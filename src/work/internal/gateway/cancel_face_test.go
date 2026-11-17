package gateway_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

// GW15: the cancel downlink and the cancel_ack stop fact. request_cancel already put the Run into
// cancel_requested, but nothing told the device, so finish_local_run's run_cancel_requested route
// (§3.4 step 4) was unreachable. 0056 adds the read-only getter and the ack command; the gateway
// signs, delivers and forwards, and judges nothing.
//
// The two wire extensions ruled 主签 2026-11-17 are pinned here: both sides carry an ES256
// signature, and the ack body is the closed five keys (run_id/cancel_revision are what make it
// callable at all — one session can hold several Runs).

// requestCancel asks for the cancel through the real work_api command, exactly as the M1b REST
// face does, and returns the control_revision the cancel downlink must carry. It is owner-bound
// and asserts app.subject_id, so it runs on an api connection set to the task owner.
func (r *runUnderFinish) requestCancel(t *testing.T) string {
	t.Helper()
	ctx := gwContext(t)
	api, err := testpg.Open(ctx, testpg.AppURL(r.f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = api.Close(ctx) }()
	if err := testpg.ExecRaw(ctx, api,
		"SET app.org_id = '"+gwOrg+"'; SET app.subject_id = '"+gwSubject+"'"); err != nil {
		t.Fatal(err)
	}
	// request_cancel RETURNS void, so it is executed rather than decoded.
	if _, err := api.Exec(ctx, `SELECT work.request_cancel($1,$2::uuid,$3,$4)`,
		gwOrg, r.runID, gwSubject, "user_cancel"); err != nil {
		t.Fatalf("request_cancel: %v", err)
	}
	return r.scalar(t, `SELECT control_revision::text FROM work.run WHERE org_id=$1 AND id=$2::uuid`,
		gwOrg, r.runID)
}

// cancelAckBody builds the closed five-key wire body minus the signature signFrame adds.
func (r *runUnderFinish) cancelAckBody(revision, stopped, seq string) map[string]any {
	return map[string]any{
		"run_id":             r.runID,
		"cancel_revision":    revision,
		"stopped_or_unknown": stopped,
		"last_receipt_seq":   seq,
	}
}

func (r *runUnderFinish) sendCancelAck(t *testing.T, body map[string]any) {
	t.Helper()
	if err := r.stream.SendMsg(r.f.signFrame(t, "cancel_ack", r.sessionID, r.bootID, r.agentID, body)); err != nil {
		t.Fatal(err)
	}
}

// TestCancelIsPushedOnHeartbeatAndServerSigned proves the downlink fires on the cadence the
// design already fixes (there is no worker→gateway signal for a REST-requested cancel), that it
// is server-signed over the "cancel" frame type, and that the getter is read-only: two more
// heartbeats re-deliver nothing and settle nothing.
func TestCancelIsPushedOnHeartbeatAndServerSigned(t *testing.T) {
	r := startRunForFinish(t)
	revision := r.requestCancel(t)

	// The lease downlink is the sequencing barrier: the renewals are sent before the pushes and
	// the stream is handled sequentially, so the cancel that follows is this heartbeat's.
	r.heartbeatRenew(t)
	bodyJSON, cancel, session := recvTypedFrame(t, r.stream, "cancel")
	if session != r.sessionID {
		t.Fatalf("cancel session = %v, want %s", session, r.sessionID)
	}
	// §3.1's two keys plus the ruled server signature.
	if len(cancel) != 3 {
		t.Fatalf("cancel body = %#v, want exactly three keys", cancel)
	}
	if cancel["run_id"] != r.runID {
		t.Fatalf("cancel run_id = %#v, want %s", cancel["run_id"], r.runID)
	}
	if cancel["cancel_revision"] != revision {
		t.Fatalf("cancel_revision = %#v, want the Run's control_revision %s",
			cancel["cancel_revision"], revision)
	}
	sig, _ := cancel["signature"].(string)
	if sig == "" || !devicesig.VerifyFrame(r.serverPub, "cancel", bodyJSON, sig) {
		t.Fatalf("cancel signature does not verify against the hello_ack frame JWK: %#v", cancel)
	}
	for _, other := range []string{"command", "run_offer", "run_finish_ack", "cancel_ack", "permit"} {
		if devicesig.VerifyFrame(r.serverPub, other, bodyJSON, sig) {
			t.Fatalf("a cancel signature verified as %s (frame type not bound)", other)
		}
	}
	// The permit key is independent: it must not verify a frame (GW14's separation).
	if devicesig.VerifyFrame(r.permitPub, "cancel", bodyJSON, sig) {
		t.Fatal("the cancel verified under the PERMIT key: the two signing keys are not independent")
	}

	// Per-stream dedup: each heartbeatRenew reads exactly one lease frame, so a re-delivered
	// cancel from the previous heartbeat would be read here as the wrong type.
	r.heartbeatRenew(t)
	r.heartbeatRenew(t)

	// Read-only re-push: nothing moved, and no stop fact was invented.
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "cancel_requested" {
		t.Fatalf("Run state = %q, want cancel_requested", got)
	}
	if got := r.scalar(t, `SELECT control_revision::text FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != revision {
		t.Fatalf("control_revision moved to %s, want %s", got, revision)
	}
	if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND run_id=$2::uuid`, gwOrg, r.runID); got != "dispatching" {
		t.Fatalf("the getter settled the Operation to %q, want dispatching", got)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.task_event WHERE org_id=$1 AND type='run.cancel_acknowledged'`, gwOrg); got != "0" {
		t.Fatalf("cancel events = %s, want 0 (nothing was acknowledged)", got)
	}
}

// TestCancelAckRecordsTheStopFactWithoutARunVerdict is the GW15 round trip. 'stopped' confirms
// the local process tree stopped, so the in-flight Operation becomes unknown (external effects
// still unproven) and the undispatched one is canceled. The Run stays cancel_requested: the ack
// is not a terminal writer, and no downlink answers it (§3.1 registers no third frame).
func TestCancelAckRecordsTheStopFactWithoutARunVerdict(t *testing.T) {
	r, grantID := startRunForAction(t)
	// An ask_each action parks an Operation on its Approval, so the ack has both branches.
	r.sendAction(t, r.actionBody(grantID, "tool:parked", 0))
	_, ack, _ := recvTypedFrame(t, r.stream, "action_prepared")
	if ack["state"] != "waiting_approval" {
		t.Fatalf("ask_each ack = %#v, want waiting_approval", ack)
	}
	parkedOp, _ := ack["operation_id"].(string)
	inflightOp := r.scalar(t, `SELECT id::text FROM work.operation WHERE org_id=$1 AND run_id=$2::uuid AND state='dispatching'`,
		gwOrg, r.runID)

	revision := r.requestCancel(t)
	r.heartbeatRenew(t)
	_, cancel, _ := recvTypedFrame(t, r.stream, "cancel")
	if cancel["cancel_revision"] != revision {
		t.Fatalf("cancel_revision = %#v, want %s", cancel["cancel_revision"], revision)
	}

	r.sendCancelAck(t, r.cancelAckBody(revision, "stopped", "7"))
	// No response frame exists, so the next heartbeat's lease is the barrier that proves the
	// ack was consumed before the reads below.
	r.heartbeatRenew(t)

	if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND id=$2::uuid`, gwOrg, inflightOp); got != "unknown" {
		t.Fatalf("in-flight Operation = %q, want unknown under a stopped assertion", got)
	}
	if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND id=$2::uuid`, gwOrg, parkedOp); got != "canceled" {
		t.Fatalf("undispatched Operation = %q, want canceled", got)
	}
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "cancel_requested" {
		t.Fatalf("Run state = %q, want cancel_requested (finish_local_run_state owns the verdict)", got)
	}
	// last_receipt_seq is evidence, not a second watermark writer: renew_device_lease owns
	// execution_lease.last_receipt_seq (0051) and the heartbeat above sent 0.
	if got := r.scalar(t, `SELECT last_receipt_seq::text FROM work.execution_lease WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.leaseID); got != "0" {
		t.Fatalf("lease watermark = %s, want 0 (the ack must not advance it)", got)
	}
	if got := r.scalar(t, `SELECT payload->>'last_receipt_seq' FROM work.task_event WHERE org_id=$1 AND type='run.cancel_acknowledged'`, gwOrg); got != "7" {
		t.Fatalf("task event last_receipt_seq = %q, want the reported 7", got)
	}
	if got := r.scalar(t, `SELECT payload->>'stopped_or_unknown' FROM work.task_event WHERE org_id=$1 AND type='run.cancel_acknowledged'`, gwOrg); got != "stopped" {
		t.Fatalf("task event assertion = %q, want stopped", got)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.audit_event WHERE org_id=$1 AND action='device_cancel.acknowledged'`, gwOrg); got != "1" {
		t.Fatalf("cancel audits = %s, want 1", got)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.device_run_finish WHERE run_id=$1::uuid`, r.runID); got != "0" {
		t.Fatalf("verdict rows = %s, want 0 (the ack wrote a Run verdict)", got)
	}
}

