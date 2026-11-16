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

// GW11: the offer spine. run_offer is pushed (server-signed) when the gateway notices a live
// binding — on session establish and on every heartbeat, because the repo has no
// worker→gateway signal and a binding is created only after the device already holds a
// session. run_ready is device-signed and verified before acknowledge_run_ready; a 'ready'
// answer acquires the lease with the BINDING'S OWN start_nonce and answers with a
// server-signed run_start. run_started is verify-only and writes nothing.

// seedOffer parks an offered device_run_binding on the seeded Run, bound to the given
// session, and returns the start_nonce the gateway must pass through verbatim.
func (f *gwFixture) seedOffer(t *testing.T, sessionID, runID string, revision int) string {
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
	nonce := uuid.NewString()
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		INSERT INTO work.device_run_binding
		  (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
		   input_hash, snapshot_hash, profile_id, profile_revision, runtime_digest,
		   tool_manifest_hash, model_version, grant_set, start_nonce, offer_expiry, state)
		VALUES ('%s','%s',%d,'%s','%s','%s','ref','%s','%s','p1',1,'%s','%s','m1',
		        '[{"grant_id":"%s","grant_revision":1}]'::jsonb,'%s',
		        now() + interval '2 minutes','offered');
	`, gwOrg, gwOrg, runID, revision, taskID, f.deviceID, sessionID,
		strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64),
		strings.Repeat("5", 64), uuid.NewString(), nonce)
	if err := testpg.ExecRaw(ctx, seed, script); err != nil {
		t.Fatal(err)
	}
	return nonce
}

// mintSecondTicket inserts another pending single-use ticket. The fixture's own ticket is
// consumed by the first hello (the claim is a CAS), so a second session needs a second
// ticket; activate_device_session then supersedes the previous active session, which is the
// reconnect scenario the offer spine has to refuse.
func (f *gwFixture) mintSecondTicket(t *testing.T) string {
	t.Helper()
	ctx := gwContext(t)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = seed.Close(ctx) }()
	ticket := "ticket-" + uuid.NewString()
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		INSERT INTO work.device_session_ticket
		  (org_id, device_id, owner_subject_id, auth_plane, auth_epoch,
		   public_key_thumbprint, ticket_hash, client_request_id, request_hash,
		   expires_at, state)
		VALUES ('%s','%s','%s','bearer',%d,'%s','%s','%s','%s',
		        now() + interval '60 seconds','pending');
	`, gwOrg, gwOrg, f.deviceID, gwSubject, gwEpoch, f.thumbprint, sha256Hex(ticket),
		"tick-"+uuid.NewString(), sha256Hex("req-"+uuid.NewString()))
	if err := testpg.ExecRaw(ctx, seed, script); err != nil {
		t.Fatal(err)
	}
	return ticket
}

// helloWithTicket runs hello on an explicit ticket and returns the newly allocated session,
// the fixed envelope identity and the server signing key from hello_ack.
func (f *gwFixture) helloWithTicket(t *testing.T, stream grpc.ClientStream, ticket string) (sessionID, bootID, agentID string, serverPub *devicesig.PublicKey) {
	t.Helper()
	bootID = "boot-" + uuid.NewString()
	agentID = uuid.NewString()
	if err := stream.SendMsg(f.signHelloIdentity(t, ticket, uuid.NewString(), bootID, agentID)); err != nil {
		t.Fatal(err)
	}
	ack := recvAck(t, stream)
	sessionID, _ = ack["_session_id"].(string)
	if sessionID == "" {
		t.Fatalf("hello_ack gave no session: %#v", ack)
	}
	jwkJSON, err := json.Marshal(ack["server_public_jwk"])
	if err != nil {
		t.Fatal(err)
	}
	serverPub, err = devicesig.ParseJWK(jwkJSON)
	if err != nil {
		t.Fatalf("hello_ack server_public_jwk does not parse: %v", err)
	}
	return sessionID, bootID, agentID, serverPub
}

