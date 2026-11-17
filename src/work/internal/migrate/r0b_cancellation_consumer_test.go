package migrate

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for increment 0057: the governance cancellation-intent consumer (control §6.1).
//
// Before this increment `consumed` and `dead_letter` had no writer at all - the orphan-state
// debt §6.1:389 records. These tests cover the claims the increment exists for: the claim is
// capped per Task and per org and keeps its cursor instead of skipping the overflow; the
// predicate is RE-CHECKED under the Task lock per scope rather than trusted from the producer;
// the consume writes the cancel path and no terminal Run state; the failure ladder is §6.1's
// 1s..60s with dead-letter at 10 and an audit alert; and ops replay is the only way back from
// dead_letter, never from consumed.

const claimCancelsSQL = `SELECT work.claim_pending_cancellation_intents($1, $2, $3)`
const consumeCancelSQL = `SELECT work.consume_cancellation_intent($1, $2::uuid, $3::uuid)`
const failCancelSQL = `SELECT work.fail_cancellation_intent($1, $2::uuid, $3::uuid, $4)`
const requeueCancelSQL = `SELECT work.requeue_cancellation_dead_letter($1, $2::uuid, $3::uuid, $4, $5)`

type cancelRunRef struct {
	taskID string
	runID  string
}

// cancelSeedRuns adds n more Task+Run graphs to the fixture organization, each admitted at
// `epoch` and owned by `owner`, so the per-scope predicate has something to discriminate.
// The epoch is produced by moving the org counter first: 0018:37-49 stamps admission_access_epoch
// from work.org at INSERT and deliberately overwrites whatever a caller passed, so a Run
// "admitted after the deny" is a Run inserted while the org epoch is already higher.
func cancelSeedRuns(t *testing.T, f *deviceFixture, n int, owner string, epoch int, state string) []cancelRunRef {
	t.Helper()
	mustExec(t, f.admin, "UPDATE work.org SET access_epoch = "+fmt.Sprint(epoch)+
		" WHERE id = "+quoteLiteral(f.org))
	if owner != f.subject {
		mustExec(t, f.admin, "INSERT INTO work.member (org_id, subject_id, status, role, work_seat) VALUES ("+
			quoteLiteral(f.org)+", "+quoteLiteral(owner)+", 'active', 'member', true) "+
			"ON CONFLICT (org_id, subject_id) DO NOTHING")
	}
	var batch strings.Builder
	refs := make([]cancelRunRef, 0, n)
	for i := 0; i < n; i++ {
		task, run, snapshot, input := newUUID(t), newUUID(t), newUUID(t), newUUID(t)
		refs = append(refs, cancelRunRef{taskID: task, runID: run})
		// task and capability_snapshot reference each other, so the graph lands in one batch.
		fmt.Fprintf(&batch, `
INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status)
VALUES (%[1]s, %[2]s, %[3]s, %[5]s, encode(sha256(%[5]s::bytea), 'hex'), 1, 'text/plain', 'active');
INSERT INTO work.capability_snapshot
  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
VALUES (%[6]s, %[2]s, %[7]s, 'v1', repeat('a', 64), ARRAY['workspace.read'], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, input_id, title)
VALUES (%[7]s, %[2]s, %[3]s, 'open', %[6]s, %[1]s, 'cancel consumer');
INSERT INTO work.run
  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
VALUES (%[4]s, %[2]s, %[7]s, 1, %[8]s, %[6]s, %[9]s, 'v1');
UPDATE work.task SET active_run_id = %[4]s, latest_run_id = %[4]s WHERE id = %[7]s;
`,
			quoteLiteral(input), quoteLiteral(f.org), quoteLiteral(owner), quoteLiteral(run),
			quoteLiteral("seed-"+run), quoteLiteral(snapshot), quoteLiteral(task),
			quoteLiteral(state), quoteLiteral("wf-"+run))
	}
	if err := execRaw(testContext(t), f.admin, batch.String()); err != nil {
		t.Fatalf("seed cancel runs: %v", err)
	}
	return refs
}

// cancelDeny writes the scope authority the consumer joins back to. source 'governance'
// leaves host_revision NULL, which is the shape 0018's constraint requires of every
// non-host_* deny (and the reason §6.1's affected_revision has no value for device/grant).
func cancelDeny(t *testing.T, f *deviceFixture, scope, subject string, epoch int) string {
	t.Helper()
	id := newUUID(t)
	mustExec(t, f.admin, "INSERT INTO work.access_restriction "+
		"(id, org_id, scope, subject_id, source, reason, epoch, release_floor_revision, state) VALUES ("+
		quoteLiteral(id)+", "+quoteLiteral(f.org)+", "+quoteLiteral(scope)+", "+quoteLiteralOrNULL(subject)+
		", 'governance', 'seat_revoked', "+fmt.Sprint(epoch)+", 0, 'active')")
	return id
}

