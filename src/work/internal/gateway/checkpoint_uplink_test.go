package gateway_test

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"

	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

// seedCheckpointBinding gives the seeded Run its current device_run_binding (revision 1)
// pointing at the certificate-mapped device and the hello-established session. 0050 binds
// checkpoint recording to that row, so without it every commit is refused.
func (f *gwFixture) seedCheckpointBinding(t *testing.T, sessionID, runID string) {
	t.Helper()
	ctx := gwContext(t)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = seed.Close(ctx) }()
	var taskID string
	if err := seed.QueryRow(ctx,
		`SELECT task_id FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, runID).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		INSERT INTO work.device_run_binding
		  (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
		   input_hash, snapshot_hash, profile_id, profile_revision, runtime_digest,
		   tool_manifest_hash, model_version, grant_set, start_nonce, offer_expiry, state)
		VALUES ('%s','%s',1,'%s','%s','%s','ref','%s','%s','p1',1,'%s','%s','m1',
		        '[{"grant_id":"%s","grant_revision":1}]'::jsonb,'%s',
		        now() + interval '2 minutes','active');
	`, gwOrg, gwOrg, runID, taskID, f.deviceID, sessionID,
		strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64),
		strings.Repeat("5", 64), uuid.NewString(), uuid.NewString())
	if err := testpg.ExecRaw(ctx, seed, script); err != nil {
		t.Fatal(err)
	}
}

// checkpointBody builds the wire checkpoint_commit body: uint64 fields are decimal
// strings, only hashes and an opaque local ref are carried (never ciphertext).
func checkpointBody(runID string, fence int64, seq int, hash string, watermark int) map[string]any {
	return map[string]any{
		"run_id":                     runID,
		"binding_revision":           "1",
		"fence":                      strconv.FormatInt(fence, 10),
		"checkpoint_seq":             strconv.Itoa(seq),
		"checkpoint_hash":            hash,
		"local_checkpoint_ref":       "local/cp",
		"receipt_through_seq":        strconv.Itoa(watermark),
		"pending_operation_set_hash": strings.Repeat("c", 64),
	}
}

