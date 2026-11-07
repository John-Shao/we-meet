-- 0029: a terminal Run must not leave a quota reservation held.
--
-- Authority: 待裁 #76, ruled by the principal signer 2026-11-05 as "release 全额退回" plus
-- "定默认＋记为代码缺口". The default is now written down: a Run that reaches a terminal state
-- while its reservation is still held, and whose operation has no receipt recorded at the
-- delivery gate, gets that reservation released. The ruled trade-off is explicit and is NOT
-- hidden here: releasing closes the door on settling that call later, because release_quota
-- refuses anything that is not 'held' and settle/adjust refuse a released row. That was chosen
-- over leaving money parked indefinitely on an outcome nobody can prove.
--
-- Measured on the pilot host 2026-11-05 (I-1 injection, D3-6): a Run terminalized as
-- failed/finish_receipt_missing while work.quota_reservation still carried state='held'
-- (100,000 tokens) and work.quota_account.reserved_tokens stayed at 100,000. The runstream
-- gauge self-reported BREACH held_on_terminal=1 at 20:36:29 and the unit exited failed.
-- The ledger only became consistent because an operator ran work.release_quota by hand at
-- 21:2x - which is the thing this increment removes from the duty path.
--
-- Why the gap exists at all: the worker's abort path releases (internal/runflow/activities.go:808,
-- :875 - `case "failed","canceled"` -> release_quota), but the *finish* path does not. finish_run
-- was written to protect the money: it refuses 'succeeded' while any operation of the task is
-- prepared|waiting_approval|authorized|dispatching|unknown|unresolved
-- (work.task_has_blocking_operation, baseline/0002:598), yet it terminalizes 'failed' and
-- 'canceled' with no reservation step at all. reconcile_operation does settle-or-release, but only
-- when an operator calls it - and it deliberately leaves 'unresolved' held.
--
-- Shape chosen: a trigger on the run state transition, not a patch inside finish_run. Three paths
-- terminalize a Run today (finish_run, the cancel completion, the supersede path), and the
-- invariant is about the state of the Run, not about which function wrote it. A duty engineer
-- closing a Run by hand gets the same accounting as the worker.
--
-- Boundaries, stated rather than implied:
--   - Only state='held' is touched. 'unknown' reservations are left alone; that state means the
--     amount itself is unsettled and reconcile_operation is the owner of that decision.
--   - An operation whose delivery gate reads gate_state='receipt_recorded' is skipped. A recorded
--     receipt is server-side proof the call happened, so the money is owed and settle is still
--     correct; releasing here would erase a real charge. In this wiring settle normally happens
--     before terminalization, so this branch protects the ordering rather than the common case.
--   - The helper runs with the invoker's privileges (no SECURITY DEFINER) and filters by the run's
--     own org_id. That is enough for every path that can terminalize a Run: finish_run is
--     EXECUTE-granted to work_worker alone (baseline/0002:5221), whose connections set
--     app.org_id, and duty paths connect as a superuser, which is not RLS-filtered. A
--     work_owner connection without app.org_id would see zero rows and release nothing - the
--     silent-empty shape #53 is about - so it is called out here instead of being papered over.
--
-- One behavior changes: terminalizing a Run whose Operation is 'unknown' and whose delivery gate has
-- no recorded receipt now releases that held reservation (state='released', account reserved_tokens
-- decremented, a 'release' row in quota_entry). Everything else behaves exactly as before: no
-- reservation, an already settled or released reservation, a reservation in 'unknown', an Operation
-- in 'unresolved' or any non-unknown state, a receipt-recorded Operation, and non-terminal
-- transitions all leave the rows untouched.
--
-- Scope history, so the next reader does not widen this again by accident: the first draft released on
-- every terminal Run. 待裁 #79 (2026-11-06) narrowed it to 'unknown' after reading the two older signed
-- clauses quoted above - the ruling was B, and A (blanket release) was explicitly not taken.

SET ROLE work_owner;

CREATE OR REPLACE FUNCTION work.release_unreceipted_reservations(
  p_run_id uuid,
  p_org_id text
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_released int := 0;
  v_reservation record;
BEGIN
  FOR v_reservation IN
    SELECT r.id AS reservation_id
    FROM work.quota_reservation r
    JOIN work.operation o
      ON o.id = r.operation_id AND o.org_id = r.org_id
    WHERE o.run_id = p_run_id
      AND o.org_id = p_org_id
      AND r.state = 'held'
      -- #79=B (ruled 2026-11-06): only an Operation whose outcome is unproven gets its money back
      -- automatically. 'unknown' is exactly the shape #76 ruled on. 'unresolved' is left alone because
      -- work-r0a-data-design-2026-10-25.md:279 requires the reservation to be KEPT while usage is being
      -- reconciled, and §5.17 of the runbook says releasing a terminal task's reservation is an operator
      -- decision - both of which a blanket release at terminal would have overwritten.
      AND o.state = 'unknown'
      AND NOT EXISTS (
        SELECT 1
        FROM work.dispatch_delivery d
        WHERE d.org_id = r.org_id
          AND d.operation_id = r.operation_id
          AND d.gate_state = 'receipt_recorded'
      )
    ORDER BY r.operation_id, r.reservation_seq
  LOOP
    -- release_quota takes its own row lock and writes the account decrement plus the
    -- 'release' entry; calling it keeps this increment from re-implementing the money path.
    PERFORM work.release_quota(v_reservation.reservation_id);
    v_released := v_released + 1;
  END LOOP;
  RETURN v_released;
END;
$$;

CREATE OR REPLACE FUNCTION work.run_terminal_reservation_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state NOT IN ('succeeded', 'failed', 'canceled') THEN
    PERFORM work.release_unreceipted_reservations(NEW.id, NEW.org_id);
  END IF;
  RETURN NULL;
END;
$$;

-- AFTER UPDATE OF state, so the Run row is already terminal when the money moves: a release
-- failing here aborts the terminalization with it, rather than leaving a terminal Run whose
-- reservation outlived the transaction that closed it.
CREATE TRIGGER run_terminal_reservation_release
  AFTER UPDATE OF state ON work.run
  FOR EACH ROW
  WHEN (NEW.state IN ('succeeded', 'failed', 'canceled'))
  EXECUTE FUNCTION work.run_terminal_reservation_release();

GRANT EXECUTE ON FUNCTION work.release_unreceipted_reservations(uuid, text) TO work_worker;
GRANT EXECUTE ON FUNCTION work.run_terminal_reservation_release() TO work_worker;

-- 2026-11-06: without these two lines the live-PG guard internal/api TestNoWorkFunctionIsCallableThroughPublic
-- goes red. PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and the baseline's
-- definer/ACL assembly loop only walks the signatures it knows about - so a fresh function is callable by
-- every login role until it is revoked. The trigger needs work_worker alone (finish_run is granted to that
-- role only), and the helper no wider.
REVOKE ALL ON FUNCTION work.release_unreceipted_reservations(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work.run_terminal_reservation_release() FROM PUBLIC;
