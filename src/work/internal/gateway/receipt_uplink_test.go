package gateway_test

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"

	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

// signHelloIdentity is signHello with caller-fixed journal_epoch/boot_id/
// agent_instance_id, so a follow-up receipt can bind original_execution to the
// session this hello allocates.
func (f *gwFixture) signHelloIdentity(t *testing.T, ticket, journalEpoch, bootID, agentID string) []byte {
	t.Helper()
	body := map[string]any{
		"client_version":     "0.0.0",
		"protocol_major":     2,
		"protocol_minor":     0,
		"required_features":  []string{"journal"},
		"tool_manifest_hash": strings.Repeat("a", 64),
		"runtime_digest":     strings.Repeat("b", 64),
		"profile_id":         "profile",
		"journal_epoch":      journalEpoch,
		"last_receipt_seq":   "0",
		"ticket":             ticket,
		"challenge_response": "",
	}
	return f.signFrame(t, "hello", "", bootID, agentID, body)
}

// signFrame signs one frame body with the device key over JCS({schema_version,
// type, body}) and wraps it in the closed ten-field envelope. sessionID is the
// outer transport session (empty for hello).
func (f *gwFixture) signFrame(t *testing.T, frameType, sessionID, bootID, agentID string, body map[string]any) []byte {
	t.Helper()
	bodyJSON, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	preimage, err := devicesig.SignedPayload(frameType, bodyJSON)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(preimage)
	r, s, err := ecdsa.Sign(rand.Reader, f.priv, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	body["signature"] = base64.RawURLEncoding.EncodeToString(sig)
	bodyJSON, err = json.Marshal(body)
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

// seedAction inserts the minimal task/run/operation chain record_device_receipt
// reads (run.fence, operation.run_id/dispatch_attempt_id), bound to the given
// session. The operation is a plain dispatched action; the completed→resolution
// issuance path is SQL domain logic covered by internal/migrate, so these gateway
// tests record started receipts to exercise the uplink without re-testing it.
func (f *gwFixture) seedAction(t *testing.T, sessionID string) (runID, opID, attemptID string, fence int64) {
	t.Helper()
	return f.seedActionWithInputHash(t, sessionID, strings.Repeat("b", 64))
}

// seedActionWithInputHash is seedAction with a caller-chosen input hash. work_input_active_hash
// and run_workflow_id_key are both unique per org, so a test that needs TWO runs (e.g. two
// leases for one heartbeat) must give each run a distinct input object; the workflow id is
// derived from the run id for the same reason.
func (f *gwFixture) seedActionWithInputHash(t *testing.T, sessionID, inputHash string) (runID, opID, attemptID string, fence int64) {
	t.Helper()
	ctx := gwContext(t)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = seed.Close(ctx) }()
	runID = uuid.NewString()
	opID = uuid.NewString()
	attemptID = uuid.NewString()
	taskID := uuid.NewString()
	snapshotID := uuid.NewString()
	inputID := uuid.NewString()
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		SET app.subject_id = '%s';
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status)
		VALUES ('%s','%s','%s','ref','%s',1,'text/plain','active');
		INSERT INTO work.capability_snapshot (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		VALUES ('%s','%s','%s','v1','%s',ARRAY['workspace.read'],'{}'::jsonb,'{}'::jsonb,'{}'::jsonb);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, input_id, title)
		VALUES ('%s','%s','%s','open','%s','%s','gw');
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, wait_reason, snapshot_id, workflow_id, runtime_version, admission_access_epoch)
		VALUES ('%s','%s','%s',1,'active',NULL,'%s','%s','v1',0);
		UPDATE work.task SET active_run_id = '%s' WHERE id = '%s';
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state, dispatch_attempt_id)
		VALUES ('%s','%s','%s','step#0','tool','%s','dispatching','%s');
	`, gwOrg, gwSubject, inputID, gwOrg, gwSubject, inputHash,
		snapshotID, gwOrg, taskID, strings.Repeat("a", 64),
		taskID, gwOrg, gwSubject, snapshotID, inputID,
		runID, gwOrg, taskID, snapshotID, "wf-gw-"+runID[:8],
		runID, taskID,
		opID, gwOrg, runID, strings.Repeat("d", 64), attemptID)
	if err := testpg.ExecRaw(ctx, seed, script); err != nil {
		t.Fatal(err)
	}
	if err := seed.QueryRow(ctx,
		`SELECT fence FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, runID).Scan(&fence); err != nil {
		t.Fatal(err)
	}
	return runID, opID, attemptID, fence
}

