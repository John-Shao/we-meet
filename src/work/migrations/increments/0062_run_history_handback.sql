-- 0062: one read-only projection that says whether a Run is currently handing its history
-- back, so the UI can show device-design §3.3's "正在交回历史并收尾" instead of letting the
-- same Run read as a stuck task (execution-face batch 7).
--
-- WHY: §3.3 rules that an expired execution lease is NOT the end of the device's channel —
--   "租约过期不等于设备失去交回历史的通道（控制面 §4.2、J12）：设备可重新签一次 lease 只为
--   上传 receipts/checkpoint 与提议 run_finish，该 lease 不携带任何新许可 … 界面在此情形下应
--   显示"正在交回历史并收尾"，不是"任务卡住"。" Batch 6 made the mechanism real: 0061 lets the
--   device mint a same-session reconcile_finish lease and finish under it, and the gateway
--   answers on the existing unsigned `lease` downlink. The sentence's second half — what the
--  界面 must show — was registered in batch 6's landing note as NOT done (⑨ "本批未接界面").
--   This increment is the server fact that half needs.
--
-- THE FACT: a row in work.execution_lease for this Run with purpose='reconcile_finish'
--   AND state='active' AND expires_at > now(). 0040:876-877's partial unique index
--   work_execution_lease_one_active_per_run allows exactly ONE active lease per run regardless
--   of purpose, so "a reconcile_finish lease is live" and "the only live lease on this run is the
--   hand-back one" are the same fact — no extra condition is needed to exclude a run that also
--   holds an execute lease, and an expired or released reconcile lease answers false because
--   0051/J12 never revive an expired lease. purpose's closed set is 0040:820-821 and state's is
--   0040:826-827; nothing new is invented here.
--
-- WHY A DEFINER FUNCTION: the reader is the browser Work UI, whose plane is the Host session
--   cookie (internal/api/auth.go:33 authenticate, the same one work.list_run_reconciliations
--   uses). It cannot read the lease table: catalog 0061 grants work.execution_lease to
--   work_owner alone (SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER/TRUNCATE, no work_api row),
--   and 0040:838-839 both enables and forces RLS on it. So the fact crosses to the API through a
--   SECURITY DEFINER getter — the house pattern every R0b read face already uses — and the grant
--   below is EXECUTE to work_api only, never table privileges.
--
-- NOT A STATE: run.state is untouched and no transition edge is added. Control design §4.2's
--   rule (line 296: "本机 Run 收尾不得新造 `waiting→succeeded`" — run.waiting's legal exits are
--   active/failed/cancel_requested, 0002:518-520) is exactly why this is a projection and not a
--   new run state or a new wait_reason member. The R0a contract's Run schema is likewise not
--   touched: it is closed (r0a-openapi-v1.yaml:1147-1148 additionalProperties:false with a
--   pinned required list), so re-ruling that frozen asset would be the cost of putting the bit
--   there, and this face exists so that cost is not paid. The answer is two keys and nothing
--   else: run_id plus the boolean.
--
-- OWNERSHIP: the idiom is copied from work.list_run_reconciliations (0021:567-583) verbatim in
--   shape — org context must equal the session's app.org_id (org_context_mismatch), the actor
--   subject is asserted against the session, the Run must exist and its Task must be owned by
--   that subject, and somebody else's Run answers the SAME way a missing one does
--   (task_not_found, P0002) because a 403 would disclose that the Run is real (0002:2840-2841).
--   This function reads no artifact body, no content reference and no provider text.
SET ROLE work_owner;

CREATE FUNCTION work.run_history_handback(
  p_org_id text,
  p_run_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_handback boolean;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM work.assert_session_subject(p_actor_subject_id);

  SELECT * INTO run_row FROM work.run WHERE org_id = p_org_id AND id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO task_row FROM work.task
  WHERE org_id = p_org_id AND id = run_row.task_id
    AND owner_subject_id = p_actor_subject_id;
  -- A Run under somebody else's ownership is answered as not-found, not forbidden, for the
  -- same reason 0021:578-583 gives: this view exists so an owner can tell what their own task
  -- is doing, and a 403 would still confirm that the Run exists.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 0040:876-877 makes this existence test the whole judgment: at most one active lease per
  -- run, so a live reconcile_finish lease means the run's execution lease is already gone.
  SELECT EXISTS (
    SELECT 1
    FROM work.execution_lease l
    WHERE l.org_id = p_org_id
      AND l.run_id = p_run_id
      AND l.purpose = 'reconcile_finish'
      AND l.state = 'active'
      AND l.expires_at > now()
  ) INTO v_handback;

  RETURN jsonb_build_object(
    'run_id', run_row.id,
    'history_handback', v_handback
  );
END;
$$;

REVOKE ALL ON FUNCTION work.run_history_handback(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.run_history_handback(text, uuid, text) TO work_api;

RESET ROLE;