// recvTypedFrame reads one server-originated frame of the wanted type and returns its body
// JSON (the signed preimage source), the decoded body and the envelope session.
func recvTypedFrame(t *testing.T, stream grpc.ClientStream, want string) (bodyJSON []byte, body map[string]any, sessionID string) {
	t.Helper()
	var raw []byte
	if err := stream.RecvMsg(&raw); err != nil {
		t.Fatalf("recv %s: %v", want, err)
	}
	var env struct {
		Type      string          `json:"type"`
		SessionID string          `json:"session_id"`
		Body      json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != want {
		t.Fatalf("frame type = %q, want %s", env.Type, want)
	}
	if err := json.Unmarshal(env.Body, &body); err != nil {
		t.Fatal(err)
	}
	return env.Body, body, env.SessionID
}

// bindingState reads a binding's state and revision straight from the database.
func (f *gwFixture) bindingState(t *testing.T, runID string, revision int) string {
	t.Helper()
	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var out string
	if err := admin.QueryRow(ctx,
		`SELECT state || '/' || revision::text FROM work.device_run_binding
		 WHERE org_id=$1 AND run_id=$2::uuid AND binding_revision=$3`,
		gwOrg, runID, revision).Scan(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestRunOfferIsPushedOnHeartbeatAndServerSigned proves the offer downlink actually fires:
// the binding is created AFTER hello (as the worker would), the next heartbeat makes the
// gateway notice it, and the pushed run_offer is server-signed, closed, and carries no
// start_nonce. The getter is read-only, so the binding stays offered.
func TestRunOfferIsPushedOnHeartbeatAndServerSigned(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, serverPub := f.helloWithServerJWK(t, stream)
	runID, _, _, _ := f.seedAction(t, sessionID)
	nonce := f.seedOffer(t, sessionID, runID, 1)

	// No offer existed at session establish, so the heartbeat is what surfaces it.
	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{}, "0"))); err != nil {
		t.Fatal(err)
	}
	bodyJSON, offer, offerSession := recvTypedFrame(t, stream, "run_offer")
	if offerSession != sessionID {
		t.Fatalf("run_offer session = %v, want %s", offerSession, sessionID)
	}
	if offer["run_id"] != runID || offer["binding_revision"] != "1" {
		t.Fatalf("run_offer identity = %#v, want run %s revision 1", offer, runID)
	}
	for _, key := range []string{"binding_hash", "task_id", "input_ref", "input_hash",
		"snapshot_hash", "profile_id", "profile_revision", "runtime_digest",
		"tool_manifest_hash", "model_version", "grant_set", "offer_expiry"} {
		if offer[key] == nil {
			t.Fatalf("run_offer is missing %s: %#v", key, offer)
		}
	}
	target, _ := offer["original_target"].(map[string]any)
	if target == nil || target["device_id"] != f.deviceID || target["session_id"] != sessionID {
		t.Fatalf("run_offer original_target = %#v, want this device and session", offer["original_target"])
	}
	// §3.1 puts start_nonce only in run_start: leaking it with the offer would let a device
	// pre-register the single-use nonce before the offer is accepted.
	if _, leaked := offer["start_nonce"]; leaked {
		t.Fatalf("run_offer leaked start_nonce %s: %#v", nonce, offer)
	}
	sig, _ := offer["signature"].(string)
	if sig == "" || !devicesig.VerifyFrame(serverPub, "run_offer", bodyJSON, sig) {
		t.Fatalf("run_offer signature does not verify against the hello_ack JWK: %#v", offer)
	}
	if devicesig.VerifyFrame(serverPub, "run_start", bodyJSON, sig) {
		t.Fatal("a run_offer signature verified as run_start (frame type not bound)")
	}

	// The getter is read-only, so without a per-stream dedup every 10s heartbeat would
	// re-push this same offer until it expired. An unknown lease id is answered NotFound;
	// had a duplicate offer been queued, this recv would have returned it instead.
	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("2000", []string{uuid.NewString()}, "0"))); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.NotFound)

	// Read-only getter: the binding did not move.
	if got := f.bindingState(t, runID, 1); got != "offered/0" {
		t.Fatalf("binding after the push = %s, want the untouched offered/0", got)
	}
}

