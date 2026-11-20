-- 0059: bind receipts to dispatch history, fence new permits against cancellation,
-- replay run_start without new authority, and retain the complete finish verdict.
-- Full definitions replace the published functions; no historical migration is edited.
-- No new table privileges, roles, or RLS exemptions are introduced.
SET ROLE work_owner;

-- Existing verdicts did not retain this evidence; [] is explicitly an unknown historical
-- repair list, not a reconstruction from today's Operation states. The existing append-only
-- trigger and FORCE RLS policy cover the new column too.
ALTER TABLE work.device_run_finish
  ADD COLUMN unresolved_operations jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(unresolved_operations) = 'array');

CREATE OR REPLACE FUNCTION work.record_device_receipt(
  p_org_id text,
  p_device_id uuid,
  p_journal_epoch uuid,
  p_receipts jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_operation work.operation%ROWTYPE;
  v_run work.run%ROWTYPE;
  v_dispatch work.device_dispatch%ROWTYPE;
  v_existing work.device_receipt%ROWTYPE;
  v_element jsonb;
  v_exec jsonb;
  v_seq bigint;
  v_expected bigint;
  v_through bigint;
  v_signed_hash text;
  v_state text;
  v_outcome text;
  v_resolution jsonb;
  v_recorded jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_old_fence boolean;
  v_lease_id uuid;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF NOT work.device_receipt_batch_valid(p_receipts) THEN
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

  SELECT COALESCE(MAX(seq), 0) INTO v_expected FROM work.device_receipt
    WHERE org_id = p_org_id AND device_id = p_device_id
      AND journal_epoch = p_journal_epoch;
  v_through := v_expected;
  v_expected := v_expected + 1;

  FOR v_element IN SELECT * FROM jsonb_array_elements(p_receipts) LOOP
    v_exec := v_element -> 'original_execution';
    v_seq := (v_element ->> 'receipt_seq')::bigint;
    v_state := v_element ->> 'state';
    v_outcome := v_element ->> 'outcome';
    v_signed_hash := work.sha256_text(COALESCE(v_element ->> 'signature', ''));

    IF COALESCE(v_element ->> 'request_hash', '') !~ '^[0-9a-f]{64}$'
       OR COALESCE(v_element ->> 'signature', '') !~ '^[A-Za-z0-9_-]{86}$'
       OR v_state NOT IN ('started', 'completed', 'unknown')
       OR (v_state = 'completed') <> (v_outcome IS NOT NULL)
       OR (v_outcome IS NOT NULL AND v_outcome NOT IN
           ('succeeded', 'failed', 'rejected_not_executed'))
       OR COALESCE(v_exec ->> 'org_id', '') <> p_org_id
       OR COALESCE(v_exec ->> 'device_id', '') <> p_device_id::text
       OR COALESCE(v_exec ->> 'fence', '') !~ '^[0-9]+$'
       OR (v_element ->> 'usage_source') IS NOT NULL
          AND (v_element ->> 'usage_source') NOT IN
              ('provider', 'gateway_estimate', 'unavailable') THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'receipt_seq', v_seq, 'code', 'invalid_request'));
      CONTINUE;
    END IF;

    SELECT * INTO v_existing FROM work.device_receipt
      WHERE org_id = p_org_id AND device_id = p_device_id
        AND journal_epoch = p_journal_epoch AND seq = v_seq;
    IF FOUND THEN
      IF v_existing.signed_payload_hash IS DISTINCT FROM v_signed_hash THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'receipt_seq', v_seq, 'code', 'idempotency_key_conflict'));
      ELSE
        v_recorded := v_recorded || jsonb_build_array(jsonb_build_object(
          'receipt_seq', v_seq, 'operation_id', v_existing.operation_id,
          'state', v_existing.state, 'resolution_revision', NULL, 'replayed', true));
        IF v_seq >= v_through THEN
          v_through := v_seq;
        END IF;
      END IF;
      CONTINUE;
    END IF;

    IF v_seq <> v_expected THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'receipt_seq', v_seq, 'code', 'receipt_seq_out_of_window'));
      CONTINUE;
    END IF;

    SELECT * INTO v_operation FROM work.operation
      WHERE org_id = p_org_id AND id = (v_exec ->> 'operation_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'receipt_seq', v_seq, 'code', 'invalid_request'));
      CONTINUE;
    END IF;
    SELECT * INTO v_run FROM work.run
      WHERE org_id = p_org_id AND id = v_operation.run_id;
    IF v_run.id::text IS DISTINCT FROM (v_exec ->> 'run_id')
       OR v_operation.dispatch_attempt_id::text IS DISTINCT FROM
          (v_exec ->> 'attempt_id') THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'receipt_seq', v_seq, 'code', 'invalid_request'));
      CONTINUE;
    END IF;

    -- Ownership comes from the immutable historical dispatch, not from a device's
    -- ability to describe its own session. Neither dispatch expiry nor a superseded
    -- session invalidates historical evidence. subject_id belongs to the stored permit,
    -- not to today's task owner, authenticated actor, or newest device session.
    SELECT * INTO v_dispatch FROM work.device_dispatch
      WHERE org_id = p_org_id AND operation_id = v_operation.id
        AND attempt_id = (v_exec ->> 'attempt_id')::uuid;
    IF NOT FOUND OR v_dispatch.device_id IS DISTINCT FROM p_device_id
       OR v_dispatch.session_id::text IS DISTINCT FROM (v_exec ->> 'session_id')
       OR v_dispatch.journal_epoch IS DISTINCT FROM p_journal_epoch
       OR v_dispatch.request_hash IS DISTINCT FROM (v_element ->> 'request_hash')
       OR v_dispatch.fence IS DISTINCT FROM (v_exec ->> 'fence')::bigint
       OR (v_dispatch.permit ->> 'subject_id') IS DISTINCT FROM (v_exec ->> 'subject_id') THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'receipt_seq', v_seq, 'code', 'receipt_signature_invalid'));
      CONTINUE;
    END IF;
    -- The outer session is transport only; compare the signed original session.
    SELECT * INTO v_session FROM work.device_session
      WHERE org_id = p_org_id AND id = v_dispatch.session_id;
    IF NOT FOUND OR v_session.device_id <> p_device_id
       OR v_session.journal_epoch IS DISTINCT FROM p_journal_epoch
       OR v_session.boot_id IS DISTINCT FROM (v_exec ->> 'boot_id')
       OR v_session.agent_instance_id::text IS DISTINCT FROM
          (v_exec ->> 'agent_instance_id')
       OR v_session.generation::text IS DISTINCT FROM (v_exec ->> 'generation') THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'receipt_seq', v_seq, 'code', 'receipt_signature_invalid'));
      CONTINUE;
    END IF;
    v_old_fence := (v_exec ->> 'fence')::bigint IS DISTINCT FROM v_run.fence;

    INSERT INTO work.device_receipt
      (org_id, device_id, journal_epoch, seq, operation_id, attempt_id, request_hash,
       fence, state, outcome, signed_payload_hash, result_hash, local_result_ref,
       resolution_source, server_only, error_code, usage_source)
    VALUES
      (p_org_id, p_device_id, p_journal_epoch, v_seq, v_operation.id,
       v_operation.dispatch_attempt_id, v_element ->> 'request_hash',
       (v_exec ->> 'fence')::bigint, v_state, v_outcome, v_signed_hash,
       NULLIF(v_element ->> 'result_hash', ''),
       NULLIF(v_element ->> 'local_result_ref', ''),
       'device', false, NULLIF(v_element ->> 'error_code', ''),
       NULLIF(v_element ->> 'usage_source', ''));

    v_resolution := NULL;
    IF v_state = 'completed' AND NOT v_old_fence THEN
      IF v_outcome = 'rejected_not_executed' THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'receipt_seq', v_seq, 'code', 'invalid_request'));
      ELSE
        v_resolution := work.issue_operation_resolution(
          p_org_id, v_operation.id, v_outcome, NULL, NULL,
          'sha256:' || work.sha256_text('operation_resolution|'
            || v_operation.id::text || '|' || v_outcome || '|' || v_seq::text),
          NULL,
          jsonb_build_object('source', 'device_receipt', 'receipt_seq', v_seq,
            'journal_epoch', p_journal_epoch, 'fence', (v_exec ->> 'fence')::bigint));
      END IF;
    END IF;

    v_recorded := v_recorded || jsonb_build_array(jsonb_build_object(
      'receipt_seq', v_seq, 'operation_id', v_operation.id, 'state', v_state,
      'resolution_revision', v_resolution -> 'resolution_revision',
      'replayed', false));
    v_through := v_seq;
    v_expected := v_seq + 1;
  END LOOP;

  UPDATE work.device_session
    SET last_receipt_seq = GREATEST(last_receipt_seq, v_through),
        revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND device_id = p_device_id
      AND journal_epoch = p_journal_epoch AND last_receipt_seq < v_through;
  FOR v_lease_id IN
    SELECT l.id FROM work.execution_lease l
    WHERE l.org_id = p_org_id AND l.device_id = p_device_id
      AND l.state = 'active' AND l.last_receipt_seq < v_through
  LOOP
    UPDATE work.execution_lease
      SET last_receipt_seq = v_through, revision = revision + 1, updated_at = now()
      WHERE org_id = p_org_id AND id = v_lease_id;
  END LOOP;

  PERFORM work.append_audit(p_org_id, NULL, 'device_receipt.recorded',
    'device', p_device_id::text,
    jsonb_build_object('journal_epoch', p_journal_epoch,
      'recorded', jsonb_array_length(v_recorded),
      'conflicts', jsonb_array_length(v_conflicts),
      'receipt_through_seq', v_through));

  RETURN jsonb_build_object('recorded', v_recorded, 'conflicts', v_conflicts,
    'receipt_through_seq', v_through);
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

  -- A replay is an existing fact, not permission to perform a new dispatch.
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
  -- Recheck after the locks: claim's active-Run candidate snapshot may predate a
  -- request_cancel that held Task first. active_run_id is the existing admission
  -- ownership rule (0002 operation admission), not a new current-run field.
  IF v_run.state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  IF v_task.active_run_id IS DISTINCT FROM v_run.id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_operation FROM work.operation
    WHERE org_id = p_org_id AND id = p_operation_id FOR UPDATE;
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
      'aud', v_aud, 'fence', p_fence));

  v_response := jsonb_build_object(
    'command_id', v_command_id, 'permit_jti', v_jti,
    'operation_id', p_operation_id, 'dispatch_attempt_id', p_attempt_id,
    'fence', p_fence, 'expires_at', v_expires_at::timestamptz,
    'delivery_state', 'not_applicable', 'permit', v_permit);
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION work.acquire_device_lease(
  p_org_id text,
  p_run_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_binding_revision bigint,
  p_purpose text,
  p_start_nonce uuid,
  p_ttl_seconds int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_org work.org%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_id uuid;
  v_expiry timestamptz;
  v_baseline_hash text;
  v_has_checkpoint boolean;
  v_response jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF p_purpose IS NULL OR p_purpose NOT IN ('execute', 'reconcile_finish')
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 30
     OR p_binding_revision IS NULL OR p_binding_revision < 1 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF p_purpose = 'execute' AND p_start_nonce IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF p_purpose = 'reconcile_finish' AND p_start_nonce IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  IF p_purpose = 'execute' THEN
    SELECT * INTO v_lease FROM work.execution_lease
      WHERE org_id = p_org_id AND run_id = p_run_id AND start_nonce = p_start_nonce
      FOR UPDATE;
  ELSE
    SELECT * INTO v_lease FROM work.execution_lease
      WHERE org_id = p_org_id AND run_id = p_run_id AND purpose = 'reconcile_finish'
        AND state = 'active' FOR UPDATE;
  END IF;
  IF FOUND THEN
    IF v_lease.device_id IS DISTINCT FROM p_device_id
       OR v_lease.session_id IS DISTINCT FROM p_session_id
       OR v_lease.binding_revision IS DISTINCT FROM p_binding_revision
       OR v_lease.purpose IS DISTINCT FROM p_purpose THEN
      RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
    END IF;
    IF v_lease.state <> 'active' OR v_lease.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_binding FROM work.device_run_binding
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND binding_revision = v_lease.binding_revision;
    IF NOT FOUND OR v_binding.device_id IS DISTINCT FROM p_device_id
       OR v_binding.session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_device FROM work.device
      WHERE org_id = p_org_id AND id = p_device_id;
    IF NOT FOUND OR v_device.status <> 'active' THEN
      RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_session FROM work.device_session
      WHERE org_id = p_org_id AND id = p_session_id AND device_id = p_device_id;
    IF NOT FOUND OR v_session.state <> 'active' OR v_session.expires_at <= clock_timestamp()
       OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
       OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
      RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
    END IF;
    -- Renewals can change lease.expires_at, never the original run_start or its
    -- five-second delivery window. Audit is already the receipt carrier; retain
    -- the exact first response there, including the original checkpoint fields.
    SELECT metadata -> 'response' INTO v_response FROM work.audit_event
      WHERE org_id = p_org_id AND action = 'device_lease.acquired'
        AND metadata ->> 'lease_id' = v_lease.id::text;
    -- Pre-0059 leases have no saved response. Do not invent their original TTL,
    -- baseline, or delivery deadline from a possibly renewed current lease.
    IF v_response IS NULL OR (p_purpose = 'execute' AND
        (v_response #>> '{run_start,expiry}')::timestamptz <= clock_timestamp()) THEN
      RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_response || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_org FROM work.org WHERE id = p_org_id FOR SHARE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.state <> 'active' THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id FOR UPDATE;
  IF NOT FOUND OR v_device.status <> 'active' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id AND device_id = p_device_id;
  IF NOT FOUND OR v_session.state <> 'active' THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id AND binding_revision = p_binding_revision
    FOR UPDATE;
  IF NOT FOUND OR v_binding.device_id IS DISTINCT FROM p_device_id THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_purpose = 'execute' THEN
    IF EXISTS (SELECT 1 FROM work.operation
        WHERE org_id = p_org_id AND run_id = p_run_id
          AND state IN ('unknown', 'unresolved')) THEN
      RAISE EXCEPTION 'run_has_unreconciled_operation' USING ERRCODE = 'P0001';
    END IF;
    IF v_binding.state NOT IN ('ready', 'active') THEN
      RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
    END IF;
    SELECT EXISTS (SELECT 1 FROM work.device_checkpoint
      WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'recorded')
      INTO v_has_checkpoint;
    IF v_binding.expected_checkpoint_seq IS NULL AND v_has_checkpoint THEN
      RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_id := gen_random_uuid();
  v_expiry := now() + make_interval(secs => p_ttl_seconds);
  INSERT INTO work.execution_lease
    (org_id, id, run_id, device_id, session_id, binding_revision, fence, generation,
     purpose, start_nonce, expires_at)
  VALUES
    (p_org_id, v_id, p_run_id, p_device_id, p_session_id, p_binding_revision,
     v_run.fence, COALESCE(v_org.access_epoch, 0), p_purpose,
     CASE WHEN p_purpose = 'execute' THEN p_start_nonce ELSE NULL END, v_expiry);

  IF p_purpose = 'execute' THEN
    UPDATE work.device_run_binding
      SET state = 'active', updated_at = now(), revision = revision + 1
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND binding_revision = p_binding_revision AND state = 'ready';

    IF NOT EXISTS (SELECT 1 FROM work.device_checkpoint
        WHERE org_id = p_org_id AND run_id = p_run_id AND checkpoint_seq = 0) THEN
      v_baseline_hash := v_binding.input_hash;
      INSERT INTO work.device_checkpoint
        (org_id, run_id, checkpoint_seq, binding_revision, fence, checkpoint_hash,
         local_ref, receipt_through_seq, pending_operation_set_hash, signed_payload_hash)
      VALUES
        (p_org_id, p_run_id, 0, p_binding_revision, v_run.fence, v_baseline_hash,
         v_binding.input_ref, 0, work.sha256_text('[]'), NULL);
    END IF;
  END IF;

  v_response := jsonb_build_object('lease_id', v_id, 'run_id', p_run_id, 'fence', v_run.fence,
    'generation', COALESCE(v_org.access_epoch, 0), 'purpose', p_purpose,
    'expires_at', v_expiry, 'ttl_ms', p_ttl_seconds * 1000,
    'start_nonce', CASE WHEN p_purpose = 'execute' THEN p_start_nonce ELSE NULL END,
    'run_start', CASE WHEN p_purpose = 'execute' THEN jsonb_build_object(
      'run_binding_id', p_binding_revision, 'run_id', p_run_id, 'lease_id', v_id,
      'fence', v_run.fence, 'start_nonce', p_start_nonce,
      'expiry', LEAST(v_expiry, now() + interval '5 seconds'),
      'runtime_digest', v_binding.runtime_digest,
      'payload_hash', work.sha256_text('run_start|' || p_run_id::text || '|'
        || p_binding_revision::text || '|' || v_id::text || '|' || p_start_nonce::text))
      ELSE NULL END,
    'checkpoint_seq', CASE WHEN p_purpose = 'execute' THEN 0 ELSE NULL END,
    'checkpoint_hash', CASE WHEN p_purpose = 'execute' THEN v_binding.input_hash ELSE NULL END);
  PERFORM work.append_audit(p_org_id, NULL, 'device_lease.acquired',
    'run', p_run_id::text,
    jsonb_build_object('lease_id', v_id, 'purpose', p_purpose, 'fence', v_run.fence,
      'start_nonce', p_start_nonce, 'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION work.finish_local_run(
  p_org_id text,
  p_run_id uuid,
  p_finish_id uuid,
  p_lease_id uuid,
  p_binding_revision bigint,
  p_fence bigint,
  p_finish jsonb,
  p_device_id uuid,
  p_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_checkpoint work.device_checkpoint%ROWTYPE;
  v_existing work.device_run_finish%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_outcome text;
  v_run_outcome text;
  v_reason text;
  v_reject text;
  v_set_hash text;
  v_max_seq bigint;
  v_receipt_through bigint;
  v_unresolved jsonb;
  v_terminal bigint;
  v_signed_hash text;
  v_server_signature text;
  v_response jsonb;
  v_version_id uuid;
  v_deliverable_ok boolean := true;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

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

  IF NOT work.local_run_finish_valid(p_finish) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_outcome := p_finish ->> 'outcome';
  v_reason := p_finish ->> 'reason_code';
  IF v_outcome NOT IN ('completed', 'failed')
     OR COALESCE(p_finish ->> 'final_checkpoint_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_finish ->> 'final_operation_set_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_finish ->> 'device_signature', '') !~ '^[A-Za-z0-9_-]{86}$'
     OR COALESCE(p_finish ->> 'final_checkpoint_seq', '') !~ '^[0-9]+$'
     OR COALESCE(p_finish ->> 'receipt_through_seq', '') !~ '^[0-9]+$'
     OR (v_outcome = 'completed' AND v_reason IS NOT NULL)
     OR (v_reason IS NOT NULL AND v_reason NOT IN
         ('no_deliverable', 'model_error', 'tool_limit', 'runtime_limit_exceeded',
          'runtime_unresumable', 'checkpoint_lost', 'input_missing')) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_signed_hash := work.sha256_text(p_finish ->> 'device_signature');

  SELECT * INTO v_existing FROM work.device_run_finish
    WHERE org_id = p_org_id AND run_id = p_run_id AND finish_id = p_finish_id;
  IF FOUND THEN
    IF v_existing.signed_payload_hash IS DISTINCT FROM v_signed_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'finish_id', p_finish_id, 'state', v_existing.state,
      'code', v_existing.reject_code,
      'terminal_run_revision', v_existing.terminal_run_revision,
      'expected_operation_set_hash', v_existing.final_operation_set_hash,
      'unresolved_operations', v_existing.unresolved_operations,
      'server_signature', v_existing.server_signature, 'replayed', true);
  END IF;

  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF v_run.task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE id = v_run.task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  SELECT * INTO v_lease FROM work.execution_lease
    WHERE org_id = p_org_id AND id = p_lease_id FOR UPDATE;
  IF NOT FOUND OR v_lease.run_id <> p_run_id OR v_lease.state <> 'active'
     OR v_lease.expires_at <= now()
     OR v_lease.binding_revision IS DISTINCT FROM p_binding_revision THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id
      AND binding_revision = p_binding_revision FOR UPDATE;
  IF NOT FOUND OR v_binding.device_id <> v_lease.device_id
     OR v_binding.session_id <> v_lease.session_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_lease.device_id <> p_device_id OR v_lease.session_id <> p_session_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = v_lease.device_id;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = v_lease.session_id;

  v_reject := NULL;
  v_set_hash := work.local_operation_set_hash(p_org_id, p_run_id);
  v_unresolved := '[]'::jsonb;

  IF v_run.fence IS DISTINCT FROM p_fence OR v_lease.fence IS DISTINCT FROM p_fence THEN
    v_reject := 'stale_fence';
  END IF;

  IF v_reject IS NULL THEN
    IF v_task.state <> 'open' OR v_task.active_run_id IS DISTINCT FROM p_run_id THEN
      v_reject := 'finish_precondition_failed';
    ELSIF v_run.state = 'cancel_requested' AND v_outcome = 'completed' THEN
      v_reject := 'run_cancel_requested';
    END IF;
  END IF;

  IF v_reject IS NULL THEN
    SELECT COALESCE(MAX(checkpoint_seq), -1) INTO v_max_seq
      FROM work.device_checkpoint
      WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'recorded';
    SELECT * INTO v_checkpoint FROM work.device_checkpoint
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND checkpoint_seq = (p_finish ->> 'final_checkpoint_seq')::bigint;
    SELECT COALESCE(MAX(seq), 0) INTO v_receipt_through FROM work.device_receipt
      WHERE org_id = p_org_id AND device_id = v_lease.device_id
        AND journal_epoch = v_session.journal_epoch;
    IF (p_finish ->> 'final_checkpoint_seq')::bigint IS DISTINCT FROM v_max_seq
       OR v_checkpoint.checkpoint_hash IS DISTINCT FROM
          (p_finish ->> 'final_checkpoint_hash')
       OR (p_finish ->> 'receipt_through_seq')::bigint IS DISTINCT FROM v_receipt_through
       OR v_checkpoint.receipt_through_seq > v_receipt_through
       OR (p_finish ->> 'final_operation_set_hash') IS DISTINCT FROM v_set_hash THEN
      v_reject := 'finish_state_mismatch';
      SELECT COALESCE(jsonb_agg(jsonb_build_object('operation_id', o.id,
                                                   'state', o.state)), '[]'::jsonb)
        INTO v_unresolved
      FROM work.operation o
      WHERE o.org_id = p_org_id AND o.run_id = p_run_id
        AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching',
                        'unknown', 'unresolved');
    END IF;
  END IF;

  IF v_reject IS NULL AND v_outcome = 'completed' THEN
    IF EXISTS (
      SELECT 1 FROM work.operation o
      WHERE o.org_id = p_org_id AND o.run_id = p_run_id
        AND o.state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching',
                        'unknown', 'unresolved')
    ) OR EXISTS (
      SELECT 1 FROM work.device_dispatch d
      JOIN work.operation o ON o.id = d.operation_id AND o.org_id = d.org_id
      WHERE d.org_id = p_org_id AND o.run_id = p_run_id
        AND d.delivery_state IN ('pending', 'undelivered')
    ) THEN
      v_reject := 'finish_precondition_failed';
    ELSE
      FOR v_version_id IN
        SELECT (x #>> '{}')::uuid
        FROM jsonb_array_elements(p_finish -> 'deliverable_versions') x
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM work.artifact_version av
          WHERE av.org_id = p_org_id AND av.version_id = v_version_id
            AND av.state = 'published' AND av.location = 'local_only'
            AND av.classification = 'local_only'
            AND av.provenance ->> 'run_id' = p_run_id::text
        ) THEN
          v_deliverable_ok := false;
        END IF;
      END LOOP;
      IF jsonb_array_length(p_finish -> 'deliverable_versions') = 0
         OR NOT v_deliverable_ok THEN
        v_reject := 'finish_precondition_failed';
      END IF;
    END IF;
  END IF;

  v_server_signature := 'sha256:' || work.sha256_text('run_finish|' || p_run_id::text
    || '|' || p_finish_id::text || '|' || v_outcome || '|'
    || COALESCE(v_reject, 'accepted') || '|' || v_set_hash);

  IF v_reject IS NOT NULL THEN
    INSERT INTO work.device_run_finish
      (org_id, run_id, finish_id, binding_revision, fence, lease_id, outcome,
       reason_code, final_checkpoint_seq, final_checkpoint_hash, receipt_through_seq,
       final_operation_set_hash, deliverable_versions, signed_payload_hash, state,
       reject_code, terminal_run_revision, server_signature, unresolved_operations)
    VALUES
      (p_org_id, p_run_id, p_finish_id, p_binding_revision, p_fence, p_lease_id,
       v_outcome, v_reason, (p_finish ->> 'final_checkpoint_seq')::bigint,
       p_finish ->> 'final_checkpoint_hash',
       (p_finish ->> 'receipt_through_seq')::bigint, v_set_hash,
       p_finish -> 'deliverable_versions', v_signed_hash, 'rejected', v_reject, NULL,
       v_server_signature, v_unresolved);
    PERFORM work.append_audit(p_org_id, NULL, 'run.finish_local_rejected',
      'run', p_run_id::text,
      jsonb_build_object('finish_id', p_finish_id, 'code', v_reject,
        'expected_operation_set_hash', v_set_hash));
    RETURN jsonb_build_object('finish_id', p_finish_id, 'state', 'rejected',
      'code', v_reject, 'terminal_run_revision', NULL,
      'expected_operation_set_hash', v_set_hash, 'unresolved_operations', v_unresolved,
      'server_signature', v_server_signature, 'replayed', false);
  END IF;

  v_run_outcome := CASE v_outcome WHEN 'completed' THEN 'succeeded' ELSE 'failed' END;
  v_terminal := work.finish_local_run_state(p_org_id, p_run_id, v_run_outcome, v_reason);

  INSERT INTO work.device_run_finish
    (org_id, run_id, finish_id, binding_revision, fence, lease_id, outcome,
     reason_code, final_checkpoint_seq, final_checkpoint_hash, receipt_through_seq,
     final_operation_set_hash, deliverable_versions, signed_payload_hash, state,
     reject_code, terminal_run_revision, server_signature, unresolved_operations)
  VALUES
    (p_org_id, p_run_id, p_finish_id, p_binding_revision, p_fence, p_lease_id,
     v_outcome, v_reason, (p_finish ->> 'final_checkpoint_seq')::bigint,
     p_finish ->> 'final_checkpoint_hash',
     (p_finish ->> 'receipt_through_seq')::bigint, v_set_hash,
     p_finish -> 'deliverable_versions', v_signed_hash, 'accepted', NULL, v_terminal,
     v_server_signature, v_unresolved);

  v_response := jsonb_build_object('finish_id', p_finish_id, 'state', 'accepted',
    'code', NULL, 'terminal_run_revision', v_terminal,
    'expected_operation_set_hash', v_set_hash, 'unresolved_operations', v_unresolved,
    'server_signature', v_server_signature);
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

ALTER FUNCTION work.record_device_receipt(text, uuid, uuid, jsonb) OWNER TO work_owner;
ALTER FUNCTION work.consume_device_permit(text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) OWNER TO work_owner;
ALTER FUNCTION work.acquire_device_lease(text, uuid, uuid, uuid, bigint, text, uuid, int) OWNER TO work_owner;
ALTER FUNCTION work.finish_local_run(text, uuid, uuid, uuid, bigint, bigint, jsonb, uuid, uuid) OWNER TO work_owner;
REVOKE ALL ON FUNCTION work.record_device_receipt(text, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.consume_device_permit(text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.acquire_device_lease(text, uuid, uuid, uuid, bigint, text, uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.finish_local_run(text, uuid, uuid, uuid, bigint, bigint, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.record_device_receipt(text, uuid, uuid, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.consume_device_permit(text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.acquire_device_lease(text, uuid, uuid, uuid, bigint, text, uuid, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.finish_local_run(text, uuid, uuid, uuid, bigint, bigint, jsonb, uuid, uuid) TO work_worker;
RESET ROLE;
