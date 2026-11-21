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

// Batch 4: the local_publish uplink and the server-signed publish_ack. The Broker names a sealed
// deliverable version and the control plane finalizes it into a published local_only
// artifact_version (0043, work_worker) — the production caller finalize lacked before this batch,
// which is what makes a completed run_finish reachable. These tests cover the gateway's own
// responsibilities (verify → translate → finalize → signed ack, the ownership pin, the shape gate
// and the refusal mapping); finalize's derivation/idempotency domain logic is covered by
// internal/migrate's r0b_local_artifact tests.

// runUnderPublish drives the receipt spine so the device legitimately holds what a publication
// must name: an active Run, a dispatched operation, and a receipt whose local_result_ref and
// device_id bind the version (0043:425-430). finalize does not gate on receipt state, so a started
// receipt carrying local_result_ref is the binding the migrate happy path uses too.
type runUnderPublish struct {
	f            *gwFixture
	stream       grpc.ClientStream
	sessionID    string
	bootID       string
	agentID      string
	serverPub    *devicesig.PublicKey
	runID        string
	opID         string
	journalEpoch string
	localRef     string
	receiptRef   string
}

func startRunForPublish(t *testing.T) *runUnderPublish {
	t.Helper()
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, journalEpoch, bootID, agentID, generation, serverPub := f.helloWithServerJWK(t, stream)
	runID, opID, attemptID, fence := f.seedReceiptAction(t, sessionID)
	localRef := "local/out/report.md"
	exec := receiptExec(gwOrg, gwSubject, f.deviceID, sessionID, agentID, bootID, generation, runID, opID, attemptID, fence)
	body := map[string]any{
		"journal_epoch":      journalEpoch,
		"receipt_seq":        "1",
		"original_execution": exec,
		"request_hash":       strings.Repeat("e", 64),
		"state":              "started",
		"result_hash":        "",
		"local_result_ref":   localRef,
		"error_code":         "",
	}
	if err := stream.SendMsg(f.signFrame(t, "receipt", sessionID, bootID, agentID, body)); err != nil {
		t.Fatal(err)
	}
	ack := recvReceiptAck(t, stream)
	if rec, _ := ack["recorded"].([]any); len(rec) != 1 {
		t.Fatalf("binding receipt not recorded: %#v", ack)
	}
	return &runUnderPublish{f: f, stream: stream, sessionID: sessionID, bootID: bootID,
		agentID: agentID, serverPub: serverPub, runID: runID, opID: opID,
		journalEpoch: journalEpoch, localRef: localRef, receiptRef: journalEpoch + ":1"}
}

// publishBody builds the closed wire local_publish body: the ten-key version payload plus
// run_id/operation_id. artifact_id is null (merge by logical_name, lead ruling 甲 2026-11-21);
// content_hash is bare 64-hex and byte_count a decimal string (§3.1 uint64 boundary).
func (r *runUnderPublish) publishBody(versionID, logicalName, contentHash string) map[string]any {
	return map[string]any{
		"run_id":                 r.runID,
		"operation_id":           r.opID,
		"version_id":             versionID,
		"artifact_id":            nil,
		"logical_name":           logicalName,
		"format":                 "text/markdown",
		"content_hash":           contentHash,
		"byte_count":             "1024",
		"local_ref":              r.localRef,
		"device_id":              r.f.deviceID,
		"classification_claimed": "local_only",
		"receipt_ref":            r.receiptRef,
	}
}