func cancelIntent(t *testing.T, f *deviceFixture, denyID, runID string, dueOffsetSeconds int) {
	t.Helper()
	mustExec(t, f.admin, "INSERT INTO work.cancellation_intent "+
		"(org_id, source_event_id, run_id, reason, next_attempt) VALUES ("+
		quoteLiteral(f.org)+", "+quoteLiteral(denyID)+", "+quoteLiteral(runID)+", 'seat_revoked', now() + ("+
		fmt.Sprint(dueOffsetSeconds)+" * interval '1 second'))")
}

// cancelResetDue stands in for time passing: next_attempt is mutable, so a round that has
// already been claimed can be made due again without touching the immutable content.
func cancelResetDue(t *testing.T, f *deviceFixture) {
	t.Helper()
	mustExec(t, f.admin, "UPDATE work.cancellation_intent SET next_attempt = now() - interval '1 second' "+
		"WHERE org_id = "+quoteLiteral(f.org)+" AND state = 'pending'")
}

func claimCancels(t *testing.T, conn *pgx.Conn, org string, taskLimit, intentLimit any) []any {
	t.Helper()
	out := callJSON(t, conn, claimCancelsSQL, org, taskLimit, intentLimit)
	intents, ok := out["intents"].([]any)
	if !ok {
		t.Fatalf("claim returned no intents array: %v", out)
	}
	return intents
}

func consumeCancel(t *testing.T, conn *pgx.Conn, org, denyID, runID string) map[string]any {
	t.Helper()
	return callJSON(t, conn, consumeCancelSQL, org, denyID, runID)
}

func failCancel(t *testing.T, conn *pgx.Conn, org, denyID, runID string, retryable bool) map[string]any {
	t.Helper()
	return callJSON(t, conn, failCancelSQL, org, denyID, runID, retryable)
}

func (f *deviceFixture) opsCancelConn(t *testing.T) *pgx.Conn {
	t.Helper()
	conn := connect(t, testpg.OpsURL(f.dbName))
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	mustExec(t, conn, "SET app.org_id = "+quoteLiteral(f.org)+
		"; SET app.subject_id = "+quoteLiteral(f.subject))
	return conn
}

func cancelOp(t *testing.T, f *deviceFixture, runID, state string) string {
	t.Helper()
	id := newUUID(t)
	mustExec(t, f.admin, "INSERT INTO work.operation "+
		"(id, org_id, run_id, logical_key, kind, request_hash, state) VALUES ("+
		quoteLiteral(id)+", "+quoteLiteral(f.org)+", "+quoteLiteral(runID)+", "+
		quoteLiteral("model:"+id)+", 'model', repeat('c', 64), "+quoteLiteral(state)+")")
	return id
}

func cancelCount(t *testing.T, f *deviceFixture, sql string) string {
	t.Helper()
	return f.scalar(t, sql+" AND org_id = "+quoteLiteral(f.org))
}

