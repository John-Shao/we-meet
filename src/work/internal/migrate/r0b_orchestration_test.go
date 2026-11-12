package migrate

import (
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Tests for increment 0041: the local Run's orchestration spine.
//
// The claims covered are the ones the increment exists for: the seq=0 baseline has
// exactly one writer and is written once; a reconcile_finish lease buys no execution
// capability; an unreconciled unknown blocks a new execute lease but not the
// hand-back path; a same-seq-different-hash checkpoint stops the Run; and the
// restated rebind points the resume offer at the Run's latest recorded baseline.

// orchestrationFixture parks a device, session, grant and binding on the batch-one
// fixture, then leaves the Run active so a lease can be acquired.
type orchestrationFixture struct {
	*deviceFixture
	deviceID  string
	sessionID string
	grantID   string
	revision  int
	op        string
}

func newOrchestrationFixture(t *testing.T, org string) *orchestrationFixture {
	t.Helper()
	f := newDeviceFixture(t, org)
	api := f.apiConn(t)
	worker := f.workerConn(t)
	deviceID, _ := f.pairAndConfirm(t, api, "req-o-pair")
	thumb := f.scalar(t, "SELECT public_key_thumbprint FROM work.device WHERE id = "+quoteLiteral(deviceID))
	minted := callJSON(t, api,
		`SELECT work.mint_device_session_ticket($1,$2,'bearer',7,$3::uuid,$4,$5)`,
		f.org, f.subject, deviceID, "req-o-tick", thumb)
	ticket, _ := minted["ticket"].(string)
	hash := f.scalar(t, "SELECT work.sha256_text("+quoteLiteral(ticket)+")")
	hello := `{"boot_id":"boot-o","agent_instance_id":"` + newUUID(t) + `","journal_epoch":"` + newUUID(t) +
		`","runtime_digest":"` + strings.Repeat("6", 64) + `","protocol_major":2,"protocol_minor":0}`
	session := callJSON(t, worker, `SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`,
		f.org, deviceID, hash, hello)
	sessionID, _ := session["session_id"].(string)
	grant := callJSON(t, api,
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		f.org, f.subject, deviceID, sessionID, "req-o-grant",
		`{"root_identity_hash":"`+strings.Repeat("8", 64)+`","allowed_tools":["workspace.read"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}`)
	grantID, _ := grant["grant_id"].(string)

	o := &orchestrationFixture{deviceFixture: f, deviceID: deviceID, sessionID: sessionID,
		grantID: grantID, revision: 1, op: newUUID(t)}
	o.offer(t, worker, 1, "req-o-offer-1")
	callJSON(t, worker, `SELECT work.acknowledge_run_ready($1,$2::uuid,1,$3,$4::jsonb)`,
		f.org, f.runID, "req-o-ready-1",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"ready","device_signature":"sha256:`+strings.Repeat("b", 64)+`"}`)
	mustExec(t, f.admin, "UPDATE work.run SET state = 'active', wait_reason = NULL WHERE id = "+quoteLiteral(f.runID))
	// The operation admission trigger also requires task.active_run_id to point here.
	mustExec(t, f.admin, "UPDATE work.task SET active_run_id = "+quoteLiteral(f.runID)+
		", latest_run_id = "+quoteLiteral(f.runID)+" WHERE id = "+quoteLiteral(f.taskID))
	// The operation admission trigger requires an active Run, so it is seeded last.
	mustExec(t, f.admin, "INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state) VALUES ("+
		quoteLiteral(o.op)+", "+quoteLiteral(f.org)+", "+quoteLiteral(f.runID)+", 'tool:1:0', 'tool', '"+
		strings.Repeat("9", 64)+"', 'dispatching')")
	return o
}

func (o *orchestrationFixture) offer(t *testing.T, worker *pgx.Conn, revision int, requestID string) {
	t.Helper()
	body := `{"input_ref":"ref","input_hash":"` + strings.Repeat("7", 64) +
		`","snapshot_hash":"` + strings.Repeat("3", 64) + `","profile_id":"p1","profile_revision":1,` +
		`"runtime_digest":"` + strings.Repeat("4", 64) + `","tool_manifest_hash":"` + strings.Repeat("5", 64) +
		`","model_version":"m1","grant_set":[{"grant_id":"` + o.grantID + `","grant_revision":1}],"offer_ttl_seconds":120}`
	callJSON(t, worker,
		`SELECT work.create_device_run_binding($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb)`,
		o.org, o.runID, o.deviceID, o.sessionID, revision, requestID, body)
}

func TestR0bBaselineHasOneWriterAndIsWrittenOnce(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_orch_baseline")
	worker := o.workerConn(t)

	// create_device_run_binding must NOT write a checkpoint: §4.2 gives seq=0 exactly
	// one writer so two sources cannot disagree about the baseline hash.
	if got := o.scalar(t, "SELECT count(*)::text FROM work.device_checkpoint WHERE org_id = "+quoteLiteral(o.org)); got != "0" {
		t.Fatalf("checkpoints after the offer = %s, want 0", got)
	}
	nonce := newUUID(t)
	first := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, nonce)
	if first["run_start"] == nil {
		t.Fatalf("execute lease signed no run_start: %v", first)
	}
	if first["checkpoint_seq"] != float64(0) {
		t.Fatalf("execute lease checkpoint_seq = %v, want 0", first["checkpoint_seq"])
	}
	if got := o.scalar(t, "SELECT count(*)::text FROM work.device_checkpoint WHERE org_id = "+quoteLiteral(o.org)+" AND checkpoint_seq = 0"); got != "1" {
		t.Fatalf("seq=0 rows = %s, want 1", got)
	}
	if got := o.scalar(t, "SELECT (signed_payload_hash IS NULL)::text FROM work.device_checkpoint WHERE org_id = "+quoteLiteral(o.org)+" AND checkpoint_seq = 0"); got != "true" {
		t.Fatal("the server-written baseline carries a device signature")
	}
	// The same nonce replays the lease and does not write a second baseline.
	again := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, nonce)
	if again["replayed"] != true || again["lease_id"] != first["lease_id"] {
		t.Fatalf("nonce replay = %v, want the original lease", again)
	}
	if got := o.scalar(t, "SELECT count(*)::text FROM work.device_checkpoint WHERE org_id = "+quoteLiteral(o.org)); got != "1" {
		t.Fatalf("checkpoints after replay = %s, want 1", got)
	}
}

