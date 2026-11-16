package migrate

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Tests for increment 0052 (M3 gateway GW11): the read-only pending-offer getter the
// gateway uses to re-push run_offer at session establish, and acknowledge_run_ready bound
// to the calling device/session.
//
// The claims covered are the ones the increment exists for: the getter returns exactly this
// device's LIVE offered bindings (with the internal start_nonce and a recomputable
// binding_hash), skips expired offers, writes nothing, and refuses a foreign identity; and
// the ready answer is now refused for a foreign device, a superseded session and a revoked
// device, while the pre-0052 sha256 placeholder signature no longer passes the shape check.

// callJSONArray scans a jsonb array result (the getter returns an array, not an object).
func callJSONArray(t *testing.T, conn *pgx.Conn, sql string, args ...any) []map[string]any {
	t.Helper()
	var body []byte
	if err := conn.QueryRow(testContext(t), sql, args...).Scan(&body); err != nil {
		t.Fatalf("call: %v\nsql: %s", err, sql)
	}
	var out []map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return out
}

// seedSecondDevice parks another active device with its own active session on the fixture
// org, so an offer can legitimately belong to someone else. Seeded directly: pair_device's
// idempotency key is per subject and device name and the fixture already paired one device.
func seedSecondDevice(t *testing.T, o *orchestrationFixture) (deviceID, sessionID string) {
	t.Helper()
	deviceID = newUUID(t)
	sessionID = newUUID(t)
	thumb := strings.ReplaceAll(newUUID(t), "-", "")
	thumb += thumb
	mustExec(t, o.admin, `INSERT INTO work.device
	  (org_id, id, owner_subject_id, device_name, platform, public_key_jwk,
	   public_key_thumbprint, auth_plane, auth_epoch, status)
	VALUES (`+quoteLiteral(o.org)+`, `+quoteLiteral(deviceID)+`, `+quoteLiteral(o.subject)+`,
		'other-desk', 'windows-x64', '{"crv":"P-256","kty":"EC","x":"`+strings.Repeat("A", 43)+
		`","y":"`+strings.Repeat("B", 43)+`"}'::jsonb, `+quoteLiteral(thumb)+`, 'bearer', 7, 'active')`)
	mustExec(t, o.admin, `INSERT INTO work.device_session
	  (org_id, id, device_id, owner_subject_id, boot_id, agent_instance_id,
	   auth_plane, auth_epoch, protocol_major, protocol_minor, runtime_digest,
	   journal_epoch, generation, expires_at, state)
	VALUES (`+quoteLiteral(o.org)+`, `+quoteLiteral(sessionID)+`, `+quoteLiteral(deviceID)+`,
		`+quoteLiteral(o.subject)+`, 'boot-offer-other', `+quoteLiteral(newUUID(t))+`, 'bearer', 7,
		2, 0, `+quoteLiteral(strings.Repeat("6", 64))+`, `+quoteLiteral(newUUID(t))+`, 1,
		now() + interval '1 hour', 'active')`)
	return deviceID, sessionID
}

// seedSupersededSession parks an older session of the fixture device in the superseded
// state: §3.2 forbids a new session from picking up run_offer/run_start, so an offer bound
// to the old session must not be answerable from it. The partial unique index only covers
// active sessions, so the row coexists with the live one.
func seedSupersededSession(t *testing.T, o *orchestrationFixture) string {
	t.Helper()
	sessionID := newUUID(t)
	mustExec(t, o.admin, `INSERT INTO work.device_session
	  (org_id, id, device_id, owner_subject_id, boot_id, agent_instance_id,
	   auth_plane, auth_epoch, protocol_major, protocol_minor, runtime_digest,
	   journal_epoch, generation, expires_at, state)
	VALUES (`+quoteLiteral(o.org)+`, `+quoteLiteral(sessionID)+`, `+quoteLiteral(o.deviceID)+`,
		`+quoteLiteral(o.subject)+`, 'boot-offer-old', `+quoteLiteral(newUUID(t))+`, 'bearer', 7,
		2, 0, `+quoteLiteral(strings.Repeat("6", 64))+`, `+quoteLiteral(newUUID(t))+`, 1,
		now() + interval '1 hour', 'superseded')`)
	return sessionID
}

// offerSecondRevision parks the fixture Run in waiting (create_device_run_binding requires
// queued/waiting, and the fixture leaves it active) and then offers binding_revision 2, the
// resume flow 0041's own tests use. The new binding is left 'offered'.
func offerSecondRevision(t *testing.T, o *orchestrationFixture, worker *pgx.Conn, requestID string) {
	t.Helper()
	mustExec(t, o.admin, "UPDATE work.run SET state = 'waiting', wait_reason = 'input' WHERE id = "+
		quoteLiteral(o.runID))
	o.offer(t, worker, 2, requestID)
}

