package gateway_test

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
)

// Batch 6 (0061): a Run whose execute lease died with the old session hands its history back
// under a fresh reconcile_finish lease, and the finish is then ACCEPTED cross-session. Before this
// increment finish_local_run compared device_run_binding.session_id against the lease's unconditionally,
// so a reconnect's new session could never finish the binding that still names the superseded session —
// the gap 0053 registered and deferred. These tests prove the relaxation works AND is bounded: it is
// gated on lease purpose, the caller's device/session still own the lease, a stale fence is still
// refused, an execute lease is still strictly bound to its session, and an expired lease buys nothing
// even moments after it was superseded. The foreign-device refusals are proven one layer down, in
// internal/migrate/r0b_cross_session_finish_test.go, where a second Run and a second device are cheap
// to seed; on the wire the caller's device is the certificate's, so those identities are not reachable.

// recvFrameUntil reads downlinks until one carries the wanted type, skipping the session-establish
// pushes (offer/command/cancel) that may ride ahead of the frame under test. A stream error before a
// match is fatal — these tests only reach here on a path that answers with a frame, not a refusal.
func recvFrameUntil(t *testing.T, stream grpc.ClientStream, want string) (body map[string]any, sessionID string) {
	t.Helper()
	for {
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
			continue
		}
		if err := json.Unmarshal(env.Body, &body); err != nil {
			t.Fatal(err)
		}
		return body, env.SessionID
	}
}

// reconnectSecondSession opens a fresh stream on the same device, mints a second one-use ticket
// and runs hello, returning the new session and its transport ids. activate_device_session
// supersedes the first session, which orphans the execute lease — the exact cross-session
// precondition 0061 makes finishable (offer_uplink_test.go established this reconnect primitive).
func reconnectSecondSession(t *testing.T, r *runUnderFinish) (stream grpc.ClientStream, sessionID, bootID, agentID string) {
	t.Helper()
	stream = r.f.connect(t, r.addr)
	sessionID, bootID, agentID, _ = r.f.helloWithTicket(t, stream, r.f.mintSecondTicket(t))
	if sessionID == r.sessionID {
		t.Fatalf("reconnect reused session %s, want a fresh one", sessionID)
	}
	return stream, sessionID, bootID, agentID
}

// acquireReconcileLease sends an unsigned lease_acquire and reads the lease downlink it answers,
// returning the new lease_id and fence. The reconcile mint is fresh (no run_start, no baseline).
func acquireReconcileLease(t *testing.T, r *runUnderFinish, stream grpc.ClientStream, sessionID, bootID, agentID string) (leaseID, fence string) {
	t.Helper()
	if err := stream.SendMsg(r.f.unsignedFrame(t, "lease_acquire", sessionID, bootID, agentID,
		map[string]any{"run_id": r.runID, "binding_revision": "1"})); err != nil {
		t.Fatal(err)
	}
	body, leaseSession := recvFrameUntil(t, stream, "lease")
	if leaseSession != sessionID {
		t.Fatalf("reconcile lease session = %v, want %s", leaseSession, sessionID)
	}
	leaseID, _ = body["lease_id"].(string)
	fence, _ = body["fence"].(string)
	if leaseID == "" || fence == "" {
		t.Fatalf("reconcile lease has no id/fence: %#v", body)
	}
	if leaseID == r.leaseID {
		t.Fatalf("reconcile lease reused the dead execute lease %s", leaseID)
	}
	return leaseID, fence
}

