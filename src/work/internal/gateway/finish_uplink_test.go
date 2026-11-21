package gateway_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"

	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

// GW12: the run_finish uplink and the server-signed run_finish_ack. The device proposes, the
// control plane adjudicates (0042's six steps, bound to the caller by 0053), and the verdict —
// including all four rejection codes — travels in the ack body, never as a transport error.

// runUnderFinish drives the GW11 spine so the device legitimately holds what a finish proposal
// must name: an active lease, an active binding at revision 1, and the seq=0 checkpoint baseline
// acquire_device_lease wrote. Everything a real device would echo comes from the frames it
// received, not from the test's own guesses.
type runUnderFinish struct {
	f          *gwFixture
	stream     grpc.ClientStream
	addr       string
	sessionID  string
	bootID     string
	agentID    string
	serverPub  *devicesig.PublicKey
	permitPub  *devicesig.PublicKey
	runID      string
	leaseID    string
	fence      string
	checkpoint string
	setHash    string
}

func startRunForFinish(t *testing.T) *runUnderFinish {
	t.Helper()
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, serverPub, permitPub := f.helloWithBothJWKs(t, stream)
	runID, _, _, _ := f.seedAction(t, sessionID)
	f.seedOffer(t, sessionID, runID, 1)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{}, "0"))); err != nil {
		t.Fatal(err)
	}
	_, offer, _ := recvTypedFrame(t, stream, "run_offer")
	ready := map[string]any{
		"run_id":           runID,
		"binding_revision": "1",
		"binding_hash":     offer["binding_hash"],
		"ready_or_reason":  "ready",
	}
	if err := stream.SendMsg(f.signFrame(t, "run_ready", sessionID, bootID, agentID, ready)); err != nil {
		t.Fatal(err)
	}
	_, start, _ := recvTypedFrame(t, stream, "run_start")
	leaseID, _ := start["lease_id"].(string)
	fence, _ := start["fence"].(string)
	if leaseID == "" || fence == "" {
		t.Fatalf("run_start gave no lease/fence: %#v", start)
	}

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	// local_operation_set_hash is SECURITY DEFINER and work.operation FORCEs RLS, so the
	// definer's own org context has to be set on THIS connection or the function reads an empty
	// Operation set and returns sha256("[]") — which would make the cross-check below compare
	// the ack against the wrong value instead of against the server's real recomputation.
	if err := testpg.ExecRaw(ctx, admin, "SET app.org_id = '"+gwOrg+"'"); err != nil {
		t.Fatal(err)
	}
	r := &runUnderFinish{f: f, stream: stream, addr: addr, sessionID: sessionID, bootID: bootID,
		agentID: agentID, serverPub: serverPub, permitPub: permitPub,
		runID: runID, leaseID: leaseID, fence: fence}
	if err := admin.QueryRow(ctx,
		`SELECT checkpoint_hash FROM work.device_checkpoint
		 WHERE org_id=$1 AND run_id=$2::uuid AND checkpoint_seq=0`, gwOrg, runID).
		Scan(&r.checkpoint); err != nil {
		t.Fatalf("no seq=0 baseline to finish against: %v", err)
	}
	// The server's own recomputation, read independently so the ack can be checked against it
	// rather than against itself (O-16: the formula is a cross-side contract).
	if err := admin.QueryRow(ctx,
		`SELECT work.local_operation_set_hash($1,$2::uuid)`, gwOrg, runID).Scan(&r.setHash); err != nil {
		t.Fatal(err)
	}
	return r
}

// finishBody builds the closed wire run_finish body (§3.1). reasonCode empty means a completed
// Run, which must carry no reason; the gateway still emits the key as null for SQL's eight-key
// closed set.
func (r *runUnderFinish) finishBody(finishID, outcome, reasonCode, setHash string, deliverables []string) map[string]any {
	body := map[string]any{
		"finish_id":                finishID,
		"run_id":                   r.runID,
		"binding_revision":         "1",
		"fence":                    r.fence,
		"lease_id":                 r.leaseID,
		"outcome":                  outcome,
		"final_checkpoint_seq":     "0",
		"final_checkpoint_hash":    r.checkpoint,
		"receipt_through_seq":      "0",
		"final_operation_set_hash": setHash,
		"deliverable_versions":     deliverables,
	}
	if reasonCode != "" {
		body["reason_code"] = reasonCode
	}
	return body
}

