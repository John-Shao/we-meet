package gateway_test

import (
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"

	"github.com/we-meet/work/internal/testpg"
)

// unsignedFrame wraps a body in the closed envelope without signing it. The
// reconcile body is not re-signed (each nested receipt keeps its own signature);
// the frame is trusted via the mTLS transport.
func (f *gwFixture) unsignedFrame(t *testing.T, frameType, sessionID, bootID, agentID string, body map[string]any) []byte {
	t.Helper()
	bodyJSON, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]any{
		"schema_version":      2,
		"type":                frameType,
		"message_id":          uuid.NewString(),
		"device_id":           f.deviceID,
		"session_id":          sessionID,
		"agent_instance_id":   agentID,
		"boot_id":             bootID,
		"recovery_generation": "0",
		"sent_at":             time.Now().UTC().Format(time.RFC3339),
		"body":                json.RawMessage(bodyJSON),
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// reconcileFrame nests full original receipt envelopes (base64url, no padding)
// into a reconcile uplink body.
func (f *gwFixture) reconcileFrame(t *testing.T, sessionID, bootID, agentID, runID, journalEpoch string, fromSeq, lastSeq int, nested [][]byte) []byte {
	t.Helper()
	encoded := make([]string, len(nested))
	for i, raw := range nested {
		encoded[i] = base64.RawURLEncoding.EncodeToString(raw)
	}
	body := map[string]any{
		"original_run_id":      runID,
		"journal_epoch":        journalEpoch,
		"from_seq":             strconv.Itoa(fromSeq),
		"signed_receipt_bytes": encoded,
		"last_receipt_seq":     strconv.Itoa(lastSeq),
	}
	return f.unsignedFrame(t, "reconcile", sessionID, bootID, agentID, body)
}

func recvReconcileAck(t *testing.T, stream grpc.ClientStream) map[string]any {
	t.Helper()
	var raw []byte
	if err := stream.RecvMsg(&raw); err != nil {
		t.Fatalf("recv reconcile_ack: %v", err)
	}
	var env struct {
		Type      string          `json:"type"`
		SessionID string          `json:"session_id"`
		Body      json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "reconcile_ack" {
		t.Fatalf("frame type = %q, want reconcile_ack", env.Type)
	}
	var body map[string]any
	if err := json.Unmarshal(env.Body, &body); err != nil {
		t.Fatal(err)
	}
	body["_session_id"] = env.SessionID
	return body
}

// TestReconcileRecordsBatch is the cross-language recovery uplink: two real
// ES256-signed original receipt envelopes nested in a reconcile frame are each
// verified, translated, and recorded as one batch; the rows and watermark are
// read back from the database.
func TestReconcileRecordsBatch(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation := f.helloSession(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)

	r1 := f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)
	r2 := f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 2, "started", nil)
	if err := stream.SendMsg(f.reconcileFrame(t, sessionID, bootID, agentID, runID, journalEpoch, 1, 2, [][]byte{r1, r2})); err != nil {
		t.Fatal(err)
	}
	ack := recvReconcileAck(t, stream)
	if ack["_session_id"] != sessionID {
		t.Fatalf("reconcile_ack session = %v, want %s", ack["_session_id"], sessionID)
	}
	recorded, _ := ack["recorded"].([]any)
	conflicts, _ := ack["conflicts"].([]any)
	if len(recorded) != 2 || len(conflicts) != 0 {
		t.Fatalf("reconcile_ack = %#v, want two recorded and no conflicts", ack)
	}
	if ack["receipt_through_seq"] != float64(2) {
		t.Fatalf("receipt_through_seq = %v, want 2", ack["receipt_through_seq"])
	}

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var count int64
	if err := admin.QueryRow(ctx,
		`SELECT COUNT(*) FROM work.device_receipt WHERE org_id=$1 AND device_id=$2::uuid AND journal_epoch=$3::uuid`,
		gwOrg, f.deviceID, journalEpoch).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("recorded rows = %d, want 2", count)
	}
}

