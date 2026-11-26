package gateway_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"

	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

// seedPendingResolution binds the seeded action's Run to the fixture device on the
// hello-allocated session and inserts one un-acked resolution on the operation. The
// getter targets by device_id through the latest binding, so the push after a receipt
// delivers this conclusion. The row is written directly (how a conclusion is issued is
// issue_operation_resolution's concern, covered in internal/migrate).
func (f *gwFixture) seedPendingResolution(t *testing.T, sessionID, runID, opID, code, usageSource string) (resolveID string) {
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
	resolveID = uuid.NewString()
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		INSERT INTO work.device_run_binding
		  (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
		   input_hash, snapshot_hash, profile_id, profile_revision, runtime_digest,
		   tool_manifest_hash, model_version, grant_set, start_nonce, offer_expiry, state)
		VALUES ('%s','%s',1,'%s','%s','%s','ref','%s','%s','p1',1,'%s','%s','m1',
		        '[{"grant_id":"%s","grant_revision":1}]'::jsonb,'%s',
		        now() + interval '2 minutes','active')
		ON CONFLICT (org_id, run_id, binding_revision) DO NOTHING;
		INSERT INTO work.operation_resolution
		  (org_id, run_id, operation_id, resolution_revision, resolve_id, attempt_id,
		   state, delivery_state, settlement_state, signature, resolution_delivery,
		   code, usage_source)
		VALUES ('%s','%s','%s',1,'%s',NULL,'failed','not_applicable','unknown','sha256:%s','pending',
		        NULLIF('%s',''), NULLIF('%s',''));
	`, gwOrg, gwOrg, runID, taskID, f.deviceID, sessionID,
		strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64),
		strings.Repeat("5", 64), uuid.NewString(), uuid.NewString(),
		gwOrg, runID, opID, resolveID, strings.Repeat("e", 64), code, usageSource)
	if err := testpg.ExecRaw(ctx, seed, script); err != nil {
		t.Fatal(err)
	}
	return resolveID
}

// recvResolution reads one server-originated operation_resolution frame and returns its
// wire body (raw JSON and decoded) plus the envelope session id.
func recvResolution(t *testing.T, stream grpc.ClientStream) (bodyJSON []byte, body map[string]any, sessionID string) {
	t.Helper()
	var raw []byte
	if err := stream.RecvMsg(&raw); err != nil {
		t.Fatalf("recv operation_resolution: %v", err)
	}
	var env struct {
		Type      string          `json:"type"`
		SessionID string          `json:"session_id"`
		DeviceID  string          `json:"device_id"`
		Body      json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "operation_resolution" {
		t.Fatalf("frame type = %q, want operation_resolution", env.Type)
	}
	if err := json.Unmarshal(env.Body, &body); err != nil {
		t.Fatal(err)
	}
	return env.Body, body, env.SessionID
}

// TestResolutionDownlinkPushAndAck is the GW7 cross-language end-to-end: the gateway
// signs an operation_resolution with its server key, the device verifies it against the
// public JWK distributed in hello_ack, and the device's operation_resolution_ack advances
// the delivery watermark through consume_device_ack. The push is triggered after a receipt
// is recorded (the session-establish push finds an empty queue until a binding exists).
func TestResolutionDownlinkPushAndAck(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)

	journalEpoch := uuid.NewString()
	bootID := "boot-" + uuid.NewString()
	agentID := uuid.NewString()
	if err := stream.SendMsg(f.signHelloIdentity(t, f.ticket, journalEpoch, bootID, agentID)); err != nil {
		t.Fatal(err)
	}
	ack := recvAck(t, stream)
	sessionID, _ := ack["_session_id"].(string)
	if sessionID == "" {
		t.Fatalf("hello_ack gave no session: %#v", ack)
	}
	var generation int64
	if g, ok := ack["generation"].(float64); ok {
		generation = int64(g)
	}
	// The server signing public key the device provisions to verify downlink frames.
	jwkJSON, err := json.Marshal(ack["server_public_jwk"])
	if err != nil {
		t.Fatal(err)
	}
	serverPub, err := devicesig.ParseJWK(jwkJSON)
	if err != nil {
		t.Fatalf("hello_ack server_public_jwk does not parse: %v", err)
	}

	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	resolveID := f.seedPendingResolution(t, sessionID, runID, opID, "", "")

	// A started receipt records cleanly and triggers the post-record re-push.
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	if err := stream.SendMsg(f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)); err != nil {
		t.Fatal(err)
	}
	_ = recvReceiptAck(t, stream)

	bodyJSON, body, resSession := recvResolution(t, stream)
	if resSession != sessionID {
		t.Fatalf("resolution session = %q, want %q", resSession, sessionID)
	}
	if body["resolve_id"] != resolveID || body["operation_id"] != opID || body["run_id"] != runID {
		t.Fatalf("resolution identity = %#v", body)
	}
	if body["state"] != "failed" || body["settlement_state"] != "unknown" {
		t.Fatalf("resolution conclusion = %#v", body)
	}
	// resolution_revision is a decimal string on the wire (u64string), not a number.
	if body["resolution_revision"] != "1" {
		t.Fatalf("resolution_revision = %v (%T), want decimal string \"1\"", body["resolution_revision"], body["resolution_revision"])
	}
	// The wire signature is the server's ES256, verifiable against the hello_ack JWK;
	// the SQL sha256 placeholder never rides the frame.
	sig, _ := body["signature"].(string)
	if sig == "" {
		t.Fatalf("resolution carries no server signature: %#v", body)
	}
	if !devicesig.VerifyFrame(serverPub, "operation_resolution", bodyJSON, sig) {
		t.Fatal("device could not verify the server resolution signature against hello_ack JWK")
	}
	// Domain separation: the same signature must not verify under another frame type.
	if devicesig.VerifyFrame(serverPub, "permit", bodyJSON, sig) {
		t.Fatal("resolution signature verified under a different frame type")
	}

	// The device acks applied; the gateway consumes it through consume_device_ack.
	ackBody := map[string]any{"resolve_id": resolveID, "state": "applied"}
	if err := stream.SendMsg(f.signFrame(t, "operation_resolution_ack", sessionID, bootID, agentID, ackBody)); err != nil {
		t.Fatal(err)
	}
	// The ack has no response frame, so synchronize on a follow-up receipt: the server
	// processes frames in order, so its receipt_ack proves the ack already committed.
	// The post-record re-push now finds an empty queue (the resolution is acked).
	if err := stream.SendMsg(f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 2, "started", nil)); err != nil {
		t.Fatal(err)
	}
	_ = recvReceiptAck(t, stream)

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var delivery string
	var ackedAtNull bool
	if err := admin.QueryRow(ctx,
		`SELECT resolution_delivery, acked_at IS NULL FROM work.operation_resolution WHERE org_id=$1 AND resolve_id=$2::uuid`,
		gwOrg, resolveID).Scan(&delivery, &ackedAtNull); err != nil {
		t.Fatalf("resolution row not found after ack: %v", err)
	}
	if delivery != "acked" || ackedAtNull {
		t.Fatalf("after ack resolution_delivery=%q acked_at_null=%v, want acked/non-null", delivery, ackedAtNull)
	}
	// The conclusion itself is untouched by the ack (only the watermark moves).
	var state, settlement string
	if err := admin.QueryRow(ctx,
		`SELECT state, settlement_state FROM work.operation_resolution WHERE org_id=$1 AND resolve_id=$2::uuid`,
		gwOrg, resolveID).Scan(&state, &settlement); err != nil {
		t.Fatal(err)
	}
	if state != "failed" || settlement != "unknown" {
		t.Fatalf("ack rewrote the conclusion: state=%q settlement=%q", state, settlement)
	}
}

func TestResolutionDownlinkDegradationKeepsUnknownSettlement(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	journalEpoch := uuid.NewString()
	bootID := "boot-" + uuid.NewString()
	agentID := uuid.NewString()
	if err := stream.SendMsg(f.signHelloIdentity(t, f.ticket, journalEpoch, bootID, agentID)); err != nil {
		t.Fatal(err)
	}
	helloAck := recvAck(t, stream)
	sessionID, _ := helloAck["_session_id"].(string)
	if sessionID == "" {
		t.Fatalf("hello_ack gave no session: %#v", helloAck)
	}
	var generation int64
	if g, ok := helloAck["generation"].(float64); ok {
		generation = int64(g)
	}
	serverJWK, err := json.Marshal(helloAck["server_public_jwk"])
	if err != nil {
		t.Fatal(err)
	}
	serverPub, err := devicesig.ParseJWK(serverJWK)
	if err != nil {
		t.Fatal(err)
	}
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	resolveID := f.seedPendingResolution(t, sessionID, runID, opID, "evidence_unavailable", "unavailable")

	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	if err := stream.SendMsg(f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)); err != nil {
		t.Fatal(err)
	}
	_ = recvReceiptAck(t, stream)
	bodyJSON, body, pushedSession := recvResolution(t, stream)
	if pushedSession != sessionID || body["resolve_id"] != resolveID {
		t.Fatalf("degradation resolution session=%q body=%#v", pushedSession, body)
	}
	if body["state"] != "failed" || body["settlement_state"] != "unknown" ||
		body["code"] != "evidence_unavailable" || body["usage_source"] != "unavailable" {
		t.Fatalf("degradation wire conclusion = %#v", body)
	}
	sig, _ := body["signature"].(string)
	if sig == "" {
		t.Fatalf("degradation resolution has no server signature: %#v", body)
	}
	if !devicesig.VerifyFrame(serverPub, "operation_resolution", bodyJSON, sig) {
		t.Fatal("device could not verify the degradation resolution signature")
	}

	if err := stream.SendMsg(f.signFrame(t, "operation_resolution_ack", sessionID, bootID, agentID,
		map[string]any{"resolve_id": resolveID, "state": "applied"})); err != nil {
		t.Fatal(err)
	}
	if err := stream.SendMsg(f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 2, "started", nil)); err != nil {
		t.Fatal(err)
	}
	_ = recvReceiptAck(t, stream)

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var state, settlement, code, usage string
	var delivery string
	var acked bool
	if err := admin.QueryRow(ctx, `SELECT state, settlement_state, code, usage_source,
		resolution_delivery, acked_at IS NOT NULL
		FROM work.operation_resolution WHERE org_id=$1 AND resolve_id=$2::uuid`,
		gwOrg, resolveID).Scan(&state, &settlement, &code, &usage, &delivery, &acked); err != nil {
		t.Fatal(err)
	}
	if state != "failed" || settlement != "unknown" || code != "evidence_unavailable" ||
		usage != "unavailable" || delivery != "acked" || !acked {
		t.Fatalf("degradation after ack = state:%q settlement:%q code:%q usage:%q delivery:%q acked:%v",
			state, settlement, code, usage, delivery, acked)
	}
}

func TestResolutionDownlinkRepushesUnackedOnReconnect(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	first := f.connect(t, addr)
	session1, journalEpoch, bootID, agentID, generation := f.helloSession(t, first)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, session1)
	resolveID := f.seedPendingResolution(t, session1, runID, opID, "", "")
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, session1, agentID, bootID, generation, runID, opID, attemptID, fence)
	if err := first.SendMsg(f.signReceipt(t, journalEpoch, session1, bootID, agentID, exec, 1, "started", nil)); err != nil {
		t.Fatal(err)
	}
	_ = recvReceiptAck(t, first)
	_, body, pushedSession := recvResolution(t, first)
	if pushedSession != session1 || body["resolve_id"] != resolveID {
		t.Fatalf("first resolution push session=%q body=%#v", pushedSession, body)
	}

	// No operation_resolution_ack is sent. A fresh hello on the same device must push the
	// delivered-but-unacked conclusion before any later downlink, under the NEW session id.
	second := f.connect(t, addr)
	session2, _, _, _ := f.helloWithTicket(t, second, f.mintSecondTicket(t))
	if session2 == session1 {
		t.Fatalf("reconnect reused session %q", session1)
	}
	_, replayed, replaySession := recvResolution(t, second)
	if replaySession != session2 || replayed["resolve_id"] != resolveID {
		t.Fatalf("reconnect resolution session=%q body=%#v", replaySession, replayed)
	}

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	var attempts int
	var delivery string
	var ackedAtNull bool
	if err := admin.QueryRow(ctx, `SELECT delivery_attempts, resolution_delivery, acked_at IS NULL
		FROM work.operation_resolution WHERE org_id=$1 AND resolve_id=$2::uuid`,
		gwOrg, resolveID).Scan(&attempts, &delivery, &ackedAtNull); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 || delivery != "delivered" || !ackedAtNull {
		t.Fatalf("unacked reconnect delivery attempts=%d state=%q acked_at_null=%v", attempts, delivery, ackedAtNull)
	}
}

// TestResolutionAckRejectsBadState proves the gateway lets consume_device_ack enforce the
// closed ack state set: an out-of-set state is refused (invalid_request) and the watermark
// does not move.
func TestResolutionAckRejectsBadState(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation := f.helloSession(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	resolveID := f.seedPendingResolution(t, sessionID, runID, opID, "", "")
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	if err := stream.SendMsg(f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)); err != nil {
		t.Fatal(err)
	}
	_ = recvReceiptAck(t, stream)
	_, _, _ = recvResolution(t, stream)

	ackBody := map[string]any{"resolve_id": resolveID, "state": "bogus"}
	if err := stream.SendMsg(f.signFrame(t, "operation_resolution_ack", sessionID, bootID, agentID, ackBody)); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.InvalidArgument)

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var delivery string
	if err := admin.QueryRow(ctx,
		`SELECT resolution_delivery FROM work.operation_resolution WHERE org_id=$1 AND resolve_id=$2::uuid`,
		gwOrg, resolveID).Scan(&delivery); err != nil {
		t.Fatal(err)
	}
	if delivery != "delivered" {
		t.Fatalf("a refused ack advanced the watermark to %q, want delivered (claim set it, ack refused)", delivery)
	}
}