// TestCancelAckUnknownLeavesTheInFlightOperationDispatching is the honesty branch: 'unknown'
// means the device cannot even assert the process stopped, so the Operation must stay dispatching
// rather than being marked unknown on a fact nobody asserted.
func TestCancelAckUnknownLeavesTheInFlightOperationDispatching(t *testing.T) {
	r := startRunForFinish(t)
	revision := r.requestCancel(t)
	r.heartbeatRenew(t)
	recvTypedFrame(t, r.stream, "cancel")

	r.sendCancelAck(t, r.cancelAckBody(revision, "unknown", "0"))
	r.heartbeatRenew(t)

	if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND run_id=$2::uuid`, gwOrg, r.runID); got != "dispatching" {
		t.Fatalf("in-flight Operation = %q, want dispatching under an unknown assertion", got)
	}
	if got := r.scalar(t, `SELECT payload->>'dispatching_remaining' FROM work.task_event WHERE org_id=$1 AND type='run.cancel_acknowledged'`, gwOrg); got != "1" {
		t.Fatalf("dispatching_remaining = %q, want 1", got)
	}
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "cancel_requested" {
		t.Fatalf("Run state = %q, want cancel_requested", got)
	}
}

// TestCancelIsRePushedOnANewSession proves the getter's RUN-level targeting: a device that
// reconnects before acknowledging still learns of the cancel, because the getter binds the Run
// through its latest device_run_binding rather than through the calling session. The command
// claim cannot do this (a new session cannot renew the old lease, GW10 boundary); a cancel is a
// Run fact, so re-push across sessions is both safe and required.
func TestCancelIsRePushedOnANewSession(t *testing.T) {
	r := startRunForFinish(t)
	revision := r.requestCancel(t)
	r.heartbeatRenew(t)
	recvTypedFrame(t, r.stream, "cancel")

	// A second hello supersedes the first session. The cancel was never acknowledged.
	addr := r.f.startServer(t)
	stream := r.f.connect(t, addr)
	sessionID, bootID, agentID, serverPub := r.f.helloWithTicket(t, stream, r.f.mintSecondTicket(t))
	if sessionID == r.sessionID {
		t.Fatal("the reconnect reused the superseded session")
	}
	bodyJSON, cancel, _ := recvTypedFrame(t, stream, "cancel")
	if cancel["run_id"] != r.runID || cancel["cancel_revision"] != revision {
		t.Fatalf("re-pushed cancel = %#v, want run %s at revision %s", cancel, r.runID, revision)
	}
	sig, _ := cancel["signature"].(string)
	if !devicesig.VerifyFrame(serverPub, "cancel", bodyJSON, sig) {
		t.Fatalf("the re-pushed cancel is not server-signed: %#v", cancel)
	}
	// The new session may acknowledge it: the ack gates the session, not the binding's session.
	body := map[string]any{
		"run_id":             r.runID,
		"cancel_revision":    revision,
		"stopped_or_unknown": "stopped",
		"last_receipt_seq":   "0",
	}
	if err := stream.SendMsg(r.f.signFrame(t, "cancel_ack", sessionID, bootID, agentID, body)); err != nil {
		t.Fatal(err)
	}
	// cancel_ack has no response frame, and the new session cannot renew the old lease (GW10
	// boundary), so there is no downlink to use as a barrier. Closing the send side is one: the
	// handler processes every prior frame before its RecvMsg returns EOF, so a clean EOF proves
	// both that the ack was consumed and that nothing answered it.
	if err := stream.CloseSend(); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	err := stream.RecvMsg(&raw)
	if err == nil {
		t.Fatalf("cancel_ack was answered with a downlink: %s", raw)
	}
	// connect returns the transport's own io.EOF when the send side closes, so a clean EOF
	// (rather than a business status) is the proof the ack was consumed and nothing answered it.
	if got := status.Convert(err).Message(); got != "EOF" {
		t.Fatalf("stream ended with %q, want the transport EOF after a consumed ack", got)
	}
	if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND run_id=$2::uuid`, gwOrg, r.runID); got != "unknown" {
		t.Fatalf("Operation after the reconnect ack = %q, want unknown", got)
	}
}

