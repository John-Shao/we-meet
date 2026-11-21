package migrate

import (
	"strings"
	"testing"
)

// Tests for increment 0061 (execution-face batch 6): J12's cross-session hand-back, end to end.
//
// §3.1 gives the device a 'reconcile_finish' lease precisely so a RECONNECTED session can hand
// back the history of a run whose execute lease died with the session it was minted on. Two gates
// made that unreachable, and 0061 removes them in the order the device meets them:
//
//   - change 2 (acquire_device_lease): the mint collided with work_execution_lease_one_active_per_run
//     (0040:876) whenever the reconnect landed inside the crashed lease's TTL, because that index is
//     purpose-agnostic and nothing else expires a device lease. The mint now expires the row the
//     reconnect superseded. The mutations below pin the scope of that expiry, which is the part a
//     reviewer cannot see from the relaxation alone: a live session's execute lease survives, and so
//     does one being taken over by an execute mint.
//   - change 1 (finish_local_run): the ownership block demanded binding.session = lease.session,
//     which a reconnect can never satisfy because device_run_binding.session_id is guard-immutable
//     (0040:963). The positive path is the point of the batch; gate 1 still refuses the OLD session.

const reconcileLeaseSQL = `SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,` +
	`1,'reconcile_finish',NULL,30)`

// reconnect re-activates the fixture device the way a real hello does: mint a ticket through the
// API role and consume it, which terminalizes the session the binding and the execute lease sit on
// (0040:1644-1647) and returns the NEW live session. Seeding a session row by hand would test the
// predicate but not the state a reconnect actually produces, so this goes through the commands.
func (o *orchestrationFixture) reconnect(t *testing.T) string {
	t.Helper()
	api := o.apiConn(t)
	worker := o.workerConn(t)
	thumb := o.scalar(t, "SELECT public_key_thumbprint FROM work.device WHERE id = "+
		quoteLiteral(o.deviceID))
	minted := callJSON(t, api,
		`SELECT work.mint_device_session_ticket($1,$2,'bearer',7,$3::uuid,$4,$5)`,
		o.org, o.subject, o.deviceID, "req-61-tick", thumb)
	ticket, _ := minted["ticket"].(string)
	if ticket == "" {
		t.Fatalf("mint_device_session_ticket returned no ticket: %#v", minted)
	}
	hash := o.scalar(t, "SELECT work.sha256_text("+quoteLiteral(ticket)+")")
	hello := `{"boot_id":"boot-o","agent_instance_id":"` + newUUID(t) + `","journal_epoch":"` +
		newUUID(t) + `","runtime_digest":"` + strings.Repeat("6", 64) +
		`","protocol_major":2,"protocol_minor":0}`
	session := callJSON(t, worker, `SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`,
		o.org, o.deviceID, hash, hello)
	newID, _ := session["session_id"].(string)
	if newID == "" || newID == o.sessionID {
		t.Fatalf("reconnect session = %q, want a new id (was %q)", newID, o.sessionID)
	}
	return newID
}

// leaseState reads one execution_lease row. work_worker has no SELECT on it (0024), so every read
// here goes through the admin connection the fixture owns.
func (a *actionFixture) leaseState(t *testing.T, leaseID string) string {
	t.Helper()
	return a.scalar(t, "SELECT state FROM work.execution_lease WHERE id = "+quoteLiteral(leaseID))
}

func (a *actionFixture) activeLeaseCount(t *testing.T) int {
	t.Helper()
	return a.scalarInt(t, "SELECT count(*) FROM work.execution_lease WHERE org_id = "+
		quoteLiteral(a.org)+" AND run_id = "+quoteLiteral(a.runID)+" AND state = 'active'")
}

