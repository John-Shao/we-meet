-- 0056: the device cancel face (M3 gateway GW15, P0 #1).
--
-- 主签 2026-11-17 四项单选：① cancel_ack 只落停止事实，不当 Run 终态写者；② 取消下推＝只读
-- 重推＋每流去重；③ 取消来源含 governance cancellation_intent 消费者（该消费者是 GW16，不在
-- 本增量内）；④ cancel 下行与 cancel_ack 上行两侧都签 ES256。另裁：消费者逐 org 配置列表、
-- 新二进制＋timer、分两个提交。
--
-- WHAT WAS ALREADY LANDED. request_cancel (work_api, 0002:1760, owner-bound) sets
-- run.state='cancel_requested', bumps control_revision and writes an outbox cancel_signal;
-- ops_cancel_run (work_ops, 0002:3109) walks the same path. cancel_operation (work_worker,
-- 0002:1929) turns a dispatching Operation into unknown and RETURNs without releasing its
-- reservation, early-returns on succeeded/failed/canceled/reconciled/unresolved/unknown, and
-- otherwise cancels + expires the pending Approval + releases the held quota.
-- finish_local_run_state (0042:1769) maps failed/canceled under cancel_requested to canceled
-- (0042:1818) and routes active/waiting -> canceled through cancel_requested (0042:1829-1837).
--
-- WHAT WAS MISSING. No device-facing getter for pending cancels, no cancel_ack consumer, and
-- no way for the device to learn of a cancel at all: finish_local_run can return the
-- run_cancel_requested verdict (0053:232) but nothing ever delivered the cancel, so that
-- verdict was unreachable in practice. This increment adds the two device-plane commands.
--
-- TWO WIRE EXTENSIONS (annotated in device-design §3.1, original text preserved). The row
-- lists `run_id、cancel_revision / stopped_or_unknown、last_receipt_seq`. ① Both frames are
-- signed (ruled ④): the row lists no signature member on either side, but stopped_or_unknown
-- decides whether a dispatching Operation becomes unknown, so it is a consequential fact
-- assertion rather than a liveness signal like heartbeat — the same "required but no place"
-- class GW13 fixed for action_prepared and GW14 for command. ② The ACK row omits run_id and
-- cancel_revision, yet one session can hold several Runs and the server must know which
-- cancel is being acknowledged and at which revision; without them the ack is uncallable, so
-- the closed ack body is run_id/cancel_revision/stopped_or_unknown/last_receipt_seq/signature.
-- cancel_revision has an existing source: run.control_revision, which request_cancel already
-- bumps. No new counter is invented.
--
-- WHY cancel_operation IS NOT RESTATED. It takes p_actor_subject_id, not device/session, and
-- its other callers (prepare_local_operation's supersede path 0042:1148, and GW16's intent
-- consumer) have no device context. acknowledge_device_cancel therefore does the device and
-- session gating itself and calls cancel_operation internally as the definer, which is the
-- 0042 precedent for composing an existing command behind a new caller-bound gate.
--
-- WHY THE ACK IS NOT A TERMINAL WRITER (ruled ①). 0042:1746 made finish_local_run_state the
-- local Run's ONLY terminal writer, and §3.1's own semantics are "stopped 只确认本地可控进程
-- 停止，不宣称外部动作未发生" — a fact about local processes, not a Run verdict. So the ack
-- records the stop and settles the Operations; the Run reaches canceled only when the device
-- subsequently proposes run_finish(failed), which finish_local_run_state maps under
-- cancel_requested. The ack never writes run.state.
--
-- stopped VS unknown. 'stopped' means the device confirmed the local process tree stopped;
-- external effects are still unknown, so a dispatching Operation becomes unknown via
-- cancel_operation and goes to reconciliation. 'unknown' means the device cannot even assert
-- the process stopped, so a dispatching Operation is LEFT dispatching — marking it unknown
-- would claim a fact the device did not assert, and the process may still be running.
-- Undispatched Operations (authorized / waiting_approval) are definitively cancelable in both
-- cases: no permit was ever delivered, so no external effect is possible (§6.1 "queued或未
-- dispatch的Operation可确定取消/释放").
--
-- last_receipt_seq is recorded as EVIDENCE in the task event and audit payload, not written to
-- execution_lease: renew_device_lease is that column's writer (0051) and a second writer would
-- race its rewound-watermark refusal. The device's next heartbeat carries the watermark.
--
-- The getter is READ-ONLY (ruled ②): run.state='cancel_requested' plus control_revision is
-- already a durable idempotent fact, the run closed set has no delivered member, and adding
-- one would mean restating the run guard and the transition whitelist (GW11's reasoning for
-- list_pending_device_offers). Targeting is RUN-LEVEL through the latest device_run_binding
-- revision (0049 precedent), so a reconnect's new session still sees the cancel — unlike the
-- lease-bound command, a cancel is a Run fact and re-pushes across sessions naturally.
--
-- No new public error code is registered: every code raised here is already in
-- contracts/error-codes.json db_exception_map, and the raising surface is the gRPC device
-- plane, not the HTTP public API (0051/0053/0054/0055 precedent). stopped_or_unknown is a
-- frame-internal value, explicitly outside the HTTP vocabulary (control-design §9:606).
-- No table privilege is granted.

SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- 1. The read-only pending-cancel getter.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.list_pending_device_cancels(
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
    WHERE org_id = p_org_id AND id = p_device_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;
  IF v_device.status = 'revoked' THEN
    RAISE EXCEPTION 'device_revoked' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_session FROM work.device_session
    WHERE org_id = p_org_id AND id = p_session_id;
  IF NOT FOUND OR v_session.device_id <> p_device_id OR v_session.state <> 'active'
     OR v_session.expires_at <= now()
     OR v_session.auth_plane IS DISTINCT FROM v_device.auth_plane
     OR v_session.auth_epoch IS DISTINCT FROM v_device.auth_epoch THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  -- Run-level targeting: the latest binding of the Run must name this device. The calling
  -- session is validated above but is NOT part of the targeting, so a cancel survives a
  -- reconnect (0049 precedent). No state is moved: cancel_requested is already durable.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'run_id', r.id, 'cancel_revision', r.control_revision::text
  ) ORDER BY r.id), '[]'::jsonb) INTO v_result
  FROM work.run r
  WHERE r.org_id = p_org_id AND r.state = 'cancel_requested'
    AND EXISTS (
      SELECT 1 FROM work.device_run_binding b
      WHERE b.org_id = p_org_id AND b.run_id = r.id
        AND b.device_id = p_device_id
        AND b.binding_revision = (
          SELECT MAX(b2.binding_revision) FROM work.device_run_binding b2
          WHERE b2.org_id = p_org_id AND b2.run_id = r.id
        )
    );

  RETURN jsonb_build_object('cancels', v_result);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The cancel_ack consumer: caller-bound, settles Operations, never a Run terminal writer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.acknowledge_device_cancel(
  p_org_id text,
  p_run_id uuid,
  p_cancel_revision bigint,
  p_stopped_or_unknown text,
  p_last_receipt_seq bigint,
  p_device_id uuid,
  p_session_id uuid,
  p_device_signature text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_device work.device%ROWTYPE;
  v_session work.device_session%ROWTYPE;
  v_run work.run%ROWTYPE;
  v_task_id uuid;
  v_operation record;
  v_after text;
  v_canceled integer := 0;
  v_unknown integer := 0;
  v_left integer := 0;
  v_state text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  IF p_stopped_or_unknown NOT IN ('stopped', 'unknown')
     OR p_cancel_revision IS NULL OR p_cancel_revision < 1
     OR p_last_receipt_seq IS NULL OR p_last_receipt_seq < 0
     OR COALESCE(p_device_signature, '') !~ '^[A-Za-z0-9_-]{86}$' THEN
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

  -- Lock task before run, the order request_cancel (0002:1780) and cancel_operation
  -- (0002:1949) use, so a concurrent cancel request cannot deadlock against this ack.
  SELECT r.task_id INTO v_task_id FROM work.run r
    WHERE r.org_id = p_org_id AND r.id = p_run_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM work.task
    WHERE id = v_task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;

  -- The Run must be this device's, through the latest binding (the getter's targeting).
  IF NOT EXISTS (
    SELECT 1 FROM work.device_run_binding b
    WHERE b.org_id = p_org_id AND b.run_id = p_run_id
      AND b.device_id = p_device_id
      AND b.binding_revision = (
        SELECT MAX(b2.binding_revision) FROM work.device_run_binding b2
        WHERE b2.org_id = p_org_id AND b2.run_id = p_run_id
      )
  ) THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = 'P0001';
  END IF;

  -- A Run that never had a cancel requested cannot be acknowledged as stopped. A Run that
  -- already reached canceled is the late/replayed ack: it is a no-op, not a refusal, because
  -- the device may legitimately re-send after the terminal verdict landed.
  IF v_run.state NOT IN ('cancel_requested', 'canceled') THEN
    RAISE EXCEPTION 'run_cancel_requested' USING ERRCODE = 'P0001';
  END IF;
  IF v_run.state = 'canceled' THEN
    v_state := 'already_terminal';
  ELSE
    IF p_cancel_revision IS DISTINCT FROM v_run.control_revision THEN
      RAISE EXCEPTION 'revision_conflict' USING ERRCODE = 'P0001';
    END IF;
    v_state := 'recorded';
  END IF;

  IF v_state = 'recorded' THEN
    FOR v_operation IN
      SELECT o.id, o.state FROM work.operation o
      WHERE o.org_id = p_org_id AND o.run_id = p_run_id
        AND o.state NOT IN ('succeeded', 'failed', 'canceled', 'reconciled',
                            'unresolved', 'unknown')
      ORDER BY o.created_at
    LOOP
      -- 'unknown' from the device is not an assertion that the process stopped, so an
      -- in-flight Operation stays dispatching and goes to reconciliation on its own path.
      IF v_operation.state = 'dispatching' AND p_stopped_or_unknown = 'unknown' THEN
        v_left := v_left + 1;
        CONTINUE;
      END IF;
      -- cancel_operation owns the dispatching->unknown versus ->canceled distinction, the
      -- Approval expiry and the quota release; it early-returns on the settled states.
      PERFORM work.cancel_operation(p_org_id, v_operation.id, NULL, 'device_cancel');
      SELECT o.state INTO v_after FROM work.operation o
        WHERE o.org_id = p_org_id AND o.id = v_operation.id;
      IF v_after = 'unknown' THEN
        v_unknown := v_unknown + 1;
      ELSIF v_after = 'canceled' THEN
        v_canceled := v_canceled + 1;
      END IF;
    END LOOP;

    PERFORM work.append_task_event(p_org_id, v_task_id, 'run.cancel_acknowledged',
      jsonb_build_object('run_id', p_run_id, 'cancel_revision', p_cancel_revision,
        'stopped_or_unknown', p_stopped_or_unknown,
        'last_receipt_seq', p_last_receipt_seq,
        'canceled_operations', v_canceled, 'unknown_operations', v_unknown,
        'dispatching_remaining', v_left));
    PERFORM work.append_audit(p_org_id, NULL, 'device_cancel.acknowledged',
      'run', p_run_id::text,
      jsonb_build_object('device_id', p_device_id, 'session_id', p_session_id,
        'cancel_revision', p_cancel_revision,
        'stopped_or_unknown', p_stopped_or_unknown,
        'last_receipt_seq', p_last_receipt_seq,
        'canceled_operations', v_canceled, 'unknown_operations', v_unknown,
        'dispatching_remaining', v_left));
  END IF;

  RETURN jsonb_build_object(
    'run_id', p_run_id, 'cancel_revision', p_cancel_revision::text,
    'state', v_state, 'stopped_or_unknown', p_stopped_or_unknown,
    'canceled_operations', v_canceled, 'unknown_operations', v_unknown,
    'dispatching_remaining', v_left);
END;
$$;

REVOKE ALL ON FUNCTION work.list_pending_device_cancels(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.acknowledge_device_cancel(
  text, uuid, bigint, text, bigint, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.list_pending_device_cancels(text, uuid, uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.acknowledge_device_cancel(
  text, uuid, bigint, text, bigint, uuid, uuid, text) TO work_worker;

RESET ROLE;