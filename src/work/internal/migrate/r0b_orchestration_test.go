package migrate

import (
	"encoding/json"
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
	nonce     string
	leaseID   string
}

func newOrchestrationFixtureAtOffer(t *testing.T, org string) *orchestrationFixture {
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
	// Atomic activation requires the submitted Run to be the Task's current Run.
	mustExec(t, f.admin, "UPDATE work.task SET active_run_id = "+quoteLiteral(f.runID)+
		", latest_run_id = "+quoteLiteral(f.runID)+" WHERE id = "+quoteLiteral(f.taskID))
	o.offer(t, worker, 1, "req-o-offer-1")
	// The operation admission trigger requires an active Run, so it is seeded last.
	mustExec(t, f.admin, "INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state) VALUES ("+
		quoteLiteral(o.op)+", "+quoteLiteral(f.org)+", "+quoteLiteral(f.runID)+", 'tool:1:0', 'tool', '"+
		strings.Repeat("9", 64)+"', 'dispatching')")
	return o
}

func newOrchestrationFixture(t *testing.T, org string) *orchestrationFixture {
	t.Helper()
	o := newOrchestrationFixtureAtOffer(t, org)
	callJSON(t, o.workerConn(t), `SELECT work.acknowledge_run_ready($1,$2::uuid,1,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-o-ready-1",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"ready","device_signature":"`+strings.Repeat("d", 86)+`"}`,
		o.deviceID, o.sessionID)
	return o
}

func (o *orchestrationFixture) offer(t *testing.T, worker *pgx.Conn, revision int, requestID string) {
	t.Helper()
	expected := ""
	if revision > 1 {
		seq := o.scalar(t, "SELECT COALESCE(MAX(checkpoint_seq),0)::text FROM work.device_checkpoint WHERE org_id = "+
			quoteLiteral(o.org)+" AND run_id = "+quoteLiteral(o.runID)+" AND state = 'recorded'")
		hash := o.scalar(t, "SELECT checkpoint_hash FROM work.device_checkpoint WHERE org_id = "+
			quoteLiteral(o.org)+" AND run_id = "+quoteLiteral(o.runID)+" AND checkpoint_seq = "+seq+" AND state = 'recorded'")
		expected = `,"expected_checkpoint_seq":` + seq + `,"expected_checkpoint_hash":"` + hash + `"`
	}
	body := `{"input_ref":"ref","input_hash":"` + strings.Repeat("7", 64) +
		`","snapshot_hash":"` + strings.Repeat("3", 64) + `","profile_id":"p1","profile_revision":1,` +
		`"runtime_digest":"` + strings.Repeat("4", 64) + `","tool_manifest_hash":"` + strings.Repeat("5", 64) +
		`","model_version":"m1","grant_set":[{"grant_id":"` + o.grantID + `","grant_revision":1}]` +
		expected + `,"offer_ttl_seconds":120}`
	out := callJSON(t, worker,
		`SELECT work.create_device_run_binding($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb)`,
		o.org, o.runID, o.deviceID, o.sessionID, revision, requestID, body)
	o.nonce, _ = out["start_nonce"].(string)
	o.leaseID, _ = out["lease_id"].(string)
}

func TestR0bRunStartRequiresCommittedReady(t *testing.T) {
	o := newOrchestrationFixtureAtOffer(t, "org_r0b_orch_ready_gate")
	worker := o.workerConn(t)
	expectCode(t, worker, "run_not_active",
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, o.nonce)
	if got := o.scalar(t, "SELECT count(*)::text FROM work.audit_event WHERE org_id = "+quoteLiteral(o.org)+" AND action = 'device_lease.acquired'"); got != "0" {
		t.Fatalf("run_start signed before ready: %s audit rows", got)
	}
	callJSON(t, worker, `SELECT work.acknowledge_run_ready($1,$2::uuid,1,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-o-ready-gate",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"ready","device_signature":"`+strings.Repeat("d", 86)+`"}`,
		o.deviceID, o.sessionID)
	first := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, o.nonce)
	if first["run_start"] == nil || first["replayed"] != false || first["lease_id"] != o.leaseID {
		t.Fatalf("first start after ready = %#v", first)
	}
}