func TestR0bReconcileFinishLeaseBuysNoExecutionCapability(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_orch_j12")
	worker := o.workerConn(t)

	// An unreconciled unknown blocks a new execute lease (invariant 3).
	mustExec(t, o.admin, "UPDATE work.operation SET state = 'unknown' WHERE id = "+quoteLiteral(o.op))
	expectCode(t, worker, "run_has_unreconciled_operation",
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, newUUID(t))

	// J12: the hand-back lease is still minted, and it signs no run_start.
	handback := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'reconcile_finish',NULL,30)`,
		o.org, o.runID, o.deviceID, o.sessionID)
	if handback["run_start"] != nil {
		t.Fatalf("reconcile_finish lease signed a run_start: %v", handback)
	}
	if handback["purpose"] != "reconcile_finish" {
		t.Fatalf("purpose = %v", handback["purpose"])
	}
	if got := o.scalar(t, "SELECT count(*)::text FROM work.device_checkpoint WHERE org_id = "+quoteLiteral(o.org)); got != "0" {
		t.Fatalf("reconcile_finish wrote a baseline: %s rows", got)
	}
	// A second reconcile_finish request reuses the active row rather than minting another.
	second := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'reconcile_finish',NULL,30)`,
		o.org, o.runID, o.deviceID, o.sessionID)
	if second["lease_id"] != handback["lease_id"] {
		t.Fatalf("second hand-back lease = %v, want the same row", second["lease_id"])
	}
	if got := o.scalar(t, "SELECT count(*)::text FROM work.execution_lease WHERE org_id = "+quoteLiteral(o.org)); got != "1" {
		t.Fatalf("lease rows = %s, want 1", got)
	}
}