// TestR0bReconnectMintsAReconcileLeaseAndItsSessionFinishes is the batch's positive path: the
// crashed execute lease is expired BY the mint (change 2), the hand-back lease lands on the new
// session, and the run's own history is then accepted from that session even though the binding is
// still on the superseded one (change 1). Every step is read back, because the response alone could
// come from a lease that was never written.
func TestR0bReconnectMintsAReconcileLeaseAndItsSessionFinishes(t *testing.T) {
	a := newActionFixture(t, "org_61_xsession_ok")
	worker := a.workerConn(t)
	if got := a.leaseState(t, a.leaseID); got != "active" {
		t.Fatalf("setup execute lease = %q, want active", got)
	}
	newSession := a.reconnect(t)
	if got := a.scalar(t, "SELECT state FROM work.device_session WHERE id = "+
		quoteLiteral(a.sessionID)); got != "superseded" {
		t.Fatalf("old session = %q, want superseded", got)
	}

	handback := callJSON(t, worker, reconcileLeaseSQL, a.org, a.runID, a.deviceID, newSession)
	newLease, _ := handback["lease_id"].(string)
	if newLease == "" {
		t.Fatalf("reconcile_finish mint failed: %#v", handback)
	}
	if handback["purpose"] != "reconcile_finish" || handback["run_start"] != nil {
		t.Fatalf("hand-back lease = %#v, want reconcile_finish with no run_start", handback)
	}
	if handback["replayed"] != false {
		t.Fatalf("the first hand-back mint claims replayed: %#v", handback)
	}
	if got := a.leaseState(t, newLease); got != "active" {
		t.Fatalf("new lease state = %q, want active", got)
	}
	if got := a.scalar(t, "SELECT session_id::text FROM work.execution_lease WHERE id = "+
		quoteLiteral(newLease)); got != newSession {
		t.Fatalf("new lease session = %q, want the live %s", got, newSession)
	}
	// The superseded execute lease is expired, not deleted and not revived, and the run still has
	// exactly one active lease.
	if got := a.leaseState(t, a.leaseID); got != "expired" {
		t.Fatalf("superseded execute lease = %q, want expired", got)
	}
	if got := a.activeLeaseCount(t); got != 1 {
		t.Fatalf("active leases on the run = %d, want 1 (one-active-per-run still holds)", got)
	}
	// A second request from the same session reuses that row rather than minting another.
	again := callJSON(t, worker, reconcileLeaseSQL, a.org, a.runID, a.deviceID, newSession)
	if again["lease_id"] != newLease || again["replayed"] != true {
		t.Fatalf("second hand-back request = %#v, want a replay of %s", again, newLease)
	}

	// Change 1: the binding is on the superseded session and the lease is on the live one. Under
	// 0059:804 this proposal was unauthorized; the device's own history is now handable back.
	if got := a.scalar(t, "SELECT session_id::text FROM work.device_run_binding WHERE run_id = "+
		quoteLiteral(a.runID)+" AND binding_revision = 1"); got != a.sessionID {
		t.Fatalf("binding session = %q, want the immutable superseded %s", got, a.sessionID)
	}
	finishID := newUUID(t)
	out := callJSON(t, worker, finishSQL, a.org, a.runID, finishID, newLease, 1, a.fence,
		entitledFinish(t, a), a.deviceID, newSession)
	if out["state"] != "accepted" || out["code"] != nil {
		t.Fatalf("cross-session finish = %#v, want accepted with no code", out)
	}
	if got := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); got != "failed" {
		t.Fatalf("Run state = %q, want failed", got)
	}
	if got := a.leaseState(t, newLease); got != "released" {
		t.Fatalf("hand-back lease = %q after the terminal write, want released", got)
	}
	replay := callJSON(t, worker, finishSQL, a.org, a.runID, finishID, newLease, 1, a.fence,
		entitledFinish(t, a), a.deviceID, newSession)
	if replay["replayed"] != true || replay["state"] != "accepted" {
		t.Fatalf("finish replay = %#v, want the original accepted verdict", replay)
	}
	if got := a.finishRowCount(t); got != 1 {
		t.Fatalf("finish rows = %d, want exactly 1", got)
	}
}

