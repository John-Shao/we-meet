package api_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/testpg"
)

// work.ops_cancel_run is the command a duty engineer runs from a ticket (D-07 A,
// 2026-10-27): revoking a seat or suspending an organization does not cancel the runs
// already in flight, so this is how one gets stopped. It walks the same state machine and
// the same cancel_signal hand-off as work.request_cancel, and deliberately does not
// require the caller to be the task owner - the owner may already have lost rights.
// Nothing guarded it: `grep ops_cancel_run` across the test tree came back empty, so the
// hand-off, the ticket/reason rules and the work_ops-only grant boundary were all unrun.

const (
	opsActor        = "sub_ops"
	opsImpostor     = "sub_other"
	opsTicket       = "OPS-1042"
	opsReason       = "seat_revoked"
	opsForeignRunID = "21111111-1111-4111-8111-444444444444" // run D, org_other
)

// opsCancel calls the duty command over the work_ops login. sessionSubject is what lands
// in app.subject_id and actor is p_actor_subject_id; they only differ in the impersonation
// case, because assert_session_subject compares exactly those two and nothing else - it
// does not check membership, which is why the ticket fields carry the audit weight.
func opsCancel(dbName, sessionSubject, actor, runID, ticket, reason string) error {
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.OpsURL(dbName))
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', true)`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.subject_id', $1, true)`, sessionSubject); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT work.ops_cancel_run($1, $2::uuid, $3, $4, $5)`,
		"org_a", runID, actor, ticket, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// opsScalar reads org_a facts through the owner login, which FORCE RLS puts under the same
// tenant policy as every other role.
func opsScalar(t *testing.T, dbName, query string, args ...any) string {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', false)`); err != nil {
		t.Fatal(err)
	}
	var value string
	if err := conn.QueryRow(ctx, query, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func opsPgError(t *testing.T, err error) *pgconn.PgError {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("error %#v is not a *pgconn.PgError", err)
	}
	return pgErr
}

// opsMakeTerminal drives a run to a terminal state the way the worker's own commands would
// (failed + terminal_reason) so the early-return branch has something real to look at. The
// UPDATE fires run_terminal_event, whose append_task_event is SECURITY DEFINER under forced
// RLS, so the session needs app.org_id or the whole statement aborts.
func opsMakeTerminal(t *testing.T, dbName, runID string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	// One statement per Exec: a parameter forces the extended protocol, which refuses a
	// multi-command string.
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', false)`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		UPDATE work.run
		SET state = 'failed', terminal_reason = 'failed', wait_reason = NULL, updated_at = now()
		WHERE id = $1`, runID); err != nil {
		t.Fatal(err)
	}
}

func TestOpsCancelRunFollowsTheSameHandOff(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	// The caller is not the owner (task A belongs to sub_a) and that is the point: a duty
	// engineer on a ticket has to be able to stop the run.
	if err := opsCancel(dbName, opsActor, opsActor, runA, opsTicket, opsReason); err != nil {
		t.Fatalf("ops cancel: %v", err)
	}

	if got := runState(t, dbName, runA); got != "cancel_requested" {
		t.Fatalf("run state = %q, want cancel_requested", got)
	}
	// The control fence moves exactly like the user command, so a worker lease that races
	// the stop still invalidates. Runs are seeded at control_revision 0.
	if fence := opsScalar(t, dbName,
		`SELECT control_revision::text FROM work.run WHERE id = $1::uuid`, runA); fence != "1" {
		t.Fatalf("control_revision after ops cancel = %s, want 1", fence)
	}
	rows, reason := cancelSignalRows(t, dbName, runA)
	if rows != 1 {
		t.Fatalf("cancel_signal rows = %d, want 1", rows)
	}
	if reason != opsReason {
		t.Fatalf("cancel_signal reason = %q, want %q", reason, opsReason)
	}
	// The timeline has to say who asked, or the owner reads an ops stop as their own
	// cancellation and never files the ticket.
	requestedBy := opsScalar(t, dbName, `
		SELECT payload->>'requested_by' FROM work.task_event
		WHERE task_id = $1::uuid AND type = 'run.cancel_requested'
		ORDER BY seq DESC LIMIT 1`, taskA)
	if requestedBy != "ops" {
		t.Fatalf("task event requested_by = %q, want ops", requestedBy)
	}
	// The audit row is the only place the ticket number survives, and it is what makes a
	// duty stop attributable after the fact.
	audit := opsScalar(t, dbName, `
		SELECT count(*)::text || '/' ||
		       coalesce(max(actor_subject_id), '-') || '/' ||
		       coalesce(max(target_type || ':' || target_id), '-') || '/' ||
		       coalesce(max(metadata->>'ticket_ref'), '-') || '/' ||
		       coalesce(max(metadata->>'previous_state'), '-')
		FROM work.audit_event
		WHERE action = 'run.cancel_requested_by_ops'`)
	if audit != "1/"+opsActor+"/run:"+runA+"/"+opsTicket+"/active" {
		t.Fatalf("ops audit row = %q, want one run audit for %s carrying %s from active",
			audit, opsActor, opsTicket)
	}

	// A second engineer on the same ticket re-runs the command. The run is already
	// cancel_requested, so the state machine must not signal twice or write twice.
	if err := opsCancel(dbName, opsActor, opsActor, runA, "OPS-1043", opsReason); err != nil {
		t.Fatalf("repeat ops cancel: %v", err)
	}
	afterRows, _ := cancelSignalRows(t, dbName, runA)
	if afterRows != 1 {
		t.Fatalf("cancel_signal rows after repeat = %d, want 1", afterRows)
	}
	if afterAudit := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.audit_event
		 WHERE action = 'run.cancel_requested_by_ops'`); afterAudit != "1" {
		t.Fatalf("ops audit rows after repeat = %s, want 1", afterAudit)
	}
	if afterFence := opsScalar(t, dbName,
		`SELECT control_revision::text FROM work.run WHERE id = $1::uuid`, runA); afterFence != "1" {
		t.Fatalf("control_revision after repeat = %s, want still 1", afterFence)
	}
}