// TestReconcileRejectsBadNestedSignature proves a tampered nested receipt
// signature refuses the whole batch (fail-closed), recording nothing.
func TestReconcileRejectsBadNestedSignature(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation := f.helloSession(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	r1 := f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)

	// Tamper the nested receipt's body signature.
	var env map[string]json.RawMessage
	_ = json.Unmarshal(r1, &env)
	var body map[string]any
	_ = json.Unmarshal(env["body"], &body)
	body["signature"] = strings.Repeat("A", 86)
	env["body"], _ = json.Marshal(body)
	tampered, _ := json.Marshal(env)

	if err := stream.SendMsg(f.reconcileFrame(t, sessionID, bootID, agentID, runID, journalEpoch, 1, 1, [][]byte{tampered})); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.Unauthenticated)
}

// TestReconcileRejectsMismatchedNestedDevice proves a nested envelope whose
// device_id is not the certificate-mapped device is refused.
func TestReconcileRejectsMismatchedNestedDevice(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation := f.helloSession(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	r1 := f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)

	var env map[string]json.RawMessage
	_ = json.Unmarshal(r1, &env)
	env["device_id"], _ = json.Marshal(uuid.NewString())
	tampered, _ := json.Marshal(env)

	if err := stream.SendMsg(f.reconcileFrame(t, sessionID, bootID, agentID, runID, journalEpoch, 1, 1, [][]byte{tampered})); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.Unauthenticated)
}

// TestReconcileEmptyBatchAcks proves an empty reconcile (nothing from from_seq
// onward) is acked without recording, carrying the conservative watermark.
func TestReconcileEmptyBatchAcks(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, _ := f.helloSession(t, stream)
	runID := uuid.NewString()
	if err := stream.SendMsg(f.reconcileFrame(t, sessionID, bootID, agentID, runID, journalEpoch, 1, 0, nil)); err != nil {
		t.Fatal(err)
	}
	ack := recvReconcileAck(t, stream)
	recorded, _ := ack["recorded"].([]any)
	conflicts, _ := ack["conflicts"].([]any)
	if len(recorded) != 0 || len(conflicts) != 0 {
		t.Fatalf("empty reconcile_ack = %#v", ack)
	}
	if ack["receipt_through_seq"] != float64(0) {
		t.Fatalf("receipt_through_seq = %v, want 0 (from_seq-1)", ack["receipt_through_seq"])
	}
}

// TestReconcileOverBatchLimit proves a batch over 100 is RESOURCE_EXHAUSTED
// (device-design §3.1 :105); the ceiling is checked before decoding.
func TestReconcileOverBatchLimit(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, _ := f.helloSession(t, stream)
	runID := uuid.NewString()
	nested := make([][]byte, 101)
	if err := stream.SendMsg(f.reconcileFrame(t, sessionID, bootID, agentID, runID, journalEpoch, 1, 101, nested)); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.ResourceExhausted)
}

// TestReconcileSeqWindowConflict proves an out-of-window nested seq is a
// per-receipt conflict surfaced in the ack (SQL judgment), not a batch refusal.
func TestReconcileSeqWindowConflict(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation := f.helloSession(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	// seq 5 while the window expects 1.
	r5 := f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 5, "started", nil)
	if err := stream.SendMsg(f.reconcileFrame(t, sessionID, bootID, agentID, runID, journalEpoch, 1, 5, [][]byte{r5})); err != nil {
		t.Fatal(err)
	}
	ack := recvReconcileAck(t, stream)
	recorded, _ := ack["recorded"].([]any)
	conflicts, _ := ack["conflicts"].([]any)
	if len(recorded) != 0 || len(conflicts) != 1 {
		t.Fatalf("reconcile_ack = %#v, want one conflict", ack)
	}
	c, _ := conflicts[0].(map[string]any)
	if c["code"] != "receipt_seq_out_of_window" {
		t.Fatalf("conflict = %#v, want receipt_seq_out_of_window", conflicts[0])
	}
}

// TestReconcileJournalEpochMismatch proves a nested receipt whose journal_epoch
// differs from the reconcile body is refused as invalid_request.
func TestReconcileJournalEpochMismatch(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation := f.helloSession(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	otherEpoch := uuid.NewString()
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	r1 := f.signReceipt(t, otherEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)
	if err := stream.SendMsg(f.reconcileFrame(t, sessionID, bootID, agentID, runID, journalEpoch, 1, 1, [][]byte{r1})); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.InvalidArgument)
}
