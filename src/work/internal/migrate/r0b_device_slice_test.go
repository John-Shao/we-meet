package migrate

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for increment 0040: device identity, workspace grants, and the three tables
// their revocation paths write to.
//
// The claims these cover are the ones the increment exists for: a challenge and a
// session ticket are each usable exactly once; the classification of a workspace
// grant comes from the organization's mapping and not from the device's claim; a
// revoked device loses its sessions and its leases and leaves a cancellation intent
// bound to the deny that caused it; and a revoked device does not keep its key
// reserved forever.

const deviceTestKeyJWK = `{"crv":"P-256","kty":"EC","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}`

// deviceFixture is one organization with a configured local policy, an active owner
// member, and a Run parked in waiting(input) so the rebind path has something to act on.
type deviceFixture struct {
	dbName  string
	admin   *pgx.Conn
	org     string
	subject string
	runID   string
	taskID  string
}

func newDeviceFixture(t *testing.T, org string) *deviceFixture {
	t.Helper()
	dbName, admin := newGateDB(t)
	ctx := testContext(t)
	f := &deviceFixture{dbName: dbName, admin: admin, org: org, subject: "sub_" + org}
	// Even the maintenance connection needs the tenant set: the run/task admission
	// triggers are SECURITY DEFINER, and their owner is subject to FORCE RLS, so an
	// unset app.org_id makes the org row invisible to them.
	mustExec(t, admin, "SET app.org_id = "+quoteLiteral(org)+
		"; SET app.subject_id = "+quoteLiteral(f.subject))

	mustExec(t, admin, "INSERT INTO work.org (id, status, home_region) VALUES ("+
		quoteLiteral(org)+", 'active', 'cn-hangzhou') ON CONFLICT (id) DO NOTHING")
	mustExec(t, admin, "INSERT INTO work.member (org_id, subject_id, status, role, work_seat) VALUES ("+
		quoteLiteral(org)+", "+quoteLiteral(f.subject)+", 'active', 'owner', true) "+
		"ON CONFLICT (org_id, subject_id) DO NOTHING")
	// A configured, confirmed mapping with one local_only rule and one
	// remote_excerpt_allowed rule whose ceiling is itself. The gate must read ready.
	mustExec(t, admin, `INSERT INTO work.local_execution_policy
		(org_id, allowed_tools, allowed_destinations, classification_rules,
		 classification_default, classification_default_confirmed, classification_floor,
		 readonly_max_actions, readonly_ttl, input_limit_bytes, output_limit_bytes)
		VALUES (`+quoteLiteral(org)+`,
		 ARRAY['workspace.list','workspace.read','workspace.search','artifact.write'],
		 ARRAY['device_local'],
		 '[{"matcher":{"path_prefix":"docs"},"classification":"local_only","max_confirmable":"local_only"},
		   {"matcher":{"path_prefix":"public"},"classification":"remote_excerpt_allowed","max_confirmable":"remote_excerpt_allowed"}]'::jsonb,
		 'local_only', true, 'remote_excerpt_allowed', 3, interval '1 hour', 262144, 262144)`)

	f.taskID = newUUID(t)
	f.runID = newUUID(t)
	snapshot := newUUID(t)
	mustExec(t, admin, "INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status) VALUES ("+
		quoteLiteral(newUUID(t))+", "+quoteLiteral(org)+", "+quoteLiteral(f.subject)+", 'ref', '"+
		strings.Repeat("b", 64)+"', 1, 'text/plain', 'active')")
	var inputID string
	if err := admin.QueryRow(ctx, "SELECT id::text FROM work.input_object WHERE org_id = "+quoteLiteral(org)+" LIMIT 1").Scan(&inputID); err != nil {
		t.Fatal(err)
	}
	// task and capability_snapshot reference each other (the snapshot's task FK is
	// deferred, the task's snapshot FK is not), so the three rows must land in ONE
	// transaction. execRaw sends them as a single simple-query message.
	graphSQL := "INSERT INTO work.capability_snapshot (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest) VALUES (" +
		quoteLiteral(snapshot) + ", " + quoteLiteral(org) + ", " + quoteLiteral(f.taskID) + ", 'v1', '" +
		strings.Repeat("a", 64) + "', ARRAY['workspace.read'], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);\n" +
		"INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, input_id, title) VALUES (" +
		quoteLiteral(f.taskID) + ", " + quoteLiteral(org) + ", " + quoteLiteral(f.subject) + ", 'open', " +
		quoteLiteral(snapshot) + ", " + quoteLiteral(inputID) + ", 'device slice');\n" +
		"INSERT INTO work.run (id, org_id, task_id, attempt_no, state, wait_reason, snapshot_id, workflow_id, runtime_version) VALUES (" +
		quoteLiteral(f.runID) + ", " + quoteLiteral(org) + ", " + quoteLiteral(f.taskID) + ", 1, 'waiting', 'input', " +
		quoteLiteral(snapshot) + ", " + quoteLiteral("wf-"+org) + ", 'v1');"
	if err := execRaw(ctx, admin, graphSQL); err != nil {
		t.Fatalf("seed task graph: %v", err)
	}
	return f
}

