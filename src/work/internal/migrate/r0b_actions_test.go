package migrate

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// actionFixture is the orchestration fixture plus the execute lease and the seq=0
// baseline that prepare_local_operation requires. Everything below the lease is reused
// rather than rebuilt: the device, session, grant, binding and active Run are the same
// rows the batch-two tests already prove are reachable through registered transitions.
type actionFixture struct {
	*orchestrationFixture
	leaseID        string
	fence          int64
	checkpointSeq  int64
	checkpointHash string
	grantClass     string
	selectorHash   string
}

func newActionFixture(t *testing.T, org string) *actionFixture {
	t.Helper()
	o := newOrchestrationFixture(t, org)
	// The shared fixture inserts the policy directly, so effective_epoch is still the
	// column default 0. A policy that was actually configured through set_local_policy
	// has epoch >= 1, and request_approval refuses epoch 0 - so the fixture has to
	// represent the configured state, not relax the guard.
	mustExec(t, o.admin, "UPDATE work.local_execution_policy SET effective_epoch = 1 WHERE org_id = "+
		quoteLiteral(o.org)+" AND effective_epoch = 0")
	worker := o.workerConn(t)
	lease := callJSON(t, worker,
		`SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,30)`,
		o.org, o.runID, o.deviceID, o.sessionID, newUUID(t))
	leaseID, _ := lease["lease_id"].(string)
	if leaseID == "" {
		t.Fatalf("acquire_device_lease returned no lease_id: %#v", lease)
	}
	a := &actionFixture{orchestrationFixture: o, leaseID: leaseID,
		selectorHash: strings.Repeat("c", 64)}
	a.fence = int64(a.scalarInt(t, "SELECT fence FROM work.run WHERE id = "+quoteLiteral(o.runID)))
	a.checkpointSeq = int64(a.scalarInt(t, "SELECT checkpoint_seq FROM work.device_checkpoint WHERE org_id = "+
		quoteLiteral(o.org)+" AND run_id = "+quoteLiteral(o.runID)+" ORDER BY checkpoint_seq DESC LIMIT 1"))
	a.checkpointHash = a.scalar(t, "SELECT checkpoint_hash FROM work.device_checkpoint WHERE org_id = "+
		quoteLiteral(o.org)+" AND run_id = "+quoteLiteral(o.runID)+" AND checkpoint_seq = "+
		fmt.Sprintf("%d", a.checkpointSeq))
	a.grantClass = a.scalar(t, "SELECT classification FROM work.workspace_grant WHERE id = "+
		quoteLiteral(o.grantID))
	return a
}

func (a *actionFixture) scalarInt(t *testing.T, sql string) int {
	t.Helper()
	var n int
	if err := a.admin.QueryRow(testContext(t), sql).Scan(&n); err != nil {
		t.Fatalf("scalar int: %v (%s)", err, sql)
	}
	return n
}

// actionBody is the closed action_prepare key set (20 keys). classification is a
// parameter because the cross-check direction is one of the things under test.
func (a *actionFixture) actionBody(t *testing.T, stepKey, classification string) string {
	t.Helper()
	return `{"prepare_id":"` + newUUID(t) + `","step_key":"` + stepKey + `","supersede_no":0,` +
		`"logical_key":"` + stepKey + `#0","supersedes_operation_id":null,"supersede_reason":null,` +
		`"supersede_assertion":null,"checkpoint_hash":"` + a.checkpointHash + `",` +
		`"request_hash":"` + strings.Repeat("1", 64) + `","action_kind":"workspace.read",` +
		`"tool_schema":"read-v1","local_payload_ref":"local/payload","grant_id":"` + a.grantID + `",` +
		`"grant_revision":1,"resource_selector_hash":"` + a.selectorHash + `",` +
		`"classification":"` + classification + `","destination_id":null,` +
		`"byte_upper_bound":1024,"token_upper_bound":64,` +
		`"device_signature":"sha256:` + strings.Repeat("2", 64) + `"}`
}

