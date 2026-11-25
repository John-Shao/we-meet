-- 0070: independent device_local model-result replay identity and reconciliation.
-- ACTION receipt sequencing remains untouched; immutable dispatch is the ownership authority.
SET ROLE work_owner;

CREATE TABLE work.device_model_result (
  org_id text NOT NULL,
  model_result_id uuid NOT NULL,
  run_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL,
  outcome text,
  result_hash text,
  provider_request_id text,
  model text NOT NULL,
  usage_date date,
  input_tokens bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  usage_estimated boolean,
  error_code text,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, model_result_id),
  UNIQUE (org_id, operation_id, attempt_id),
  CONSTRAINT device_model_result_run_fkey
    FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id),
  CONSTRAINT device_model_result_operation_fkey
    FOREIGN KEY (operation_id, org_id) REFERENCES work.operation(id, org_id),
  CONSTRAINT device_model_result_device_fkey
    FOREIGN KEY (device_id, org_id) REFERENCES work.device(id, org_id),
  CONSTRAINT device_model_result_session_fkey
    FOREIGN KEY (session_id, org_id) REFERENCES work.device_session(id, org_id),
  CONSTRAINT device_model_result_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id),
  CONSTRAINT device_model_result_request_hash_shape
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_model_result_result_hash_shape
    CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_model_result_payload_hash_shape
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_model_result_state_shape CHECK (
    (state = 'completed' AND outcome IN ('succeeded', 'failed'))
    OR (state = 'unknown' AND outcome IS NULL)
  ),
  CONSTRAINT device_model_result_success_shape CHECK (
    state <> 'completed' OR outcome <> 'succeeded'
    OR (result_hash IS NOT NULL AND usage_date IS NOT NULL
        AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
        AND cached_input_tokens IS NOT NULL AND usage_estimated IS NOT NULL
        AND input_tokens >= 0 AND output_tokens >= 0 AND cached_input_tokens >= 0
        AND cached_input_tokens <= input_tokens AND error_code IS NULL)
  ),
  CONSTRAINT device_model_result_failure_shape CHECK (
    state <> 'completed' OR outcome <> 'failed'
    OR (result_hash IS NULL AND provider_request_id IS NULL AND usage_date IS NULL
        AND input_tokens IS NULL AND output_tokens IS NULL
        AND cached_input_tokens IS NULL AND usage_estimated IS NULL
        AND error_code IS NOT NULL AND btrim(error_code) <> '')
  ),
  CONSTRAINT device_model_result_unknown_shape CHECK (
    state <> 'unknown'
    OR (result_hash IS NULL AND provider_request_id IS NULL AND usage_date IS NULL
        AND input_tokens IS NULL AND output_tokens IS NULL
        AND cached_input_tokens IS NULL AND usage_estimated IS NULL
        AND error_code IS NOT NULL AND btrim(error_code) <> '')
  )
);

ALTER TABLE work.device_model_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.device_model_result FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.device_model_result
USING (org_id = current_setting('app.org_id', true))
WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE INDEX work_device_model_result_run
  ON work.device_model_result(org_id, run_id, recorded_at);
CREATE INDEX work_device_model_result_usage
  ON work.device_model_result(org_id, usage_date, model)
  WHERE state = 'completed' AND outcome = 'succeeded';

CREATE TRIGGER device_model_result_no_mutation
BEFORE UPDATE OR DELETE ON work.device_model_result
FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();

