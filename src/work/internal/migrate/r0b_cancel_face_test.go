package migrate

import (
	"strconv"
	"strings"
	"testing"
)

// GW15 / 0056: the device cancel face.
//
// request_cancel (work_api, owner-bound) and ops_cancel_run (work_ops) already put a Run into
// cancel_requested, and cancel_operation already owns the dispatching->unknown versus
// ->canceled distinction. What did not exist was any device-facing way to LEARN of the cancel
// or to report the stop, so finish_local_run's run_cancel_requested verdict (0053) was
// unreachable in practice. These tests pin the two new commands and the two rulings that
// shape them: the getter is read-only re-push, and the ack is a stop fact, never a Run
// terminal writer.

func (a *actionFixture) requestCancel(t *testing.T) {
	t.Helper()
	// request_cancel RETURNS void and asserts app.subject_id, so it runs on the api
	// connection the fixture already set to the task owner.
	if _, err := a.apiConn(t).Exec(testContext(t),
		`SELECT work.request_cancel($1,$2::uuid,$3,$4)`,
		a.org, a.runID, a.subject, "user_cancel"); err != nil {
		t.Fatalf("request_cancel: %v", err)
	}
}

func (a *actionFixture) cancelRevision(t *testing.T) int64 {
	t.Helper()
	return int64(a.scalarInt(t, "SELECT control_revision FROM work.run WHERE id = "+
		quoteLiteral(a.runID)))
}

func (a *actionFixture) pendingCancels(t *testing.T, deviceID, sessionID string) []any {
	t.Helper()
	out := callJSON(t, a.workerConn(t),
		`SELECT work.list_pending_device_cancels($1,$2::uuid,$3::uuid)`,
		a.org, deviceID, sessionID)
	cancels, _ := out["cancels"].([]any)
	return cancels
}

const cancelAckSQL = `SELECT work.acknowledge_device_cancel($1,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid,$8)`

func (a *actionFixture) ackCancel(t *testing.T, revision int64, stopped string, seq int64) map[string]any {
	t.Helper()
	return callJSON(t, a.workerConn(t), cancelAckSQL,
		a.org, a.runID, revision, stopped, seq, a.deviceID, a.sessionID, strings.Repeat("3", 86))
}

func (a *actionFixture) operationState(t *testing.T, operationID string) string {
	t.Helper()
	return a.scalar(t, "SELECT state FROM work.operation WHERE org_id = "+
		quoteLiteral(a.org)+" AND id = "+quoteLiteral(operationID))
}

// TestR0bCancelGetterIsReadOnlyAndRunTargeted pins ruled ②: cancel_requested plus
// control_revision is already a durable fact, so re-push needs no delivered state and no
// write at all. Targeting is RUN-level through the latest binding (0049 precedent), which is
// what lets a reconnect's new session still see the cancel; a second device sees nothing.
func TestR0bCancelGetterIsReadOnlyAndRunTargeted(t *testing.T) {
	a := newActionFixture(t, "org_gw15_getter")

	if got := a.pendingCancels(t, a.deviceID, a.sessionID); len(got) != 0 {
		t.Fatalf("an active Run has a pending cancel: %#v", got)
	}
	a.requestCancel(t)
	revision := a.cancelRevision(t)
	if revision < 1 {
		t.Fatalf("request_cancel did not bump control_revision: %d", revision)
	}

	cancels := a.pendingCancels(t, a.deviceID, a.sessionID)
	if len(cancels) != 1 {
		t.Fatalf("pending cancels = %#v, want exactly one", cancels)
	}
	cancel, _ := cancels[0].(map[string]any)
	if len(cancel) != 2 {
		t.Fatalf("cancel body = %#v, want the two getter keys", cancel)
	}
	if cancel["run_id"] != a.runID {
		t.Fatalf("cancel run_id = %#v, want %s", cancel["run_id"], a.runID)
	}
	// uint64/bigint cross the wire as decimal strings, like every other device-plane counter.
	if cancel["cancel_revision"] != strconv.FormatInt(revision, 10) {
		t.Fatalf("cancel_revision = %#v, want the decimal string %d", cancel["cancel_revision"], revision)
	}

	// Read-only: a second get returns the same fact and moves nothing.
	again := a.pendingCancels(t, a.deviceID, a.sessionID)
	if len(again) != 1 {
		t.Fatalf("second get = %#v, want the same single cancel", again)
	}
	if got := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); got != "cancel_requested" {
		t.Fatalf("Run state after two gets = %q, want cancel_requested", got)
	}
	if a.cancelRevision(t) != revision {
		t.Fatal("the getter bumped control_revision")
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.task_event WHERE org_id = "+
		quoteLiteral(a.org)+" AND type = 'run.cancel_acknowledged'"); got != 0 {
		t.Fatalf("the getter wrote %d cancel events, want 0", got)
	}

	// Run-level, not session-level: another device's session must not see this cancel.
	otherDevice, otherSession := seedSecondDevice(t, a.orchestrationFixture)
	if got := a.pendingCancels(t, otherDevice, otherSession); len(got) != 0 {
		t.Fatalf("a foreign device sees the cancel: %#v", got)
	}
}

