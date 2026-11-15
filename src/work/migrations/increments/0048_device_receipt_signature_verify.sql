-- 0048: device receipt real-signature reconciliation (M3 gateway GW4, P0 #1).
--
-- The device agent (src/device frame/receipt.rs) signs the receipt body with a real
-- ES256 signature: fixed 64-byte R||S, base64url without padding (86 characters),
-- over JCS({schema_version:2, type:"receipt", body}) with body.signature stripped
-- (device-design §3.1 receipt row). Until now record_device_receipt only shape-checked
-- a `sha256:<64hex>` PLACEHOLDER (0042:1606) because plpgsql cannot verify ES256
-- (pgcrypto has no ECDSA verify); the cryptographic check is the Go gateway's job
-- (0040:1135, 0021 precedent, 0046 pairing precedent). The gateway verifies the
-- receipt frame signature against the in-DB device key (0047 device_signing_key)
-- BEFORE calling this command, then translates the wire body into the 11-key element
-- this command consumes. This increment reconciles the SQL shape with the real
-- signature so a genuine device receipt is no longer rejected as invalid_request.
--
-- One change, keeping the shipped judgment order intact:
--   * record_device_receipt: CREATE OR REPLACE restating every 0042 check verbatim,
--     changing ONLY the signature shape from the placeholder `^sha256:[0-9a-f]{64}$`
--     to the real ES256 form `^[A-Za-z0-9_-]{86}$`. The command still hashes the
--     signature into signed_payload_hash for idempotency, binds original_execution
--     to the device/session/operation/attempt/fence, advances the two watermarks and
--     issues the operation_resolution for a current-fence completed receipt; it does
--     NOT verify the cryptography (the gateway does, before calling). CREATE OR
--     REPLACE preserves privileges but inherits neither SECURITY DEFINER nor
--     search_path, so both are restated in the body (0041:17-19 house rule). The
--     work_worker EXECUTE grant from 0042 is preserved by CREATE OR REPLACE (0046
--     precedent for a restated command).
--
-- No new public error code is registered: the restated command keeps invalid_request
-- / unauthorized / device_revoked / idempotency_key_conflict and the conflict codes
-- receipt_seq_out_of_window / receipt_signature_invalid, all already mapped from 0042.
-- No table privilege is granted.

SET ROLE work_owner;

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
    -- A revoked device's late receipts are no longer accepted (B03 carrier §3.3);
    -- the Run is closed one-sidedly from the server's own gate facts.
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
    -- The outer session only carries transport; the identity that matters is the one
    -- signed into original_execution, and it must be a session of this device.
    SELECT * INTO v_session FROM work.device_session
      WHERE org_id = p_org_id AND id = (v_exec ->> 'session_id')::uuid;
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
        -- That verdict belongs to an Operation that was never dispatched; from
        -- dispatching there is no registered edge to it, so it cannot be written here.
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

  -- The two watermarks the design names. They only ever advance.
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

RESET ROLE;