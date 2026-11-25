package migrate

import (
	"strings"
	"testing"
)

// Tests for increment 0051 (M3 gateway GW10): renew_device_lease is bound to the calling
// device and its live session, and to the lease's ORIGINAL device/session (§3.1 lease row
// "一次只绑定原设备/会话"). Every other 0041 judgment is restated, so the ttl window, the
// monotonic receipt watermark, the never-revive rule and the seven-field response are
// re-asserted here against the new signature.
//
// The claim the increment exists for: before 0051 any authenticated device that learned
// another device's lease_id could extend that lease and push its watermark.

// renewLease calls the restated six-argument command.
func renewLease(t *testing.T, o *orchestrationFixture, leaseID string, ttl int, seq int, deviceID, sessionID string) map[string]any {
	t.Helper()
	return callJSON(t, o.workerConn(t),
		`SELECT work.renew_device_lease($1,$2::uuid,$3,$4,$5::uuid,$6::uuid)`,
		o.org, leaseID, ttl, seq, deviceID, sessionID)
}

func acquireLease(t *testing.T, o *orchestrationFixture) string {
	t.Helper()
	if o.leaseID == "" {
		t.Fatal("create_device_run_binding returned no lease_id")
	}
	return o.leaseID
}

func TestR0bLeaseRenewalExtendsAndKeepsTheWatermarkMonotonic(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_lease_renew")
	worker := o.workerConn(t)
	leaseID := acquireLease(t, o)

	// DROP + CREATE, not a second overload: exactly one renew_device_lease survives.
	if got := o.scalar(t, "SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "+
		"WHERE n.nspname = 'work' AND p.proname = 'renew_device_lease'"); got != "1" {
		t.Fatalf("renew_device_lease overloads = %s, want 1", got)
	}
	before := o.scalar(t, "SELECT revision::text || '/' || last_receipt_seq::text FROM work.execution_lease WHERE id = "+
		quoteLiteral(leaseID))

	first := renewLease(t, o, leaseID, 30, 5, o.deviceID, o.sessionID)
	// Recovery waiting→active does not advance fence; renewal echoes that server fence.
	runFence := o.scalar(t, "SELECT fence::text FROM work.run WHERE id = "+quoteLiteral(o.runID))
	if first["lease_id"] != leaseID || first["run_id"] != o.runID ||
		first["fence"] != float64(1) || runFence != "1" || first["purpose"] != "execute" ||
		first["ttl_ms"] != float64(30000) || first["last_receipt_seq"] != float64(5) {
		t.Fatalf("renewal response = %v (run fence %s), want the closed seven-field shape", first, runFence)
	}
	if first["expires_at"] == nil || first["expires_at"] == "" {
		t.Fatalf("renewal response carries no expires_at: %v", first)
	}
	after := o.scalar(t, "SELECT revision::text || '/' || last_receipt_seq::text FROM work.execution_lease WHERE id = "+
		quoteLiteral(leaseID))
	if after == before || !strings.HasSuffix(after, "/5") {
		t.Fatalf("stored lease revision/watermark = %s (before %s), want a bumped revision and seq 5", after, before)
	}
	// The expiry really moved into the future, not just the response field.
	if got := o.scalar(t, "SELECT (expires_at > now())::text FROM work.execution_lease WHERE id = "+
		quoteLiteral(leaseID)); got != "true" {
		t.Fatalf("stored expires_at in the future = %s, want true", got)
	}

	// A higher watermark advances; the same watermark is accepted (idempotent heartbeat).
	renewLease(t, o, leaseID, 30, 7, o.deviceID, o.sessionID)
	renewLease(t, o, leaseID, 30, 7, o.deviceID, o.sessionID)
	if got := o.scalar(t, "SELECT last_receipt_seq::text FROM work.execution_lease WHERE id = "+
		quoteLiteral(leaseID)); got != "7" {
		t.Fatalf("watermark after two heartbeats = %s, want 7", got)
	}
	// A rewind is refused and writes nothing (0041 judgment restated).
	expectCode(t, worker, "invalid_request",
		`SELECT work.renew_device_lease($1,$2::uuid,$3,$4,$5::uuid,$6::uuid)`,
		o.org, leaseID, 30, 3, o.deviceID, o.sessionID)
	if got := o.scalar(t, "SELECT last_receipt_seq::text FROM work.execution_lease WHERE id = "+
		quoteLiteral(leaseID)); got != "7" {
		t.Fatalf("watermark after a refused rewind = %s, want the stored 7", got)
	}
	// The ttl window and the non-negative watermark are still enforced.
	for _, ttl := range []int{0, 31} {
		expectCode(t, worker, "invalid_request",
			`SELECT work.renew_device_lease($1,$2::uuid,$3,$4,$5::uuid,$6::uuid)`,
			o.org, leaseID, ttl, 7, o.deviceID, o.sessionID)
	}
	expectCode(t, worker, "invalid_request",
		`SELECT work.renew_device_lease($1,$2::uuid,$3,$4,$5::uuid,$6::uuid)`,
		o.org, leaseID, 30, -1, o.deviceID, o.sessionID)
}