// TestR0bCancelAckStoppedSettlesOperationsWithoutWritingRunState is ruled ① end to end at the
// SQL layer: 'stopped' confirms the local process tree stopped, so an in-flight Operation
// becomes unknown (external effects still unproven) and an undispatched one is canceled with
// its Approval expired and its quota released. The Run itself stays cancel_requested —
// 0042 made finish_local_run_state the only terminal writer — and the lease watermark is
// untouched because renew_device_lease owns that column.
func TestR0bCancelAckStoppedSettlesOperationsWithoutWritingRunState(t *testing.T) {
	a := newActionFixture(t, "org_gw15_ack_stopped")
	worker := a.workerConn(t)
	// The fixture seeds one dispatching Operation; prepare adds an ask_each action parked on
	// its Approval, so the ack has both branches to settle.
	out := a.prepare(t, worker, "tool:2", a.grantClass)
	parkedOp := idOf(t, out, "operation_id")
	if got := a.operationState(t, parkedOp); got != "waiting_approval" {
		t.Fatalf("prepared Operation state = %q, want waiting_approval", got)
	}
	a.requestCancel(t)
	revision := a.cancelRevision(t)
	watermarkBefore := a.scalar(t, "SELECT last_receipt_seq::text FROM work.execution_lease WHERE id = "+
		quoteLiteral(a.leaseID))

	got := a.ackCancel(t, revision, "stopped", 7)
	if got["state"] != "recorded" {
		t.Fatalf("ack = %#v, want recorded", got)
	}
	if got["run_id"] != a.runID || got["cancel_revision"] != strconv.FormatInt(revision, 10) ||
		got["stopped_or_unknown"] != "stopped" {
		t.Fatalf("ack echo = %#v, want the run/revision/assertion it acknowledged", got)
	}
	if got["unknown_operations"] != float64(1) || got["canceled_operations"] != float64(1) ||
		got["dispatching_remaining"] != float64(0) {
		t.Fatalf("ack counts = %#v, want one unknown, one canceled, none left dispatching", got)
	}
	if s := a.operationState(t, a.op); s != "unknown" {
		t.Fatalf("the dispatching Operation became %q, want unknown (external effects unproven)", s)
	}
	if s := a.operationState(t, parkedOp); s != "canceled" {
		t.Fatalf("the undispatched Operation became %q, want canceled", s)
	}
	if s := a.scalar(t, "SELECT a.status FROM work.approval a JOIN work.approval_operation ao "+
		"ON ao.approval_id = a.id AND ao.org_id = a.org_id WHERE ao.operation_id = "+
		quoteLiteral(parkedOp)); s != "expired" {
		t.Fatalf("the parked Approval status = %q, want expired", s)
	}
	// Ruled ①: the ack is not a terminal writer.
	if s := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); s != "cancel_requested" {
		t.Fatalf("Run state after the ack = %q, want cancel_requested (finish owns the verdict)", s)
	}
	if a.cancelRevision(t) != revision {
		t.Fatal("the ack bumped control_revision")
	}
	// last_receipt_seq is evidence in the event/audit, not a second watermark writer.
	if s := a.scalar(t, "SELECT last_receipt_seq::text FROM work.execution_lease WHERE id = "+
		quoteLiteral(a.leaseID)); s != watermarkBefore {
		t.Fatalf("lease watermark moved from %s to %s; renew_device_lease is its only writer",
			watermarkBefore, s)
	}
	if s := a.scalar(t, "SELECT payload->>'last_receipt_seq' FROM work.task_event WHERE org_id = "+
		quoteLiteral(a.org)+" AND type = 'run.cancel_acknowledged'"); s != "7" {
		t.Fatalf("task event last_receipt_seq = %q, want the reported 7", s)
	}
	if n := a.scalarInt(t, "SELECT count(*) FROM work.audit_event WHERE org_id = "+
		quoteLiteral(a.org)+" AND action = 'device_cancel.acknowledged'"); n != 1 {
		t.Fatalf("cancel audits = %d, want 1", n)
	}
}

