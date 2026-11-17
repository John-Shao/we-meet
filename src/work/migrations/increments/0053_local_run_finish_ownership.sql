-- 0053: bind finish_local_run to the calling device and session (M3 gateway GW12).
--
-- Authority: control-design §4.2 finish_local_run caller = "gateway经领域代理", §6.4 step 1
-- ("签名、session、lease、fence、binding_revision 精确匹配当前值"), device-design §3.1
-- run_finish/run_finish_ack row and §3.4 step 4. 0042:1907 implemented the whole six-step
-- adjudication and 0042:1769 finish_local_run_state is the local Run's only terminal writer;
-- neither is restated here beyond the two additions below.
--
-- WHY the gates are needed: 0042's finish_local_run took only org/run/finish_id/lease_id/
-- binding_revision/fence/finish. It derived the device and session FROM THE LEASE ROW
-- (0042:2007-2010) and only compared the binding against that lease (0042:2003-2006) — it
-- never compared either against the CALLER. So any authenticated device that learned another
-- device's lease_id + binding_revision + fence could finish that device's Run: move it to a
-- terminal state, release its lease, invalidate its readonly grants and revoke its runtime
-- executions. work_worker has no SELECT on execution_lease / device_run_binding /
-- device_session / device (0024 house rule, 0040:2418), so the gateway cannot make that
-- judgment itself; it has to live here. This is the same ownership class GW9 (0050),
-- GW10 (0051) and GW11 (0052) closed.
--
-- Three changes, everything else restated verbatim and in the shipped order:
--
--   1. p_device_id/p_session_id with two gates, both ahead of the idempotency lookup
--      (0050/0052 precedent, so a revoked device cannot obtain a replayed verdict either):
--        a. the calling device exists and is not revoked, and the session is active,
--           device-owned, unexpired and on the device's current auth_plane/auth_epoch
--           (0051:88-104 precedent);
--        b. the lease itself belongs to that device AND that session. The existing
--           binding-vs-lease comparison below then binds the caller transitively.
--      §6.4 step 1 asks for session to match "当前值" literally, and §3.1's lease row says
--      "一次只绑定原设备/会话", so a reconnect's fresh hello session cannot finish under the
--      old session's lease (GW10 made the same ruling for renewal). KNOWN GAP, flagged not
--      solved (主签 2026-11-16 单选＝登记缺口延后): §3.3/J12 lets a device re-acquire a lease
--      solely to hand back history and propose run_finish, and 0041:340-348/398-400 already
--      implements purpose='reconcile_finish' (no start_nonce, no run_start, no seq=0 baseline,
--      allowed with unreconciled unknowns) — but §3.1 has NO uplink frame that requests a
--      lease (heartbeat only renews ones already held), and acquire_device_lease requires
--      run.state='active' (0041:378). So after a reconnect or an expired lease the device
--      cannot obtain that finish-only lease, and this command refuses it. Closing the gap
--      needs a wire ruling, not a SQL change.
--
--   2. device_signature's internal PLACEHOLDER shape `^sha256:[0-9a-f]{64}$` becomes the real
--      ES256 form `^[A-Za-z0-9_-]{86}$`, exactly as 0046/0048/0050/0052 did for their frames.
--      The gateway verifies the ES256 run_finish frame against the in-DB device key (0047)
--      BEFORE calling this command; SQL only shape-checks it. signed_payload_hash keeps its
--      0042 formula (sha256_text of the signature string) — it is the idempotency payload
--      hash, not a signature.
--
--   3. device_run_finish_deliverable_shape EXEMPTS REJECTED ROWS (主签 2026-11-17 单选＝本批修).
--      0042:465-466 checks work.deliverable_versions_valid(deliverable_versions, outcome) on
--      EVERY row, and that function demands completed => a non-empty list (0042:402-405). But
--      0042:1903-1905 also writes a state='rejected' row as the EVIDENCE of what was refused,
--      and §6.4 step 4 says a completed proposal with an empty deliverable list must be answered
--      finish_precondition_failed. The two collide: the refused proposal's own INSERT violates
--      23514, so the device gets a transport-level service_degraded instead of the verdict the
--      design defines, and no evidence row survives. Measured discrimination: the same proposal
--      with one bogus non-empty version id is adjudicated normally.
--      The fix exempts only the evidence row — a rejected row records the proposal AS MADE, not
--      a deliverable fact — and leaves the accepted path under the original gate untouched, so
--      no success criterion is relaxed. Existing rows all satisfy the stricter old check, so
--      ADD CONSTRAINT's validation scan passes.
--
-- server_signature is deliberately LEFT AS THE INTERNAL PLACEHOLDER: the column carries
-- `CHECK (server_signature ~ '^sha256:[0-9a-f]{64}$')` (0042:479-480) and plpgsql cannot sign
-- ES256 (0040:1135, 0021/0049 precedent). The gateway signs the WIRE run_finish_ack frame with
-- its server key and drops this column from the body; the device verifies against the
-- hello_ack public JWK.
--
-- The argument list changes, so this is DROP + CREATE (CREATE OR REPLACE would leave a second
-- overload alive). DROP removes privileges, so REVOKE/GRANT are restated for the new signature;
-- SECURITY DEFINER and the pinned search_path are in the CREATE statement itself (#87 house
-- rule). No new public error code: org_context_mismatch / unauthorized / device_revoked /
-- run_not_found / invalid_request / idempotency_key_conflict are all already mapped, and the
-- four verdict codes (stale_fence / run_cancel_requested / finish_state_mismatch /
-- finish_precondition_failed) are NOT exceptions — 0042 returns them inside the result as
-- state='rejected', code=…, which the gateway forwards in the ack body (device-design §3.1
-- keeps them in run_finish_ack.code's closed set, separate from operation_resolution's).
-- No table privilege is granted.