// seedExpiredOffer inserts an offered binding whose offer_expiry has already passed.
// Seeded directly with a backdated created_at because device_run_binding_window forbids
// offer_expiry <= created_at and the guard makes created_at immutable, so a live offer can
// never be aged into expiry by an UPDATE.
func seedExpiredOffer(t *testing.T, o *orchestrationFixture) {
	t.Helper()
	mustExec(t, o.admin, `INSERT INTO work.device_run_binding
	  (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
	   input_hash, snapshot_hash, profile_id, profile_revision, runtime_digest,
	   tool_manifest_hash, model_version, grant_set, start_nonce, offer_expiry, state,
	   created_at)
	VALUES (`+quoteLiteral(o.org)+`, `+quoteLiteral(o.runID)+`, 3, `+quoteLiteral(o.taskID)+`,
		`+quoteLiteral(o.deviceID)+`, `+quoteLiteral(o.sessionID)+`, 'ref', '`+strings.Repeat("7", 64)+
		`', '`+strings.Repeat("3", 64)+`', 'p1', 1, '`+strings.Repeat("4", 64)+`', '`+
		strings.Repeat("5", 64)+`', 'm1', '[{"grant_id":"`+o.grantID+`","grant_revision":1}]'::jsonb,
		`+quoteLiteral(newUUID(t))+`, now() - interval '5 minutes', 'offered',
		now() - interval '10 minutes')`)
}

func TestR0bOfferGetterReturnsLiveOffersAndWritesNothing(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_offer_getter")
	worker := o.workerConn(t)
	// The fixture's revision 1 is already 'ready'; offer a second revision so the getter
	// has a live 'offered' row to return.
	offerSecondRevision(t, o, worker, "req-offer-getter-2")

	offers := callJSONArray(t, worker,
		`SELECT work.list_pending_device_offers($1,$2::uuid,$3::uuid)`,
		o.org, o.deviceID, o.sessionID)
	if len(offers) != 1 {
		t.Fatalf("pending offers = %d, want 1 (%#v)", len(offers), offers)
	}
	got := offers[0]
	if got["run_id"] != o.runID || got["binding_revision"] != float64(2) ||
		got["task_id"] != o.taskID {
		t.Fatalf("offer identity = %#v, want run %s revision 2", got, o.runID)
	}
	// The material the device needs to decide ready/missing_input, plus the internal
	// start_nonce the gateway passes verbatim to acquire_device_lease.
	for _, key := range []string{"input_ref", "input_hash", "snapshot_hash", "profile_id",
		"runtime_digest", "tool_manifest_hash", "model_version", "grant_set",
		"start_nonce", "offer_expiry", "binding_hash"} {
		if got[key] == nil {
			t.Fatalf("offer is missing %s: %#v", key, got)
		}
	}
	// No signature column: plpgsql cannot sign ES256, the gateway signs the wire frame.
	if _, hasSig := got["server_signature"]; hasSig {
		t.Fatalf("getter returned a server_signature it cannot compute: %#v", got)
	}
	// binding_hash follows the documented formula, so the gateway and the device agree.
	nonce, _ := got["start_nonce"].(string)
	wantHash := o.scalar(t, `SELECT work.sha256_text('run_offer|'`+
		` || `+quoteLiteral(o.runID)+` || '|' || 2 || '|' || `+quoteLiteral(nonce)+`)`)
	if got["binding_hash"] != wantHash {
		t.Fatalf("binding_hash = %v, want the recomputed %s", got["binding_hash"], wantHash)
	}

	// Read-only: the binding is still offered and its revision did not move.
	if got := o.scalar(t, "SELECT state || '/' || revision::text FROM work.device_run_binding "+
		"WHERE run_id = "+quoteLiteral(o.runID)+" AND binding_revision = 2"); got != "offered/0" {
		t.Fatalf("binding after the getter = %s, want the untouched offered/0", got)
	}
	// Calling it twice changes nothing either (re-push is idempotent by construction).
	if again := callJSONArray(t, worker,
		`SELECT work.list_pending_device_offers($1,$2::uuid,$3::uuid)`,
		o.org, o.deviceID, o.sessionID); len(again) != 1 {
		t.Fatalf("second getter call returned %d offers, want the same 1", len(again))
	}

	// An expired offer is skipped, never pushed (主签 2026-11-16 裁定): only the live
	// revision 2 comes back, the aged revision 3 does not.
	seedExpiredOffer(t, o)
	live := callJSONArray(t, worker,
		`SELECT work.list_pending_device_offers($1,$2::uuid,$3::uuid)`,
		o.org, o.deviceID, o.sessionID)
	if len(live) != 1 || live[0]["binding_revision"] != float64(2) {
		t.Fatalf("offers with an expired row present = %#v, want only revision 2", live)
	}
}