// TestR0bCancelAckUnknownLeavesAnInFlightOperationDispatching is the honesty branch: 'unknown'
// means the device cannot even assert the process stopped, so marking the Operation unknown
// would claim a fact nobody asserted. It stays dispatching and is counted as remaining, while
// the undispatched action is still definitively cancelable (§6.1).
func TestR0bCancelAckUnknownLeavesAnInFlightOperationDispatching(t *testing.T) {
	a := newActionFixture(t, "org_gw15_ack_unknown")
	worker := a.workerConn(t)
	parkedOp := idOf(t, a.prepare(t, worker, "tool:2", a.grantClass), "operation_id")
	a.requestCancel(t)

	got := a.ackCancel(t, a.cancelRevision(t), "unknown", 0)
	if got["state"] != "recorded" || got["stopped_or_unknown"] != "unknown" {
		t.Fatalf("ack = %#v, want a recorded unknown assertion", got)
	}
	if got["dispatching_remaining"] != float64(1) || got["unknown_operations"] != float64(0) ||
		got["canceled_operations"] != float64(1) {
		t.Fatalf("ack counts = %#v, want the in-flight action left dispatching", got)
	}
	if s := a.operationState(t, a.op); s != "dispatching" {
		t.Fatalf("in-flight Operation became %q, want dispatching under an unknown assertion", s)
	}
	if s := a.operationState(t, parkedOp); s != "canceled" {
		t.Fatalf("undispatched Operation became %q, want canceled", s)
	}
	if s := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); s != "cancel_requested" {
		t.Fatalf("Run state = %q, want cancel_requested", s)
	}
}

// TestR0bCancelAckIsBoundAndRevisionGated proves the ack carries the device-plane ownership
// gates and the closed assertion vocabulary. Each negative case is measured before any write,
// so a refusal cannot leave a half-settled Run.
func TestR0bCancelAckIsBoundAndRevisionGated(t *testing.T) {
	a := newActionFixture(t, "org_gw15_ack_bound")
	worker := a.workerConn(t)
	sig := strings.Repeat("3", 86)

	// An active Run has no cancel to acknowledge.
	expectCode(t, worker, "run_cancel_requested", cancelAckSQL,
		a.org, a.runID, int64(1), "stopped", int64(0), a.deviceID, a.sessionID, sig)

	a.requestCancel(t)
	revision := a.cancelRevision(t)
	otherDevice, otherSession := seedSecondDevice(t, a.orchestrationFixture)

	expectCode(t, worker, "unauthorized", cancelAckSQL,
		a.org, a.runID, revision, "stopped", int64(0), otherDevice, otherSession, sig)
	expectCode(t, worker, "unauthorized", cancelAckSQL,
		a.org, a.runID, revision, "stopped", int64(0), a.deviceID, newUUID(t), sig)
	expectCode(t, worker, "unauthorized", cancelAckSQL,
		a.org, a.runID, revision, "stopped", int64(0), newUUID(t), a.sessionID, sig)
	expectCode(t, worker, "revision_conflict", cancelAckSQL,
		a.org, a.runID, revision+1, "stopped", int64(0), a.deviceID, a.sessionID, sig)
	expectCode(t, worker, "run_not_found", cancelAckSQL,
		a.org, newUUID(t), revision, "stopped", int64(0), a.deviceID, a.sessionID, sig)
	// The closed vocabulary and the real ES256 shape, not a placeholder.
	expectCode(t, worker, "invalid_request", cancelAckSQL,
		a.org, a.runID, revision, "stopped_or_unknown", int64(0), a.deviceID, a.sessionID, sig)
	expectCode(t, worker, "invalid_request", cancelAckSQL,
		a.org, a.runID, revision, "", int64(0), a.deviceID, a.sessionID, sig)
	expectCode(t, worker, "invalid_request", cancelAckSQL,
		a.org, a.runID, revision, "stopped", int64(-1), a.deviceID, a.sessionID, sig)
	expectCode(t, worker, "invalid_request", cancelAckSQL,
		a.org, a.runID, int64(0), "stopped", int64(0), a.deviceID, a.sessionID, sig)
	expectCode(t, worker, "invalid_request", cancelAckSQL,
		a.org, a.runID, revision, "stopped", int64(0), a.deviceID, a.sessionID, "sha256:abc")

	if s := a.operationState(t, a.op); s != "dispatching" {
		t.Fatalf("a refused ack settled the Operation to %q", s)
	}
	if n := a.scalarInt(t, "SELECT count(*) FROM work.task_event WHERE org_id = "+
		quoteLiteral(a.org)+" AND type = 'run.cancel_acknowledged'"); n != 0 {
		t.Fatalf("refused acks wrote %d events, want 0", n)
	}
	// The positive control: the same call with the entitled identity is accepted, so every
	// refusal above measured its own gate rather than a fixture that can never succeed.
	if got := a.ackCancel(t, revision, "stopped", 0); got["state"] != "recorded" {
		t.Fatalf("entitled ack = %#v, want recorded", got)
	}
}

