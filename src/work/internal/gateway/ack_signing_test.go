package gateway_test

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/grpc"

	"github.com/we-meet/work/internal/devicesig"
)

// recvFrameRaw reads one server-originated frame and returns its type, raw body and
// decoded body (the raw body is what the signature covers once the signature is
// stripped, so signature verification needs it).
func recvFrameRaw(t *testing.T, stream grpc.ClientStream) (frameType string, bodyJSON []byte, body map[string]any) {
	t.Helper()
	var raw []byte
	if err := stream.RecvMsg(&raw); err != nil {
		t.Fatalf("recv frame: %v", err)
	}
	var env struct {
		Type string          `json:"type"`
		Body json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(env.Body, &body); err != nil {
		t.Fatal(err)
	}
	return env.Type, env.Body, body
}

// helloWithServerJWK runs hello and returns the allocated session, the fixed identity,
// and the parsed server signing public key from hello_ack — the key the device uses to
// verify server-signed downlink acks.
func (f *gwFixture) helloWithServerJWK(t *testing.T, stream grpc.ClientStream) (sessionID, journalEpoch, bootID, agentID string, generation int64, serverPub *devicesig.PublicKey) {
	t.Helper()
	sessionID, journalEpoch, bootID, agentID, generation, serverPub, _ = f.helloWithBothJWKs(t, stream)
	return sessionID, journalEpoch, bootID, agentID, generation, serverPub
}

// helloWithBothJWKs is helloWithServerJWK plus the INDEPENDENT permit key (GW14). §3.3 requires
// a separate permit signing key, so hello_ack carries two: server_public_jwk for frames and
// permit_public_jwk for the nested permit document of a command. A test that only checks frames
// must not accidentally accept a permit signed by the frame key, which is why both are returned.
func (f *gwFixture) helloWithBothJWKs(t *testing.T, stream grpc.ClientStream) (sessionID, journalEpoch, bootID, agentID string, generation int64, serverPub, permitPub *devicesig.PublicKey) {
	t.Helper()
	journalEpoch = uuid.NewString()
	bootID = "boot-" + uuid.NewString()
	agentID = uuid.NewString()
	if err := stream.SendMsg(f.signHelloIdentity(t, f.ticket, journalEpoch, bootID, agentID)); err != nil {
		t.Fatal(err)
	}
	ack := recvAck(t, stream)
	sessionID, _ = ack["_session_id"].(string)
	if sessionID == "" {
		t.Fatalf("hello_ack gave no session: %#v", ack)
	}
	if g, ok := ack["generation"].(float64); ok {
		generation = int64(g)
	}
	parse := func(member string) *devicesig.PublicKey {
		raw, err := json.Marshal(ack[member])
		if err != nil {
			t.Fatal(err)
		}
		pub, err := devicesig.ParseJWK(raw)
		if err != nil {
			t.Fatalf("hello_ack %s does not parse: %v", member, err)
		}
		return pub
	}
	serverPub = parse("server_public_jwk")
	permitPub = parse("permit_public_jwk")
	if serverPub.Thumbprint == permitPub.Thumbprint {
		t.Fatal("hello_ack distributed the SAME key twice: the permit key must be independent")
	}
	return sessionID, journalEpoch, bootID, agentID, generation, serverPub, permitPub
}

// TestReceiptAckIsServerSigned proves the receipt_ack downlink is now ES256-signed by
// the gateway server key (GW8): the device verifies it against the hello_ack JWK, and
// a receipt_ack signature does not verify under the reconcile_ack frame type.
func TestReceiptAckIsServerSigned(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation, serverPub := f.helloWithServerJWK(t, stream)
	runID, opID, attemptID, fence := f.seedAction(t, sessionID)

	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	if err := stream.SendMsg(f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)); err != nil {
		t.Fatal(err)
	}
	frameType, bodyJSON, body := recvFrameRaw(t, stream)
	if frameType != "receipt_ack" {
		t.Fatalf("frame type = %q, want receipt_ack", frameType)
	}
	sig, _ := body["signature"].(string)
	if sig == "" {
		t.Fatalf("receipt_ack carries no server signature: %#v", body)
	}
	if !devicesig.VerifyFrame(serverPub, "receipt_ack", bodyJSON, sig) {
		t.Fatal("device could not verify receipt_ack signature against hello_ack JWK")
	}
	if devicesig.VerifyFrame(serverPub, "reconcile_ack", bodyJSON, sig) {
		t.Fatal("receipt_ack signature verified under the reconcile_ack frame type")
	}
}

// TestReconcileAckIsServerSigned proves the reconcile_ack downlink is server-signed over
// its own frame type (GW8), so a receipt_ack signature never verifies here. An empty
// batch is enough to exercise the signed ack path.
func TestReconcileAckIsServerSigned(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, serverPub := f.helloWithServerJWK(t, stream)

	body := map[string]any{
		"original_run_id":      uuid.NewString(),
		"journal_epoch":        uuid.NewString(),
		"from_seq":             "5",
		"signed_receipt_bytes": []string{},
		"last_receipt_seq":     "0",
	}
	if err := stream.SendMsg(f.unsignedFrame(t, "reconcile", sessionID, bootID, agentID, body)); err != nil {
		t.Fatal(err)
	}
	frameType, bodyJSON, bodyOut := recvFrameRaw(t, stream)
	if frameType != "reconcile_ack" {
		t.Fatalf("frame type = %q, want reconcile_ack", frameType)
	}
	sig, _ := bodyOut["signature"].(string)
	if sig == "" {
		t.Fatalf("reconcile_ack carries no server signature: %#v", bodyOut)
	}
	if !devicesig.VerifyFrame(serverPub, "reconcile_ack", bodyJSON, sig) {
		t.Fatal("device could not verify reconcile_ack signature against hello_ack JWK")
	}
	if devicesig.VerifyFrame(serverPub, "receipt_ack", bodyJSON, sig) {
		t.Fatal("reconcile_ack signature verified under the receipt_ack frame type")
	}
}