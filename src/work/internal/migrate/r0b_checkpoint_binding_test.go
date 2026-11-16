package migrate

import (
	"strconv"
	"strings"
	"testing"
)

// Tests for increment 0050 (M3 gateway GW9): record_device_checkpoint is bound to the
// calling device/session and the Run's current binding, and its response carries the
// receipt watermark the server-signed checkpoint_ack relays (B03 carrier §3.2).
//
// The claims covered are the ones the increment exists for: a recorded ack returns the
// watermark it just stored (and a replay returns the stored one, a conflict returns none);
// a foreign device, a foreign session and a superseded binding_revision are all refused;
// a revoked device is refused; and the internal sha256 placeholder no longer passes the
// signature shape now that the gateway verifies the real ES256 frame (0048 precedent).

// checkpointBody builds the closed wire element the gateway translates into. The signature
// is the real ES256 shape (86 base64url characters); the cryptography is the gateway's job.
func checkpointBody(seq int, hash string, watermark int) string {
	return `{"checkpoint_seq":` + strconv.Itoa(seq) +
		`,"checkpoint_hash":"` + hash +
		`","local_checkpoint_ref":"local/cp","receipt_through_seq":` + strconv.Itoa(watermark) +
		`,"pending_operation_set_hash":"` + strings.Repeat("c", 64) +
		`","device_signature":"` + strings.Repeat("d", 86) + `"}`
}

func TestR0bCheckpointAckCarriesTheReceiptWatermark(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_cp_wm")
	worker := o.workerConn(t)
	callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, newUUID(t))

	cp := func(seq int, hash string, watermark int, requestID string) map[string]any {
		return callJSON(t, worker,
			`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
			o.org, o.runID, requestID, checkpointBody(seq, hash, watermark), o.deviceID, o.sessionID)
	}

	first := cp(1, strings.Repeat("1", 64), 7, "req-wm-1")
	if first["state"] != "recorded" || first["receipt_through_seq"] != float64(7) {
		t.Fatalf("recorded checkpoint = %v, want state recorded and watermark 7", first)
	}
	// The watermark is durable, not just echoed: it is the stored column.
	if got := o.scalar(t, "SELECT receipt_through_seq::text FROM work.device_checkpoint WHERE org_id = "+
		quoteLiteral(o.org)+" AND checkpoint_seq = 1"); got != "7" {
		t.Fatalf("stored watermark = %s, want 7", got)
	}
	// An idempotent replay returns the stored watermark, not a freshly computed one.
	again := cp(1, strings.Repeat("1", 64), 7, "req-wm-1")
	if again["replayed"] != true || again["receipt_through_seq"] != float64(7) {
		t.Fatalf("replay = %v, want replayed with watermark 7", again)
	}
	second := cp(2, strings.Repeat("2", 64), 9, "req-wm-2")
	if second["state"] != "recorded" || second["receipt_through_seq"] != float64(9) {
		t.Fatalf("second checkpoint = %v, want watermark 9", second)
	}
	// Same seq, different hash: the Run parks and the conflict ack carries NO watermark.
	conflict := cp(2, strings.Repeat("3", 64), 11, "req-wm-conflict")
	if conflict["state"] != "conflict" || conflict["receipt_through_seq"] != float64(0) {
		t.Fatalf("conflict = %v, want state conflict and watermark 0", conflict)
	}
	if got := o.scalar(t, "SELECT state || '/' || coalesce(wait_reason,'-') FROM work.run WHERE id = " +
		quoteLiteral(o.runID)); got != "waiting/reconcile" {
		t.Fatalf("run after conflict = %s, want waiting/reconcile", got)
	}
	// The stored watermark of the conflicted row is unchanged (the ack's 0 is not a write).
	if got := o.scalar(t, "SELECT receipt_through_seq::text FROM work.device_checkpoint WHERE org_id = " +
		quoteLiteral(o.org)+" AND checkpoint_seq = 2"); got != "9" {
		t.Fatalf("conflicted row watermark = %s, want the recorded 9", got)
	}
}

func TestR0bCheckpointRefusesForeignDeviceSessionAndStaleBinding(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_cp_owner")
	worker := o.workerConn(t)
	callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, newUUID(t))

	// A second device with its OWN active session: the session gate passes, so only the
	// run-level binding gate can refuse it (0049 targeting precedent). Seeded directly
	// because pair_device's idempotency key is per subject/device-name, and the fixture
	// already paired one device on this org.
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
	`+quoteLiteral(o.subject)+`, 'boot-cp-other', `+quoteLiteral(newUUID(t))+`, 'bearer', 7, 2, 0,
	`+quoteLiteral(strings.Repeat("6", 64))+`, `+quoteLiteral(newUUID(t))+`, 1,
	now() + interval '1 hour', 'active')`)

	body := checkpointBody(1, strings.Repeat("1", 64), 0)
	// The Run's latest binding points at o.deviceID, so the foreign device is refused.
	expectCode(t, worker, "unauthorized",
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-cp-foreign", body, otherDevice, otherSessionID)
	// A session that belongs to another device is refused even for the right device id.
	expectCode(t, worker, "unauthorized",
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-cp-cross-session", body, o.deviceID, otherSessionID)
	// A superseded binding_revision cannot keep writing baselines (latest is 1).
	expectCode(t, worker, "unauthorized",
		`SELECT work.record_device_checkpoint($1,$2::uuid,2,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-cp-stale-binding", body, o.deviceID, o.sessionID)
	// Nothing was written by any of the three refusals.
	if got := o.scalar(t, "SELECT count(*)::text FROM work.device_checkpoint WHERE org_id = "+
		quoteLiteral(o.org)+" AND checkpoint_seq > 0"); got != "0" {
		t.Fatalf("device checkpoints after refusals = %s, want 0", got)
	}
	// The entitled device still records, so the refusals are not a broken fixture.
	ok := callJSON(t, worker,
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-cp-owner", body, o.deviceID, o.sessionID)
	if ok["state"] != "recorded" {
		t.Fatalf("entitled device = %v, want recorded", ok)
	}
}

func TestR0bCheckpointRefusesRevokedDeviceAndPlaceholderSignature(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_cp_revoked")
	worker := o.workerConn(t)
	callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, newUUID(t))

	// The pre-GW9 internal placeholder is no longer a valid device_signature shape.
	placeholder := `{"checkpoint_seq":1,"checkpoint_hash":"` + strings.Repeat("1", 64) +
		`","local_checkpoint_ref":"local/cp","receipt_through_seq":0,"pending_operation_set_hash":"` +
		strings.Repeat("c", 64) + `","device_signature":"sha256:` + strings.Repeat("d", 64) + `"}`
	expectCode(t, worker, "invalid_request",
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-cp-placeholder", placeholder, o.deviceID, o.sessionID)

	// A revoked device cannot record, and cannot obtain a replayed response either.
	mustExec(t, o.admin, "UPDATE work.device SET status = 'revoked', revoked_at = now() WHERE id = "+quoteLiteral(o.deviceID))
	expectCode(t, worker, "device_revoked",
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-cp-revoked", checkpointBody(1, strings.Repeat("1", 64), 0),
		o.deviceID, o.sessionID)
	if got := o.scalar(t, "SELECT count(*)::text FROM work.device_checkpoint WHERE org_id = "+
		quoteLiteral(o.org)+" AND checkpoint_seq > 0"); got != "0" {
		t.Fatalf("device checkpoints after refusal = %s, want 0", got)
	}
}