func TestR0bOfferGetterIsDeviceScopedAndRefusesForeignIdentity(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_offer_scope")
	worker := o.workerConn(t)
	offerSecondRevision(t, o, worker, "req-offer-scope-2")
	otherDevice, otherSession := seedSecondDevice(t, o)

	// Another device sees none of this device's offers, even with a valid own session.
	if got := callJSONArray(t, worker,
		`SELECT work.list_pending_device_offers($1,$2::uuid,$3::uuid)`,
		o.org, otherDevice, otherSession); len(got) != 0 {
		t.Fatalf("foreign device saw %d offers, want 0", len(got))
	}
	// The fixture device with a session that is not its own is refused at the session gate.
	expectCode(t, worker, "unauthorized",
		`SELECT work.list_pending_device_offers($1,$2::uuid,$3::uuid)`,
		o.org, o.deviceID, otherSession)
	// A session that does not exist is refused too.
	expectCode(t, worker, "unauthorized",
		`SELECT work.list_pending_device_offers($1,$2::uuid,$3::uuid)`,
		o.org, o.deviceID, newUUID(t))
	// A revoked device is refused rather than answered with an empty list.
	mustExec(t, o.admin, "UPDATE work.device SET status = 'revoked', revoked_at = now() WHERE id = "+
		quoteLiteral(o.deviceID))
	expectCode(t, worker, "device_revoked",
		`SELECT work.list_pending_device_offers($1,$2::uuid,$3::uuid)`,
		o.org, o.deviceID, o.sessionID)
}

// TestR0bOfferGetterSkipsOffersBoundToAnotherSession proves the session targeting that
// separates an offer from a conclusion: 0049 re-pushes resolutions by device so they survive
// a reconnect, but an offer is session-bound (§3.2, and the restated acknowledge_run_ready
// refuses an answer from any other session), so a stale offer must not be handed to a session
// that has no right to accept it. After a reconnect the worker re-offers at a higher
// binding_revision instead.
func TestR0bOfferGetterSkipsOffersBoundToAnotherSession(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_offer_session")
	worker := o.workerConn(t)
	offerSecondRevision(t, o, worker, "req-offer-session-2")
	oldSession := seedSupersededSession(t, o)

	// Re-point the offered binding at the superseded session. session_id is guard-immutable,
	// so this is seeded as a fresh binding row instead of an UPDATE.
	mustExec(t, o.admin, "UPDATE work.device_run_binding SET state = 'canceled' WHERE run_id = "+
		quoteLiteral(o.runID)+" AND binding_revision = 2")
	mustExec(t, o.admin, `INSERT INTO work.device_run_binding
	  (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
	   input_hash, snapshot_hash, profile_id, profile_revision, runtime_digest,
	   tool_manifest_hash, model_version, grant_set, start_nonce, offer_expiry, state)
	VALUES (`+quoteLiteral(o.org)+`, `+quoteLiteral(o.runID)+`, 3, `+quoteLiteral(o.taskID)+`,
		`+quoteLiteral(o.deviceID)+`, `+quoteLiteral(oldSession)+`, 'ref', '`+strings.Repeat("7", 64)+
		`', '`+strings.Repeat("3", 64)+`', 'p1', 1, '`+strings.Repeat("4", 64)+`', '`+
		strings.Repeat("5", 64)+`', 'm1', '[{"grant_id":"`+o.grantID+`","grant_revision":1}]'::jsonb,
		`+quoteLiteral(newUUID(t))+`, now() + interval '2 minutes', 'offered')`)

	// The live session sees neither: revision 2 was canceled, revision 3 belongs to the
	// superseded session.
	if got := callJSONArray(t, worker,
		`SELECT work.list_pending_device_offers($1,$2::uuid,$3::uuid)`,
		o.org, o.deviceID, o.sessionID); len(got) != 0 {
		t.Fatalf("live session saw %d offers, want 0 (%#v)", len(got), got)
	}
	// And answering ready for the stale offer from the live session is refused, which is
	// exactly why pushing it would have been useless.
	expectCode(t, worker, "unauthorized",
		`SELECT work.acknowledge_run_ready($1,$2::uuid,3,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-ready-stale-session",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"ready","device_signature":"`+
			strings.Repeat("d", 86)+`"}`, o.deviceID, o.sessionID)
}