func TestR0bCancellationClaimIsCappedAndKeepsTheCursor(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_cancel_claim")
	worker := f.workerConn(t)
	runs := cancelSeedRuns(t, f, 4, f.subject, 0, "active")
	deny := cancelDeny(t, f, "org", "", 0)
	for i, r := range runs {
		cancelIntent(t, f, deny, r.runID, -40+10*i)
	}

	// The Task budget is spent on the Tasks whose oldest intent is due first.
	intents := claimCancels(t, worker, f.org, 2, 500)
	if len(intents) != 2 {
		t.Fatalf("claimed %d intents, want the 2 oldest Tasks", len(intents))
	}
	for i, want := range []string{runs[0].runID, runs[1].runID} {
		row := intents[i].(map[string]any)
		if row["run_id"] != want {
			t.Fatalf("claim order[%d] = %v, want %s (oldest due first)", i, row["run_id"], want)
		}
		if row["task_id"] != runs[i].taskID || row["reason"] != "seat_revoked" || row["attempts"] != float64(0) {
			t.Fatalf("claimed row = %v", row)
		}
	}
	// §6.1 "超量保留cursor继续，不跳过": the overflow stays pending AND still due.
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.cancellation_intent WHERE state = 'pending' AND next_attempt <= now()"); got != "2" {
		t.Fatalf("still-due overflow = %s, want 2 (the cursor must not skip)", got)
	}
	// The visibility window is what keeps a second consumer off the in-flight rows, and it
	// is not a failure: attempts must stay 0 so only real failures count toward dead-letter.
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.cancellation_intent WHERE next_attempt > now()"); got != "2" {
		t.Fatalf("claimed rows pushed out of the due window = %s, want 2", got)
	}
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.cancellation_intent WHERE attempts <> 0"); got != "0" {
		t.Fatalf("claim bumped attempts on %s rows, want 0", got)
	}
	// The next round picks the overflow up (the cursor continued) and nothing else: the two
	// rows already in flight are inside the visibility window.
	intents = claimCancels(t, worker, f.org, 100, 500)
	if len(intents) != 2 {
		t.Fatalf("second round claimed %d, want the 2 overflow intents", len(intents))
	}
	for i, want := range []string{runs[2].runID, runs[3].runID} {
		if intents[i].(map[string]any)["run_id"] != want {
			t.Fatalf("second round[%d] = %v, want %s", i, intents[i], want)
		}
	}
	if n := len(claimCancels(t, worker, f.org, 100, 500)); n != 0 {
		t.Fatalf("a third round inside the visibility window claimed %d, want 0", n)
	}

	// The intent cap applies inside the Task budget.
	cancelResetDue(t, f)
	if n := len(claimCancels(t, worker, f.org, 100, 1)); n != 1 {
		t.Fatalf("intent_limit 1 claimed %d, want 1", n)
	}
	// Both caps clamp like claim_outbox: 0 and NULL are not "unlimited".
	cancelResetDue(t, f)
	if n := len(claimCancels(t, worker, f.org, 0, 0)); n != 1 {
		t.Fatalf("claim(0,0) claimed %d, want the clamped 1", n)
	}
	cancelResetDue(t, f)
	if n := len(claimCancels(t, worker, f.org, nil, nil)); n != 4 {
		t.Fatalf("claim(NULL,NULL) claimed %d, want all 4", n)
	}

	// The ruled Task ceiling is 100: a 105-Task backlog serves 100 Tasks and leaves the rest.
	more := cancelSeedRuns(t, f, 101, f.subject, 0, "active")
	for _, r := range more {
		cancelIntent(t, f, deny, r.runID, -1)
	}
	intents = claimCancels(t, worker, f.org, nil, nil)
	if len(intents) != 100 {
		t.Fatalf("claimed %d intents across 105 due Tasks, want the 100-Task ceiling", len(intents))
	}
	tasks := map[string]bool{}
	for _, raw := range intents {
		tasks[raw.(map[string]any)["task_id"].(string)] = true
	}
	if len(tasks) != 100 {
		t.Fatalf("claimed %d distinct Tasks, want 100", len(tasks))
	}

	// The ruled per-org ceiling is 500. 501 denies on one Run is a real backlog deeper than
	// the ceiling: the PK is (org, source_event_id, run_id), so it needs no 501 Tasks.
	// Everything left over from the Task-ceiling round is parked first, so the only due rows
	// are the 501 and the overflow count below is exactly the 501st.
	mustExec(t, f.admin, "UPDATE work.cancellation_intent SET next_attempt = now() + interval '60 seconds' "+
		"WHERE org_id = "+quoteLiteral(f.org)+" AND state = 'pending'")
	deep := cancelSeedRuns(t, f, 1, f.subject, 0, "active")[0]
	mustExec(t, f.admin, "INSERT INTO work.access_restriction "+
		"(id, org_id, scope, source, reason, epoch, release_floor_revision) "+
		"SELECT gen_random_uuid(), "+quoteLiteral(f.org)+", 'org', 'governance', 'bulk_revoked', 0, 0 "+
		"FROM generate_series(1, 501)")
	mustExec(t, f.admin, "INSERT INTO work.cancellation_intent (org_id, source_event_id, run_id, reason) "+
		"SELECT "+quoteLiteral(f.org)+", id, "+quoteLiteral(deep.runID)+", 'bulk_revoked' "+
		"FROM work.access_restriction WHERE org_id = "+quoteLiteral(f.org)+" AND reason = 'bulk_revoked'")
	if n := len(claimCancels(t, worker, f.org, nil, nil)); n != 500 {
		t.Fatalf("claimed %d of 501 due intents, want the 500 ceiling", n)
	}
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.cancellation_intent WHERE state = 'pending' AND next_attempt <= now()"); got != "1" {
		t.Fatalf("still-due overflow = %s, want the 501st keeping its cursor", got)
	}
}

