-- 0057: the governance cancellation-intent consumer (M3 GW16, control-design §6.1).
--
-- 主签 2026-11-17 三项单选（GW15 另裁"分两个提交"，消费者独立成批）：① dead_letter 的运维
-- 重放＝**增注册一条 dead_letter→pending 边＋work_ops 专属命令**；② Task 锁内**全谓词复核
-- （含 device/grant 资源侧）**；③ 告警＝**审计行，照 mark_outbox_failed 先例**（现网 outbox
-- 死信也只有审计行、无 gauge，两者口径一致；"无死信计数 gauge"如实登记为欠账）。
-- 另三项已裁：逐 org 配置列表（不新增 RLS 旁路标志）、新二进制 cmd/work-cancel＋systemd
-- timer、消费者与设备取消面分两个提交。
--
-- WHAT WAS ALREADY LANDED. 0018 created work.cancellation_intent (PK org/source_event_id/
-- run_id = §6.1's dedup key, partial due index on (org_id,next_attempt) WHERE state='pending',
-- immutable content guard, no_delete, transition whitelist pending→consumed / pending→
-- dead_letter, ALL table DML revoked from every workload role). 0023 gave `pending` a
-- producer: queue_run_cancellations, called in the same transaction as the deny by
-- record_org_narrowing / record_member_narrowing (member and seat) / the operator suspension
-- command. 0040 added two direct producers: revoke_device (:1752) and revoke_workspace_grant
-- (:2037). WHAT WAS MISSING: no claim, no consume, no fail, no replay — `consumed` and
-- `dead_letter` had NO writer at all, the orphan-state debt §6.1:389 records as task #32.
-- Writing without consuming is the safe direction (the backlog grows, cancellations are not
-- lost) but it is not a finished pipeline. This increment closes it.
--
-- WHY A FOURTH WRITER OF cancel_requested IS NOT A SINGLE-WRITER VIOLATION. The discipline
-- 0042:1746 established is that finish_local_run_state is the local Run's only TERMINAL
-- writer. cancel_requested is not terminal, and it already has three inline writers:
-- request_cancel (0002:1794), ops_cancel_run (0002:3136) and finish_local_run_state
-- (0042:1830, the registered active/waiting→canceled path). The consumer cannot call either
-- command: request_cancel is work_api and owner-bound through assert_session_subject,
-- ops_cancel_run is work_ops and ticket-bound, and a governance consumer is neither a user
-- nor an operator. So it writes the same registered transition itself, with the same write
-- set (state, wait_reason=NULL, control_revision+1, task event, outbox cancel_signal, audit).
-- The outbox row is the hand-off, not a second authority: the relay turns cancel_signal into
-- a Temporal signal for cloud Runs, and for a local Run the state change is what GW15's
-- read-only list_pending_device_cancels getter delivers to the device. The consumer sends no
-- frame and writes no terminal state.
--
-- THE PREDICATE IS RE-CHECKED, NOT TRUSTED (ruled ②). cancellation_intent stores no cutoff,
-- scope or subject column, so the consumer joins back to the deny that produced it
-- (access_restriction.id = source_event_id) and re-applies §6.1's predicate inside the Task
-- lock, per scope, exactly as each producer applied it:
--   org    — run.admission_access_epoch <= deny.epoch (the RETIRED epoch, 0023:159/162).
--   member — the same epoch test PLUS task.owner_subject_id = deny.subject_id. §6.1's point
--            is "不以当前该成员的所有Run代替": a Run admitted after the deny carries a higher
--            admission epoch and is excluded by construction.
--   device — the Run actually binds that device (device_run_binding), which is revoke_device's
--            own selector (0040:1756-1757).
--   grant  — the Run's binding grant_set actually contains that grant, which is
--            revoke_workspace_grant's own selector (0040:2043-2044).
-- §6.1's `affected_revision` comparison has NO value for device/grant: those two denies leave
-- host_revision NULL (0040:1745/2031), and §6.1:385 defines affected_revision AS host_revision.
-- Neither producer applies an epoch filter either, so re-checking one here would narrow the
-- queue below what produced it. This is recorded rather than invented around.
--
-- A RELEASED DENY STILL CANCELS ITS OLD RUNS. §6.1: "旧Run即使后来恢复席位仍属于原取消范围，
-- 不自动复活". The re-check therefore does NOT test access_restriction.state: releasing a deny
-- stops NEW admissions at the old epoch, it does not resurrect the Runs already in scope.
--
-- BACKOFF AND DEAD-LETTER (ruled ③). fail_cancellation_intent mirrors mark_outbox_failed
-- (0002:2525-2585) with §6.1's own ladder: next_attempt = now() + LEAST(2^(attempts-1), 60)
-- seconds, so the first retry is 1s and the ceiling is 60s (the outbox ceiling is 300s; §6.1
-- asks for 60). At 10 attempts, or immediately when the failure is not retryable, the intent
-- goes to dead_letter and an audit row is the alert. The deny is never touched: §6.1 requires
-- it retained, and ops may only replay the intent, never force a Run to canceled.
--
-- THE REPLAY EDGE (ruled ①). 0018:66-67 registered only pending→consumed and pending→
-- dead_letter, so dead_letter was a one-way end with no way back — and no_delete plus the
-- composite PK mean a replay cannot be expressed as a fresh row either. This increment
-- registers dead_letter→pending, which is what makes "运维只重放意图/信号" callable.
-- `consumed` stays terminal: the guard already refuses consumed→dead_letter (0018:505) and
-- no consumed→pending edge is registered, so a settled intent can never be re-opened.
--
-- CLAIM CAPS ARE DB FACTS. §6.1: ≤100 Tasks per round, ≤500 pending intents per org, and
-- "超量保留cursor继续，不跳过". The writer deliberately has no cap (0023:103) because a
-- producer-side limit would silently drop cancellations, so both limits live here and are
-- clamped like claim_outbox's LEAST(GREATEST(limit,1),100). The cursor is the due index order
-- (next_attempt, source_event_id, run_id): whatever the caps leave behind stays pending at its
-- original next_attempt and is picked up next round, never skipped.
--
-- The claim also pushes each returned row's next_attempt 60s into the future. That is a
-- visibility window, not a new column: cancellation_intent has no claimed_by/claimed_until
-- (0018:464-481) and adding them would mean restating the content guard. A consumer that dies
-- mid-round therefore leaves intents that become due again on their own, and a second
-- consumer cannot re-claim rows already in flight. systemd's oneshot timer already prevents
-- overlapping runs of the same unit; the window covers the crash case.
--
-- One new internal code is raised: cancellation_intent_not_pending (P0001, whose fallback is
-- service_degraded per the catalog's worker-only rule, so registering it moves no shipped
-- response). No new PUBLIC code: the raising surface is a workload consumer and an ops
-- command, not the HTTP public API, and every other code used here is already mapped.

