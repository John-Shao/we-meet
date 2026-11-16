-- 0052: read-only pending-offer getter for the gateway downlink, and bind the run_ready
-- answer to the calling device (M3 gateway GW11).
--
-- Authority: device-design §3.1 run_offer/run_ready row, §3.2 ("worker从该记录向原设备发送
-- 签名run_offer"; "绑定记录主键 (org_id,run_id,binding_revision)，start_nonce唯一"; "新session
-- 须重新授权目录…但该通道不可领取run_offer/start"), control-design §4.2 create_device_run_binding
-- / acknowledge_run_ready caller = "worker / gateway领域代理". The device agent already
-- validates an offer against local journal facts (src/device recovery/resume.rs: terminal-run
-- tombstone, strictly-higher binding_revision, expected_checkpoint must equal the latest
-- signed-reported checkpoint, prior receipts complete) and persists start_nonce single-use
-- (journal runtime_start, sidecar/lifecycle.rs), but the gateway had no way to learn which
-- offers a device is owed, and acknowledge_run_ready had the same ownership gap GW9/GW10 fixed.
--
-- Two changes:
--
--   1. NEW read-only getter work.list_pending_device_offers. Ruling (主签 2026-11-16 单选)＝
--      只读重推: it changes NO state, so offered->ready stays acknowledge_run_ready's unique
--      transition and the binding closed set needs no delivered/delivering member (adding one
--      would mean restating device_run_binding_guard plus the transition whitelist). Ruling＝
--      expired offers are SKIPPED: only state='offered' AND offer_expiry > now() rows are
--      returned, so the device never receives a dead offer; re-offering needs a higher
--      binding_revision. Targeting is by device_id AND session_id: unlike a resolution
--      (0049 targets by device so a conclusion survives a reconnect), an offer is
--      session-bound, so a stale offer must not be handed to a session that has no right to
--      accept it — after a reconnect the worker re-offers under a higher binding_revision.
--      The calling session is validated active and device-owned. An empty queue returns
--      '[]' rather than raising.
--
--      WHEN it is called (主签 2026-11-16 裁定＝搭在 heartbeat 上查): the repo has no
--      worker→gateway signal (no LISTEN/NOTIFY anywhere, and cmd/work-gateway has no poll
--      loop), and a binding is only created AFTER the device already has a session, so a
--      session-establish-only push could never fire. The gateway therefore also calls this
--      getter on every heartbeat (§3.3's ruled 10s cadence), which bounds offer delivery
--      latency to one heartbeat against a 120s default offer_ttl.
--
--      start_nonce IS returned (ruling 主签 2026-11-16 更正后＝读 binding 行原样传): the column
--      is NOT NULL and guard-immutable (0040:903, 0040:976) and create_device_run_binding
--      already mints it (0041:196), so nobody may mint a second one — §3.2's "start_nonce唯一"
--      (UNIQUE (org_id, start_nonce)), the device's runtime_start single-use and
--      acquire_device_lease's replay lookup all key off that value. It is an INTERNAL field of
--      this getter's result, NOT a §3.1 run_offer wire field: the gateway passes it to
--      acquire_device_lease and it first reaches the device inside run_start.
--
--      server_signature is deliberately NOT returned: plpgsql cannot sign ES256 (0040:1135,
--      0021 precedent), so the gateway signs the wire run_offer frame with its server key and
--      the device verifies it against the hello_ack public JWK (0049 precedent for a getter
--      that withholds the signature column). binding_hash IS computed here, by the same
--      sha256_text formula style acquire_device_lease uses for run_start.payload_hash
--      (0041:459-461), so the device can echo it in run_ready and the server can recompute it.
--
--   2. acknowledge_run_ready RESTATED with p_device_id/p_session_id. 0041 took only
--      org/run/binding_revision/client_request_id/ready: any authenticated device could answer
--      ready for another device's offer and thereby move its binding to ready, which is what
--      lets the workflow AcquireRun. work_worker has no SELECT on device_run_binding /
--      device_session / device (0024 house rule, 0040:2418), so the check must live here.
--      Gates, both ahead of the idempotency lookup (0050 precedent, so a revoked device cannot
--      obtain a replayed response either):
--        a. the calling device exists and is not revoked, and the session is active,
--           device-owned, unexpired and on the device's current auth_plane/auth_epoch
--           (0051:88-104 precedent);
--        b. the binding itself belongs to that device AND that session. §3.2 is explicit that
--           a new session may not pick up run_offer/run_start, so a reconnect's fresh hello
--           session cannot answer for an offer made to the old one; the worker re-offers under
--           a higher binding_revision bound to the new session instead.
--      The device_signature shape is reconciled with the real device signature exactly as 0048
--      did for record_device_receipt and 0050 for record_device_checkpoint: the internal
--      `^sha256:[0-9a-f]{64}$` PLACEHOLDER becomes the real ES256 form `^[A-Za-z0-9_-]{86}$`.
--      The gateway verifies the ES256 run_ready frame against the in-DB device key (0047)
--      BEFORE calling this command; SQL only shape-checks it.
--
--      Everything else is restated verbatim and in the shipped order: the request_hash formula,
--      the audit-receipt idempotency replay, the closed ready_or_reason set
--      (ready/missing_input/needs_reauthorization/profile_unavailable), the binding_hash shape
--      check, the run_not_found lookup with FOR UPDATE, and the rule that ONLY a 'ready' answer
--      on an 'offered' binding moves state (the other three leave it offered, because the
--      workflow must not AcquireRun and the reason is the user-visible next step).
--      binding_hash stays SHAPE-CHECKED ONLY, as in 0041 — comparing it against the recomputed
--      value is a separate strengthening that was not ruled for this batch.
--
-- The argument list changes, so acknowledge_run_ready is DROP + CREATE (not CREATE OR REPLACE,
-- which would leave a second overload alive). DROP removes privileges, so REVOKE/GRANT are
-- restated for the new signature and stated for the new getter; SECURITY DEFINER and the pinned
-- search_path are in each CREATE statement itself (#87 house rule). No new public error code:
-- org_context_mismatch / unauthorized / device_revoked / run_not_found / invalid_request /
-- idempotency_key_conflict are all already mapped. No table privilege is granted.

SET ROLE work_owner;

CREATE FUNCTION work.list_pending_device_offers(
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

  -- Read-only: no UPDATE, no state transition, no audit row. offered->ready remains
  -- acknowledge_run_ready's unique transition, and an expired offer is skipped rather than
  -- pushed (主签 2026-11-16 裁定).
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
    AND b.state = 'offered'
    AND b.offer_expiry > now();

  RETURN v_result;
END;
$$;

DROP FUNCTION work.acknowledge_run_ready(text, uuid, bigint, text, jsonb);

CREATE FUNCTION work.acknowledge_run_ready(
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
  v_request_hash text;
  v_receipt jsonb;
  v_response jsonb;
  v_reason text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  -- GW11 gate 1: the calling device and its live session (0051:88-104 precedent).
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

  SELECT * INTO v_binding FROM work.device_run_binding
    WHERE org_id = p_org_id AND run_id = p_run_id AND binding_revision = p_binding_revision
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- GW11 gate 2: the offer belongs to this device AND this session. §3.2: a new session may
  -- not pick up run_offer/run_start, so a reconnect cannot answer for the old session's offer.
  IF v_binding.device_id <> p_device_id OR v_binding.session_id <> p_session_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
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

REVOKE ALL ON FUNCTION work.list_pending_device_offers(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.list_pending_device_offers(text, uuid, uuid) TO work_worker;

REVOKE ALL ON FUNCTION work.acknowledge_run_ready(
  text, uuid, bigint, text, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.acknowledge_run_ready(
  text, uuid, bigint, text, jsonb, uuid, uuid) TO work_worker;

RESET ROLE;