func TestR0bConcurrentFirstStartSerializes(t *testing.T) {
	o := newOrchestrationFixtureAtOffer(t, "org_r0b_orch_start_race")
	worker := o.workerConn(t)
	callJSON(t, worker, `SELECT work.acknowledge_run_ready($1,$2::uuid,1,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-start-race-ready",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"ready","device_signature":"`+strings.Repeat("d", 86)+`"}`,
		o.deviceID, o.sessionID)
	type result struct {
		raw []byte
		err error
	}
	results := make(chan result, 2)
	for range 2 {
		conn := o.workerConn(t)
		go func() {
			var raw []byte
			err := conn.QueryRow(testContext(t), `SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
				o.org, o.runID, o.deviceID, o.sessionID, o.nonce).Scan(&raw)
			results <- result{raw: raw, err: err}
		}()
	}
	firstStart := false
	leaseIDs := map[string]bool{}
	for range 2 {
		got := <-results
		if got.err != nil {
			t.Fatalf("concurrent first start: %v", got.err)
		}
		var body map[string]any
		if err := json.Unmarshal(got.raw, &body); err != nil {
			t.Fatal(err)
		}
		leaseID, _ := body["lease_id"].(string)
		leaseIDs[leaseID] = true
		if body["replayed"] == false {
			if firstStart {
				t.Fatalf("two first-start responses: %#v", body)
			}
			firstStart = true
		}
	}
	if !firstStart || len(leaseIDs) != 1 {
		t.Fatalf("concurrent starts = first:%v leases:%#v", firstStart, leaseIDs)
	}
	if got := o.scalar(t, "SELECT count(*)::text FROM work.audit_event WHERE org_id = "+quoteLiteral(o.org)+" AND action = 'device_lease.acquired'"); got != "1" {
		t.Fatalf("first-start audit rows = %s, want 1", got)
	}
}

func TestR0bQueuedBindingActivationAdvancesFenceOnce(t *testing.T) {
	o := newOrchestrationFixtureAtOffer(t, "org_r0b_orch_queued")
	worker := o.workerConn(t)
	newTask := newUUID(t)
	newRun := newUUID(t)
	newSnapshot := newUUID(t)
	var snapshotID, inputID string
	if err := o.admin.QueryRow(testContext(t), "SELECT snapshot_id::text, input_id::text FROM work.task WHERE id = "+quoteLiteral(o.taskID)).Scan(&snapshotID, &inputID); err != nil {
		t.Fatal(err)
	}
	mustExec(t, o.admin, "INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, input_id, title) VALUES ("+
		quoteLiteral(newTask)+", "+quoteLiteral(o.org)+", "+quoteLiteral(o.subject)+", 'open', "+
		quoteLiteral(snapshotID)+", "+quoteLiteral(inputID)+", 'queued activation')")
	mustExec(t, o.admin, "INSERT INTO work.capability_snapshot (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest) VALUES ("+
		quoteLiteral(newSnapshot)+", "+quoteLiteral(o.org)+", "+quoteLiteral(newTask)+", 'v1', '"+
		strings.Repeat("c", 64)+"', ARRAY['workspace.read'], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)")
	mustExec(t, o.admin, "UPDATE work.task SET snapshot_id = "+quoteLiteral(newSnapshot)+" WHERE id = "+quoteLiteral(newTask))
	mustExec(t, o.admin, "INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version) VALUES ("+
		quoteLiteral(newRun)+", "+quoteLiteral(o.org)+", "+quoteLiteral(newTask)+", 1, 'queued', "+
		quoteLiteral(newSnapshot)+", "+quoteLiteral("wf-queued-"+newRun)+", 'v1')")
	mustExec(t, o.admin, "UPDATE work.task SET active_run_id = "+quoteLiteral(newRun)+", latest_run_id = "+quoteLiteral(newRun)+" WHERE id = "+quoteLiteral(newTask))
	body := `{"input_ref":"ref","input_hash":"` + strings.Repeat("7", 64) +
		`","snapshot_hash":"` + strings.Repeat("3", 64) + `","profile_id":"p1","profile_revision":1,` +
		`"runtime_digest":"` + strings.Repeat("4", 64) + `","tool_manifest_hash":"` + strings.Repeat("5", 64) +
		`","model_version":"m1","grant_set":[{"grant_id":"` + o.grantID + `","grant_revision":1}],"offer_ttl_seconds":120}`
	callJSON(t, worker, `SELECT work.acknowledge_run_ready($1,$2::uuid,1,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-other-run-ready",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"ready","device_signature":"`+strings.Repeat("d", 86)+`"}`,
		o.deviceID, o.sessionID)
	badBody := strings.Replace(body, `"offer_ttl_seconds"`, `"expected_checkpoint_seq":1,"expected_checkpoint_hash":"`+strings.Repeat("9", 64)+`","offer_ttl_seconds"`, 1)
	expectCode(t, worker, "resync_required", `SELECT work.create_device_run_binding($1,$2::uuid,$3::uuid,$4::uuid,1,$5,$6::jsonb)`,
		o.org, newRun, o.deviceID, o.sessionID, "req-queued-bad-checkpoint", badBody)
	if got := o.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(newRun)); got != "queued" {
		t.Fatalf("bad checkpoint moved Run to %s, want queued", got)
	}
	out := callJSON(t, worker, `SELECT work.create_device_run_binding($1,$2::uuid,$3::uuid,$4::uuid,1,$5,$6::jsonb)`,
		o.org, newRun, o.deviceID, o.sessionID, "req-queued-offer", body)
	if out["state"] != "active" || out["lease_id"] == nil {
		t.Fatalf("queued binding activation = %#v", out)
	}
	again := callJSON(t, worker, `SELECT work.create_device_run_binding($1,$2::uuid,$3::uuid,$4::uuid,1,$5,$6::jsonb)`,
		o.org, newRun, o.deviceID, o.sessionID, "req-queued-offer", body)
	if again["replayed"] != true || again["lease_id"] != out["lease_id"] {
		t.Fatalf("queued binding replay = %#v, want original lease", again)
	}
	nonce, _ := out["start_nonce"].(string)
	expectCode(t, worker, "run_not_active",
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, newRun, o.deviceID, o.sessionID, nonce)
	callJSON(t, worker, `SELECT work.acknowledge_run_ready($1,$2::uuid,1,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, newRun, "req-queued-ready",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"ready","device_signature":"`+strings.Repeat("d", 86)+`"}`,
		o.deviceID, o.sessionID)
	started := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, newRun, o.deviceID, o.sessionID, nonce)
	if started["run_start"] == nil {
		t.Fatalf("queued Run did not start after its own ready: %#v", started)
	}
	if got := o.scalar(t, "SELECT state || '/' || fence::text FROM work.run WHERE id = "+quoteLiteral(newRun)); got != "active/2" {
		t.Fatalf("queued activation run = %s, want active/2", got)
	}
}

func TestR0bPreReadyLeaseCannotPrepareOrConsume(t *testing.T) {
	a := newActionFixtureAtOffer(t, "org_r0b_orch_pre_ready_gate")
	worker := a.workerConn(t)
	expectCode(t, worker, "run_not_active",
		`SELECT work.prepare_local_operation($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb)`,
		a.org, a.runID, a.deviceID, a.sessionID, a.leaseID, a.fence, a.checkpointSeq,
		a.actionBody(t, "pre-ready", a.grantClass))
	if got := a.scalarInt(t, "SELECT count(*) FROM work.operation WHERE org_id = "+quoteLiteral(a.org)+" AND logical_key = 'pre-ready#0'"); got != 0 {
		t.Fatalf("pre-ready prepare created %d Operations", got)
	}
	callJSON(t, worker, `SELECT work.acknowledge_run_ready($1,$2::uuid,1,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		a.org, a.runID, "req-pre-ready",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"ready","device_signature":"`+strings.Repeat("d", 86)+`"}`,
		a.deviceID, a.sessionID)
	callJSON(t, worker, `SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		a.org, a.runID, a.deviceID, a.sessionID, a.nonce)
	prepared := a.prepare(t, worker, "pre-ready", a.grantClass)
	if idOf(t, prepared, "operation_id") == "" {
		t.Fatalf("prepare after committed ready = %#v", prepared)
	}
}

func TestR0bExpiredPreReadyLeaseCanBeReplacedAtomically(t *testing.T) {
	o := newOrchestrationFixtureAtOffer(t, "org_r0b_orch_pre_ready_expiry")
	mustExec(t, o.admin, "UPDATE work.execution_lease SET state = 'expired', revision = revision + 1 WHERE id = "+quoteLiteral(o.leaseID))
	o.offer(t, o.workerConn(t), 2, "req-pre-ready-expiry-2")
	if o.leaseID == "" || o.nonce == "" {
		t.Fatalf("replacement binding returned no lease/nonce")
	}
	if got := o.scalar(t, "SELECT state FROM work.device_run_binding WHERE run_id = "+quoteLiteral(o.runID)+" AND binding_revision = 1"); got != "canceled" {
		t.Fatalf("expired pre-ready binding = %s, want canceled", got)
	}
	if got := o.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(o.runID)); got != "active" {
		t.Fatalf("replacement run = %s, want active", got)
	}
	if got := o.scalar(t, "SELECT count(*)::text FROM work.execution_lease WHERE org_id = "+quoteLiteral(o.org)+" AND run_id = "+quoteLiteral(o.runID)+" AND state = 'active'"); got != "1" {
		t.Fatalf("active leases after replacement = %s, want 1", got)
	}
}

func TestR0bBaselineHasOneWriterAndIsWrittenOnce(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_orch_baseline")
	worker := o.workerConn(t)

	if got := o.scalar(t, "SELECT count(*)::text FROM work.device_checkpoint WHERE org_id = "+quoteLiteral(o.org)); got != "1" {
		t.Fatalf("checkpoints after atomic activation = %s, want 1", got)
	}
	if got := o.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(o.runID)); got != "active" {
		t.Fatalf("run after binding creation = %s, want active", got)
	}
	if got := o.scalar(t, "SELECT fence::text FROM work.run WHERE id = "+quoteLiteral(o.runID)); got != "1" {
		t.Fatalf("resume activation fence = %s, want unchanged 1", got)
	}
	first := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, o.nonce)
	if first["run_start"] == nil {
		t.Fatalf("execute lease signed no run_start: %v", first)
	}
	expectCode(t, worker, "run_not_active",
		`SELECT work.acknowledge_run_ready($1,$2::uuid,1,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-o-late-non-ready",
		`{"binding_hash":"`+strings.Repeat("a", 64)+`","ready_or_reason":"missing_input","device_signature":"`+strings.Repeat("d", 86)+`"}`,
		o.deviceID, o.sessionID)
	if got := o.scalar(t, "SELECT state FROM work.execution_lease WHERE id = "+quoteLiteral(o.leaseID)); got != "active" {
		t.Fatalf("late non-ready revoked issued lease: %s", got)
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
		o.org, o.runID, o.deviceID, o.sessionID, o.nonce)
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

	// An unreconciled unknown blocks first run_start signing (invariant 3).
	mustExec(t, o.admin, "UPDATE work.operation SET state = 'unknown' WHERE id = "+quoteLiteral(o.op))
	expectCode(t, worker, "run_has_unreconciled_operation",
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, o.nonce)
	mustExec(t, o.admin, "UPDATE work.execution_lease SET state = 'expired' WHERE id = "+quoteLiteral(o.leaseID))

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
	if got := o.scalar(t, "SELECT count(*)::text FROM work.device_checkpoint WHERE org_id = "+quoteLiteral(o.org)); got != "1" {
		t.Fatalf("reconcile_finish changed the atomic baseline: %s rows", got)
	}
	// A second reconcile_finish request reuses the active row rather than minting another.
	second := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'reconcile_finish',NULL,30)`,
		o.org, o.runID, o.deviceID, o.sessionID)
	if second["lease_id"] != handback["lease_id"] {
		t.Fatalf("second hand-back lease = %v, want the same row", second["lease_id"])
	}
	if got := o.scalar(t, "SELECT count(*)::text FROM work.execution_lease WHERE org_id = "+quoteLiteral(o.org)); got != "2" {
		t.Fatalf("lease rows = %s, want expired execute plus active reconcile", got)
	}
	if got := o.scalar(t, "SELECT purpose FROM work.execution_lease WHERE id = "+quoteLiteral(handback["lease_id"].(string))); got != "reconcile_finish" {
		t.Fatalf("hand-back lease purpose = %q", got)
	}
	if got := o.scalar(t, "SELECT count(*)::text FROM work.operation WHERE org_id = "+quoteLiteral(o.org)); got != "1" {
		t.Fatalf("hand-back lease created Operations: %s rows", got)
	}
	if got := o.scalar(t, "SELECT count(*)::text FROM work.local_action WHERE org_id = "+quoteLiteral(o.org)); got != "0" {
		t.Fatalf("hand-back lease created local actions: %s rows", got)
	}
	if got := o.scalar(t, "SELECT count(*)::text FROM work.device_dispatch WHERE org_id = "+quoteLiteral(o.org)); got != "0" {
		t.Fatalf("hand-back lease minted permits: %s dispatch rows", got)
	}
}

func TestR0bUnknownAllowsAccountingAndRecoversAfterLateReceipt(t *testing.T) {
	a, unknownOp, unknownAttempt := reviewDispatchedAction(t)
	worker := a.workerConn(t)
	blocked := a.prepare(t, worker, "blocked:1", a.grantClass)
	blockedOp := idOf(t, blocked, "operation_id")
	blockedAttempt := idOf(t, blocked, "attempt_id")
	a.authorizeAction(t, blockedOp)

	operationsBefore := a.scalarInt(t, "SELECT count(*) FROM work.operation WHERE org_id = "+quoteLiteral(a.org))
	actionsBefore := a.scalarInt(t, "SELECT count(*) FROM work.local_action WHERE org_id = "+quoteLiteral(a.org))
	quotaBefore := a.scalarInt(t, "SELECT count(*) FROM work.quota_reservation WHERE org_id = "+quoteLiteral(a.org))
	dispatchesBefore := a.scalarInt(t, "SELECT count(*) FROM work.device_dispatch WHERE org_id = "+quoteLiteral(a.org))
	mustExec(t, a.admin, "UPDATE work.operation SET state = 'unknown' WHERE id = "+quoteLiteral(unknownOp))

	replayed := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		a.org, a.runID, a.deviceID, a.sessionID, a.nonce)
	if replayed["replayed"] != true || replayed["lease_id"] != a.leaseID {
		t.Fatalf("unknown changed the already-issued start: %#v", replayed)
	}
	expectCode(t, worker, "run_has_unreconciled_operation",
		`SELECT work.prepare_local_operation($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb)`,
		a.org, a.runID, a.deviceID, a.sessionID, a.leaseID, a.fence, a.checkpointSeq,
		a.actionBody(t, "never:1", a.grantClass))
	a.refuseConsume(t, worker, blockedOp, blockedAttempt, "run_has_unreconciled_operation")
	if got := a.scalarInt(t, "SELECT count(*) FROM work.operation WHERE org_id = "+quoteLiteral(a.org)); got != operationsBefore {
		t.Fatalf("refused prepare created Operations: %d -> %d", operationsBefore, got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.local_action WHERE org_id = "+quoteLiteral(a.org)); got != actionsBefore {
		t.Fatalf("refused prepare created local actions: %d -> %d", actionsBefore, got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.quota_reservation WHERE org_id = "+quoteLiteral(a.org)); got != quotaBefore {
		t.Fatalf("refused commands changed quota reservations: %d -> %d", quotaBefore, got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_dispatch WHERE org_id = "+quoteLiteral(a.org)); got != dispatchesBefore {
		t.Fatalf("refused consume minted permits: %d -> %d", dispatchesBefore, got)
	}

	mustExec(t, a.admin, "UPDATE work.run SET state = 'waiting', wait_reason = 'reconcile' WHERE id = "+quoteLiteral(a.runID))
	oldExpiry := a.scalar(t, "SELECT expires_at::text FROM work.execution_lease WHERE id = "+quoteLiteral(a.leaseID))
	renewed := callJSON(t, worker,
		`SELECT work.renew_device_lease($1,$2::uuid,30,0,$3::uuid,$4::uuid)`, a.org, a.leaseID, a.deviceID, a.sessionID)
	if renewed["purpose"] != "execute" || renewed["run_id"] != a.runID {
		t.Fatalf("renewal under unknown = %#v", renewed)
	}
	if got := a.scalar(t, "SELECT (expires_at > "+quoteLiteral(oldExpiry)+"::timestamptz)::text FROM work.execution_lease WHERE id = "+quoteLiteral(a.leaseID)); got != "true" {
		t.Fatal("renewal under unknown did not extend the lease")
	}

	checkpoint := callJSON(t, worker,
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,$3,$4,$5::jsonb,$6::uuid,$7::uuid)`,
		a.org, a.runID, a.fence, "req-unknown-checkpoint",
		`{"checkpoint_seq":`+strconv.FormatInt(a.checkpointSeq+1, 10)+`,"checkpoint_hash":"`+strings.Repeat("9", 64)+
			`","local_checkpoint_ref":"local/unknown-cp","receipt_through_seq":0,"pending_operation_set_hash":"`+strings.Repeat("c", 64)+
			`","device_signature":"`+strings.Repeat("d", 86)+`"}`, a.deviceID, a.sessionID)
	if checkpoint["state"] != "recorded" {
		t.Fatalf("checkpoint under unknown = %#v", checkpoint)
	}
	a.checkpointSeq++
	a.checkpointHash = strings.Repeat("9", 64)

	receipt, journal := reviewReceipt(t, a, unknownOp, unknownAttempt, a.sessionID)
	recorded := reviewRecord(t, a, a.deviceID, journal, receipt)
	if len(recorded["recorded"].([]any)) != 1 || len(recorded["conflicts"].([]any)) != 0 {
		t.Fatalf("late receipt under unknown = %#v", recorded)
	}
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE id = "+quoteLiteral(unknownOp)); got != "reconciled" {
		t.Fatalf("late receipt Operation state = %q, want reconciled", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.operation WHERE org_id = "+quoteLiteral(a.org)+
		" AND state IN ('unknown','unresolved')"); got != 0 {
		t.Fatalf("unknown Operations after late receipt = %d, want 0", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_receipt WHERE org_id = "+quoteLiteral(a.org)); got != 1 {
		t.Fatalf("device receipts after late evidence = %d, want 1", got)
	}

	if _, err := worker.Exec(testContext(t), `SELECT work.resume_run($1,$2::uuid)`, a.org, a.runID); err != nil {
		t.Fatalf("resume after late receipt: %v", err)
	}
	a.consumePermit(t, worker, blockedOp, blockedAttempt)
	recovered := a.prepare(t, worker, "recovered:1", a.grantClass)
	if idOf(t, recovered, "operation_id") == "" {
		t.Fatalf("prepare after late receipt returned no Operation: %#v", recovered)
	}
}

func TestR0bAcquireRecoversAfterUnknownIsReconciled(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_orch_unknown_recovered")
	worker := o.workerConn(t)
	r0bAdmin(t, o.admin, o.org)
	mustExec(t, o.admin, "UPDATE work.operation SET step_key = 'tool:1', supersede_no = 0, logical_key = 'tool:1#0', state = 'unknown' WHERE id = "+quoteLiteral(o.op))
	expectCode(t, worker, "run_has_unreconciled_operation",
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, o.nonce)

	issueResolution(t, o.admin, o.org, o.op, "succeeded", nil, nil, nil)
	if got := o.scalar(t, "SELECT state FROM work.operation WHERE id = "+quoteLiteral(o.op)); got != "reconciled" {
		t.Fatalf("settled unknown Operation state = %q, want reconciled", got)
	}
	acquired := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, o.nonce)
	if acquired["run_start"] == nil || acquired["purpose"] != "execute" {
		t.Fatalf("execute lease after reconciliation = %#v", acquired)
	}
}

func TestR0bReconcileFinishLeaseCannotMintPermitForAuthorizedOperation(t *testing.T) {
	a := newActionFixture(t, "org_r0b_orch_j12_no_permit")
	worker := a.workerConn(t)
	out := a.prepare(t, worker, "tool:1", a.grantClass)
	opID := idOf(t, out, "operation_id")
	attemptID := idOf(t, out, "attempt_id")
	a.authorizeAction(t, opID)
	mustExec(t, a.admin, "UPDATE work.execution_lease SET state = 'expired' WHERE id = "+quoteLiteral(a.leaseID))
	handback := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'reconcile_finish',NULL,30)`,
		a.org, a.runID, a.deviceID, a.sessionID)
	a.leaseID = idOf(t, handback, "lease_id")

	a.refuseConsume(t, worker, opID, attemptID, "unauthorized")
	expectCode(t, worker, "unauthorized",
		`SELECT work.prepare_local_operation($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb)`,
		a.org, a.runID, a.deviceID, a.sessionID, a.leaseID, a.fence, a.checkpointSeq,
		a.actionBody(t, "tool:2", a.grantClass))
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE id = "+quoteLiteral(opID)); got != "authorized" {
		t.Fatalf("reconcile lease changed authorized Operation = %q", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_dispatch WHERE org_id = "+quoteLiteral(a.org)); got != 0 {
		t.Fatalf("reconcile lease minted %d permits, want 0", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.runtime_execution WHERE org_id = "+quoteLiteral(a.org)); got != 0 {
		t.Fatalf("reconcile lease created %d runtime executions, want 0", got)
	}
}

func TestR0bReconcileFinishLeaseCanFinishFailedWithUnknown(t *testing.T) {
	a := newActionFixture(t, "org_r0b_orch_j12_finish")
	worker := a.workerConn(t)
	mustExec(t, a.admin, "UPDATE work.operation SET state = 'unknown' WHERE id = "+quoteLiteral(a.op))
	mustExec(t, a.admin, "UPDATE work.execution_lease SET state = 'expired' WHERE id = "+quoteLiteral(a.leaseID))
	handback := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'reconcile_finish',NULL,30)`,
		a.org, a.runID, a.deviceID, a.sessionID)
	a.leaseID = idOf(t, handback, "lease_id")
	operationsBefore := a.scalarInt(t, "SELECT count(*) FROM work.operation WHERE org_id = "+quoteLiteral(a.org))
	dispatchesBefore := a.scalarInt(t, "SELECT count(*) FROM work.device_dispatch WHERE org_id = "+quoteLiteral(a.org))

	out := a.callFinish(t, worker, newUUID(t), entitledFinish(t, a), a.deviceID, a.sessionID)
	if out["state"] != "accepted" || out["code"] != nil {
		t.Fatalf("failed finish under reconcile lease = %#v", out)
	}
	if got := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); got != "failed" {
		t.Fatalf("Run state = %q, want failed", got)
	}
	if got := a.scalar(t, "SELECT state FROM work.execution_lease WHERE id = "+quoteLiteral(a.leaseID)); got != "released" {
		t.Fatalf("reconcile lease state = %q, want released", got)
	}
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE id = "+quoteLiteral(a.op)); got != "unknown" {
		t.Fatalf("failed finish rewrote unknown Operation = %q", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.operation WHERE org_id = "+quoteLiteral(a.org)); got != operationsBefore {
		t.Fatalf("hand-back finish created Operations: %d -> %d", operationsBefore, got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_dispatch WHERE org_id = "+quoteLiteral(a.org)); got != dispatchesBefore {
		t.Fatalf("hand-back finish minted permits: %d -> %d", dispatchesBefore, got)
	}
}