SET ROLE work_owner;

-- ---------------------------------------------------------------------------
-- 1. The replay edge ruled ①. `consumed` deliberately gets no outgoing edge.
-- ---------------------------------------------------------------------------
INSERT INTO work.state_transition (entity, from_state, to_state) VALUES
  ('cancellation_intent', 'dead_letter', 'pending')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The claim: due pending intents, capped per org and per round, oldest first.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.claim_pending_cancellation_intents(
  p_org_id text,
  p_task_limit integer,
  p_intent_limit integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_task_limit integer := LEAST(GREATEST(COALESCE(p_task_limit, 100), 1), 100);
  v_intent_limit integer := LEAST(GREATEST(COALESCE(p_intent_limit, 500), 1), 500);
  v_tasks uuid[];
  v_row record;
  v_result jsonb := '[]'::jsonb;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  -- The Task budget is spent on the Tasks whose oldest intent is due first, so a backlog
  -- deeper than one round drains in arrival order rather than starving the oldest Task.
  SELECT ARRAY(
    SELECT s.task_id FROM (
      SELECT r.task_id, MIN(ci.next_attempt) AS first_due
      FROM work.cancellation_intent ci
      JOIN work.run r ON r.id = ci.run_id AND r.org_id = ci.org_id
      WHERE ci.org_id = p_org_id AND ci.state = 'pending' AND ci.next_attempt <= now()
      GROUP BY r.task_id
      ORDER BY first_due, r.task_id
      LIMIT v_task_limit
    ) s
  ) INTO v_tasks;

  IF v_tasks IS NULL OR cardinality(v_tasks) = 0 THEN
    RETURN jsonb_build_object('intents', v_result);
  END IF;

  FOR v_row IN
    SELECT ci.source_event_id, ci.run_id, ci.reason, ci.attempts, r.task_id
    FROM work.cancellation_intent ci
    JOIN work.run r ON r.id = ci.run_id AND r.org_id = ci.org_id
    WHERE ci.org_id = p_org_id AND ci.state = 'pending' AND ci.next_attempt <= now()
      AND r.task_id = ANY(v_tasks)
    ORDER BY ci.next_attempt, ci.source_event_id, ci.run_id
    LIMIT v_intent_limit
    FOR UPDATE OF ci SKIP LOCKED
  LOOP
    -- Visibility window: a consumer that dies here leaves an intent that becomes due again
    -- on its own, and a concurrent consumer cannot re-claim it. attempts is NOT bumped —
    -- only a real failure counts against the dead-letter ladder.
    UPDATE work.cancellation_intent
      SET next_attempt = now() + interval '60 seconds', updated_at = now()
      WHERE org_id = p_org_id AND source_event_id = v_row.source_event_id
        AND run_id = v_row.run_id;
    v_result := v_result || jsonb_build_object(
      'source_event_id', v_row.source_event_id, 'run_id', v_row.run_id,
      'task_id', v_row.task_id, 'reason', v_row.reason, 'attempts', v_row.attempts);
  END LOOP;

  RETURN jsonb_build_object('intents', v_result);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. The consume: re-check the predicate under the Task lock, then enter the cancel path.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.consume_cancellation_intent(
  p_org_id text,
  p_source_event_id uuid,
  p_run_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_intent work.cancellation_intent%ROWTYPE;
  v_deny work.access_restriction%ROWTYPE;
  v_task_id uuid;
  v_task work.task%ROWTYPE;
  v_run work.run%ROWTYPE;
  v_operation record;
  v_canceled integer := 0;
  v_in_scope boolean;
  v_outcome text;
  v_reason text;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);

  SELECT * INTO v_intent FROM work.cancellation_intent
    WHERE org_id = p_org_id AND source_event_id = p_source_event_id AND run_id = p_run_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  -- A consumed intent is the replay of a settled one: a no-op, not a refusal, so a consumer
  -- that crashed after committing can re-run its round safely. A dead_letter intent belongs
  -- to ops replay and must not be consumed by the worker.
  IF v_intent.state = 'consumed' THEN
    RETURN jsonb_build_object('source_event_id', p_source_event_id, 'run_id', p_run_id,
      'state', 'consumed', 'outcome', 'already_consumed',
      'cancel_revision', NULL, 'canceled_operations', 0);
  END IF;
  IF v_intent.state <> 'pending' THEN
    RAISE EXCEPTION 'cancellation_intent_not_pending' USING ERRCODE = 'P0001';
  END IF;

  SELECT r.task_id INTO v_task_id FROM work.run r
    WHERE r.org_id = p_org_id AND r.id = p_run_id;
  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'run_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Task before Run, the order request_cancel (0002:1780) and cancel_operation (0002:1949)
  -- use, so a concurrent user cancel cannot deadlock against this consumer.
  SELECT * INTO v_task FROM work.task
    WHERE id = v_task_id AND org_id = p_org_id FOR UPDATE;
  SELECT * INTO v_run FROM work.run
    WHERE org_id = p_org_id AND id = p_run_id FOR UPDATE;

  -- The deny is the scope authority. Without it the predicate cannot be re-checked, and
  -- cancelling on an unverifiable scope is the fail-open direction this table exists to
  -- prevent, so the intent fails rather than being consumed blind.
  SELECT * INTO v_deny FROM work.access_restriction
    WHERE org_id = p_org_id AND id = p_source_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  -- §6.1's predicate per scope, exactly as each producer applied it. deny.state is
  -- deliberately NOT tested: a released deny still cancels the Runs it already scoped.
  v_in_scope := CASE v_deny.scope
    WHEN 'org' THEN v_run.admission_access_epoch <= v_deny.epoch
    WHEN 'member' THEN v_run.admission_access_epoch <= v_deny.epoch
      AND v_task.owner_subject_id = v_deny.subject_id
    WHEN 'device' THEN EXISTS (
      SELECT 1 FROM work.device_run_binding b
      WHERE b.org_id = p_org_id AND b.run_id = p_run_id AND b.device_id = v_deny.device_id)
    WHEN 'grant' THEN EXISTS (
      SELECT 1 FROM work.device_run_binding b
      WHERE b.org_id = p_org_id AND b.run_id = p_run_id
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(b.grant_set) e
                     WHERE (e ->> 'grant_id')::uuid = v_deny.workspace_grant_id))
    ELSE false
  END;

  IF NOT v_in_scope THEN
    v_outcome := 'out_of_scope';
  ELSIF v_run.state IN ('succeeded', 'failed', 'canceled') THEN
    v_outcome := 'already_terminal';
  ELSIF v_run.state = 'cancel_requested' THEN
    -- Already inside the cancel path (a user cancel, an ops cancel, or another intent for
    -- the same Run). GW15's getter delivers it to the device; a second write would only
    -- bump control_revision and invalidate the revision the device is about to ack.
    v_outcome := 'already_canceling';
  ELSE
    v_outcome := 'cancel_requested';
  END IF;

  IF v_outcome = 'cancel_requested' THEN
    v_reason := work.reason_code(v_intent.reason);
    UPDATE work.run r
      SET state = 'cancel_requested', wait_reason = NULL,
          control_revision = r.control_revision + 1, updated_at = now()
      WHERE r.org_id = p_org_id AND r.id = p_run_id;
    PERFORM work.append_task_event(p_org_id, v_task_id, 'run.cancel_requested',
      jsonb_build_object('run_id', p_run_id, 'reason', v_reason,
        'requested_by', 'governance', 'restriction_id', p_source_event_id));
    -- The same hand-off request_cancel and ops_cancel_run write: the relay turns this into
    -- a Temporal signal for a cloud Run; for a local Run the state change is what the GW15
    -- cancel getter delivers. The consumer sends no frame itself.
    INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
    VALUES (p_org_id, 'run', p_run_id, gen_random_uuid(),
      jsonb_build_object('kind', 'cancel_signal', 'run_id', p_run_id, 'reason', v_reason));
    PERFORM work.append_audit(p_org_id, NULL, 'run.cancel_requested_by_governance',
      'run', p_run_id::text,
      jsonb_build_object('task_id', v_task_id, 'previous_state', v_run.state,
        'restriction_id', p_source_event_id, 'scope', v_deny.scope, 'reason', v_reason));

    -- §6.1: "queued或未dispatch的Operation可确定取消/释放". Only the UNDISPATCHED states are
    -- settled here. A dispatching Operation is left for the device: GW15's cancel downlink
    -- stops it and cancel_ack decides unknown versus canceled from the stop fact, which the
    -- cloud cannot assert. unknown/unresolved stay for reconciliation (§6.1 "保持waiting
    -- (reconcile)"), and cancel_operation early-returns on every settled state anyway.
    FOR v_operation IN
      SELECT o.id FROM work.operation o
      WHERE o.org_id = p_org_id AND o.run_id = p_run_id
        AND o.state IN ('prepared', 'waiting_approval', 'authorized')
      ORDER BY o.created_at
    LOOP
      PERFORM work.cancel_operation(p_org_id, v_operation.id, NULL, v_reason);
      v_canceled := v_canceled + 1;
    END LOOP;
  END IF;

  UPDATE work.cancellation_intent
    SET state = 'consumed', updated_at = now()
    WHERE org_id = p_org_id AND source_event_id = p_source_event_id AND run_id = p_run_id;

  RETURN jsonb_build_object('source_event_id', p_source_event_id, 'run_id', p_run_id,
    'state', 'consumed', 'outcome', v_outcome,
    'cancel_revision', CASE WHEN v_outcome = 'cancel_requested'
                            THEN (v_run.control_revision + 1)::text ELSE NULL END,
    'canceled_operations', v_canceled);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The failure ladder: §6.1's 1s..60s backoff, dead-letter at 10, deny retained.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.fail_cancellation_intent(
  p_org_id text,
  p_source_event_id uuid,
  p_run_id uuid,
  p_retryable boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_intent work.cancellation_intent%ROWTYPE;
  v_attempts integer;
  v_dead boolean;
  v_next timestamptz;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  IF p_retryable IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent FROM work.cancellation_intent
    WHERE org_id = p_org_id AND source_event_id = p_source_event_id AND run_id = p_run_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_intent.state <> 'pending' THEN
    RAISE EXCEPTION 'cancellation_intent_not_pending' USING ERRCODE = 'P0001';
  END IF;

  v_attempts := v_intent.attempts + 1;
  v_dead := (NOT p_retryable) OR v_attempts >= 10;
  IF v_dead THEN
    v_next := now();
  ELSE
    -- 2^(attempts-1) seconds: the first retry is 1s, the ceiling §6.1 asks for is 60s.
    v_next := now() + (LEAST(power(2, v_attempts - 1), 60) * interval '1 second');
  END IF;

  UPDATE work.cancellation_intent
    SET state = CASE WHEN v_dead THEN 'dead_letter' ELSE 'pending' END,
        attempts = v_attempts, next_attempt = v_next, updated_at = now()
    WHERE org_id = p_org_id AND source_event_id = p_source_event_id AND run_id = p_run_id;

  IF v_dead THEN
    -- The alert, on the mark_outbox_failed precedent (0002:2571): an audit row naming the
    -- system actor. The deny is deliberately untouched — §6.1 requires it retained, and
    -- ops may only replay the intent, never force the Run to canceled.
    PERFORM work.append_audit(p_org_id, 'system:work-cancel',
      'cancellation_intent.dead_lettered', 'cancellation_intent', p_source_event_id::text,
      jsonb_build_object('run_id', p_run_id, 'attempts', v_attempts,
        'retryable', p_retryable, 'reason', v_intent.reason));
  END IF;

  RETURN jsonb_build_object('source_event_id', p_source_event_id, 'run_id', p_run_id,
    'state', CASE WHEN v_dead THEN 'dead_letter' ELSE 'pending' END,
    'attempts', v_attempts, 'dead_lettered', v_dead,
    'next_attempt', to_char(v_next AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Ops replay (ruled ①). work_ops only; a settled intent can never be re-opened.
-- ---------------------------------------------------------------------------
CREATE FUNCTION work.requeue_cancellation_dead_letter(
  p_org_id text,
  p_source_event_id uuid,
  p_run_id uuid,
  p_actor_subject_id text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  v_intent work.cancellation_intent%ROWTYPE;
BEGIN
  IF p_org_id IS DISTINCT FROM current_setting('app.org_id', true) THEN
    RAISE EXCEPTION 'org_context_mismatch' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  PERFORM work.assert_session_subject(p_actor_subject_id);
  -- The outbox replay precedent (0002:2619): a replay is an accountable ops act, so it
  -- carries a reason of its own rather than reusing the intent's immutable one.
  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_intent FROM work.cancellation_intent
    WHERE org_id = p_org_id AND source_event_id = p_source_event_id AND run_id = p_run_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_intent.state <> 'dead_letter' THEN
    RAISE EXCEPTION 'cancellation_intent_not_pending' USING ERRCODE = 'P0001';
  END IF;

  UPDATE work.cancellation_intent
    SET state = 'pending', attempts = 0, next_attempt = now(), updated_at = now()
    WHERE org_id = p_org_id AND source_event_id = p_source_event_id AND run_id = p_run_id;
  PERFORM work.append_audit(p_org_id, p_actor_subject_id,
    'cancellation_intent.requeued', 'cancellation_intent', p_source_event_id::text,
    jsonb_build_object('run_id', p_run_id, 'reason', btrim(p_reason),
      'previous_attempts', v_intent.attempts));
END;
$$;

REVOKE ALL ON FUNCTION work.claim_pending_cancellation_intents(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.consume_cancellation_intent(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.fail_cancellation_intent(text, uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.requeue_cancellation_dead_letter(text, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.claim_pending_cancellation_intents(text, integer, integer) TO work_worker;
GRANT EXECUTE ON FUNCTION work.consume_cancellation_intent(text, uuid, uuid) TO work_worker;
GRANT EXECUTE ON FUNCTION work.fail_cancellation_intent(text, uuid, uuid, boolean) TO work_worker;
GRANT EXECUTE ON FUNCTION work.requeue_cancellation_dead_letter(text, uuid, uuid, text, text) TO work_ops;

RESET ROLE;