func TestR0bCancellationConsumeRechecksEpochAndOwner(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_cancel_scope")
	worker := f.workerConn(t)

	// org scope: the cutoff is the RETIRED epoch, so a Run admitted after the deny is out.
	// Both epoch-5 Runs are seeded before the counter moves to 6, because the stamp is taken
	// at INSERT and cannot be rewritten afterwards.
	atCutoff := cancelSeedRuns(t, f, 1, f.subject, 5, "active")[0]
	restored := cancelSeedRuns(t, f, 1, f.subject, 5, "active")[0]
	afterCutoff := cancelSeedRuns(t, f, 1, f.subject, 6, "active")[0]
	orgDeny := cancelDeny(t, f, "org", "", 5)
	cancelIntent(t, f, orgDeny, atCutoff.runID, -1)
	cancelIntent(t, f, orgDeny, afterCutoff.runID, -1)

	out := consumeCancel(t, worker, f.org, orgDeny, atCutoff.runID)
	wantStr(t, out, "outcome", "cancel_requested")
	wantStr(t, out, "state", "consumed")
	if out["cancel_revision"] != "1" {
		t.Fatalf("cancel_revision = %v, want the text \"1\"", out["cancel_revision"])
	}
	if got := f.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(atCutoff.runID)); got != "cancel_requested" {
		t.Fatalf("in-scope Run state = %s, want cancel_requested", got)
	}

	out = consumeCancel(t, worker, f.org, orgDeny, afterCutoff.runID)
	wantStr(t, out, "outcome", "out_of_scope")
	wantStr(t, out, "state", "consumed")
	if out["cancel_revision"] != nil {
		t.Fatalf("out_of_scope returned cancel_revision %v, want null", out["cancel_revision"])
	}
	// Out of scope is consumed without a single Run write: no state, no revision, no event,
	// no outbox hand-off, no audit. The intent is settled, the Run is untouched.
	if got := f.scalar(t, "SELECT state || '/' || control_revision::text FROM work.run WHERE id = "+
		quoteLiteral(afterCutoff.runID)); got != "active/0" {
		t.Fatalf("out-of-scope Run = %s, want active/0", got)
	}
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.outbox WHERE aggregate_id = "+
		quoteLiteral(afterCutoff.runID)); got != "0" {
		t.Fatalf("out-of-scope outbox rows = %s, want 0", got)
	}
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.task_event WHERE task_id = "+
		quoteLiteral(afterCutoff.taskID)); got != "0" {
		t.Fatalf("out-of-scope task events = %s, want 0", got)
	}

	// member scope: the same epoch test PLUS the owner test. §6.1 "不以当前该成员的所有Run
	// 代替" - a Run owned by somebody else is out even at the same admission epoch.
	other := "sub_other_" + f.org
	mine := cancelSeedRuns(t, f, 1, f.subject, 6, "active")[0]
	theirs := cancelSeedRuns(t, f, 1, other, 6, "active")[0]
	memberDeny := cancelDeny(t, f, "member", f.subject, 6)
	cancelIntent(t, f, memberDeny, mine.runID, -1)
	cancelIntent(t, f, memberDeny, theirs.runID, -1)
	wantStr(t, consumeCancel(t, worker, f.org, memberDeny, mine.runID), "outcome", "cancel_requested")
	wantStr(t, consumeCancel(t, worker, f.org, memberDeny, theirs.runID), "outcome", "out_of_scope")
	if got := f.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(theirs.runID)); got != "active" {
		t.Fatalf("another member's Run = %s, want active", got)
	}

	// A RELEASED deny still cancels the Runs it already scoped: §6.1 "旧Run即使后来恢复席位
	// 仍属于原取消范围，不自动复活". Releasing stops new admissions, it does not resurrect.
	mustExec(t, f.admin, "UPDATE work.access_restriction SET state = 'released', "+
		"released_by_revision = 1, released_at = now() WHERE id = "+quoteLiteral(orgDeny))
	cancelIntent(t, f, orgDeny, restored.runID, -1)
	wantStr(t, consumeCancel(t, worker, f.org, orgDeny, restored.runID), "outcome", "cancel_requested")
	if got := f.scalar(t, "SELECT state FROM work.access_restriction WHERE id = "+quoteLiteral(orgDeny)); got != "released" {
		t.Fatalf("the consumer moved the deny to %s, want it retained as released", got)
	}

	// Fail closed without the scope authority: an intent whose deny cannot be read is not
	// consumed blind, and it stays pending so the failure ladder can act on it.
	orphan := cancelSeedRuns(t, f, 1, f.subject, 6, "active")[0]
	missingDeny := newUUID(t)
	cancelIntent(t, f, missingDeny, orphan.runID, -1)
	expectCode(t, worker, "not_found", consumeCancelSQL, f.org, missingDeny, orphan.runID)
	if got := f.scalar(t, "SELECT state FROM work.cancellation_intent WHERE source_event_id = "+
		quoteLiteral(missingDeny)); got != "pending" {
		t.Fatalf("unverifiable intent = %s, want pending", got)
	}
	if got := f.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(orphan.runID)); got != "active" {
		t.Fatalf("Run cancelled without a readable deny: %s", got)
	}
}