SET ROLE work_owner;

DROP FUNCTION work.finish_local_run(text, uuid, uuid, uuid, bigint, bigint, jsonb);

CREATE FUNCTION work.finish_local_run(
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

  -- GW12 gate 1: the calling device and its live session (0051:88-104 / 0052 precedent).
  -- Ahead of the shape check AND the idempotency lookup, so a revoked device cannot obtain
  -- a replayed verdict either.
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

  -- Idempotency by (org, run, finish_id), never by outcome.
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
      'unresolved_operations', '[]'::jsonb,
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
  -- GW12 gate 2: the lease belongs to the CALLING device AND session. 0042 compared the
  -- binding against the lease but never either against the caller; with the check above, the
  -- binding is bound to the caller transitively. §6.4 step 1 wants session to match "当前值"
  -- and §3.1's lease row says "一次只绑定原设备/会话", so a reconnect's fresh hello session
  -- cannot finish under the old session's lease (GW10 ruled the same for renewal). The J12
  -- reconcile_finish lease that would let it hand back history is unreachable today — header.
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

  -- 1. fence. An old fence is refused without writing any state.
  IF v_run.fence IS DISTINCT FROM p_fence OR v_lease.fence IS DISTINCT FROM p_fence THEN
    v_reject := 'stale_fence';
  END IF;

  -- 2. Task ownership and the cancel request.
  IF v_reject IS NULL THEN
    IF v_task.state <> 'open' OR v_task.active_run_id IS DISTINCT FROM p_run_id THEN
      v_reject := 'finish_precondition_failed';
    ELSIF v_run.state = 'cancel_requested' AND v_outcome = 'completed' THEN
      v_reject := 'run_cancel_requested';
    END IF;
  END IF;

  -- 3. checkpoint / receipt continuity / the recomputed operation-set hash.
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

  -- 4. the completed gate, computed for THIS RUN only. task_has_blocking_operation is
  -- deliberately not used: it aggregates the whole Task and a previous Run's unknown
  -- would block this one forever. It stays in force for new-Run admission and acceptance.
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
      -- Every deliverable must be a published local_only version of THIS Run.
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
       reject_code, terminal_run_revision, server_signature)
    VALUES
      (p_org_id, p_run_id, p_finish_id, p_binding_revision, p_fence, p_lease_id,
       v_outcome, v_reason, (p_finish ->> 'final_checkpoint_seq')::bigint,
       p_finish ->> 'final_checkpoint_hash',
       (p_finish ->> 'receipt_through_seq')::bigint, v_set_hash,
       p_finish -> 'deliverable_versions', v_signed_hash, 'rejected', v_reject, NULL,
       v_server_signature);
    PERFORM work.append_audit(p_org_id, NULL, 'run.finish_local_rejected',
      'run', p_run_id::text,
      jsonb_build_object('finish_id', p_finish_id, 'code', v_reject,
        'expected_operation_set_hash', v_set_hash));
    RETURN jsonb_build_object('finish_id', p_finish_id, 'state', 'rejected',
      'code', v_reject, 'terminal_run_revision', NULL,
      'expected_operation_set_hash', v_set_hash, 'unresolved_operations', v_unresolved,
      'server_signature', v_server_signature, 'replayed', false);
  END IF;

  -- 5. the terminal write, through the dedicated local writer only.
  v_run_outcome := CASE v_outcome WHEN 'completed' THEN 'succeeded' ELSE 'failed' END;
  v_terminal := work.finish_local_run_state(p_org_id, p_run_id, v_run_outcome, v_reason);

  INSERT INTO work.device_run_finish
    (org_id, run_id, finish_id, binding_revision, fence, lease_id, outcome,
     reason_code, final_checkpoint_seq, final_checkpoint_hash, receipt_through_seq,
     final_operation_set_hash, deliverable_versions, signed_payload_hash, state,
     reject_code, terminal_run_revision, server_signature)
  VALUES
    (p_org_id, p_run_id, p_finish_id, p_binding_revision, p_fence, p_lease_id,
     v_outcome, v_reason, (p_finish ->> 'final_checkpoint_seq')::bigint,
     p_finish ->> 'final_checkpoint_hash',
     (p_finish ->> 'receipt_through_seq')::bigint, v_set_hash,
     p_finish -> 'deliverable_versions', v_signed_hash, 'accepted', NULL, v_terminal,
     v_server_signature);

  v_response := jsonb_build_object('finish_id', p_finish_id, 'state', 'accepted',
    'code', NULL, 'terminal_run_revision', v_terminal,
    'expected_operation_set_hash', v_set_hash, 'unresolved_operations', '[]'::jsonb,
    'server_signature', v_server_signature);
  RETURN v_response || jsonb_build_object('replayed', false);
END;
$$;

-- Change 3: the rejected evidence row is exempt from the deliverable shape gate. The accepted
-- path keeps 0042's original criterion verbatim, so a completed Run still cannot be recorded
-- without at least one deliverable version.
ALTER TABLE work.device_run_finish
  DROP CONSTRAINT device_run_finish_deliverable_shape;
ALTER TABLE work.device_run_finish
  ADD CONSTRAINT device_run_finish_deliverable_shape
  CHECK (state = 'rejected' OR work.deliverable_versions_valid(deliverable_versions, outcome));

REVOKE ALL ON FUNCTION work.finish_local_run(
  text, uuid, uuid, uuid, bigint, bigint, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.finish_local_run(
  text, uuid, uuid, uuid, bigint, bigint, jsonb, uuid, uuid) TO work_worker;

RESET ROLE;
