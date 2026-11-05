-- 0028: give a dead execute lease an exit, so an interrupted model step can be
-- re-driven instead of only being failed.
--
-- Authority: 0009's own comment fixes the rule this increment restores - "registered ->
-- active with a fixed holder and a short lease", with the lease as the proof that no
-- other parent is running the fragment. 0009 then made the expired-lease case terminal
-- for everybody: claim refused a different holder, renew committed the expiry, and
-- register refuses to replace a row whose operation already has a delivery gate
-- (dispatch_gate_exists). The combination has no exit - after one heartbeat gap the
-- execution can never be claimed, re-registered or revived by anything.
--
-- Measured on the pilot host 2026-11-05 (D1-6/D2-4 re-drive injection, run
-- 0fd4f0a8, execution f372c418): the worker stopped 3 seconds into AdvanceRuntime, the
-- activity was reported canceled at 11:35:13, work-node kept heartbeating through the
-- provider exchange (execution_claimed at 11:35:09, capability generations 1..7 to
-- 11:37:09, heartbeat_seq 13) and Temporal started attempt 2 at 11:39:19 - which is
-- #56-A working: 4 minutes, not the 16 minutes measured on 11-04. Attempt 2 then died
-- in the claim: the row was still state='active' with lease_until 11:35:39 (the revoke
-- audit at 11:39:19.965839 carries previous_state='active'), so the second half of the
-- old first IF raised runtime_execution_expired, Node mapped it to lease_not_claimable,
-- and the Run closed as advance_failed. Nothing could have revived that row afterwards.
--
-- One behavior changes: state='active', lease elapsed and a DIFFERENT holder now take
-- over the fragment instead of being refused. Every case that exists today behaves the
-- same - same-holder replay still returns already_claimed, a live lease with a foreign
-- holder still raises runtime_execution_holder_mismatch, the hard deadline still raises
-- runtime_execution_expired, and completed/revoked/expired still raise
-- runtime_execution_not_claimable. The takeover also resets heartbeat_seq, because that
-- counter orders one holder's own heartbeats (renew ignores an equal or lower sequence);
-- without the reset the new holder's renewals 1..13 would be no-ops and the takeover
-- would inherit a 30-second lease it could never extend.
--
-- A takeover cannot buy a second provider call, which is what made #56-A call one retry
-- safe, and it still cannot: consume_dispatch_delivery answers "observed" for any
-- operation that already has a delivery row, before it looks at holder, lease or
-- deadline, and egress.Execute turns a non-won decision into OutcomeNotSent, so nobody
-- but the winner of that INSERT reaches the provider. The takeover is what lets the
-- loser read what the winner left behind: Node returns WAITING_RECONCILE, the Run parks
-- on wait_reason='reconcile', and the workflow's existing finish path resolves the
-- receipt from work.dispatch_delivery plus the content-reference registry. So the durable
-- half of an interrupted step is recoverable; "success is never inferred from a consumed
-- gate" (finishing.ErrReceiptNotAttached) keeps governing it - if the first exchange
-- never attached a receipt, the Run waits for an operator's decision instead of
-- inventing one.
--
-- Two objects change together, because the claim is not the only writer on this row:
-- work.runtime_execution_guard (0009:386-424) refuses ANY holder move
-- (runtime_execution_holder_immutable) and ANY heartbeat_seq decrease
-- (runtime_execution_heartbeat_not_monotonic) below the function, so a takeover UPDATE
-- would abort inside its own statement. Both guards gain exactly one shape - still
-- 'active', the displaced lease genuinely over, the new lease ahead of the one it
-- replaces - and nothing else. The displaced dispatch attempt needs no second check
-- here because the binding block above the holder clause already refuses any change to
-- it; deleting that conjunct was mutation-tested and the suite stays green without it,
-- so it is not written. The gate's own guard is not touched, and that is the point:
-- dispatch_delivery_guard pins holder_id, so the send right stays with whoever won it,
-- and a takeover can never move it. That is the sense in which the
-- orchestration design's "禁止接管旧进程发送权" (work-r0a-orchestration-design-2026-10-25.md:162)
-- is preserved, and its RR-01 row's "一个有效 holder" (:181) still holds: at no instant do two
-- holders both have a lease, because the previous one is refused by the holder check in
-- claim and by the mismatch refusal in renew.
--
-- The direction of this increment is "catch up to a rule already signed", not "loosen one":
-- the same design's background-jobs section :518 fixes the general rule - "租约与接管：所有领取都带
-- 持有者与到期时间；只有租约过期才允许接管；接管不得重复外部副作用" - and :670 verifies that shape
-- for audit export (an elapsed lease lets a new holder finish the job, the old holder gets
-- audit_export_lease_lost). work.runtime_execution was the only claim path in R0a that did not
-- follow it. The runbook's general rule 1 already promised the outcome too
-- ("作业崩溃后由租约到期接管"); runbook §5.23 records that the promise was untrue for this table
-- until now, and how to read a takeover in the audit.
--
-- 0009 is published, so its body is replaced here rather than edited there:
-- manifest.json pins the published checksums and rewriting them would make every
-- already-applied database disagree with its own ledger row. The replacement restates
-- SECURITY DEFINER and the fixed search_path, because CREATE OR REPLACE inherits
-- neither, and restates the ACL because a replacement keeps the old one silently.