func (a *actionFixture) prepare(t *testing.T, worker *pgx.Conn, stepKey, classification string) map[string]any {
	t.Helper()
	return callJSON(t, worker,
		`SELECT work.prepare_local_operation($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb)`,
		a.org, a.runID, a.deviceID, a.sessionID, a.leaseID, a.fence, a.checkpointSeq,
		a.actionBody(t, stepKey, classification))
}

// The carrier ruling (bing) exists so both predicates have a per-action input set. This
// pins that prepare writes it, that the classification stored is the SERVER's value, and
// that a device claiming a less strict one is refused rather than believed.
func TestR0bPrepareLandsTheActionCarrierWithTheServerClassification(t *testing.T) {
	a := newActionFixture(t, "org_b3_carrier")
	worker := a.workerConn(t)

	out := a.prepare(t, worker, "tool:1", a.grantClass)
	opID, _ := out["operation_id"].(string)
	if opID == "" {
		t.Fatalf("prepare returned no operation_id: %#v", out)
	}
	if out["attempt_id"] == nil || out["attempt_id"] == "" {
		t.Fatalf("prepare must return the attempt_id consume_device_permit needs: %#v", out)
	}
	if got := a.scalar(t, "SELECT classification FROM work.local_action WHERE operation_id = "+
		quoteLiteral(opID)); got != a.grantClass {
		t.Fatalf("local_action classification = %q, want the grant's %q", got, a.grantClass)
	}
	if got := a.scalar(t, "SELECT action_kind FROM work.local_action WHERE operation_id = "+
		quoteLiteral(opID)); got != "workspace.read" {
		t.Fatalf("action_kind = %q, want workspace.read", got)
	}
	// A replay of the same logical_key and hash returns the same operation and attempt.
	replay := a.prepare(t, worker, "tool:1", a.grantClass)
	if replay["operation_id"] != opID || replay["replayed"] != true {
		t.Fatalf("replay = %#v, want the original operation %s", replay, opID)
	}

	// The cross-check is one-directional: a LESS strict claim than the server's value is
	// refused. With a local_only grant, remote_excerpt_allowed is that less strict claim.
	// A grant already at remote_excerpt_allowed has nothing less strict to claim, so the
	// negative case is only constructible on the local_only side.
	if a.grantClass == "local_only" {
		expectCode(t, worker, "classification_floor_required",
			`SELECT work.prepare_local_operation($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb)`,
			a.org, a.runID, a.deviceID, a.sessionID, a.leaseID, a.fence, a.checkpointSeq,
			a.actionBody(t, "tool:2", "remote_excerpt_allowed"))
	}
}