func TestR0bCheckpointConflictStopsTheRun(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_orch_conflict")
	worker := o.workerConn(t)
	callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, o.nonce)

	cp := func(seq int, hash, requestID string) map[string]any {
		return callJSON(t, worker,
			`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
			o.org, o.runID, requestID,
			`{"checkpoint_seq":`+strconv.Itoa(seq)+`,"checkpoint_hash":"`+hash+`","local_checkpoint_ref":"local/cp","receipt_through_seq":0,"pending_operation_set_hash":"`+strings.Repeat("c", 64)+`","device_signature":"`+strings.Repeat("d", 86)+`"}`,
			o.deviceID, o.sessionID)
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
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-cp-zero",
		`{"checkpoint_seq":0,"checkpoint_hash":"`+strings.Repeat("3", 64)+`","local_checkpoint_ref":"local/cp","receipt_through_seq":0,"pending_operation_set_hash":"`+strings.Repeat("c", 64)+`","device_signature":"`+strings.Repeat("d", 86)+`"}`,
		o.deviceID, o.sessionID)
}

func TestR0bRebindPointsAtTheLatestRecordedBaseline(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_orch_rebind")
	api := o.apiConn(t)
	worker := o.workerConn(t)
	callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, o.nonce)
	callJSON(t, worker,
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-rb-cp",
		`{"checkpoint_seq":1,"checkpoint_hash":"`+strings.Repeat("4", 64)+`","local_checkpoint_ref":"local/cp1","receipt_through_seq":0,"pending_operation_set_hash":"`+strings.Repeat("c", 64)+`","device_signature":"`+strings.Repeat("d", 86)+`"}`,
		o.deviceID, o.sessionID)

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
	if rebound["binding_revision"] != float64(2) || rebound["state"] != "active" {
		t.Fatalf("rebind did not atomically activate: %#v", rebound)
	}
	if got := o.scalar(t, "SELECT count(*)::text FROM work.execution_lease WHERE org_id = "+quoteLiteral(o.org)+" AND run_id = "+quoteLiteral(o.runID)+" AND binding_revision = 2 AND state = 'active'"); got != "1" {
		t.Fatalf("active rebind leases = %s, want 1", got)
	}
	if got := o.scalar(t, "SELECT state FROM work.execution_lease WHERE id = "+quoteLiteral(o.leaseID)); got != "revoked" {
		t.Fatalf("old execute lease = %s, want revoked", got)
	}
	if got := o.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(o.runID)); got != "active" {
		t.Fatalf("run after rebind = %s, want active", got)
	}
	if got := o.scalar(t, "SELECT fence::text FROM work.run WHERE id = "+quoteLiteral(o.runID)); got != "1" {
		t.Fatalf("resume fence = %s, want unchanged 1", got)
	}
}

func TestR0bAcquireRefusesResumeOfferWithoutItsBaseline(t *testing.T) {
	o := newOrchestrationFixture(t, "org_r0b_orch_failclosed")
	worker := o.workerConn(t)
	callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, o.nonce)
	callJSON(t, worker,
		`SELECT work.record_device_checkpoint($1,$2::uuid,1,2,$3,$4::jsonb,$5::uuid,$6::uuid)`,
		o.org, o.runID, "req-fc-cp",
		`{"checkpoint_seq":1,"checkpoint_hash":"`+strings.Repeat("5", 64)+`","local_checkpoint_ref":"local/cp1","receipt_through_seq":0,"pending_operation_set_hash":"`+strings.Repeat("c", 64)+`","device_signature":"`+strings.Repeat("d", 86)+`"}`,
		o.deviceID, o.sessionID)

	// A second binding that does not reference the available baseline must not start:
	// device §3.2 forbids rerunning from the initial input when a checkpoint exists.
	mustExec(t, o.admin, "UPDATE work.run SET state = 'waiting', wait_reason = 'input' WHERE id = "+quoteLiteral(o.runID))
	offer2 := `{"input_ref":"ref","input_hash":"` + strings.Repeat("7", 64) + `","snapshot_hash":"` + strings.Repeat("3", 64) +
		`","profile_id":"p1","profile_revision":1,"runtime_digest":"` + strings.Repeat("4", 64) +
		`","tool_manifest_hash":"` + strings.Repeat("5", 64) + `","model_version":"m1","grant_set":[{"grant_id":"` + o.grantID + `","grant_revision":1}],"offer_ttl_seconds":120}`
	expectCode(t, worker, "resync_required",
		`SELECT work.create_device_run_binding($1,$2::uuid,$3::uuid,$4::uuid,2,$5,$6::jsonb)`,
		o.org, o.runID, o.deviceID, o.sessionID, "req-fc-offer2", offer2)
	if got := o.scalar(t, "SELECT count(*)::text FROM work.device_run_binding WHERE org_id = "+quoteLiteral(o.org)+" AND binding_revision = 2"); got != "0" {
		t.Fatalf("failed activation left %s binding rows", got)
	}
	if got := o.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(o.runID)); got != "waiting" {
		t.Fatalf("failed activation moved Run to %s, want waiting", got)
	}
}