// TestRejectedRunFinishDeliversThePendingCancelInTheSameRoundTrip pins §3.4 step 4: a rejected
// finish routes the device into the cancel_ack flow, and cancel_ack needs the cancel_revision the
// device only learns from the cancel downlink. Pushing after the verdict makes that route callable
// without waiting for the next heartbeat (GW14's command-after-action_prepared precedent).
func TestRejectedRunFinishDeliversThePendingCancelInTheSameRoundTrip(t *testing.T) {
	r := startRunForFinish(t)
	revision := r.requestCancel(t)

	// A mismatched operation-set hash is rejected with finish_state_mismatch, which is a verdict
	// in the ack body rather than a transport error, so the stream survives and the push runs.
	r.send(t, r.finishBody(uuid.NewString(), "failed", "model_error", strings.Repeat("e", 64), []string{}))
	_, verdict, _ := recvTypedFrame(t, r.stream, "run_finish_ack")
	if verdict["state"] != "rejected" || verdict["code"] != "finish_state_mismatch" {
		t.Fatalf("verdict = %#v, want a finish_state_mismatch rejection", verdict)
	}
	_, cancel, _ := recvTypedFrame(t, r.stream, "cancel")
	if cancel["run_id"] != r.runID || cancel["cancel_revision"] != revision {
		t.Fatalf("cancel after the rejected finish = %#v, want run %s at revision %s",
			cancel, r.runID, revision)
	}
}