// Invariant 3, first enforcement point: an unreconciled Operation in this Run blocks a
// new action, and the code is run_has_unreconciled_operation, not execution_unknown.
func TestR0bPrepareBlocksOnAnUnreconciledOperation(t *testing.T) {
	a := newActionFixture(t, "org_b3_unknown")
	worker := a.workerConn(t)
	other := newUUID(t)
	mustExec(t, a.admin, "INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state) VALUES ("+
		quoteLiteral(other)+", "+quoteLiteral(a.org)+", "+quoteLiteral(a.runID)+", 'tool:9#0', 'tool', '"+
		strings.Repeat("7", 64)+"', 'unknown')")

	expectCode(t, worker, "run_has_unreconciled_operation",
		`SELECT work.prepare_local_operation($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb)`,
		a.org, a.runID, a.deviceID, a.sessionID, a.leaseID, a.fence, a.checkpointSeq,
		a.actionBody(t, "tool:1", a.grantClass))
	// Refused with zero side effects: no Operation, no action row, no Approval.
	if got := a.scalarInt(t, "SELECT count(*) FROM work.local_action WHERE org_id = "+
		quoteLiteral(a.org)); got != 0 {
		t.Fatalf("local_action rows after a refused prepare = %d, want 0", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.operation WHERE org_id = "+
		quoteLiteral(a.org)+" AND logical_key = 'tool:1#0'"); got != 0 {
		t.Fatalf("the refused prepare still created an Operation (%d rows)", got)
	}
}

// permitBody is the closed SignedPermit key set (28 keys). scope_hash is recomputed with
// the server's own helper over the server's own action row, which is what the command
// compares against; a tampered scope is the negative case below.
func (a *actionFixture) permitBody(t *testing.T, opID, attemptID, jti string, expires time.Time) string {
	t.Helper()
	scope := `{"action_kind":"workspace.read","grant_id":"` + a.grantID + `","grant_revision":1,` +
		`"resource_selector_hash":"` + a.selectorHash + `","classification":"` + a.grantClass +
		`","destination_id":null}`
	scopeHash := a.scalar(t, "SELECT work.sha256_text("+quoteLiteral(scope)+")")
	approvalID := a.scalar(t, "SELECT ao.approval_id::text FROM work.approval_operation ao WHERE ao.operation_id = "+
		quoteLiteral(opID))
	decisionRev := "0"
	if approvalID != "" {
		decisionRev = a.scalar(t, "SELECT revision::text FROM work.approval WHERE id = "+quoteLiteral(approvalID))
	}
	approvalField := "null"
	if approvalID != "" {
		approvalField = `"` + approvalID + `"`
	}
	return `{"v":1,"aud":"device-tool","kid":"k1","jti":"` + jti + `","org_id":"` + a.org +
		`","subject_id":"` + a.subject + `","device_id":"` + a.deviceID + `","session_id":"` + a.sessionID +
		`","agent_instance_id":"` + a.scalar(t, "SELECT agent_instance_id::text FROM work.device_session WHERE id = "+quoteLiteral(a.sessionID)) +
		`","boot_id":"boot-o","generation":` + a.scalar(t, "SELECT generation::text FROM work.device_session WHERE id = "+quoteLiteral(a.sessionID)) + `,"run_id":"` + a.runID + `","operation_id":"` + opID +
		`","dispatch_attempt_id":"` + attemptID + `","request_hash":"` + strings.Repeat("1", 64) +
		`","fence":` + fmt.Sprintf("%d", a.fence) + `,"policy_epoch":` +
		a.scalar(t, "SELECT effective_epoch::text FROM work.local_execution_policy WHERE org_id = "+quoteLiteral(a.org)) +
		`,"access_epoch":` + a.scalar(t, "SELECT admission_access_epoch::text FROM work.run WHERE id = "+quoteLiteral(a.runID)) +
		`,"grant_id":"` + a.grantID + `","grant_revision":1,"approval_id":` + approvalField +
		`,"decision_revision":` + decisionRev + `,"scope_hash":"` + scopeHash +
		`","destination_id":null,"max_bytes":1024,"issued_at":"` +
		time.Now().UTC().Add(-time.Second).Format(time.RFC3339) + `","expires_at":"` +
		expires.UTC().Format(time.RFC3339) + `","signature":"sha256:` + strings.Repeat("3", 64) + `"}`
}

// The single-use authority is the jti UNIQUE plus the authorized -> dispatching CAS.
// A replay returns the original command; a second, differently-signed permit for the
// same action cannot win the CAS again.
func TestR0bPermitIsSingleUseAndOnlyTheCASWinnerDispatches(t *testing.T) {
	a := newActionFixture(t, "org_b3_permit")
	worker := a.workerConn(t)
	out := a.prepare(t, worker, "tool:1", a.grantClass)
	opID, _ := out["operation_id"].(string)
	attemptID, _ := out["attempt_id"].(string)
	// The approval path is exercised separately; here the Operation is authorized so the
	// permit CAS is the thing under test.
	mustExec(t, a.admin, "UPDATE work.operation SET state = 'authorized' WHERE id = "+quoteLiteral(opID))
	mustExec(t, a.admin, "UPDATE work.approval SET status = 'approved', revision = revision + 1 WHERE id IN "+
		"(SELECT approval_id FROM work.approval_operation WHERE operation_id = "+quoteLiteral(opID)+")")

	jti := newUUID(t)
	body := a.permitBody(t, opID, attemptID, jti, time.Now().Add(4*time.Second))
	first := callJSON(t, worker,
		`SELECT work.consume_device_permit($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::jsonb)`,
		a.org, opID, attemptID, a.deviceID, a.sessionID, a.leaseID, a.fence,
		strings.Repeat("1", 64), body)
	if first["command_id"] == nil || first["delivery_state"] != "not_applicable" {
		t.Fatalf("first permit = %#v", first)
	}
	replay := callJSON(t, worker,
		`SELECT work.consume_device_permit($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::jsonb)`,
		a.org, opID, attemptID, a.deviceID, a.sessionID, a.leaseID, a.fence,
		strings.Repeat("1", 64), body)
	if replay["command_id"] != first["command_id"] || replay["replayed"] != true {
		t.Fatalf("replay = %#v, want the original command %v", replay, first["command_id"])
	}
	// A different jti for the same action: the CAS is already spent.
	expectCode(t, worker, "operation_not_authorizable",
		`SELECT work.consume_device_permit($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::jsonb)`,
		a.org, opID, attemptID, a.deviceID, a.sessionID, a.leaseID, a.fence,
		strings.Repeat("1", 64), a.permitBody(t, opID, attemptID, newUUID(t), time.Now().Add(4*time.Second)))
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_dispatch WHERE operation_id = "+
		quoteLiteral(opID)); got != 1 {
		t.Fatalf("dispatch rows = %d, want exactly 1", got)
	}
}