CREATE FUNCTION work.record_device_model_result_frame(
  p_org_id text,
  p_device_id uuid,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_keys text[] := ARRAY[
    'model_result_id', 'run_id', 'operation_id', 'attempt_id', 'request_hash',
    'state', 'outcome', 'result_hash', 'provider_request_id', 'model', 'usage',
    'error_code', 'signature'
  ];
  v_model_result_id uuid;
  v_run_id uuid;
  v_operation_id uuid;
  v_attempt_id uuid;
  v_request_hash text;
  v_state text;
  v_outcome text;
  v_result_hash text;
  v_provider_request_id text;
  v_model text;
  v_usage jsonb;
  v_error_code text;
  v_input_tokens bigint;
  v_output_tokens bigint;
  v_cached_input_tokens bigint;
  v_usage_estimated boolean;
  v_usage_date date;
  v_payload_hash text;
  v_resolution_signature text;
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_operation work.operation%ROWTYPE;
  v_action work.local_action%ROWTYPE;
  v_dispatch work.device_dispatch%ROWTYPE;
  v_execution work.runtime_execution%ROWTYPE;
  v_existing work.device_model_result%ROWTYPE;
  v_reservation work.quota_reservation%ROWTYPE;
  v_fact work.operation_usage_fact%ROWTYPE;
  v_recorded_result jsonb;
  v_usage_revision int;
  v_counted boolean := false;
  v_settled boolean := false;
  v_execution_state text;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  IF p_device_id IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR NOT (p_payload ?& v_keys)
     OR (p_payload - v_keys) <> '{}'::jsonb
     OR COALESCE(p_payload ->> 'signature', '') !~ '^[A-Za-z0-9_-]{86}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_model_result_id := CASE WHEN (p_payload ->> 'model_result_id') ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN (p_payload ->> 'model_result_id')::uuid ELSE NULL END;
  v_run_id := CASE WHEN (p_payload ->> 'run_id') ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN (p_payload ->> 'run_id')::uuid ELSE NULL END;
  v_operation_id := CASE WHEN (p_payload ->> 'operation_id') ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN (p_payload ->> 'operation_id')::uuid ELSE NULL END;
  v_attempt_id := CASE WHEN (p_payload ->> 'attempt_id') ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN (p_payload ->> 'attempt_id')::uuid ELSE NULL END;
  IF v_model_result_id IS NULL OR v_run_id IS NULL OR v_operation_id IS NULL
     OR v_attempt_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_request_hash := p_payload ->> 'request_hash';
  v_state := p_payload ->> 'state';
  v_outcome := p_payload ->> 'outcome';
  v_result_hash := p_payload ->> 'result_hash';
  v_provider_request_id := p_payload ->> 'provider_request_id';
  v_model := btrim(COALESCE(p_payload ->> 'model', ''));
  v_usage := p_payload -> 'usage';
  v_error_code := NULLIF(btrim(COALESCE(p_payload ->> 'error_code', '')), '');
  IF COALESCE(v_request_hash, '') !~ '^[0-9a-f]{64}$'
     OR v_state IS NULL OR v_state NOT IN ('completed', 'unknown')
     OR (v_state = 'completed' AND v_outcome IS DISTINCT FROM 'succeeded'
         AND v_outcome IS DISTINCT FROM 'failed')
     OR (v_state = 'unknown' AND v_outcome IS NOT NULL)
     OR v_model = ''
     OR (v_result_hash IS NOT NULL AND v_result_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  IF v_state = 'completed' AND v_outcome = 'succeeded' THEN
    IF v_result_hash IS NULL OR v_error_code IS NOT NULL OR jsonb_typeof(v_usage) <> 'object'
       OR (v_usage - ARRAY['input_tokens', 'output_tokens', 'cached_input_tokens', 'estimated'])
          <> '{}'::jsonb
       OR NOT (v_usage ?& ARRAY['input_tokens', 'output_tokens', 'cached_input_tokens', 'estimated'])
       OR COALESCE(v_usage ->> 'input_tokens', '') !~ '^[0-9]+$'
       OR COALESCE(v_usage ->> 'output_tokens', '') !~ '^[0-9]+$'
       OR COALESCE(v_usage ->> 'cached_input_tokens', '') !~ '^[0-9]+$'
       OR jsonb_typeof(v_usage -> 'estimated') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'invalid_request:usage' USING ERRCODE = '22023';
    END IF;
    v_input_tokens := (v_usage ->> 'input_tokens')::bigint;
    v_output_tokens := (v_usage ->> 'output_tokens')::bigint;
    v_cached_input_tokens := (v_usage ->> 'cached_input_tokens')::bigint;
    v_usage_estimated := (v_usage ->> 'estimated')::boolean;
    IF v_cached_input_tokens > v_input_tokens THEN
      RAISE EXCEPTION 'invalid_request:usage' USING ERRCODE = '22023';
    END IF;
  ELSIF v_state = 'unknown' OR v_outcome = 'failed' THEN
    IF v_error_code IS NULL OR v_result_hash IS NOT NULL
       OR v_provider_request_id IS NOT NULL OR v_usage IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_payload_hash := work.sha256_text((p_payload - 'signature')::text);
  SELECT * INTO v_existing FROM work.device_model_result
    WHERE org_id = p_org_id AND model_result_id = v_model_result_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.device_id <> p_device_id OR v_existing.payload_hash <> v_payload_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('state', 'recorded', 'code', NULL,
      'model_result_id', v_model_result_id, 'operation_id', v_operation_id,
      'replayed', true);
  END IF;
  SELECT * INTO v_existing FROM work.device_model_result
    WHERE org_id = p_org_id AND operation_id = v_operation_id
      AND attempt_id = v_attempt_id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
  END IF;

  SELECT run_id INTO v_run.id FROM work.operation
    WHERE org_id = p_org_id AND id = v_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_run := work.lock_runtime_run(p_org_id, v_run.id);
  IF v_run.id <> v_run_id THEN
    RAISE EXCEPTION 'runtime_execution_binding_conflict' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  SELECT * INTO v_operation FROM work.operation
    WHERE org_id = p_org_id AND id = v_operation_id FOR UPDATE;
  IF v_operation.dispatch_attempt_id <> v_attempt_id
     OR v_operation.request_hash <> v_request_hash THEN
    RAISE EXCEPTION 'runtime_execution_binding_conflict' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_action FROM work.local_action
    WHERE org_id = p_org_id AND operation_id = v_operation_id
      AND attempt_id = v_attempt_id;
  IF NOT FOUND OR v_action.action_kind <> 'model.send_device_local'
     OR v_action.destination_id <> 'device_local'
     OR v_action.request_hash <> v_request_hash THEN
    RAISE EXCEPTION 'runtime_execution_binding_conflict' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_dispatch FROM work.device_dispatch
    WHERE org_id = p_org_id AND operation_id = v_operation_id
      AND attempt_id = v_attempt_id FOR UPDATE;
  IF NOT FOUND OR v_dispatch.device_id <> p_device_id
     OR v_dispatch.request_hash <> v_request_hash THEN
    RAISE EXCEPTION 'runtime_execution_binding_conflict' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_execution FROM work.runtime_execution
    WHERE org_id = p_org_id AND run_id = v_run_id
      AND operation_id = v_operation_id AND dispatch_attempt_id = v_attempt_id
      AND mode = 'execute'
      AND split_part(holder_id, ':', 2) = p_device_id::text
      AND split_part(holder_id, ':', 3) = v_dispatch.session_id::text
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR v_execution.state NOT IN ('active', 'completed', 'expired', 'revoked') THEN
    RAISE EXCEPTION 'runtime_execution_binding_conflict' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM work.device d
    WHERE d.org_id = p_org_id AND d.id = p_device_id AND d.status = 'revoked'
  ) OR NOT EXISTS (
    SELECT 1 FROM work.device_session s
    WHERE s.org_id = p_org_id AND s.id = v_dispatch.session_id
      AND s.device_id = p_device_id
  ) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_operation.state NOT IN ('dispatching', 'unknown', 'unresolved', 'succeeded',
                              'reconciled', 'failed', 'canceled') THEN
    RAISE EXCEPTION 'operation_not_confirmable' USING ERRCODE = 'P0001';
  END IF;

  IF v_state = 'unknown' THEN
    IF v_operation.state <> 'unknown' THEN
      PERFORM work.mark_operation_unknown(p_org_id, v_operation_id, 'model_io_unknown');
    END IF;
  ELSE
    IF v_outcome = 'succeeded' THEN
      v_usage_date := (v_dispatch.created_at AT TIME ZONE 'UTC')::date;
      SELECT * INTO v_fact FROM work.operation_usage_fact
        WHERE org_id = p_org_id AND operation_id = v_operation_id
        ORDER BY usage_revision DESC LIMIT 1;
      IF v_fact.id IS NOT NULL THEN
        IF v_fact.source_receipt_hash <> v_result_hash
           OR v_fact.usage_source <> 'device_adapter'
           OR v_fact.provider <> 'device_local'
           OR v_fact.model <> v_model
           OR v_fact.input_tokens <> v_input_tokens
           OR v_fact.output_tokens <> v_output_tokens
           OR v_fact.cached_input_tokens <> v_cached_input_tokens THEN
          RAISE EXCEPTION 'usage_receipt_conflict' USING ERRCODE = 'P0001';
        END IF;
        v_usage_revision := v_fact.usage_revision;
      ELSE
        v_usage_revision := 1;
        INSERT INTO work.operation_usage_fact
          (org_id, operation_id, usage_revision, origin, usage_source, source_receipt_hash,
           subject_id, provider, model, usage_date, input_tokens, output_tokens,
           cached_input_tokens, counted_in_usage_daily)
        VALUES
          (p_org_id, v_operation_id, 1, 'command', 'device_adapter', v_result_hash,
           v_task.owner_subject_id, 'device_local', v_model, v_usage_date,
           v_input_tokens, v_output_tokens, v_cached_input_tokens, true);
        PERFORM work.accumulate_usage_daily(
          p_org_id, v_task.owner_subject_id, 'device_local', v_model, v_usage_date,
          v_input_tokens, v_output_tokens, v_cached_input_tokens, 1
        );
        UPDATE work.operation
        SET usage_recorded_at = COALESCE(usage_recorded_at, now()), updated_at = now()
        WHERE org_id = p_org_id AND id = v_operation_id;
        v_counted := true;
      END IF;

      SELECT * INTO v_reservation FROM work.quota_reservation
        WHERE org_id = p_org_id AND operation_id = v_operation_id
        ORDER BY reservation_seq DESC LIMIT 1 FOR UPDATE;
      IF v_reservation.id IS NOT NULL THEN
        IF v_reservation.state IN ('held', 'unknown') THEN
          PERFORM work.settle_quota(
            v_reservation.id, v_input_tokens + v_output_tokens,
            jsonb_build_object('resolution', 'device_model_result',
              'model_result_id', v_model_result_id, 'result_hash', v_result_hash,
              'usage_source', 'device_adapter', 'usage_revision', v_usage_revision),
            v_reservation.settlement_revision + 1
          );
          v_settled := true;
        END IF;
      END IF;
      IF v_execution.state = 'active' THEN
        v_execution_state := work.complete_device_model_execution(
          p_org_id, v_execution.execution_id, 'model_result_recorded');
      ELSE
        v_execution_state := v_execution.state;
      END IF;
      v_recorded_result := jsonb_build_object('usage_revision', v_usage_revision,
        'usage_counted', v_counted, 'settled', v_settled,
        'execution_state', v_execution_state);
    ELSE
      SELECT * INTO v_reservation FROM work.quota_reservation
        WHERE org_id = p_org_id AND operation_id = v_operation_id
        ORDER BY reservation_seq DESC LIMIT 1 FOR UPDATE;
      IF v_reservation.id IS NOT NULL AND v_reservation.state IN ('held', 'unknown') THEN
        PERFORM work.settle_quota(
          v_reservation.id, 0,
          jsonb_build_object('resolution', 'device_model_result_failed',
            'model_result_id', v_model_result_id, 'usage_source', 'device_adapter'),
          v_reservation.settlement_revision + 1
        );
      END IF;
      IF v_execution.state = 'active' THEN
        PERFORM work.complete_device_model_execution(
          p_org_id, v_execution.execution_id, 'model_result_failed');
      END IF;
    END IF;

    UPDATE work.operation
    SET provider_request_id = CASE WHEN v_outcome = 'succeeded'
                                   THEN v_provider_request_id ELSE NULL END,
        receipt_ref = 'model_result:' || v_model_result_id::text,
        revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = v_operation_id;
    v_resolution_signature := 'sha256:' || work.sha256_text(
      'model_result|' || v_model_result_id::text || '|' || v_outcome || '|' || v_payload_hash);
    IF v_operation.state NOT IN ('succeeded', 'failed', 'canceled', 'reconciled') THEN
      PERFORM work.issue_operation_resolution(
        p_org_id, v_operation_id, v_outcome, NULL, NULL, v_resolution_signature, NULL,
        jsonb_build_object('model_result_id', v_model_result_id,
          'model_result_payload_hash', v_payload_hash, 'attempt_id', v_attempt_id,
          'device_id', p_device_id, 'session_id', v_dispatch.session_id,
          'execution_id', v_execution.execution_id, 'usage_source', 'device_adapter')
      );
    END IF;
  END IF;

  INSERT INTO work.device_model_result
    (org_id, model_result_id, run_id, operation_id, attempt_id, device_id, session_id,
     execution_id, request_hash, state, outcome, result_hash, provider_request_id, model,
     usage_date, input_tokens, output_tokens, cached_input_tokens, usage_estimated,
     error_code, payload_hash, payload)
  VALUES
    (p_org_id, v_model_result_id, v_run_id, v_operation_id, v_attempt_id, p_device_id,
     v_dispatch.session_id, v_execution.execution_id, v_request_hash, v_state, v_outcome,
     v_result_hash, v_provider_request_id, v_model, v_usage_date, v_input_tokens,
     v_output_tokens, v_cached_input_tokens, v_usage_estimated, v_error_code,
     v_payload_hash, p_payload);

  PERFORM work.append_audit(
    p_org_id, NULL, 'device_model.result_frame_recorded', 'operation', v_operation_id::text,
    jsonb_build_object('model_result_id', v_model_result_id, 'attempt_id', v_attempt_id,
      'state', v_state, 'outcome', v_outcome, 'payload_hash', v_payload_hash,
      'usage_result', v_recorded_result)
  );
  RETURN jsonb_build_object('state', 'recorded', 'code', NULL,
    'model_result_id', v_model_result_id, 'operation_id', v_operation_id,
    'replayed', false);
END;
$$;

ALTER FUNCTION work.record_device_model_result_frame(text, uuid, jsonb) OWNER TO work_owner;
REVOKE ALL ON FUNCTION work.record_device_model_result_frame(text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.record_device_model_result_frame(text, uuid, jsonb) TO work_worker;

RESET ROLE;