// bindCancelRun pairs a fresh device, opens a session, registers a workspace grant and binds
// the Run to it - the resource facts the device/grant predicates re-check. It mirrors the
// binding the 0040 revocation tests use, without the lease (no lease is under test here).
func bindCancelRun(t *testing.T, f *deviceFixture, api *pgx.Conn, ref cancelRunRef, tag string) (string, string) {
	t.Helper()
	// One key per device: pair_device refuses a second unrevoked device with the same
	// thumbprint (0040:1233-1236), so the fixture's shared test key cannot be reused.
	jwk := `{"crv":"P-256","kty":"EC","x":"` + strings.Repeat("A", 42) + tag[len(tag)-1:] +
		`","y":"` + strings.Repeat("B", 43) + `"}`
	pairing := callJSON(t, api,
		`SELECT work.pair_device($1,$2,'bearer',7,$3,'desk','windows-x64',$4::jsonb)`,
		f.org, f.subject, "req-"+tag+"-pair", jwk)
	challenge, _ := pairing["challenge"].(string)
	deviceID, _ := pairing["device_id"].(string)
	confirmed := callJSON(t, api,
		`SELECT work.confirm_device_pairing($1,$2,'bearer',7,$3::uuid,$4,$5,'`+deviceTestConfirmSignature+`')`,
		f.org, f.subject, pairing["pairing_id"], "req-"+tag+"-pair-confirm", challenge)
	if confirmed["status"] != "active" {
		t.Fatalf("confirm status = %v, want active", confirmed["status"])
	}
	thumb := f.scalar(t, "SELECT public_key_thumbprint FROM work.device WHERE id = "+quoteLiteral(deviceID))
	minted := callJSON(t, api,
		`SELECT work.mint_device_session_ticket($1,$2,'bearer',7,$3::uuid,$4,$5)`,
		f.org, f.subject, deviceID, "req-"+tag+"-tick", thumb)
	ticket, _ := minted["ticket"].(string)
	hash := f.scalar(t, "SELECT work.sha256_text("+quoteLiteral(ticket)+")")
	hello := `{"boot_id":"boot-` + tag + `","agent_instance_id":"` + newUUID(t) + `","journal_epoch":"` + newUUID(t) +
		`","runtime_digest":"` + strings.Repeat("e", 64) + `","protocol_major":2,"protocol_minor":0}`
	session := callJSON(t, f.workerConn(t), `SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`,
		f.org, deviceID, hash, hello)
	sessionID, _ := session["session_id"].(string)
	grant := callJSON(t, api,
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		f.org, f.subject, deviceID, sessionID, "req-"+tag+"-grant",
		`{"root_identity_hash":"`+strings.Repeat("1", 64)+`","allowed_tools":["workspace.read"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}`)
	grantID, _ := grant["grant_id"].(string)
	mustExec(t, f.admin, `INSERT INTO work.device_run_binding
		(org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref, input_hash,
		 snapshot_hash, profile_id, profile_revision, runtime_digest, tool_manifest_hash,
		 model_version, grant_set, start_nonce, offer_expiry, state)
		VALUES (`+quoteLiteral(f.org)+", "+quoteLiteral(ref.runID)+", 1, "+quoteLiteral(ref.taskID)+", "+
		quoteLiteral(deviceID)+", "+quoteLiteral(sessionID)+", 'ref', '"+strings.Repeat("2", 64)+"', '"+
		strings.Repeat("3", 64)+"', 'p1', 1, '"+strings.Repeat("4", 64)+"', '"+strings.Repeat("5", 64)+
		"', 'm1', '"+`[{"grant_id":"`+grantID+`","grant_revision":1}]`+"'::jsonb, "+quoteLiteral(newUUID(t))+
		", now() + interval '2 minutes', 'active')")
	return deviceID, grantID
}

func TestR0bCancellationConsumeRechecksTheResourcePredicate(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_cancel_resource")
	api := f.apiConn(t)
	worker := f.workerConn(t)
	first := cancelRunRef{taskID: f.taskID, runID: f.runID}
	second := cancelSeedRuns(t, f, 1, f.subject, 0, "active")[0]
	device1, _ := bindCancelRun(t, f, api, first, "r1")
	device2, grant2 := bindCancelRun(t, f, api, second, "r2")

	// The real producers queue the intents; the consumer re-derives the scope from the deny.
	revoked := callJSON(t, api, `SELECT work.revoke_device($1,$2,$3::uuid,$4,'left the org')`,
		f.org, f.subject, device1, "req-r1-rev")
	deviceDeny, _ := revoked["restriction_id"].(string)
	if revoked["cancellation_intents"] != float64(1) {
		t.Fatalf("revoke_device queued %v intents, want 1", revoked["cancellation_intents"])
	}
	wantStr(t, consumeCancel(t, worker, f.org, deviceDeny, first.runID), "outcome", "cancel_requested")
	if got := f.scalar(t, "SELECT state || '/' || coalesce(wait_reason, 'null') FROM work.run WHERE id = "+
		quoteLiteral(first.runID)); got != "cancel_requested/null" {
		t.Fatalf("bound Run = %s, want cancel_requested with wait_reason cleared", got)
	}

	// A device deny does not reach a Run bound to another device, even in the same org.
	cancelIntent(t, f, deviceDeny, second.runID, -1)
	wantStr(t, consumeCancel(t, worker, f.org, deviceDeny, second.runID), "outcome", "out_of_scope")
	if got := f.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(second.runID)); got != "active" {
		t.Fatalf("Run bound to %s was cancelled by a deny on %s: %s", device2, device1, got)
	}

	// grant scope: the binding's grant_set must actually contain the revoked grant.
	grantRevoked := callJSON(t, api, `SELECT work.revoke_workspace_grant($1,$2,$3::uuid,$4,'grant withdrawn')`,
		f.org, f.subject, grant2, "req-r2-rev")
	grantDeny, _ := grantRevoked["restriction_id"].(string)
	wantStr(t, consumeCancel(t, worker, f.org, grantDeny, second.runID), "outcome", "cancel_requested")
	// The first Run holds grant1, so the grant2 deny is out of scope for it - and the scope
	// test comes BEFORE the state test, so an already-canceling Run still reads out_of_scope.
	cancelIntent(t, f, grantDeny, first.runID, -1)
	wantStr(t, consumeCancel(t, worker, f.org, grantDeny, first.runID), "outcome", "out_of_scope")
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.outbox WHERE aggregate_id = "+
		quoteLiteral(first.runID)); got != "1" {
		t.Fatalf("first Run outbox rows = %s, want only its own device cancel", got)
	}
}

