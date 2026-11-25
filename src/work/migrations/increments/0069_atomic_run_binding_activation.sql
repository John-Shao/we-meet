-- 0069: atomic local-Run binding activation.
-- Creating a binding activates queued/waiting Run, creates its execute lease and
-- writes the missing seq=0 baseline in one transaction. run_start is signed only
-- after ready is committed; non-ready answers roll the activation back to waiting.

SET ROLE work_owner;

INSERT INTO work.state_transition (entity, from_state, to_state) VALUES
  ('device_run_binding', 'offered', 'active')
ON CONFLICT DO NOTHING;

CREATE FUNCTION work.activate_device_run_binding(
  p_org_id text,
  p_run_id uuid,
  p_binding_revision bigint,
  p_lease_ttl_seconds int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_org work.org%ROWTYPE;
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_cp work.device_checkpoint%ROWTYPE;
  v_lease_id uuid;
  v_expiry timestamptz;
  v_run_state text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  IF p_binding_revision IS NULL OR p_binding_revision < 1
     OR p_lease_ttl_seconds IS NULL OR p_lease_ttl_seconds NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_org FROM work.org WHERE id = p_org_id FOR SHARE;
  SELECT * INTO v_task FROM work.task
    WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  IF NOT FOUND OR v_task.state <> 'open' OR v_task.active_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id
      AND binding_revision = p_binding_revision FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = v_binding.device_id FOR UPDATE;
  IF NOT FOUND OR v_device.status <> 'active' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = v_binding.session_id
      AND device_id = v_binding.device_id FOR UPDATE;
  IF NOT FOUND OR v_session.state <> 'active' OR v_session.expires_at <= clock_timestamp()
     OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_lease FROM work.execution_lease
    WHERE org_id = p_org_id AND run_id = p_run_id
      AND binding_revision = p_binding_revision AND purpose = 'execute'
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND AND v_lease.state = 'active' AND v_lease.expires_at > clock_timestamp()
     AND v_binding.state = 'active' AND v_run.state = 'active' THEN
    RETURN jsonb_build_object('lease_id', v_lease.id, 'fence', v_lease.fence,
      'generation', v_lease.generation, 'expires_at', v_lease.expires_at,
      'checkpoint_seq', 0, 'checkpoint_hash', v_binding.input_hash, 'state', 'active');
  END IF;

  IF v_run.state = 'active' THEN
    IF EXISTS (SELECT 1 FROM work.audit_event a
        WHERE a.org_id = p_org_id AND a.action = 'device_lease.acquired'
          AND a.metadata -> 'response' ->> 'run_id' = p_run_id::text) THEN
      RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM work.execution_lease l
        WHERE l.org_id = p_org_id AND l.run_id = p_run_id
          AND l.state = 'active' AND l.expires_at > clock_timestamp()) THEN
      RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
    END IF;
    UPDATE work.execution_lease
      SET state = 'revoked', revision = revision + 1, updated_at = clock_timestamp()
      WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'active';
    UPDATE work.device_run_binding
      SET state = 'canceled', updated_at = clock_timestamp(), revision = revision + 1
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND binding_revision <> p_binding_revision AND state IN ('offered', 'ready', 'active');
    UPDATE work.run
      SET state = 'waiting', wait_reason = 'input',
          control_revision = control_revision + 1, updated_at = clock_timestamp()
      WHERE org_id = p_org_id AND id = p_run_id AND state = 'active';
    SELECT * INTO v_run FROM work.run
      WHERE org_id = p_org_id AND id = p_run_id;
    v_run_state := 'active_expired_before_ready';
  END IF;
  IF v_run.state NOT IN ('queued', 'waiting') THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM work.operation
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND state IN ('unknown', 'unresolved')) THEN
    RAISE EXCEPTION 'run_has_unreconciled_operation' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM work.execution_lease
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND state = 'active' AND purpose = 'reconcile_finish') THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_cp FROM work.device_checkpoint
    WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'recorded'
    ORDER BY checkpoint_seq DESC LIMIT 1;
  IF FOUND AND (v_binding.expected_checkpoint_seq IS NULL
      OR v_binding.expected_checkpoint_seq IS DISTINCT FROM v_cp.checkpoint_seq
      OR v_binding.expected_checkpoint_hash IS DISTINCT FROM v_cp.checkpoint_hash) THEN
    RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
  END IF;
  IF NOT FOUND AND (v_binding.expected_checkpoint_seq IS NOT NULL
      OR v_binding.expected_checkpoint_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
  END IF;

  IF v_run_state IS NULL THEN
    v_run_state := v_run.state;
  END IF;
  IF v_run.state = 'queued' THEN
    v_run := work.acquire_run(p_run_id, p_org_id);
  ELSE
    PERFORM work.resume_run(p_org_id, p_run_id);
    SELECT * INTO v_run FROM work.run
      WHERE org_id = p_org_id AND id = p_run_id;
  END IF;

  UPDATE work.execution_lease
    SET state = 'revoked', revision = revision + 1, updated_at = clock_timestamp()
    WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'active'
      AND purpose = 'execute' AND binding_revision <> p_binding_revision;
  IF FOUND THEN
    PERFORM work.append_audit(p_org_id, NULL, 'device_lease.revoked', 'run', p_run_id::text,
      jsonb_build_object('binding_revision', p_binding_revision, 'reason', 'binding_replaced'));
  END IF;

  v_lease_id := gen_random_uuid();
  v_expiry := clock_timestamp() + make_interval(secs => p_lease_ttl_seconds);
  INSERT INTO work.execution_lease
    (org_id, id, run_id, device_id, session_id, binding_revision, fence, generation,
     purpose, start_nonce, expires_at)
  VALUES
    (p_org_id, v_lease_id, p_run_id, v_binding.device_id, v_binding.session_id,
     p_binding_revision, v_run.fence, COALESCE(v_org.access_epoch, 0), 'execute',
     v_binding.start_nonce, v_expiry);

  IF NOT EXISTS (SELECT 1 FROM work.device_checkpoint
      WHERE org_id = p_org_id AND run_id = p_run_id AND checkpoint_seq = 0) THEN
    INSERT INTO work.device_checkpoint
      (org_id, run_id, checkpoint_seq, binding_revision, fence, checkpoint_hash,
       local_ref, receipt_through_seq, pending_operation_set_hash, signed_payload_hash)
    VALUES
      (p_org_id, p_run_id, 0, p_binding_revision, v_run.fence, v_binding.input_hash,
       v_binding.input_ref, 0, work.sha256_text('[]'), NULL);
  END IF;

  UPDATE work.device_run_binding
    SET state = 'active', revision = revision + 1, updated_at = clock_timestamp()
    WHERE org_id = p_org_id AND run_id = p_run_id
      AND binding_revision = p_binding_revision AND state = 'offered';

  PERFORM work.append_audit(p_org_id, NULL, 'device_run_binding.activated', 'run', p_run_id::text,
    jsonb_build_object('binding_revision', p_binding_revision, 'lease_id', v_lease_id,
      'run_state_before', v_run_state, 'fence', v_run.fence,
      'checkpoint_seq', 0, 'checkpoint_hash', v_binding.input_hash));
  RETURN jsonb_build_object('lease_id', v_lease_id, 'fence', v_run.fence,
    'generation', COALESCE(v_org.access_epoch, 0), 'expires_at', v_expiry,
    'checkpoint_seq', 0, 'checkpoint_hash', v_binding.input_hash, 'state', 'active');
END;
$$;

CREATE OR REPLACE FUNCTION work.create_device_run_binding(
  p_org_id text,
  p_run_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_binding_revision bigint,
  p_client_request_id text,
  p_offer jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_activation jsonb;
  v_nonce uuid;
  v_expiry timestamptz;
  v_ttl int;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  v_request_hash := work.sha256_text('device_run_binding.create|' || p_run_id::text
    || '|' || p_binding_revision::text || '|' || COALESCE(p_offer::text, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND action = 'device_run_binding.create'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF p_offer IS NULL OR jsonb_typeof(p_offer) <> 'object'
     OR p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_binding_revision IS NULL OR p_binding_revision < 1 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.org WHERE id = p_org_id FOR SHARE;
  PERFORM 1 FROM work.task WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id FOR UPDATE;
  IF NOT FOUND OR v_device.status <> 'active' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id AND device_id = p_device_id FOR UPDATE;
  IF NOT FOUND OR v_session.state <> 'active' OR v_session.expires_at <= clock_timestamp()
     OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND action = 'device_run_binding.create'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF NOT work.binding_grant_set_valid(p_offer -> 'grant_set')
     OR (p_offer ->> 'input_ref') IS NULL OR (p_offer ->> 'input_ref') = ''
     OR (p_offer ->> 'input_hash') IS NULL
     OR (p_offer ->> 'input_hash') !~ '^[0-9a-f]{64}$'
     OR (p_offer ->> 'snapshot_hash') IS NULL
     OR (p_offer ->> 'snapshot_hash') !~ '^[0-9a-f]{64}$'
     OR (p_offer ->> 'profile_id') IS NULL OR (p_offer ->> 'profile_id') = ''
     OR (p_offer ->> 'runtime_digest') IS NULL
     OR (p_offer ->> 'runtime_digest') !~ '^[0-9a-f]{64}$'
     OR (p_offer ->> 'tool_manifest_hash') IS NULL
     OR (p_offer ->> 'tool_manifest_hash') !~ '^[0-9a-f]{64}$'
     OR (p_offer ->> 'model_version') IS NULL OR (p_offer ->> 'model_version') = '' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_ttl := COALESCE(NULLIF(p_offer ->> 'offer_ttl_seconds', '')::int, 120);
  IF v_ttl < 1 OR v_ttl > 600 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_nonce := gen_random_uuid();
  v_expiry := now() + make_interval(secs => v_ttl);

  -- The activation helper writes the missing seq=0 baseline in this same transaction;
  -- acquire_device_lease only signs run_start after ready has committed.
  INSERT INTO work.device_run_binding
    (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
     input_hash, snapshot_descriptor_ref, snapshot_hash, profile_id, profile_revision,
     runtime_digest, tool_manifest_hash, model_version, grant_set,
     expected_checkpoint_seq, expected_checkpoint_hash, start_nonce, offer_expiry, state)
  VALUES
    (p_org_id, p_run_id, p_binding_revision, v_run.task_id, p_device_id, p_session_id,
     p_offer ->> 'input_ref', p_offer ->> 'input_hash',
     p_offer ->> 'snapshot_descriptor_ref', p_offer ->> 'snapshot_hash',
     p_offer ->> 'profile_id',
     COALESCE(NULLIF(p_offer ->> 'profile_revision', '')::bigint, 0),
     p_offer ->> 'runtime_digest', p_offer ->> 'tool_manifest_hash',
     p_offer ->> 'model_version', p_offer -> 'grant_set',
     NULLIF(p_offer ->> 'expected_checkpoint_seq', '')::bigint,
     p_offer ->> 'expected_checkpoint_hash', v_nonce, v_expiry, 'offered');
  v_activation := work.activate_device_run_binding(
    p_org_id, p_run_id, p_binding_revision, 30);

  v_response := jsonb_build_object('run_id', p_run_id, 'binding_revision', p_binding_revision,
    'task_id', v_run.task_id, 'device_id', p_device_id, 'start_nonce', v_nonce,
    'offer_expiry', v_expiry, 'state', 'active',
    'lease_id', v_activation ->> 'lease_id',
    'checkpoint_seq', v_activation -> 'checkpoint_seq',
    'checkpoint_hash', v_activation ->> 'checkpoint_hash',
    'expected_checkpoint_seq', p_offer -> 'expected_checkpoint_seq',
    'expected_checkpoint_hash', p_offer -> 'expected_checkpoint_hash');
  PERFORM work.append_audit(p_org_id, NULL, 'device_run_binding.create',
    'run', p_run_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION work.list_pending_device_offers(
  p_org_id text,
  p_device_id uuid,
  p_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_result jsonb;
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

  -- Read-only. Legacy offered/ready rows remain visible; an atomically activated row is
  -- visible only while its execute lease is live and run_start has not yet been signed.
  --
  -- Targeted by device_id AND session_id, unlike claim_pending_device_resolutions (0049),
  -- which is deliberately device-level so a conclusion survives a reconnect. An offer is not
  -- a conclusion: the binding is session-bound (§3.2 "worker从该记录向原设备发送签名run_offer",
  -- and the restated acknowledge_run_ready below refuses an answer from any other session),
  -- so re-pushing an old session's offer to a new session would hand the device something it
  -- has no right to accept. After a reconnect the worker re-offers under a higher
  -- binding_revision bound to the new session instead — the resume flow §3.2 describes.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'run_id', b.run_id,
    'binding_revision', b.binding_revision,
    'binding_hash', work.sha256_text('run_offer|' || b.run_id::text || '|'
      || b.binding_revision::text || '|' || b.start_nonce::text),
    'task_id', b.task_id,
    'device_id', b.device_id,
    'session_id', b.session_id,
    'input_ref', b.input_ref,
    'input_hash', b.input_hash,
    'snapshot_descriptor_ref', b.snapshot_descriptor_ref,
    'snapshot_hash', b.snapshot_hash,
    'profile_id', b.profile_id,
    'profile_revision', b.profile_revision,
    'runtime_digest', b.runtime_digest,
    'tool_manifest_hash', b.tool_manifest_hash,
    'model_version', b.model_version,
    'grant_set', b.grant_set,
    'expected_checkpoint_seq', b.expected_checkpoint_seq,
    'expected_checkpoint_hash', b.expected_checkpoint_hash,
    'start_nonce', b.start_nonce,
    'offer_expiry', b.offer_expiry
  ) ORDER BY b.run_id, b.binding_revision), '[]'::jsonb)
  INTO v_result
  FROM work.device_run_binding b
  WHERE b.org_id = p_org_id
    AND b.device_id = p_device_id
    AND b.session_id = p_session_id
    AND b.binding_revision = (SELECT MAX(latest.binding_revision)
      FROM work.device_run_binding latest
      WHERE latest.org_id = b.org_id AND latest.run_id = b.run_id)
    AND b.state IN ('offered', 'ready', 'active')
    AND b.offer_expiry > clock_timestamp()
    AND (b.state IN ('offered', 'ready') OR EXISTS (
      SELECT 1 FROM work.execution_lease l
      WHERE l.org_id = b.org_id AND l.run_id = b.run_id
        AND l.binding_revision = b.binding_revision AND l.purpose = 'execute'
        AND l.state = 'active' AND l.expires_at > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM work.audit_event a
          WHERE a.org_id = l.org_id AND a.action = 'device_lease.acquired'
            AND a.metadata ->> 'lease_id' = l.id::text)));

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION work.acknowledge_run_ready(
  p_org_id text,
  p_run_id uuid,
  p_binding_revision bigint,
  p_client_request_id text,
  p_ready jsonb,
  p_device_id uuid,
  p_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_state text;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_reason text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  v_request_hash := work.sha256_text('device_run_binding.ready|' || p_run_id::text
    || '|' || p_binding_revision::text || '|' || COALESCE(p_ready::text, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND action = 'device_run_binding.ready'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  v_reason := p_ready ->> 'ready_or_reason';
  IF p_ready IS NULL OR jsonb_typeof(p_ready) <> 'object'
     OR p_client_request_id IS NULL OR p_client_request_id = ''
     OR v_reason IS NULL
     OR v_reason NOT IN ('ready', 'missing_input', 'needs_reauthorization',
                         'profile_unavailable')
     OR (p_ready ->> 'binding_hash') IS NULL
     OR (p_ready ->> 'binding_hash') !~ '^[0-9a-f]{64}$'
     OR (p_ready ->> 'device_signature') IS NULL
     OR (p_ready ->> 'device_signature') !~ '^[A-Za-z0-9_-]{86}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.org WHERE id = p_org_id FOR SHARE;
  SELECT * INTO v_task FROM work.task
    WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  SELECT * INTO v_device FROM work.device
    WHERE org_id = p_org_id AND id = p_device_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_device.status = 'revoked' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id AND device_id = p_device_id FOR UPDATE;
  IF NOT FOUND OR v_session.device_id <> p_device_id OR v_session.state <> 'active'
     OR v_session.expires_at <= clock_timestamp()
     OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id AND binding_revision = p_binding_revision
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_binding.device_id <> p_device_id OR v_binding.session_id <> p_session_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND action = 'device_run_binding.ready'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF v_binding.state = 'active' THEN
    IF v_run.state <> 'active' THEN
      RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_lease FROM work.execution_lease
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND binding_revision = p_binding_revision AND purpose = 'execute'
        AND state = 'active' FOR UPDATE;
    IF FOUND AND EXISTS (SELECT 1 FROM work.audit_event a
        WHERE a.org_id = p_org_id AND a.action = 'device_lease.acquired'
          AND a.metadata ->> 'lease_id' = v_lease.id::text) THEN
      IF v_reason <> 'ready' THEN
        RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
      END IF;
      v_state := 'active';
    ELSIF v_reason = 'ready' THEN
      IF v_binding.offer_expiry <= clock_timestamp()
         OR NOT FOUND OR v_lease.expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
      END IF;
      v_state := 'active';
    ELSE
      IF FOUND THEN
        UPDATE work.execution_lease
          SET state = 'revoked', revision = revision + 1, updated_at = clock_timestamp()
          WHERE org_id = p_org_id AND id = v_lease.id AND state = 'active';
      END IF;
      UPDATE work.device_run_binding
        SET state = 'canceled', updated_at = clock_timestamp(), revision = revision + 1
        WHERE org_id = p_org_id AND run_id = p_run_id
          AND binding_revision = p_binding_revision AND state = 'active';
      UPDATE work.run
        SET state = 'waiting', wait_reason = 'input',
            control_revision = control_revision + 1, updated_at = clock_timestamp()
        WHERE org_id = p_org_id AND id = p_run_id AND state = 'active';
      v_state := 'canceled';
    END IF;
  ELSIF v_reason = 'ready' THEN
    IF v_binding.state = 'offered' THEN
      UPDATE work.device_run_binding
        SET state = 'ready', updated_at = clock_timestamp(), revision = revision + 1
        WHERE org_id = p_org_id AND run_id = p_run_id
          AND binding_revision = p_binding_revision AND state = 'offered';
      v_state := 'ready';
    ELSE
      RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    v_state := v_binding.state;
  END IF;

  v_response := jsonb_build_object('run_id', p_run_id,
    'binding_revision', p_binding_revision, 'ready_or_reason', v_reason,
    'state', v_state);
  PERFORM work.append_audit(p_org_id, NULL, 'device_run_binding.ready',
    'run', p_run_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'response', v_response));
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
  v_task work.task%ROWTYPE;
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
      WHERE org_id = p_org_id AND run_id = p_run_id AND start_nonce = p_start_nonce;
  ELSE
    SELECT * INTO v_lease FROM work.execution_lease
      WHERE org_id = p_org_id AND run_id = p_run_id AND purpose = 'reconcile_finish'
        AND state = 'active';
  END IF;
  IF FOUND THEN
    PERFORM 1 FROM work.org WHERE id = p_org_id FOR SHARE;
    SELECT task_id INTO v_run.task_id FROM work.run
      WHERE org_id = p_org_id AND id = p_run_id;
    SELECT * INTO v_task FROM work.task
      WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
    SELECT * INTO v_run FROM work.run
      WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
    SELECT * INTO v_lease FROM work.execution_lease
      WHERE org_id = p_org_id AND id = v_lease.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
    END IF;
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
    -- CHANGE 3 below is what makes this branch reachable from a reconnected session: the binding
    -- of a superseded session is guard-immutable and names that dead session, so the execute-only
    -- form of the session test is the same relaxation change 1 applies on the finish side.
    IF NOT FOUND OR v_binding.device_id IS DISTINCT FROM p_device_id
       OR (v_lease.purpose = 'execute'
           AND v_binding.session_id IS DISTINCT FROM p_session_id) THEN
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
    SELECT metadata -> 'response' INTO v_response FROM work.audit_event
      WHERE org_id = p_org_id AND action = 'device_lease.acquired'
        AND metadata ->> 'lease_id' = v_lease.id::text;
    IF v_response IS NULL AND p_purpose = 'execute' THEN
      IF v_run.state <> 'active' OR v_task.state <> 'open'
         OR v_task.active_run_id IS DISTINCT FROM p_run_id THEN
        RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
      END IF;
      IF EXISTS (SELECT 1 FROM work.operation
          WHERE org_id = p_org_id AND run_id = p_run_id
            AND state IN ('unknown', 'unresolved')) THEN
        RAISE EXCEPTION 'run_has_unreconciled_operation' USING ERRCODE = 'P0001';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM work.audit_event a
          WHERE a.org_id = p_org_id AND a.action = 'device_run_binding.ready'
            AND a.metadata -> 'response' ->> 'run_id' = p_run_id::text
            AND a.metadata -> 'response' ->> 'binding_revision' = p_binding_revision::text
            AND a.metadata -> 'response' ->> 'ready_or_reason' = 'ready') THEN
        RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM work.device_checkpoint
          WHERE org_id = p_org_id AND run_id = p_run_id AND checkpoint_seq = 0
            AND state = 'recorded') THEN
        RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
      END IF;
      v_response := jsonb_build_object('lease_id', v_lease.id, 'run_id', p_run_id,
        'fence', v_lease.fence, 'generation', v_lease.generation, 'purpose', 'execute',
        'expires_at', v_lease.expires_at, 'ttl_ms', p_ttl_seconds * 1000,
        'start_nonce', p_start_nonce,
        'run_start', jsonb_build_object(
          'run_binding_id', p_binding_revision, 'run_id', p_run_id, 'lease_id', v_lease.id,
          'fence', v_lease.fence, 'start_nonce', p_start_nonce,
          'expiry', LEAST(v_lease.expires_at, clock_timestamp() + interval '5 seconds'),
          'runtime_digest', v_binding.runtime_digest,
          'payload_hash', work.sha256_text('run_start|' || p_run_id::text || '|'
            || p_binding_revision::text || '|' || v_lease.id::text || '|' || p_start_nonce::text)),
        'checkpoint_seq', 0, 'checkpoint_hash', v_binding.input_hash);
      PERFORM work.append_audit(p_org_id, NULL, 'device_lease.acquired', 'run', p_run_id::text,
        jsonb_build_object('lease_id', v_lease.id, 'purpose', 'execute',
          'fence', v_lease.fence, 'start_nonce', p_start_nonce, 'response', v_response));
      RETURN v_response || jsonb_build_object('replayed', false);
    END IF;
    IF v_response IS NULL OR (p_purpose = 'execute' AND
        (v_response #>> '{run_start,expiry}')::timestamptz <= clock_timestamp()) THEN
      RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_response || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_org FROM work.org WHERE id = p_org_id FOR SHARE;
  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
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
    IF v_binding.state = 'active' THEN
      RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
    END IF;
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

  -- 0061 change 2: the reconcile_finish mint reclaims the run's single active-lease slot.
  -- work_execution_lease_one_active_per_run (0040:876) is purpose-agnostic and nothing else
  -- expires a device lease (renew only extends an active row, 0051:121, and there is no
  -- sweeper), so a reconnect that lands inside the crashed execute lease's TTL collided with
  -- that index on the INSERT below and the hand-back lease could not be minted at all. Expire
  -- exactly the row the reconnect superseded: this run, the calling device, purpose 'execute',
  -- still 'active', and an owning session activate_device_session has already terminalized
  -- (0040:1644-1647). The positive-form session test is what keeps it narrow: a lease whose
  -- session is still active is never disarmed, and because a device has at most one active
  -- session the caller can never be expiring the very lease it is standing on. active ->
  -- expired is whitelisted (0040:183) and neither column is in execution_lease_guard's
  -- immutable set (0040:848-858); the row keeps expires_at, fence and last_receipt_seq as the
  -- evidence of what it was, which is also how 0042's terminal write releases a lease.
  IF p_purpose = 'reconcile_finish' THEN
    UPDATE work.execution_lease
      SET state = 'expired', revision = revision + 1, updated_at = now()
      WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'active'
        AND purpose = 'execute' AND device_id = p_device_id
        AND EXISTS (SELECT 1 FROM work.device_session dead
                    WHERE dead.org_id = p_org_id AND dead.id = execution_lease.session_id
                      AND dead.state <> 'active');
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
      'expiry', LEAST(v_expiry, clock_timestamp() + interval '5 seconds'),
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

CREATE OR REPLACE FUNCTION work.rebind_run_workspace(
  p_org_id text,
  p_actor_subject_id text,
  p_auth_plane text,
  p_auth_epoch bigint,
  p_run_id uuid,
  p_client_request_id text,
  p_old_grant_id uuid,
  p_new_grant_id uuid,
  p_proof jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_old work.workspace_grant%ROWTYPE;
  v_new work.workspace_grant%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_activation jsonb;
  v_revision bigint;
  v_nonce uuid;
  v_grant_set jsonb;
  v_invalidated int;
  v_cp_seq bigint;
  v_cp_hash text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);

  v_request_hash := work.sha256_text('run.workspace_rebind|' || p_run_id::text
    || '|' || p_old_grant_id::text || '|' || p_new_grant_id::text
    || '|' || COALESCE(p_proof::text, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND actor_subject_id = p_actor_subject_id
      AND action = 'run.workspace_rebind'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF p_client_request_id IS NULL OR p_client_request_id = ''
     OR p_old_grant_id IS NULL OR p_new_grant_id IS NULL
     OR p_old_grant_id = p_new_grant_id
     OR p_proof IS NULL OR jsonb_typeof(p_proof) <> 'object'
     OR (p_proof ->> 'signature') IS NULL
     OR (p_proof ->> 'signature') !~ '^sha256:[0-9a-f]{64}$'
     OR (p_proof ->> 'nonce') IS NULL
     OR (p_proof ->> 'root_identity_hash') IS NULL
     OR (p_proof ->> 'root_identity_hash') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF (p_proof ->> 'old_grant_id')::uuid IS DISTINCT FROM p_old_grant_id
     OR (p_proof ->> 'new_grant_id')::uuid IS DISTINCT FROM p_new_grant_id
     OR (p_proof ->> 'run_id')::uuid IS DISTINCT FROM p_run_id
     OR p_proof ->> 'auth_plane' IS DISTINCT FROM p_auth_plane
     OR (p_proof ->> 'auth_epoch')::bigint IS DISTINCT FROM p_auth_epoch THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- O-17 = yi: the nonce inside the possession proof is spent here, once per
  -- organization. §12.12 step 4 has always read "verify the signature and
  -- atomically consume the nonce", while the 0041 body only tested that the field
  -- was present and copied its value into the audit metadata - the consumption half
  -- of that signed step had no carrier until this table existed.
  --
  -- Position: after the audit-receipt replay branch (so a retry with the same
  -- client_request_id never reaches it) and after every proof-vs-scalar comparison,
  -- but before any business write - which is also why a rebind that refuses further
  -- down cannot leave a spent nonce behind: the rollback takes this insert with it.
  IF EXISTS (SELECT 1 FROM work.consumed_possession_nonce
             WHERE org_id = p_org_id AND nonce = (p_proof ->> 'nonce')) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO work.consumed_possession_nonce (org_id, purpose, nonce)
    VALUES (p_org_id, 'workspace_rebind', p_proof ->> 'nonce');


  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.org WHERE id = p_org_id FOR SHARE;
  SELECT * INTO v_task FROM work.task
    WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  IF v_task.owner_subject_id IS DISTINCT FROM p_actor_subject_id
     OR v_task.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.state NOT IN ('waiting', 'active')
     OR (v_run.state = 'waiting' AND v_run.wait_reason IS DISTINCT FROM 'input') THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id
    ORDER BY binding_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_binding.grant_set) e
                  WHERE (e ->> 'grant_id')::uuid = p_old_grant_id) THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_old FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = p_old_grant_id FOR UPDATE;
  SELECT * INTO v_new FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = p_new_grant_id FOR UPDATE;
  IF NOT FOUND OR v_new.state <> 'active' THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_new.owner_subject_id IS DISTINCT FROM p_actor_subject_id
     OR v_new.device_id IS DISTINCT FROM v_binding.device_id THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;
  IF v_new.root_identity_hash IS DISTINCT FROM v_old.root_identity_hash
     OR v_new.root_identity_hash IS DISTINCT FROM (p_proof ->> 'root_identity_hash') THEN
    RAISE EXCEPTION 'workspace_identity_changed' USING ERRCODE = 'P0001';
  END IF;

  -- The recovery baseline: newest recorded checkpoint for THIS Run, no fence filter.
  -- NULL only when the Run has no recorded checkpoint at all, which is legitimate for
  -- a rebind that happens before any action ran.
  SELECT checkpoint_seq, checkpoint_hash INTO v_cp_seq, v_cp_hash
    FROM work.device_checkpoint
    WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'recorded'
    ORDER BY checkpoint_seq DESC LIMIT 1;

  v_revision := v_binding.binding_revision + 1;
  v_nonce := gen_random_uuid();
  SELECT jsonb_agg(
           CASE WHEN (e ->> 'grant_id')::uuid = p_old_grant_id
                THEN jsonb_build_object('grant_id', p_new_grant_id,
                                        'grant_revision', v_new.grant_revision)
                ELSE e END)
    INTO v_grant_set
    FROM jsonb_array_elements(v_binding.grant_set) e;

  INSERT INTO work.workspace_grant_succession
    (org_id, run_id, old_grant_id, new_grant_id, proof_hash, binding_revision,
     client_request_id, request_hash)
  VALUES
    (p_org_id, p_run_id, p_old_grant_id, p_new_grant_id,
     work.sha256_text(p_proof::text), v_revision, p_client_request_id, v_request_hash);

  UPDATE work.workspace_grant
    SET state = 'succeeded', succeeded_by = p_new_grant_id, updated_at = now(),
        revision = revision + 1
    WHERE org_id = p_org_id AND id = p_old_grant_id AND state = 'active';

  UPDATE work.readonly_approval_grant
    SET status = 'invalidated', updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND workspace_grant_id = p_old_grant_id AND status = 'active';
  GET DIAGNOSTICS v_invalidated = ROW_COUNT;

  INSERT INTO work.device_run_binding
    (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
     input_hash, snapshot_descriptor_ref, snapshot_hash, profile_id, profile_revision,
     runtime_digest, tool_manifest_hash, model_version, grant_set,
     expected_checkpoint_seq, expected_checkpoint_hash, start_nonce, offer_expiry, state)
  VALUES
    (p_org_id, p_run_id, v_revision, v_binding.task_id, v_binding.device_id,
     v_new.session_id, v_binding.input_ref, v_binding.input_hash,
     v_binding.snapshot_descriptor_ref, v_binding.snapshot_hash, v_binding.profile_id,
     v_binding.profile_revision, v_binding.runtime_digest, v_binding.tool_manifest_hash,
     v_binding.model_version, v_grant_set, v_cp_seq, v_cp_hash, v_nonce,
     now() + interval '120 seconds', 'offered');
  v_activation := work.activate_device_run_binding(
    p_org_id, p_run_id, v_revision, 30);

  UPDATE work.run
    SET control_revision = control_revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_run_id;

  v_response := jsonb_build_object('run_id', p_run_id, 'old_grant_id', p_old_grant_id,
    'new_grant_id', p_new_grant_id, 'binding_revision', v_revision,
    'expected_checkpoint_seq', v_cp_seq, 'expected_checkpoint_hash', v_cp_hash,
    'offer_expiry', now() + interval '120 seconds', 'state', 'active',
    'checkpoint_seq', v_activation -> 'checkpoint_seq',
    'checkpoint_hash', v_activation ->> 'checkpoint_hash',
    'invalidated_readonly_grants', v_invalidated);
  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'run.workspace_rebind',
    'run', p_run_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'nonce', p_proof ->> 'nonce', 'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION work.prepare_local_operation(
  p_org_id text,
  p_run_id uuid,
  p_device_id uuid,
  p_session_id uuid,
  p_lease_id uuid,
  p_fence bigint,
  p_checkpoint_seq bigint,
  p_action jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_task work.task%ROWTYPE;
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_lease work.execution_lease%ROWTYPE;
  v_binding work.device_run_binding%ROWTYPE;
  v_checkpoint work.device_checkpoint%ROWTYPE;
  v_grant work.workspace_grant%ROWTYPE;
  v_policy work.local_execution_policy%ROWTYPE;
  v_old work.operation%ROWTYPE;
  v_old_action work.local_action%ROWTYPE;
  v_existing work.operation%ROWTYPE;
  v_existing_action work.local_action%ROWTYPE;
  v_readonly work.readonly_approval_grant%ROWTYPE;
  v_operation_id uuid;
  v_attempt_id uuid;
  v_approval_id uuid;
  v_kind text;
  v_classification text;
  v_gate text;
  v_taint integer;
  v_max_seq bigint;
  v_step_key text;
  v_supersede_no integer;
  v_reason text;
  v_assertion jsonb;
  v_changed text[];
  v_bucket_count integer;
  v_auto boolean := false;
  v_is_supersede boolean;
  v_succession boolean;
  v_response jsonb;
  v_action_kind text;
  v_destination text;
  v_reservation_id uuid;
  v_final_state text;
  v_final_revision bigint;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF NOT work.local_action_prepare_valid(p_action) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_action_kind := p_action ->> 'action_kind';
  v_destination := p_action ->> 'destination_id';
  v_step_key := p_action ->> 'step_key';
  IF COALESCE(v_step_key, '') = ''
     OR COALESCE(p_action ->> 'logical_key', '') = ''
     OR COALESCE(p_action ->> 'local_payload_ref', '') = ''
     OR COALESCE(p_action ->> 'tool_schema', '') = ''
     OR COALESCE(p_action ->> 'checkpoint_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_action ->> 'request_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_action ->> 'resource_selector_hash', '') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_action ->> 'device_signature', '') !~ '^[A-Za-z0-9_-]{86}$'
     OR COALESCE(p_action ->> 'prepare_id', '') !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_action ->> 'grant_id', '') !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(p_action ->> 'supersede_no', '') !~ '^[0-9]+$'
     OR COALESCE(p_action ->> 'grant_revision', '') !~ '^[0-9]+$'
     OR COALESCE(p_action ->> 'byte_upper_bound', '') !~ '^[0-9]+$'
     OR COALESCE(p_action ->> 'token_upper_bound', '') !~ '^[0-9]+$'
     OR v_action_kind NOT IN ('workspace.list', 'workspace.read', 'workspace.search',
                              'artifact.write', 'model.send_remote',
                              'model.send_device_local')
     OR COALESCE(p_action ->> 'classification', '') NOT IN
        ('local_only', 'remote_excerpt_allowed') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_supersede_no := (p_action ->> 'supersede_no')::integer;
  IF (p_action ->> 'logical_key') <> v_step_key || '#' || v_supersede_no THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_is_supersede := (p_action ->> 'supersedes_operation_id') IS NOT NULL;
  IF v_is_supersede <> ((p_action ->> 'supersede_reason') IS NOT NULL)
     OR v_is_supersede <> ((p_action ->> 'supersede_assertion') IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_is_supersede AND v_supersede_no < 1 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF NOT v_is_supersede AND v_supersede_no <> 0 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- A model action carries a destination; nothing else may claim one.
  IF (v_action_kind IN ('model.send_remote', 'model.send_device_local'))
     <> (v_destination IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF v_destination IS NOT NULL
     AND v_destination NOT IN ('device_local', 'org_private', 'org_remote') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  -- Lock order per control §4.3: Task, Run, Operation, lease.
  SELECT task_id INTO v_run.task_id FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id;
  IF v_run.task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE id = v_run.task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;

  -- Idempotency authority is the operation key, not prepare_id (O-9 = jia). A replay
  -- returns the original row and the original attempt, so the device can re-read the
  -- attempt_id it needs for consume_device_permit without a second dispatch.
  SELECT * INTO v_existing FROM work.operation
    WHERE org_id = p_org_id AND run_id = p_run_id
      AND logical_key = p_action ->> 'logical_key';
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM (p_action ->> 'request_hash') THEN
      RAISE EXCEPTION 'operation_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_existing_action FROM work.local_action
      WHERE org_id = p_org_id AND operation_id = v_existing.id
      ORDER BY created_at LIMIT 1;
    SELECT ao.approval_id INTO v_approval_id FROM work.approval_operation ao
      WHERE ao.org_id = p_org_id AND ao.operation_id = v_existing.id;
    v_response := jsonb_build_object(
      'operation_id', v_existing.id, 'logical_key', v_existing.logical_key,
      'step_key', v_existing.step_key, 'supersede_no', v_existing.supersede_no,
      'state', v_existing.state, 'revision', v_existing.revision,
      'approval_id', v_approval_id,
      'auto_approved', v_approval_id IS NULL AND v_existing.state = 'authorized',
      'request_hash', v_existing.request_hash,
      'attempt_id', v_existing_action.attempt_id,
      'checkpoint_seq', p_checkpoint_seq,
      'classification', v_existing_action.classification,
      'destination_id', v_existing_action.destination_id);
    RETURN v_response || jsonb_build_object('replayed', true);
  END IF;

  -- 1. identity / session / lease / fence / binding_revision / checkpoint.
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
  IF NOT FOUND OR v_session.device_id <> p_device_id
     OR v_session.state <> 'active' OR v_session.expires_at <= now()
     OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_lease FROM work.execution_lease
    WHERE org_id = p_org_id AND id = p_lease_id FOR UPDATE;
  IF NOT FOUND OR v_lease.run_id <> p_run_id OR v_lease.device_id <> p_device_id
     OR v_lease.session_id <> p_session_id OR v_lease.purpose <> 'execute'
     OR v_lease.state <> 'active' OR v_lease.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM work.audit_event a
      WHERE a.org_id = p_org_id AND a.action = 'device_lease.acquired'
        AND a.metadata ->> 'lease_id' = p_lease_id::text) THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.fence IS DISTINCT FROM p_fence OR v_lease.fence IS DISTINCT FROM p_fence THEN
    RAISE EXCEPTION 'stale_fence' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id
      AND binding_revision = v_lease.binding_revision FOR UPDATE;
  IF NOT FOUND OR v_binding.state <> 'active'
     OR v_binding.device_id <> p_device_id OR v_binding.session_id <> p_session_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(MAX(checkpoint_seq), -1) INTO v_max_seq FROM work.device_checkpoint
    WHERE org_id = p_org_id AND run_id = p_run_id AND state = 'recorded';
  IF p_checkpoint_seq IS DISTINCT FROM v_max_seq THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_checkpoint FROM work.device_checkpoint
    WHERE org_id = p_org_id AND run_id = p_run_id AND checkpoint_seq = p_checkpoint_seq;
  IF v_checkpoint.checkpoint_hash IS DISTINCT FROM (p_action ->> 'checkpoint_hash') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- 0041's fail-closed rule, restated on the action path: a resume offer that points at
  -- a baseline may not prepare against a different one.
  IF v_binding.expected_checkpoint_seq IS NOT NULL
     AND (v_binding.expected_checkpoint_seq IS DISTINCT FROM p_checkpoint_seq
          OR v_binding.expected_checkpoint_hash IS DISTINCT FROM
             (p_action ->> 'checkpoint_hash')) THEN
    RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
  END IF;

  -- 2. the local policy gate, with zero side effects on refusal. Literal branches, not
  -- a dynamic RAISE: the apierr coverage gate only recognises literal codes (0040).
  v_gate := work.local_policy_gate(p_org_id);
  IF v_gate = 'local_policy_incomplete' THEN
    RAISE EXCEPTION 'local_policy_incomplete' USING ERRCODE = 'P0001';
  END IF;
  IF v_gate <> 'ready' THEN
    RAISE EXCEPTION 'local_policy_not_configured' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_policy FROM work.local_execution_policy WHERE org_id = p_org_id;

  SELECT * INTO v_grant FROM work.workspace_grant
    WHERE org_id = p_org_id AND id = (p_action ->> 'grant_id')::uuid FOR UPDATE;
  IF NOT FOUND OR v_grant.device_id <> p_device_id OR v_grant.state <> 'active'
     OR v_grant.expires_at <= now()
     OR v_grant.grant_revision IS DISTINCT FROM
        (p_action ->> 'grant_revision')::bigint THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  -- The grant's tool whitelist is a closed set of the four workspace/artifact kinds;
  -- model actions reference a grant for its classification, not for a tool permission.
  IF v_action_kind IN ('workspace.list', 'workspace.read', 'workspace.search',
                       'artifact.write')
     AND NOT (v_action_kind = ANY(v_grant.allowed_tools)) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  -- Card U = jia: the device reports the rule index it matched, the server lands the
  -- value. The grant's classification is already server-derived (0040), so it is the
  -- authority here; a device claim that is LESS strict is refused, never accepted.
  v_classification := v_grant.classification;
  IF work.classification_rank(p_action ->> 'classification')
     < work.classification_rank(v_classification) THEN
    RAISE EXCEPTION 'classification_floor_required' USING ERRCODE = 'P0001';
  END IF;

  -- 3. (A) the destination gate. Input set = grants referenced by content-taking
  -- actions of this Run (workspace.read / workspace.search / artifact.write output
  -- roots), including succession. workspace.list is excluded (J11). The refusal only
  -- fires for a model action whose destination is outside the device; with card E=B
  -- the only reachable destination is device_local, so this branch is unreachable in
  -- production today - it is implemented, not deleted and not relaxed.
  IF v_action_kind IN ('model.send_remote', 'model.send_device_local')
     AND v_destination <> 'device_local' THEN
    SELECT COALESCE(MAX(work.classification_rank(g.classification)), 0) INTO v_taint
    FROM work.local_action la
    JOIN work.operation o ON o.id = la.operation_id AND o.org_id = la.org_id
    JOIN work.workspace_grant g ON g.id = la.grant_id AND g.org_id = la.org_id
    WHERE la.org_id = p_org_id AND o.run_id = p_run_id
      AND la.action_kind IN ('workspace.read', 'workspace.search', 'artifact.write');
    IF v_taint >= work.classification_rank('local_only') THEN
      RAISE EXCEPTION 'destination_not_allowed_for_local_only' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 4. invariant 3, first enforcement point. The code is run_has_unreconciled_operation,
  -- NOT execution_unknown: the refused action has no Operation to reconcile.
  IF EXISTS (
    SELECT 1 FROM work.operation o
    WHERE o.org_id = p_org_id AND o.run_id = p_run_id
      AND o.state IN ('unknown', 'unresolved')
  ) THEN
    RAISE EXCEPTION 'run_has_unreconciled_operation' USING ERRCODE = 'P0001';
  END IF;

  -- 6. supersede validation, before any write. (Step 5's readonly branch is evaluated
  -- after it because a supersede that must be re-approved may not hit the grant.)
  v_reason := p_action ->> 'supersede_reason';
  IF v_is_supersede THEN
    IF v_reason NOT IN ('reauthorized', 'approval_expired', 'source_changed',
                        'resend_undelivered', 'workspace_rebound',
                        'tool_params_changed') THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_old FROM work.operation
      WHERE org_id = p_org_id
        AND id = (p_action ->> 'supersedes_operation_id')::uuid FOR UPDATE;
    IF NOT FOUND OR v_old.run_id <> p_run_id OR v_old.step_key IS DISTINCT FROM v_step_key
       OR v_old.supersede_no + 1 <> v_supersede_no THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    -- One old Operation may be superseded at most once.
    IF EXISTS (SELECT 1 FROM work.operation o
               WHERE o.org_id = p_org_id
                 AND o.supersedes_operation_id = v_old.id) THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_old_action FROM work.local_action
      WHERE org_id = p_org_id AND operation_id = v_old.id
      ORDER BY created_at LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    -- The invariants that make a supersede the same action rather than a new one.
    IF v_old_action.action_kind IS DISTINCT FROM v_action_kind
       OR v_old_action.tool_schema IS DISTINCT FROM (p_action ->> 'tool_schema')
       OR v_old_action.destination_id IS DISTINCT FROM v_destination
       OR work.classification_rank(v_classification)
          < work.classification_rank(v_old_action.classification)
       OR (p_action ->> 'byte_upper_bound')::bigint > v_old_action.byte_upper_bound
       OR (p_action ->> 'token_upper_bound')::bigint > v_old_action.token_upper_bound THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    v_assertion := p_action -> 'supersede_assertion';
    IF jsonb_typeof(v_assertion) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_assertion)) <> 14
       OR NOT v_assertion ?& ARRAY[
         'v', 'run_id', 'old_operation_id', 'new_operation_id', 'old_request_hash',
         'new_request_hash', 'reason', 'changed_fields', 'device_id', 'session_id',
         'auth_plane', 'auth_epoch', 'nonce', 'expires_at']
       OR (v_assertion ->> 'old_operation_id') IS DISTINCT FROM v_old.id::text
       OR (v_assertion ->> 'run_id') IS DISTINCT FROM p_run_id::text
       OR (v_assertion ->> 'old_request_hash') IS DISTINCT FROM v_old.request_hash
       OR (v_assertion ->> 'new_request_hash') IS DISTINCT FROM
          (p_action ->> 'request_hash')
       OR (v_assertion ->> 'reason') IS DISTINCT FROM v_reason
       OR (v_assertion ->> 'device_id') IS DISTINCT FROM p_device_id::text
       OR (v_assertion ->> 'session_id') IS DISTINCT FROM p_session_id::text THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_typeof(v_assertion -> 'changed_fields') <> 'array' THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    SELECT array_agg(x) INTO v_changed
      FROM jsonb_array_elements_text(v_assertion -> 'changed_fields') x;
    IF v_changed IS NULL
       OR NOT work.text_array_closed_unique(v_changed,
            ARRAY['grant', 'entry_ref', 'source_identity', 'params', 'none']) THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    -- reason <-> changed_fields pairs that are decidable from the closed set.
    IF (v_reason = 'workspace_rebound'
        AND NOT (v_changed @> ARRAY['grant', 'entry_ref']))
       OR (v_reason = 'tool_params_changed' AND NOT (v_changed @> ARRAY['params']))
       OR (v_reason = 'source_changed' AND NOT (v_changed @> ARRAY['source_identity']))
       OR (v_reason = 'resend_undelivered' AND NOT (v_changed @> ARRAY['none']))
       OR (v_reason = 'approval_expired' AND NOT (v_changed @> ARRAY['none']))
       OR (v_reason = 'reauthorized' AND NOT (v_changed @> ARRAY['grant'])) THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    -- The mutually inverse pair (twenty-first round): workspace_rebound requires a
    -- succession row the server itself wrote and the new action must reference its
    -- new grant; reauthorized requires that no such row exists and the scope is
    -- unchanged. entry_ref has no column on this side, so resource_selector_hash is
    -- the observable identity of the scope - a narrower test, never a wider one.
    SELECT EXISTS (
      SELECT 1 FROM work.workspace_grant_succession s
      WHERE s.org_id = p_org_id AND s.run_id = p_run_id
        AND s.old_grant_id = v_old_action.grant_id
        AND s.new_grant_id = (p_action ->> 'grant_id')::uuid
    ) INTO v_succession;
    IF v_reason = 'workspace_rebound' AND NOT v_succession THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    IF v_reason = 'reauthorized'
       AND (v_succession
            OR v_old_action.resource_selector_hash IS DISTINCT FROM
               (p_action ->> 'resource_selector_hash')) THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    -- J21's two buckets, counted separately and refused separately. Active overflow is
    -- supersede_limit_exceeded; passive overflow is supersede_not_allowed, because
    -- "the user did nothing wrong" must not be locked out under the active bucket's
    -- vocabulary (control §9, twenty-first round).
    IF v_reason IN ('workspace_rebound', 'tool_params_changed') THEN
      SELECT count(*) INTO v_bucket_count FROM work.operation o
        WHERE o.org_id = p_org_id AND o.run_id = p_run_id AND o.step_key = v_step_key
          AND o.supersede_reason IN ('workspace_rebound', 'tool_params_changed');
      IF v_bucket_count >= 5 THEN
        RAISE EXCEPTION 'supersede_limit_exceeded' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_reason IN ('approval_expired', 'source_changed') THEN
      SELECT count(*) INTO v_bucket_count FROM work.operation o
        WHERE o.org_id = p_org_id AND o.run_id = p_run_id AND o.step_key = v_step_key
          AND o.supersede_reason = v_reason;
      IF v_bucket_count >= 3 THEN
        RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_reason = 'resend_undelivered' THEN
      SELECT count(*) INTO v_bucket_count FROM work.operation o
        WHERE o.org_id = p_org_id AND o.run_id = p_run_id AND o.step_key = v_step_key
          AND o.supersede_reason = 'resend_undelivered';
      IF v_bucket_count >= 1 THEN
        RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
      END IF;
      -- The old action already succeeded and settled: keep its terminal state and its
      -- settlement, only mark the dispatch superseded.
      IF v_old.state <> 'succeeded' THEN
        RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    -- The old action's own state must permit a supersede. unknown is never superseded.
    IF v_reason <> 'resend_undelivered'
       AND v_old.state IN ('succeeded', 'failed', 'canceled', 'reconciled',
                           'unknown', 'unresolved') THEN
      RAISE EXCEPTION 'supersede_not_allowed' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 5. the readonly branch - the ONLY consumer of readonly_approval_grant (R11C-1).
  -- Coverage is hash equality: a hash cannot express a subtree, and the signed rule
  -- (list/search take relative_dir, read takes the entry's parent dir) is computed on
  -- the device into this hash. Equality is the narrow reading - it can only prompt
  -- more often, never approve a wider scope than the user signed.
  IF v_action_kind IN ('workspace.list', 'workspace.read', 'workspace.search')
     AND NOT (v_is_supersede AND v_reason IN ('reauthorized', 'resend_undelivered')) THEN
    SELECT * INTO v_readonly FROM work.readonly_approval_grant g
      WHERE g.org_id = p_org_id AND g.run_id = p_run_id AND g.device_id = p_device_id
        AND g.workspace_grant_id = v_grant.id
        AND g.grant_revision = v_grant.grant_revision
        AND g.status = 'active' AND g.expires_at > now()
        AND v_action_kind = ANY(g.tool_set)
        AND g.resource_selector_hash = (p_action ->> 'resource_selector_hash')
        AND g.policy_epoch = v_policy.effective_epoch
        AND g.access_epoch = v_run.admission_access_epoch
      ORDER BY g.created_at LIMIT 1;
    IF FOUND THEN
      v_auto := true;
    END IF;
  END IF;

  -- 7. the atomic write.
  v_operation_id := work.create_operation(p_run_id, p_org_id,
    p_action ->> 'logical_key',
    CASE WHEN v_action_kind LIKE 'workspace.%' THEN 'tool'
         WHEN v_action_kind = 'artifact.write' THEN 'artifact'
         ELSE 'model' END,
    p_action ->> 'request_hash');
  v_attempt_id := gen_random_uuid();

  UPDATE work.operation
    SET step_key = v_step_key, supersede_no = v_supersede_no,
        supersedes_operation_id = CASE WHEN v_is_supersede
          THEN (p_action ->> 'supersedes_operation_id')::uuid ELSE NULL END,
        supersede_reason = v_reason,
        supersede_assertion_hash = CASE WHEN v_is_supersede
          THEN work.sha256_text(v_assertion::text) ELSE NULL END,
        dispatch_attempt_id = v_attempt_id,
        revision = revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = v_operation_id;

  INSERT INTO work.local_action
    (org_id, operation_id, attempt_id, action_kind, grant_id, grant_revision,
     resource_selector_hash, classification, local_payload_ref, request_hash,
     tool_schema, destination_id, byte_upper_bound, token_upper_bound)
  VALUES
    (p_org_id, v_operation_id, v_attempt_id, v_action_kind, v_grant.id,
     v_grant.grant_revision, p_action ->> 'resource_selector_hash', v_classification,
     p_action ->> 'local_payload_ref', p_action ->> 'request_hash',
     p_action ->> 'tool_schema', v_destination,
     (p_action ->> 'byte_upper_bound')::bigint,
     (p_action ->> 'token_upper_bound')::bigint);

  IF v_is_supersede THEN
    -- Conditional termination, exactly as control §4.2 prescribes: cancel_operation
    -- silently returns for terminal and unknown/unresolved rows, and turns a
    -- dispatching row into unknown rather than pretending it did not happen.
    IF v_reason <> 'resend_undelivered' THEN
      PERFORM work.cancel_operation(p_org_id, v_old.id, NULL, 'superseded');
      UPDATE work.approval a
        SET status = 'expired', revision = a.revision + 1, updated_at = now()
        FROM work.approval_operation ao
        WHERE ao.approval_id = a.id AND ao.org_id = a.org_id
          AND ao.operation_id = v_old.id AND a.org_id = p_org_id
          AND a.status = 'pending';
      -- release_quota, not a bare UPDATE: the account's reserved_tokens has to come
      -- back down and the ledger needs its release entry. Only held rows are released
      -- (release_quota refuses anything else, which is why the filter is here).
      FOR v_reservation_id IN
        SELECT q.id FROM work.quota_reservation q
        WHERE q.org_id = p_org_id AND q.operation_id = v_old.id AND q.state = 'held'
      LOOP
        PERFORM work.release_quota(v_reservation_id);
      END LOOP;
    END IF;
    UPDATE work.device_dispatch d
      SET delivery_state = 'superseded', updated_at = now()
      WHERE d.org_id = p_org_id AND d.operation_id = v_old.id
        AND d.delivery_state <> 'superseded';
  END IF;

  IF v_auto THEN
    PERFORM work.authorize_operation(p_org_id, v_operation_id,
      v_policy.effective_epoch, 'policy_auto');
    UPDATE work.readonly_approval_grant
      SET consumed_count = consumed_count + 1, revision = revision + 1,
          updated_at = now()
      WHERE org_id = p_org_id AND id = v_readonly.id;
    PERFORM work.append_audit(p_org_id, NULL, 'operation.auto_approved',
      'operation', v_operation_id::text,
      jsonb_build_object('readonly_grant_id', v_readonly.id,
        'workspace_grant_id', v_grant.id, 'grant_revision', v_grant.grant_revision,
        'action_kind', v_action_kind));
    v_approval_id := NULL;
  ELSE
    -- ask_each is the default: every action that did not hit the readonly grant gets
    -- its own Approval. reauthorized and resend_undelivered land here by construction
    -- because the readonly branch above excludes them, which is control §4.2's
    -- "resend_undelivered强制人工审批" and "reauthorized…每次必须重新逐次审批".
    v_approval_id := work.request_approval(p_org_id, v_operation_id,
      p_action ->> 'request_hash',
      jsonb_build_object('action_kind', v_action_kind, 'grant_id', v_grant.id,
        'grant_revision', v_grant.grant_revision,
        'resource_selector_hash', p_action ->> 'resource_selector_hash',
        'classification', v_classification, 'destination_id', v_destination),
      CASE WHEN v_action_kind IN ('model.send_remote', 'model.send_device_local')
           THEN 'high'
           WHEN v_action_kind = 'artifact.write' THEN 'medium' ELSE 'low' END,
      LEAST(v_grant.expires_at, v_lease.expires_at), v_policy.effective_epoch);
    IF v_run.state = 'active' THEN
      UPDATE work.run
        SET state = 'waiting', wait_reason = 'approval',
            control_revision = control_revision + 1, updated_at = now()
        WHERE org_id = p_org_id AND id = p_run_id;
      PERFORM work.append_task_event(p_org_id, v_task.id, 'run.waiting',
        jsonb_build_object('run_id', p_run_id, 'reason', 'approval'));
    END IF;
  END IF;

  PERFORM work.append_audit(p_org_id, NULL, 'operation.prepare_local',
    'operation', v_operation_id::text,
    jsonb_build_object('run_id', p_run_id, 'device_id', p_device_id,
      'action_kind', v_action_kind, 'classification', v_classification,
      'attempt_id', v_attempt_id, 'supersede_reason', v_reason,
      'auto_approved', v_auto));

  SELECT state, revision INTO v_final_state, v_final_revision
    FROM work.operation WHERE org_id = p_org_id AND id = v_operation_id;
  v_response := jsonb_build_object(
    'operation_id', v_operation_id, 'logical_key', p_action ->> 'logical_key',
    'step_key', v_step_key, 'supersede_no', v_supersede_no,
    'state', v_final_state, 'revision', v_final_revision,
    'approval_id', v_approval_id, 'auto_approved', v_auto,
    'request_hash', p_action ->> 'request_hash', 'attempt_id', v_attempt_id,
    'checkpoint_seq', p_checkpoint_seq, 'classification', v_classification,
    'destination_id', v_destination);
  RETURN v_response || jsonb_build_object('replayed', false);
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
     OR v_lease.session_id <> p_session_id OR v_lease.purpose <> 'execute'
     OR v_lease.state <> 'active'
     OR v_lease.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM work.audit_event a
      WHERE a.org_id = p_org_id AND a.action = 'device_lease.acquired'
        AND a.metadata ->> 'lease_id' = p_lease_id::text) THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
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

ALTER FUNCTION work.activate_device_run_binding(text, uuid, bigint, int) OWNER TO work_owner;
ALTER FUNCTION work.create_device_run_binding(text, uuid, uuid, uuid, bigint, text, jsonb) OWNER TO work_owner;
ALTER FUNCTION work.list_pending_device_offers(text, uuid, uuid) OWNER TO work_owner;
ALTER FUNCTION work.acknowledge_run_ready(text, uuid, bigint, text, jsonb, uuid, uuid) OWNER TO work_owner;
ALTER FUNCTION work.acquire_device_lease(text, uuid, uuid, uuid, bigint, text, uuid, int) OWNER TO work_owner;
ALTER FUNCTION work.prepare_local_operation(text, uuid, uuid, uuid, uuid, bigint, bigint, jsonb) OWNER TO work_owner;
ALTER FUNCTION work.consume_device_permit(text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) OWNER TO work_owner;
ALTER FUNCTION work.rebind_run_workspace(text, text, text, bigint, uuid, text, uuid, uuid, jsonb) OWNER TO work_owner;

REVOKE ALL ON FUNCTION work.activate_device_run_binding(text, uuid, bigint, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.create_device_run_binding(text, uuid, uuid, uuid, bigint, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.list_pending_device_offers(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.acknowledge_run_ready(text, uuid, bigint, text, jsonb, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.acquire_device_lease(text, uuid, uuid, uuid, bigint, text, uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.prepare_local_operation(text, uuid, uuid, uuid, uuid, bigint, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.consume_device_permit(text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.rebind_run_workspace(text, text, text, bigint, uuid, text, uuid, uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION work.create_device_run_binding(text, uuid, uuid, uuid, bigint, text, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.list_pending_device_offers(text, uuid, uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.acknowledge_run_ready(text, uuid, bigint, text, jsonb, uuid, uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.acquire_device_lease(text, uuid, uuid, uuid, bigint, text, uuid, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.prepare_local_operation(text, uuid, uuid, uuid, uuid, bigint, bigint, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.consume_device_permit(text, uuid, uuid, uuid, uuid, uuid, bigint, text, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.rebind_run_workspace(text, text, text, bigint, uuid, text, uuid, uuid, jsonb) TO work_api;

RESET ROLE;