// finish must recompute the operation-set hash itself (O-16) and refuse a mismatch
// without writing any terminal state. The ack carries the server's own expected value.
func TestR0bFinishRefusesAMismatchedOperationSetHash(t *testing.T) {
	a := newActionFixture(t, "org_b3_finish")
	worker := a.workerConn(t)
	finishID := newUUID(t)
	body := `{"outcome":"failed","reason_code":"model_error","final_checkpoint_seq":` +
		fmt.Sprintf("%d", a.checkpointSeq) + `,"final_checkpoint_hash":"` + a.checkpointHash +
		`","receipt_through_seq":0,"final_operation_set_hash":"` + strings.Repeat("e", 64) +
		`","deliverable_versions":[],"device_signature":"sha256:` + strings.Repeat("4", 64) + `"}`
	out := callJSON(t, worker,
		`SELECT work.finish_local_run($1,$2::uuid,$3::uuid,$4::uuid,1,$5,$6::jsonb)`,
		a.org, a.runID, finishID, a.leaseID, a.fence, body)
	if out["state"] != "rejected" || out["code"] != "finish_state_mismatch" {
		t.Fatalf("finish = %#v, want rejected/finish_state_mismatch", out)
	}
	expected := a.scalar(t, "SELECT work.local_operation_set_hash("+quoteLiteral(a.org)+", "+
		quoteLiteral(a.runID)+")")
	if out["expected_operation_set_hash"] != expected {
		t.Fatalf("ack expected hash = %v, want the recomputed %s", out["expected_operation_set_hash"], expected)
	}
	if got := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); got != "active" {
		t.Fatalf("Run state after a refused finish = %q, want active (no terminal write)", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_run_finish WHERE run_id = "+
		quoteLiteral(a.runID)+" AND state = 'rejected'"); got != 1 {
		t.Fatalf("rejected finish rows = %d, want 1 (the refusal is evidence too)", got)
	}
	// Replaying the same finish_id returns the same verdict, not a second row.
	replay := callJSON(t, worker,
		`SELECT work.finish_local_run($1,$2::uuid,$3::uuid,$4::uuid,1,$5,$6::jsonb)`,
		a.org, a.runID, finishID, a.leaseID, a.fence, body)
	if replay["replayed"] != true || replay["state"] != "rejected" {
		t.Fatalf("finish replay = %#v", replay)
	}
}

