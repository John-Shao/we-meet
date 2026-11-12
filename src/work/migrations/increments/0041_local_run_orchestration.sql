-- 0041: the local Run's orchestration spine - checkpoint reporting, lease acquisition
--       and renewal, and the binding offer/ready handshake.
--
-- Authority: work-r0b-m1a-device-migration-design-2026-11-12.md §14 (card I = I1,
-- O-12 = jia "supplement each batch's shapes before landing it", card T moved
-- execution_lease and device_run_binding into batch one). Control design §4.2
-- (acquire_device_lease / renew_device_lease / record_device_checkpoint /
-- create_device_run_binding / acknowledge_run_ready), §6.4, device design §3.2 / §3.4.
--
-- One table only: device_checkpoint. The other two C-group tables already landed in
-- 0040 because three batch-one commands write them.
--
-- This increment also discharges the obligation 0040 recorded: rebind_run_workspace
-- created resume offers with a NULL expected_checkpoint because no checkpoint table
-- existed. It is restated here to point at the Run's latest recorded checkpoint, and
-- acquire_device_lease refuses to start a resume offer that has a baseline available
-- but does not reference it. The restatement keeps every batch-one check and adds the
-- two column values; per #87 it restates SECURITY DEFINER and search_path in the same
-- statement, because CREATE OR REPLACE inherits neither.
--
-- Signature verification stays in the Go/gateway layer, exactly as 0021 and 0040 do:
-- plpgsql cannot verify ES256, so these bodies format-check, bind and CAS.
SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- device_checkpoint
-- ---------------------------------------------------------------------------
CREATE TABLE work.device_checkpoint (
  org_id text NOT NULL,
  run_id uuid NOT NULL,
  checkpoint_seq bigint NOT NULL,
  binding_revision bigint NOT NULL,
  fence bigint NOT NULL,
  checkpoint_hash text NOT NULL,
  local_ref text NOT NULL,
  receipt_through_seq bigint NOT NULL DEFAULT 0,
  pending_operation_set_hash text NOT NULL,
  signed_payload_hash text,
  state text NOT NULL DEFAULT 'recorded',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, run_id, checkpoint_seq),
  CONSTRAINT device_checkpoint_seq_nonneg CHECK (checkpoint_seq >= 0),
  CONSTRAINT device_checkpoint_binding_positive CHECK (binding_revision >= 1),
  -- fence is historical only. run.fence goes 1 -> 2 at the first queued -> active, so
  -- filtering recovery baselines by fence would drop the seq=0 row written earlier.
  CONSTRAINT device_checkpoint_fence_positive CHECK (fence >= 1),
  CONSTRAINT device_checkpoint_hash_shape CHECK (checkpoint_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_checkpoint_local_ref_shape CHECK (local_ref <> ''),
  CONSTRAINT device_checkpoint_receipt_seq_nonneg CHECK (receipt_through_seq >= 0),
  CONSTRAINT device_checkpoint_pending_shape
    CHECK (pending_operation_set_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_checkpoint_signature_shape
    CHECK (signed_payload_hash IS NULL OR signed_payload_hash ~ '^[0-9a-f]{64}$'),
  -- seq=0 is the server-written input baseline and carries no device signature;
  -- every later checkpoint is device-signed.
  CONSTRAINT device_checkpoint_baseline_shape
    CHECK ((checkpoint_seq = 0) = (signed_payload_hash IS NULL)),
  CONSTRAINT device_checkpoint_state_check CHECK (state IN ('recorded', 'conflict')),
  CONSTRAINT device_checkpoint_run_fkey
    FOREIGN KEY (run_id, org_id) REFERENCES work.run(id, org_id),
  CONSTRAINT device_checkpoint_org_fkey FOREIGN KEY (org_id) REFERENCES work.org(id)
);

ALTER TABLE work.device_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.device_checkpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.device_checkpoint
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE FUNCTION work.device_checkpoint_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.checkpoint_seq IS DISTINCT FROM OLD.checkpoint_seq
     OR NEW.binding_revision IS DISTINCT FROM OLD.binding_revision
     OR NEW.fence IS DISTINCT FROM OLD.fence
     OR NEW.checkpoint_hash IS DISTINCT FROM OLD.checkpoint_hash
     OR NEW.local_ref IS DISTINCT FROM OLD.local_ref
     OR NEW.receipt_through_seq IS DISTINCT FROM OLD.receipt_through_seq
     OR NEW.pending_operation_set_hash IS DISTINCT FROM OLD.pending_operation_set_hash
     OR NEW.signed_payload_hash IS DISTINCT FROM OLD.signed_payload_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'device_checkpoint_content_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_checkpoint_guard BEFORE UPDATE ON work.device_checkpoint
  FOR EACH ROW EXECUTE FUNCTION work.device_checkpoint_guard();
CREATE TRIGGER device_checkpoint_no_delete BEFORE DELETE ON work.device_checkpoint
  FOR EACH ROW EXECUTE FUNCTION work.prevent_mutation();
CREATE TRIGGER device_checkpoint_transition BEFORE UPDATE OF state ON work.device_checkpoint
  FOR EACH ROW EXECUTE FUNCTION work.enforce_state_transition('device_checkpoint');

INSERT INTO work.state_transition (entity, from_state, to_state) VALUES
  ('device_checkpoint', 'recorded', 'conflict')
ON CONFLICT DO NOTHING;

-- Recovery baselines are selected by Run, newest recorded first, never by fence.
CREATE INDEX work_device_checkpoint_run_recorded
  ON work.device_checkpoint(org_id, run_id, checkpoint_seq DESC)
  WHERE state = 'recorded';

-- ---------------------------------------------------------------------------
-- create_device_run_binding
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.create_device_run_binding(
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

  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.state NOT IN ('queued', 'waiting') THEN
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

  -- §4.2: this command does NOT write device_checkpoint. The seq=0 baseline has
  -- exactly one writer (acquire_device_lease), so two sources cannot disagree about
  -- the baseline hash.
  INSERT INTO work.device_run_binding
    (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
     input_hash, snapshot_descriptor_ref, snapshot_hash, profile_id, profile_revision,
     runtime_digest, tool_manifest_hash, model_version, grant_set, start_nonce,
     offer_expiry, state)
  VALUES
    (p_org_id, p_run_id, p_binding_revision, v_run.task_id, p_device_id, p_session_id,
     p_offer ->> 'input_ref', p_offer ->> 'input_hash',
     p_offer ->> 'snapshot_descriptor_ref', p_offer ->> 'snapshot_hash',
     p_offer ->> 'profile_id',
     COALESCE(NULLIF(p_offer ->> 'profile_revision', '')::bigint, 0),
     p_offer ->> 'runtime_digest', p_offer ->> 'tool_manifest_hash',
     p_offer ->> 'model_version', p_offer -> 'grant_set', v_nonce, v_expiry, 'offered');

  v_response := jsonb_build_object('run_id', p_run_id, 'binding_revision', p_binding_revision,
    'task_id', v_run.task_id, 'device_id', p_device_id, 'start_nonce', v_nonce,
    'offer_expiry', v_expiry, 'state', 'offered',
    'expected_checkpoint_seq', null, 'expected_checkpoint_hash', null);
  PERFORM work.append_audit(p_org_id, NULL, 'device_run_binding.create',
    'run', p_run_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- acknowledge_run_ready
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.acknowledge_run_ready(
  p_org_id text,
  p_run_id uuid,
  p_binding_revision bigint,
  p_client_request_id text,
  p_ready jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_binding work.device_run_binding%ROWTYPE;
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
     OR (p_ready ->> 'device_signature') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id AND binding_revision = p_binding_revision
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Only a ready answer moves the binding. The other three leave it offered: the
  -- workflow must not AcquireRun, and the reason is the user-visible next step.
  IF v_reason = 'ready' AND v_binding.state = 'offered' THEN
    UPDATE work.device_run_binding
      SET state = 'ready', updated_at = now(), revision = revision + 1
      WHERE org_id = p_org_id AND run_id = p_run_id
        AND binding_revision = p_binding_revision AND state = 'offered';
  END IF;

  v_response := jsonb_build_object('run_id', p_run_id,
    'binding_revision', p_binding_revision, 'ready_or_reason', v_reason,
    'state', CASE WHEN v_reason = 'ready' THEN 'ready' ELSE v_binding.state END);
  PERFORM work.append_audit(p_org_id, NULL, 'device_run_binding.ready',
    'run', p_run_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- acquire_device_lease
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.acquire_device_lease(
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

  -- Replay: the same start_nonce already bought a lease, or a reconcile_finish lease
  -- is already active for this Run. Neither mints a second row.
  IF p_purpose = 'execute' THEN
    SELECT * INTO v_lease FROM work.execution_lease
      WHERE org_id = p_org_id AND run_id = p_run_id AND start_nonce = p_start_nonce;
  ELSE
    SELECT * INTO v_lease FROM work.execution_lease
      WHERE org_id = p_org_id AND run_id = p_run_id AND purpose = 'reconcile_finish'
        AND state = 'active';
  END IF;
  IF FOUND THEN
    RETURN jsonb_build_object('lease_id', v_lease.id, 'run_id', v_lease.run_id,
      'fence', v_lease.fence, 'generation', v_lease.generation,
      'purpose', v_lease.purpose, 'expires_at', v_lease.expires_at,
      'ttl_ms', p_ttl_seconds * 1000, 'start_nonce', v_lease.start_nonce,
      'run_start', null, 'checkpoint_seq', null, 'checkpoint_hash', null,
      'replayed', true);
  END IF;

  SELECT * INTO v_org FROM work.org WHERE id = p_org_id FOR SHARE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- The workflow calls resume_run first; this command never moves the Run itself.
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

  -- J12: a reconcile_finish lease buys no new execution capability. It is allowed even
  -- with unreconciled unknowns, and it signs no run_start and writes no baseline.
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
    -- Fail-closed: a resume offer that has a baseline available but does not reference
    -- it must not start from the initial input (device §3.2).
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

    -- The seq=0 baseline has exactly one writer and is written only if absent, so a
    -- resume never rewrites it into a same-seq-different-hash conflict.
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

  PERFORM work.append_audit(p_org_id, NULL, 'device_lease.acquired',
    'run', p_run_id::text,
    jsonb_build_object('lease_id', v_id, 'purpose', p_purpose, 'fence', v_run.fence,
      'start_nonce', p_start_nonce));

  RETURN jsonb_build_object('lease_id', v_id, 'run_id', p_run_id, 'fence', v_run.fence,
    'generation', COALESCE(v_org.access_epoch, 0), 'purpose', p_purpose,
    'expires_at', v_expiry, 'ttl_ms', p_ttl_seconds * 1000,
    'start_nonce', CASE WHEN p_purpose = 'execute' THEN p_start_nonce ELSE NULL END,
    'run_start', CASE WHEN p_purpose = 'execute' THEN jsonb_build_object(
      'run_binding_id', p_binding_revision, 'run_id', p_run_id, 'lease_id', v_id,
      'fence', v_run.fence, 'start_nonce', p_start_nonce, 'expiry', v_expiry,
      'runtime_digest', v_binding.runtime_digest,
      'payload_hash', work.sha256_text('run_start|' || p_run_id::text || '|'
        || p_binding_revision::text || '|' || v_id::text || '|' || p_start_nonce::text))
      ELSE NULL END,
    'checkpoint_seq', CASE WHEN p_purpose = 'execute' THEN 0 ELSE NULL END,
    'checkpoint_hash', CASE WHEN p_purpose = 'execute' THEN v_binding.input_hash ELSE NULL END,
    'replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- renew_device_lease
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.renew_device_lease(
  p_org_id text,
  p_lease_id uuid,
  p_ttl_seconds int,
  p_last_receipt_seq bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_lease work.execution_lease%ROWTYPE;
  v_expiry timestamptz;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 30
     OR p_last_receipt_seq IS NULL OR p_last_receipt_seq < 0 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_lease FROM work.execution_lease
    WHERE org_id = p_org_id AND id = p_lease_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  -- An expired lease is never revived: the whitelist has no expired -> active edge.
  -- The device asks for a new reconcile_finish lease instead, which is the J12 path.
  IF v_lease.state <> 'active' OR v_lease.expires_at <= now() THEN
    RAISE EXCEPTION 'resync_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_last_receipt_seq < v_lease.last_receipt_seq THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_expiry := now() + make_interval(secs => p_ttl_seconds);
  UPDATE work.execution_lease
    SET expires_at = v_expiry, last_receipt_seq = p_last_receipt_seq,
        updated_at = now(), revision = revision + 1
    WHERE org_id = p_org_id AND id = p_lease_id AND state = 'active';

  RETURN jsonb_build_object('lease_id', p_lease_id, 'run_id', v_lease.run_id,
    'fence', v_lease.fence, 'purpose', v_lease.purpose, 'expires_at', v_expiry,
    'ttl_ms', p_ttl_seconds * 1000, 'last_receipt_seq', p_last_receipt_seq);
END;
$$;

-- ---------------------------------------------------------------------------
-- record_device_checkpoint
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.record_device_checkpoint(
  p_org_id text,
  p_run_id uuid,
  p_binding_revision bigint,
  p_fence bigint,
  p_client_request_id text,
  p_checkpoint jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_run work.run%ROWTYPE;
  v_existing work.device_checkpoint%ROWTYPE;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_seq bigint;
  v_max bigint;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  v_request_hash := work.sha256_text('device_checkpoint.record|' || p_run_id::text
    || '|' || COALESCE(p_checkpoint::text, ''));
  SELECT metadata INTO v_receipt FROM work.audit_event
    WHERE org_id = p_org_id AND action = 'device_checkpoint.record'
      AND metadata ->> 'request_id' = p_client_request_id;
  IF FOUND THEN
    IF v_receipt ->> 'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'idempotency_key_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN (v_receipt -> 'response') || jsonb_build_object('replayed', true);
  END IF;

  IF p_checkpoint IS NULL OR jsonb_typeof(p_checkpoint) <> 'object'
     OR p_client_request_id IS NULL OR p_client_request_id = ''
     OR (p_checkpoint ->> 'checkpoint_seq') IS NULL
     OR (p_checkpoint ->> 'checkpoint_hash') IS NULL
     OR (p_checkpoint ->> 'checkpoint_hash') !~ '^[0-9a-f]{64}$'
     OR (p_checkpoint ->> 'local_checkpoint_ref') IS NULL
     OR (p_checkpoint ->> 'local_checkpoint_ref') = ''
     OR (p_checkpoint ->> 'pending_operation_set_hash') IS NULL
     OR (p_checkpoint ->> 'pending_operation_set_hash') !~ '^[0-9a-f]{64}$'
     OR (p_checkpoint ->> 'device_signature') IS NULL
     OR (p_checkpoint ->> 'device_signature') !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_seq := (p_checkpoint ->> 'checkpoint_seq')::bigint;
  -- seq=0 belongs to acquire_device_lease alone; a device may not rewrite the baseline.
  IF v_seq < 1 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing FROM work.device_checkpoint
    WHERE org_id = p_org_id AND run_id = p_run_id AND checkpoint_seq = v_seq
    FOR UPDATE;
  IF FOUND THEN
    IF v_existing.checkpoint_hash IS DISTINCT FROM (p_checkpoint ->> 'checkpoint_hash') THEN
      -- Same seq, different hash: the Run cannot continue on an ambiguous baseline.
      UPDATE work.device_checkpoint
        SET state = 'conflict', updated_at = now()
        WHERE org_id = p_org_id AND run_id = p_run_id AND checkpoint_seq = v_seq
          AND state = 'recorded';
      UPDATE work.run
        SET state = 'waiting', wait_reason = 'reconcile',
            control_revision = control_revision + 1, updated_at = now()
        WHERE org_id = p_org_id AND id = p_run_id AND state = 'active';
      v_response := jsonb_build_object('run_id', p_run_id, 'checkpoint_seq', v_seq,
        'state', 'conflict');
      PERFORM work.append_audit(p_org_id, NULL, 'device_checkpoint.record',
        'run', p_run_id::text,
        jsonb_build_object('request_id', p_client_request_id,
          'request_hash', v_request_hash, 'response', v_response));
      RETURN v_response || jsonb_build_object('replayed', false);
    END IF;
    v_response := jsonb_build_object('run_id', p_run_id, 'checkpoint_seq', v_seq,
      'state', v_existing.state);
    PERFORM work.append_audit(p_org_id, NULL, 'device_checkpoint.record',
      'run', p_run_id::text,
      jsonb_build_object('request_id', p_client_request_id,
        'request_hash', v_request_hash, 'response', v_response));
    RETURN v_response || jsonb_build_object('replayed', true);
  END IF;

  SELECT COALESCE(MAX(checkpoint_seq), 0) INTO v_max FROM work.device_checkpoint
    WHERE org_id = p_org_id AND run_id = p_run_id;
  IF v_seq <= v_max THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  INSERT INTO work.device_checkpoint
    (org_id, run_id, checkpoint_seq, binding_revision, fence, checkpoint_hash, local_ref,
     receipt_through_seq, pending_operation_set_hash, signed_payload_hash)
  VALUES
    (p_org_id, p_run_id, v_seq, p_binding_revision, p_fence,
     p_checkpoint ->> 'checkpoint_hash', p_checkpoint ->> 'local_checkpoint_ref',
     COALESCE(NULLIF(p_checkpoint ->> 'receipt_through_seq', '')::bigint, 0),
     p_checkpoint ->> 'pending_operation_set_hash',
     work.sha256_text(p_checkpoint ->> 'device_signature'));

  v_response := jsonb_build_object('run_id', p_run_id, 'checkpoint_seq', v_seq,
    'state', 'recorded');
  PERFORM work.append_audit(p_org_id, NULL, 'device_checkpoint.record',
    'run', p_run_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- rebind_run_workspace, restated.
--
-- 0040 created resume offers with a NULL expected_checkpoint because device_checkpoint
-- did not exist yet; that obligation was recorded in the increment and in the design
-- doc §13.3. This restatement fills both columns from the Run's latest RECORDED
-- checkpoint, selected by Run and never filtered by fence (run.fence already went 1->2
-- at the first queued->active, so a fence filter would drop the seq=0 baseline).
-- Every batch-one check and write is kept; only the two column values are added.
-- #87: CREATE OR REPLACE inherits neither SECURITY DEFINER nor search_path, so both
-- are restated in this same statement.
-- ---------------------------------------------------------------------------
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

  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM work.task
    WHERE org_id = p_org_id AND id = v_run.task_id FOR UPDATE;
  IF v_task.owner_subject_id IS DISTINCT FROM p_actor_subject_id
     OR v_task.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.state <> 'waiting' OR v_run.wait_reason IS DISTINCT FROM 'input' THEN
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

  UPDATE work.run
    SET control_revision = control_revision + 1, updated_at = now()
    WHERE org_id = p_org_id AND id = p_run_id;

  v_response := jsonb_build_object('run_id', p_run_id, 'old_grant_id', p_old_grant_id,
    'new_grant_id', p_new_grant_id, 'binding_revision', v_revision,
    'expected_checkpoint_seq', v_cp_seq, 'expected_checkpoint_hash', v_cp_hash,
    'offer_expiry', now() + interval '120 seconds', 'state', 'offered',
    'invalidated_readonly_grants', v_invalidated);
  PERFORM work.append_audit(p_org_id, p_actor_subject_id, 'run.workspace_rebind',
    'run', p_run_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'nonce', p_proof ->> 'nonce', 'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges. All five orchestration commands are the worker/gateway face; the
-- restated rebind keeps its work_api grant. No table privilege is granted.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION work.device_checkpoint_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION work.create_device_run_binding(
  text, uuid, uuid, uuid, bigint, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.acknowledge_run_ready(
  text, uuid, bigint, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.acquire_device_lease(
  text, uuid, uuid, uuid, bigint, text, uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.renew_device_lease(text, uuid, int, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.record_device_checkpoint(
  text, uuid, bigint, bigint, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.rebind_run_workspace(
  text, text, text, bigint, uuid, text, uuid, uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION work.create_device_run_binding(
  text, uuid, uuid, uuid, bigint, text, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.acknowledge_run_ready(
  text, uuid, bigint, text, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.acquire_device_lease(
  text, uuid, uuid, uuid, bigint, text, uuid, int) TO work_worker;
GRANT EXECUTE ON FUNCTION work.renew_device_lease(text, uuid, int, bigint) TO work_worker;
GRANT EXECUTE ON FUNCTION work.record_device_checkpoint(
  text, uuid, bigint, bigint, text, jsonb) TO work_worker;
GRANT EXECUTE ON FUNCTION work.rebind_run_workspace(
  text, text, text, bigint, uuid, text, uuid, uuid, jsonb) TO work_api;

REVOKE ALL ON TABLE work.device_checkpoint FROM PUBLIC;
REVOKE ALL ON TABLE work.device_checkpoint FROM work_api, work_worker,
  work_directory, work_ledger, work_ops, work_governance_events;

RESET ROLE;