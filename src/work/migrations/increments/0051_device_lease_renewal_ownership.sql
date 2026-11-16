-- 0051: bind lease renewal to the calling device and its live session (M3 gateway GW10).
--
-- Authority: device-design §3.1 heartbeat row ("monotonic_ms、lease IDs、last_receipt_seq
-- ｜仅在线性化续租成功后延长本地许可") and lease row ("lease_id、run_id、fence、expires_at、
-- ttl_ms｜不等于动作许可；一次只绑定原设备/会话"), §3.3 ("租约默认 30s/心跳10s；本地 deadline
-- 用发送心跳时的单调时间 + 服务端 TTL 减往返耗时保守计算"), control-design §4.2
-- renew_device_lease caller = "worker/gateway领域代理". The device agent already holds the
-- local lease state machine (src/device permit/lease.rs: monotonic deadline, TTL minus
-- round-trip, history-return-only mode), but the gateway had no heartbeat handler and this
-- command had one gap that made the renewal surface unsafe to expose:
--
--   NO DEVICE/SESSION OWNERSHIP. 0041 took only org/lease_id/ttl/last_receipt_seq: any
--   authenticated device that learned another device's lease_id could extend that lease
--   (and push its receipt watermark), because execution_lease.device_id/session_id were
--   never compared against the caller. work_worker has no SELECT on execution_lease /
--   device_session / device (0024 house rule, 0040:2418), so the gateway cannot check
--   ownership itself — the check must live in this definer command. The heartbeat wire
--   body carries no identity (§3.1), so the gateway passes the certificate-mapped device
--   and the hello-established session as two new arguments, exactly as 0050 did for
--   record_device_checkpoint.
--
-- Two gates, both before any write:
--   1. The calling device exists and is not revoked, and the session is active,
--      device-owned, unexpired and on the device's current auth_plane/auth_epoch.
--      Mirrors 0050:91-107 (which mirrors consume_device_permit, 0042:1345-1360).
--   2. The lease itself belongs to that device AND that session. §3.1's "一次只绑定原
--      设备/会话" is literal: execution_lease.session_id is immutable (0040:851 guard),
--      so a reconnect that mints a NEW hello session cannot renew the old session's
--      lease. The device's local lease is invalidated on sleep/clock discontinuity
--      (§3.3) and it must reconcile and re-acquire instead; acquire_device_lease's
--      start_nonce replay path returning a lease bound to an older session is a
--      pre-existing offer/start-spine boundary, deliberately NOT changed here.
--
-- Every other 0041 judgment is restated verbatim and in its shipped order: the ttl
-- BETWEEN 1 AND 30 / last_receipt_seq >= 0 shape check, the lease lookup with FOR UPDATE,
-- not_found, the never-revive rule (state <> 'active' OR expires_at <= now() raises
-- resync_required — the whitelist has no expired -> active edge, the device asks for a
-- new reconcile_finish lease instead, J12), the monotonic watermark check, the renewal
-- UPDATE and the seven-field response. The identity gates are inserted ahead of them so
-- a foreign device cannot obtain even a shape error about another device's lease.
--
-- resync_required is already a registered public code (contracts/error-codes.json:
-- 409, retryable=false, recovery_action=resync); no new code is registered. The gateway
-- maps it to FAILED_PRECONDITION (control-design §582) so the device can tell "reconcile
-- and re-acquire" from a generic service failure. No table privilege is granted.
--
-- The argument list changes, so this is DROP + CREATE (not CREATE OR REPLACE, which would
-- leave a second overload alive). DROP removes privileges, so REVOKE/GRANT are restated
-- for the new signature; SECURITY DEFINER and the pinned search_path are in the CREATE
-- statement itself (#87 house rule).

SET ROLE work_owner;

DROP FUNCTION work.renew_device_lease(text, uuid, int, bigint);

CREATE FUNCTION work.renew_device_lease(
  p_org_id text,
  p_lease_id uuid,
  p_ttl_seconds int,
  p_last_receipt_seq bigint,
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
  v_lease work.execution_lease%ROWTYPE;
  v_expiry timestamptz;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  -- GW10 gate 1: the calling device and its live session (0050:91-107 precedent).
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

  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 30
     OR p_last_receipt_seq IS NULL OR p_last_receipt_seq < 0 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_lease FROM work.execution_lease
    WHERE org_id = p_org_id AND id = p_lease_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  -- GW10 gate 2: a lease is bound to the original device AND session (§3.1 lease row).
  IF v_lease.device_id <> p_device_id OR v_lease.session_id <> p_session_id THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
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

REVOKE ALL ON FUNCTION work.renew_device_lease(
  text, uuid, int, bigint, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.renew_device_lease(
  text, uuid, int, bigint, uuid, uuid) TO work_worker;

RESET ROLE;