func (r *runUnderPublish) scalar(t *testing.T, sql string, args ...any) string {
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

// TestLocalPublishFinalizesAndServerSigns is the batch-4 round trip: a signed local_publish is
// verified, translated to the closed ten-key version (device_id pinned to the caller), finalized
// into a published local_only artifact_version, and answered with a server-signed publish_ack the
// device can attribute. The write set is read back, and a re-send of the same signed bytes replays
// (finalize is idempotent by version_id, 0043:543) rather than minting a second version.
func TestLocalPublishFinalizesAndServerSigns(t *testing.T) {
	r := startRunForPublish(t)
	f := r.f
	versionID := uuid.NewString()
	contentHash := strings.Repeat("c", 64)
	signed := f.signFrame(t, "local_publish", r.sessionID, r.bootID, r.agentID,
		r.publishBody(versionID, "reports/final.md", contentHash))
	if err := r.stream.SendMsg(signed); err != nil {
		t.Fatal(err)
	}
	bodyJSON, ack, ackSession := recvTypedFrame(t, r.stream, "publish_ack")
	if ackSession != r.sessionID {
		t.Fatalf("publish_ack session = %v, want %s", ackSession, r.sessionID)
	}
	if ack["version_id"] != versionID || ack["location"] != "local_only" || ack["classification"] != "local_only" {
		t.Fatalf("publish_ack = %#v, want the published local_only version", ack)
	}
	if ack["version_no"] != "1" {
		t.Fatalf("version_no = %v, want the decimal string 1", ack["version_no"])
	}
	if ack["run_id"] != r.runID || ack["operation_id"] != r.opID {
		t.Fatalf("publish_ack did not echo the Run/operation: %#v", ack)
	}
	if artifactID, _ := ack["artifact_id"].(string); artifactID == "" {
		t.Fatalf("publish_ack carries no merged artifact_id: %#v", ack)
	}
	if ack["publish_ack"] == nil || ack["publish_ack"] == "" {
		t.Fatalf("publish_ack carries no publication token: %#v", ack)
	}
	// The closed eight-key body plus the server signature; the internal derivation evidence and
	// the replayed fact are dropped (GW9 precedent).
	if len(ack) != 9 {
		t.Fatalf("ack body = %#v, want exactly eight business keys plus signature", ack)
	}
	for _, absent := range []string{"classification_derivation", "replayed", "hash", "bytes"} {
		if _, leaked := ack[absent]; leaked {
			t.Fatalf("ack leaked the internal %s: %#v", absent, ack)
		}
	}
	sig, _ := ack["signature"].(string)
	if sig == "" || !devicesig.VerifyFrame(r.serverPub, "publish_ack", bodyJSON, sig) {
		t.Fatalf("ack signature does not verify against the hello_ack JWK: %#v", ack)
	}
	for _, other := range []string{"local_publish", "run_finish_ack", "receipt_ack"} {
		if devicesig.VerifyFrame(r.serverPub, other, bodyJSON, sig) {
			t.Fatalf("a publish_ack signature verified as %s (frame type not bound)", other)
		}
	}

	// The write set finalize_local_artifact owns (0043): a published local_only version with no
	// remote content_ref, its local replica, and the one derivation audit row.
	if got := r.scalar(t, `SELECT state || '/' || location || '/' || (content_ref IS NULL)::text || '/' || classification
		FROM work.artifact_version WHERE org_id=$1 AND version_id=$2::uuid`, gwOrg, versionID); got != "published/local_only/true/local_only" {
		t.Fatalf("version row = %q, want published/local_only/true/local_only", got)
	}
	if got := r.scalar(t, `SELECT (provenance ->> 'run_id') || '/' || (provenance ->> 'operation_id')
		FROM work.artifact_version WHERE org_id=$1 AND version_id=$2::uuid`, gwOrg, versionID); got != r.runID+"/"+r.opID {
		t.Fatalf("version provenance = %q, want the Run/operation it was finalized from", got)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.artifact_replica WHERE org_id=$1`, gwOrg); got != "1" {
		t.Fatalf("replica rows = %s, want 1", got)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.audit_event WHERE org_id=$1 AND action='artifact.local_finalize'`, gwOrg); got != "1" {
		t.Fatalf("finalize audit rows = %s, want 1", got)
	}

	// A lost ack is repaired by re-sending the SAME signed bytes: finalize replays the existing
	// version (same artifact+hash+run), the business fields are unchanged, and no second version
	// or replica appears.
	if err := r.stream.SendMsg(signed); err != nil {
		t.Fatal(err)
	}
	_, replay, _ := recvTypedFrame(t, r.stream, "publish_ack")
	delete(ack, "signature")
	delete(replay, "signature")
	if !reflect.DeepEqual(ack, replay) {
		t.Fatalf("replay changed business fields: %#v vs %#v", ack, replay)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.artifact_version WHERE org_id=$1`, gwOrg); got != "1" {
		t.Fatalf("version rows after a replay = %s, want still 1", got)
	}
}

// TestLocalPublishRejectsForeignDevice proves the gateway pins the version's device_id to the
// certificate-mapped caller: a body claiming another device is invalid_request before finalize, so
// a device cannot publish under a foreign identity (finalize's receipt cross-check is the second
// line, 0043:428). No artifact row is written.
func TestLocalPublishRejectsForeignDevice(t *testing.T) {
	r := startRunForPublish(t)
	body := r.publishBody(uuid.NewString(), "reports/final.md", strings.Repeat("c", 64))
	body["device_id"] = uuid.NewString() // not the cert-mapped caller
	if err := r.stream.SendMsg(r.f.signFrame(t, "local_publish", r.sessionID, r.bootID, r.agentID, body)); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, r.stream.RecvMsg(&raw), codes.InvalidArgument)
	if got := r.scalar(t, `SELECT count(*)::text FROM work.artifact_version WHERE org_id=$1`, gwOrg); got != "0" {
		t.Fatalf("a foreign-device claim wrote %s versions, want 0", got)
	}
}

// TestLocalPublishRejectsBadSignature proves the gateway verifies the local_publish ES256 signature
// over the wire body before the domain command: a tampered signature is UNAUTHENTICATED and nothing
// is finalized.
func TestLocalPublishRejectsBadSignature(t *testing.T) {
	r := startRunForPublish(t)
	signed := r.f.signFrame(t, "local_publish", r.sessionID, r.bootID, r.agentID,
		r.publishBody(uuid.NewString(), "reports/final.md", strings.Repeat("c", 64)))
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
	if got := r.scalar(t, `SELECT count(*)::text FROM work.artifact_version WHERE org_id=$1`, gwOrg); got != "0" {
		t.Fatalf("a bad signature wrote %s versions, want 0", got)
	}
}

// TestLocalPublishMapsFinalizeRefusal proves a domain refusal travels as the mapped gRPC status, not
// service_degraded: an unreconciled operation on the Run makes finalize raise
// run_has_unreconciled_operation (0043:441), which errors.go maps to FAILED_PRECONDITION — the
// device must wait for reconciliation, not reconnect.
func TestLocalPublishMapsFinalizeRefusal(t *testing.T) {
	r := startRunForPublish(t)
	ctx := gwContext(t)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(r.f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	if err := testpg.ExecRaw(ctx, seed, `SET app.org_id='`+gwOrg+`';
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state, dispatch_attempt_id)
		VALUES ('`+uuid.NewString()+`','`+gwOrg+`','`+r.runID+`','step#unrec','tool','`+strings.Repeat("f", 64)+`','unknown','`+uuid.NewString()+`')`); err != nil {
		t.Fatal(err)
	}
	_ = seed.Close(ctx)
	if err := r.stream.SendMsg(r.f.signFrame(t, "local_publish", r.sessionID, r.bootID, r.agentID,
		r.publishBody(uuid.NewString(), "reports/final.md", strings.Repeat("c", 64)))); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, r.stream.RecvMsg(&raw), codes.FailedPrecondition)
	if got := r.scalar(t, `SELECT count(*)::text FROM work.artifact_version WHERE org_id=$1`, gwOrg); got != "0" {
		t.Fatalf("a refused finalize wrote %s versions, want 0", got)
	}
}

// TestLocalPublishRejectsBadShape proves the closed body is parsed before any domain command: a
// non-UUID version_id, a sha256:-prefixed content_hash (the wire carries bare hex), a malformed
// receipt_ref, a non-decimal byte_count, an unknown classification_claimed and an empty logical_name
// are all invalid_request. No Run is seeded — the shape gate runs first — and each case gets its own
// stream because a refusal terminates it.
func TestLocalPublishRejectsBadShape(t *testing.T) {
	good := func(f *gwFixture) map[string]any {
		return map[string]any{
			"run_id": uuid.NewString(), "operation_id": uuid.NewString(),
			"version_id": uuid.NewString(), "artifact_id": nil,
			"logical_name": "reports/final.md", "format": "text/markdown",
			"content_hash": strings.Repeat("c", 64), "byte_count": "1024",
			"local_ref": "local/out/report.md", "device_id": f.deviceID,
			"classification_claimed": "local_only",
			"receipt_ref":            uuid.NewString() + ":1",
		}
	}
	mutate := []func(map[string]any){
		func(b map[string]any) { b["version_id"] = "not-a-uuid" },
		func(b map[string]any) { b["content_hash"] = "sha256:" + strings.Repeat("c", 64) },
		func(b map[string]any) { b["receipt_ref"] = "not-a-ref" },
		func(b map[string]any) { b["byte_count"] = "not-a-count" },
		func(b map[string]any) { b["classification_claimed"] = "org_remote" },
		func(b map[string]any) { b["logical_name"] = "" },
	}
	for _, mut := range mutate {
		f := newGatewayFixture(t)
		addr := f.startServer(t)
		stream := f.connect(t, addr)
		sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
		body := good(f)
		mut(body)
		if err := stream.SendMsg(f.signFrame(t, "local_publish", sessionID, bootID, agentID, body)); err != nil {
			t.Fatal(err)
		}
		var raw []byte
		wantCode(t, stream.RecvMsg(&raw), codes.InvalidArgument)
	}
}