func TestR0bRunReadyIsBoundToDeviceSessionAndRealSignature(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_ready_bound")
	worker := o.workerConn(t)
	offerSecondRevision(t, o, worker, "req-ready-bound-2")
	otherDevice, otherSession := seedSecondDevice(t, o)
	oldSession := seedSupersededSession(t, o)

	ready := func(sig string) string {
		return `{"binding_hash":"` + strings.Repeat("a", 64) +
			`","ready_or_reason":"ready","device_signature":"` + sig + `"}`
	}
	// A foreign device cannot answer ready for this device's offer: that answer is what
	// lets the workflow AcquireRun.
	expectCode(t, worker, "unauthorized",
		`SELECT work.acknowledge_run_ready($1,$2::uuid,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-ready-foreign", ready(strings.Repeat("d", 86)), otherDevice, otherSession)
	// Neither can a superseded session of the right device (§3.2: a new session may not
	// pick up run_offer/run_start, so the old session's offer is not answerable either).
	expectCode(t, worker, "unauthorized",
		`SELECT work.acknowledge_run_ready($1,$2::uuid,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-ready-oldsession", ready(strings.Repeat("d", 86)), o.deviceID, oldSession)
	// The pre-0052 internal placeholder is no longer a valid device_signature shape: the
	// gateway verifies the real ES256 frame before calling (0048/0050 precedent).
	expectCode(t, worker, "invalid_request",
		`SELECT work.acknowledge_run_ready($1,$2::uuid,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-ready-placeholder", ready("sha256:"+strings.Repeat("b", 64)),
		o.deviceID, o.sessionID)
	// Nothing moved: the binding is still offered.
	if got := o.scalar(t, "SELECT state || '/' || revision::text FROM work.device_run_binding "+
		"WHERE run_id = "+quoteLiteral(o.runID)+" AND binding_revision = 2"); got != "offered/0" {
		t.Fatalf("binding after three refusals = %s, want the untouched offered/0", got)
	}

	// The entitled device/session still moves offered -> ready, and a replay is idempotent.
	ok := callJSON(t, worker,
		`SELECT work.acknowledge_run_ready($1,$2::uuid,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-ready-owner", ready(strings.Repeat("d", 86)), o.deviceID, o.sessionID)
	if ok["ready_or_reason"] != "ready" || ok["state"] != "ready" || ok["replayed"] != false {
		t.Fatalf("ready answer = %v, want state ready, not replayed", ok)
	}
	again := callJSON(t, worker,
		`SELECT work.acknowledge_run_ready($1,$2::uuid,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-ready-owner", ready(strings.Repeat("d", 86)), o.deviceID, o.sessionID)
	if again["replayed"] != true || again["state"] != "ready" {
		t.Fatalf("replay = %v, want replayed with state ready", again)
	}
	if got := o.scalar(t, "SELECT state || '/' || revision::text FROM work.device_run_binding "+
		"WHERE run_id = "+quoteLiteral(o.runID)+" AND binding_revision = 2"); got != "ready/1" {
		t.Fatalf("binding after ready = %s, want ready/1 (moved exactly once)", got)
	}
}

func TestR0bRunReadyRefusesRevokedDeviceAndNonReadyReasonKeepsOffered(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_ready_revoked")
	worker := o.workerConn(t)
	offerSecondRevision(t, o, worker, "req-ready-revoked-2")

	// A non-ready reason is a legitimate answer but must NOT move the binding: the workflow
	// must not AcquireRun and the reason is the user-visible next step (0041 rule restated).
	reason := callJSON(t, worker,
		`SELECT work.acknowledge_run_ready($1,$2::uuid,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-ready-missing-input",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"missing_input","device_signature":"`+
			strings.Repeat("d", 86)+`"}`, o.deviceID, o.sessionID)
	if reason["ready_or_reason"] != "missing_input" || reason["state"] != "offered" {
		t.Fatalf("non-ready answer = %v, want state left offered", reason)
	}
	if got := o.scalar(t, "SELECT state || '/' || revision::text FROM work.device_run_binding "+
		"WHERE run_id = "+quoteLiteral(o.runID)+" AND binding_revision = 2"); got != "offered/0" {
		t.Fatalf("binding after a non-ready answer = %s, want the untouched offered/0", got)
	}

	// A revoked device cannot answer, and cannot obtain a replayed response either.
	mustExec(t, o.admin, "UPDATE work.device SET status = 'revoked', revoked_at = now() WHERE id = "+
		quoteLiteral(o.deviceID))
	expectCode(t, worker, "device_revoked",
		`SELECT work.acknowledge_run_ready($1,$2::uuid,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-ready-owner",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"ready","device_signature":"`+
			strings.Repeat("d", 86)+`"}`, o.deviceID, o.sessionID)
}