// The nonce is consumed atomically and is single-use across the organization, so a
// signature for "approve once" cannot be replayed under a different client_request_id.
func TestR0bApprovalDecisionConsumesItsNonceOnce(t *testing.T) {
	a := newActionFixture(t, "org_b3_nonce")
	api := a.apiConn(t)
	worker := a.workerConn(t)
	out := a.prepare(t, worker, "tool:1", a.grantClass)
	opID, _ := out["operation_id"].(string)
	approvalID, _ := out["approval_id"].(string)
	if approvalID == "" {
		t.Fatalf("ask_each prepare produced no approval: %#v", out)
	}
	nonce := "nonce-b3-0001"
	proof := func(approval, op, decision string) string {
		return `{"v":1,"org_id":"` + a.org + `","subject_id":"` + a.subject +
			`","auth_plane":"bearer","auth_epoch":` +
			a.scalar(t, "SELECT auth_epoch::text FROM work.device WHERE id = "+quoteLiteral(a.deviceID)) +
			`,"device_id":"` + a.deviceID + `","session_id":"` + a.sessionID +
			`","approval_id":"` + approval + `","operation_id":"` + op +
			`","params_hash":"` + strings.Repeat("1", 64) + `","expected_revision":0,` +
			`"decision":"` + decision + `","remember_readonly":false,"readonly_scope":null,` +
			`"readonly_expires_at":null,"policy_epoch":` +
			a.scalar(t, "SELECT effective_epoch::text FROM work.local_execution_policy WHERE org_id = "+quoteLiteral(a.org)) +
			`,"access_epoch":` + a.scalar(t, "SELECT admission_access_epoch::text FROM work.run WHERE id = "+quoteLiteral(a.runID)) +
			`,"nonce":"` + nonce + `","expires_at":"` +
			time.Now().UTC().Add(10*time.Minute).Format(time.RFC3339) +
			`","signature":"sha256:` + strings.Repeat("5", 64) + `"}`
	}
	decided := callJSON(t, api,
		`SELECT work.decide_local_approval($1,$2,'bearer',$3,$4::uuid,$5,$6::jsonb)`,
		a.org, a.subject,
		a.scalarInt(t, "SELECT auth_epoch FROM work.device WHERE id = "+quoteLiteral(a.deviceID)),
		approvalID, "req-b3-decide-1", proof(approvalID, opID, "approved"))
	if decided["decision"] != "approved" {
		t.Fatalf("decision = %#v", decided)
	}
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE id = "+quoteLiteral(opID)); got != "authorized" {
		t.Fatalf("operation state after approval = %q, want authorized", got)
	}
	if got := a.scalar(t, "SELECT nonce FROM work.approval_decision WHERE approval_id = "+
		quoteLiteral(approvalID)); got != nonce {
		t.Fatalf("stored nonce = %q, want %q", got, nonce)
	}
	// The nonce is single-use across the ORGANIZATION, not per approval: a second,
	// still-pending approval decided with the same nonce is a replayed signature.
	second := a.prepare(t, worker, "tool:2", a.grantClass)
	op2, _ := second["operation_id"].(string)
	approval2, _ := second["approval_id"].(string)
	if approval2 == "" {
		t.Fatalf("second prepare produced no approval: %#v", second)
	}
	expectCode(t, api, "approval_nonce_reused",
		`SELECT work.decide_local_approval($1,$2,'bearer',$3,$4::uuid,$5,$6::jsonb)`,
		a.org, a.subject,
		a.scalarInt(t, "SELECT auth_epoch FROM work.device WHERE id = "+quoteLiteral(a.deviceID)),
		approval2, "req-b3-decide-2", proof(approval2, op2, "approved"))
	// The same client_request_id is the ordinary retry and returns the original answer.
	replay := callJSON(t, api,
		`SELECT work.decide_local_approval($1,$2,'bearer',$3,$4::uuid,$5,$6::jsonb)`,
		a.org, a.subject,
		a.scalarInt(t, "SELECT auth_epoch FROM work.device WHERE id = "+quoteLiteral(a.deviceID)),
		approvalID, "req-b3-decide-1", proof(approvalID, opID, "approved"))
	if replay["replayed"] != true {
		t.Fatalf("same-request replay = %#v", replay)
	}
}