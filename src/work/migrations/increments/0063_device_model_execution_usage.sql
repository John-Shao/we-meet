-- 0063: device_local execution lifecycle and adapter usage (EV102/EV114).
-- The remote egress path stays out under card E=B. These functions only accept
-- action_kind=model.send_device_local and provider=device_local.
SET ROLE work_owner;

ALTER TABLE work.operation_usage_fact
  DROP CONSTRAINT operation_usage_fact_usage_source_check;
ALTER TABLE work.operation_usage_fact
  ADD CONSTRAINT operation_usage_fact_usage_source_check
  CHECK (usage_source IN ('provider', 'gateway_estimate', 'unavailable', 'device_adapter'));

ALTER TABLE work.operation_resolution
  DROP CONSTRAINT operation_resolution_usage_source_check;
ALTER TABLE work.operation_resolution
  ADD CONSTRAINT operation_resolution_usage_source_check
  CHECK (usage_source IN ('provider', 'gateway_estimate', 'unavailable', 'device_adapter'));

CREATE FUNCTION work.register_device_model_execution(
  p_org_id text,
  p_execution_id uuid,
  p_run_id uuid,
  p_operation_id uuid,
  p_attempt_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_request_hash text,
  p_runtime_version text,
  p_permit_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  run_row work.run%ROWTYPE;
  operation_row work.operation%ROWTYPE;
  action_row work.local_action%ROWTYPE;
  session_row work.device_session%ROWTYPE;
  expired_row work.runtime_execution%ROWTYPE;
  v_now timestamptz;
  v_holder text;
  v_lease_until timestamptz;
  v_hard_deadline timestamptz;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF p_execution_id IS NULL OR p_run_id IS NULL OR p_operation_id IS NULL
     OR p_attempt_id IS NULL OR p_device_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:execution_id' USING ERRCODE = '22023';
  END IF;
  IF p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request:request_hash' USING ERRCODE = '22023';
  END IF;
  PERFORM work.assert_runtime_identifier('runtime_version', p_runtime_version);
  IF p_permit_expires_at IS NULL OR p_permit_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'permit_expired' USING ERRCODE = 'P0001';
  END IF;

  run_row := work.lock_runtime_run(p_org_id, p_run_id);
  v_now := clock_timestamp();
  IF p_permit_expires_at <= v_now THEN
    RAISE EXCEPTION 'permit_expired' USING ERRCODE = 'P0001';
  END IF;
  IF run_row.state <> 'active' THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO operation_row FROM work.operation
    WHERE org_id = p_org_id AND id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR operation_row.run_id <> p_run_id
     OR operation_row.state <> 'dispatching'
     OR operation_row.dispatch_attempt_id <> p_attempt_id
     OR operation_row.request_hash <> p_request_hash THEN
    RAISE EXCEPTION 'runtime_execution_intent_mismatch' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO action_row FROM work.local_action
    WHERE org_id = p_org_id AND operation_id = p_operation_id
      AND attempt_id = p_attempt_id;
  IF NOT FOUND OR action_row.action_kind <> 'model.send_device_local'
     OR action_row.destination_id <> 'device_local' THEN
    RAISE EXCEPTION 'runtime_execution_intent_mismatch' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO session_row FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id AND device_id = p_device_id
      AND state = 'active' AND expires_at > v_now;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM work.device d
    WHERE d.org_id = p_org_id AND d.id = p_device_id AND d.status = 'revoked'
  ) THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;

  FOR expired_row IN
    UPDATE work.runtime_execution e
    SET state = 'expired', lease_until = NULL, terminal_reason = 'deadline_elapsed',
        revision = e.revision + 1, updated_at = now()
    WHERE e.org_id = p_org_id AND e.run_id = p_run_id
      AND e.state IN ('registered', 'active')
      AND (e.hard_deadline <= v_now OR (e.state = 'active' AND e.lease_until <= v_now))
    RETURNING e.*
  LOOP
    PERFORM work.append_audit(
      p_org_id, NULL, 'runtime.execution_expired', 'runtime_execution',
      expired_row.execution_id::text,
      jsonb_build_object('run_id', p_run_id, 'holder_id', expired_row.holder_id,
                         'reason', 'deadline_elapsed')
    );
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM work.runtime_execution
    WHERE org_id = p_org_id AND run_id = p_run_id AND state IN ('registered', 'active')
  ) THEN
    RAISE EXCEPTION 'runtime_execution_already_live' USING ERRCODE = 'P0001';
  END IF;

  v_holder := 'device:' || p_device_id::text || ':' || p_session_id::text;
  v_lease_until := p_permit_expires_at + interval '2 seconds';
  v_hard_deadline := LEAST(v_now + make_interval(secs => work.runtime_hard_deadline_max_seconds()),
                           v_lease_until);
  INSERT INTO work.runtime_execution
    (execution_id, org_id, task_id, run_id, mode, run_fence, runtime_version,
     input_checkpoint_ref, input_checkpoint_hash, intent_ref, intent_hash,
     request_hash, operation_id, dispatch_attempt_id, state, holder_id,
     lease_until, hard_deadline)
  VALUES
    (p_execution_id, p_org_id, run_row.task_id, p_run_id, 'execute', run_row.fence,
     p_runtime_version, NULL, NULL, 'local:' || p_operation_id::text, p_request_hash,
     p_request_hash, p_operation_id, p_attempt_id, 'active', v_holder,
     v_lease_until, v_hard_deadline);
  PERFORM work.append_audit(
    p_org_id, NULL, 'runtime.execution_registered', 'runtime_execution', p_execution_id::text,
    jsonb_build_object('run_id', p_run_id, 'mode', 'execute', 'run_fence', run_row.fence,
      'operation_id', p_operation_id, 'holder_id', v_holder, 'usage_source', 'device_adapter')
  );
  RETURN p_execution_id;
