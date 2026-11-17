package gateway_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

// GW14: the command downlink. 0055 made consume_device_permit MINT the permit after the dispatch
// CAS and added claim_pending_device_commands, so the gateway's job is to sign and deliver, never
// to decide. These tests prove the two signing domains are really independent (a permit signed by
// the frame key must not verify), that the wire document is the stored one modulo the signature,
// and that delivery is deduped per stream but re-driven by the heartbeat once an Approval is decided.

// seedReadonlyGrant adds the readonly_approval_grant that makes prepare_local_operation authorize
// the Operation without an Approval (R11C-1). It is the only path that dispatches inside the same
// round trip, which is what makes the command downlink observable without a second heartbeat.
func (r *runUnderFinish) seedReadonlyGrant(t *testing.T, grantID string) string {
	t.Helper()
	ctx := gwContext(t)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(r.f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = seed.Close(ctx) }()
	readonlyID := uuid.NewString()
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		INSERT INTO work.readonly_approval_grant
			(org_id, id, owner_subject_id, run_id, device_id, workspace_grant_id, grant_revision,
			 tool_set, resource_selector_hash, policy_epoch, access_epoch, expires_at, status)
		VALUES ('%s','%s','%s','%s','%s','%s',1,
			ARRAY['workspace.read'],'%s',1,0, now() + interval '1 hour','active');
	`, gwOrg, gwOrg, readonlyID, gwSubject, r.runID, r.f.deviceID, grantID, strings.Repeat("c", 64))
	if err := testpg.ExecRaw(ctx, seed, script); err != nil {
		t.Fatal(err)
	}
	return readonlyID
}

// heartbeatRenew sends a heartbeat naming the execute lease, so the handler answers one lease
// downlink. That frame is the test's barrier: the renewals are sent BEFORE the offer and command
// pushes, and the stream is handled sequentially, so a second lease proves the first heartbeat's
// claim has already returned. Without it a "nothing was dispatched" read could race the claim.
func (r *runUnderFinish) heartbeatRenew(t *testing.T) {
	t.Helper()
	if err := r.stream.SendMsg(r.f.unsignedFrame(t, "heartbeat", r.sessionID, r.bootID, r.agentID,
		heartbeatBody("1000", []string{r.leaseID}, "0"))); err != nil {
		t.Fatal(err)
	}
	recvTypedFrame(t, r.stream, "lease")
}

// decideApproval decides an ask_each Approval through the real work_api command, exactly as the
// M1b REST face does — including the resume_run it performs, without which the Run stays parked
// and the claim (which only dispatches actions of an ACTIVE Run) would never deliver.
func (r *runUnderFinish) decideApproval(t *testing.T, approvalID, operationID string) {
	t.Helper()
	ctx := gwContext(t)
	api, err := testpg.Open(ctx, testpg.AppURL(r.f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = api.Close(ctx) }()
	if err := testpg.ExecRaw(ctx, api,
		"SET app.org_id = '"+gwOrg+"'; SET app.subject_id = '"+gwSubject+"'"); err != nil {
		t.Fatal(err)
	}
	proof := fmt.Sprintf(`{"v":1,"org_id":"%s","subject_id":"%s","auth_plane":"bearer",
		"auth_epoch":%d,"device_id":"%s","session_id":"%s","approval_id":"%s","operation_id":"%s",
		"params_hash":"%s","expected_revision":0,"decision":"approved","remember_readonly":false,
		"readonly_scope":null,"readonly_expires_at":null,"policy_epoch":%s,"access_epoch":%s,
		"nonce":"%s","expires_at":"%s","signature":"sha256:%s"}`,
		gwOrg, gwSubject, gwEpoch, r.f.deviceID, r.sessionID, approvalID, operationID,
		strings.Repeat("1", 64),
		r.scalar(t, `SELECT effective_epoch::text FROM work.local_execution_policy WHERE org_id=$1`, gwOrg),
		r.scalar(t, `SELECT admission_access_epoch::text FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID),
		"nonce-gw14-"+uuid.NewString(),
		time.Now().UTC().Add(10*time.Minute).Format(time.RFC3339),
		strings.Repeat("5", 64))
	var raw []byte
	if err := api.QueryRow(ctx,
		`SELECT work.decide_local_approval($1,$2,'bearer',$3,$4::uuid,$5,$6::jsonb)`,
		gwOrg, gwSubject, gwEpoch, approvalID, "req-gw14-decide-"+uuid.NewString(), proof,
	).Scan(&raw); err != nil {
		t.Fatalf("decide_local_approval: %v", err)
	}
	var decided map[string]any
	if err := json.Unmarshal(raw, &decided); err != nil {
		t.Fatal(err)
	}
	if decided["decision"] != "approved" {
		t.Fatalf("decision = %#v, want approved", decided)
	}
}

