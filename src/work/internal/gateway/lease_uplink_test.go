package gateway_test

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"

	"github.com/we-meet/work/internal/testpg"
)

// GW10: the heartbeat uplink and the unsigned lease downlink. device-design §3.1 lists no
// signature for either row, so both ride the mTLS transport plus the hello-established
// session (hello_ack precedent); the ownership judgment is 0051's, in the database.

// seedLease parks an active execution_lease on the seeded Run, bound to the given device
// and session. renew_device_lease checks device/session/lease ownership only (no binding),
// so this is the whole fixture the renewal surface needs.
func (f *gwFixture) seedLease(t *testing.T, runID, deviceID, sessionID string) string {
	t.Helper()
	ctx := gwContext(t)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = seed.Close(ctx) }()
	var fence int64
	if err := seed.QueryRow(ctx,
		`SELECT fence FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, runID).Scan(&fence); err != nil {
		t.Fatal(err)
	}
	leaseID := uuid.NewString()
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		INSERT INTO work.execution_lease
		  (org_id, id, run_id, device_id, session_id, binding_revision, fence, generation,
		   purpose, start_nonce, expires_at, last_receipt_seq, state)
		VALUES ('%s','%s','%s','%s','%s',1,%d,0,'execute','%s',
		        now() + interval '30 seconds',0,'active');
	`, gwOrg, gwOrg, leaseID, runID, deviceID, sessionID, fence, uuid.NewString())
	if err := testpg.ExecRaw(ctx, seed, script); err != nil {
		t.Fatal(err)
	}
	return leaseID
}

// leaseRow reads the durable renewal facts: revision, watermark, expiry and state.
func leaseRow(t *testing.T, f *gwFixture, leaseID string) (revision, seq int64, expiresAt time.Time, state string) {
	t.Helper()
	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	if err := admin.QueryRow(ctx,
		`SELECT revision, last_receipt_seq, expires_at, state FROM work.execution_lease
		 WHERE org_id=$1 AND id=$2::uuid`, gwOrg, leaseID).Scan(&revision, &seq, &expiresAt, &state); err != nil {
		t.Fatal(err)
	}
	return revision, seq, expiresAt, state
}

// seedForeignDevice parks a second active device with its own active session, so a lease
// can legitimately belong to someone else (the execution_lease device/session foreign keys
// require real rows). Seeded directly: pair_device's idempotency key is per subject and
// device name, and the fixture already paired one device on this org.
func (f *gwFixture) seedForeignDevice(t *testing.T) (deviceID, sessionID string) {
	t.Helper()
	ctx := gwContext(t)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = seed.Close(ctx) }()
	deviceID = uuid.NewString()
	sessionID = uuid.NewString()
	thumb := strings.ReplaceAll(uuid.NewString(), "-", "")
	thumb += thumb
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		INSERT INTO work.device
		  (org_id, id, owner_subject_id, device_name, platform, public_key_jwk,
		   public_key_thumbprint, auth_plane, auth_epoch, status)
		VALUES ('%s','%s','%s','other-desk','windows-x64',
		        '{"crv":"P-256","kty":"EC","x":"%s","y":"%s"}'::jsonb,
		        '%s','bearer',7,'active');
		INSERT INTO work.device_session
		  (org_id, id, device_id, owner_subject_id, boot_id, agent_instance_id,
		   auth_plane, auth_epoch, protocol_major, protocol_minor, runtime_digest,
		   journal_epoch, generation, expires_at, state)
		VALUES ('%s','%s','%s','%s','boot-lease-other','%s','bearer',7,2,0,'%s','%s',1,
		        now() + interval '1 hour','active');
	`, gwOrg, gwOrg, deviceID, gwSubject, strings.Repeat("A", 43), strings.Repeat("B", 43),
		thumb, gwOrg, sessionID, deviceID, gwSubject, uuid.NewString(),
		strings.Repeat("6", 64), uuid.NewString())
	if err := testpg.ExecRaw(ctx, seed, script); err != nil {
		t.Fatal(err)
	}
	return deviceID, sessionID
}

// seedSupersededSession parks an older session of THIS device in the superseded state — the
// reconnect scenario §3.1's "一次只绑定原设备/会话" is about: hello minted a new session, and
// a lease acquired under the old one is still bound to it. The partial unique index only
// covers active sessions, so a superseded row coexists with the live one.
func (f *gwFixture) seedSupersededSession(t *testing.T) string {
	t.Helper()
	ctx := gwContext(t)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = seed.Close(ctx) }()
	sessionID := uuid.NewString()
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		INSERT INTO work.device_session
		  (org_id, id, device_id, owner_subject_id, boot_id, agent_instance_id,
		   auth_plane, auth_epoch, protocol_major, protocol_minor, runtime_digest,
		   journal_epoch, generation, expires_at, state)
		VALUES ('%s','%s','%s','%s','boot-lease-old','%s','bearer',7,2,0,'%s','%s',1,
		        now() + interval '1 hour','superseded');
	`, gwOrg, gwOrg, sessionID, f.deviceID, gwSubject, uuid.NewString(),
		strings.Repeat("6", 64), uuid.NewString())
	if err := testpg.ExecRaw(ctx, seed, script); err != nil {
		t.Fatal(err)
	}
	return sessionID
}