func TestOpsCancelRunLeavesATerminalRunAlone(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	opsMakeTerminal(t, dbName, runC)

	if err := opsCancel(dbName, opsActor, opsActor, runC, opsTicket, opsReason); err != nil {
		t.Fatalf("ops cancel on terminal run: %v", err)
	}
	// Silent success is the documented behaviour (a duty engineer retrying a closed ticket
	// must not get an error), but it must not rewrite the outcome or queue a signal for a
	// workflow that is already finished.
	if got := runState(t, dbName, runC); got != "failed" {
		t.Fatalf("terminal run state = %q, want failed", got)
	}
	if rows, _ := cancelSignalRows(t, dbName, runC); rows != 0 {
		t.Fatalf("cancel_signal rows for a terminal run = %d, want 0", rows)
	}
	if audit := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.audit_event
		 WHERE action = 'run.cancel_requested_by_ops'`); audit != "0" {
		t.Fatalf("ops audit rows for a terminal run = %s, want 0", audit)
	}
}

func TestOpsCancelRunRefusesWithoutTheGrant(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	// EXECUTE is granted to work_ops only (baseline/0002:5229). Executing through the
	// application role has to fail on the privilege, not on the arguments, otherwise the
	// boundary is decorative and any authenticated API caller could stop anyone's run.
	err := func() error {
		ctx := context.Background()
		conn, openErr := testpg.Open(ctx, testpg.AppURL(dbName))
		if openErr != nil {
			return openErr
		}
		defer conn.Close(ctx)
		tx, beginErr := conn.Begin(ctx)
		if beginErr != nil {
			return beginErr
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, e := tx.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', true)`); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `SELECT set_config('app.subject_id', $1, true)`, opsActor); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `SELECT work.ops_cancel_run($1, $2::uuid, $3, $4, $5)`,
			"org_a", runA, opsActor, opsTicket, opsReason)
		return e
	}()
	if err == nil {
		t.Fatal("work_api executed the duty command; only work_ops is granted")
	}
	pgErr := opsPgError(t, err)
	// The privilege has to be what stopped it - a refusal on the arguments would leave the
	// grant decorative.
	if pgErr.SQLState() != "42501" || pgErr.Message != "permission denied for function ops_cancel_run" {
		t.Fatalf("app-role refusal = %s %q, want 42501 permission denied",
			pgErr.SQLState(), pgErr.Message)
	}
	if got := runState(t, dbName, runA); got != "active" {
		t.Fatalf("run state after refused call = %q, want untouched", got)
	}
}

func TestOpsCancelRunValidatesTicketAndSession(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	cases := []struct {
		name    string
		session string
		actor   string
		runID   string
		ticket  string
		reason  string
		state   string
		msg     string
	}{
		{"missing ticket", opsActor, opsActor, runA, "", opsReason, "22023", "invalid_request"},
		{"lowercase ticket", opsActor, opsActor, runA, "ops-1042", opsReason, "22023", "invalid_request"},
		{"ticket without a number", opsActor, opsActor, runA, "OPSABC", opsReason, "22023", "invalid_request"},
		{"blank reason", opsActor, opsActor, runA, "OPS-1044", "   ", "22023", "invalid_request"},
		// reason_code only checks the shape (baseline/0002:1272-1279), which is the open
		// #286 question of whether duty reasons are free text or an enum.
		{"free text reason", opsActor, opsActor, runA, "OPS-1045", "user asked nicely", "22023", "invalid_reason_code"},
		{"actor impersonates another session", opsActor, opsImpostor, runA, opsTicket, opsReason, "42501", "actor_mismatch"},
		{"run in another org", opsActor, opsActor, opsForeignRunID, "OPS-1047", opsReason, "P0002", "run_not_found"},
	}
	for _, tc := range cases {
		err := opsCancel(dbName, tc.session, tc.actor, tc.runID, tc.ticket, tc.reason)
		if err == nil {
			t.Fatalf("%s: call succeeded, want %s", tc.name, tc.msg)
		}
		pgErr := opsPgError(t, err)
		if pgErr.SQLState() != tc.state || pgErr.Message != tc.msg {
			t.Fatalf("%s = %s %q, want %s %q", tc.name,
				pgErr.SQLState(), pgErr.Message, tc.state, tc.msg)
		}
	}

	// None of the refusals may leave a hand-off or an audit line behind, and the run the
	// duty engineer was trying to stop is still running.
	if rows, _ := cancelSignalRows(t, dbName, runA); rows != 0 {
		t.Fatalf("cancel_signal rows after refusals = %d, want 0", rows)
	}
	if got := runState(t, dbName, runA); got != "active" {
		t.Fatalf("run state after refusals = %q, want active", got)
	}
	if audit := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.audit_event
		 WHERE action = 'run.cancel_requested_by_ops'`); audit != "0" {
		t.Fatalf("ops audit rows after refusals = %s, want 0", audit)
	}
	if events := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.task_event
		 WHERE task_id = $1::uuid AND type = 'run.cancel_requested'`, taskA); events != "0" {
		t.Fatalf("task events after refusals = %s, want 0", events)
	}
}