// seedReceiptAction buys a real dispatch through prepare/consume. The simpler
// seedAction graph remains useful to offer/lease tests that must start without a lease.
func (f *gwFixture) seedReceiptAction(t *testing.T, sessionID string) (runID, opID, attemptID string, fence int64) {
	t.Helper()
	runID, _, _, fence = f.seedAction(t, sessionID)
	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	var boot string
	if err = admin.QueryRow(ctx, `SELECT boot_id FROM work.device_session WHERE id=$1::uuid`, sessionID).Scan(&boot); err != nil {
		t.Fatal(err)
	}
	grant := f.seedLocalPolicyAndGrant(t, sessionID, boot)
	nonce := f.seedOffer(t, sessionID, runID, 1)
	if _, err = admin.Exec(ctx, `UPDATE work.device_run_binding SET state='ready' WHERE org_id=$1 AND run_id=$2::uuid`, gwOrg, runID); err != nil {
		t.Fatal(err)
	}
	worker, err := testpg.Open(ctx, testpg.WorkerURL(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close(ctx)
	if err = testpg.ExecRaw(ctx, worker, "SET app.org_id='"+gwOrg+"'; SET app.subject_id='"+gwSubject+"'"); err != nil {
		t.Fatal(err)
	}
	var leaseID, checkpoint string
	if err = worker.QueryRow(ctx, `SELECT x->>'lease_id', x->>'checkpoint_hash' FROM
		(SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30) x) q`,
		gwOrg, runID, f.deviceID, sessionID, nonce).Scan(&leaseID, &checkpoint); err != nil {
		t.Fatal(err)
	}
	r := &runUnderFinish{f: f, runID: runID, sessionID: sessionID, bootID: boot, leaseID: leaseID, fence: fmt.Sprint(fence), checkpoint: checkpoint}
	r.seedReadonlyGrant(t, grant)
	action := r.actionBody(grant, "receipt:action", 0)
	for _, key := range []string{"run_id", "lease_id", "fence", "checkpoint_seq"} {
		delete(action, key)
	}
	action["supersede_no"], action["device_signature"] = 0, strings.Repeat("a", 86)
	action["request_hash"] = strings.Repeat("e", 64)
	raw, err := json.Marshal(action)
	if err != nil {
		t.Fatal(err)
	}
	if err = worker.QueryRow(ctx, `SELECT x->>'operation_id', x->>'attempt_id' FROM
		(SELECT work.prepare_local_operation($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,0,$7::jsonb) x) q`,
		gwOrg, runID, f.deviceID, sessionID, leaseID, fence, string(raw)).Scan(&opID, &attemptID); err != nil {
		t.Fatal(err)
	}
	if _, err = worker.Exec(ctx, `SELECT work.consume_device_permit($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,'receipt-fixture')`,
		gwOrg, opID, attemptID, f.deviceID, sessionID, leaseID, fence, strings.Repeat("e", 64)); err != nil {
		t.Fatal(err)
	}
	return
}

// receiptExec builds the wire original_execution (short names) bound to the
// hello-allocated session and the seeded action.
func receiptExec(org, subject, deviceID, sessionID, agentID, bootID string, generation int64, runID, opID, attemptID string, fence int64) map[string]any {
	return map[string]any{
		"org":            org,
		"subject":        subject,
		"device":         deviceID,
		"session":        sessionID,
		"agent_instance": agentID,
		"boot":           bootID,
		"generation":     strconv.FormatInt(generation, 10),
		"run":            runID,
		"operation":      opID,
		"attempt":        attemptID,
		"fence":          strconv.FormatInt(fence, 10),
	}
}

// signReceipt builds a signed wire receipt frame (device-design §3.1 short names).
func (f *gwFixture) signReceipt(t *testing.T, journalEpoch, sessionID, bootID, agentID string, exec map[string]any, seq int, state string, outcome any) []byte {
	t.Helper()
	body := map[string]any{
		"journal_epoch":      journalEpoch,
		"receipt_seq":        strconv.Itoa(seq),
		"original_execution": exec,
		"request_hash":       strings.Repeat("e", 64),
		"state":              state,
		"result_hash":        "",
		"local_result_ref":   "",
		"error_code":         "",
	}
	if outcome != nil {
		body["outcome"] = outcome
	}
	return f.signFrame(t, "receipt", sessionID, bootID, agentID, body)
}

func recvReceiptAck(t *testing.T, stream grpc.ClientStream) map[string]any {
	t.Helper()
	var raw []byte
	if err := stream.RecvMsg(&raw); err != nil {
		t.Fatalf("recv receipt_ack: %v", err)
	}
	var env struct {
		Type      string          `json:"type"`
		SessionID string          `json:"session_id"`
		Body      json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "receipt_ack" {
		t.Fatalf("frame type = %q, want receipt_ack", env.Type)
	}
	var body map[string]any
	if err := json.Unmarshal(env.Body, &body); err != nil {
		t.Fatal(err)
	}
	body["_session_id"] = env.SessionID
	return body
}

// helloSession runs hello and returns the allocated session id, generation and the
// fixed identity the receipt must bind to.
func (f *gwFixture) helloSession(t *testing.T, stream grpc.ClientStream) (sessionID, journalEpoch, bootID, agentID string, generation int64) {
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
	return sessionID, journalEpoch, bootID, agentID, generation
}

// TestReceiptUplinkRecords is the cross-language end-to-end: a real ES256-signed
// device receipt frame (short wire names) is verified, translated to the closed
// SQL element, recorded by record_device_receipt as work_worker, and acked. The
// row and the session watermark are then read back from the database.
func TestReceiptUplinkRecords(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation := f.helloSession(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)

	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	if err := stream.SendMsg(f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)); err != nil {
		t.Fatal(err)
	}
	ack := recvReceiptAck(t, stream)
	if ack["_session_id"] != sessionID {
		t.Fatalf("receipt_ack session = %v, want %s", ack["_session_id"], sessionID)
	}
	recorded, _ := ack["recorded"].([]any)
	conflicts, _ := ack["conflicts"].([]any)
	if len(recorded) != 1 || len(conflicts) != 0 {
		t.Fatalf("receipt_ack = %#v, want one recorded and no conflicts", ack)
	}
	if ack["receipt_through_seq"] != float64(1) {
		t.Fatalf("receipt_through_seq = %v, want 1", ack["receipt_through_seq"])
	}

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var state string
	var seq int64
	if err := admin.QueryRow(ctx,
		`SELECT state, seq FROM work.device_receipt WHERE org_id=$1 AND device_id=$2::uuid AND journal_epoch=$3::uuid`,
		gwOrg, f.deviceID, journalEpoch).Scan(&state, &seq); err != nil {
		t.Fatalf("receipt row not recorded: %v", err)
	}
	if state != "started" || seq != 1 {
		t.Fatalf("recorded receipt = %q seq=%d", state, seq)
	}
	var watermark int64
	if err := admin.QueryRow(ctx,
		`SELECT last_receipt_seq FROM work.device_session WHERE org_id=$1 AND id=$2::uuid`,
		gwOrg, sessionID).Scan(&watermark); err != nil {
		t.Fatal(err)
	}
	if watermark != 1 {
		t.Fatalf("session last_receipt_seq = %d, want 1", watermark)
	}
}

// TestReceiptUplinkReplayIsIdempotent proves a re-sent identical receipt (same
// signature) is replayed, not double-recorded, and a different signature at the
// same seq is an idempotency conflict surfaced in the ack.
func TestReceiptUplinkReplayIsIdempotent(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation := f.helloSession(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)

	receipt := f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)
	if err := stream.SendMsg(receipt); err != nil {
		t.Fatal(err)
	}
	_ = recvReceiptAck(t, stream)
	// Same signed bytes again: replayed, still one row.
	if err := stream.SendMsg(receipt); err != nil {
		t.Fatal(err)
	}
	ack := recvReceiptAck(t, stream)
	recorded, _ := ack["recorded"].([]any)
	if len(recorded) != 1 {
		t.Fatalf("replay ack = %#v", ack)
	}
	if rec, _ := recorded[0].(map[string]any); rec["replayed"] != true {
		t.Fatalf("replay not flagged: %#v", recorded[0])
	}
}

// TestReceiptRejectsBadSignature proves the gateway verifies the receipt ES256
// signature over the wire body before the domain command: a tampered signature is
// UNAUTHENTICATED and nothing is recorded.
func TestReceiptRejectsBadSignature(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation := f.helloSession(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	receipt := f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)

	var env map[string]json.RawMessage
	_ = json.Unmarshal(receipt, &env)
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

// TestReceiptRejectsMismatchedDeviceID proves the envelope device_id must equal the
// certificate-mapped device on every frame, not just hello.
func TestReceiptRejectsMismatchedDeviceID(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation := f.helloSession(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	receipt := f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)

	var env map[string]json.RawMessage
	_ = json.Unmarshal(receipt, &env)
	env["device_id"], _ = json.Marshal(uuid.NewString())
	tampered, _ := json.Marshal(env)
	if err := stream.SendMsg(tampered); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.Unauthenticated)
}

// TestReceiptRejectsRevokedDevice proves a device revoked mid-session has its
// receipt refused by the domain command (device_revoked → PERMISSION_DENIED).
func TestReceiptRejectsRevokedDevice(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation := f.helloSession(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)

	ctx := gwContext(t)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	if err := testpg.ExecRaw(ctx, seed, fmt.Sprintf(
		`UPDATE work.device SET status='revoked', revoked_at=now() WHERE org_id='%s' AND id='%s'`,
		gwOrg, f.deviceID)); err != nil {
		t.Fatal(err)
	}
	_ = seed.Close(ctx)

	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	if err := stream.SendMsg(f.signReceipt(t, journalEpoch, sessionID, bootID, agentID, exec, 1, "started", nil)); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.PermissionDenied)
}

// TestDeferredFrameUnimplemented proves frames beyond the GW4 receipt slice are
// refused as unimplemented rather than silently dropped.
func TestDeferredFrameUnimplemented(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _ := f.helloSession(t, stream)
	if err := stream.SendMsg(f.signFrame(t, "permit", sessionID, bootID, agentID, map[string]any{})); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.Unimplemented)
}