func TestR0bCheckpointConflictStopsTheRun(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_orch_conflict")
	worker := o.workerConn(t)
	callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, newUUID(t))

	cp := func(seq int, hash, requestID string) map[string]any {
		return callJSON(t, worker,
			`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb)`,
			o.org, o.runID, requestID,
			`{"checkpoint_seq":`+strconv.Itoa(seq)+`,"checkpoint_hash":"`+hash+`","local_checkpoint_ref":"local/cp","receipt_through_seq":0,"pending_operation_set_hash":"`+strings.Repeat("c", 64)+`","device_signature":"sha256:`+strings.Repeat("d", 64)+`"}`)
	}
	first := cp(1, strings.Repeat("1", 64), "req-cp-1")
	if first["state"] != "recorded" {
		t.Fatalf("first checkpoint = %v", first)
	}
	// Same seq, same hash is an idempotent replay.
	if again := cp(1, strings.Repeat("1", 64), "req-cp-1"); again["replayed"] != true {
		t.Fatalf("same-hash replay = %v", again)
	}
	// Same seq, different hash stops the Run and marks the row conflicted.
	conflict := cp(1, strings.Repeat("2", 64), "req-cp-2")
	if conflict["state"] != "conflict" {
		t.Fatalf("conflicting checkpoint = %v", conflict)
	}
	if got := o.scalar(t, "SELECT state || '/' || coalesce(wait_reason,'-') FROM work.run WHERE id = "+quoteLiteral(o.runID)); got != "waiting/reconcile" {
		t.Fatalf("run after conflict = %s, want waiting/reconcile", got)
	}
	if got := o.scalar(t, "SELECT state FROM work.device_checkpoint WHERE org_id = "+quoteLiteral(o.org)+" AND checkpoint_seq = 1"); got != "conflict" {
		t.Fatalf("checkpoint state = %s, want conflict", got)
	}
	// seq=0 is not the device's to write.
	expectCode(t, worker, "invalid_request",
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb)`,
		o.org, o.runID, "req-cp-zero",
		`{"checkpoint_seq":0,"checkpoint_hash":"`+strings.Repeat("3", 64)+`","local_checkpoint_ref":"local/cp","receipt_through_seq":0,"pending_operation_set_hash":"`+strings.Repeat("c", 64)+`","device_signature":"sha256:`+strings.Repeat("d", 64)+`"}`)
}

func TestR0bRebindPointsAtTheLatestRecordedBaseline(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_orch_rebind")
	api := o.apiConn(t)
	worker := o.workerConn(t)
	callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, newUUID(t))
	callJSON(t, worker,
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb)`,
		o.org, o.runID, "req-rb-cp",
		`{"checkpoint_seq":1,"checkpoint_hash":"`+strings.Repeat("4", 64)+`","local_checkpoint_ref":"local/cp1","receipt_through_seq":0,"pending_operation_set_hash":"`+strings.Repeat("c", 64)+`","device_signature":"sha256:`+strings.Repeat("d", 64)+`"}`)

	// A second grant on the same root, then park the Run for reauthorization.
	second := callJSON(t, api,
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		o.org, o.subject, o.deviceID, o.sessionID, "req-rb-grant2",
		`{"root_identity_hash":"`+strings.Repeat("8", 64)+`","allowed_tools":["workspace.read"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}`)
	newGrant, _ := second["grant_id"].(string)
	mustExec(t, o.admin, "UPDATE work.run SET state = 'waiting', wait_reason = 'input' WHERE id = "+quoteLiteral(o.runID))

	rebound := callJSON(t, api,
		`SELECT work.rebind_run_workspace($1,$2,'bearer',7,$3::uuid,$4,$5::uuid,$6::uuid,$7::jsonb)`,
		o.org, o.subject, o.runID, "req-rb-1", o.grantID, newGrant,
		`{"old_grant_id":"`+o.grantID+`","new_grant_id":"`+newGrant+`","run_id":"`+o.runID+`","root_identity_hash":"`+strings.Repeat("8", 64)+`","session_id":"`+o.sessionID+`","auth_plane":"bearer","auth_epoch":7,"nonce":"`+newUUID(t)+`","signature":"sha256:`+strings.Repeat("e", 64)+`"}`)
	// The 0040 obligation discharged: the resume offer names the recorded baseline.
	if rebound["expected_checkpoint_seq"] != float64(1) {
		t.Fatalf("rebind expected_checkpoint_seq = %v, want 1", rebound["expected_checkpoint_seq"])
	}
	if rebound["expected_checkpoint_hash"] != strings.Repeat("4", 64) {
		t.Fatalf("rebind expected_checkpoint_hash = %v", rebound["expected_checkpoint_hash"])
	}
	if rebound["binding_revision"] != float64(2) {
		t.Fatalf("binding_revision = %v, want 2", rebound["binding_revision"])
	}
}

func TestR0bAcquireRefusesResumeOfferWithoutItsBaseline(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_orch_failclosed")
	worker := o.workerConn(t)
	callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, newUUID(t))
	callJSON(t, worker,
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb)`,
		o.org, o.runID, "req-fc-cp",
		`{"checkpoint_seq":1,"checkpoint_hash":"`+strings.Repeat("5", 64)+`","local_checkpoint_ref":"local/cp1","receipt_through_seq":0,"pending_operation_set_hash":"`+strings.Repeat("c", 64)+`","device_signature":"sha256:`+strings.Repeat("d", 64)+`"}`)

	// A second binding that does not reference the available baseline must not start:
	// device §3.2 forbids rerunning from the initial input when a checkpoint exists.
	mustExec(t, o.admin, "UPDATE work.run SET state = 'waiting', wait_reason = 'input' WHERE id = "+quoteLiteral(o.runID))
	offer2 := `{"input_ref":"ref","input_hash":"` + strings.Repeat("7", 64) + `","snapshot_hash":"` + strings.Repeat("3", 64) +
		`","profile_id":"p1","profile_revision":1,"runtime_digest":"` + strings.Repeat("4", 64) +
		`","tool_manifest_hash":"` + strings.Repeat("5", 64) + `","model_version":"m1","grant_set":[{"grant_id":"` + o.grantID + `","grant_revision":1}],"offer_ttl_seconds":120}`
	callJSON(t, worker, `SELECT work.create_device_run_binding($1,$2::uuid,$3::uuid,$4::uuid,2,$5,$6::jsonb)`,
		o.org, o.runID, o.deviceID, o.sessionID, "req-fc-offer2", offer2)
	callJSON(t, worker, `SELECT work.acknowledge_run_ready($1,$2::uuid,2,$3,$4::jsonb)`,
		o.org, o.runID, "req-fc-ready2",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"ready","device_signature":"sha256:`+strings.Repeat("b", 64)+`"}`)
	mustExec(t, o.admin, "UPDATE work.run SET state = 'active', wait_reason = NULL WHERE id = "+quoteLiteral(o.runID))
	expectCode(t, worker, "resync_required",
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,2,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, newUUID(t))
}