func TestR0bLeaseRenewalRefusesForeignDeviceAndSession(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_lease_owner")
	worker := o.workerConn(t)
	leaseID := acquireLease(t, o)

	// A second device with its OWN active session, so gate 1 passes and the lease
	// ownership gate is what refuses (seeded directly: pair_device's idempotency key is
	// per subject/device-name and the fixture already paired one device on this org).
	otherDevice := newUUID(t)
	otherSessionID := newUUID(t)
	thumb := strings.ReplaceAll(newUUID(t), "-", "")
	thumb += thumb
	mustExec(t, o.admin, `INSERT INTO work.device
	  (org_id, id, owner_subject_id, device_name, platform, public_key_jwk,
	   public_key_thumbprint, auth_plane, auth_epoch, status)
	VALUES (`+quoteLiteral(o.org)+`, `+quoteLiteral(otherDevice)+`, `+quoteLiteral(o.subject)+`,
		'other-desk', 'windows-x64', '{"crv":"P-256","kty":"EC","x":"`+strings.Repeat("A", 43)+
		`","y":"`+strings.Repeat("B", 43)+`"}'::jsonb, `+quoteLiteral(thumb)+`, 'bearer', 7, 'active')`)
	mustExec(t, o.admin, `INSERT INTO work.device_session
	  (org_id, id, device_id, owner_subject_id, boot_id, agent_instance_id,
	   auth_plane, auth_epoch, protocol_major, protocol_minor, runtime_digest,
	   journal_epoch, generation, expires_at, state)
	VALUES (`+quoteLiteral(o.org)+`, `+quoteLiteral(otherSessionID)+`, `+quoteLiteral(otherDevice)+`,
		`+quoteLiteral(o.subject)+`, 'boot-lease-other', `+quoteLiteral(newUUID(t))+`, 'bearer', 7, 2, 0,
		`+quoteLiteral(strings.Repeat("6", 64))+`, `+quoteLiteral(newUUID(t))+`, 1,
		now() + interval '1 hour', 'active')`)

	before := o.scalar(t, "SELECT revision::text || '/' || expires_at::text FROM work.execution_lease WHERE id = "+
		quoteLiteral(leaseID))
	// Another device cannot extend this lease, even with its own valid session.
	expectCode(t, worker, "unauthorized",
		`SELECT work.renew_device_lease($1,$2::uuid,$3,$4,$5::uuid,$6::uuid)`,
		o.org, leaseID, 30, 9, otherDevice, otherSessionID)
	// The right device with a session that belongs to someone else is refused at gate 1.
	expectCode(t, worker, "unauthorized",
		`SELECT work.renew_device_lease($1,$2::uuid,$3,$4,$5::uuid,$6::uuid)`,
		o.org, leaseID, 30, 9, o.deviceID, otherSessionID)
	// A session that does not exist at all is refused too.
	expectCode(t, worker, "unauthorized",
		`SELECT work.renew_device_lease($1,$2::uuid,$3,$4,$5::uuid,$6::uuid)`,
		o.org, leaseID, 30, 9, o.deviceID, newUUID(t))
	if got := o.scalar(t, "SELECT revision::text || '/' || expires_at::text FROM work.execution_lease WHERE id = "+
		quoteLiteral(leaseID)); got != before {
		t.Fatalf("lease after three refusals = %s, want the untouched %s", got, before)
	}
	// The entitled device/session still renews, so the refusals are not a broken fixture.
	ok := renewLease(t, o, leaseID, 30, 9, o.deviceID, o.sessionID)
	if ok["last_receipt_seq"] != float64(9) {
		t.Fatalf("entitled renewal = %v, want watermark 9", ok)
	}
}

func TestR0bLeaseRenewalRefusesRevokedDeviceExpiredLeaseAndUnknownLease(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_lease_revoked")
	worker := o.workerConn(t)
	leaseID := acquireLease(t, o)

	// An unknown lease is not_found, and the identity gates run first so a foreign
	// device learns nothing about whether a lease id exists.
	expectCode(t, worker, "not_found",
		`SELECT work.renew_device_lease($1,$2::uuid,$3,$4,$5::uuid,$6::uuid)`,
		o.org, newUUID(t), 30, 0, o.deviceID, o.sessionID)

	// An expired lease is never revived: the whitelist has no expired -> active edge.
	// The device asks for a new reconcile_finish lease instead (J12). Expiry is driven
	// through the whitelisted active -> expired transition (0040:183) because
	// execution_lease_window forbids backdating expires_at below created_at.
	mustExec(t, o.admin, "UPDATE work.execution_lease SET state = 'expired' WHERE id = "+quoteLiteral(leaseID))
	expectCode(t, worker, "resync_required",
		`SELECT work.renew_device_lease($1,$2::uuid,$3,$4,$5::uuid,$6::uuid)`,
		o.org, leaseID, 30, 0, o.deviceID, o.sessionID)
	if got := o.scalar(t, "SELECT state FROM work.execution_lease WHERE id = "+quoteLiteral(leaseID)); got != "expired" {
		t.Fatalf("lease state after a refused revival = %s, want the untouched expired", got)
	}

	// A revoked device cannot renew, and the device gate precedes the lease lookup.
	mustExec(t, o.admin, "UPDATE work.device SET status = 'revoked', revoked_at = now() WHERE id = "+
		quoteLiteral(o.deviceID))
	expectCode(t, worker, "device_revoked",
		`SELECT work.renew_device_lease($1,$2::uuid,$3,$4,$5::uuid,$6::uuid)`,
		o.org, leaseID, 30, 0, o.deviceID, o.sessionID)
}