END;
$$;

CREATE FUNCTION work.complete_device_model_execution(
  p_org_id text,
  p_execution_id uuid,
  p_reason text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  execution_row work.runtime_execution%ROWTYPE;
  reason text := work.reason_code(p_reason);
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF reason IS NULL OR p_execution_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request:reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO execution_row FROM work.runtime_execution
    WHERE org_id = p_org_id AND execution_id = p_execution_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM work.lock_runtime_run(p_org_id, execution_row.run_id);
  SELECT * INTO execution_row FROM work.runtime_execution
    WHERE org_id = p_org_id AND execution_id = p_execution_id FOR UPDATE;
  IF execution_row.state = 'completed' AND execution_row.terminal_reason = reason THEN
    RETURN 'completed';
  END IF;
  IF execution_row.state <> 'active' THEN
    RAISE EXCEPTION 'runtime_execution_not_active' USING ERRCODE = 'P0001',
      DETAIL = execution_row.state;
  END IF;
  UPDATE work.runtime_execution
  SET state = 'completed', lease_until = NULL, terminal_reason = reason,
      revision = revision + 1, updated_at = now()
  WHERE org_id = p_org_id AND execution_id = p_execution_id;
  PERFORM work.append_audit(
    p_org_id, NULL, 'runtime.execution_completed', 'runtime_execution', p_execution_id::text,
    jsonb_build_object('reason', reason, 'operation_id', execution_row.operation_id)
  );
  RETURN 'completed';
END;
$$;

CREATE FUNCTION work.record_device_model_result(
  p_org_id text,
  p_operation_id uuid,
  p_execution_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_result_hash text,
  p_provider text,
  p_model text,
  p_usage_date date,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cached_input_tokens bigint,
  p_settlement_tokens bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  operation_row work.operation%ROWTYPE;
  action_row work.local_action%ROWTYPE;
  execution_row work.runtime_execution%ROWTYPE;
  dispatch_row work.device_dispatch%ROWTYPE;
  fact_row work.operation_usage_fact%ROWTYPE;
  reservation work.quota_reservation%ROWTYPE;
  v_replayed boolean := false;
  v_counted boolean := false;
  v_settled boolean := false;
  v_execution_state text;
  v_settlement_tokens bigint;
  v_usage_revision int;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF p_operation_id IS NULL OR p_execution_id IS NULL OR p_device_id IS NULL
     OR p_session_id IS NULL OR p_result_hash IS NULL
     OR p_result_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF p_provider IS DISTINCT FROM 'device_local' THEN
    RAISE EXCEPTION 'invalid_request:provider' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(btrim(p_model)) = 0 OR p_usage_date IS NULL
     OR p_input_tokens IS NULL OR p_output_tokens IS NULL OR p_cached_input_tokens IS NULL
     OR p_input_tokens < 0 OR p_output_tokens < 0 OR p_cached_input_tokens < 0
     OR (p_settlement_tokens IS NOT NULL AND p_settlement_tokens < 0) THEN
    RAISE EXCEPTION 'invalid_request:usage' USING ERRCODE = '22023';
  END IF;

  SELECT run_id INTO run_row.id FROM work.operation
    WHERE org_id = p_org_id AND id = p_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  run_row := work.lock_runtime_run(p_org_id, run_row.id);
  SELECT * INTO task_row FROM work.task
    WHERE org_id = p_org_id AND id = run_row.task_id FOR UPDATE;
  SELECT * INTO operation_row FROM work.operation
    WHERE org_id = p_org_id AND id = p_operation_id FOR UPDATE;
  SELECT * INTO execution_row FROM work.runtime_execution
    WHERE org_id = p_org_id AND execution_id = p_execution_id FOR UPDATE;
  IF NOT FOUND OR execution_row.run_id <> run_row.id
     OR execution_row.operation_id <> p_operation_id
     OR execution_row.mode <> 'execute'
     OR split_part(execution_row.holder_id, ':', 2) <> p_device_id::text THEN
    RAISE EXCEPTION 'runtime_execution_binding_conflict' USING ERRCODE = 'P0001';
  END IF;
  IF execution_row.state NOT IN ('active', 'completed', 'expired', 'revoked') THEN
    RAISE EXCEPTION 'runtime_execution_not_active' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM work.device d
    WHERE d.org_id = p_org_id AND d.id = p_device_id AND d.status = 'revoked'
  ) OR NOT EXISTS (
    SELECT 1 FROM work.device_session s
    WHERE s.org_id = p_org_id AND s.id = p_session_id AND s.device_id = p_device_id
  ) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO action_row FROM work.local_action
    WHERE org_id = p_org_id AND operation_id = p_operation_id
      AND attempt_id = execution_row.dispatch_attempt_id;
  IF NOT FOUND OR action_row.action_kind <> 'model.send_device_local'
     OR action_row.destination_id <> 'device_local' THEN
    RAISE EXCEPTION 'runtime_execution_binding_conflict' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO dispatch_row FROM work.device_dispatch
    WHERE org_id = p_org_id AND operation_id = p_operation_id
      AND attempt_id = execution_row.dispatch_attempt_id;
  IF NOT FOUND OR dispatch_row.device_id <> p_device_id THEN
    RAISE EXCEPTION 'runtime_execution_binding_conflict' USING ERRCODE = 'P0001';
  END IF;
  IF operation_row.state NOT IN ('dispatching', 'unknown', 'unresolved', 'succeeded',
                                'reconciled', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'operation_not_confirmable' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO fact_row FROM work.operation_usage_fact
    WHERE org_id = p_org_id AND operation_id = p_operation_id
    ORDER BY usage_revision DESC LIMIT 1;
  IF fact_row.id IS NOT NULL THEN
    IF fact_row.source_receipt_hash <> p_result_hash
       OR fact_row.usage_source <> 'device_adapter'
       OR fact_row.provider IS DISTINCT FROM p_provider
       OR fact_row.model IS DISTINCT FROM btrim(p_model)
       OR fact_row.input_tokens IS DISTINCT FROM p_input_tokens
       OR fact_row.output_tokens IS DISTINCT FROM p_output_tokens
       OR fact_row.cached_input_tokens IS DISTINCT FROM p_cached_input_tokens THEN
      RAISE EXCEPTION 'usage_receipt_conflict' USING ERRCODE = 'P0001';
    END IF;
    v_replayed := true;
    v_usage_revision := fact_row.usage_revision;
  ELSE
    v_usage_revision := 1;
    INSERT INTO work.operation_usage_fact
      (org_id, operation_id, usage_revision, origin, usage_source, source_receipt_hash,
       subject_id, provider, model, usage_date, input_tokens, output_tokens,
       cached_input_tokens, counted_in_usage_daily)
    VALUES
      (p_org_id, p_operation_id, 1, 'command', 'device_adapter', p_result_hash,
       task_row.owner_subject_id, p_provider, btrim(p_model), p_usage_date,
       p_input_tokens, p_output_tokens, p_cached_input_tokens, true);
    PERFORM work.accumulate_usage_daily(
      p_org_id, task_row.owner_subject_id, p_provider, p_model, p_usage_date,
      p_input_tokens, p_output_tokens, p_cached_input_tokens, 1
    );
    UPDATE work.operation
    SET usage_recorded_at = COALESCE(usage_recorded_at, now()), updated_at = now()
    WHERE org_id = p_org_id AND id = p_operation_id;
    v_counted := true;
  END IF;

  SELECT * INTO reservation FROM work.quota_reservation
    WHERE org_id = p_org_id AND operation_id = p_operation_id
    ORDER BY reservation_seq DESC LIMIT 1 FOR UPDATE;
  IF reservation.id IS NULL OR reservation.state NOT IN ('held', 'unknown', 'settled') THEN
    RAISE EXCEPTION 'quota_reservation_not_held' USING ERRCODE = 'P0001';
  END IF;
  IF reservation.state IN ('held', 'unknown') THEN
    v_settlement_tokens := COALESCE(p_settlement_tokens, p_input_tokens + p_output_tokens);
    PERFORM work.settle_quota(
      reservation.id, v_settlement_tokens,
      jsonb_build_object('resolution', 'device_model_result',
        'result_hash', p_result_hash, 'usage_source', 'device_adapter',
        'usage_revision', v_usage_revision),
      reservation.settlement_revision + 1
    );
    v_settled := true;
  END IF;

  IF execution_row.state = 'active' THEN
    v_execution_state := work.complete_device_model_execution(
      p_org_id, p_execution_id, 'model_result_recorded');
  ELSE
    v_execution_state := execution_row.state;
  END IF;
  PERFORM work.append_audit(
    p_org_id, NULL, 'device_model.result_recorded', 'operation', p_operation_id::text,
    jsonb_build_object('execution_id', p_execution_id, 'result_hash', p_result_hash,
      'usage_source', 'device_adapter', 'usage_revision', v_usage_revision,
      'replayed', v_replayed, 'settled', v_settled)
  );
  RETURN jsonb_build_object(
    'outcome', CASE WHEN v_replayed THEN 'replayed' ELSE 'recorded' END,
    'usage_revision', v_usage_revision,
    'usage_counted', v_counted,
    'settled', v_settled,
    'execution_state', v_execution_state
  );
END;
$$;

CREATE OR REPLACE FUNCTION work.consume_device_permit(
  p_org_id text,
  p_operation_id uuid,
  p_attempt_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_lease_id uuid,
  p_fence bigint,
  p_request_hash text,
  p_kid text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_operation work.operation%ROWTYPE;
  v_action work.local_action%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_grant work.workspace_grant%ROWTYPE;
  v_policy work.local_execution_policy%ROWTYPE;
  v_approval work.approval%ROWTYPE;
  v_existing work.device_dispatch%ROWTYPE;
  v_reservation work.quota_reservation%ROWTYPE;
  v_command_id uuid;
  v_execution_id uuid;
  v_jti uuid;
  v_taint integer;
  v_scope_hash text;
  v_aud text;
  v_permit jsonb;
  v_response jsonb;
  v_approval_id uuid;
  v_issued_at text;
  v_expires_at text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF COALESCE(p_request_hash, '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_kid, '') = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM work.device_dispatch
    WHERE org_id = p_org_id AND operation_id = p_operation_id AND attempt_id = p_attempt_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'command_id', v_existing.command_id, 'permit_jti', v_existing.permit_jti,
      'operation_id', v_existing.operation_id,
      'dispatch_attempt_id', v_existing.attempt_id, 'fence', v_existing.fence,
      'expires_at', v_existing.expires_at, 'delivery_state', v_existing.delivery_state,
      'permit', v_existing.permit, 'replayed', true);
  END IF;

  SELECT task_id INTO v_run.task_id FROM work.run r
    JOIN work.operation o ON o.run_id = r.id AND o.org_id = r.org_id
    WHERE o.org_id = p_org_id AND o.id = p_operation_id;
  IF v_run.task_id IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE id = v_run.task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id
      AND id = (SELECT run_id FROM work.operation
                WHERE org_id = p_org_id AND id = p_operation_id)
    FOR UPDATE;
  IF v_run.state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  IF v_task.active_run_id IS DISTINCT FROM v_run.id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_operation FROM work.operation
    WHERE org_id = p_org_id AND id = p_operation_id FOR UPDATE;
  SELECT * INTO v_existing FROM work.device_dispatch
    WHERE org_id = p_org_id AND operation_id = p_operation_id AND attempt_id = p_attempt_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'command_id', v_existing.command_id, 'permit_jti', v_existing.permit_jti,
      'operation_id', v_existing.operation_id,
      'dispatch_attempt_id', v_existing.attempt_id, 'fence', v_existing.fence,
      'expires_at', v_existing.expires_at, 'delivery_state', v_existing.delivery_state,
      'permit', v_existing.permit, 'replayed', true);
  END IF;
  SELECT * INTO v_action FROM work.local_action
    WHERE org_id = p_org_id AND operation_id = p_operation_id
      AND attempt_id = p_attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_operation.dispatch_attempt_id IS DISTINCT FROM p_attempt_id THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_device.status = 'revoked' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.device_id <> p_device_id OR v_session.state <> 'active'
     OR v_session.expires_at <= now()
     OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_lease FROM work.execution_lease
    WHERE org_id = p_org_id AND id = p_lease_id FOR UPDATE;
  IF NOT FOUND OR v_lease.run_id <> v_run.id OR v_lease.device_id <> p_device_id
     OR v_lease.session_id <> p_session_id OR v_lease.state <> 'active'
     OR v_lease.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.fence IS DISTINCT FROM p_fence OR v_lease.fence IS DISTINCT FROM p_fence THEN
    RAISE EXCEPTION 'stale_fence' USING ERRCODE = 'P0001';
  END IF;

  IF p_request_hash IS DISTINCT FROM v_operation.request_hash THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  v_aud := CASE WHEN v_action.action_kind IN ('model.send_remote',
                                            'model.send_device_local')
                THEN 'device-model-proxy' ELSE 'device-tool' END;

  v_issued_at := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_expires_at := to_char((now() + interval '5 seconds') AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  IF v_expires_at::timestamptz <= now()
     OR v_expires_at::timestamptz > now() + interval '5 seconds'
     OR v_expires_at::timestamptz > v_lease.expires_at
     OR v_issued_at::timestamptz > now() THEN
    RAISE EXCEPTION 'permit_expired' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_grant FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = v_action.grant_id FOR UPDATE;
  IF NOT FOUND OR v_grant.state <> 'active' OR v_grant.expires_at <= now()
     OR v_grant.grant_revision IS DISTINCT FROM v_action.grant_revision THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_policy FROM work.local_execution_policy WHERE org_id = p_org_id;

  v_scope_hash := work.sha256_text('{"action_kind":"' || v_action.action_kind
    || '","grant_id":"' || v_action.grant_id::text
    || '","grant_revision":' || v_action.grant_revision
    || ',"resource_selector_hash":"' || v_action.resource_selector_hash
    || '","classification":"' || v_action.classification
    || '","destination_id":' || CASE WHEN v_action.destination_id IS NULL THEN 'null'
         ELSE '"' || v_action.destination_id || '"' END || '}');

  SELECT ao.approval_id INTO v_approval_id FROM work.approval_operation ao
    WHERE ao.org_id = p_org_id AND ao.operation_id = p_operation_id;
  IF v_approval_id IS NOT NULL THEN
    SELECT * INTO v_approval FROM work.approval
      WHERE org_id = p_org_id AND id = v_approval_id FOR UPDATE;
    IF v_approval.status <> 'approved' OR v_approval.expires_at <= now() THEN
      RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM work.operation o
    WHERE o.org_id = p_org_id AND o.run_id = v_run.id
      AND o.state IN ('unknown', 'unresolved')
  ) THEN
    RAISE EXCEPTION 'run_has_unreconciled_operation' USING ERRCODE = 'P0001';
  END IF;

  IF v_action.action_kind IN ('model.send_remote', 'model.send_device_local')
     AND v_action.destination_id <> 'device_local' THEN
    SELECT COALESCE(MAX(work.classification_rank(g.classification)), 0) INTO v_taint
    FROM work.local_action la
    JOIN work.operation o ON o.id = la.operation_id AND o.org_id = la.org_id
    JOIN work.workspace_grant g ON g.id = la.grant_id AND g.org_id = la.org_id
    WHERE la.org_id = p_org_id AND o.run_id = v_run.id
      AND la.action_kind IN ('workspace.read', 'workspace.search', 'artifact.write');
    IF v_taint >= work.classification_rank('local_only') THEN
      RAISE EXCEPTION 'destination_not_allowed_for_local_only' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF work.classification_rank(v_action.classification)
     < work.classification_rank(v_grant.classification) THEN
    RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_reservation FROM work.quota_reservation q
    WHERE q.org_id = p_org_id AND q.operation_id = p_operation_id
    ORDER BY q.reservation_seq DESC LIMIT 1;
  IF FOUND AND v_reservation.state NOT IN ('held', 'unknown') THEN
    RAISE EXCEPTION 'quota_reservation_not_held' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.operation
    SET state = 'dispatching', revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_operation_id AND state = 'authorized';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_not_authorizable' USING ERRCODE = 'P0001';
  END IF;

  v_jti := gen_random_uuid();
  v_permit := jsonb_build_object(
    'v', 2,
    'aud', v_aud,
    'kid', p_kid,
    'jti', v_jti,
    'org_id', p_org_id,
    'subject_id', v_task.owner_subject_id,
    'device_id', p_device_id::text,
    'session_id', p_session_id::text,
    'agent_instance_id', v_session.agent_instance_id::text,
    'boot_id', v_session.boot_id,
    'generation', v_session.generation::text,
    'run_id', v_run.id::text,
    'operation_id', p_operation_id::text,
    'dispatch_attempt_id', p_attempt_id::text,
    'request_hash', p_request_hash,
    'fence', p_fence::text,
    'policy_epoch', v_policy.effective_epoch::text,
    'access_epoch', v_run.admission_access_epoch::text,
    'grant_id', v_action.grant_id::text,
    'grant_revision', v_action.grant_revision::text,
    'approval_id', v_approval_id,
    'decision_revision', CASE WHEN v_approval_id IS NULL THEN NULL
                              ELSE v_approval.revision::text END,
    'scope_hash', v_scope_hash,
    'destination_id', v_action.destination_id,
    'max_bytes', v_action.byte_upper_bound::text,
    'issued_at', v_issued_at,
    'expires_at', v_expires_at,
    'signature', 'sha256:' || work.sha256_text(v_scope_hash || '|' || v_jti::text));
  IF NOT work.device_permit_valid(v_permit) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_command_id := gen_random_uuid();
  IF v_action.action_kind = 'model.send_device_local' THEN
    v_execution_id := work.register_device_model_execution(
      p_org_id, v_command_id, v_run.id, p_operation_id, p_attempt_id,
      p_device_id, p_session_id, p_request_hash, v_run.runtime_version,
      v_expires_at::timestamptz);
  END IF;
  INSERT INTO work.device_dispatch
    (org_id, operation_id, attempt_id, device_id, session_id, journal_epoch,
     command_id, permit_jti, request_hash, fence, expires_at, delivery_state, permit)
  VALUES
    (p_org_id, p_operation_id, p_attempt_id, p_device_id, p_session_id,
     v_session.journal_epoch, v_command_id, v_jti, p_request_hash, p_fence,
     v_expires_at::timestamptz, 'not_applicable', v_permit);

  PERFORM work.append_task_event(p_org_id, v_task.id, 'operation.dispatched',
    jsonb_build_object('operation_id', p_operation_id, 'command_id', v_command_id,
      'attempt_id', p_attempt_id, 'fence', p_fence));
  PERFORM work.append_audit(p_org_id, NULL, 'device_permit.consumed',
    'operation', p_operation_id::text,
    jsonb_build_object('command_id', v_command_id,
      'permit_jti', v_jti, 'attempt_id', p_attempt_id,
      'aud', v_aud, 'fence', p_fence, 'execution_id', v_execution_id));

  v_response := jsonb_build_object(
    'command_id', v_command_id, 'permit_jti', v_jti,
    'operation_id', p_operation_id, 'dispatch_attempt_id', p_attempt_id,
    'fence', p_fence, 'expires_at', v_expires_at::timestamptz,
    'delivery_state', 'not_applicable', 'permit', v_permit);
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION work.register_device_model_execution(
  text, uuid, uuid, uuid, uuid, uuid, uuid, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.complete_device_model_execution(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.record_device_model_result(
  text, uuid, uuid, uuid, uuid, text, text, text, date, bigint, bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.consume_device_permit(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION work.record_device_model_result(
  text, uuid, uuid, uuid, uuid, text, text, text, date, bigint, bigint, bigint, bigint) TO work_worker;
GRANT EXECUTE ON FUNCTION work.consume_device_permit(
  text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) TO work_worker;

RESET ROLE;