// TestCancelAckIsRevisionGatedAndClosed measures each refusal on its own stream, because a gRPC
// status terminates the stream (control-design §582). The business code is preserved in the
// message, and the mapping is the ruled one: a revision conflict is ABORTED, a shape error
// INVALID_ARGUMENT, an unknown Run NOT_FOUND.
func TestCancelAckIsRevisionGatedAndClosed(t *testing.T) {
	for _, tc := range []struct {
		name     string
		mutate   func(map[string]any)
		wantCode codes.Code
		wantMsg  string
	}{
		{"stale revision", func(b map[string]any) { b["cancel_revision"] = "99" },
			codes.Aborted, "revision_conflict"},
		{"outside the closed vocabulary", func(b map[string]any) { b["stopped_or_unknown"] = "stopped_or_unknown" },
			codes.InvalidArgument, "invalid_request"},
		{"negative watermark", func(b map[string]any) { b["last_receipt_seq"] = "-1" },
			codes.InvalidArgument, "invalid_request: cancel_ack last_receipt_seq"},
		{"unknown run", func(b map[string]any) { b["run_id"] = uuid.NewString() },
			codes.NotFound, "run_not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := startRunForFinish(t)
			revision := r.requestCancel(t)
			body := r.cancelAckBody(revision, "stopped", "0")
			tc.mutate(body)
			r.sendCancelAck(t, body)
			var raw []byte
			err := r.stream.RecvMsg(&raw)
			wantCode(t, err, tc.wantCode)
			if got := status.Convert(err).Message(); got != tc.wantMsg {
				t.Fatalf("message = %q, want %q", got, tc.wantMsg)
			}
			if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND run_id=$2::uuid`, gwOrg, r.runID); got != "dispatching" {
				t.Fatalf("a refused ack settled the Operation to %q", got)
			}
		})
	}
}

// TestCancelAckRejectsATamperedAssertion proves the uplink signature covers the stop fact itself:
// stopped_or_unknown decides whether an in-flight Operation becomes unknown, so flipping it after
// signing must fail verification rather than reach the domain command.
func TestCancelAckRejectsATamperedAssertion(t *testing.T) {
	r := startRunForFinish(t)
	revision := r.requestCancel(t)
	signed := r.f.signFrame(t, "cancel_ack", r.sessionID, r.bootID, r.agentID,
		r.cancelAckBody(revision, "unknown", "0"))

	var env map[string]json.RawMessage
	if err := json.Unmarshal(signed, &env); err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(env["body"], &body); err != nil {
		t.Fatal(err)
	}
	body["stopped_or_unknown"] = "stopped"
	tamperedBody, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	env["body"] = tamperedBody
	tampered, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.stream.SendMsg(tampered); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, r.stream.RecvMsg(&raw), codes.Unauthenticated)
	if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND run_id=$2::uuid`, gwOrg, r.runID); got != "dispatching" {
		t.Fatalf("a tampered ack settled the Operation to %q", got)
	}
}

// TestCancelAckReplayIsIdempotent proves a re-sent ack settles nothing a second time. ES256 is
// randomized, so the replay re-sends the SAME signed bytes rather than re-signing (GW12 lesson).
func TestCancelAckReplayIsIdempotent(t *testing.T) {
	r := startRunForFinish(t)
	revision := r.requestCancel(t)
	r.heartbeatRenew(t)
	recvTypedFrame(t, r.stream, "cancel")
	signed := r.f.signFrame(t, "cancel_ack", r.sessionID, r.bootID, r.agentID,
		r.cancelAckBody(revision, "stopped", "3"))
	if err := r.stream.SendMsg(signed); err != nil {
		t.Fatal(err)
	}
	r.heartbeatRenew(t)
	if got := r.scalar(t, `SELECT count(*)::text FROM work.task_event WHERE org_id=$1 AND type='run.cancel_acknowledged'`, gwOrg); got != "1" {
		t.Fatalf("cancel events after the first ack = %s, want 1", got)
	}
	if err := r.stream.SendMsg(signed); err != nil {
		t.Fatal(err)
	}
	r.heartbeatRenew(t)
	if got := r.scalar(t, `SELECT payload->>'unknown_operations' FROM work.task_event WHERE org_id=$1 AND type='run.cancel_acknowledged' ORDER BY seq DESC LIMIT 1`, gwOrg); got != "0" {
		t.Fatalf("replayed ack unknown_operations = %q, want 0 (nothing left to settle)", got)
	}
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "cancel_requested" {
		t.Fatalf("Run state after a replay = %q, want cancel_requested", got)
	}
}
