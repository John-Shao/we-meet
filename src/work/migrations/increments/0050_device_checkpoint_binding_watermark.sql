-- 0050: bind checkpoint recording to the calling device and return the receipt watermark
-- (M3 gateway GW9).
--
-- Authority: device-design §3.1 checkpoint_commit/checkpoint_ack row and §3.4 ("控制面只
-- 记录 hash、不透明 ref、receipt 水位和未决 Operation 集合 hash"), B03 carrier §3.2
-- ("receipt 增量清理 ← checkpoint_commit 的 recorded ack 所携带的 receipt 水位…该 ack 只在
-- 控制面事务提交后签发"), control-design §4.1 device_checkpoint row. The device agent
-- already builds and signs checkpoint_commit (src/device frame/checkpoint.rs) and already
-- consumes a server-signed recorded ack's watermark (reconcile/watermark.rs), but the
-- gateway had no checkpoint handler and this command had two gaps that made the chain
-- unusable:
--
--   1. NO DEVICE OWNERSHIP. 0041 took only org/run/binding_revision/fence: any
--      authenticated device could write a baseline into another device's Run, and the
--      guard (0041:71) only enforces immutability. work_worker has no SELECT on
--      device_run_binding / device_session / device (0024 house rule, 0040:2418), so the
--      gateway cannot check ownership itself — the check must live in this definer
--      command. The wire body carries no identity (§3.1), so the gateway passes the
--      certificate-mapped device and the hello-established session as two new arguments.
--      The device/session gates mirror consume_device_permit (0042:1345-1360) and the
--      run-level binding gate mirrors claim_pending_device_resolutions (0049:75-83):
--      the current binding for a Run is its highest binding_revision (resume mints a
--      higher one), and the committed binding_revision must be that current one, so a
--      superseded binding cannot keep writing baselines. fence stays a historical record
--      and is deliberately NOT validated (§4.1: recovery baselines are selected by Run).
--
--   2. NO WATERMARK IN THE RESPONSE. 0041 returned {run_id, checkpoint_seq, state,
--      replayed} while B03 §3.2 requires the recorded ack to carry the receipt watermark
--      the device may release up to. The command already STORES receipt_through_seq; it
--      now also RETURNS it: the recorded value on a fresh insert, the stored row's value
--      on an idempotent replay, and 0 on conflict (a conflict ack carries no usable
--      watermark, watermark.rs releases nothing). This is an upper bound, not a deletion
--      authority: the device releases only contiguous seqs it has already acked and that
--      are not unknown (journal/recover.rs cleanup_receipts_through), so an inflated
--      watermark cannot drop an un-acked receipt.
--
-- Signature shape reconciled with the real device signature, exactly as 0048 did for
-- record_device_receipt: `device_signature` was the internal `^sha256:[0-9a-f]{64}$`
-- placeholder because plpgsql cannot verify ES256 (pgcrypto has no ECDSA verify). The
-- gateway verifies the ES256 checkpoint_commit frame against the in-DB device key (0047)
-- BEFORE calling this command, then passes the wire signature (fixed 64-byte R||S,
-- base64url no padding, 86 characters) through; the command only shape-checks it and
-- hashes it into signed_payload_hash for idempotency (0040:1135, 0021/0046/0048 precedent).
--
-- Judgment order: the identity/run/binding gates now precede the idempotency lookup, so a
-- revoked device or a superseded binding cannot obtain a replayed response either. Every
-- other 0041 check is restated verbatim (request_hash formula, replay conflict, closed
-- shape, seq>=1, run lock, same-seq-different-hash conflict that parks the Run in
-- waiting/reconcile, monotonic seq, the immutable insert).
--
-- The argument list changes, so this is DROP + CREATE (not CREATE OR REPLACE, which would
-- leave a second overload alive). DROP removes privileges, so REVOKE/GRANT are restated
-- for the new signature; SECURITY DEFINER and the pinned search_path are in the CREATE
-- statement itself (#87 house rule). No new public error code: org_context_mismatch /
-- unauthorized / device_revoked / run_not_found / invalid_request / idempotency_key_conflict
-- are all already mapped from 0041/0042. No table privilege is granted.

SET ROLE work_owner;

DROP FUNCTION work.record_device_checkpoint(text, uuid, bigint, bigint, text, jsonb);

CREATE FUNCTION work.record_device_checkpoint(
  p_org_id text,
  p_run_id uuid,
  p_binding_revision bigint,
  p_fence bigint,
  p_client_request_id text,
  p_checkpoint jsonb,
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
  v_existing work.device_checkpoint%ROWTYPE;
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_seq bigint;
  v_max bigint;
  v_watermark bigint;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  -- GW9 gate 1: the calling device and its live session (0042:1345-1360 precedent).
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

  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- GW9 gate 2: the Run's current binding must point at this device, and the commit
  -- must name that binding_revision (0049:75-83 run-level targeting precedent).
  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id
    ORDER BY binding_revision DESC LIMIT 1;
  IF NOT FOUND OR v_binding.device_id <> p_device_id
     OR v_binding.binding_revision <> p_binding_revision THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

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
     OR (p_checkpoint ->> 'device_signature') !~ '^[A-Za-z0-9_-]{86}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_seq := (p_checkpoint ->> 'checkpoint_seq')::bigint;
  -- seq=0 belongs to acquire_device_lease alone; a device may not rewrite the baseline.
  IF v_seq < 1 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  v_watermark := COALESCE(NULLIF(p_checkpoint ->> 'receipt_through_seq', '')::bigint, 0);

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
      -- A conflict ack carries no usable watermark (B03 §3.2, watermark.rs).
      v_response := jsonb_build_object('run_id', p_run_id, 'checkpoint_seq', v_seq,
        'state', 'conflict', 'receipt_through_seq', 0);
      PERFORM work.append_audit(p_org_id, NULL, 'device_checkpoint.record',
        'run', p_run_id::text,
        jsonb_build_object('request_id', p_client_request_id,
          'request_hash', v_request_hash, 'response', v_response));
      RETURN v_response || jsonb_build_object('replayed', false);
    END IF;
    v_response := jsonb_build_object('run_id', p_run_id, 'checkpoint_seq', v_seq,
      'state', v_existing.state, 'receipt_through_seq', v_existing.receipt_through_seq);
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
     v_watermark,
     p_checkpoint ->> 'pending_operation_set_hash',
     work.sha256_text(p_checkpoint ->> 'device_signature'));

  v_response := jsonb_build_object('run_id', p_run_id, 'checkpoint_seq', v_seq,
    'state', 'recorded', 'receipt_through_seq', v_watermark);
  PERFORM work.append_audit(p_org_id, NULL, 'device_checkpoint.record',
    'run', p_run_id::text,
    jsonb_build_object('request_id', p_client_request_id, 'request_hash', v_request_hash,
      'response', v_response));
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION work.record_device_checkpoint(
  text, uuid, bigint, bigint, text, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.record_device_checkpoint(
  text, uuid, bigint, bigint, text, jsonb, uuid, uuid) TO work_worker;

RESET ROLE;