func (r *runUnderFinish) send(t *testing.T, body map[string]any) {
	t.Helper()
	if err := r.stream.SendMsg(r.f.signFrame(t, "run_finish", r.sessionID, r.bootID, r.agentID, body)); err != nil {
		t.Fatal(err)
	}
}

// scalar reads one value as the test's own admin connection.
func (r *runUnderFinish) scalar(t *testing.T, sql string, args ...any) string {
	t.Helper()
	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(r.f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var out string
	if err := admin.QueryRow(ctx, sql, args...).Scan(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestRunFinishIsAdjudicatedAndServerSigned is the GW12 round trip and the reason the ack was
// ruled to seven keys: a mismatched operation-set hash is REJECTED with the server's own
// expected value and the blocking Operation list, the device repairs the proposal from that ack
// alone, and a new finish_id is accepted. The verdict is server-signed over the run_finish_ack
// frame type, the terminal write set is read back, and a re-send of the same finish_id replays.
func TestRunFinishIsAdjudicatedAndServerSigned(t *testing.T) {
	r := startRunForFinish(t)
	f := r.f

	// 1. A wrong set hash: rejected, and the ack carries what the device needs to repair it.
	rejectedBytes := f.signFrame(t, "run_finish", r.sessionID, r.bootID, r.agentID,
		r.finishBody(uuid.NewString(), "failed", "model_error", strings.Repeat("e", 64), []string{}))
	if err := r.stream.SendMsg(rejectedBytes); err != nil {
		t.Fatal(err)
	}
	bodyJSON, ack, ackSession := recvTypedFrame(t, r.stream, "run_finish_ack")
	if ackSession != r.sessionID {
		t.Fatalf("run_finish_ack session = %v, want %s", ackSession, r.sessionID)
	}
	if ack["state"] != "rejected" || ack["code"] != "finish_state_mismatch" {
		t.Fatalf("ack = %#v, want rejected/finish_state_mismatch", ack)
	}
	if ack["expected_operation_set_hash"] != r.setHash {
		t.Fatalf("ack expected hash = %v, want the server's recomputed %s",
			ack["expected_operation_set_hash"], r.setHash)
	}
	unresolved, _ := ack["unresolved_operations"].([]any)
	if len(unresolved) != 1 {
		t.Fatalf("unresolved_operations = %#v, want the one dispatched Operation", ack["unresolved_operations"])
	}
	if op, _ := unresolved[0].(map[string]any); op["state"] != "dispatching" {
		t.Fatalf("unresolved operation = %#v, want state dispatching", unresolved[0])
	}
	if ack["terminal_run_revision"] != nil {
		t.Fatalf("a rejected ack carries a terminal revision: %#v", ack)
	}
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "active" {
		t.Fatalf("Run state after a refusal = %q, want active (no terminal write)", got)
	}

	// The rejected verdict is just as replayable as success, including its repair list.
	if err := r.stream.SendMsg(rejectedBytes); err != nil {
		t.Fatal(err)
	}
	_, rejectedReplay, _ := recvTypedFrame(t, r.stream, "run_finish_ack")
	delete(ack, "signature")
	delete(rejectedReplay, "signature")
	if !reflect.DeepEqual(ack, rejectedReplay) {
		t.Fatalf("rejected replay changed business fields: %#v vs %#v", ack, rejectedReplay)
	}

	// 2. The repaired proposal, under a NEW finish_id (§3.4 step 4: never re-judge under the
	// same one). The only value taken from the ack is the expected hash.
	finishID := uuid.NewString()
	repaired := r.finishBody(finishID, "failed", "model_error", r.setHash, []string{})
	// The signed bytes are captured once and re-sent verbatim below: ES256 is randomized, so
	// re-signing the same body produces a different signature, a different signed_payload_hash
	// and therefore idempotency_key_conflict — §3.4 step 3 says re-send the SAME bytes, which is
	// what the device's runtime_finish row stores.
	repairedBytes := f.signFrame(t, "run_finish", r.sessionID, r.bootID, r.agentID, repaired)
	if err := r.stream.SendMsg(repairedBytes); err != nil {
		t.Fatal(err)
	}
	bodyJSON, accepted, _ := recvTypedFrame(t, r.stream, "run_finish_ack")
	if accepted["state"] != "accepted" || accepted["code"] != nil {
		t.Fatalf("repaired finish = %#v, want accepted with no code", accepted)
	}
	revision, _ := accepted["terminal_run_revision"].(string)
	if revision == "" || revision == "0" {
		t.Fatalf("terminal_run_revision = %v, want a positive decimal string", accepted["terminal_run_revision"])
	}
	// The closed seven-key body: §3.1's five plus the two §3.4/§6.4 repair fields, with the
	// internal sha256 placeholder and the idempotency fact both dropped.
	if len(accepted) != 7 {
		t.Fatalf("ack body = %#v, want exactly the ruled seven keys", accepted)
	}
	for _, absent := range []string{"server_signature", "replayed"} {
		if _, leaked := accepted[absent]; leaked {
			t.Fatalf("ack leaked the internal %s: %#v", absent, accepted)
		}
	}
	sig, _ := accepted["signature"].(string)
	if sig == "" || !devicesig.VerifyFrame(r.serverPub, "run_finish_ack", bodyJSON, sig) {
		t.Fatalf("ack signature does not verify against the hello_ack JWK: %#v", accepted)
	}
	for _, other := range []string{"run_finish", "run_offer", "checkpoint_ack"} {
		if devicesig.VerifyFrame(r.serverPub, other, bodyJSON, sig) {
			t.Fatalf("a run_finish_ack signature verified as %s (frame type not bound)", other)
		}
	}

	// 3. The terminal write set finish_local_run_state owns (0042:1769).
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "failed" {
		t.Fatalf("Run state = %q, want failed", got)
	}
	if got := r.scalar(t, `SELECT terminal_reason FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "model_error" {
		t.Fatalf("terminal_reason = %q, want model_error", got)
	}
	if got := r.scalar(t, `SELECT state FROM work.execution_lease WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.leaseID); got != "released" {
		t.Fatalf("lease state = %q, want released", got)
	}
	if got := f.bindingState(t, r.runID, 1); got != "finished/3" {
		t.Fatalf("binding = %s, want finished/3 (offered/0 → ready/1 → active/2 → finished/3)", got)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.device_run_finish WHERE org_id=$1 AND run_id=$2::uuid`, gwOrg, r.runID); got != "2" {
		t.Fatalf("verdict rows = %s, want 2 (the refusal is evidence too)", got)
	}

	// 4. A lost ack is repaired by re-sending the SAME finish_id and the same signed bytes
	// (§3.4 step 3, §6.3): the same verdict and revision, no third row, no re-judgment.
	if err := r.stream.SendMsg(repairedBytes); err != nil {
		t.Fatal(err)
	}
	_, replay, _ := recvTypedFrame(t, r.stream, "run_finish_ack")
	delete(accepted, "signature")
	delete(replay, "signature")
	if !reflect.DeepEqual(accepted, replay) {
		t.Fatalf("accepted replay changed business fields: %#v vs %#v", accepted, replay)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.device_run_finish WHERE org_id=$1 AND run_id=$2::uuid`, gwOrg, r.runID); got != "2" {
		t.Fatalf("verdict rows after a replay = %s, want still 2", got)
	}
}

// TestRunFinishCompletedWithoutDeliverablesIsRejected proves the completed gate is reachable
// through the gateway and that its verdict is an ack, not a gRPC error: a completed proposal
// with no deliverable version is finish_precondition_failed and the Run stays active. This is
// also the 0042 defect 0053 change 3 fixed — the rejected evidence row used to violate the
// table's deliverable shape CHECK (completed => non-empty), so the proposal died on 23514 and
// the device saw service_degraded instead of the verdict §6.4 step 4 defines.
func TestRunFinishCompletedWithoutDeliverablesIsRejected(t *testing.T) {
	r := startRunForFinish(t)
	r.send(t, r.finishBody(uuid.NewString(), "completed", "", r.setHash, []string{}))
	_, ack, _ := recvTypedFrame(t, r.stream, "run_finish_ack")
	if ack["state"] != "rejected" || ack["code"] != "finish_precondition_failed" {
		t.Fatalf("ack = %#v, want rejected/finish_precondition_failed", ack)
	}
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "active" {
		t.Fatalf("Run state = %q, want the untouched active", got)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.device_run_finish WHERE org_id=$1 AND run_id=$2::uuid AND state='rejected'`, gwOrg, r.runID); got != "1" {
		t.Fatalf("rejected evidence rows = %s, want 1", got)
	}
}

// TestRunFinishRejectsBadSignature proves the gateway verifies the run_finish ES256 signature
// over the wire body before the domain command: a tampered signature is UNAUTHENTICATED and no
// verdict row is written.
func TestRunFinishRejectsBadSignature(t *testing.T) {
	r := startRunForFinish(t)
	body := r.finishBody(uuid.NewString(), "failed", "model_error", r.setHash, []string{})
	signed := r.f.signFrame(t, "run_finish", r.sessionID, r.bootID, r.agentID, body)

	var env map[string]json.RawMessage
	if err := json.Unmarshal(signed, &env); err != nil {
		t.Fatal(err)
	}
	var inner map[string]any
	if err := json.Unmarshal(env["body"], &inner); err != nil {
		t.Fatal(err)
	}
	inner["signature"] = strings.Repeat("A", 86)
	env["body"], _ = json.Marshal(inner)
	tampered, _ := json.Marshal(env)
	if err := r.stream.SendMsg(tampered); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, r.stream.RecvMsg(&raw), codes.Unauthenticated)
	if got := r.scalar(t, `SELECT count(*)::text FROM work.device_run_finish WHERE org_id=$1 AND run_id=$2::uuid`, gwOrg, r.runID); got != "0" {
		t.Fatalf("a bad signature wrote %s verdict rows, want 0", got)
	}
}

// TestRunFinishRejectsBadShape proves the closed body is parsed before any domain command: a
// non-UUID lease id, a non-decimal checkpoint seq, a non-array deliverable list and an explicit
// null list are all invalid_request. No Run or lease is seeded — the shape gate runs first, so
// nothing downstream is reachable, and each case gets its own stream because a refusal
// terminates it.
func TestRunFinishRejectsBadShape(t *testing.T) {
	bad := []map[string]any{
		{"finish_id": uuid.NewString(), "run_id": uuid.NewString(), "binding_revision": "1",
			"fence": "1", "lease_id": "not-a-uuid", "outcome": "failed", "reason_code": "model_error",
			"final_checkpoint_seq": "0", "final_checkpoint_hash": strings.Repeat("a", 64),
			"receipt_through_seq": "0", "final_operation_set_hash": strings.Repeat("b", 64),
			"deliverable_versions": []string{}},
		{"finish_id": uuid.NewString(), "run_id": uuid.NewString(), "binding_revision": "1",
			"fence": "1", "lease_id": uuid.NewString(), "outcome": "failed", "reason_code": "model_error",
			"final_checkpoint_seq": "not-a-seq", "final_checkpoint_hash": strings.Repeat("a", 64),
			"receipt_through_seq": "0", "final_operation_set_hash": strings.Repeat("b", 64),
			"deliverable_versions": []string{}},
		{"finish_id": uuid.NewString(), "run_id": uuid.NewString(), "binding_revision": "1",
			"fence": "1", "lease_id": uuid.NewString(), "outcome": "failed", "reason_code": "model_error",
			"final_checkpoint_seq": "0", "final_checkpoint_hash": strings.Repeat("a", 64),
			"receipt_through_seq": "0", "final_operation_set_hash": strings.Repeat("b", 64),
			"deliverable_versions": "not-an-array"},
		// An explicit null is a shape error too: SQL's validator only checks key presence, so
		// letting it through would reach the table CHECK and surface as service_degraded.
		{"finish_id": uuid.NewString(), "run_id": uuid.NewString(), "binding_revision": "1",
			"fence": "1", "lease_id": uuid.NewString(), "outcome": "failed", "reason_code": "model_error",
			"final_checkpoint_seq": "0", "final_checkpoint_hash": strings.Repeat("a", 64),
			"receipt_through_seq": "0", "final_operation_set_hash": strings.Repeat("b", 64),
			"deliverable_versions": nil},
	}
	for _, body := range bad {
		f := newGatewayFixture(t)
		addr := f.startServer(t)
		stream := f.connect(t, addr)
		sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
		if err := stream.SendMsg(f.signFrame(t, "run_finish", sessionID, bootID, agentID, body)); err != nil {
			t.Fatal(err)
		}
		var raw []byte
		wantCode(t, stream.RecvMsg(&raw), codes.InvalidArgument)
	}
}

// TestRunFinishVerbatimReplayUnderNewSessionReaccepts is the batch-5 ruling-甲 restart-replay proof:
// a restart mints a NEW session (0040 activate_device_session always supersedes), and the durable finish
// the device re-uploads verbatim (same finish_id, same signed bytes) is RE-ACCEPTED — 0053's idempotency
// lookup by (org, run, finish_id) precedes the lease/session gate, so the stored verdict replays regardless
// of the calling session. The ack business fields are identical (only the server signature differs). This
// is the server-side truth behind the device's reconcile replay (lib-proven) and the real-exe restart.
func TestRunFinishVerbatimReplayUnderNewSessionReaccepts(t *testing.T) {
	r := startRunForFinish(t)
	f := r.f
	// A finish accepted under session 1 — the durable proposal a restart would replay verbatim.
	finishID := uuid.NewString()
	verbatim := f.signFrame(t, "run_finish", r.sessionID, r.bootID, r.agentID,
		r.finishBody(finishID, "failed", "model_error", r.setHash, []string{}))
	if err := r.stream.SendMsg(verbatim); err != nil {
		t.Fatal(err)
	}
	_, ack, _ := recvTypedFrame(t, r.stream, "run_finish_ack")
	if ack["state"] != "accepted" || ack["finish_id"] != finishID {
		t.Fatalf("session-1 finish = %#v, want accepted %s", ack, finishID)
	}
	// Restart: a fresh ticket + hello mints session 2, superseding session 1.
	ticket2 := uuid.NewString()
	f.seedSecondTicket(t, ticket2)
	stream2 := f.connect(t, r.addr)
	session2, _, _, _ := f.helloWithTicket(t, stream2, ticket2)
	if session2 == r.sessionID {
		t.Fatalf("hello reused session %s; a restart must mint a new one", session2)
	}
	// Re-upload the SAME signed bytes verbatim on the new session: the idempotency lookup replays the
	// stored accepted verdict (same finish_id, same business fields), never a fresh adjudication.
	if err := stream2.SendMsg(verbatim); err != nil {
		t.Fatal(err)
	}
	_, replay, replaySession := recvTypedFrame(t, stream2, "run_finish_ack")
	if replaySession != session2 {
		t.Fatalf("replay ack session = %v, want the new session %s", replaySession, session2)
	}
	if replay["state"] != "accepted" || replay["finish_id"] != finishID {
		t.Fatalf("verbatim replay = %#v, want accepted %s", replay, finishID)
	}
	delete(ack, "signature")
	delete(replay, "signature")
	if !reflect.DeepEqual(ack, replay) {
		t.Fatalf("cross-session replay changed business fields: %#v vs %#v", ack, replay)
	}
}