// heartbeatBody builds the closed wire heartbeat body: uint64 fields are decimal strings
// and there is no signature member (§3.1 heartbeat row).
func heartbeatBody(monotonicMS string, leaseIDs []string, lastReceiptSeq string) map[string]any {
	return map[string]any{
		"monotonic_ms":     monotonicMS,
		"lease_ids":        leaseIDs,
		"last_receipt_seq": lastReceiptSeq,
	}
}

// recvLease reads one lease downlink and returns its decoded body plus the envelope session.
func recvLease(t *testing.T, stream grpc.ClientStream) (body map[string]any, sessionID string) {
	t.Helper()
	var raw []byte
	if err := stream.RecvMsg(&raw); err != nil {
		t.Fatalf("recv lease: %v", err)
	}
	var env struct {
		Type      string          `json:"type"`
		SessionID string          `json:"session_id"`
		Body      json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "lease" {
		t.Fatalf("frame type = %q, want lease", env.Type)
	}
	if err := json.Unmarshal(env.Body, &body); err != nil {
		t.Fatal(err)
	}
	return body, env.SessionID
}

// TestHeartbeatRenewsAndAnswersTheClosedLeaseFrame is the GW10 round trip: an unsigned
// heartbeat naming one lease is renewed through 0051 and answered with one unsigned lease
// frame carrying exactly the five §3.1 fields, the uint64s as decimal strings. The renewal
// is read back from the database, and a second heartbeat advances the watermark.
func TestHeartbeatRenewsAndAnswersTheClosedLeaseFrame(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, fence := f.seedAction(t, sessionID)
	leaseID := f.seedLease(t, runID, f.deviceID, sessionID)
	beforeRevision, _, beforeExpiry, _ := leaseRow(t, f, leaseID)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{leaseID}, "5"))); err != nil {
		t.Fatal(err)
	}
	body, leaseSession := recvLease(t, stream)
	if leaseSession != sessionID {
		t.Fatalf("lease session = %v, want %s", leaseSession, sessionID)
	}
	if len(body) != 5 {
		t.Fatalf("lease body = %#v, want exactly the five §3.1 fields", body)
	}
	if body["lease_id"] != leaseID || body["run_id"] != runID {
		t.Fatalf("lease body identity = %#v, want %s/%s", body, leaseID, runID)
	}
	if body["fence"] != strconv.FormatInt(fence, 10) || body["ttl_ms"] != "30000" {
		t.Fatalf("lease fence/ttl_ms = %#v, want decimal strings %d and 30000", body, fence)
	}
	if expires, _ := body["expires_at"].(string); expires == "" {
		t.Fatalf("lease body carries no expires_at: %#v", body)
	}
	// Unsigned by ruling: no signature member, and nothing to verify against the JWK.
	if _, signed := body["signature"]; signed {
		t.Fatalf("lease body carries a signature, §3.1 lists none: %#v", body)
	}

	revision, seq, expiresAt, state := leaseRow(t, f, leaseID)
	if revision != beforeRevision+1 || seq != 5 || state != "active" {
		t.Fatalf("stored lease = rev %d seq %d state %s, want rev %d seq 5 active",
			revision, seq, state, beforeRevision+1)
	}
	if !expiresAt.After(beforeExpiry) || !expiresAt.After(time.Now()) {
		t.Fatalf("stored expiry %v did not move past %v / now", expiresAt, beforeExpiry)
	}

	// A second heartbeat advances the watermark and extends again.
	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("11000", []string{leaseID}, "7"))); err != nil {
		t.Fatal(err)
	}
	recvLease(t, stream)
	if _, seq, _, _ := leaseRow(t, f, leaseID); seq != 7 {
		t.Fatalf("watermark after the second heartbeat = %d, want 7", seq)
	}
}

