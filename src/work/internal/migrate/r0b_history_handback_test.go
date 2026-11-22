package migrate

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for increment 0062 (execution-face batch 7): the one server fact device-design §3.3 needs.
//
// §3.3 promises the UI a distinct answer for "handing history back and wrapping up" versus "the
// task is stuck", and batch 6 made the hand-back real: after a reconnect the device mints a
// same-session reconcile_finish lease (0061 change 2 expires the execute lease it replaces) and
// proposes run_finish under it. 0062 projects that ledger fact for the browser Work UI, which
// cannot read work.execution_lease itself (the table is granted to work_owner only and 0040:838-839
// forces RLS on it).
//
// What these cases pin is that the projection reads exactly the fact and nothing wider: false while
// the run still holds its execute lease, true the moment the reconnect's hand-back lease is live,
// false again once that lease is released or has run out its window, and the same §1.4 not-found
// answer for a caller who does not own the task. The true case is the batch's point, so it is
// produced by the real path (mint after a reconnect) rather than by inserting a row.

const handbackSQL = `SELECT work.run_history_handback($1, $2::uuid, $3)`

// handbackDocument reads 0062 through the API role with the session subject set - the only way the
// function's own gates (assert_session_subject, then task ownership) are actually exercised, which
// is how the shipped face calls it too.
func (a *actionFixture) handbackDocument(t *testing.T, subject string) map[string]any {
	t.Helper()
	var raw []byte
	if err := a.apiConnAs(t, subject).QueryRow(testContext(t), handbackSQL,
		a.org, a.runID, subject).Scan(&raw); err != nil {
		t.Fatalf("run_history_handback(%s): %v", subject, err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("run_history_handback returned a non-object: %s", raw)
	}
	return doc
}

// apiConnAs is deviceFixture.apiConn with a different session subject. The shipped handler sets
// app.subject_id from the verified Host session, so this is how a test says "somebody else is
// asking" while staying on the work_api role the face actually runs on.
func (a *actionFixture) apiConnAs(t *testing.T, subject string) *pgx.Conn {
	t.Helper()
	conn := connect(t, testpg.AppURL(a.dbName))
	mustExec(t, conn, "SET app.org_id = "+quoteLiteral(a.org)+
		"; SET app.subject_id = "+quoteLiteral(subject))
	return conn
}

// handbackError reports what the projection answers for a subject, for the refusal cases.
func (a *actionFixture) handbackError(t *testing.T, subject string) error {
	t.Helper()
	var raw []byte
	return a.apiConnAs(t, subject).QueryRow(testContext(t), handbackSQL,
		a.org, a.runID, subject).Scan(&raw)
}

func (a *actionFixture) handback(t *testing.T) bool {
	t.Helper()
	doc := a.handbackDocument(t, a.subject)
	if len(doc) != 2 {
		t.Fatalf("history hand-back document keys = %d (%v), want exactly run_id + history_handback",
			len(doc), doc)
	}
	if id, _ := doc["run_id"].(string); id != a.runID {
		t.Fatalf("document run_id = %q, want the fixture run %q", id, a.runID)
	}
	value, ok := doc["history_handback"].(bool)
	if !ok {
		t.Fatalf("history_handback is not a boolean: %#v", doc["history_handback"])
	}
	return value
}

// TestR0bHistoryHandbackIsFalseWhileTheRunStillHasItsExecuteLease is the negative half of the
// promise: a run executing normally must never read as handing history back, or the UI would show
// the §3.3 sentence for every ordinary run.
func TestR0bHistoryHandbackIsFalseWhileTheRunStillHasItsExecuteLease(t *testing.T) {
	a := newActionFixture(t, "org_62_execute_only")
	if got := a.leaseState(t, a.leaseID); got != "active" {
		t.Fatalf("fixture execute lease state = %q, want active", got)
	}
	if a.handback(t) {
		t.Fatal("history_handback = true while the run holds only its execute lease; §3.3's " +
			"hand-back sentence would then replace the normal running state")
	}
}

// TestR0bHistoryHandbackTurnsTrueWhenTheReconnectMintsTheReconcileLease is the batch's positive
// path, built the way a device builds it: a real reconnect (which supersedes the session the
// binding and the execute lease sit on) and then 0061's mint, which expires that execute lease to
// free the one-active-lease-per-run slot. Both halves are read back, because the boolean alone
// could otherwise come from a lease nobody minted.
func TestR0bHistoryHandbackTurnsTrueWhenTheReconnectMintsTheReconcileLease(t *testing.T) {
	a := newActionFixture(t, "org_62_reconcile_true")
	session2 := a.reconnect(t)
	minted := callJSON(t, a.workerConn(t), reconcileLeaseSQL, a.org, a.runID, a.deviceID, session2)
	leaseID, _ := minted["lease_id"].(string)
	if leaseID == "" {
		t.Fatalf("reconcile_finish mint returned no lease_id: %#v", minted)
	}

	if !a.handback(t) {
		t.Fatalf("history_handback = false with a live reconcile_finish lease %s; that lease IS "+
			"the fact §3.3 asks the UI to show", leaseID)
	}
	// The mint's precondition is 0061 change 2, and the projection must agree with it: the slot is
	// the run's single active lease, now the hand-back one.
	if got := a.leaseState(t, a.leaseID); got != "expired" {
		t.Fatalf("superseded execute lease state = %q, want expired by the reconcile mint", got)
	}
	if got := a.activeLeaseCount(t); got != 1 {
		t.Fatalf("active leases on the run = %d, want the one hand-back lease", got)
	}
	if purpose := a.scalar(t, "SELECT purpose FROM work.execution_lease WHERE id = "+
		quoteLiteral(leaseID)); purpose != "reconcile_finish" {
		t.Fatalf("the live lease purpose = %q, want reconcile_finish", purpose)
	}
}

// TestR0bHistoryHandbackIsFalseForAReleasedOrTimePastReconcileLease keeps the projection honest at
// both ends of the lease's life. Released means the hand-back already finished, and a lease whose
// window elapsed is NOT live even though its row still says state='active' - 0051/J12 never revives
// it, and expires_at is the clause that says so. The two conditions are separated because the
// fixture cannot produce them by mints: an expired lease that still carries state='active' is
// exactly the shape a caller must not be able to read as a live hand-back.
func TestR0bHistoryHandbackIsFalseForAReleasedOrTimePastReconcileLease(t *testing.T) {
	a := newActionFixture(t, "org_62_dead_lease")
	session2 := a.reconnect(t)
	minted := callJSON(t, a.workerConn(t), reconcileLeaseSQL, a.org, a.runID, a.deviceID, session2)
	leaseID, _ := minted["lease_id"].(string)
	if leaseID == "" {
		t.Fatalf("reconcile_finish mint returned no lease_id: %#v", minted)
	}
	if !a.handback(t) {
		t.Fatalf("history_handback = false immediately after the mint %s; the positive path broke", leaseID)
	}

	// ① state stays 'active' and only the window elapses. Two seconds have to pass first because
	// execution_lease_window (0040:824) requires expires_at > created_at: the row was minted with a
	// 30s TTL, so a past expires_at is only expressible a second or two after creation - which is
	// exactly the shape a caller must not read as live.
	time.Sleep(2 * time.Second)
	mustExec(t, a.admin, "UPDATE work.execution_lease SET expires_at = now() - interval '1 second' WHERE id = "+
		quoteLiteral(leaseID))
	if a.handback(t) {
		t.Fatal("history_handback = true for a hand-back lease whose window elapsed; an expired " +
			"lease buys nothing (0051/J12) and must not keep the UI in the hand-back state")
	}
	if got := a.scalar(t, "SELECT state FROM work.execution_lease WHERE id = "+
		quoteLiteral(leaseID)); got != "active" {
		t.Fatalf("the row under test moved to state %q; this case is about expires_at alone", got)
	}

	// ② the terminal state with a future window: the finish already landed, so §3.3's sentence has
	// to stop showing even though the row is not yet out of date. active→released is the legal
	// transition (0017's map), which is why the two clauses are read in this order.
	mustExec(t, a.admin, "UPDATE work.execution_lease SET state = 'released', "+
		"expires_at = now() + interval '30 seconds' WHERE id = "+quoteLiteral(leaseID))
	if a.handback(t) {
		t.Fatal("history_handback = true for a released hand-back lease; the finish already " +
			"happened, so the lease row must not keep the run in the hand-back state")
	}
}

// TestR0bHistoryHandbackRefusesARunTheCallerDoesNotOwn is §1.4's confidentiality idiom for this
// face: a stranger asking about a run that IS handing back gets the same answer a missing run
// gets. A 403 here would confirm that somebody else's stuck run exists.
func TestR0bHistoryHandbackRefusesARunTheCallerDoesNotOwn(t *testing.T) {
	a := newActionFixture(t, "org_62_foreign_caller")
	session2 := a.reconnect(t)
	callJSON(t, a.workerConn(t), reconcileLeaseSQL, a.org, a.runID, a.deviceID, session2)
	if !a.handback(t) {
		t.Fatal("precondition: the owner's own read must report the hand-back")
	}

	err := a.handbackError(t, "sub_62_stranger")
	if err == nil || !strings.Contains(err.Error(), "task_not_found") {
		t.Fatalf("foreign subject read = %v, want task_not_found (a 403-shaped answer would "+
			"disclose that the run exists)", err)
	}
}