func TestCrossSessionReconcileFinishIsAccepted(t *testing.T) {
	r := startRunForFinish(t)

	// The finish is impossible while the execute lease is bound to the dead session — reconnect and
	// mint a same-session reconcile_finish lease first, then finish under it.
	s2, session2, boot2, agent2 := reconnectSecondSession(t, r)
	reconcileID, reconcileFence := acquireReconcileLease(t, r, s2, session2, boot2, agent2)

	finishID := uuid.NewString()
	body := r.finishBody(finishID, "failed", "model_error", r.setHash, []string{})
	body["lease_id"] = reconcileID
	body["fence"] = reconcileFence
	if err := s2.SendMsg(r.f.signFrame(t, "run_finish", session2, boot2, agent2, body)); err != nil {
		t.Fatal(err)
	}
	ack, ackSession := recvFrameUntil(t, s2, "run_finish_ack")
	if ackSession != session2 {
		t.Fatalf("ack session = %v, want the reconnect's %s", ackSession, session2)
	}
	if ack["state"] != "accepted" || ack["code"] != nil {
		t.Fatalf("cross-session reconcile finish = %#v, want accepted (0061)", ack)
	}
	if rev, _ := ack["terminal_run_revision"].(string); rev == "" || rev == "0" {
		t.Fatalf("terminal_run_revision = %v, want a positive decimal string", ack["terminal_run_revision"])
	}
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "failed" {
		t.Fatalf("Run state after cross-session finish = %q, want failed", got)
	}
	// The verdict row names the reconcile lease, proving the relaxation ran on that lease's path.
	if got := r.scalar(t, `SELECT lease_id::text FROM work.device_run_finish WHERE org_id=$1 AND run_id=$2::uuid AND state='accepted'`, gwOrg, r.runID); got != reconcileID {
		t.Fatalf("accepted finish lease_id = %s, want the reconcile lease %s", got, reconcileID)
	}
	// Change 2 is what made this reachable: the mint reclaimed the slot by expiring the lease the
	// reconnect superseded, and the run ends with exactly one lease row still active (the terminal
	// write released the reconcile lease, so that count is zero — the point is the expired state).
	if got := r.scalar(t, `SELECT state FROM work.execution_lease WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.leaseID); got != "expired" {
		t.Fatalf("superseded execute lease = %q, want expired", got)
	}
}

// TestCrossSessionReconcileLeaseAcquireReplays is the mint's idempotency under the new branch: a
// second lease_acquire from the SAME session reuses the active reconcile_finish row (0059:548-550)
// instead of expiring or minting again. Without this, "expire then INSERT" would look equally
// correct while silently minting a fresh lease on every heartbeat-scale retry.
func TestCrossSessionReconcileLeaseAcquireReplays(t *testing.T) {
	r := startRunForFinish(t)
	s2, session2, boot2, agent2 := reconnectSecondSession(t, r)
	first, fence := acquireReconcileLease(t, r, s2, session2, boot2, agent2)
	second, _ := acquireReconcileLease(t, r, s2, session2, boot2, agent2)
	if second != first {
		t.Fatalf("second lease_acquire minted %s, want a replay of %s", second, first)
	}
	if fence == "" {
		t.Fatal("reconcile lease carried no fence")
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.execution_lease WHERE org_id=$1 AND run_id=$2::uuid AND state='active'`, gwOrg, r.runID); got != "1" {
		t.Fatalf("active leases on the run = %s, want 1 after a replayed acquire", got)
	}
}

// TestCrossSessionFinishUnderExecuteLeaseIsRefused is the discrimination that proves the relaxation
// is gated on purpose: the SAME cross-session shape, but finishing under the still-active execute
// lease (not a reconcile lease), stays bound to its original session and is refused unauthorized —
// the lease-vs-caller session check 0053/0059 added is untouched for an execute lease.
func TestCrossSessionFinishUnderExecuteLeaseIsRefused(t *testing.T) {
	r := startRunForFinish(t)
	s2, session2, boot2, agent2 := reconnectSecondSession(t, r)

	// No lease_acquire: finish under the dead session's execute lease (r.leaseID).
	if err := s2.SendMsg(r.f.signFrame(t, "run_finish", session2, boot2, agent2,
		r.finishBody(uuid.NewString(), "failed", "model_error", r.setHash, []string{}))); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, s2.RecvMsg(&raw), codes.Unauthenticated)
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "active" {
		t.Fatalf("refused execute finish moved Run to %q, want active", got)
	}
}

// TestCrossSessionStaleFenceFinishIsRejected shows the fence adjudication still binds a reconcile
// finish: under a valid reconcile lease and session, a wrong fence is the in-band verdict
// stale_fence, not a transport error and not an acceptance.
func TestCrossSessionStaleFenceFinishIsRejected(t *testing.T) {
	r := startRunForFinish(t)
	s2, session2, boot2, agent2 := reconnectSecondSession(t, r)
	reconcileID, _ := acquireReconcileLease(t, r, s2, session2, boot2, agent2)

	body := r.finishBody(uuid.NewString(), "failed", "model_error", r.setHash, []string{})
	body["lease_id"] = reconcileID
	body["fence"] = "999999999" // does not match the run's fence
	if err := s2.SendMsg(r.f.signFrame(t, "run_finish", session2, boot2, agent2, body)); err != nil {
		t.Fatal(err)
	}
	ack, _ := recvFrameUntil(t, s2, "run_finish_ack")
	if ack["state"] != "rejected" || ack["code"] != "stale_fence" {
		t.Fatalf("stale-fence reconcile finish = %#v, want rejected/stale_fence", ack)
	}
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "active" {
		t.Fatalf("stale-fence finish moved Run to %q, want active", got)
	}
}