// TestHeartbeatWithNoLeasesIsANoOp proves an empty lease list extends nothing and sends
// nothing: the next frame the device receives is the refusal of the following heartbeat,
// not a stray lease downlink.
func TestHeartbeatWithNoLeasesIsANoOp(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, _ := f.seedAction(t, sessionID)
	leaseID := f.seedLease(t, runID, f.deviceID, sessionID)
	beforeRevision, beforeSeq, beforeExpiry, _ := leaseRow(t, f, leaseID)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{}, "9"))); err != nil {
		t.Fatal(err)
	}
	// An unknown lease is not_found; had the empty heartbeat sent a frame, this recv
	// would have returned that frame instead of the error.
	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("2000", []string{uuid.NewString()}, "9"))); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.NotFound)

	revision, seq, expiresAt, _ := leaseRow(t, f, leaseID)
	if revision != beforeRevision || seq != beforeSeq || !expiresAt.Equal(beforeExpiry) {
		t.Fatalf("untouched lease changed: rev %d→%d seq %d→%d expiry %v→%v",
			beforeRevision, revision, beforeSeq, seq, beforeExpiry, expiresAt)
	}
}

// TestHeartbeatRefusesForeignDeviceAndForeignSession proves the two ownership gates: a
// lease belonging to another device cannot be renewed, and a lease bound to this device's
// ORIGINAL session cannot be renewed from a different session (§3.1 "一次只绑定原设备/会话").
// Each case gets its own fixture and stream because a refusal terminates the stream.
func TestHeartbeatRefusesForeignDeviceAndForeignSession(t *testing.T) {
	cases := []struct {
		name string
		// seed parks the lease and returns its id, bound to whoever the case is about.
		seed func(t *testing.T, f *gwFixture, sessionID, runID string) string
	}{
		{"lease of another device", func(t *testing.T, f *gwFixture, sessionID, runID string) string {
			otherDevice, otherSession := f.seedForeignDevice(t)
			return f.seedLease(t, runID, otherDevice, otherSession)
		}},
		{"lease of a superseded session", func(t *testing.T, f *gwFixture, sessionID, runID string) string {
			return f.seedLease(t, runID, f.deviceID, f.seedSupersededSession(t))
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newGatewayFixture(t)
			addr := f.startServer(t)
			stream := f.connect(t, addr)
			sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
			runID, _, _, _ := f.seedAction(t, sessionID)
			leaseID := tc.seed(t, f, sessionID, runID)
			revision, seq, expiresAt, _ := leaseRow(t, f, leaseID)

			if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
				heartbeatBody("1000", []string{leaseID}, "9"))); err != nil {
				t.Fatal(err)
			}
			var raw []byte
			wantCode(t, stream.RecvMsg(&raw), codes.Unauthenticated)
			afterRevision, afterSeq, afterExpiry, _ := leaseRow(t, f, leaseID)
			if afterRevision != revision || afterSeq != seq || !afterExpiry.Equal(expiresAt) {
				t.Fatalf("refused lease %s was written: rev %d→%d seq %d→%d",
					leaseID, revision, afterRevision, seq, afterSeq)
			}
		})
	}
}