// TestR0bCancelAckReplayIsIdempotentAndALateAckIsANoOp covers the two replay shapes the
// read-only re-push ruling produces: the same ack arriving twice on one stream, and an ack
// arriving after the Run already reached its terminal verdict through finish_local_run.
func TestR0bCancelAckReplayIsIdempotentAndALateAckIsANoOp(t *testing.T) {
	a := newActionFixture(t, "org_gw15_ack_replay")
	worker := a.workerConn(t)
	a.prepare(t, worker, "tool:2", a.grantClass)
	a.requestCancel(t)
	revision := a.cancelRevision(t)

	first := a.ackCancel(t, revision, "stopped", 4)
	if first["canceled_operations"] != float64(1) || first["unknown_operations"] != float64(1) {
		t.Fatalf("first ack = %#v, want both Operations settled", first)
	}
	second := a.ackCancel(t, revision, "stopped", 4)
	if second["state"] != "recorded" {
		t.Fatalf("replayed ack = %#v, want recorded", second)
	}
	if second["canceled_operations"] != float64(0) || second["unknown_operations"] != float64(0) ||
		second["dispatching_remaining"] != float64(0) {
		t.Fatalf("replayed ack = %#v, want zero counts (nothing left to settle)", second)
	}
	if s := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); s != "cancel_requested" {
		t.Fatalf("Run state after a replay = %q, want cancel_requested", s)
	}

	// The terminal verdict still comes only from finish_local_run, and under
	// cancel_requested a failed outcome maps to canceled (0042:1818).
	verdict := a.callFinish(t, worker, newUUID(t), entitledFinish(t, a), a.deviceID, a.sessionID)
	if verdict["state"] != "accepted" {
		t.Fatalf("finish after the cancel ack = %#v, want accepted", verdict)
	}
	if s := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); s != "canceled" {
		t.Fatalf("Run state after finish = %q, want canceled", s)
	}
	// A late ack against the terminal Run is a no-op, not a refusal and not a second verdict.
	late := a.ackCancel(t, revision, "stopped", 4)
	if late["state"] != "already_terminal" {
		t.Fatalf("late ack = %#v, want already_terminal", late)
	}
	if late["canceled_operations"] != float64(0) || late["unknown_operations"] != float64(0) {
		t.Fatalf("late ack = %#v, want zero counts", late)
	}
	if s := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); s != "canceled" {
		t.Fatalf("a late ack moved the terminal Run to %q", s)
	}
	if n := a.scalarInt(t, "SELECT count(*) FROM work.device_run_finish WHERE run_id = "+
		quoteLiteral(a.runID)); n != 1 {
		t.Fatalf("verdict rows = %d, want 1 (the ack is not a verdict writer)", n)
	}
}

// TestR0bCancelFaceIsWorkerOnly pins the ACL: both commands are device-plane, so work_api
// (the REST face) must not be able to call them, and neither may PUBLIC.
func TestR0bCancelFaceIsWorkerOnly(t *testing.T) {
	a := newActionFixture(t, "org_gw15_acl")
	api := a.apiConn(t)
	expectCode(t, api, "permission denied",
		`SELECT work.list_pending_device_cancels($1,$2::uuid,$3::uuid)`,
		a.org, a.deviceID, a.sessionID)
	expectCode(t, api, "permission denied", cancelAckSQL,
		a.org, a.runID, int64(1), "stopped", int64(0), a.deviceID, a.sessionID,
		strings.Repeat("3", 86))
}