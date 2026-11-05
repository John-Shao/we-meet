package authz_test

import (
	"testing"

	"github.com/jackc/pgx/v5"
)

// These cases exercise increment 0029 against a real PostgreSQL instance. Scope is the one 待裁 #79
// ruled (B): terminalizing a Run releases a held reservation ONLY when its Operation is 'unknown' and
// the delivery gate has no recorded receipt. Everything else keeps the money where it is, because
// work-r0a-data-design-2026-10-25.md:279 requires a reservation to be kept while usage is being
// reconciled, and runbook §5.17 says releasing a terminal task's reservation is an operator decision.
//
// The production reading being reproduced is the pilot host's D3-6 on 2026-11-05: a Run closed as
// failed/finish_receipt_missing while its reservation still carried 100,000 held tokens with
// operation=unknown, and the runstream gauge self-reported BREACH held_on_terminal=1. The ledger only
// balanced because an operator ran work.release_quota by hand at 21:2x.
//
// Writes go through the work_worker login because that is the only role finish_run and reserve_quota
// are EXECUTE-granted to (baseline/0002:5218-5221): grants, the tenant context and the RAISE texts stay
// part of the assertion instead of being bypassed by a superuser. Admin connections are for fixtures
// and reads, never for the release itself.

type terminalReservation struct {
	id       string
	state    string
	amount   int64
	reserved int64
}