// commandPermit extracts the nested permit document and asserts the closed 28-key set.
func commandPermit(t *testing.T, command map[string]any) (permitJSON []byte, permit map[string]any) {
	t.Helper()
	raw, err := json.Marshal(command["permit"])
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &permit); err != nil {
		t.Fatalf("command permit is not an object: %#v", command["permit"])
	}
	if len(permit) != 28 {
		t.Fatalf("permit = %#v, want the closed 28 keys", permit)
	}
	return raw, permit
}

// TestCommandCarriesAnIndependentlySignedPermit is the GW14 round trip on the readonly path: the
// prepare auto-approves, the claim dispatches after the CAS, and the command arrives in the same
// round trip. The permit verifies under the hello_ack permit key and NOT under the frame key —
// §3.3's independent signing key is a real separation, not a second copy of the same key.
func TestCommandCarriesAnIndependentlySignedPermit(t *testing.T) {
	r, grantID := startRunForAction(t)
	r.seedReadonlyGrant(t, grantID)
	r.sendAction(t, r.actionBody(grantID, "tool:auto", 0))
	_, ack, _ := recvTypedFrame(t, r.stream, "action_prepared")
	if ack["state"] != "authorized" || ack["auto_approved"] != true {
		t.Fatalf("readonly ack = %#v, want authorized/auto_approved", ack)
	}
	opID, _ := ack["operation_id"].(string)
	attemptID, _ := ack["attempt_id"].(string)

	bodyJSON, command, session := recvTypedFrame(t, r.stream, "command")
	if session != r.sessionID {
		t.Fatalf("command session = %v, want %s", session, r.sessionID)
	}
	// §3.1's nine keys plus the ruled server signature.
	if len(command) != 10 {
		t.Fatalf("command body = %#v, want exactly ten keys", command)
	}
	commandID, _ := command["command_id"].(string)
	if commandID == "" {
		t.Fatalf("command carries no command_id: %#v", command)
	}
	if command["run_id"] != r.runID || command["operation_id"] != opID ||
		command["dispatch_attempt_id"] != attemptID || command["logical_key"] != "tool:auto#0" {
		t.Fatalf("command identity = %#v, want the prepared operation %s/%s", command, opID, attemptID)
	}
	if command["request_hash"] != strings.Repeat("1", 64) ||
		command["tool_schema"] != "read-v1" || command["local_payload_ref"] != "local/payload" {
		t.Fatalf("command payload = %#v, want the proposed hash/schema/ref verbatim", command)
	}
	sig, _ := command["signature"].(string)
	if sig == "" || !devicesig.VerifyFrame(r.serverPub, "command", bodyJSON, sig) {
		t.Fatalf("command signature does not verify against the hello_ack frame JWK: %#v", command)
	}
	for _, other := range []string{"permit", "action_prepared", "run_offer", "run_finish_ack"} {
		if devicesig.VerifyFrame(r.serverPub, other, bodyJSON, sig) {
			t.Fatalf("a command signature verified as %s (frame type not bound)", other)
		}
	}

	permitJSON, permit := commandPermit(t, command)
	permitSig, _ := permit["signature"].(string)
	if permitSig == "" || !devicesig.VerifyFrame(r.permitPub, "permit", permitJSON, permitSig) {
		t.Fatalf("permit signature does not verify against the hello_ack permit JWK: %#v", permit)
	}
	// The independence that matters: the frame key must NOT verify the permit, and the permit
	// key must NOT verify the frame. One key for both would collapse §3.3's separation.
	if devicesig.VerifyFrame(r.serverPub, "permit", permitJSON, permitSig) {
		t.Fatal("the permit verified under the FRAME key: the two signing keys are not independent")
	}
	if devicesig.VerifyFrame(r.permitPub, "command", bodyJSON, sig) {
		t.Fatal("the command verified under the PERMIT key: the two signing domains are not separated")
	}
	for _, other := range []string{"command", "action_prepared", "receipt"} {
		if devicesig.VerifyFrame(r.permitPub, other, permitJSON, permitSig) {
			t.Fatalf("a permit signature verified as %s (frame type not bound)", other)
		}
	}
	// The placeholder is gone: SQL cannot make ES256, so the stored sha256 form must never ship.
	if strings.HasPrefix(permitSig, "sha256:") || len(permitSig) != 86 {
		t.Fatalf("wire permit signature = %q, want the 86-character ES256 form", permitSig)
	}
	if permit["kid"] != r.permitPub.Thumbprint {
		t.Fatalf("permit kid = %v, want the permit key thumbprint %s", permit["kid"], r.permitPub.Thumbprint)
	}
	if permit["v"] != float64(2) || permit["aud"] != "device-tool" {
		t.Fatalf("permit v/aud = %#v, want 2 and the tool audience", permit)
	}

	// Every identity field is a server fact, cross-checked against the rows rather than the ack.
	for _, field := range []struct{ key, sql string }{
		{"org_id", `SELECT org_id FROM work.device_dispatch WHERE org_id=$1 AND command_id=$2::uuid`},
		{"device_id", `SELECT device_id::text FROM work.device_dispatch WHERE org_id=$1 AND command_id=$2::uuid`},
		{"session_id", `SELECT session_id::text FROM work.device_dispatch WHERE org_id=$1 AND command_id=$2::uuid`},
		{"run_id", `SELECT run_id::text FROM work.operation WHERE org_id=$1 AND id=$2::uuid`},
		{"operation_id", `SELECT id::text FROM work.operation WHERE org_id=$1 AND id=$2::uuid`},
		{"dispatch_attempt_id", `SELECT attempt_id::text FROM work.device_dispatch WHERE org_id=$1 AND command_id=$2::uuid`},
		{"request_hash", `SELECT request_hash FROM work.device_dispatch WHERE org_id=$1 AND command_id=$2::uuid`},
		{"jti", `SELECT permit_jti::text FROM work.device_dispatch WHERE org_id=$1 AND command_id=$2::uuid`},
		{"boot_id", `SELECT boot_id FROM work.device_session WHERE org_id=$1 AND id=$2::uuid`},
		{"agent_instance_id", `SELECT agent_instance_id::text FROM work.device_session WHERE org_id=$1 AND id=$2::uuid`},
		{"generation", `SELECT generation::text FROM work.device_session WHERE org_id=$1 AND id=$2::uuid`},
		{"subject_id", `SELECT owner_subject_id FROM work.task WHERE org_id=$1 AND id=(SELECT task_id FROM work.run WHERE org_id=$1 AND id=$2::uuid)`},
	} {
		args := []any{gwOrg, commandID}
		if field.key == "run_id" || field.key == "operation_id" {
			args = []any{gwOrg, opID}
		}
		if field.key == "boot_id" || field.key == "agent_instance_id" || field.key == "generation" {
			args = []any{gwOrg, r.sessionID}
		}
		if field.key == "subject_id" {
			args = []any{gwOrg, r.runID}
		}
		if want := r.scalar(t, field.sql, args...); permit[field.key] != want {
			t.Fatalf("permit %s = %v, want the server fact %s", field.key, permit[field.key], want)
		}
	}
	if permit["fence"] != r.fence {
		t.Fatalf("permit fence = %v, want the run/lease fence %s", permit["fence"], r.fence)
	}
	for _, key := range []string{"fence", "generation", "policy_epoch", "access_epoch",
		"grant_revision", "max_bytes"} {
		if _, ok := permit[key].(string); !ok {
			t.Fatalf("permit %s = %#v, want a decimal string (§3.1 uint64 boundary)", key, permit[key])
		}
	}
	// The readonly path has no Approval, so both keys are present and null — omitting them
	// would change the JCS preimage and the device could never verify a readonly permit.
	if permit["approval_id"] != nil || permit["decision_revision"] != nil {
		t.Fatalf("a readonly permit carries an Approval identity: %#v", permit)
	}
	if value, present := permit["destination_id"]; !present || value != nil {
		t.Fatalf("permit destination_id = %#v (present=%v), want an explicit null", value, present)
	}

	// §3.3: TTL at most 5s and never beyond the remaining lease.
	issued, err := time.Parse(time.RFC3339, permit["issued_at"].(string))
	if err != nil {
		t.Fatalf("permit issued_at = %v, want RFC3339: %v", permit["issued_at"], err)
	}
	expires, err := time.Parse(time.RFC3339, permit["expires_at"].(string))
	if err != nil {
		t.Fatalf("permit expires_at = %v, want RFC3339: %v", permit["expires_at"], err)
	}
	if ttl := expires.Sub(issued); ttl <= 0 || ttl > 5*time.Second {
		t.Fatalf("permit TTL = %v, want (0, 5s]", ttl)
	}
	leaseExpiry := r.scalar(t, `SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		FROM work.execution_lease WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.leaseID)
	leaseEnd, err := time.Parse(time.RFC3339, leaseExpiry)
	if err != nil {
		t.Fatal(err)
	}
	if expires.After(leaseEnd) {
		t.Fatalf("permit expires %v after the lease %v", expires, leaseEnd)
	}

	// The wire document IS the stored evidence, modulo the signature the gateway replaced.
	stored := r.scalar(t, `SELECT permit::text FROM work.device_dispatch WHERE org_id=$1 AND command_id=$2::uuid`, gwOrg, commandID)
	var storedMap, wireMap map[string]any
	if err := json.Unmarshal([]byte(stored), &storedMap); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(permitJSON, &wireMap); err != nil {
		t.Fatal(err)
	}
	storedSignature, _ := storedMap["signature"].(string)
	delete(storedMap, "signature")
	delete(wireMap, "signature")
	storedJSON, _ := json.Marshal(storedMap)
	wireJSON, _ := json.Marshal(wireMap)
	if string(storedJSON) != string(wireJSON) {
		t.Fatalf("the gateway rewrote the permit:\n stored %s\n wire   %s", storedJSON, wireJSON)
	}
	if !strings.HasPrefix(storedSignature, "sha256:") {
		t.Fatalf("stored signature = %q, want SQL's internal placeholder", storedSignature)
	}

	// The terminal write set is the claim's, read back independently of the frame.
	if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND id=$2::uuid`, gwOrg, opID); got != "dispatching" {
		t.Fatalf("Operation state = %q, want dispatching (the CAS was spent)", got)
	}
	if got := r.scalar(t, `SELECT delivery_state FROM work.device_dispatch WHERE org_id=$1 AND command_id=$2::uuid`, gwOrg, commandID); got != "not_applicable" {
		t.Fatalf("delivery_state = %q, want not_applicable (§3.1 has no command_ack)", got)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.device_dispatch WHERE org_id=$1`, gwOrg); got != "1" {
		t.Fatalf("dispatch rows = %s, want exactly 1", got)
	}
}

// TestCommandIsNotRedeliveredOnTheSameStream proves the per-stream dedup: the claim returns every
// live dispatch until its permit expires, so without the cache each 10s heartbeat would re-deliver
// an instruction the device may already be executing. A second heartbeat and a second prepare are
// the barriers — frames are ordered, so a re-delivered command would arrive before the next
// action_prepared and fail the typed read.
func TestCommandIsNotRedeliveredOnTheSameStream(t *testing.T) {
	r, grantID := startRunForAction(t)
	r.seedReadonlyGrant(t, grantID)
	r.sendAction(t, r.actionBody(grantID, "tool:first", 0))
	recvTypedFrame(t, r.stream, "action_prepared")
	_, first, _ := recvTypedFrame(t, r.stream, "command")
	firstID, _ := first["command_id"].(string)

	// A heartbeat renewing the same lease: one lease downlink, no second command.
	r.heartbeatRenew(t)
	r.heartbeatRenew(t)

	r.sendAction(t, r.actionBody(grantID, "tool:second", 0))
	_, ack, _ := recvTypedFrame(t, r.stream, "action_prepared")
	if ack["logical_key"] != "tool:second#0" {
		t.Fatalf("a re-delivered command preceded the second action_prepared: %#v", ack)
	}
	_, second, _ := recvTypedFrame(t, r.stream, "command")
	secondID, _ := second["command_id"].(string)
	if secondID == "" || secondID == firstID {
		t.Fatalf("second command = %#v, want a new command distinct from %s", second, firstID)
	}
	if got := r.scalar(t, `SELECT count(*)::text FROM work.device_dispatch WHERE org_id=$1`, gwOrg); got != "2" {
		t.Fatalf("dispatch rows = %s, want 2 (one per action, none re-minted)", got)
	}
	// The first permit keeps its jti: a re-push must never mint a second one (§3.3).
	if got := r.scalar(t, `SELECT permit_jti::text FROM work.device_dispatch WHERE org_id=$1 AND command_id=$2::uuid`, gwOrg, firstID); got != first["permit"].(map[string]any)["jti"] {
		t.Fatalf("the first dispatch jti changed: %s vs %v", got, first["permit"].(map[string]any)["jti"])
	}
}

// TestAskEachCommandWaitsForTheApprovalAndArrivesOnTheNextHeartbeat proves the heartbeat-driven
// claim: an ask_each action parks the Run, so nothing is dispatchable and no command is delivered;
// once the user decides the Approval through the M1b REST command (which also resumes the Run),
// the NEXT heartbeat dispatches and delivers it. There is no worker→gateway signal, so this
// cadence is the only way the gateway can learn of the decision (GW11's offer-push precedent).
func TestAskEachCommandWaitsForTheApprovalAndArrivesOnTheNextHeartbeat(t *testing.T) {
	r, grantID := startRunForAction(t)
	r.sendAction(t, r.actionBody(grantID, "tool:ask", 0))
	_, ack, _ := recvTypedFrame(t, r.stream, "action_prepared")
	if ack["state"] != "waiting_approval" {
		t.Fatalf("ask_each ack = %#v, want waiting_approval", ack)
	}
	opID, _ := ack["operation_id"].(string)
	approvalID, _ := ack["approval_id"].(string)
	if approvalID == "" {
		t.Fatalf("ask_each produced no Approval: %#v", ack)
	}

	// Two heartbeats: the second lease proves the first handler's claim already returned, so the
	// zero-dispatch read below cannot race it.
	r.heartbeatRenew(t)
	r.heartbeatRenew(t)
	if got := r.scalar(t, `SELECT count(*)::text FROM work.device_dispatch WHERE org_id=$1`, gwOrg); got != "0" {
		t.Fatalf("an approval-waiting action dispatched %s rows, want 0", got)
	}
	if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND id=$2::uuid`, gwOrg, opID); got != "waiting_approval" {
		t.Fatalf("Operation state = %q, want the untouched waiting_approval", got)
	}

	r.decideApproval(t, approvalID, opID)
	if got := r.scalar(t, `SELECT state FROM work.run WHERE org_id=$1 AND id=$2::uuid`, gwOrg, r.runID); got != "active" {
		t.Fatalf("Run state after the decision = %q, want active (decide_local_approval resumes it)", got)
	}
	r.heartbeatRenew(t)
	_, command, _ := recvTypedFrame(t, r.stream, "command")
	if command["operation_id"] != opID {
		t.Fatalf("command = %#v, want the decided operation %s", command, opID)
	}
	permitJSON, permit := commandPermit(t, command)
	permitSig, _ := permit["signature"].(string)
	if !devicesig.VerifyFrame(r.permitPub, "permit", permitJSON, permitSig) {
		t.Fatalf("the decided action's permit does not verify: %#v", permit)
	}
	// An approved action carries its Approval identity, unlike the readonly path.
	if permit["approval_id"] != approvalID {
		t.Fatalf("permit approval_id = %v, want %s", permit["approval_id"], approvalID)
	}
	if revision, ok := permit["decision_revision"].(string); !ok || revision == "" || revision == "0" {
		t.Fatalf("permit decision_revision = %#v, want the decided revision as a decimal string", permit["decision_revision"])
	}
	if got := r.scalar(t, `SELECT state FROM work.operation WHERE org_id=$1 AND id=$2::uuid`, gwOrg, opID); got != "dispatching" {
		t.Fatalf("Operation state = %q, want dispatching", got)
	}
}
