package gateway_test

import (
	"encoding/json"
	"fmt"
	"reflect"
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

// seedAtomicOffer creates binding revision 1 through the 0069 domain command, so the
// gateway sees the same pre-created active lease/baseline as production.
func (f *gwFixture) seedAtomicOffer(t *testing.T, sessionID, runID string) (nonce, leaseID string) {
	t.Helper()
	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = admin.Exec(ctx, `UPDATE work.run SET state='waiting', wait_reason='input' WHERE org_id=$1 AND id=$2::uuid`, gwOrg, runID); err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	if err = admin.Close(ctx); err != nil {
		t.Fatal(err)
	}
	worker, err := testpg.Open(ctx, testpg.WorkerURL(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = worker.Close(ctx) }()
	if err = testpg.ExecRaw(ctx, worker, "SET app.org_id='"+gwOrg+"'; SET app.subject_id='"+gwSubject+"'"); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"input_ref":"ref","input_hash":"%s","snapshot_hash":"%s","profile_id":"p1","profile_revision":1,"runtime_digest":"%s","tool_manifest_hash":"%s","model_version":"m1","grant_set":[{"grant_id":"%s","grant_revision":1}],"offer_ttl_seconds":120}`,
		strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64),
		strings.Repeat("5", 64), uuid.NewString())
	var raw []byte
	if err = worker.QueryRow(ctx, `SELECT work.create_device_run_binding($1,$2::uuid,$3::uuid,$4::uuid,1,$5,$6::jsonb)`,
		gwOrg, runID, f.deviceID, sessionID, "atomic-"+uuid.NewString(), body).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var out struct {
		StartNonce string `json:"start_nonce"`
		LeaseID    string `json:"lease_id"`
	}
	if err = json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out.StartNonce, out.LeaseID
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
	// The seed stores grant_revision as a JSON number; the wire must still carry the §3.1
	// decimal-string boundary, or the device's u64string adapter refuses the whole offer.
	grants, _ := offer["grant_set"].([]any)
	if len(grants) != 1 {
		t.Fatalf("run_offer grant_set = %#v, want one grant", offer["grant_set"])
	}
	grant, _ := grants[0].(map[string]any)
	if revision, _ := grant["grant_revision"].(string); revision != "1" {
		t.Fatalf("grant_revision = %#v, want decimal string \"1\"", grant["grant_revision"])
	}
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

// TestHeartbeatCreatesResumeOfferAfterExecutorExit proves 0084 is wired into the production
// poll: a waiting Run with a recorded checkpoint and no live lease gets a higher revision on
// heartbeat, then follows the existing signed offer -> ready -> start chain.
func TestHeartbeatCreatesResumeOfferAfterExecutorExit(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, serverPub := f.helloWithServerJWK(t, stream)
	runID, _, _, fence := f.seedAction(t, sessionID)
	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var taskID, boot string
	if err = admin.QueryRow(ctx, `SELECT task_id FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, runID).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	if err = admin.QueryRow(ctx, `SELECT boot_id FROM work.device_session WHERE org_id=$1 AND id=$2::uuid`, gwOrg, sessionID).Scan(&boot); err != nil {
		t.Fatal(err)
	}
	grantID := f.seedLocalPolicyAndGrant(t, sessionID, boot)
	checkpointHash := strings.Repeat("c", 64)
	nonce := uuid.NewString()
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		INSERT INTO work.device_run_binding
		  (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
		   input_hash, snapshot_hash, profile_id, profile_revision, runtime_digest,
		   tool_manifest_hash, model_version, grant_set, start_nonce, offer_expiry, state,
		   created_at)
		VALUES ('%s','%s',1,'%s','%s','%s','ref','%s','%s','p1',1,'%s','%s','m1',
		        '[{"grant_id":"%s","grant_revision":1}]'::jsonb,'%s',
		        now() - interval '1 second','active',now() - interval '2 seconds');
		INSERT INTO work.device_checkpoint
		  (org_id, run_id, checkpoint_seq, binding_revision, fence, checkpoint_hash,
		   local_ref, receipt_through_seq, pending_operation_set_hash, signed_payload_hash, state)
		VALUES ('%s','%s',1,1,%d,'%s','local/cp1',0,'%s','%s','recorded');
		INSERT INTO work.audit_event (org_id, action, target_type, target_id, metadata)
		VALUES ('%s','device_lease.acquired','run','%s',
		        '{"response":{"run_id":"%s","lease_id":"%s"}}'::jsonb);
		UPDATE work.run SET state='waiting', wait_reason='input' WHERE org_id='%s' AND id='%s';
	`, gwOrg, gwOrg, runID, taskID, f.deviceID, sessionID,
		strings.Repeat("b", 64), strings.Repeat("3", 64), strings.Repeat("4", 64),
		strings.Repeat("5", 64), grantID, nonce,
		gwOrg, runID, fence, checkpointHash, strings.Repeat("d", 64), strings.Repeat("e", 64),
		gwOrg, runID, runID, uuid.NewString(), gwOrg, runID)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	if err = testpg.ExecRaw(ctx, seed, script); err != nil {
		_ = seed.Close(ctx)
		t.Fatal(err)
	}
	_ = seed.Close(ctx)

	if err = stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{}, "0"))); err != nil {
		t.Fatal(err)
	}
	bodyJSON, offer, offerSession := recvTypedFrame(t, stream, "run_offer")
	if offerSession != sessionID || offer["run_id"] != runID || offer["binding_revision"] != "2" {
		t.Fatalf("resume offer = session %v body %#v", offerSession, offer)
	}
	if offer["expected_checkpoint_seq"] != "1" || offer["expected_checkpoint_hash"] != checkpointHash {
		t.Fatalf("resume checkpoint = %#v, want seq 1 hash %s", offer, checkpointHash)
	}
	if sig, _ := offer["signature"].(string); sig == "" || !devicesig.VerifyFrame(serverPub, "run_offer", bodyJSON, sig) {
		t.Fatalf("resume offer signature does not verify: %#v", offer)
	}
	bindingHash, _ := offer["binding_hash"].(string)
	if err = stream.SendMsg(f.signFrame(t, "run_ready", sessionID, bootID, agentID, map[string]any{
		"run_id": runID, "binding_revision": "2", "binding_hash": bindingHash, "ready_or_reason": "ready",
	})); err != nil {
		t.Fatal(err)
	}
	_, start, _ := recvTypedFrame(t, stream, "run_start")
	if start["run_id"] != runID || start["run_binding_id"] != "2" || start["start_nonce"] == nonce {
		t.Fatalf("resume run_start = %#v", start)
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
	readyBytes := f.signFrame(t, "run_ready", sessionID, bootID, agentID, ready)
	if err := stream.SendMsg(readyBytes); err != nil {
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
	// Same signed ready bytes on the same stream replay the complete original start.
	if err := stream.SendMsg(readyBytes); err != nil {
		t.Fatal(err)
	}
	replayJSON, replayStart, _ := recvTypedFrame(t, stream, "run_start")
	if !devicesig.VerifyFrame(serverPub, "run_start", replayJSON, replayStart["signature"].(string)) {
		t.Fatal("replayed start signature is invalid")
	}
	delete(start, "signature")
	delete(replayStart, "signature")
	if !reflect.DeepEqual(start, replayStart) {
		t.Fatalf("ready replay changed start: %#v vs %#v", start, replayStart)
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

func TestRunReadyUsesPrecreatedAtomicLease(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, _ := f.seedAction(t, sessionID)
	nonce, leaseID := f.seedAtomicOffer(t, sessionID, runID)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{}, "0"))); err != nil {
		t.Fatal(err)
	}
	_, offer, _ := recvTypedFrame(t, stream, "run_offer")
	ready := map[string]any{
		"run_id": runID, "binding_revision": "1", "binding_hash": offer["binding_hash"],
		"ready_or_reason": "ready",
	}
	if err := stream.SendMsg(f.signFrame(t, "run_ready", sessionID, bootID, agentID, ready)); err != nil {
		t.Fatal(err)
	}
	_, start, _ := recvTypedFrame(t, stream, "run_start")
	if start["start_nonce"] != nonce || start["lease_id"] != leaseID {
		t.Fatalf("atomic run_start = %#v, want nonce %s lease %s", start, nonce, leaseID)
	}
	if got := f.bindingState(t, runID, 1); got != "active/1" {
		t.Fatalf("binding after atomic ready = %s, want active/1", got)
	}
	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var leases, baselines int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM work.execution_lease WHERE org_id=$1 AND run_id=$2::uuid AND state='active'`, gwOrg, runID).Scan(&leases); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM work.device_checkpoint WHERE org_id=$1 AND run_id=$2::uuid AND checkpoint_seq=0`, gwOrg, runID).Scan(&baselines); err != nil {
		t.Fatal(err)
	}
	if leases != 1 || baselines != 1 {
		t.Fatalf("atomic lease/baseline counts = %d/%d, want 1/1", leases, baselines)
	}
}

func TestRunReadyNonReadyRollsBackAtomicActivation(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, _ := f.seedAction(t, sessionID)
	_, leaseID := f.seedAtomicOffer(t, sessionID, runID)
	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{}, "0"))); err != nil {
		t.Fatal(err)
	}
	_, offer, _ := recvTypedFrame(t, stream, "run_offer")
	reason := map[string]any{
		"run_id": runID, "binding_revision": "1", "binding_hash": offer["binding_hash"],
		"ready_or_reason": "missing_input",
	}
	if err := stream.SendMsg(f.signFrame(t, "run_ready", sessionID, bootID, agentID, reason)); err != nil {
		t.Fatal(err)
	}
	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("2000", []string{uuid.NewString()}, "0"))); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.NotFound)
	if got := f.bindingState(t, runID, 1); got != "canceled/2" {
		t.Fatalf("binding after atomic non-ready = %s, want canceled/2", got)
	}
	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var runState, leaseState string
	if err := admin.QueryRow(ctx, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, runID).Scan(&runState); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT state FROM work.execution_lease WHERE org_id=$1 AND id=$2::uuid`, gwOrg, leaseID).Scan(&leaseState); err != nil {
		t.Fatal(err)
	}
	if runState != "waiting" || leaseState != "revoked" {
		t.Fatalf("non-ready rollback run/lease = %s/%s, want waiting/revoked", runState, leaseState)
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