func terminalSetup(t *testing.T, admin *pgx.Conn, org string) *authzExecRun {
	t.Helper()
	run := seedAuthzExecRun(t, admin, org, repeatChar('1', 64))
	// reserve_quota refuses with org_policy_missing before it looks at anything else, and its
	// run-cap check is cumulative over the run, so the cap has to clear the amounts below.
	tag, err := admin.Exec(testContext(t), `
		INSERT INTO work.org_policy (org_id, run_cap_tokens)
		VALUES ($1, 1000000)
		ON CONFLICT (org_id) DO UPDATE SET run_cap_tokens = EXCLUDED.run_cap_tokens`, org)
	if err != nil {
		t.Fatalf("seed org_policy for %s: %v", org, err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("org_policy affected %d rows, want 1", tag.RowsAffected())
	}
	return run
}

// terminalReserveAndExecute puts the run into the shape production reaches: an operation with a
// reservation, a committed plan head and a registered execute fragment. The reservation amount is
// whatever registerAuthzExecute books (1000); asserting on a literal would only test the fixture.
func terminalReserveAndExecute(t *testing.T, dbName, org string, admin *pgx.Conn) (*authzExecRun, *pgx.Conn) {
	t.Helper()
	run := terminalSetup(t, admin, org)
	worker := authzExecWorker(t, dbName, org)
	prepareAuthzExecute(t, worker, run)
	return run, worker
}

// terminalOperationState walks the operation into the state a case is about. It insists on exactly one
// row: after #79=B the Operation's state is the single variable that decides whether the money comes
// back, so a fixture write that landed on nothing would silently turn a release case into a refusal
// case, or the other way round.
func terminalOperationState(t *testing.T, admin *pgx.Conn, opID, state string) {
	t.Helper()
	tag, err := admin.Exec(testContext(t),
		`UPDATE work.operation SET state = $2 WHERE id = $1`, opID, state)
	if err != nil {
		t.Fatalf("set operation %s state=%s: %v", opID, state, err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("setting operation state=%s affected %d rows, want 1", state, tag.RowsAffected())
	}
	var got string
	if err := admin.QueryRow(testContext(t),
		`SELECT state FROM work.operation WHERE id = $1`, opID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != state {
		t.Fatalf("operation state read back as %q, want %q", got, state)
	}
}

func terminalReadForOperation(t *testing.T, admin *pgx.Conn, opID string) terminalReservation {
	t.Helper()
	var res terminalReservation
	err := admin.QueryRow(testContext(t), `
		SELECT r.id::text, r.state, r.amount_tokens, a.reserved_tokens
		FROM work.quota_reservation r
		JOIN work.quota_account a ON a.id = r.account_id AND a.org_id = r.org_id
		WHERE r.operation_id = $1
		ORDER BY r.reservation_seq DESC
		LIMIT 1`, opID).Scan(&res.id, &res.state, &res.amount, &res.reserved)
	if err != nil {
		t.Fatalf("read reservation for operation %s: %v", opID, err)
	}
	return res
}

func terminalReleaseEntries(t *testing.T, admin *pgx.Conn, reservationID string) int {
	t.Helper()
	var count int
	err := admin.QueryRow(testContext(t), `
		SELECT count(*) FROM work.quota_entry
		WHERE reservation_id = $1 AND kind = 'release'`, reservationID).Scan(&count)
	if err != nil {
		t.Fatalf("count release entries: %v", err)
	}
	return count
}

func terminalFinish(t *testing.T, worker *pgx.Conn, run *authzExecRun, outcome string, reason any) {
	t.Helper()
	if _, err := worker.Exec(testContext(t),
		`SELECT work.finish_run($1, $2, $3, $4)`, run.runID, run.org, outcome, reason); err != nil {
		t.Fatalf("finish_run(%s/%v): %v", outcome, reason, err)
	}
}

// terminalWriteOne runs a fixture write and insists it landed: a 0-row UPDATE here would turn a
// refusal case into a silent pass on the wrong branch.
func terminalWriteOne(t *testing.T, conn *pgx.Conn, sql string, args ...any) {
	t.Helper()
	tag, err := conn.Exec(testContext(t), sql, args...)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("fixture write affected %d rows, want 1: %s", tag.RowsAffected(), sql)
	}
}

// terminalRecordReceipt writes the delivery-gate row in the shape the receipt CHECK demands. The
// execution row already exists (registerAuthzExecute created it), so the FK holds; going through
// consume/attach would exercise the gate, which is not what this increment is about.
func terminalRecordReceipt(t *testing.T, admin *pgx.Conn, run *authzExecRun) {
	t.Helper()
	terminalWriteOne(t, admin, `
		INSERT INTO work.dispatch_delivery (
			org_id, operation_id, gate_state, execution_id, holder_id, attempt_id,
			request_hash, receipt_slot_id, receipt_ref, receipt_hash, receipt_result,
			consumed_at, receipt_recorded_at)
		VALUES ($1, $2, 'receipt_recorded', $3, $4, $5::uuid, $6,
			gen_random_uuid(), 'receipt/terminal/1', $7, 'success', now(), now())`,
		run.org, run.opID, run.execExec, run.holder, run.attempt, run.requestHash,
		authzExecHash(t, "9"))
}

func repeatChar(c rune, n int) string {
	out := make([]rune, n)
	for i := range out {
		out[i] = c
	}
	return string(out)
}

// TestTerminalRunReleasesUnreceiptedReservation is the leak #77, closed inside the #79=B scope.
func TestTerminalRunReleasesUnreceiptedReservation(t *testing.T) {
	dbName, admin, _ := newAuthzExecDB(t)
	org := "org_terminal_release"
	run, worker := terminalReserveAndExecute(t, dbName, org, admin)

	before := terminalReadForOperation(t, admin, run.opID)
	if before.state != "held" || before.reserved != before.amount {
		t.Fatalf("before finish: state=%s reserved=%d amount=%d, want held and reserved==amount",
			before.state, before.reserved, before.amount)
	}
	// The ruled shape is operation='unknown' plus no receipt. Without this write the case would be
	// proving the wrong branch: 'unknown' is the only state that gets money back automatically.
	terminalOperationState(t, admin, run.opID, "unknown")

	terminalFinish(t, worker, run, "failed", "finish_receipt_missing")

	after := terminalReadForOperation(t, admin, run.opID)
	if after.state != "released" {
		t.Fatalf("after finish: reservation state=%s, want released - this is the held-on-terminal leak 0029 removes", after.state)
	}
	if after.reserved != 0 {
		t.Fatalf("after finish: account reserved_tokens=%d, want 0", after.reserved)
	}
	if got := terminalReleaseEntries(t, admin, before.id); got != 1 {
		t.Fatalf("release entries=%d, want exactly 1", got)
	}
	var runState string
	if err := admin.QueryRow(testContext(t),
		`SELECT state FROM work.run WHERE id = $1`, run.runID).Scan(&runState); err != nil {
		t.Fatal(err)
	}
	if runState != "failed" {
		t.Fatalf("run state=%s, want failed", runState)
	}

	// Idempotence, two shapes: re-terminalizing with the same outcome, and calling the helper
	// directly. A second release would either double-decrement reserved_tokens or abort on
	// release_quota's 'only_held_reservations_can_be_released' guard - neither is acceptable in a
	// trigger that fires inside whoever's transaction closes the run.
	terminalFinish(t, worker, run, "failed", "finish_receipt_missing")
	var released int
	if err := admin.QueryRow(testContext(t),
		`SELECT work.release_unreceipted_reservations($1, $2)`, run.runID, run.org).Scan(&released); err != nil {
		t.Fatalf("direct helper call: %v", err)
	}
	if released != 0 {
		t.Fatalf("helper released %d on an already released reservation, want 0", released)
	}
	if got := terminalReleaseEntries(t, admin, before.id); got != 1 {
		t.Fatalf("release entries after re-drive=%d, want still 1", got)
	}
	if again := terminalReadForOperation(t, admin, run.opID); again.reserved != 0 {
		t.Fatalf("reserved_tokens after re-drive=%d, want still 0", again.reserved)
	}
}

// TestTerminalRunKeepsReceiptRecordedReservation is the first negative control. Both guards now point
// at the same row, so the case forces operation='unknown' and lets ONLY the recorded receipt protect
// the money - otherwise it would pass on the state condition and prove nothing about the receipt.
func TestTerminalRunKeepsReceiptRecordedReservation(t *testing.T) {
	dbName, admin, _ := newAuthzExecDB(t)
	org := "org_terminal_receipted"
	run, worker := terminalReserveAndExecute(t, dbName, org, admin)

	before := terminalReadForOperation(t, admin, run.opID)
	terminalRecordReceipt(t, admin, run)
	terminalOperationState(t, admin, run.opID, "unknown")

	terminalFinish(t, worker, run, "failed", "advance_failed")

	after := terminalReadForOperation(t, admin, run.opID)
	if after.state != "held" || after.reserved != before.amount {
		t.Fatalf("receipt-recorded operation: state=%s reserved=%d, want still held/%d",
			after.state, after.reserved, before.amount)
	}
	if got := terminalReleaseEntries(t, admin, before.id); got != 0 {
		t.Fatalf("release entries=%d, want 0 for a receipted operation", got)
	}
}

// TestTerminalRunKeepsReservationForNonUnknownOperation is the half #79=B exists for: only an
// Operation whose outcome is unproven gets its money back automatically. data-design :279 says a
// reservation stays while usage is being reconciled and §5.17 says releasing a terminal task's
// reservation is an operator decision, so any other operation state must leave the row alone.
//
// This uses the operation's real post-claim state ('dispatching') rather than 'unresolved': an
// earlier draft tried to force 'unresolved' with a fixture UPDATE and the Operation state machine
// refused it (ERROR invalid_transition:operation:dispatching->unresolved, SQLSTATE 23514) - that
// state is only reachable through reconcile_operation, and faking it here would have tested a
// shape production cannot hold.
func TestTerminalRunKeepsReservationForNonUnknownOperation(t *testing.T) {
	dbName, admin, _ := newAuthzExecDB(t)
	org := "org_terminal_nonunknown"
	run, worker := terminalReserveAndExecute(t, dbName, org, admin)

	before := terminalReadForOperation(t, admin, run.opID)
	var opState string
	if err := admin.QueryRow(testContext(t),
		`SELECT state FROM work.operation WHERE id = $1`, run.opID).Scan(&opState); err != nil {
		t.Fatal(err)
	}
	if opState == "unknown" {
		t.Fatalf("fixture landed on operation state %q, want a non-unknown state for this control", opState)
	}

	terminalFinish(t, worker, run, "failed", "finish_receipt_missing")

	after := terminalReadForOperation(t, admin, run.opID)
	if after.state != "held" || after.reserved != before.amount {
		t.Fatalf("operation=%s: reservation=%s reserved=%d, want still held/%d (only 'unknown' releases)",
			opState, after.state, after.reserved, before.amount)
	}
	if got := terminalReleaseEntries(t, admin, before.id); got != 0 {
		t.Fatalf("release entries=%d for operation state %q, want 0", got, opState)
	}
}

// TestTerminalRunLeavesUnknownReservationAlone pins the remaining boundary: a reservation in
// 'unknown' means the amount itself is unproven and reconcile_operation owns that decision, so the
// trigger must not quietly convert it into a release even when the operation is 'unknown'.
func TestTerminalRunLeavesUnknownReservationAlone(t *testing.T) {
	dbName, admin, _ := newAuthzExecDB(t)
	org := "org_terminal_unknown"
	run, worker := terminalReserveAndExecute(t, dbName, org, admin)

	before := terminalReadForOperation(t, admin, run.opID)
	terminalWriteOne(t, admin,
		`UPDATE work.quota_reservation SET state = 'unknown' WHERE id = $1`, before.id)
	terminalOperationState(t, admin, run.opID, "unknown")

	// The run has to walk the legal edge: active -> canceled is refused by the state machine
	// (this fixture first hit ERROR invalid_transition:run:active->canceled, SQLSTATE 23514),
	// so the cancel request lands before the terminalization.
	terminalWriteOne(t, admin, `
		UPDATE work.run SET state = 'cancel_requested',
		    control_revision = control_revision + 1, updated_at = now()
		WHERE id = $1 AND org_id = $2`, run.runID, org)
	terminalFinish(t, worker, run, "canceled", nil)

	if after := terminalReadForOperation(t, admin, run.opID); after.state != "unknown" {
		t.Fatalf("reservation state=%s, want still unknown (reconcile_operation owns that row)", after.state)
	}
}

// TestNonTerminalTransitionReleasesNothing checks the WHEN clause: waiting is not terminal, and a
// Run that parks mid-flight must keep its reservation - otherwise #60=B's waiting semantics would
// silently give the quota back while the work is still running.
func TestNonTerminalTransitionReleasesNothing(t *testing.T) {
	dbName, admin, _ := newAuthzExecDB(t)
	org := "org_terminal_waiting"
	run, _ := terminalReserveAndExecute(t, dbName, org, admin)

	before := terminalReadForOperation(t, admin, run.opID)
	terminalOperationState(t, admin, run.opID, "unknown")
	terminalWriteOne(t, admin, `
		UPDATE work.run SET state = 'waiting', wait_reason = 'reconcile', updated_at = now()
		WHERE id = $1 AND org_id = $2`, run.runID, org)

	after := terminalReadForOperation(t, admin, run.opID)
	if after.state != "held" || after.reserved != before.amount {
		t.Fatalf("after active -> waiting: state=%s reserved=%d, want held/%d",
			after.state, after.reserved, before.amount)
	}
}