func mustExec(t *testing.T, conn *pgx.Conn, sql string) {
	t.Helper()
	if _, err := conn.Exec(testContext(t), sql); err != nil {
		t.Fatalf("exec: %v\nsql: %s", err, sql)
	}
}

// apiConn is a work_api connection with the tenant and actor set, which is what
// assert_session_subject and the RLS policy both read.
func (f *deviceFixture) apiConn(t *testing.T) *pgx.Conn {
	t.Helper()
	conn := connect(t, testpg.AppURL(f.dbName))
	mustExec(t, conn, "SET app.org_id = "+quoteLiteral(f.org)+
		"; SET app.subject_id = "+quoteLiteral(f.subject))
	return conn
}

func (f *deviceFixture) workerConn(t *testing.T) *pgx.Conn {
	t.Helper()
	conn := connect(t, testpg.WorkerURL(f.dbName))
	mustExec(t, conn, "SET app.org_id = "+quoteLiteral(f.org)+
		"; SET app.subject_id = "+quoteLiteral(f.subject))
	return conn
}

func callJSON(t *testing.T, conn *pgx.Conn, sql string, args ...any) map[string]any {
	t.Helper()
	var body []byte
	if err := conn.QueryRow(testContext(t), sql, args...).Scan(&body); err != nil {
		t.Fatalf("call: %v\nsql: %s", err, sql)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func expectCode(t *testing.T, conn *pgx.Conn, want string, sql string, args ...any) {
	t.Helper()
	var body []byte
	err := conn.QueryRow(testContext(t), sql, args...).Scan(&body)
	if err == nil {
		t.Fatalf("expected %q, got a result: %s", want, string(body))
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("expected error containing %q, got %v", want, err)
	}
}

func (f *deviceFixture) scalar(t *testing.T, sql string) string {
	t.Helper()
	var out string
	if err := f.admin.QueryRow(testContext(t), sql).Scan(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

// pairAndConfirm walks the two-step pairing and returns the device id.
func (f *deviceFixture) pairAndConfirm(t *testing.T, api *pgx.Conn, requestID string) (string, string) {
	t.Helper()
	pairing := callJSON(t, api,
		`SELECT work.pair_device($1,$2,'bearer',7,$3,'desk','windows-x64',$4::jsonb)`,
		f.org, f.subject, requestID, deviceTestKeyJWK)
	challenge, _ := pairing["challenge"].(string)
	if challenge == "" {
		t.Fatalf("pairing returned no challenge: %v", pairing)
	}
	deviceID, _ := pairing["device_id"].(string)
	confirmed := callJSON(t, api,
		`SELECT work.confirm_device_pairing($1,$2,'bearer',7,$3::uuid,$4,$5,'sha256:`+strings.Repeat("c", 64)+`')`,
		f.org, f.subject, pairing["pairing_id"], requestID+"-confirm", challenge)
	if confirmed["status"] != "active" {
		t.Fatalf("confirm status = %v, want active", confirmed["status"])
	}
	return deviceID, challenge
}

func TestR0bDeviceChallengeIsSingleUseAndReplayReturnsTheOriginal(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_device_challenge")
	api := f.apiConn(t)
	deviceID, challenge := f.pairAndConfirm(t, api, "req-pair-1")

	// The same confirm request_id replays the original result rather than consuming again.
	replay := callJSON(t, api,
		`SELECT work.confirm_device_pairing($1,$2,'bearer',7,$3::uuid,$4,$5,'sha256:`+strings.Repeat("c", 64)+`')`,
		f.org, f.subject, f.scalar(t, "SELECT id::text FROM work.device_pairing WHERE org_id = "+quoteLiteral(f.org)+" LIMIT 1"),
		"req-pair-1-confirm", challenge)
	if replay["replayed"] != true || replay["device_id"] != deviceID {
		t.Fatalf("replay = %v, want replayed=true for %s", replay, deviceID)
	}

	// A different request_id presenting the same challenge must fail: the challenge was
	// consumed, and a consumed challenge is never reusable.
	expectCode(t, api, "unauthorized",
		`SELECT work.confirm_device_pairing($1,$2,'bearer',7,$3::uuid,$4,$5,'sha256:`+strings.Repeat("c", 64)+`')`,
		f.org, f.subject, f.scalar(t, "SELECT id::text FROM work.device_pairing WHERE org_id = "+quoteLiteral(f.org)+" LIMIT 1"),
		"req-pair-2-confirm", challenge)

	// A wrong challenge is refused even before the state check would matter.
	pairing2 := callJSON(t, api,
		`SELECT work.pair_device($1,$2,'bearer',7,$3,'desk2','windows-x64',$4::jsonb)`,
		f.org, f.subject, "req-pair-3", strings.Replace(deviceTestKeyJWK, "AAAA", "CCCC", 1))
	expectCode(t, api, "invalid_request:signature",
		`SELECT work.confirm_device_pairing($1,$2,'bearer',7,$3::uuid,$4,$5,'sha256:`+strings.Repeat("c", 64)+`')`,
		f.org, f.subject, pairing2["pairing_id"], "req-pair-3-confirm", strings.Repeat("f", 64))

	if got := f.scalar(t, "SELECT count(*)::text FROM work.device WHERE org_id = "+quoteLiteral(f.org)); got != "2" {
		t.Fatalf("device rows = %s, want 2 (one active, one still pending)", got)
	}
}

func TestR0bDeviceSessionTicketIsSingleUseAndOneSessionPerDevice(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_device_ticket")
	api := f.apiConn(t)
	worker := f.workerConn(t)
	deviceID, _ := f.pairAndConfirm(t, api, "req-tick-pair")

	thumb := f.scalar(t, "SELECT public_key_thumbprint FROM work.device WHERE id = "+quoteLiteral(deviceID))
	minted := callJSON(t, api,
		`SELECT work.mint_device_session_ticket($1,$2,'bearer',7,$3::uuid,$4,$5)`,
		f.org, f.subject, deviceID, "req-tick-1", thumb)
	ticket, _ := minted["ticket"].(string)
	if ticket == "" {
		t.Fatalf("mint returned no ticket: %v", minted)
	}
	ticketHash := f.scalar(t, "SELECT work.sha256_text("+quoteLiteral(ticket)+")")
	hello := `{"boot_id":"boot-1","agent_instance_id":"` + newUUID(t) + `","journal_epoch":"` + newUUID(t) +
		`","runtime_digest":"` + strings.Repeat("d", 64) + `","protocol_major":2,"protocol_minor":0}`

	first := callJSON(t, worker, `SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`,
		f.org, deviceID, ticketHash, hello)
	if first["session_id"] == nil {
		t.Fatalf("hello returned no session: %v", first)
	}
	// The ticket is consumed: a second hello with the same ticket must not mint a session.
	expectCode(t, worker, "unauthorized",
		`SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`,
		f.org, deviceID, ticketHash, hello)
	if got := f.scalar(t, "SELECT count(*)::text FROM work.device_session WHERE org_id = "+quoteLiteral(f.org)); got != "1" {
		t.Fatalf("session rows = %s, want 1", got)
	}
	if got := f.scalar(t, "SELECT state FROM work.device_session_ticket WHERE org_id = "+quoteLiteral(f.org)); got != "consumed" {
		t.Fatalf("ticket state = %s, want consumed", got)
	}

	// A second ticket supersedes the first session rather than deleting it, and the
	// partial unique index keeps exactly one active row.
	minted2 := callJSON(t, api,
		`SELECT work.mint_device_session_ticket($1,$2,'bearer',7,$3::uuid,$4,$5)`,
		f.org, f.subject, deviceID, "req-tick-2", thumb)
	ticket2, _ := minted2["ticket"].(string)
	hash2 := f.scalar(t, "SELECT work.sha256_text("+quoteLiteral(ticket2)+")")
	callJSON(t, worker, `SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`,
		f.org, deviceID, hash2, hello)
	if got := f.scalar(t, "SELECT count(*)::text FROM work.device_session WHERE org_id = "+quoteLiteral(f.org)+" AND state = 'active'"); got != "1" {
		t.Fatalf("active sessions = %s, want 1", got)
	}
	if got := f.scalar(t, "SELECT count(*)::text FROM work.device_session WHERE org_id = "+quoteLiteral(f.org)+" AND state = 'superseded'"); got != "1" {
		t.Fatalf("superseded sessions = %s, want 1 (evidence is not deleted)", got)
	}
}

// TestR0bDeviceRevokeWritesCancellationIntent is the test the privilege sweep names:
// cancellation_intent left the "structure without a writer" set in 0040, so the writer
// has to be exercised for real, including the binding to the deny and the replay.
func TestR0bDeviceRevokeWritesCancellationIntent(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_device_revoke")
	api := f.apiConn(t)
	deviceID, _ := f.pairAndConfirm(t, api, "req-rev-pair")

	// A binding tying the parked Run to this device, plus an active session and lease.
	thumb := f.scalar(t, "SELECT public_key_thumbprint FROM work.device WHERE id = "+quoteLiteral(deviceID))
	minted := callJSON(t, api,
		`SELECT work.mint_device_session_ticket($1,$2,'bearer',7,$3::uuid,$4,$5)`,
		f.org, f.subject, deviceID, "req-rev-tick", thumb)
	ticket, _ := minted["ticket"].(string)
	hash := f.scalar(t, "SELECT work.sha256_text("+quoteLiteral(ticket)+")")
	hello := `{"boot_id":"boot-r","agent_instance_id":"` + newUUID(t) + `","journal_epoch":"` + newUUID(t) +
		`","runtime_digest":"` + strings.Repeat("e", 64) + `","protocol_major":2,"protocol_minor":0}`
	session := callJSON(t, f.workerConn(t), `SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`,
		f.org, deviceID, hash, hello)
	sessionID, _ := session["session_id"].(string)

	grant := callJSON(t, api,
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		f.org, f.subject, deviceID, sessionID, "req-rev-grant",
		`{"root_identity_hash":"`+strings.Repeat("1", 64)+`","allowed_tools":["workspace.read"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}`)
	grantID, _ := grant["grant_id"].(string)

	mustExec(t, f.admin, "UPDATE work.run SET state = 'active', wait_reason = NULL WHERE id = "+quoteLiteral(f.runID))
	mustExec(t, f.admin, `INSERT INTO work.device_run_binding
		(org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref, input_hash,
		 snapshot_hash, profile_id, profile_revision, runtime_digest, tool_manifest_hash,
		 model_version, grant_set, start_nonce, offer_expiry, state)
		VALUES (`+quoteLiteral(f.org)+", "+quoteLiteral(f.runID)+", 1, "+quoteLiteral(f.taskID)+", "+
		quoteLiteral(deviceID)+", "+quoteLiteral(sessionID)+", 'ref', '"+strings.Repeat("2", 64)+"', '"+
		strings.Repeat("3", 64)+"', 'p1', 1, '"+strings.Repeat("4", 64)+"', '"+strings.Repeat("5", 64)+
		"', 'm1', '"+`[{"grant_id":"`+grantID+`","grant_revision":1}]`+"'::jsonb, "+quoteLiteral(newUUID(t))+
		", now() + interval '2 minutes', 'active')")
	mustExec(t, f.admin, `INSERT INTO work.execution_lease
		(org_id, run_id, device_id, session_id, binding_revision, fence, generation, purpose,
		 start_nonce, expires_at)
		VALUES (`+quoteLiteral(f.org)+", "+quoteLiteral(f.runID)+", "+quoteLiteral(deviceID)+", "+
		quoteLiteral(sessionID)+", 1, 2, 0, 'execute', "+quoteLiteral(newUUID(t))+
		", now() + interval '30 seconds')")

	revoked := callJSON(t, api, `SELECT work.revoke_device($1,$2,$3::uuid,$4,'left the org')`,
		f.org, f.subject, deviceID, "req-rev-1")
	if revoked["status"] != "revoked" {
		t.Fatalf("revoke = %v", revoked)
	}
	if revoked["revoked_sessions"] != float64(1) || revoked["revoked_leases"] != float64(1) {
		t.Fatalf("revoke did not terminalize the session and the lease: %v", revoked)
	}
	if revoked["cancellation_intents"] != float64(1) {
		t.Fatalf("cancellation_intents = %v, want 1", revoked["cancellation_intents"])
	}
	denyID, _ := revoked["restriction_id"].(string)

	// The intent is bound to the deny that caused it, which is what makes "same source,
	// same Run" unique rather than a convention.
	if got := f.scalar(t, "SELECT count(*)::text FROM work.cancellation_intent WHERE org_id = "+quoteLiteral(f.org)+
		" AND source_event_id = "+quoteLiteral(denyID)+" AND run_id = "+quoteLiteral(f.runID)); got != "1" {
		t.Fatalf("intent bound to the deny = %s, want 1", got)
	}
	if got := f.scalar(t, "SELECT scope || '/' || source FROM work.access_restriction WHERE id = "+quoteLiteral(denyID)); got != "device/device" {
		t.Fatalf("deny scope/source = %s, want device/device", got)
	}
	// No outbox row: the relay fails unknown kinds non-retryably, so the audit row and
	// the intent are the carriers (0019:178-195).
	if got := f.scalar(t, "SELECT count(*)::text FROM work.outbox WHERE org_id = "+quoteLiteral(f.org)); got != "0" {
		t.Fatalf("outbox rows = %s, want 0", got)
	}

	// Replay returns the original receipt and creates nothing new.
	again := callJSON(t, api, `SELECT work.revoke_device($1,$2,$3::uuid,$4,'left the org')`,
		f.org, f.subject, deviceID, "req-rev-1")
	if again["replayed"] != true || again["restriction_id"] != denyID {
		t.Fatalf("replay = %v, want the original deny %s", again, denyID)
	}
	if got := f.scalar(t, "SELECT count(*)::text FROM work.cancellation_intent WHERE org_id = "+quoteLiteral(f.org)); got != "1" {
		t.Fatalf("intents after replay = %s, want 1", got)
	}
	// Same key, different payload is a conflict, not a second revocation.
	expectCode(t, api, "idempotency_key_conflict",
		`SELECT work.revoke_device($1,$2,$3::uuid,$4,'a different reason')`,
		f.org, f.subject, deviceID, "req-rev-1")
}

func TestR0bWorkspaceGrantClassificationComesFromTheMapping(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_grant_class")
	api := f.apiConn(t)
	deviceID, _ := f.pairAndConfirm(t, api, "req-cls-pair")
	thumb := f.scalar(t, "SELECT public_key_thumbprint FROM work.device WHERE id = "+quoteLiteral(deviceID))
	minted := callJSON(t, api,
		`SELECT work.mint_device_session_ticket($1,$2,'bearer',7,$3::uuid,$4,$5)`,
		f.org, f.subject, deviceID, "req-cls-tick", thumb)
	ticket, _ := minted["ticket"].(string)
	hash := f.scalar(t, "SELECT work.sha256_text("+quoteLiteral(ticket)+")")
	hello := `{"boot_id":"boot-c","agent_instance_id":"` + newUUID(t) + `","journal_epoch":"` + newUUID(t) +
		`","runtime_digest":"` + strings.Repeat("9", 64) + `","protocol_major":2,"protocol_minor":0}`
	session := callJSON(t, f.workerConn(t), `SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`,
		f.org, deviceID, hash, hello)
	sessionID, _ := session["session_id"].(string)

	register := func(requestID, body string) map[string]any {
		return callJSON(t, api,
			`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
			f.org, f.subject, deviceID, sessionID, requestID, body)
	}
	root := strings.Repeat("7", 64)

	// Rule 1 maps to remote_excerpt_allowed; the server takes that value, not the claim.
	got := register("req-cls-1", `{"root_identity_hash":"`+root+`","allowed_tools":["workspace.read"],"matched_rule_index":1,"classification_claimed":"remote_excerpt_allowed","user_selected_ttl_seconds":3600}`)
	if got["classification"] != "remote_excerpt_allowed" {
		t.Fatalf("rule 1 classification = %v, want remote_excerpt_allowed", got["classification"])
	}

	// A claim looser than the mapping is refused outright, with zero rows written.
	expectCode(t, api, "classification_floor_required",
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		f.org, f.subject, deviceID, sessionID, "req-cls-2",
		`{"root_identity_hash":"`+root+`","allowed_tools":["workspace.read"],"matched_rule_index":0,"classification_claimed":"remote_excerpt_allowed","user_selected_ttl_seconds":3600}`)

	// No rule matched: the confirmed default applies, and it is local_only.
	got = register("req-cls-3", `{"root_identity_hash":"`+root+`","allowed_tools":["workspace.read"],"user_selected_ttl_seconds":3600}`)
	if got["classification"] != "local_only" {
		t.Fatalf("default classification = %v, want local_only", got["classification"])
	}

	// A tool outside the organization's allowlist is refused: only narrowing is allowed.
	expectCode(t, api, "invalid_request",
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		f.org, f.subject, deviceID, sessionID, "req-cls-4",
		`{"root_identity_hash":"`+root+`","allowed_tools":["model.send_remote"],"user_selected_ttl_seconds":3600}`)

	// An out-of-range rule index is a request error, not a silent fallback to the default.
	expectCode(t, api, "invalid_request",
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		f.org, f.subject, deviceID, sessionID, "req-cls-5",
		`{"root_identity_hash":"`+root+`","allowed_tools":["workspace.read"],"matched_rule_index":9,"user_selected_ttl_seconds":3600}`)

	if got := f.scalar(t, "SELECT count(*)::text FROM work.workspace_grant WHERE org_id = "+quoteLiteral(f.org)); got != "2" {
		t.Fatalf("grant rows = %s, want 2 (the refusals wrote nothing)", got)
	}
}

func TestR0bDeviceSlicePrivilegesAndRePairAfterRevoke(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_device_priv")
	api := f.apiConn(t)
	deviceID, _ := f.pairAndConfirm(t, api, "req-priv-pair")

	// No workload role holds direct SELECT on any of the nine tables.
	for _, table := range []string{"device", "device_pairing", "device_session",
		"device_session_ticket", "workspace_grant", "workspace_grant_succession",
		"execution_lease", "device_run_binding", "readonly_approval_grant"} {
		for _, role := range []string{"work_api", "work_worker"} {
			if got := f.scalar(t, "SELECT has_table_privilege("+quoteLiteral(role)+
				", 'work."+table+"', 'SELECT')::text"); got != "false" {
				t.Fatalf("%s holds SELECT on work.%s", role, table)
			}
		}
	}
	// The gateway face belongs to work_worker, and work_api must not have it.
	if got := f.scalar(t, `SELECT has_function_privilege('work_api',
		'work.activate_device_session(text,uuid,text,jsonb)', 'EXECUTE')::text`); got != "false" {
		t.Fatal("work_api can execute the gateway hello command")
	}
	if got := f.scalar(t, `SELECT has_function_privilege('work_worker',
		'work.pair_device(text,text,text,bigint,text,text,text,jsonb)', 'EXECUTE')::text`); got != "false" {
		t.Fatal("work_worker can execute the API pairing command")
	}

	// Revocation must not reserve the key forever: device §2.1 says re-pairing mints a
	// new id, so the same CNG key has to be usable again afterwards.
	callJSON(t, api, `SELECT work.revoke_device($1,$2,$3::uuid,$4,'revoke')`,
		f.org, f.subject, deviceID, "req-priv-rev")
	again := callJSON(t, api,
		`SELECT work.pair_device($1,$2,'bearer',7,$3,'desk','windows-x64',$4::jsonb)`,
		f.org, f.subject, "req-priv-repair", deviceTestKeyJWK)
	if again["device_id"] == deviceID {
		t.Fatal("re-pairing reused the revoked device id")
	}
	if got := f.scalar(t, "SELECT count(*)::text FROM work.device WHERE org_id = "+quoteLiteral(f.org)); got != "2" {
		t.Fatalf("device rows = %s, want 2", got)
	}
}
