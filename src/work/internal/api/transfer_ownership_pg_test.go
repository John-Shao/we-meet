package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

// work.transfer_task_ownership is the third duty command (the pilot's hand-over for a
// leaver or a moved seat) and, like the two cancellation and deletion commands, it has no
// Go entry point at all: `grep transfer_task_ownership` in the test tree returned nothing.
// Its comment states the two rules that are easy to get wrong and impossible to see from a
// unit test of the API: the new owner must be an active, seated, non-viewer member of the
// same organization, and the transfer copies no grants - the previous owner loses access at
// the same statement.
//
// The access half is asserted through the read endpoint rather than only through the column,
// because "owner_subject_id changed" is compatible with a read model that still shows the
// old owner the task.

const (
	transferTarget = "sub_target"
	transferViewer = "sub_viewer"
	transferNoSeat = "sub_noseat"
	transferLeft   = "sub_left"
	transferTicket = "OPS-3001"
	transferReason = "leaver_handover"
)

func seedTransferMembers(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES
		  ('org_a', '` + transferTarget + `', 'active', 'member', true),
		  ('org_a', '` + transferViewer + `', 'active', 'viewer', true),
		  ('org_a', '` + transferNoSeat + `', 'active', 'member', false),
		  ('org_a', '` + transferLeft + `', 'suspended', 'member', true);
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

// opsTransfer returns the revision the command reports, so the optimistic-concurrency
// contract of the follow-up reads can be asserted without guessing.
func opsTransfer(dbName, sessionSubject, actor, taskID, newOwner, ticket, reason string) (int64, error) {
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
	var revision int64
	if err := tx.QueryRow(ctx,
		`SELECT work.transfer_task_ownership($1, $2::uuid, $3, $4, $5, $6)`,
		"org_a", taskID, newOwner, actor, ticket, reason).Scan(&revision); err != nil {
		return 0, err
	}
	return revision, tx.Commit(ctx)
}

func taskOwnerFacts(t *testing.T, dbName, taskID string) string {
	t.Helper()
	return opsScalar(t, dbName, `
		SELECT owner_subject_id || '/' || revision::text FROM work.task WHERE id = $1::uuid`, taskID)
}

// listedTaskIDs asks the read model which tasks a subject can see, which is where a
// transfer that "copies no grants" either holds or does not.
func listedTaskIDs(t *testing.T, pool *pgxpool.Pool, claims host.Claims) []string {
	t.Helper()
	server := newHTTPServer(t, pool, &stubVerifier{claims: claims}, testCSRF(t))
	items := getTasks(t, server.URL, "?limit=10").Items
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.TaskID)
	}
	return ids
}

func listsTask(ids []string, taskID string) bool {
	for _, id := range ids {
		if id == taskID {
			return true
		}
	}
	return false
}

