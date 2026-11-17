package gateway_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"

	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

// GW13: the action_prepare uplink and the server-signed action_prepared downlink. The domain
// command needed no ownership restatement (0042 already binds device/session/lease/fence);
// 0054 only reconciled the signature shape. These tests prove the gateway verifies before it
// translates, forwards without judging, and returns the ruled fourteen-key body.

// seedLocalPolicyAndGrant adds what prepare_local_operation needs and the receipt/finish
// fixtures never did: a configured organization policy (local_policy_gate must read 'ready',
// and request_approval refuses effective_epoch 0) and an active workspace grant bound to this
// device and session. The grant is inserted directly, as seedAction/seedOffer insert their own
// rows; its classification is the server-derived value the device may only cross-check.
func (f *gwFixture) seedLocalPolicyAndGrant(t *testing.T, sessionID, bootID string) string {
	t.Helper()
	ctx := gwContext(t)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = seed.Close(ctx) }()
	grantID := uuid.NewString()
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		INSERT INTO work.local_execution_policy
			(org_id, allowed_tools, allowed_destinations, classification_rules,
			 classification_default, classification_default_confirmed, classification_floor,
			 readonly_max_actions, readonly_ttl, input_limit_bytes, output_limit_bytes,
			 effective_epoch)
		VALUES ('%s',
			ARRAY['workspace.list','workspace.read','workspace.search','artifact.write'],
			ARRAY['device_local'],
			'[{"matcher":{"path_prefix":"docs"},"classification":"local_only","max_confirmable":"local_only"},
			  {"matcher":{"path_prefix":"public"},"classification":"remote_excerpt_allowed","max_confirmable":"remote_excerpt_allowed"}]'::jsonb,
			'local_only', true, 'remote_excerpt_allowed', 3, interval '1 hour', 262144, 262144, 1);
		INSERT INTO work.workspace_grant
			(org_id, id, device_id, session_id, owner_subject_id, boot_id, root_identity_hash,
			 allowed_tools, classification, matched_rule_index, grant_revision, expires_at,
			 state, client_request_id, request_hash)
		VALUES ('%s','%s','%s','%s','%s','%s','%s',
			ARRAY['workspace.read'],'local_only',0,1, now() + interval '1 hour',
			'active','req-gw13-grant','%s');
	`, gwOrg, gwOrg, gwOrg, grantID, f.deviceID, sessionID, gwSubject, bootID,
		strings.Repeat("8", 64), strings.Repeat("9", 64))
	if err := testpg.ExecRaw(ctx, seed, script); err != nil {
		t.Fatal(err)
	}
	return grantID
}

// startRunForAction is the GW11 spine plus the policy and grant, so the device legitimately
// holds everything an action_prepare must name: an active execute lease, the current fence and
// the seq=0 checkpoint baseline acquire_device_lease wrote.
func startRunForAction(t *testing.T) (*runUnderFinish, string) {
	t.Helper()
	r := startRunForFinish(t)
	return r, r.f.seedLocalPolicyAndGrant(t, r.sessionID, r.bootID)
}

// actionBody builds the closed wire action_prepare body (§3.1 plus the ruled lease_id/fence).
// supersede_no is not a key: the gateway derives it from logical_key, which SQL forces to be
// step_key#supersede_no. The three supersede keys are present and null for a fresh action.
func (r *runUnderFinish) actionBody(grantID, stepKey string, supersedeNo int) map[string]any {
	return map[string]any{
		"prepare_id":              uuid.NewString(),
		"run_id":                  r.runID,
		"lease_id":                r.leaseID,
		"fence":                   r.fence,
		"step_key":                stepKey,
		"logical_key":             fmt.Sprintf("%s#%d", stepKey, supersedeNo),
		"supersedes_operation_id": nil,
		"supersede_reason":        nil,
		"supersede_assertion":     nil,
		"checkpoint_seq":          "0",
		"checkpoint_hash":         r.checkpoint,
		"request_hash":            strings.Repeat("1", 64),
		"action_kind":             "workspace.read",
		"tool_schema":             "read-v1",
		"local_payload_ref":       "local/payload",
		"grant_id":                grantID,
		"grant_revision":          "1",
		"resource_selector_hash":  strings.Repeat("c", 64),
		"classification":          "local_only",
		"destination_id":          nil,
		"byte_upper_bound":        "1024",
		"token_upper_bound":       "64",
	}
}

func (r *runUnderFinish) sendAction(t *testing.T, body map[string]any) {
	t.Helper()
	if err := r.stream.SendMsg(r.f.signFrame(t, "action_prepare", r.sessionID, r.bootID, r.agentID, body)); err != nil {
		t.Fatal(err)
	}
}

// TestActionPrepareCreatesTheOperationAndIsServerSigned is the GW13 round trip on the default
// ask_each path: the device proposes, SQL creates the Operation and its Approval and parks the
// Run, and the ack carries the attempt_id the next step (consume_device_permit) requires. The
// gateway judges nothing — the classification it returns is the grant's, not the device's claim.
func TestActionPrepareCreatesTheOperationAndIsServerSigned(t *testing.T) {
	r, grantID := startRunForAction(t)
	body := r.actionBody(grantID, "tool:1", 0)
	// signFrame mutates the map, and ES256 is randomized: capture the bytes once so the replay
	// below re-sends the SAME signature rather than a fresh one (GW12 lesson).
	signed := r.f.signFrame(t, "action_prepare", r.sessionID, r.bootID, r.agentID, body)
	if err := r.stream.SendMsg(signed); err != nil {
		t.Fatal(err)
	}
	bodyJSON, ack, ackSession := recvTypedFrame(t, r.stream, "action_prepared")
	if ackSession != r.sessionID {
		t.Fatalf("action_prepared session = %v, want %s", ackSession, r.sessionID)
	}
	// The ruled closed fourteen-key set: the command's thirteen response keys plus signature.
	if len(ack) != 14 {
		t.Fatalf("ack body = %#v, want exactly the ruled fourteen keys", ack)
	}
	if _, leaked := ack["replayed"]; leaked {
		t.Fatalf("ack leaked the internal idempotency fact: %#v", ack)
	}
	opID, _ := ack["operation_id"].(string)
	attemptID, _ := ack["attempt_id"].(string)
	if opID == "" || attemptID == "" {
		t.Fatalf("ack must carry the operation and the attempt consume_device_permit needs: %#v", ack)
	}
	if ack["state"] != "waiting_approval" || ack["auto_approved"] != false {
		t.Fatalf("ask_each ack = %#v, want waiting_approval and auto_approved false", ack)
	}
	if approval, _ := ack["approval_id"].(string); approval == "" {
		t.Fatalf("ask_each must return the Approval it created: %#v", ack)
	}
	if ack["classification"] != "local_only" || ack["destination_id"] != nil {
		t.Fatalf("ack classification/destination = %#v, want the grant's local_only and null", ack)
	}
	for _, key := range []string{"supersede_no", "revision", "checkpoint_seq"} {
		if value, ok := ack[key].(string); !ok || value == "" {
			t.Fatalf("ack %s = %#v, want a decimal string (§3.1 uint64 boundary)", key, ack[key])
		}
	}
	if ack["logical_key"] != "tool:1#0" || ack["step_key"] != "tool:1" || ack["supersede_no"] != "0" {
		t.Fatalf("ack key identity = %#v, want the derived supersede_no 0", ack)
	}
	if ack["request_hash"] != strings.Repeat("1", 64) {
		t.Fatalf("ack request_hash = %#v, want the proposed hash", ack["request_hash"])
	}
	sig, _ := ack["signature"].(string)
	if sig == "" || !devicesig.VerifyFrame(r.serverPub, "action_prepared", bodyJSON, sig) {
		t.Fatalf("ack signature does not verify against the hello_ack JWK: %#v", ack)
	}
	for _, other := range []string{"action_prepare", "run_offer", "run_finish_ack", "checkpoint_ack"} {
		if devicesig.VerifyFrame(r.serverPub, other, bodyJSON, sig) {
			t.Fatalf("an action_prepared signature verified as %s (frame type not bound)", other)
		}
	}

	// The write set is SQL's, read back independently of the ack.
	if got := r.scalar(t, `SELECT classification FROM work.local_action WHERE org_id=$1 AND operation_id=$2::uuid`, gwOrg, opID); got != "local_only" {
		t.Fatalf("local_action classification = %q, want the grant's local_only", got)
	}
	if got := r.scalar(t, `SELECT attempt_id::text FROM work.local_action WHERE org_id=$1 AND operation_id=$2::uuid`, gwOrg, opID); got != attemptID {
		t.Fatalf("local_action attempt = %s, want the ack's %s", got, attemptID)
	}
	if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND id=$2::uuid`, gwOrg, opID); got != "waiting_approval" {
		t.Fatalf("Operation state = %q, want waiting_approval", got)
	}
	if got := r.scalar(t, `SELECT state || '/' || COALESCE(wait_reason,'') FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "waiting/approval" {
		t.Fatalf("Run = %s, want waiting/approval (ask_each parks the Run)", got)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.device_dispatch WHERE org_id=$1`, gwOrg); got != "0" {
		t.Fatalf("prepare dispatched %s rows: it must not consume a permit or create a command", got)
	}

	// A lost ack is repaired by re-sending the same bytes: the idempotency authority is
	// (org, run, logical_key), not prepare_id (O-9 = jia), so the same Operation and attempt
	// come back and no second action row is written.
	if err := r.stream.SendMsg(signed); err != nil {
		t.Fatal(err)
	}
	_, replay, _ := recvTypedFrame(t, r.stream, "action_prepared")
	if replay["operation_id"] != opID || replay["attempt_id"] != attemptID {
		t.Fatalf("replay = %#v, want the original operation %s and attempt %s", replay, opID, attemptID)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.local_action WHERE org_id=$1 AND operation_id=$2::uuid`, gwOrg, opID); got != "1" {
		t.Fatalf("action rows after a replay = %s, want still 1", got)
	}
}

// TestActionPrepareReadonlyGrantAutoApproves proves the only consumer of readonly_approval_grant
// (R11C-1) is reachable through the gateway: a matching grant authorizes the Operation without
// an Approval, consumes one action of the grant, and leaves the Run active.
func TestActionPrepareReadonlyGrantAutoApproves(t *testing.T) {
	r, grantID := startRunForAction(t)
	readonlyID := r.seedReadonlyGrant(t, grantID)

	r.sendAction(t, r.actionBody(grantID, "tool:auto", 0))
	_, ack, _ := recvTypedFrame(t, r.stream, "action_prepared")
	if ack["state"] != "authorized" || ack["auto_approved"] != true {
		t.Fatalf("readonly ack = %#v, want authorized and auto_approved true", ack)
	}
	if ack["approval_id"] != nil {
		t.Fatalf("a readonly hit must not create an Approval: %#v", ack)
	}
	opID, _ := ack["operation_id"].(string)
	if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND id=$2::uuid`, gwOrg, opID); got != "authorized" {
		t.Fatalf("Operation state = %q, want authorized", got)
	}
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "active" {
		t.Fatalf("Run state = %q, want the untouched active", got)
	}
	if got := r.scalar(t, `SELECT consumed_count::text FROM work.readonly_approval_grant WHERE org_id=$1 AND id=$2::uuid`, gwOrg, readonlyID); got != "1" {
		t.Fatalf("readonly grant consumed_count = %s, want 1", got)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.audit_event WHERE org_id=$1 AND action='operation.auto_approved'`, gwOrg); got != "1" {
		t.Fatalf("auto_approved audit rows = %s, want 1", got)
	}
}

// TestActionPrepareRejectsBadSignature proves the gateway verifies the action_prepare ES256
// signature over the wire body before the domain command: a tampered signature is
// UNAUTHENTICATED and no action row is written.
func TestActionPrepareRejectsBadSignature(t *testing.T) {
	r, grantID := startRunForAction(t)
	signed := r.f.signFrame(t, "action_prepare", r.sessionID, r.bootID, r.agentID,
		r.actionBody(grantID, "tool:bad", 0))
	var env map[string]json.RawMessage
	if err := json.Unmarshal(signed, &env); err != nil {
		t.Fatal(err)
	}
	var inner map[string]any
	if err := json.Unmarshal(env["body"], &inner); err != nil {
		t.Fatal(err)
	}
	inner["signature"] = strings.Repeat("A", 86)
	env["body"], _ = json.Marshal(inner)
	tampered, _ := json.Marshal(env)
	if err := r.stream.SendMsg(tampered); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, r.stream.RecvMsg(&raw), codes.Unauthenticated)
	if got := r.scalar(t, `SELECT count(*)::text FROM work.local_action WHERE org_id=$1`, gwOrg); got != "0" {
		t.Fatalf("a bad signature wrote %s action rows, want 0", got)
	}
}

// TestActionPrepareRejectsBadShape proves the closed body is parsed before any domain command:
// a non-UUID grant, a non-decimal fence, a logical_key without the supersede separator and an
// empty tool_schema are all invalid_request. Each case gets its own stream because a refusal
// terminates it, and the shape gate runs first so nothing downstream is reachable.
func TestActionPrepareRejectsBadShape(t *testing.T) {
	mutate := []func(map[string]any){
		func(b map[string]any) { b["grant_id"] = "not-a-uuid" },
		func(b map[string]any) { b["fence"] = "not-a-fence" },
		func(b map[string]any) { b["logical_key"] = "tool:nosep" },
		func(b map[string]any) { b["tool_schema"] = "" },
		func(b map[string]any) { b["checkpoint_seq"] = "-1" },
		func(b map[string]any) { b["grant_revision"] = "0" },
	}
	for _, edit := range mutate {
		f := newGatewayFixture(t)
		addr := f.startServer(t)
		stream := f.connect(t, addr)
		sessionID, _, bootID, agentID, _, _ := f.helloWithServerJWK(t, stream)
		body := map[string]any{
			"prepare_id": uuid.NewString(), "run_id": uuid.NewString(),
			"lease_id": uuid.NewString(), "fence": "2",
			"step_key": "tool:1", "logical_key": "tool:1#0",
			"supersedes_operation_id": nil, "supersede_reason": nil, "supersede_assertion": nil,
			"checkpoint_seq": "0", "checkpoint_hash": strings.Repeat("a", 64),
			"request_hash": strings.Repeat("b", 64), "action_kind": "workspace.read",
			"tool_schema": "read-v1", "local_payload_ref": "local/payload",
			"grant_id": uuid.NewString(), "grant_revision": "1",
			"resource_selector_hash": strings.Repeat("c", 64),
			"classification":         "local_only", "destination_id": nil,
			"byte_upper_bound": "1024", "token_upper_bound": "64",
		}
		edit(body)
		if err := stream.SendMsg(f.signFrame(t, "action_prepare", sessionID, bootID, agentID, body)); err != nil {
			t.Fatal(err)
		}
		var raw []byte
		wantCode(t, stream.RecvMsg(&raw), codes.InvalidArgument)
	}
}

// TestActionPrepareMapsTheDomainRefusals proves the business codes survive the gRPC mapping
// (§582) instead of collapsing into service_degraded, and that the ownership gates 0042 already
// shipped are reachable through the gateway. Each refusal terminates its stream, so each case
// drives its own spine.
func TestActionPrepareMapsTheDomainRefusals(t *testing.T) {
	t.Run("same key with a different hash is a conflict", func(t *testing.T) {
		r, grantID := startRunForAction(t)
		r.sendAction(t, r.actionBody(grantID, "tool:conflict", 0))
		_, first, _ := recvTypedFrame(t, r.stream, "action_prepared")
		changed := r.actionBody(grantID, "tool:conflict", 0)
		changed["request_hash"] = strings.Repeat("7", 64)
		r.sendAction(t, changed)
		var raw []byte
		err := r.stream.RecvMsg(&raw)
		wantCode(t, err, codes.Aborted)
		if !strings.Contains(err.Error(), "operation_key_conflict") {
			t.Fatalf("error = %v, want the operation_key_conflict code preserved", err)
		}
		if got := r.scalar(t, `SELECT count(*)::text FROM work.local_action WHERE org_id=$1 AND operation_id=$2::uuid`,
			gwOrg, first["operation_id"]); got != "1" {
			t.Fatalf("a conflicting key wrote %s action rows, want still 1", got)
		}
	})
	t.Run("a stale fence is a precondition, not a shape error", func(t *testing.T) {
		r, grantID := startRunForAction(t)
		body := r.actionBody(grantID, "tool:fence", 0)
		body["fence"] = "99"
		r.sendAction(t, body)
		var raw []byte
		err := r.stream.RecvMsg(&raw)
		wantCode(t, err, codes.FailedPrecondition)
		if !strings.Contains(err.Error(), "stale_fence") {
			t.Fatalf("error = %v, want stale_fence", err)
		}
	})
	t.Run("a foreign lease is refused", func(t *testing.T) {
		r, grantID := startRunForAction(t)
		body := r.actionBody(grantID, "tool:lease", 0)
		body["lease_id"] = uuid.NewString()
		r.sendAction(t, body)
		var raw []byte
		err := r.stream.RecvMsg(&raw)
		wantCode(t, err, codes.Unauthenticated)
		if !strings.Contains(err.Error(), "unauthorized") {
			t.Fatalf("error = %v, want unauthorized", err)
		}
		if got := r.scalar(t, `SELECT count(*)::text FROM work.local_action WHERE org_id=$1`, gwOrg); got != "0" {
			t.Fatalf("a foreign lease wrote %s action rows, want 0", got)
		}
	})
	t.Run("a supersede without its assertion is refused", func(t *testing.T) {
		r, grantID := startRunForAction(t)
		body := r.actionBody(grantID, "tool:supersede", 1)
		body["supersedes_operation_id"] = uuid.NewString()
		body["supersede_reason"] = "reauthorized"
		// supersede_assertion stays null: SQL demands all three or none (0042:777-780).
		r.sendAction(t, body)
		var raw []byte
		err := r.stream.RecvMsg(&raw)
		wantCode(t, err, codes.InvalidArgument)
		if !strings.Contains(err.Error(), "invalid_request") {
			t.Fatalf("error = %v, want invalid_request", err)
		}
	})
	t.Run("a less strict classification claim is refused", func(t *testing.T) {
		r, grantID := startRunForAction(t)
		body := r.actionBody(grantID, "tool:floor", 0)
		body["classification"] = "remote_excerpt_allowed"
		r.sendAction(t, body)
		var raw []byte
		err := r.stream.RecvMsg(&raw)
		wantCode(t, err, codes.FailedPrecondition)
		if !strings.Contains(err.Error(), "classification_floor_required") {
			t.Fatalf("error = %v, want classification_floor_required", err)
		}
	})
}