SET ROLE work_owner;

-- registered -> active with a holder and a short lease. A replay by the same holder is a
-- query only and must not start a second child process; a live lease held by another
-- parent is refused. An ELAPSED lease held by another parent is taken over - see 0028.
-- Lease and deadline comparisons use the database clock read after the lock.
CREATE OR REPLACE FUNCTION work.claim_runtime_execution(
  p_org_id text,
  p_execution_id uuid,
  p_holder_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = work, pg_catalog
AS $$
DECLARE
  execution_row work.runtime_execution%ROWTYPE;
  run_row work.run%ROWTYPE;
  task_row work.task%ROWTYPE;
  v_now timestamptz;
  v_lease timestamptz;
  v_takeover boolean := false;
BEGIN
  PERFORM work.assert_runtime_context(p_org_id);
  PERFORM work.assert_runtime_identifier('holder_id', p_holder_id);
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime_execution_not_found' USING ERRCODE = 'P0002';
  END IF;
  run_row := work.lock_runtime_run(p_org_id, execution_row.run_id);
  SELECT * INTO task_row FROM work.task t WHERE t.id = run_row.task_id AND t.org_id = p_org_id;
  SELECT * INTO execution_row
  FROM work.runtime_execution e
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id
  FOR UPDATE;
  v_now := clock_timestamp();

  IF execution_row.state IN ('completed', 'revoked', 'expired') THEN
    RAISE EXCEPTION 'runtime_execution_not_claimable' USING ERRCODE = 'P0001',
      DETAIL = execution_row.state;
  END IF;
  -- The takeover arm is the only behavior this increment changes: an elapsed
  -- lease plus a different holder. Read it as a lease, which is what the column
  -- is - proof of an absent parent, not a sentence.
  v_takeover := execution_row.state = 'active'
    AND execution_row.lease_until <= v_now
    AND execution_row.holder_id IS DISTINCT FROM p_holder_id;
  IF execution_row.hard_deadline <= v_now
     OR (execution_row.state = 'active' AND execution_row.lease_until <= v_now
         AND NOT v_takeover) THEN
    -- Refuse only: the elapsed row stays until register_runtime_execution or a
    -- late heartbeat commits the explicit expiry. A same-holder replay of an
    -- elapsed lease lands here too, exactly as before this increment.
    RAISE EXCEPTION 'runtime_execution_expired' USING ERRCODE = 'P0001';
  END IF;
  IF execution_row.state = 'active' AND NOT v_takeover THEN
    IF execution_row.holder_id IS DISTINCT FROM p_holder_id THEN
      RAISE EXCEPTION 'runtime_execution_holder_mismatch' USING ERRCODE = '42501';
    END IF;
    -- Same holder: state query only, never a second fork.
    RETURN 'already_claimed';
  END IF;

  PERFORM work.assert_org_execution_enabled(p_org_id);
  IF task_row.state <> 'open' OR task_row.active_run_id IS DISTINCT FROM run_row.id
     OR run_row.state <> 'active' OR run_row.fence <> execution_row.run_fence THEN
    RAISE EXCEPTION 'run_not_current' USING ERRCODE = 'P0001';
  END IF;
  v_lease := LEAST(v_now + make_interval(secs => work.runtime_lease_seconds()),
                   execution_row.hard_deadline);
  UPDATE work.runtime_execution e
  SET state = 'active', holder_id = p_holder_id, lease_until = v_lease,
      heartbeat_seq = CASE WHEN v_takeover THEN 0 ELSE e.heartbeat_seq END,
      revision = e.revision + 1, updated_at = now()
  WHERE e.execution_id = p_execution_id AND e.org_id = p_org_id;
  IF v_takeover THEN
    -- The previous holder is named so a reader can tell "parent vanished"
    -- apart from "parent refused to heartbeat", and the elapsed lease is kept
    -- because it is the evidence the takeover was allowed at all.
    PERFORM work.append_audit(
      p_org_id, NULL, 'runtime.execution_taken_over', 'runtime_execution', p_execution_id::text,
      jsonb_build_object(
        'holder_id', p_holder_id, 'lease_until', v_lease,
        'previous_holder_id', execution_row.holder_id,
        'previous_lease_until', execution_row.lease_until,
        'previous_heartbeat_seq', execution_row.heartbeat_seq::text,
        'reason', 'lease_elapsed'
      )
    );
  ELSE
    PERFORM work.append_audit(
      p_org_id, NULL, 'runtime.execution_claimed', 'runtime_execution', p_execution_id::text,
      jsonb_build_object('holder_id', p_holder_id, 'lease_until', v_lease)
    );
  END IF;
  RETURN 'claimed';
END;
$$;

-- CREATE OR REPLACE keeps the published ACL, but state it so the next reader does not
-- have to go find 0009:1707 and 0009:1730 to know who may call this.
REVOKE ALL ON FUNCTION work.claim_runtime_execution(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.claim_runtime_execution(text, uuid, text) TO work_worker;

-- The row guard, replaced for the same reason and with the same narrow exception.
-- Triggers runtime_execution_guard / runtime_execution_no_delete are bound by name
-- to this function, so they keep working without being recreated.
CREATE OR REPLACE FUNCTION work.runtime_execution_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.run_fence IS DISTINCT FROM OLD.run_fence
     OR NEW.runtime_version IS DISTINCT FROM OLD.runtime_version
     OR NEW.input_checkpoint_ref IS DISTINCT FROM OLD.input_checkpoint_ref
     OR NEW.input_checkpoint_hash IS DISTINCT FROM OLD.input_checkpoint_hash
     OR NEW.intent_ref IS DISTINCT FROM OLD.intent_ref
     OR NEW.intent_hash IS DISTINCT FROM OLD.intent_hash
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.dispatch_attempt_id IS DISTINCT FROM OLD.dispatch_attempt_id
     OR NEW.hard_deadline IS DISTINCT FROM OLD.hard_deadline THEN
    RAISE EXCEPTION 'runtime_execution_binding_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.holder_id IS NOT NULL AND NEW.holder_id IS DISTINCT FROM OLD.holder_id THEN
    -- Exactly one shape is allowed, and it is the shape claim_runtime_execution
    -- writes when it takes over an elapsed lease: same binding (the block above
    -- already refused any change to org/task/run/mode/fence/runtime_version/
    -- checkpoint/intent/request/operation/dispatch attempt/hard deadline, so the
    -- displaced attempt needs no second check here - dropping that clause was
    -- mutation-tested: the suite stays green without it), still 'active', the
    -- displaced lease genuinely over, and the new lease ahead of the one it
    -- replaces. The comparison is row-to-row rather than against the clock on the
    -- new side because claim computed that value from its own clock_timestamp
    -- under the row lock: a fragment whose hard deadline falls a microsecond ahead
    -- would otherwise be refused by this trigger after a legal claim.
    IF NOT (OLD.state = 'active' AND NEW.state = 'active'
            AND OLD.lease_until IS NOT NULL AND OLD.lease_until <= clock_timestamp()
            AND NEW.lease_until IS NOT NULL AND NEW.lease_until > OLD.lease_until) THEN
      RAISE EXCEPTION 'runtime_execution_holder_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.heartbeat_seq < OLD.heartbeat_seq THEN
    -- heartbeat_seq orders one holder's own heartbeats, so it resets with the
    -- holder and nowhere else: a decrease is legal only as part of the same
    -- takeover shape, and only down to 0.
    IF NOT (OLD.holder_id IS NOT NULL AND NEW.holder_id IS DISTINCT FROM OLD.holder_id
            AND NEW.heartbeat_seq = 0
            AND OLD.state = 'active' AND NEW.state = 'active'
            AND OLD.lease_until IS NOT NULL AND OLD.lease_until <= clock_timestamp()) THEN
      RAISE EXCEPTION 'runtime_execution_heartbeat_not_monotonic' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state IN ('completed', 'revoked', 'expired') THEN
      RAISE EXCEPTION 'runtime_execution_terminal' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'registered' AND NEW.state NOT IN ('active', 'revoked', 'expired') THEN
      RAISE EXCEPTION 'runtime_execution_invalid_transition' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'active' AND NEW.state NOT IN ('completed', 'revoked', 'expired') THEN
      RAISE EXCEPTION 'runtime_execution_invalid_transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

RESET ROLE;