// readTaskDetail opens a session for one subject and asks for one task by id.
func readTaskDetail(t *testing.T, pool *pgxpool.Pool, claims host.Claims, taskID string) *http.Response {
	t.Helper()
	server := newHTTPServer(t, pool, &stubVerifier{claims: claims}, testCSRF(t))
	request, err := http.NewRequest(http.MethodGet,
		server.URL+"/work/v1/tasks/"+taskID, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func claimsFor(subject string) host.Claims {
	return host.Claims{
		SubjectID:       subject,
		OrgID:           testOrg,
		SessionRevision: 4,
		VerifiedAt:      time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC),
	}
}

func TestOpsTransferOwnershipFlipsBothSidesOfAccess(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	seedTransferMembers(t, dbName)

	// Task B belongs to sub_a and has no run, so the quiescence rule is satisfied. The
	// caller is not the owner and not a member at all: a duty engineer on a ticket.
	revision, err := opsTransfer(dbName, opsActor, opsActor, taskB, transferTarget,
		transferTicket, transferReason)
	if err != nil {
		t.Fatalf("duty transfer: %v", err)
	}
	if revision != 1 {
		t.Fatalf("transfer returned revision %d, want 0+1", revision)
	}
	if got := taskOwnerFacts(t, dbName, taskB); got != transferTarget+"/1" {
		t.Fatalf("task owner after transfer = %q, want %s at revision 1", got, transferTarget)
	}

	// The timeline has to record that the owner field changed, or the new owner's first
	// event is a task they never created.
	fields := opsScalar(t, dbName, `
		SELECT payload->'fields'::text FROM work.task_event
		WHERE task_id = $1::uuid AND type = 'task.owner_changed' ORDER BY seq DESC LIMIT 1`, taskB)
	if fields != `["owner"]` {
		t.Fatalf("owner_changed event fields = %s, want only owner", fields)
	}
	audit := opsScalar(t, dbName, `
		SELECT count(*)::text || '/' ||
		       coalesce(max(actor_subject_id), '-') || '/' ||
		       coalesce(max(metadata->>'from'), '-') || '/' ||
		       coalesce(max(metadata->>'to'), '-') || '/' ||
		       coalesce(max(metadata->>'ticket_ref'), '-') || '/' ||
		       coalesce(max(metadata->>'reason'), '-')
		FROM work.audit_event WHERE action = 'task.ownership_transferred'`)
	if audit != "1/"+opsActor+"/sub_a/"+transferTarget+"/"+transferTicket+"/"+transferReason {
		t.Fatalf("transfer audit = %q, want one row from sub_a to %s carrying %s",
			audit, transferTarget, transferTicket)
	}

	// Both halves of "copies no grants", asserted where a user would feel it: the former
	// owner's list loses the task and its detail answer is the same 404 as for a task that
	// never existed, while the new owner's list gains it in the same breath.
	former := readTaskDetail(t, pool, claimsFor(testSubject), taskB)
	assertAPICode(t, former, http.StatusNotFound, "task_not_found")
	if ids := listedTaskIDs(t, pool, claimsFor(testSubject)); listsTask(ids, taskB) {
		t.Fatalf("former owner still lists the transferred task: %v", ids)
	}
	ids := listedTaskIDs(t, pool, claimsFor(transferTarget))
	if !listsTask(ids, taskB) {
		t.Fatalf("new owner does not list the task, want %s in %v", taskB, ids)
	}

	// Re-running the command for the subject who already owns it is a no-op that answers
	// with the current revision: no second event, no second audit, no third revision.
	again, err := opsTransfer(dbName, opsActor, opsActor, taskB, transferTarget,
		"OPS-3002", transferReason)
	if err != nil {
		t.Fatalf("repeat transfer to the same owner: %v", err)
	}
	if again != 1 {
		t.Fatalf("repeat transfer returned revision %d, want the current 1", again)
	}
	if got := taskOwnerFacts(t, dbName, taskB); got != transferTarget+"/1" {
		t.Fatalf("task after repeat = %q, want unchanged", got)
	}
	if count := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.audit_event WHERE action = 'task.ownership_transferred'`); count != "1" {
		t.Fatalf("transfer audit rows after repeat = %s, want 1", count)
	}
	if count := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.task_event WHERE task_id = $1::uuid AND type = 'task.owner_changed'`,
		taskB); count != "1" {
		t.Fatalf("owner_changed events after repeat = %s, want 1", count)
	}
}