func TestR0bCancellationConsumeWritesTheCancelPathOnly(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_cancel_writes")
	worker := f.workerConn(t)
	api := f.apiConn(t)
	ref := cancelSeedRuns(t, f, 1, f.subject, 0, "active")[0]
	deny := cancelDeny(t, f, "org", "", 0)
	cancelIntent(t, f, deny, ref.runID, -1)
	// One Operation in each of the three classes §6.1 separates: undispatched (settled here),
	// dispatching (the device's stop fact decides), unknown (reconciliation owns it).
	parked := cancelOp(t, f, ref.runID, "authorized")
	inFlight := cancelOp(t, f, ref.runID, "dispatching")
	unknown := cancelOp(t, f, ref.runID, "unknown")

	out := consumeCancel(t, worker, f.org, deny, ref.runID)
	wantStr(t, out, "outcome", "cancel_requested")
	wantInt(t, out, "canceled_operations", 1)
	wantStr(t, out, "cancel_revision", "1")

	if got := f.scalar(t, "SELECT state || '/' || coalesce(wait_reason, 'null') || '/' || control_revision::text "+
		"FROM work.run WHERE id = "+quoteLiteral(ref.runID)); got != "cancel_requested/null/1" {
		t.Fatalf("Run = %s, want cancel_requested/null/1", got)
	}
	for _, c := range []struct{ op, want string }{
		{parked, "canceled"}, {inFlight, "dispatching"}, {unknown, "unknown"},
	} {
		if got := f.scalar(t, "SELECT state FROM work.operation WHERE id = "+quoteLiteral(c.op)); got != c.want {
			t.Fatalf("operation %s = %s, want %s", c.op, got, c.want)
		}
	}
	// The hand-off request_cancel writes, with the governance actor in the event.
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.outbox WHERE aggregate_id = "+
		quoteLiteral(ref.runID)+" AND payload->>'kind' = 'cancel_signal'"); got != "1" {
		t.Fatalf("cancel_signal outbox rows = %s, want 1", got)
	}
	if got := f.scalar(t, "SELECT payload->>'requested_by' || '/' || (payload->>'restriction_id') "+
		"FROM work.task_event WHERE task_id = "+quoteLiteral(ref.taskID)+" AND type = 'run.cancel_requested'"); got !=
		"governance/"+deny {
		t.Fatalf("cancel event payload = %s, want governance/%s", got, deny)
	}
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.audit_event WHERE action = "+
		"'run.cancel_requested_by_governance' AND target_id = "+quoteLiteral(ref.runID)); got != "1" {
		t.Fatalf("governance cancel audits = %s, want 1", got)
	}
	// Not a terminal writer: the Run stays cancel_requested and no verdict/finish row exists.
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.device_run_finish WHERE run_id = "+
		quoteLiteral(ref.runID)); got != "0" {
		t.Fatalf("device_run_finish rows = %s, want 0 (GW15's ack is not a terminal writer either)", got)
	}

	// Re-consuming a settled intent is a no-op, not a refusal: a consumer that crashed after
	// committing can re-run its round without bumping the revision the device is about to ack.
	again := consumeCancel(t, worker, f.org, deny, ref.runID)
	wantStr(t, again, "outcome", "already_consumed")
	wantInt(t, again, "canceled_operations", 0)
	if again["cancel_revision"] != nil {
		t.Fatalf("replay returned cancel_revision %v, want null", again["cancel_revision"])
	}
	if got := f.scalar(t, "SELECT control_revision::text FROM work.run WHERE id = "+quoteLiteral(ref.runID)); got != "1" {
		t.Fatalf("replay bumped control_revision to %s, want 1", got)
	}
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.outbox WHERE aggregate_id = "+
		quoteLiteral(ref.runID)); got != "1" {
		t.Fatalf("replay wrote a second outbox row (%s total)", got)
	}

	// A Run already inside the cancel path is left alone for the same reason.
	userCancel := cancelSeedRuns(t, f, 1, f.subject, 0, "active")[0]
	cancelIntent(t, f, deny, userCancel.runID, -1)
	mustExec(t, api, "SELECT work.request_cancel("+quoteLiteral(f.org)+", "+
		quoteLiteral(userCancel.runID)+", "+quoteLiteral(f.subject)+", 'user_cancel')")
	wantStr(t, consumeCancel(t, worker, f.org, deny, userCancel.runID), "outcome", "already_canceling")
	if got := f.scalar(t, "SELECT control_revision::text FROM work.run WHERE id = "+quoteLiteral(userCancel.runID)); got != "1" {
		t.Fatalf("already_canceling bumped control_revision to %s, want the user's 1", got)
	}

	// A terminal Run is consumed without a write: the intent is settled, the fact stands.
	done := cancelSeedRuns(t, f, 1, f.subject, 0, "succeeded")[0]
	cancelIntent(t, f, deny, done.runID, -1)
	wantStr(t, consumeCancel(t, worker, f.org, deny, done.runID), "outcome", "already_terminal")
	if got := f.scalar(t, "SELECT state || '/' || control_revision::text FROM work.run WHERE id = "+
		quoteLiteral(done.runID)); got != "succeeded/0" {
		t.Fatalf("terminal Run = %s, want succeeded/0", got)
	}
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.cancellation_intent WHERE state <> 'consumed'"); got != "0" {
		t.Fatalf("intents left unconsumed = %s, want 0", got)
	}
}

