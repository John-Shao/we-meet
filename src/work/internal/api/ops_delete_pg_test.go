package api_test

import (
	"context"
	"testing"

	"github.com/we-meet/work/internal/testpg"
)

// work.ops_delete_task is the other duty command (legal hold release, org exit, leaver
// cleanup) and, like work.ops_cancel_run, it is granted to work_ops only. It hands the work
// to delete_task_core with p_required_owner and p_expected_revision NULL: a duty engineer
// deletes a task they do not own, without knowing its revision, because the owner may
// already have lost rights.
//
// The producer side of that command was also unrun. Every content_shred test up to now
// hand-inserts the outbox payload (relay/relay_test.go:232, relay/lease_crash_test.go:213),
// so nothing checked that a delete actually enqueues the references the shredder consumes -
// the same vacuous-seed class that D3-N01 was rewritten for.

const (
	opsInputB     = "31111111-1111-4111-8111-222222222222" // task B's input, content://b
	opsContentRef = "content://b"
)

// opsDelete runs the duty delete and returns how many content references it queued.
// sessionSubject and actor are separate for the same reason as the cancel command.
func opsDelete(dbName, sessionSubject, actor, taskID, ticket, reason string) (int, error) {
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.OpsURL(dbName))
	if err != nil {
		return 0, err
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', true)`); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.subject_id', $1, true)`, sessionSubject); err != nil {
		return 0, err
	}
	var refs int
	if err := tx.QueryRow(ctx, `SELECT work.ops_delete_task($1, $2::uuid, $3, $4, $5)`,
		"org_a", taskID, actor, ticket, reason).Scan(&refs); err != nil {
		return 0, err
	}
	return refs, tx.Commit(ctx)
}

// bindInput reproduces what create_task does to the input row (baseline/0002:1595-1597).
// The seed helper leaves task_id NULL, and delete_task_core only shreds references whose
// input is bound to the task, so an unbound seed silently tests the no-refs path.
func bindInput(t *testing.T, dbName, inputID, taskID string) {
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
	if _, err := conn.Exec(ctx, `UPDATE work.input_object SET task_id = $2::uuid WHERE id = $1::uuid`,
		inputID, taskID); err != nil {
		t.Fatal(err)
	}
}

// shredHandoff reads the content_shred row a delete produced: the aggregate it points at and
// the exact reference list, which must be references only - never titles or body text.
func shredHandoff(t *testing.T, dbName, taskID string) (int, string) {
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
	var rows int
	var refs string
	if err := conn.QueryRow(ctx, `
		SELECT count(*), coalesce(max(payload->>'content_refs'), '[]')
		FROM work.outbox
		WHERE payload->>'kind' = 'content_shred' AND aggregate_type = 'content'
		  AND aggregate_id = $1::uuid`, taskID,
	).Scan(&rows, &refs); err != nil {
		t.Fatal(err)
	}
	return rows, refs
}

func TestOpsDeleteTaskTombstonesAndQueuesTheShred(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	bindInput(t, dbName, opsInputB, taskB)

	// Task B belongs to sub_a and sits at revision 0. The duty command checks neither, so a
	// single call has to produce the whole cleanup chain.
	refs, err := opsDelete(dbName, opsActor, opsActor, taskB, opsTicket, opsReason)
	if err != nil {
		t.Fatalf("ops delete: %v", err)
	}
	if refs != 1 {
		t.Fatalf("shredded references = %d, want 1", refs)
	}

	state := opsScalar(t, dbName, `
		SELECT count(*)::text || '/' ||
		       coalesce((max(deleted_at) IS NOT NULL)::text, '-') || '/' ||
		       coalesce(max(title), '-') || '/' ||
		       coalesce(max(revision)::text, '-')
		FROM work.task WHERE id = $1::uuid`, taskB)
	if state != "1/true/[deleted]/1" {
		t.Fatalf("task after ops delete = %q, want one tombstoned row titled [deleted] at revision 1", state)
	}
	input := opsScalar(t, dbName, `
		SELECT status || '/' || (deleted_at IS NOT NULL)::text
		FROM work.input_object WHERE id = $1::uuid`, opsInputB)
	if input != "deleted/true" {
		t.Fatalf("input after ops delete = %q, want deleted with deleted_at set", input)
	}

	rows, payload := shredHandoff(t, dbName, taskB)
	if rows != 1 {
		t.Fatalf("content_shred rows = %d, want 1", rows)
	}
	if payload != `["`+opsContentRef+`"]` {
		t.Fatalf("content_shred refs = %s, want only the deleted task's own reference", payload)
	}

	// The audit row is the only place that ties the deletion to a ticket, and it has to show
	// both who acted and whose task it was.
	audit := opsScalar(t, dbName, `
		SELECT count(*)::text || '/' ||
		       coalesce(max(actor_subject_id), '-') || '/' ||
		       coalesce(max(target_type || ':' || target_id), '-') || '/' ||
		       coalesce(max(metadata->>'reason'), '-') || '/' ||
		       coalesce(max(metadata->>'owner_subject_id'), '-') || '/' ||
		       coalesce(max(metadata->>'content_refs'), '-')
		FROM work.audit_event WHERE action = 'task.deleted_by_ops'`)
	if audit != "1/"+opsActor+"/task:"+taskB+"/"+opsTicket+": "+opsReason+"/sub_a/1" {
		t.Fatalf("ops delete audit = %q, want one ticket-scoped audit naming sub_ops, sub_a and 1 ref", audit)
	}

	// A second engineer on the same ticket: already tombstoned, so the core returns 0 and
	// must not queue a second shred or a second audit line.
	secondRefs, err := opsDelete(dbName, opsActor, opsActor, taskB, "OPS-1048", opsReason)
	if err != nil {
		t.Fatalf("repeat ops delete: %v", err)
	}
	if secondRefs != 0 {
		t.Fatalf("repeat shredded references = %d, want 0", secondRefs)
	}
	if afterRows, afterPayload := shredHandoff(t, dbName, taskB); afterRows != 1 || afterPayload != payload {
		t.Fatalf("shred after repeat = %d rows %s, want still 1 row %s", afterRows, afterPayload, payload)
	}
	if afterAudit := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.audit_event WHERE action = 'task.deleted_by_ops'`); afterAudit != "1" {
		t.Fatalf("ops delete audit rows after repeat = %s, want 1", afterAudit)
	}
}