// TestR0bReconcileMintOnlyExpiresASupersededSessionsLease is the scope of change 2. The expiry must
// fire for neither of the two cases that look superficially the same: a reconcile_finish mint from
// the session that is still live, and an execute mint from a reconnected session. In both, the
// run's execute lease has to stay active — a mint must never be a way to disarm a lease somebody is
// still holding, and the lease that survives is read back rather than inferred from the refusal.
// Each refusal is the one this call already had before 0061, and change 2 sits behind
// `IF p_purpose = 'reconcile_finish'` (0061:491), so neither path ever reaches the UPDATE:
//   - reconcile_finish from the live session: the purpose-agnostic work_execution_lease_one_active_per_run.
//   - execute from the reconnected session: 0059's execute-only resync gate. The first execute mint
//     inserted the seq-0 baseline checkpoint row, whose state defaults to 'recorded' (0041:39), and
//     binding.expected_checkpoint_seq is guard-immutable (0040:974), so a second execute mint on that
//     revision is refused before the INSERT (0061:473) — it does not get to collide with the index.
func TestR0bReconcileMintOnlyExpiresASupersededSessionsLease(t *testing.T) {
	t.Run("reconcile_finish from the live session", func(t *testing.T) {
		a := newActionFixture(t, "org_61_mint_live")
		worker := a.workerConn(t)
		expectCode(t, worker, "work_execution_lease_one_active_per_run", reconcileLeaseSQL,
			a.org, a.runID, a.deviceID, a.sessionID)
		if got := a.leaseState(t, a.leaseID); got != "active" {
			t.Fatalf("execute lease = %q after a refused mint, want the untouched active", got)
		}
	})
	t.Run("execute from a reconnected session", func(t *testing.T) {
		a := newActionFixture(t, "org_61_mint_execute")
		worker := a.workerConn(t)
		newSession := a.reconnect(t)
		expectCode(t, worker, "resync_required",
			`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
			a.org, a.runID, a.deviceID, newSession, newUUID(t))
		if got := a.leaseState(t, a.leaseID); got != "active" {
			t.Fatalf("execute lease = %q after a refused execute mint, want the untouched active", got)
		}
		if got := a.activeLeaseCount(t); got != 1 {
			t.Fatalf("active leases on the run = %d, want the 1 that was never disarmed", got)
		}
	})
	// A foreign device cannot use the mint to expire the victim's lease either: the binding belongs
	// to the victim, so 0059:618 refuses before the mint path is reached.
	t.Run("reconcile_finish from another device", func(t *testing.T) {
		a := newActionFixture(t, "org_61_mint_foreign")
		worker := a.workerConn(t)
		otherDevice, otherSession := seedSecondDevice(t, a.orchestrationFixture)
		expectCode(t, worker, "run_not_found", reconcileLeaseSQL,
			a.org, a.runID, otherDevice, otherSession)
		if got := a.leaseState(t, a.leaseID); got != "active" {
			t.Fatalf("victim's execute lease = %q, want the untouched active", got)
		}
	})
}

// TestR0bCrossSessionFinishStillRefusesEveryOtherIdentity proves change 1 relaxed the binding
// comparison and nothing else. Two refusals bracket the mint: the superseded session's EXECUTE
// lease still cannot be handed back by the live session (0053 gate 2, the lease-vs-caller
// comparison), and the hand-back lease still cannot be presented by the session it displaced
// (gate 1, which demands a live session). Neither writes a verdict row.
func TestR0bCrossSessionFinishStillRefusesTheOtherSide(t *testing.T) {
	a := newActionFixture(t, "org_61_xsession_old")
	worker := a.workerConn(t)
	newSession := a.reconnect(t)

	// Before the hand-back exists: the execute lease belongs to the superseded session, so the new
	// session has no standing to finish with it. Only the lease is minted on S1; the relaxation for
	// purpose='execute' is not a relaxation at all.
	expectCode(t, worker, "unauthorized", finishSQL,
		a.org, a.runID, newUUID(t), a.leaseID, 1, a.fence, entitledFinish(t, a),
		a.deviceID, newSession)

	handback := callJSON(t, worker, reconcileLeaseSQL, a.org, a.runID, a.deviceID, newSession)
	newLease, _ := handback["lease_id"].(string)
	if newLease == "" {
		t.Fatalf("setup mint failed: %#v", handback)
	}

	// And the other direction: gate 1 still requires the CALLER's session to be live, so the
	// superseded session cannot use the lease its own device just earned.
	expectCode(t, worker, "unauthorized", finishSQL,
		a.org, a.runID, newUUID(t), newLease, 1, a.fence, entitledFinish(t, a),
		a.deviceID, a.sessionID)

	if got := a.finishRowCount(t); got != 0 {
		t.Fatalf("refused identities wrote %d verdict rows, want 0", got)
	}
	if got := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); got != "active" {
		t.Fatalf("Run state = %q, want the untouched active", got)
	}
}
