package migrate

import (
	"testing"
)

// GW14: the heartbeat-driven command claim. No worker -> gateway signal exists, so an
// ask_each action that the user approved through the M1b REST face is discovered here.
// The claim is a combined claim (0049 precedent): it dispatches what is authorized and
// returns every live dispatch of THIS device and session, with the stored permit document.

func (a *actionFixture) claimCommands(t *testing.T, deviceID, sessionID string) []any {
	t.Helper()
	out := callJSON(t, a.workerConn(t),
		`SELECT work.claim_pending_device_commands($1,$2::uuid,$3::uuid,$4)`,
		a.org, deviceID, sessionID, permitTestKid)
	commands, _ := out["commands"].([]any)
	return commands
}

// TestR0bCommandClaimDispatchesAuthorizedActionsAndReplaysTheSameCommand pins the whole
// dispatch half of the action spine: nothing is dispatched while the approval is pending,
// authorizing it makes the next claim mint and return exactly one command, and a second
// claim returns the SAME command and jti rather than minting a second permit (§3.3).
func TestR0bCommandClaimDispatchesAuthorizedActionsAndReplaysTheSameCommand(t *testing.T) {
	a := newActionFixture(t, "org_gw14_claim")
	worker := a.workerConn(t)
	out := a.prepare(t, worker, "tool:1", a.grantClass)
	opID := idOf(t, out, "operation_id")
	attemptID := idOf(t, out, "attempt_id")

	// ask_each parks the Operation on its Approval, so there is nothing to dispatch.
	if got := a.claimCommands(t, a.deviceID, a.sessionID); len(got) != 0 {
		t.Fatalf("claim before approval = %#v, want no command", got)
	}
	a.authorizeAction(t, opID)

	commands := a.claimCommands(t, a.deviceID, a.sessionID)
	if len(commands) != 1 {
		t.Fatalf("claim after approval = %#v, want exactly one command", commands)
	}
	command, _ := commands[0].(map[string]any)
	// The closed command body (§3.1 plus the ruled server signature, which the gateway adds).
	for _, key := range []string{"command_id", "run_id", "operation_id", "logical_key",
		"dispatch_attempt_id", "request_hash", "tool_schema", "local_payload_ref", "permit"} {
		if command[key] == nil || command[key] == "" {
			t.Fatalf("command is missing %s: %#v", key, command)
		}
	}
	if len(command) != 9 {
		t.Fatalf("command body = %#v, want the nine getter keys", command)
	}
	if command["operation_id"] != opID || command["dispatch_attempt_id"] != attemptID {
		t.Fatalf("command identity = %#v, want the prepared operation/attempt", command)
	}
	if command["run_id"] != a.runID || command["logical_key"] != "tool:1#0" {
		t.Fatalf("command run/logical_key = %#v", command)
	}
	if command["tool_schema"] != "read-v1" || command["local_payload_ref"] != "local/payload" {
		t.Fatalf("command must carry the device's own previewed schema/ref: %#v", command)
	}
	permit, _ := command["permit"].(map[string]any)
	if len(permit) != 28 || permit["kid"] != permitTestKid {
		t.Fatalf("command permit = %#v, want the closed 28 keys with the supplied kid", permit)
	}
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE org_id = "+
		quoteLiteral(a.org)+" AND id = "+quoteLiteral(opID)); got != "dispatching" {
		t.Fatalf("Operation state = %q, want dispatching (the CAS is spent)", got)
	}
	// delivery_state is deliberately untouched: only not_applicable -> superseded is
	// registered, and §3.1 has no command_ack frame.
	if got := a.scalar(t, "SELECT delivery_state FROM work.device_dispatch WHERE org_id = "+
		quoteLiteral(a.org)+" AND operation_id = "+quoteLiteral(opID)); got != "not_applicable" {
		t.Fatalf("delivery_state = %q, want not_applicable", got)
	}

	again := a.claimCommands(t, a.deviceID, a.sessionID)
	if len(again) != 1 {
		t.Fatalf("second claim = %#v, want the same single command", again)
	}
	replayed, _ := again[0].(map[string]any)
	if replayed["command_id"] != command["command_id"] {
		t.Fatalf("second claim minted a new command: %v vs %v",
			replayed["command_id"], command["command_id"])
	}
	replayedPermit, _ := replayed["permit"].(map[string]any)
	if replayedPermit["jti"] != permit["jti"] {
		t.Fatalf("second claim minted a second jti: %v vs %v", replayedPermit["jti"], permit["jti"])
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_dispatch WHERE org_id = "+
		quoteLiteral(a.org)); got != 1 {
		t.Fatalf("dispatch rows after two claims = %d, want 1", got)
	}
}