func TestR0bCancellationFailLadderDeadLettersAtTen(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_cancel_ladder")
	worker := f.workerConn(t)
	ref := cancelSeedRuns(t, f, 1, f.subject, 0, "active")[0]
	deny := cancelDeny(t, f, "org", "", 0)
	cancelIntent(t, f, deny, ref.runID, -1)

	// §6.1's ladder is 1s..60s, NOT the outbox's 300s ceiling. next_attempt and updated_at
	// are written by the same statement, so their difference is the exact backoff.
	want := []int{1, 2, 4, 8, 16, 32, 60, 60, 60}
	for i, seconds := range want {
		out := failCancel(t, worker, f.org, deny, ref.runID, true)
		wantStr(t, out, "state", "pending")
		wantBool(t, out, "dead_lettered", false)
		wantInt(t, out, "attempts", i+1)
		got := f.scalar(t, "SELECT extract(epoch from (next_attempt - updated_at))::int::text "+
			"FROM work.cancellation_intent WHERE source_event_id = "+quoteLiteral(deny))
		if got != fmt.Sprint(seconds) {
			t.Fatalf("attempt %d backoff = %ss, want %ds", i+1, got, seconds)
		}
		if out["next_attempt"] == nil || !strings.HasSuffix(out["next_attempt"].(string), "Z") {
			t.Fatalf("next_attempt = %v, want an RFC3339 UTC string", out["next_attempt"])
		}
	}
	// The tenth attempt dead-letters, and the alert is an audit row on the outbox precedent.
	out := failCancel(t, worker, f.org, deny, ref.runID, true)
	wantStr(t, out, "state", "dead_letter")
	wantBool(t, out, "dead_lettered", true)
	wantInt(t, out, "attempts", 10)
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.audit_event WHERE action = "+
		"'cancellation_intent.dead_lettered' AND actor_subject_id = 'system:work-cancel' AND target_id = "+
		quoteLiteral(deny)); got != "1" {
		t.Fatalf("dead-letter alert audits = %s, want 1", got)
	}
	// The deny is retained and the Run is untouched: a dead intent is not a cancellation.
	if got := f.scalar(t, "SELECT state FROM work.access_restriction WHERE id = "+quoteLiteral(deny)); got != "active" {
		t.Fatalf("deny = %s, want it retained active", got)
	}
	if got := f.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(ref.runID)); got != "active" {
		t.Fatalf("Run = %s, want active (the consumer never forces a terminal state)", got)
	}
	// A dead intent is ops' to replay, not the worker's to fail or consume again.
	expectCode(t, worker, "cancellation_intent_not_pending", failCancelSQL, f.org, deny, ref.runID, true)
	expectCode(t, worker, "cancellation_intent_not_pending", consumeCancelSQL, f.org, deny, ref.runID)

	// A non-retryable failure dead-letters immediately, on the first attempt.
	fast := cancelSeedRuns(t, f, 1, f.subject, 0, "active")[0]
	fastDeny := cancelDeny(t, f, "org", "", 0)
	cancelIntent(t, f, fastDeny, fast.runID, -1)
	out = failCancel(t, worker, f.org, fastDeny, fast.runID, false)
	wantStr(t, out, "state", "dead_letter")
	wantInt(t, out, "attempts", 1)
	wantBool(t, out, "dead_lettered", true)

	// retryable is a required decision, not a default.
	expectCode(t, worker, "invalid_request", failCancelSQL, f.org, fastDeny, fast.runID, nil)
}