// recvCheckpointAck reads one checkpoint_ack and returns its body JSON (the signed
// preimage source), the decoded body and the envelope session id.
func recvCheckpointAck(t *testing.T, stream grpc.ClientStream) (bodyJSON []byte, body map[string]any, sessionID string) {
	t.Helper()
	var raw []byte
	if err := stream.RecvMsg(&raw); err != nil {
		t.Fatalf("recv checkpoint_ack: %v", err)
	}
	var env struct {
		Type      string          `json:"type"`
		SessionID string          `json:"session_id"`
		Body      json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "checkpoint_ack" {
		t.Fatalf("frame type = %q, want checkpoint_ack", env.Type)
	}
	if err := json.Unmarshal(env.Body, &body); err != nil {
		t.Fatal(err)
	}
	return env.Body, body, env.SessionID
}

// TestCheckpointCommitRecordsAndAcksTheWatermark is the GW9 cross-language checkpoint
// round trip: a real ES256-signed checkpoint_commit is verified, translated, recorded
// through 0050, and answered with a server-signed checkpoint_ack whose recorded state
// carries the durable receipt watermark (B03 carrier §3.2). The row and the watermark
// are read back from the database.
func TestCheckpointCommitRecordsAndAcksTheWatermark(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, serverPub := f.helloWithServerJWK(t, stream)
	runID, _, _, fence := f.seedAction(t, sessionID)
	f.seedCheckpointBinding(t, sessionID, runID)

	frame := f.signFrame(t, "checkpoint_commit", sessionID, bootID, agentID,
		checkpointBody(runID, fence, 1, strings.Repeat("1", 64), 7))
	if err := stream.SendMsg(frame); err != nil {
		t.Fatal(err)
	}
	bodyJSON, ack, ackSession := recvCheckpointAck(t, stream)
	if ackSession != sessionID {
		t.Fatalf("checkpoint_ack session = %v, want %s", ackSession, sessionID)
	}
	if ack["run_id"] != runID || ack["state"] != "recorded" {
		t.Fatalf("checkpoint_ack = %#v, want recorded for %s", ack, runID)
	}
	// The two seqs are decimal strings on the wire (SQL returns bigint numbers).
	if ack["checkpoint_seq"] != "1" || ack["receipt_through_seq"] != "7" {
		t.Fatalf("checkpoint_ack seqs = %#v, want decimal strings 1 and 7", ack)
	}
	// The ack is server-signed under its own frame type, and never under another.
	sig, _ := ack["signature"].(string)
	if sig == "" || !devicesig.VerifyFrame(serverPub, "checkpoint_ack", bodyJSON, sig) {
		t.Fatalf("checkpoint_ack signature does not verify against the hello_ack JWK: %#v", ack)
	}
	if devicesig.VerifyFrame(serverPub, "receipt_ack", bodyJSON, sig) {
		t.Fatal("a checkpoint_ack signature verified as receipt_ack (frame type not bound)")
	}

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var state string
	var watermark int64
	if err := admin.QueryRow(ctx,
		`SELECT state, receipt_through_seq FROM work.device_checkpoint
		 WHERE org_id=$1 AND run_id=$2::uuid AND checkpoint_seq=1`,
		gwOrg, runID).Scan(&state, &watermark); err != nil {
		t.Fatal(err)
	}
	if state != "recorded" || watermark != 7 {
		t.Fatalf("stored checkpoint = %s/%d, want recorded/7", state, watermark)
	}
}

// TestCheckpointCommitReplayReturnsTheStoredWatermark proves a lost ack is covered by
// re-sending the identical signed frame: the same message_id is the idempotency key, so
// the second ack is the stored response with the same watermark, and no second row exists.
func TestCheckpointCommitReplayReturnsTheStoredWatermark(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, fence := f.seedAction(t, sessionID)
	f.seedCheckpointBinding(t, sessionID, runID)

	frame := f.signFrame(t, "checkpoint_commit", sessionID, bootID, agentID,
		checkpointBody(runID, fence, 1, strings.Repeat("1", 64), 7))
	for i := 0; i < 2; i++ {
		if err := stream.SendMsg(frame); err != nil {
			t.Fatal(err)
		}
		_, ack, _ := recvCheckpointAck(t, stream)
		if ack["state"] != "recorded" || ack["receipt_through_seq"] != "7" {
			t.Fatalf("attempt %d ack = %#v, want recorded with watermark 7", i+1, ack)
		}
	}
	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var count int64
	if err := admin.QueryRow(ctx,
		`SELECT COUNT(*) FROM work.device_checkpoint WHERE org_id=$1 AND run_id=$2::uuid`,
		gwOrg, runID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("checkpoint rows after replay = %d, want 1", count)
	}
}

// TestCheckpointConflictAckCarriesNoWatermark proves a same-seq-different-hash commit
// parks the Run and answers conflict with watermark 0: a conflict ack releases nothing
// on the device (watermark.rs), and the stored watermark is not rewritten.
func TestCheckpointConflictAckCarriesNoWatermark(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, fence := f.seedAction(t, sessionID)
	f.seedCheckpointBinding(t, sessionID, runID)

	if err := stream.SendMsg(f.signFrame(t, "checkpoint_commit", sessionID, bootID, agentID,
		checkpointBody(runID, fence, 1, strings.Repeat("1", 64), 7))); err != nil {
		t.Fatal(err)
	}
	_, first, _ := recvCheckpointAck(t, stream)
	if first["state"] != "recorded" {
		t.Fatalf("first ack = %#v, want recorded", first)
	}
	if err := stream.SendMsg(f.signFrame(t, "checkpoint_commit", sessionID, bootID, agentID,
		checkpointBody(runID, fence, 1, strings.Repeat("2", 64), 9))); err != nil {
		t.Fatal(err)
	}
	_, conflict, _ := recvCheckpointAck(t, stream)
	if conflict["state"] != "conflict" || conflict["receipt_through_seq"] != "0" {
		t.Fatalf("conflict ack = %#v, want conflict with watermark 0", conflict)
	}

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var runState, waitReason string
	var watermark int64
	if err := admin.QueryRow(ctx,
		`SELECT state, coalesce(wait_reason,'-') FROM work.run WHERE org_id=$1 AND id=$2::uuid`,
		gwOrg, runID).Scan(&runState, &waitReason); err != nil {
		t.Fatal(err)
	}
	if runState != "waiting" || waitReason != "reconcile" {
		t.Fatalf("run after conflict = %s/%s, want waiting/reconcile", runState, waitReason)
	}
	if err := admin.QueryRow(ctx,
		`SELECT receipt_through_seq FROM work.device_checkpoint
		 WHERE org_id=$1 AND run_id=$2::uuid AND checkpoint_seq=1`,
		gwOrg, runID).Scan(&watermark); err != nil {
		t.Fatal(err)
	}
	if watermark != 7 {
		t.Fatalf("conflicted row watermark = %d, want the recorded 7", watermark)
	}
}

// TestCheckpointCommitRejectsBadSignature proves a tampered checkpoint_commit signature
// is refused before any domain command (fail-closed, nothing recorded).
func TestCheckpointCommitRejectsBadSignature(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, fence := f.seedAction(t, sessionID)
	f.seedCheckpointBinding(t, sessionID, runID)

	frame := f.signFrame(t, "checkpoint_commit", sessionID, bootID, agentID,
		checkpointBody(runID, fence, 1, strings.Repeat("1", 64), 7))
	var env map[string]json.RawMessage
	_ = json.Unmarshal(frame, &env)
	var body map[string]any
	_ = json.Unmarshal(env["body"], &body)
	body["signature"] = strings.Repeat("A", 86)
	env["body"], _ = json.Marshal(body)
	tampered, _ := json.Marshal(env)

	if err := stream.SendMsg(tampered); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.Unauthenticated)
}

// TestCheckpointCommitRejectsStaleBinding proves the gateway passes the binding_revision
// through and 0050 refuses a superseded one: the Run's current binding is revision 1, so a
// commit naming revision 2 is unauthorized and records nothing.
func TestCheckpointCommitRejectsStaleBinding(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, fence := f.seedAction(t, sessionID)
	f.seedCheckpointBinding(t, sessionID, runID)

	body := checkpointBody(runID, fence, 1, strings.Repeat("1", 64), 7)
	body["binding_revision"] = "2"
	if err := stream.SendMsg(f.signFrame(t, "checkpoint_commit", sessionID, bootID, agentID, body)); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.Unauthenticated)

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var count int64
	if err := admin.QueryRow(ctx,
		`SELECT COUNT(*) FROM work.device_checkpoint WHERE org_id=$1 AND run_id=$2::uuid`,
		gwOrg, runID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("checkpoint rows after a stale-binding refusal = %d, want 0", count)
	}
}

// TestCheckpointCommitRejectsMissingBinding proves a Run with no device_run_binding for
// this device cannot be checkpointed at all (the ownership gate, not a shape check).
func TestCheckpointCommitRejectsMissingBinding(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, fence := f.seedAction(t, sessionID)

	if err := stream.SendMsg(f.signFrame(t, "checkpoint_commit", sessionID, bootID, agentID,
		checkpointBody(runID, fence, 1, strings.Repeat("1", 64), 7))); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.Unauthenticated)
}