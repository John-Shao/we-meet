-- 0049: claim the device's un-acked operation_resolution queue for the gateway downlink (M3 GW7).
--
-- Authority: device-design §3.1 operation_resolution row ("送达是 push 且可重推：每次
-- session 建立（含重连与新 hello）控制面都先按未 ack 的 resolution 重发"), architecture
-- RB-A21 and signoff R7-7 ("重推条件为不在 {acked, not_applicable}"). The gateway signs
-- the WIRE operation_resolution frame with its own server key (GW7, devicesig.SignFrame)
-- and the device verifies it against the public JWK distributed in hello_ack; plpgsql
-- cannot sign ES256 (0040:1135, 0021 precedent), so operation_resolution.signature stays
-- the immutable internal sha256 placeholder issue_operation_resolution writes and is NOT
-- the wire signature. This command therefore returns the conclusion fields the wire body
-- carries and deliberately NOT the signature column.
--
-- Push is delivered (主签 2026-11-16 裁定＝认领命令，读+写合一). The watermark guard
-- (0021:142) allows pending->delivered and delivered->acked but NOT pending->acked, so a
-- pushed conclusion must be marked delivered before consume_device_ack can ack it.
-- 'delivered' had no writer in the landed chain (an orphan closed-set member); this command
-- is that unique writer. Claiming is atomic with the read: the pending rows of the device's
-- queue advance pending->delivered (delivery_attempts counts the attempt), already-delivered
-- rows are re-counted idempotent (delivered->delivered is not a transition), and the two
-- terminal watermarks (acked/not_applicable) are never touched. The returned set is exactly
-- what the gateway signs and sends; a lost send is covered by re-push (delivered is re-pushed).
--
-- Device targeting (主签 2026-11-16 裁定＝run 级): a resolution belongs to a Run, and the
-- authoritative device↔run association is device_run_binding (device-design §3.2). The
-- current binding for a Run is its highest binding_revision (resume mints a higher one,
-- index work_device_run_binding_run_latest); the command claims a resolution only when that
-- latest binding points at the calling device. Filtering by device_id rather than the
-- binding's historical session_id is what makes re-push survive a reconnect with a new hello
-- session. The calling session is still validated active and device-owned, mirroring
-- consume_device_ack (0042:2186), so a superseded session cannot drain the queue.
--
-- work_worker has no SELECT/UPDATE on operation_resolution / device_run_binding /
-- device_session (0024 house rule, 0040:2418), so this SECURITY DEFINER command is the in-DB
-- read+write path. No new public error code: org_context_mismatch and unauthorized are
-- internal guards already mapped; an empty queue returns '[]' rather than raising. No table
-- privilege is granted.

SET ROLE work_owner;

CREATE FUNCTION work.claim_pending_device_resolutions(
  p_org_id text,
  p_device_id uuid,
  p_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_session work.device_session%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id;
  IF NOT FOUND OR v_session.device_id <> p_device_id OR v_session.state <> 'active'
     OR v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  -- Claim: advance the device's pending conclusions to delivered and re-count the ones
  -- already delivered. The terminal watermarks are excluded, so an acked/not_applicable
  -- row is never resurrected. delivered->delivered leaves resolution_delivery unchanged
  -- (the guard only checks a transition when the value actually moves).
  UPDATE work.operation_resolution o
  SET resolution_delivery = 'delivered',
      delivery_attempts = delivery_attempts + 1,
      updated_at = now()
  WHERE o.org_id = p_org_id
    AND o.resolution_delivery NOT IN ('acked', 'not_applicable')
    AND EXISTS (
      SELECT 1 FROM work.device_run_binding b
      WHERE b.org_id = p_org_id AND b.run_id = o.run_id
        AND b.device_id = p_device_id
        AND b.binding_revision = (
          SELECT MAX(b2.binding_revision) FROM work.device_run_binding b2
          WHERE b2.org_id = p_org_id AND b2.run_id = o.run_id
        )
    );

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'resolve_id', r.resolve_id,
    'run_id', r.run_id,
    'operation_id', r.operation_id,
    'attempt_id', r.attempt_id,
    'state', r.state,
    'delivery_state', r.delivery_state,
    'code', r.code,
    'usage_source', r.usage_source,
    'settlement_state', r.settlement_state,
    'resolution_revision', r.resolution_revision
  ) ORDER BY r.run_id, r.operation_id, r.resolution_revision), '[]'::jsonb)
  INTO v_result
  FROM work.operation_resolution r
  WHERE r.org_id = p_org_id
    AND r.resolution_delivery NOT IN ('acked', 'not_applicable')
    AND EXISTS (
      SELECT 1 FROM work.device_run_binding b
      WHERE b.org_id = p_org_id AND b.run_id = r.run_id
        AND b.device_id = p_device_id
        AND b.binding_revision = (
          SELECT MAX(b2.binding_revision) FROM work.device_run_binding b2
          WHERE b2.org_id = p_org_id AND b2.run_id = r.run_id
        )
    );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION work.claim_pending_device_resolutions(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.claim_pending_device_resolutions(text, uuid, uuid) TO work_worker;

RESET ROLE;