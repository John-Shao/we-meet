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
	return a.prepareBody(t, worker, a.actionBody(t, stepKey, classification))
}

func (a *actionFixture) prepareBody(t *testing.T, worker *pgx.Conn, body string) map[string]any {
	t.Helper()
	return callJSON(t, worker,
		`SELECT work.prepare_local_operation($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb)`,
		a.org, a.runID, a.deviceID, a.sessionID, a.leaseID, a.fence, a.checkpointSeq, body)
}

func (a *actionFixture) refusePrepareBody(t *testing.T, worker *pgx.Conn, body, wantCode string) refusal {
	t.Helper()
	return expectRefused(t, worker, wantCode, "P0001",
		`SELECT work.prepare_local_operation($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb)`,
		a.org, a.runID, a.deviceID, a.sessionID, a.leaseID, a.fence, a.checkpointSeq, body)
}

// modelActionBody is actionBody reshaped into one of the two model kinds. They are the
// only actions allowed to carry a destination (0042:789), so they are the only shape the
// (A) destination gate can look at. Both rewrites are asserted: a body that quietly stayed
// a workspace.read would still refuse, but for a reason that has nothing to do with the
// branch under test.
func (a *actionFixture) modelActionBody(t *testing.T, stepKey, actionKind, destination string) string {
	t.Helper()
	base := a.actionBody(t, stepKey, a.grantClass)
	body := strings.Replace(base, `"action_kind":"workspace.read"`,
		`"action_kind":"`+actionKind+`"`, 1)
	if body == base {
		t.Fatalf("actionBody no longer contains the workspace.read needle, so no model action was built")
	}
	prev := body
	body = strings.Replace(body, `"destination_id":null`, `"destination_id":"`+destination+`"`, 1)
	if body == prev {
		t.Fatalf("actionBody no longer contains a null destination_id, so the destination was never set")
	}
	return body
}

// runTaint is the destination gate's own input set, read the way the gate reads it: the
// content-taking actions of this Run and the classification of the grant each referenced
// (workspace.list excluded, J11). Both EV97 tests pin it because their premise is the
// taint, not the body: without this reading a refusal could come from the gate, and a
// missing taint could equally be the reason the positive control passed, and neither test
// would be able to tell which of the two it measured.
func (a *actionFixture) runTaint(t *testing.T) string {
	t.Helper()
	return a.scalar(t, `SELECT coalesce(string_agg(la.action_kind || ':' || g.classification, ',' `+
		`ORDER BY la.action_kind || ':' || g.classification), 'none') `+
		`FROM work.local_action la `+
		`JOIN work.operation o ON o.id = la.operation_id AND o.org_id = la.org_id `+
		`JOIN work.workspace_grant g ON g.id = la.grant_id AND g.org_id = la.org_id `+
		`WHERE la.org_id = `+quoteLiteral(a.org)+` AND o.run_id = `+quoteLiteral(a.runID)+
		` AND la.action_kind IN ('workspace.read', 'workspace.search', 'artifact.write')`)
}

// authorizeAction moves a prepared Operation to authorized the way a decided approval
// does. Both writes are needed: consume_device_permit refuses a permit whose approval_id
// or decision_revision disagrees with the stored Approval, and that check sits before the
// destination gate, so a half-moved action tests the approval comparison instead.
func (a *actionFixture) authorizeAction(t *testing.T, operationID string) {
	t.Helper()
	mustExec(t, a.admin, "UPDATE work.operation SET state = 'authorized' WHERE id = "+quoteLiteral(operationID))
	mustExec(t, a.admin, "UPDATE work.approval SET status = 'approved', revision = revision + 1 WHERE id IN "+
		"(SELECT approval_id FROM work.approval_operation WHERE operation_id = "+quoteLiteral(operationID)+")")
}

func (a *actionFixture) consumePermit(t *testing.T, worker *pgx.Conn, opID, attemptID, body string) map[string]any {
	t.Helper()
	return callJSON(t, worker,
		`SELECT work.consume_device_permit($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::jsonb)`,
		a.org, opID, attemptID, a.deviceID, a.sessionID, a.leaseID, a.fence,
		strings.Repeat("1", 64), body)
}