// TestR0bCommandClaimIsBoundToTheCallingDeviceAndSession proves the claim carries the same
// ownership gates as the rest of the device plane: a foreign session is refused before any
// candidate is dispatched, so one device cannot mint permits against another's actions.
func TestR0bCommandClaimIsBoundToTheCallingDeviceAndSession(t *testing.T) {
	a := newActionFixture(t, "org_gw14_claim_bound")
	worker := a.workerConn(t)
	out := a.prepare(t, worker, "tool:1", a.grantClass)
	a.authorizeAction(t, idOf(t, out, "operation_id"))

	expectCode(t, worker, "unauthorized",
		`SELECT work.claim_pending_device_commands($1,$2::uuid,$3::uuid,$4)`,
		a.org, a.deviceID, newUUID(t), permitTestKid)
	expectCode(t, worker, "unauthorized",
		`SELECT work.claim_pending_device_commands($1,$2::uuid,$3::uuid,$4)`,
		a.org, newUUID(t), a.sessionID, permitTestKid)
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_dispatch WHERE org_id = "+
		quoteLiteral(a.org)); got != 0 {
		t.Fatalf("a refused claim dispatched %d rows, want 0", got)
	}
	// An empty kid is a shape refusal, not a minted permit with no key identity.
	expectCode(t, worker, "invalid_request",
		`SELECT work.claim_pending_device_commands($1,$2::uuid,$3::uuid,$4)`,
		a.org, a.deviceID, a.sessionID, "")
}

// TestR0bCommandClaimSkipsARunWithAnUnreconciledOperation is invariant 3 at the dispatch
// entry point: the claim must not mint a permit while another action of the Run is unknown,
// and the skipped action stays authorized rather than being half-dispatched.
func TestR0bCommandClaimSkipsARunWithAnUnreconciledOperation(t *testing.T) {
	a := newActionFixture(t, "org_gw14_claim_unknown")
	worker := a.workerConn(t)
	out := a.prepare(t, worker, "tool:1", a.grantClass)
	opID := idOf(t, out, "operation_id")
	a.authorizeAction(t, opID)
	// The fixture's seeded Operation is the Run's other action; move it to unknown the way
	// a lost dispatch confirmation does.
	mustExec(t, a.admin, "UPDATE work.operation SET state = 'unknown' WHERE org_id = "+
		quoteLiteral(a.org)+" AND run_id = "+quoteLiteral(a.runID)+" AND id <> "+quoteLiteral(opID))

	if got := a.claimCommands(t, a.deviceID, a.sessionID); len(got) != 0 {
		t.Fatalf("claim under an unreconciled unknown = %#v, want no command", got)
	}
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE org_id = "+
		quoteLiteral(a.org)+" AND id = "+quoteLiteral(opID)); got != "authorized" {
		t.Fatalf("skipped Operation state = %q, want authorized (no half dispatch)", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_dispatch WHERE org_id = "+
		quoteLiteral(a.org)); got != 0 {
		t.Fatalf("dispatch rows = %d, want 0", got)
	}
	// consume itself still refuses, so the claim's filter is not the only enforcement.
	a.refuseConsume(t, worker, opID, idOf(t, out, "attempt_id"), "run_has_unreconciled_operation")
}

// TestR0bMintedPermitCarriesNullApprovalOnTheReadonlyPath proves the readonly auto-approve
// branch produces a permit the device can actually deserialize: approval_id and
// decision_revision are null (there is no Approval row), and the keys are still present
// because the closed set counts 28.
func TestR0bMintedPermitCarriesNullApprovalOnTheReadonlyPath(t *testing.T) {
	a := newActionFixture(t, "org_gw14_readonly")
	worker := a.workerConn(t)
	mustExec(t, a.admin, `INSERT INTO work.readonly_approval_grant
		(org_id, id, owner_subject_id, run_id, device_id, workspace_grant_id, grant_revision,
		 tool_set, resource_selector_hash, policy_epoch, access_epoch, expires_at, status)
		VALUES (`+quoteLiteral(a.org)+`, `+quoteLiteral(newUUID(t))+`, `+quoteLiteral(a.subject)+`, `+
		quoteLiteral(a.runID)+`, `+quoteLiteral(a.deviceID)+`, `+quoteLiteral(a.grantID)+`, 1,
		 ARRAY['workspace.read'], `+quoteLiteral(a.selectorHash)+`, 1, 0,
		 now() + interval '1 hour', 'active')`)
	out := a.prepare(t, worker, "tool:auto", a.grantClass)
	if out["auto_approved"] != true {
		t.Fatalf("readonly hit did not auto-approve: %#v", out)
	}
	got := a.consumePermit(t, worker, idOf(t, out, "operation_id"), idOf(t, out, "attempt_id"))
	permit, _ := got["permit"].(map[string]any)
	if len(permit) != 28 {
		t.Fatalf("minted permit = %#v, want 28 keys", permit)
	}
	if permit["approval_id"] != nil || permit["decision_revision"] != nil {
		t.Fatalf("an auto-approved permit must carry null approval fields: %#v", permit)
	}
	if permit["aud"] != "device-tool" {
		t.Fatalf("readonly permit aud = %#v, want device-tool", permit["aud"])
	}
	if scope, _ := permit["scope_hash"].(string); len(scope) != 64 {
		t.Fatalf("readonly permit scope_hash = %#v, want the recomputed 64 hex", permit["scope_hash"])
	}
}