// TestRunReadyAcquiresLeaseAndSendsRunStart is the GW11 end-to-end spine: offer pushed →
// device-signed run_ready verified → acknowledge_run_ready moves offered->ready →
// acquire_device_lease with the BINDING'S OWN start_nonce → server-signed run_start. The
// lease, the seq=0 baseline and the binding's active state are read back.
func TestRunReadyAcquiresLeaseAndSendsRunStart(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, serverPub := f.helloWithServerJWK(t, stream)
	runID, _, _, fence := f.seedAction(t, sessionID)
	nonce := f.seedOffer(t, sessionID, runID, 1)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{}, "0"))); err != nil {
		t.Fatal(err)
	}
	_, offer, _ := recvTypedFrame(t, stream, "run_offer")
	bindingHash, _ := offer["binding_hash"].(string)

	ready := map[string]any{
		"run_id":           runID,
		"binding_revision": "1",
		"binding_hash":     bindingHash,
		"ready_or_reason":  "ready",
	}
	if err := stream.SendMsg(f.signFrame(t, "run_ready", sessionID, bootID, agentID, ready)); err != nil {
		t.Fatal(err)
	}
	startJSON, start, startSession := recvTypedFrame(t, stream, "run_start")
	if startSession != sessionID {
		t.Fatalf("run_start session = %v, want %s", startSession, sessionID)
	}
	// The corrected ruling: the nonce is the binding row's own, never a gateway-minted one.
	if start["start_nonce"] != nonce {
		t.Fatalf("run_start start_nonce = %v, want the binding's %s", start["start_nonce"], nonce)
	}
	if start["run_id"] != runID || start["session_id"] != sessionID {
		t.Fatalf("run_start identity = %#v, want run %s session %s", start, runID, sessionID)
	}
	if start["fence"] != fmt.Sprint(fence) || start["run_binding_id"] != "1" {
		t.Fatalf("run_start fence/binding = %#v, want decimal strings %d and 1", start, fence)
	}
	for _, key := range []string{"lease_id", "runtime_digest", "expiry", "payload_hash", "generation"} {
		if start[key] == nil || start[key] == "" {
			t.Fatalf("run_start is missing %s: %#v", key, start)
		}
	}
	sig, _ := start["signature"].(string)
	if sig == "" || !devicesig.VerifyFrame(serverPub, "run_start", startJSON, sig) {
		t.Fatalf("run_start signature does not verify against the hello_ack JWK: %#v", start)
	}
	if devicesig.VerifyFrame(serverPub, "run_offer", startJSON, sig) {
		t.Fatal("a run_start signature verified as run_offer (frame type not bound)")
	}

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	// acquire_device_lease moved the binding ready->active, wrote the lease with that nonce
	// and wrote the seq=0 baseline (its unique writer, §4.2).
	if got := f.bindingState(t, runID, 1); got != "active/2" {
		t.Fatalf("binding after run_start = %s, want active/2 (ready then active)", got)
	}
	var leaseCount, baselineCount int
	var leaseNonce string
	if err := admin.QueryRow(ctx,
		`SELECT count(*), coalesce(max(start_nonce::text),'') FROM work.execution_lease
		 WHERE org_id=$1 AND run_id=$2::uuid AND state='active'`, gwOrg, runID).
		Scan(&leaseCount, &leaseNonce); err != nil {
		t.Fatal(err)
	}
	if leaseCount != 1 || leaseNonce != nonce {
		t.Fatalf("leases = %d with nonce %q, want exactly 1 carrying %s", leaseCount, leaseNonce, nonce)
	}
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM work.device_checkpoint
		 WHERE org_id=$1 AND run_id=$2::uuid AND checkpoint_seq=0`, gwOrg, runID).
		Scan(&baselineCount); err != nil {
		t.Fatal(err)
	}
	if baselineCount != 1 {
		t.Fatalf("seq=0 baselines = %d, want exactly 1", baselineCount)
	}
}

// TestRunReadyNonReadyReasonSendsNoStart proves a legitimate non-ready answer is recorded
// but buys no lease and no run_start: the binding stays offered, and because the offer was
// already pushed on this stream nothing at all is sent for the answer.
func TestRunReadyNonReadyReasonSendsNoStart(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, _ := f.seedAction(t, sessionID)
	f.seedOffer(t, sessionID, runID, 1)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{}, "0"))); err != nil {
		t.Fatal(err)
	}
	_, offer, _ := recvTypedFrame(t, stream, "run_offer")

	reason := map[string]any{
		"run_id":           runID,
		"binding_revision": "1",
		"binding_hash":     offer["binding_hash"],
		"ready_or_reason":  "missing_input",
	}
	if err := stream.SendMsg(f.signFrame(t, "run_ready", sessionID, bootID, agentID, reason)); err != nil {
		t.Fatal(err)
	}
	if got := f.bindingState(t, runID, 1); got != "offered/0" {
		t.Fatalf("binding after a non-ready answer = %s, want the untouched offered/0", got)
	}
	// Nothing was sent for the answer itself: an unknown lease id is answered NotFound, and
	// had a run_start (or a duplicate offer) been queued, this recv would have returned it.
	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("2000", []string{uuid.NewString()}, "0"))); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.NotFound)

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var leases int
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM work.execution_lease WHERE org_id=$1 AND run_id=$2::uuid`,
		gwOrg, runID).Scan(&leases); err != nil {
		t.Fatal(err)
	}
	if leases != 0 {
		t.Fatalf("leases after a non-ready answer = %d, want 0", leases)
	}
}