func (a *actionFixture) refuseConsume(t *testing.T, worker *pgx.Conn, opID, attemptID, body, wantCode string) refusal {
	t.Helper()
	return expectRefused(t, worker, wantCode, "P0001",
		`SELECT work.consume_device_permit($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::jsonb)`,
		a.org, opID, attemptID, a.deviceID, a.sessionID, a.leaseID, a.fence,
		strings.Repeat("1", 64), body)
}

// idOf is the one assertion every prepare answer needs before it is used as a premise:
// callJSON does not fail on a success-shaped body that is missing the id.
func idOf(t *testing.T, out map[string]any, key string) string {
	t.Helper()
	id, _ := out[key].(string)
	if id == "" {
		t.Fatalf("%s returned no %s: %#v", t.Name(), key, out)
	}
	return id
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
//
// The action's kind, classification and destination are READ from work.local_action rather
// than passed in, because consume_device_permit derives aud and scope_hash from that row
// (0042:1391, 0042:1425). A hand-written pair that disagrees with the stored row refuses
// for 'unauthorized' long before the branch a test is aimed at, and the test would then be
// measuring the wrong gate.
func (a *actionFixture) permitBody(t *testing.T, opID, attemptID, jti string, expires time.Time) string {
	t.Helper()
	row := a.scalar(t, "SELECT action_kind||'|'||classification||'|'||coalesce(destination_id,'') "+
		"FROM work.local_action WHERE org_id = "+quoteLiteral(a.org)+" AND operation_id = "+quoteLiteral(opID))
	parts := strings.SplitN(row, "|", 3)
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" {
		t.Fatalf("no stored local_action row for operation %s, got %q", opID, row)
	}
	kind, classification, destination := parts[0], parts[1], parts[2]
	aud, destinationField := "device-tool", "null"
	if strings.HasPrefix(kind, "model.send") {
		aud = "device-model-proxy"
		if destination == "" {
			t.Fatalf("stored action %s has no destination, so the permit cannot name one", kind)
		}
		destinationField = `"` + destination + `"`
	}
	scope := `{"action_kind":"` + kind + `","grant_id":"` + a.grantID + `","grant_revision":1,` +
		`"resource_selector_hash":"` + a.selectorHash + `","classification":"` + classification +
		`","destination_id":` + destinationField + `}`
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
	return `{"v":1,"aud":"` + aud + `","kid":"k1","jti":"` + jti + `","org_id":"` + a.org +
		`","subject_id":"` + a.subject + `","device_id":"` + a.deviceID + `","session_id":"` + a.sessionID +
		`","agent_instance_id":"` + a.scalar(t, "SELECT agent_instance_id::text FROM work.device_session WHERE id = "+quoteLiteral(a.sessionID)) +
		`","boot_id":"boot-o","generation":` + a.scalar(t, "SELECT generation::text FROM work.device_session WHERE id = "+quoteLiteral(a.sessionID)) + `,"run_id":"` + a.runID + `","operation_id":"` + opID +
		`","dispatch_attempt_id":"` + attemptID + `","request_hash":"` + strings.Repeat("1", 64) +
		`","fence":` + fmt.Sprintf("%d", a.fence) + `,"policy_epoch":` +
		a.scalar(t, "SELECT effective_epoch::text FROM work.local_execution_policy WHERE org_id = "+quoteLiteral(a.org)) +
		`,"access_epoch":` + a.scalar(t, "SELECT admission_access_epoch::text FROM work.run WHERE id = "+quoteLiteral(a.runID)) +
		`,"grant_id":"` + a.grantID + `","grant_revision":1,"approval_id":` + approvalField +
		`,"decision_revision":` + decisionRev + `,"scope_hash":"` + scopeHash +
		`","destination_id":` + destinationField + `,"max_bytes":1024,"issued_at":"` +
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

// EV97, first of the two named cases for card (A).
//
// The gate at 0042:932 is implemented-but-unreachable in production today (card E=B left
// device_local as the only destination), which is exactly why it needs a named test rather
// than a prose claim: nothing else exercises the branch, so a regression that deletes or
// inverts it is silent. The three cells here are pairwise, so the refusal names its own
// cause - (no taint, remote) passes and (taint, device_local) passes, and only
// (taint, remote) is refused.
func TestR0bPrepareRefusesANonDeviceDestinationOnceTheRunHasLocalOnlyInput(t *testing.T) {
	a := newActionFixture(t, "org_b3_dest_prepare")
	worker := a.workerConn(t)
	// The predicate is a rank comparison against local_only. With the less strict grant
	// there is no taint that can trip it, so the premise is checked rather than assumed.
	if a.grantClass != "local_only" {
		t.Fatalf("grant classification = %q, want local_only", a.grantClass)
	}
	if got := a.runTaint(t); got != "none" {
		t.Fatalf("a fresh Run already has content-taking actions: %q", got)
	}

	// Cell (no taint, remote): the body shape is acceptable, so a later refusal of the
	// same shape can only be about the taint.
	out := a.prepareBody(t, worker, a.modelActionBody(t, "model:remote:1",
		"model.send_remote", "org_remote"))
	firstOp := idOf(t, out, "operation_id")
	if got := a.scalar(t, "SELECT destination_id FROM work.local_action WHERE org_id = "+
		quoteLiteral(a.org)+" AND operation_id = "+quoteLiteral(firstOp)); got != "org_remote" {
		t.Fatalf("stored destination = %q, want org_remote", got)
	}

	// Land the taint, then re-check it from the gate's own input set.
	a.prepare(t, worker, "tool:1", a.grantClass)
	if got := a.runTaint(t); got != "workspace.read:local_only" {
		t.Fatalf("run taint = %q, want the local_only workspace.read to be visible", got)
	}

	actions := countRows(t, a.admin, "SELECT count(*) FROM work.local_action WHERE org_id = "+
		quoteLiteral(a.org))
	ops := countRows(t, a.admin, "SELECT count(*) FROM work.operation WHERE org_id = "+
		quoteLiteral(a.org))
	refused := a.refusePrepareBody(t, worker, a.modelActionBody(t, "model:remote:2",
		"model.send_remote", "org_remote"), "destination_not_allowed_for_local_only")
	if refused.code != "destination_not_allowed_for_local_only" {
		t.Fatalf("refusal code = %q", refused.code)
	}
	// Zero side effects: gate (A) sits before every write in prepare, so a refusal may
	// not leave an Operation, an action carrier or an Approval behind.
	if got := countRows(t, a.admin, "SELECT count(*) FROM work.local_action WHERE org_id = "+
		quoteLiteral(a.org)); got != actions {
		t.Fatalf("local_action rows moved %d -> %d on a refused prepare", actions, got)
	}
	if got := countRows(t, a.admin, "SELECT count(*) FROM work.operation WHERE org_id = "+
		quoteLiteral(a.org)); got != ops {
		t.Fatalf("operation rows moved %d -> %d on a refused prepare", ops, got)
	}
	if got := countRows(t, a.admin, "SELECT count(*) FROM work.operation WHERE org_id = "+
		quoteLiteral(a.org)+" AND logical_key = 'model:remote:2#0'"); got != 0 {
		t.Fatalf("the refused action still created %d Operation rows", got)
	}

	// Cell (taint, device_local): the destination is what the gate objects to, not the
	// model kind, not the grant and not the Run state the first refusal left behind.
	ctrl := a.prepareBody(t, worker, a.modelActionBody(t, "model:local:1",
		"model.send_device_local", "device_local"))
	ctrlOp := idOf(t, ctrl, "operation_id")
	if ctrl["replayed"] == true {
		t.Fatalf("the device_local control replayed an earlier action: %#v", ctrl)
	}
	if got := a.scalar(t, "SELECT destination_id FROM work.local_action WHERE org_id = "+
		quoteLiteral(a.org)+" AND operation_id = "+quoteLiteral(ctrlOp)); got != "device_local" {
		t.Fatalf("control stored destination = %q, want device_local", got)
	}
}

// EV97, second of the two. The same predicate is re-evaluated at 0042:1462 from the
// stored action row, because the taint can arrive after prepare: the device may hold an
// authorized, un-dispatched action across a workspace.read. This test is the only thing
// that proves the second reading is a reading - the permit body is built from the server's
// own row, so nothing device-claimed is consulted here.
func TestR0bPermitConsumptionReChecksTheDestinationFromServerFacts(t *testing.T) {
	a := newActionFixture(t, "org_b3_dest_permit")
	worker := a.workerConn(t)
	if a.grantClass != "local_only" {
		t.Fatalf("grant classification = %q, want local_only", a.grantClass)
	}

	// Prepare the remote model action while the Run is clean: gate (A) at prepare does not
	// fire, which is the whole reason a second enforcement point exists.
	out := a.prepareBody(t, worker, a.modelActionBody(t, "model:remote:1",
		"model.send_remote", "org_remote"))
	opID := idOf(t, out, "operation_id")
	attemptID := idOf(t, out, "attempt_id")
	if got := a.runTaint(t); got != "none" {
		t.Fatalf("the remote action should not have tainted its own Run: %q", got)
	}

	a.prepare(t, worker, "tool:1", a.grantClass)
	if got := a.runTaint(t); got != "workspace.read:local_only" {
		t.Fatalf("run taint = %q, want the local_only workspace.read to be visible", got)
	}

	a.authorizeAction(t, opID)
	body := a.permitBody(t, opID, attemptID, newUUID(t), time.Now().Add(4*time.Second))
	a.refuseConsume(t, worker, opID, attemptID, body, "destination_not_allowed_for_local_only")

	// The refusal sits before the CAS, so the single-use authority is still unspent and
	// the Operation has not moved: no dispatch row, no command, still authorized.
	if got := countRows(t, a.admin, "SELECT count(*) FROM work.device_dispatch WHERE org_id = "+
		quoteLiteral(a.org)+" AND operation_id = "+quoteLiteral(opID)); got != 0 {
		t.Fatalf("a refused permit still wrote %d dispatch rows", got)
	}
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE org_id = "+
		quoteLiteral(a.org)+" AND id = "+quoteLiteral(opID)); got != "authorized" {
		t.Fatalf("operation state after the refused permit = %q, want authorized (the CAS is "+
			"after the gate, so a dispatching row here means the gate let it through)", got)
	}

	// Positive control: with the same taint, the same lease and a permit built the same
	// way, a device_local model action does get its command. Without this, a permitBody
	// that no longer matches the server's row would make the negative case pass for the
	// wrong reason - it would refuse with 'unauthorized', and expectRefused would not see
	// that code, but an unconditional RAISE earlier in the function would also be invisible.
	ctrl := a.prepareBody(t, worker, a.modelActionBody(t, "model:local:1",
		"model.send_device_local", "device_local"))
	ctrlOp := idOf(t, ctrl, "operation_id")
	ctrlAttempt := idOf(t, ctrl, "attempt_id")
	a.authorizeAction(t, ctrlOp)
	got := a.consumePermit(t, worker, ctrlOp, ctrlAttempt,
		a.permitBody(t, ctrlOp, ctrlAttempt, newUUID(t), time.Now().Add(4*time.Second)))
	if idOf(t, got, "command_id") == "" || got["delivery_state"] != "not_applicable" {
		t.Fatalf("device_local permit under the same taint = %#v", got)
	}
	if n := countRows(t, a.admin, "SELECT count(*) FROM work.device_dispatch WHERE org_id = "+
		quoteLiteral(a.org)+" AND operation_id = "+quoteLiteral(ctrlOp)); n != 1 {
		t.Fatalf("dispatch rows for the control = %d, want exactly 1", n)
	}
}