// TestCrossSessionFinishUnderExpiredExecuteLeaseIsRefused is the other half of change 2: the mint
// reclaims the slot by EXPIRING the superseded lease, and an expired lease must then buy nothing —
// not even seconds after the device itself caused the transition. Under 0059 this lease was still
// 'active' (nothing expires it) and this call reached the session gate; both refuse, but the point
// is that expiring a lease for the hand-back does not leave it usable by anyone else either.
func TestCrossSessionFinishUnderExpiredExecuteLeaseIsRefused(t *testing.T) {
	r := startRunForFinish(t)
	s2, session2, boot2, agent2 := reconnectSecondSession(t, r)
	reconcileID, _ := acquireReconcileLease(t, r, s2, session2, boot2, agent2)
	if reconcileID == "" {
		t.Fatal("setup mint failed")
	}
	body := r.finishBody(uuid.NewString(), "failed", "model_error", r.setHash, []string{})
	if err := s2.SendMsg(r.f.signFrame(t, "run_finish", session2, boot2, agent2, body)); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, s2.RecvMsg(&raw), codes.Unauthenticated)
	if got := r.scalar(t, `SELECT count(*)::text FROM work.device_run_finish WHERE org_id=$1 AND run_id=$2::uuid`, gwOrg, r.runID); got != "0" {
		t.Fatalf("verdict rows = %s after a refusal, want 0", got)
	}
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "active" {
		t.Fatalf("refused finish moved Run to %q, want active", got)
	}
}

// TestLeaseAcquireForUnknownBindingRevisionIsRefused proves the mint reaches the binding gate rather
// than minting from the frame's word alone: run_id is real, binding_revision is not, and
// acquire_device_lease's binding lookup answers run_not_found (0059:615-620).
func TestLeaseAcquireForUnknownBindingRevisionIsRefused(t *testing.T) {
	r := startRunForFinish(t)
	s2, session2, boot2, agent2 := reconnectSecondSession(t, r)
	if err := s2.SendMsg(r.f.unsignedFrame(t, "lease_acquire", session2, boot2, agent2,
		map[string]any{"run_id": r.runID, "binding_revision": "4"})); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, s2.RecvMsg(&raw), codes.NotFound)
	if got := r.scalar(t, `SELECT state FROM work.execution_lease WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.leaseID); got != "active" {
		t.Fatalf("execute lease = %q after a refused mint, want the untouched active", got)
	}
}

// TestLeaseAcquireRejectsBadShape proves the closed body is shape-checked before any domain
// command: a non-UUID run_id and a non-decimal/zero binding_revision are invalid_request. Each
// refusal terminates the stream, so each case gets its own connection.
func TestLeaseAcquireRejectsBadShape(t *testing.T) {
	bad := []map[string]any{
		{"run_id": "not-a-uuid", "binding_revision": "1"},
		{"run_id": uuid.NewString(), "binding_revision": "not-a-number"},
		{"run_id": uuid.NewString(), "binding_revision": "0"},
	}
	for _, body := range bad {
		r := startRunForFinish(t)
		s2, session2, boot2, agent2 := reconnectSecondSession(t, r)
		if err := s2.SendMsg(r.f.unsignedFrame(t, "lease_acquire", session2, boot2, agent2, body)); err != nil {
			t.Fatal(err)
		}
		var raw []byte
		wantCode(t, s2.RecvMsg(&raw), codes.InvalidArgument)
	}
}

// TestLeaseAcquireForUnknownRunIsRefused proves the run gate: a lease_acquire naming a run that does
// not exist reaches acquire_device_lease's run_not_found rather than minting a lease.
func TestLeaseAcquireForUnknownRunIsRefused(t *testing.T) {
	r := startRunForFinish(t)
	s2, session2, boot2, agent2 := reconnectSecondSession(t, r)
	if err := s2.SendMsg(r.f.unsignedFrame(t, "lease_acquire", session2, boot2, agent2,
		map[string]any{"run_id": uuid.NewString(), "binding_revision": "1"})); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, s2.RecvMsg(&raw), codes.NotFound)
}