func TestR0bCancellationOpsReplayIsTheOnlyWayBack(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_cancel_replay")
	worker := f.workerConn(t)
	ops := f.opsCancelConn(t)
	ref := cancelSeedRuns(t, f, 1, f.subject, 0, "active")[0]
	deny := cancelDeny(t, f, "org", "", 0)
	cancelIntent(t, f, deny, ref.runID, -1)
	failCancel(t, worker, f.org, deny, ref.runID, false)

	// The replay edge registered by 0057 is what makes this callable at all: 0018 registered
	// only pending→consumed and pending→dead_letter, and no_delete plus the composite PK mean
	// a replay cannot be expressed as a fresh row either.
	mustExec(t, ops, "SELECT work.requeue_cancellation_dead_letter("+quoteLiteral(f.org)+", "+
		quoteLiteral(deny)+", "+quoteLiteral(ref.runID)+", "+quoteLiteral(f.subject)+", 'host cursor recovered')")
	if got := f.scalar(t, "SELECT state || '/' || attempts::text FROM work.cancellation_intent "+
		"WHERE source_event_id = "+quoteLiteral(deny)); got != "pending/0" {
		t.Fatalf("replayed intent = %s, want pending/0", got)
	}
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.cancellation_intent WHERE state = 'pending' AND next_attempt <= now()"); got != "1" {
		t.Fatalf("replayed intent due rows = %s, want 1", got)
	}
	if got := cancelCount(t, f, "SELECT count(*)::text FROM work.audit_event WHERE action = "+
		"'cancellation_intent.requeued' AND actor_subject_id = "+quoteLiteral(f.subject)); got != "1" {
		t.Fatalf("replay audits = %s, want 1", got)
	}
	// The replayed intent goes through the normal round again.
	if n := len(claimCancels(t, worker, f.org, nil, nil)); n != 1 {
		t.Fatalf("claim after replay returned %d, want 1", n)
	}
	wantStr(t, consumeCancel(t, worker, f.org, deny, ref.runID), "outcome", "cancel_requested")

	// consumed stays terminal: no edge back, and the guard refuses consumed→dead_letter too.
	expectCode(t, ops, "cancellation_intent_not_pending", requeueCancelSQL,
		f.org, deny, ref.runID, f.subject, "replay a settled intent")
	if got := f.scalar(t, "SELECT state FROM work.cancellation_intent WHERE source_event_id = "+
		quoteLiteral(deny)); got != "consumed" {
		t.Fatalf("settled intent = %s, want consumed", got)
	}
	// A pending intent is not ops' to reset either.
	live := cancelSeedRuns(t, f, 1, f.subject, 0, "active")[0]
	liveDeny := cancelDeny(t, f, "org", "", 0)
	cancelIntent(t, f, liveDeny, live.runID, -1)
	expectCode(t, ops, "cancellation_intent_not_pending", requeueCancelSQL,
		f.org, liveDeny, live.runID, f.subject, "reset a live intent")
	// A replay is an accountable act: it carries a reason of its own and the session actor.
	expectCode(t, ops, "invalid_request", requeueCancelSQL,
		f.org, liveDeny, live.runID, f.subject, "no")
	expectCode(t, ops, "actor_mismatch", requeueCancelSQL,
		f.org, liveDeny, live.runID, "sub_somebody_else", "a valid reason")
}

func TestR0bCancellationConsumerPrivilegesAndOrgContext(t *testing.T) {
	f := newDeviceFixture(t, "org_r0b_cancel_acl")
	worker := f.workerConn(t)
	api := f.apiConn(t)
	ops := f.opsCancelConn(t)
	ref := cancelSeedRuns(t, f, 1, f.subject, 0, "active")[0]
	deny := cancelDeny(t, f, "org", "", 0)
	cancelIntent(t, f, deny, ref.runID, -1)

	// The three workload commands are work_worker's; the replay is work_ops' alone.
	for _, c := range []struct {
		conn *pgx.Conn
		sql  string
		args []any
	}{
		{api, claimCancelsSQL, []any{f.org, 10, 10}},
		{api, consumeCancelSQL, []any{f.org, deny, ref.runID}},
		{api, failCancelSQL, []any{f.org, deny, ref.runID, true}},
		{ops, consumeCancelSQL, []any{f.org, deny, ref.runID}},
		{worker, requeueCancelSQL, []any{f.org, deny, ref.runID, f.subject, "a valid reason"}},
	} {
		var body []byte
		err := c.conn.QueryRow(testContext(t), c.sql, c.args...).Scan(&body)
		if err == nil || !strings.Contains(err.Error(), "permission denied") {
			t.Fatalf("expected permission denied, got err=%v result=%s", err, string(body))
		}
	}
	// The org argument is bound to the session tenant, so a worker cannot spend its round on
	// another organization's backlog.
	other := "org_r0b_cancel_acl_other"
	mustExec(t, f.admin, "INSERT INTO work.org (id, status, home_region) VALUES ("+
		quoteLiteral(other)+", 'active', 'cn-hangzhou')")
	expectCode(t, worker, "org_context_mismatch", claimCancelsSQL, other, 10, 10)
	expectCode(t, worker, "org_context_mismatch", consumeCancelSQL, other, deny, ref.runID)
	expectCode(t, worker, "org_context_mismatch", failCancelSQL, other, deny, ref.runID, true)
	expectCode(t, ops, "org_context_mismatch", requeueCancelSQL, other, deny, ref.runID, f.subject, "a valid reason")
	// The intent is still pending and the Run untouched after every refusal above.
	if got := f.scalar(t, "SELECT state FROM work.cancellation_intent WHERE source_event_id = "+
		quoteLiteral(deny)); got != "pending" {
		t.Fatalf("intent = %s, want pending", got)
	}
	if got := f.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(ref.runID)); got != "active" {
		t.Fatalf("Run = %s, want active", got)
	}
}