func TestOpsTransferOwnershipRefusesUnqualifiedMembersAndBusyTasks(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	seedTransferMembers(t, dbName)

	cases := []struct {
		name     string
		taskID   string
		newOwner string
		actor    string
		ticket   string
		state    string
		msg      string
	}{
		// Each of these is a member of org_a who must not be able to receive a task.
		{"viewer", taskB, transferViewer, opsActor, "OPS-3010", "P0001", "work_seat_required"},
		{"no seat", taskB, transferNoSeat, opsActor, "OPS-3011", "P0001", "work_seat_required"},
		{"suspended member", taskB, transferLeft, opsActor, "OPS-3012", "P0001", "work_seat_required"},
		// Task A has an active run: a hand-over mid-run would leave the running work owned
		// by someone who never submitted it.
		{"active run", taskA, transferTarget, opsActor, "OPS-3013", "P0001", "run_not_quiescent"},
		{"other org", taskD, transferTarget, opsActor, "OPS-3014", "P0002", "task_not_found"},
		{"unknown subject", taskB, "sub_nobody", opsActor, "OPS-3015", "P0001", "work_seat_required"},
		{"missing ticket", taskB, transferTarget, opsActor, "", "22023", "invalid_request"},
		{"impersonated session", taskB, transferTarget, opsImpostor, "OPS-3016", "42501", "actor_mismatch"},
	}
	for _, tc := range cases {
		if _, err := opsTransfer(dbName, opsActor, tc.actor, tc.taskID, tc.newOwner,
			tc.ticket, transferReason); err == nil {
			t.Fatalf("%s: call succeeded, want %s", tc.name, tc.msg)
		} else if pgErr := opsPgError(t, err); pgErr.SQLState() != tc.state ||
			pgErr.Message != tc.msg {
			t.Fatalf("%s = %s %q, want %s %q", tc.name,
				pgErr.SQLState(), pgErr.Message, tc.state, tc.msg)
		}
	}

	// Nothing moved, nothing was written.
	if got := taskOwnerFacts(t, dbName, taskB); got != "sub_a/0" {
		t.Fatalf("task B owner facts after refusals = %q, want sub_a at revision 0", got)
	}
	if got := taskOwnerFacts(t, dbName, taskA); got != "sub_a/1" {
		t.Fatalf("task A owner facts after refusals = %q, want sub_a at revision 1", got)
	}
	if audit := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.audit_event WHERE action = 'task.ownership_transferred'`); audit != "0" {
		t.Fatalf("transfer audit rows after refusals = %s, want 0", audit)
	}
	if events := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.task_event WHERE type = 'task.owner_changed'`); events != "0" {
		t.Fatalf("owner_changed events after refusals = %s, want 0", events)
	}

	// A deleted task is not transferable: the duty delete is the same entry point an
	// offboarding engineer would use, so the pair has to refuse in the right order.
	if _, err := opsDelete(dbName, opsActor, opsActor, taskB, "OPS-3017", transferReason); err != nil {
		t.Fatalf("duty delete before the transfer check: %v", err)
	}
	if _, err := opsTransfer(dbName, opsActor, opsActor, taskB, transferTarget,
		"OPS-3018", transferReason); err == nil {
		t.Fatal("transferred a tombstoned task")
	} else if pgErr := opsPgError(t, err); pgErr.SQLState() != "P0002" ||
		pgErr.Message != "task_not_found" {
		t.Fatalf("transfer of a deleted task = %s %q, want P0002 task_not_found",
			pgErr.SQLState(), pgErr.Message)
	}
}

func TestOpsTransferOwnershipRefusesWithoutTheGrant(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	seedTransferMembers(t, dbName)

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
		if _, e := tx.Exec(ctx, `SELECT set_config('app.subject_id', $1, true)`,
			opsActor); e != nil {
			return e
		}
		var revision int64
		return tx.QueryRow(ctx,
			`SELECT work.transfer_task_ownership($1, $2::uuid, $3, $4, $5, $6)`,
			"org_a", taskB, transferTarget, opsActor, transferTicket, transferReason,
		).Scan(&revision)
	}()
	if err == nil {
		t.Fatal("work_api moved task ownership; only work_ops is granted")
	}
	pgErr := opsPgError(t, err)
	if pgErr.SQLState() != "42501" ||
		pgErr.Message != "permission denied for function transfer_task_ownership" {
		t.Fatalf("app-role refusal = %s %q, want permission denied for function transfer_task_ownership",
			pgErr.SQLState(), pgErr.Message)
	}
	if got := taskOwnerFacts(t, dbName, taskB); got != "sub_a/0" {
		t.Fatalf("task B after refused transfer = %q, want untouched", got)
	}
}