func TestOpsDeleteTaskRefusesActiveRunForeignTaskAndBadTicket(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	cases := []struct {
		name    string
		session string
		actor   string
		taskID  string
		ticket  string
		reason  string
		state   string
		msg     string
	}{
		// Task C has an active run: duty deletion still waits for quiescence, otherwise the
		// tombstone would hide a run that is still writing artifacts.
		{"running task", opsActor, opsActor, taskC, "OPS-1049", opsReason, "P0001", "run_not_quiescent"},
		{"other org", opsActor, opsActor, taskD, "OPS-1050", opsReason, "P0002", "task_not_found"},
		{"missing ticket", opsActor, opsActor, taskB, "", opsReason, "22023", "invalid_request"},
		{"lowercase ticket", opsActor, opsActor, taskB, "ops-1051", opsReason, "22023", "invalid_request"},
		{"blank reason", opsActor, opsActor, taskB, "OPS-1052", "  ", "22023", "invalid_request"},
		{"impersonated session", opsActor, opsImpostor, taskB, "OPS-1053", opsReason, "42501", "actor_mismatch"},
	}
	for _, tc := range cases {
		if _, err := opsDelete(dbName, tc.session, tc.actor, tc.taskID, tc.ticket, tc.reason); err == nil {
			t.Fatalf("%s: call succeeded, want %s", tc.name, tc.msg)
		} else if pgErr := opsPgError(t, err); pgErr.SQLState() != tc.state || pgErr.Message != tc.msg {
			t.Fatalf("%s = %s %q, want %s %q", tc.name,
				pgErr.SQLState(), pgErr.Message, tc.state, tc.msg)
		}
	}

	for _, taskID := range []string{taskB, taskC} {
		live := opsScalar(t, dbName,
			`SELECT (deleted_at IS NOT NULL)::text FROM work.task WHERE id = $1::uuid`, taskID)
		if live != "false" {
			t.Fatalf("task %s deleted after refusals = %s, want false", taskID, live)
		}
		if rows, _ := shredHandoff(t, dbName, taskID); rows != 0 {
			t.Fatalf("content_shred rows for %s after refusals = %d, want 0", taskID, rows)
		}
	}
	if audit := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.audit_event WHERE action = 'task.deleted_by_ops'`); audit != "0" {
		t.Fatalf("ops delete audit rows after refusals = %s, want 0", audit)
	}
}

func TestOpsDeleteTaskRefusesWithoutTheGrant(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

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
		var refs int
		return tx.QueryRow(ctx, `SELECT work.ops_delete_task($1, $2::uuid, $3, $4, $5)`,
			"org_a", taskB, opsActor, opsTicket, opsReason).Scan(&refs)
	}()
	if err == nil {
		t.Fatal("work_api executed the duty delete; only work_ops is granted")
	}
	pgErr := opsPgError(t, err)
	if pgErr.SQLState() != "42501" ||
		pgErr.Message != "permission denied for function ops_delete_task" {
		t.Fatalf("app-role refusal = %s %q, want permission denied for function ops_delete_task",
			pgErr.SQLState(), pgErr.Message)
	}
	if rows, _ := shredHandoff(t, dbName, taskB); rows != 0 {
		t.Fatalf("content_shred rows after refused call = %d, want 0", rows)
	}
}