// TestRunReadyRejectsBadSignatureAndForeignSession proves the two refusals: a tampered
// device signature is caught before any domain command, and an offer bound to another
// session of the same device cannot be answered from this one (§3.2).
func TestRunReadyRejectsBadSignatureAndForeignSession(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, _ := f.seedAction(t, sessionID)
	f.seedOffer(t, sessionID, runID, 1)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{}, "0"))); err != nil {
		t.Fatal(err)
	}
	_, offer, _ := recvTypedFrame(t, stream, "run_offer")

	// Tamper with the signed body after signing: the signature no longer covers it.
	raw := f.signFrame(t, "run_ready", sessionID, bootID, agentID, map[string]any{
		"run_id":           runID,
		"binding_revision": "1",
		"binding_hash":     offer["binding_hash"],
		"ready_or_reason":  "ready",
	})
	var env map[string]json.RawMessage
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(env["body"], &body); err != nil {
		t.Fatal(err)
	}
	body["ready_or_reason"] = "missing_input"
	env["body"], _ = json.Marshal(body)
	tampered, _ := json.Marshal(env)
	if err := stream.SendMsg(tampered); err != nil {
		t.Fatal(err)
	}
	var got []byte
	wantCode(t, stream.RecvMsg(&got), codes.Unauthenticated)
	if state := f.bindingState(t, runID, 1); state != "offered/0" {
		t.Fatalf("binding after a tampered answer = %s, want the untouched offered/0", state)
	}

	// A second stream on a fresh session: the offer belongs to the first session, so this
	// one may not answer it. The refusal is the database's, not a gateway judgment.
	stream2 := f.connect(t, addr)
	session2, boot2, agent2, _ := f.helloWithTicket(t, stream2, f.mintSecondTicket(t))
	if session2 == sessionID {
		t.Fatalf("second hello reused session %s; the test needs a distinct one", sessionID)
	}
	if err := stream2.SendMsg(f.signFrame(t, "run_ready", session2, boot2, agent2, map[string]any{
		"run_id":           runID,
		"binding_revision": "1",
		"binding_hash":     offer["binding_hash"],
		"ready_or_reason":  "ready",
	})); err != nil {
		t.Fatal(err)
	}
	wantCode(t, stream2.RecvMsg(&got), codes.Unauthenticated)
	if state := f.bindingState(t, runID, 1); state != "offered/0" {
		t.Fatalf("binding after a foreign-session answer = %s, want the untouched offered/0", state)
	}
}

// TestRunStartedIsVerifiedAndWritesNothing covers the ruling that run_started is verify-only:
// a valid signature is accepted with no downlink and no database write, and a tampered one is
// refused. The absence of a frame is proved by making the next read a heartbeat refusal.
func TestRunStartedIsVerifiedAndWritesNothing(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, _ := f.seedAction(t, sessionID)
	nonce := f.seedOffer(t, sessionID, runID, 1)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{}, "0"))); err != nil {
		t.Fatal(err)
	}
	_, offer, _ := recvTypedFrame(t, stream, "run_offer")
	if err := stream.SendMsg(f.signFrame(t, "run_ready", sessionID, bootID, agentID, map[string]any{
		"run_id":           runID,
		"binding_revision": "1",
		"binding_hash":     offer["binding_hash"],
		"ready_or_reason":  "ready",
	})); err != nil {
		t.Fatal(err)
	}
	if _, start, _ := recvTypedFrame(t, stream, "run_start"); start["start_nonce"] != nonce {
		t.Fatalf("run_start nonce = %v, want %s", start["start_nonce"], nonce)
	}
	stateBefore := f.bindingState(t, runID, 1)

	if err := stream.SendMsg(f.signFrame(t, "run_started", sessionID, bootID, agentID, map[string]any{
		"start_nonce":     nonce,
		"state":           "started",
		"checkpoint_ref":  "local/cp0",
		"checkpoint_hash": strings.Repeat("2", 64),
	})); err != nil {
		t.Fatal(err)
	}
	// No frame was produced: the next thing the stream yields is the refusal of a heartbeat
	// naming an unknown lease.
	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("2000", []string{uuid.NewString()}, "0"))); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.NotFound)
	if after := f.bindingState(t, runID, 1); after != stateBefore {
		t.Fatalf("binding after run_started = %s, want the unchanged %s", after, stateBefore)
	}

	// A tampered run_started is refused before anything else.
	stream2 := f.connect(t, addr)
	session2, boot2, agent2, _ := f.helloWithTicket(t, stream2, f.mintSecondTicket(t))
	bad := f.signFrame(t, "run_started", session2, boot2, agent2, map[string]any{
		"start_nonce":     nonce,
		"state":           "started",
		"checkpoint_ref":  "local/cp0",
		"checkpoint_hash": strings.Repeat("2", 64),
	})
	var env map[string]json.RawMessage
	if err := json.Unmarshal(bad, &env); err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(env["body"], &body); err != nil {
		t.Fatal(err)
	}
	body["state"] = "crashed"
	env["body"], _ = json.Marshal(body)
	tampered, _ := json.Marshal(env)
	if err := stream2.SendMsg(tampered); err != nil {
		t.Fatal(err)
	}
	wantCode(t, stream2.RecvMsg(&raw), codes.Unauthenticated)
}