// TestHeartbeatAnyFailureRefusesTheWholeFrame is the 2026-11-16 ruling: a heartbeat naming
// one renewable lease and one expired lease is refused as a whole, and the renewable
// lease's extension is ROLLED BACK (one work_worker transaction), so the device never sees
// a partial extension. The expired lease answers resync_required → FAILED_PRECONDITION.
// The good lease is renewed alone FIRST, which both proves it is renewable and gives the
// rollback a non-trivial baseline to be compared against.
func TestHeartbeatAnyFailureRefusesTheWholeFrame(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runA, _, _, _ := f.seedAction(t, sessionID)
	goodLease := f.seedLease(t, runA, f.deviceID, sessionID)
	runB, _, _, _ := f.seedActionWithInputHash(t, sessionID, strings.Repeat("e", 64))
	expiredLease := f.seedLease(t, runB, f.deviceID, sessionID)

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx,
		`UPDATE work.execution_lease SET state='expired' WHERE org_id=$1 AND id=$2::uuid`,
		gwOrg, expiredLease); err != nil {
		t.Fatal(err)
	}
	_ = admin.Close(ctx)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{goodLease}, "5"))); err != nil {
		t.Fatal(err)
	}
	if body, _ := recvLease(t, stream); body["lease_id"] != goodLease {
		t.Fatalf("solo renewal = %#v, want %s", body, goodLease)
	}
	revision, seq, expiresAt, _ := leaseRow(t, f, goodLease)
	if seq != 5 {
		t.Fatalf("solo renewal watermark = %d, want 5", seq)
	}

	// The mixed frame is refused as a whole and the solo extension is not carried further.
	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("11000", []string{goodLease, expiredLease}, "9"))); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.FailedPrecondition)
	afterRevision, afterSeq, afterExpiry, _ := leaseRow(t, f, goodLease)
	if afterRevision != revision || afterSeq != seq || !afterExpiry.Equal(expiresAt) {
		t.Fatalf("the good lease was partially extended: rev %d→%d seq %d→%d expiry %v→%v",
			revision, afterRevision, seq, afterSeq, expiresAt, afterExpiry)
	}
	if _, _, _, state := leaseRow(t, f, expiredLease); state != "expired" {
		t.Fatalf("expired lease state = %s, want the untouched expired", state)
	}
}

// TestHeartbeatRejectsRewoundWatermark proves the restated 0041 monotonic-watermark
// judgment: a heartbeat reporting a lower last_receipt_seq than the stored one is refused
// and writes nothing. A refusal terminates the stream, so this is the frame's last act.
func TestHeartbeatRejectsRewoundWatermark(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, _ := f.seedAction(t, sessionID)
	leaseID := f.seedLease(t, runID, f.deviceID, sessionID)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{leaseID}, "7"))); err != nil {
		t.Fatal(err)
	}
	recvLease(t, stream)
	revision, _, expiresAt, _ := leaseRow(t, f, leaseID)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("11000", []string{leaseID}, "3"))); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.InvalidArgument)
	afterRevision, seq, afterExpiry, _ := leaseRow(t, f, leaseID)
	if afterRevision != revision || seq != 7 || !afterExpiry.Equal(expiresAt) {
		t.Fatalf("a refused rewind wrote the lease: rev %d→%d seq %d", revision, afterRevision, seq)
	}
}

// TestHeartbeatRejectsBadShape proves the closed body is validated before any domain
// command: a non-decimal monotonic clock, a non-UUID lease id and a negative watermark are
// all invalid_request. Each case gets its own stream because a refusal terminates it, and
// no lease is seeded — the shape gate runs first, so nothing downstream is reachable.
func TestHeartbeatRejectsBadShape(t *testing.T) {
	bad := []map[string]any{
		heartbeatBody("not-a-clock", []string{uuid.NewString()}, "7"),
		heartbeatBody("1000", []string{"not-a-uuid"}, "7"),
		heartbeatBody("1000", []string{uuid.NewString()}, "-1"),
	}
	for _, body := range bad {
		f := newGatewayFixture(t)
		addr := f.startServer(t)
		stream := f.connect(t, addr)
		sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
		if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID, body)); err != nil {
			t.Fatal(err)
		}
		var raw []byte
		wantCode(t, stream.RecvMsg(&raw), codes.InvalidArgument)
	}
}

// TestHeartbeatRefusesRevokedDevice proves the device gate precedes the lease lookup: a
// revoked device cannot extend any lease, and the refusal is device_revoked.
func TestHeartbeatRefusesRevokedDevice(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
	runID, _, _, _ := f.seedAction(t, sessionID)
	leaseID := f.seedLease(t, runID, f.deviceID, sessionID)
	revision, seq, expiresAt, _ := leaseRow(t, f, leaseID)

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx,
		`UPDATE work.device SET status='revoked', revoked_at=now() WHERE org_id=$1 AND id=$2::uuid`,
		gwOrg, f.deviceID); err != nil {
		t.Fatal(err)
	}
	_ = admin.Close(ctx)

	if err := stream.SendMsg(f.unsignedFrame(t, "heartbeat", sessionID, bootID, agentID,
		heartbeatBody("1000", []string{leaseID}, "9"))); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.PermissionDenied)
	afterRevision, afterSeq, afterExpiry, _ := leaseRow(t, f, leaseID)
	if afterRevision != revision || afterSeq != seq || !afterExpiry.Equal(expiresAt) {
		t.Fatalf("revoked device wrote the lease: rev %d→%d seq %d→%d",
			revision, afterRevision, seq, afterSeq)
	}
}
