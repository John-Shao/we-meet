package migrate

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Tests for increment 0021: operation_resolution, the two evidence-limited
// degradations, and the adoption block J38 adds.
//
// These cover EV113's and EV120's control-plane halves: the settlement vocabulary may
// not be written into the Operation row, a degradation lands on the registered
// unknown -> reconciled edge, the reservation stays unknown, and an
// evidence_exhausted verdict blocks adoption while a read-only degradation does not.

// localUnknownOperation builds the smallest server fact set a local Run degradation
// needs: an Operation on a step key, stuck in unknown, on a Run waiting for
// reconcile. Every step uses a registered transition, so the fixture itself proves the
// states are reachable.
func localUnknownOperation(t *testing.T, dbName, org string, admin *pgx.Conn) (string, string) {
	t.Helper()
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)
	r0bExec(t, dbName, org, fmt.Sprintf(`
		UPDATE work.operation
		SET step_key = 'tool:1', supersede_no = 0, logical_key = 'tool:1#0',
		    kind = 'tool', state = 'dispatching'
		WHERE id = '%s';
		UPDATE work.operation SET state = 'unknown' WHERE id = '%s';
		UPDATE work.run SET state = 'waiting', wait_reason = 'reconcile' WHERE id = '%s';
	`, run.opID, run.opID, run.runID))
	return run.runID, run.opID
}

// issueResolutionSigned issues one verdict with the signature the caller supplies,
// and returns the error rather than failing: replay and conflict cases are the point
// of several tests below, and a signature is opaque to the database, so "the same
// conclusion, signed twice" has to be constructible deliberately.
func issueResolutionSigned(t *testing.T, admin *pgx.Conn, org, operationID, state string, code any,
	ticket any, signature string, evidence map[string]any) (map[string]any, error) {
	t.Helper()
	if evidence == nil {
		evidence = map[string]any{}
	}
	body, err := json.Marshal(evidence)
	if err != nil {
		t.Fatal(err)
	}
	if signature == "" {
		signature = "sha256:" + repeatHex(t, 64)
	}
	var raw []byte
	if err := admin.QueryRow(testContext(t),
		`SELECT work.issue_operation_resolution($1, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb)`,
		org, operationID, state, code, ticket, signature, "sub_operator", string(body)).Scan(&raw); err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out, nil
}

func issueResolution(t *testing.T, admin *pgx.Conn, org, operationID, state string, code any,
	ticket any, evidence map[string]any) map[string]any {
	t.Helper()
	out, err := issueResolutionSigned(t, admin, org, operationID, state, code, ticket, "", evidence)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// i4Facts attests the one §4.2 precondition the server still cannot read: the journal
// lives in the device's SQLite (device design §6.1), so "原设备 journal 明确不可得" stays
// a named attestation. 0042 (O-10 = jia) replaced the other two keys with table reads,
// so attesting them here would be asserting something the function no longer looks at.
func i4Facts(values map[string]any) map[string]any {
	if values == nil {
		values = map[string]any{}
	}
	values["journal_unavailable"] = "true"
	return values
}

// degradationServerFacts creates what the restated issue_operation_resolution reads:
// an expired lease for this Run, so "其 execution_lease 已过期或设备已撤权" holds, and a
// revoked device whose only session is expired, so "设备不可达" holds. No
// device_run_binding is created - the session read is a NOT EXISTS over the Run's
// bindings, and the lease half of the revocation read needs no binding either.
func degradationServerFacts(t *testing.T, dbName, org, runID string) {
	t.Helper()
	deviceID := newUUID(t)
	sessionID := newUUID(t)
	leaseID := newUUID(t)
	instanceID := newUUID(t)
	epoch := newUUID(t)
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.device
		  (org_id, id, owner_subject_id, device_name, platform, public_key_jwk,
		   public_key_thumbprint, auth_plane, auth_epoch, status, revoked_at)
		VALUES ('%s', '%s', 'sub_%s', 'fixture desk', 'windows-x64',
		        '{"crv":"P-256","kty":"EC","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}'::jsonb,
		        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		        'bearer', 0, 'revoked', now());
		INSERT INTO work.device_session
		  (org_id, id, device_id, owner_subject_id, boot_id, agent_instance_id,
		   auth_plane, auth_epoch, protocol_major, protocol_minor, runtime_digest,
		   journal_epoch, generation, expires_at, state)
		VALUES ('%s', '%s', '%s', 'sub_%s', 'boot-degraded', '%s', 'bearer', 0, 1, 0,
		        '%s', '%s', 1, now() + interval '1 hour', 'expired');
		INSERT INTO work.execution_lease
		  (org_id, id, run_id, device_id, session_id, binding_revision, fence,
		   generation, purpose, start_nonce, expires_at, state)
		VALUES ('%s', '%s', '%s', '%s', '%s', 1, 1, 1, 'reconcile_finish', NULL,
		        now() + interval '1 hour', 'expired');
	`, org, deviceID, org, org, sessionID, deviceID, org, instanceID,
		strings.Repeat("d", 64), epoch, org, leaseID, runID, deviceID, sessionID))
}

func TestR0bReadonlyDegradationReconcilesAndKeepsTheReservation(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_resolution_ro"
	runID, opID := localUnknownOperation(t, dbName, org, admin)
	degradationServerFacts(t, dbName, org, runID)

	// An unattested read-only verdict is refused: §4.2's preconditions (3) and (4) are
	// server facts whose tables arrive with I4, and "the caller did not mention them"
	// is not the same as "they were checked and hold".
	if _, err := issueResolutionSigned(t, admin, org, opID, "failed", "evidence_unavailable",
		nil, "", map[string]any{"lease_or_revocation_checked": "true"}); err == nil {
		t.Fatal("a read-only degradation without journal attestation was accepted")
	} else {
		assertPgMessage(t, err, "resolution_preconditions_unattested")
	}

	result := issueResolution(t, admin, org, opID, "failed", "evidence_unavailable", nil,
		i4Facts(map[string]any{"checked": "no receipt, no provider request id, no gate fact"}))
	if result["operation_state"] != "reconciled" {
		t.Fatalf("operation state after degradation = %v", result["operation_state"])
	}
	if result["settlement_state"] != "unknown" {
		t.Fatalf("settlement state = %v, want unknown", result["settlement_state"])
	}
	if result["delivery_state"] != "not_applicable" {
		t.Fatalf("delivery state = %v, want not_applicable (no dispatch was ever made)",
			result["delivery_state"])
	}

	// unknown -> reconciled is the registered edge; writing the settlement word
	// 'failed' into the Operation row would have been refused by the whitelist.
	if got := scalarString(t, admin,
		`SELECT state FROM work.operation WHERE id = $1`, opID); got != "reconciled" {
		t.Fatalf("operation.state = %q, want reconciled", got)
	}
	// The reservation is neither released nor settled: no evidence is not proof of
	// non-execution (invariant 2).
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.quota_reservation
		WHERE org_id = $1 AND operation_id = $2 AND state = 'held'`, org, opID); got != 0 {
		t.Fatalf("held reservations = %d, want none created by this path", got)
	}
	if got := scalarString(t, admin,
		`SELECT settlement_state FROM work.operation_resolution WHERE operation_id = $1`, opID); got != "unknown" {
		t.Fatalf("resolution settlement_state = %q", got)
	}

	// The Run stops waiting for reconcile, and the wait reason is rewritten to input
	// rather than cleared; control_revision rises and fence does not.
	run := scalarString(t, admin, `SELECT state || '/' || COALESCE(wait_reason, 'null')
		FROM work.run WHERE id = $1`, runID)
	if run != "waiting/input" {
		t.Fatalf("run state/wait_reason = %q, want waiting/input", run)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.task_event
		WHERE org_id = $1 AND payload ->> 'operation_id' = $2
		  AND type = 'operation.reconciled'`, org, opID); got != 1 {
		t.Fatalf("reconcile task events = %d, want 1", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND target_id = $2 AND action = 'operation.resolution_issued'
		  AND metadata ->> 'code' = 'evidence_unavailable'`, org, opID); got != 1 {
		t.Fatalf("resolution audit rows = %d, want 1", got)
	}
	// A read-only degradation must not block adoption (§4.2: the block is the
	// side-effect path only).
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		INSERT INTO work.acceptance (org_id, task_id, actor_subject_id, task_revision, completion_reason)
		SELECT '%s', r.task_id, 'sub_operator', 1, 'accepted as-is'
		FROM work.run r WHERE r.id = '%s'`, org, runID)); err != nil {
		t.Fatalf("a read-only degradation blocked adoption: %v", err)
	}
}

func TestR0bExhaustedDegradationRequiresTicketAndBlocksAdoption(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_resolution_exhausted"
	runID, opID := localUnknownOperation(t, dbName, org, admin)

	// No ticket: the request itself is malformed, and an unattested exhausted verdict
	// is refused rather than accepted on the operator's word.
	if _, err := admin.Exec(testContext(t),
		`SELECT work.issue_operation_resolution($1, $2::uuid, 'failed', 'evidence_exhausted',
		  '', $3, 'sub_operator', '{}'::jsonb)`,
		org, opID, "sha256:"+repeatHex(t, 64)); err == nil {
		t.Fatal("an evidence_exhausted verdict without a ticket was accepted")
	} else {
		assertPgMessage(t, err, "invalid_request:ticket_id")
	}
	if _, err := admin.Exec(testContext(t),
		`SELECT work.issue_operation_resolution($1, $2::uuid, 'failed', 'evidence_exhausted',
		  'TICKET-42', $3, 'sub_operator', '{"device_unreachable": "true"}'::jsonb)`,
		org, opID, "sha256:"+repeatHex(t, 64)); err == nil {
		t.Fatal("an evidence_exhausted verdict was accepted without the server facts")
	}

	// 0042 (O-10 = jia): the refusal above is now the server's own read - no expired
	// lease and no revoked device for this Run - rather than a missing attestation.
	// Creating the facts is what makes the verdict issuable.
	degradationServerFacts(t, dbName, org, runID)
	issueResolution(t, admin, org, opID, "failed", "evidence_exhausted", "TICKET-42",
		map[string]any{
			"device_unreachable":          "true",
			"lease_or_revocation_checked": "true",
			"seal_checked":                "true",
		})
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.operation_resolution
		WHERE org_id = $1 AND operation_id = $2 AND code = 'evidence_exhausted'
		  AND ticket_id = 'TICKET-42'`, org, opID); got != 1 {
		t.Fatalf("exhausted verdicts = %d, want 1", got)
	}

	// Adoption is blocked, and the block is the half of J38 that stops reconciled
	// being read as "this action succeeded".
	_, err := admin.Exec(testContext(t), fmt.Sprintf(`
		INSERT INTO work.acceptance (org_id, task_id, actor_subject_id, task_revision, completion_reason)
		SELECT '%s', r.task_id, 'sub_operator', 1, 'accepted as-is'
		FROM work.run r WHERE r.id = '%s'`, org, runID))
	assertPgMessage(t, err, "acceptance_blocked_unresolvable")

	// A new Run is still allowed: the cost J38 accepted is a blocked Task, not a dead
	// organization. R0a's one-open-run-per-task rule still applies, so the blocked
	// attempt is finished first - the point is that nothing about the verdict itself
	// adds an admission block.
	r0bExec(t, dbName, org, fmt.Sprintf(`
		UPDATE work.run SET state = 'cancel_requested' WHERE id = '%s';
		UPDATE work.run SET state = 'canceled' WHERE id = '%s';
	`, runID, runID))
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		SELECT '%s', r.org_id, r.task_id, 2, 'queued', r.snapshot_id, 'run:after-exhausted', 'pi-1'
		FROM work.run r WHERE r.id = '%s'`, newUUID(t), runID)); err != nil {
		t.Fatalf("a new Run was refused after an exhausted verdict: %v", err)
	}
	// and the Task stays un-adoptable even after that new Run exists
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		INSERT INTO work.acceptance (org_id, task_id, actor_subject_id, task_revision, completion_reason)
		SELECT '%s', r.task_id, 'sub_operator', 2, 'accepted as-is'
		FROM work.run r WHERE r.id = '%s'`, org, runID)); err == nil {
		t.Fatal("a task with an exhausted verdict was adopted")
	}
}

func TestR0bResolutionIsIssuedOnceAndNeverRewritten(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_resolution_once"
	runID, opID := localUnknownOperation(t, dbName, org, admin)
	degradationServerFacts(t, dbName, org, runID)

	// A retry with the same signature is the ordinary at-least-once delivery and
	// returns the conclusion already issued.
	signature := "sha256:" + repeatHex(t, 64)
	first, err := issueResolutionSigned(t, admin, org, opID, "failed", "evidence_unavailable",
		nil, signature, i4Facts(nil))
	if err != nil {
		t.Fatal(err)
	}
	replay, err := issueResolutionSigned(t, admin, org, opID, "failed", "evidence_unavailable",
		nil, signature, i4Facts(nil))
	if err != nil {
		t.Fatalf("replaying the issued verdict failed: %v", err)
	}
	if replay["replayed"] != true || replay["resolve_id"] != first["resolve_id"] {
		t.Fatalf("replay did not return the issued conclusion: %v", replay)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.operation_resolution WHERE operation_id = $1`, opID); got != 1 {
		t.Fatalf("resolution rows after a replay = %d, want 1", got)
	}

	// The same conclusion presented under a different signature is two claims about one
	// verdict, not a retry. repeatHex is deliberately deterministic, so the second
	// signature has to differ by construction rather than by calling it again.
	if _, err := issueResolutionSigned(t, admin, org, opID, "failed", "evidence_unavailable",
		nil, "sha256:"+strings.Repeat("f", 64), i4Facts(nil)); err == nil {
		t.Fatal("a second signature on an already issued conclusion was accepted")
	} else {
		assertPgMessage(t, err, "idempotency_conflict")
	}

	// Late evidence cannot flip an issued verdict: a different conclusion is refused
	// rather than written as a second revision.
	if _, err := admin.Exec(testContext(t),
		`SELECT work.issue_operation_resolution($1, $2::uuid, 'succeeded', NULL,
		  NULL, $3, 'sub_operator', '{}'::jsonb)`,
		org, opID, "sha256:"+repeatHex(t, 64)); err == nil {
		t.Fatal("a later conclusion replaced the issued one")
	}

	// One downgrade per Operation is a constraint, not a consequence of the state gate:
	// writing around the command is refused too. §4.1's monotonic revision belongs to
	// settlement verdicts, which may append when the terminal state really changes.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		INSERT INTO work.operation_resolution
		  (org_id, run_id, operation_id, resolution_revision, state, delivery_state,
		   code, settlement_state, signature)
		SELECT '%s', o.run_id, '%s', 2, 'failed', 'not_applicable',
		       'evidence_exhausted', 'unknown', 'sha256:%s'
		FROM work.operation o WHERE o.id = '%s'`, org, opID, repeatHex(t, 64), opID)); err == nil {
		t.Fatal("a second degradation was written around the issuing command")
	}

	// The watermark may move forward and never backwards, and the conclusion itself is
	// untouchable.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		UPDATE work.operation_resolution SET resolution_delivery = 'delivered'
		WHERE operation_id = '%s'`, opID)); err != nil {
		t.Fatalf("pending -> delivered refused: %v", err)
	}
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		UPDATE work.operation_resolution SET resolution_delivery = 'pending'
		WHERE operation_id = '%s'`, opID)); err == nil {
		t.Fatal("a watermark moved backwards")
	}
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		UPDATE work.operation_resolution SET settlement_state = 'settled'
		WHERE operation_id = '%s'`, opID)); err == nil {
		t.Fatal("an issued settlement fact was rewritten")
	}
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		"DELETE FROM work.operation_resolution WHERE operation_id = '%s'", opID)); err == nil {
		t.Fatal("a resolution row was deleted")
	}
}

// TestR0bSettlementReportsTheLedgerFactsItActuallyHas covers the two columns §4.1
// defines as echoes rather than assertions: delivery_state is the dispatch gate's own
// state (a sealed_not_sent row means never delivered, not "a row exists"), and
// settlement_state is quota_reservation.state (a held reservation is not a settled one,
// and no reservation at all is not a settlement either). Both were constants before,
// which is the difference between reporting a fact and claiming one.
func TestR0bSettlementReportsTheLedgerFactsItActuallyHas(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_resolution_ledger"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	// opA: sealed by the gate and never sent, no reservation.
	// opB: never dispatched at all, but holding a reservation.
	// Both carry a step_key: resolutions exist only for local steps (§4.1), and the
	// seeded Operation is a cloud-shaped row until one is set.
	opB := newUUID(t)
	r0bExec(t, dbName, org, fmt.Sprintf(`
		UPDATE work.operation SET step_key = 'model:1', supersede_no = 0,
		       logical_key = 'model:1#0' WHERE id = '%s';
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash,
		  state, step_key)
		VALUES ('%s', '%s', '%s', 'tool:2#0', 'tool', repeat('d', 64), 'authorized', 'tool:2');
		INSERT INTO work.dispatch_delivery (org_id, operation_id, gate_state, sealed_at)
		VALUES ('%s', '%s', 'sealed_not_sent', now());
	`, run.opID, opB, org, run.runID, org, run.opID))
	if _, err := admin.Exec(testContext(t),
		`SELECT work.reserve_quota($1, 'default', to_char(now(), 'YYYY-MM'), $2, 1000)`,
		org, opB); err != nil {
		t.Fatalf("reserving quota for the second operation failed: %v", err)
	}

	sealed := issueResolution(t, admin, org, run.opID, "sealed_not_sent", nil, nil, nil)
	if sealed["operation_state"] != "canceled" {
		t.Fatalf("sealed_not_sent settled the Operation as %v, want canceled", sealed["operation_state"])
	}
	if sealed["delivery_state"] != "undelivered" {
		t.Fatalf("delivery state = %v, want undelivered: the gate row exists and says never sent",
			sealed["delivery_state"])
	}
	if sealed["settlement_state"] != "unknown" {
		t.Fatalf("settlement state = %v, want unknown: there is no reservation to echo",
			sealed["settlement_state"])
	}

	canceled := issueResolution(t, admin, org, opB, "canceled", nil, nil, nil)
	if canceled["operation_state"] != "canceled" {
		t.Fatalf("canceled verdict settled the Operation as %v", canceled["operation_state"])
	}
	if canceled["delivery_state"] != "not_applicable" {
		t.Fatalf("delivery state = %v, want not_applicable for an action never dispatched",
			canceled["delivery_state"])
	}
	if canceled["settlement_state"] != "held" {
		t.Fatalf("settlement state = %v, want the reservation's own state, held",
			canceled["settlement_state"])
	}
	// The breakdown the frame summarizes is recorded with it, so a reader can see the
	// verdict reported one reservation of several rather than inventing a total.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.operation_resolution
		WHERE org_id = $1 AND operation_id = $2
		  AND evidence -> 'reservations' -> 0 ->> 'state' = 'held'`, org, opB); got != 1 {
		t.Fatalf("reservations recorded in the evidence = %d, want 1", got)
	}
}

// TestR0bReconciliationsReadFaceIsTheJ38Query is §1.4's GET /runs/{id}/reconciliations at
// the database level (R12C-2: the wait, the blocked outcome and the signed verdict had to be
// visible to the owner rather than living in an out-of-band ops job). It pins the three
// things the row cannot do without: the J38 states are distinguishable, a normally settled
// action is not reported as still waiting, and the two mandatory outcomes split - a read-only
// degradation clears both, an exhausted verdict keeps acceptance shut.
func TestR0bReconciliationsReadFaceIsTheJ38Query(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_reconciliations"
	runID, opPending := localUnknownOperation(t, dbName, org, admin)
	r0bAdmin(t, admin, org)
	ctx := testContext(t)

	// opExhausted: a side-effect step whose evidence ran out, signed with a ticket.
	opExhausted := newUUID(t)
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash,
		  state, step_key)
		VALUES ('%s', '%s', '%s', 'tool:9#0', 'tool', repeat('e', 64), 'unknown', 'tool:9')`,
		opExhausted, org, runID))
	degradationServerFacts(t, dbName, org, runID)
	issueResolution(t, admin, org, opExhausted, "failed", "evidence_exhausted", "TICKET-55",
		map[string]any{"egress_receipt": "checked, none"})

	// opSettled: settled by real evidence, so it must not appear as somebody's wait.
	opSettled := newUUID(t)
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash,
		  state, step_key)
		VALUES ('%s', '%s', '%s', 'tool:8#0', 'tool', repeat('f', 64), 'dispatching', 'tool:8')`,
		opSettled, org, runID))
	issueResolution(t, admin, org, opSettled, "succeeded", nil, nil, nil)

	// opGated: still waiting, but the server already holds a gate fact about it, which is the
	// one item that may report authoritative evidence.
	opGated := newUUID(t)
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash,
		  state, step_key)
		VALUES ('%s', '%s', '%s', 'tool:7#0', 'tool', repeat('b', 64), 'unknown', 'tool:7');
		INSERT INTO work.dispatch_delivery (org_id, operation_id, gate_state, sealed_at)
		VALUES ('%s', '%s', 'sealed_not_sent', now())`,
		opGated, org, runID, org, opGated))

	var raw []byte
	if err := admin.QueryRow(ctx, `SELECT work.list_run_reconciliations($1, $2::uuid, $3)`,
		org, runID, r0bAdminSubject(org)).Scan(&raw); err != nil {
		t.Fatalf("the reconciliation read failed: %v", err)
	}
	var view struct {
		OrgID  string `json:"org_id"`
		RunID  string `json:"run_id"`
		TaskID string `json:"task_id"`
		Items  []struct {
			OperationID              string   `json:"operation_id"`
			State                    string   `json:"operation_state"`
			ResolutionState          string   `json:"resolution_state"`
			EvidenceSources          []string `json:"evidence_sources"`
			TicketID                 *string  `json:"ticket_id"`
			HasAuthoritativeEvidence bool     `json:"has_authoritative_evidence"`
			ContactPath              string   `json:"contact_path"`
			WaitedSeconds            *int64   `json:"waited_seconds"`
		} `json:"items"`
		Blocking struct {
			NewRun     bool `json:"new_run"`
			Acceptance bool `json:"acceptance"`
		} `json:"blocking"`
	}
	if err := json.Unmarshal(raw, &view); err != nil {
		t.Fatal(err)
	}
	if len(view.Items) != 3 {
		t.Fatalf("listed items = %d, want the two waiting steps and the exhausted verdict, "+
			"with the settled action excluded (%s)", len(view.Items), raw)
	}
	byOperation := map[string]int{}
	for index, item := range view.Items {
		byOperation[item.OperationID] = index
	}
	pending, okPending := byOperation[opPending]
	exhausted, okExhausted := byOperation[opExhausted]
	gated, okGated := byOperation[opGated]
	if !okPending || !okExhausted || !okGated {
		t.Fatalf("expected %s, %s and %s in %#v", opPending, opExhausted, opGated, view.Items)
	}
	if _, settledListed := byOperation[opSettled]; settledListed {
		t.Fatal("an action settled by real evidence was reported as a wait")
	}
	if got := view.Items[pending].ResolutionState; got != "pending" {
		t.Fatalf("waiting step = %q, want pending", got)
	}
	if got := view.Items[pending].ContactPath; got != "wait_for_reconciliation" {
		t.Fatalf("pending contact path = %q", got)
	}
	if view.Items[pending].WaitedSeconds == nil {
		t.Fatal("the pending item reports no wait clock; reconcile_requested_at has a writer")
	}
	if got := view.Items[exhausted].ResolutionState; got != "evidence_exhausted" {
		t.Fatalf("degraded step = %q, want evidence_exhausted", got)
	}
	if got := view.Items[exhausted].State; got != "reconciled" {
		t.Fatalf("degraded step operation state = %q, want the mapped reconciled", got)
	}
	if view.Items[exhausted].TicketID == nil || *view.Items[exhausted].TicketID != "TICKET-55" {
		t.Fatalf("exhausted ticket = %v, want the cited external ticket", view.Items[exhausted].TicketID)
	}
	if got := view.Items[exhausted].ContactPath; got != "operator_ticket" {
		t.Fatalf("exhausted contact path = %q", got)
	}
	// The exhausted list is what somebody checked, so the command's own internals
	// (state before/after, reservation snapshot) must not be presented as evidence sources.
	for _, source := range view.Items[exhausted].EvidenceSources {
		if source == "operation_state_after" || source == "reservation_held" ||
			source == "reservations" || source == "operation_state_before" {
			t.Fatalf("evidence sources leaked command internals: %#v",
				view.Items[exhausted].EvidenceSources)
		}
	}
	// 0042 (O-10 = jia): three of the four keys this verdict used to be signed against
	// (device_unreachable, lease_or_revocation_checked, seal_checked) are now server
	// table reads or deleted outright, so they are no longer caller evidence. What is
	// left is the one note the operator actually supplied.
	if len(view.Items[exhausted].EvidenceSources) != 1 {
		t.Fatalf("evidence sources = %#v, want the one note the verdict was signed against",
			view.Items[exhausted].EvidenceSources)
	}
	// Both degradations are signed only when no server fact exists, so a signed verdict
	// never reports authoritative evidence; the gate row is what does. That distinction is
	// the whole point of the field: it tells the client whether somebody can still resolve
	// this from the server, or whether the case is genuinely evidence-limited.
	if view.Items[exhausted].HasAuthoritativeEvidence {
		t.Fatal("an exhausted verdict reports authoritative evidence; it may only be signed without any")
	}
	if view.Items[pending].HasAuthoritativeEvidence {
		t.Fatal("a bare unknown step reports authoritative evidence it does not have")
	}
	if !view.Items[gated].HasAuthoritativeEvidence {
		t.Fatal("a dispatch gate fact was not reported as authoritative evidence")
	}
	if view.Items[gated].ResolutionState != "pending" {
		t.Fatalf("the gated step = %q, want pending", view.Items[gated].ResolutionState)
	}
	// While the unknown steps are still open both mandatory outcomes are blocked.
	if !view.Blocking.NewRun || !view.Blocking.Acceptance {
		t.Fatalf("blocking = %+v, want both while steps are unknown", view.Blocking)
	}

	// Clear every remaining wait and the two outcomes split: J38 keeps acceptance shut for an
	// exhausted verdict while releasing new-Run admission. Both open steps are settled (the
	// gated one by a settlement verdict, which is exactly what its gate fact says it needs),
	// because while *any* operation is still open both flags are legitimately true - the
	// split is only observable once nothing is waiting.
	issueResolution(t, admin, org, opPending, "failed", nil, nil, nil)
	issueResolution(t, admin, org, opGated, "failed", nil, nil, nil)
	if err := admin.QueryRow(ctx, `SELECT work.list_run_reconciliations($1, $2::uuid, $3)`,
		org, runID, r0bAdminSubject(org)).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &view); err != nil {
		t.Fatal(err)
	}
	if len(view.Items) != 1 {
		t.Fatalf("items after settling both waits = %d, want only the exhausted verdict (%s)",
			len(view.Items), raw)
	}
	if view.Blocking.NewRun {
		t.Fatalf("new-Run admission still blocked after the wait cleared: %+v", view.Blocking)
	}
	if !view.Blocking.Acceptance {
		t.Fatal("an exhausted verdict stopped blocking adoption; §4.2's J38 asymmetry is gone")
	}

	// A caller who does not own the task gets the same answer as a missing Run: the view
	// exists so an owner can see their own wait, and a forbidden here would disclose that
	// somebody else's Run is stuck. The session subject must move with the actor, or
	// assert_session_subject answers first and this proves nothing about ownership.
	other := "sub_not_the_owner"
	if _, err := admin.Exec(ctx, "SET app.subject_id = "+quoteLiteral(other)); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `SELECT work.list_run_reconciliations($1, $2::uuid, $3)`,
		org, runID, other); err == nil {
		t.Fatal("a non-owner read another task's reconciliation state")
	} else {
		assertPgMessage(t, err, "task_not_found")
	}
}

func TestR0bResolutionRefusesTheWrongVocabularyAndScope(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_resolution_scope"
	_, opID := localUnknownOperation(t, dbName, org, admin)

	// Not a local step: resolutions exist only for local Runs (control §4.1).
	cloudOp := "88888888-8888-8888-8888-888888888888"
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state)
		SELECT '%s', r.org_id, r.run_id, 'model:9', 'model', repeat('a', 64), 'unknown'
		FROM work.operation r WHERE r.id = '%s'`, cloudOp, opID))
	if _, err := admin.Exec(testContext(t),
		`SELECT work.issue_operation_resolution($1, $2::uuid, 'failed', 'evidence_unavailable',
		  NULL, $3, 'sub_operator', '{}'::jsonb)`,
		org, cloudOp, "sha256:"+repeatHex(t, 64)); err == nil {
		t.Fatal("a degradation was issued for a cloud Run's Operation")
	}

	// Server-side evidence already present means the case is reconcilable, not
	// downgradable.
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.operation SET provider_request_id = 'req-77' WHERE id = '%s'", opID))
	if _, err := admin.Exec(testContext(t),
		`SELECT work.issue_operation_resolution($1, $2::uuid, 'failed', 'evidence_unavailable',
		  NULL, $3, 'sub_operator', '{}'::jsonb)`,
		org, opID, "sha256:"+repeatHex(t, 64)); err == nil {
		t.Fatal("a degradation was issued while a provider request id existed")
	}
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.operation SET provider_request_id = NULL WHERE id = '%s'", opID))

	// The canceled verdict cannot be reached from unknown at all: the only registered
	// target there is reconciled/unresolved, so the caller's vocabulary error is
	// refused instead of being silently mapped.
	if _, err := admin.Exec(testContext(t),
		`SELECT work.issue_operation_resolution($1, $2::uuid, 'canceled', NULL,
		  NULL, $3, 'sub_operator', '{}'::jsonb)`,
		org, opID, "sha256:"+repeatHex(t, 64)); err == nil {
		t.Fatal("canceled was resolved from an unknown Operation")
	} else {
		assertPgMessage(t, err, "resolution_target_unreachable")
	}

	// A model action is never the read-only degradation's subject.
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.operation SET kind = 'model' WHERE id = '%s'", opID))
	if _, err := admin.Exec(testContext(t),
		`SELECT work.issue_operation_resolution($1, $2::uuid, 'failed', 'evidence_unavailable',
		  NULL, $3, 'sub_operator', '{}'::jsonb)`,
		org, opID, "sha256:"+repeatHex(t, 64)); err == nil {
		t.Fatal("a model action took the read-only degradation path")
	}

	// A dispatch gate row is a server fact about what happened, on either degradation
	// path: sealed_not_sent / consumed / receipt_recorded all say the case is settleable,
	// so downgrading past it is refused rather than guessed around. It is asserted last
	// among the refusals because dispatch_delivery is append-only (0009), so the row
	// cannot be withdrawn and every check that must fail for some *other* reason has to
	// run while the gate is still empty.
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.dispatch_delivery (org_id, operation_id, gate_state, sealed_at)
		VALUES ('%s', '%s', 'sealed_not_sent', now())`, org, opID))
	if _, err := issueResolutionSigned(t, admin, org, opID, "failed", "evidence_unavailable",
		nil, "", i4Facts(nil)); err == nil {
		t.Fatal("a degradation was issued while the dispatch gate held a fact")
	} else {
		assertPgMessage(t, err, "resolution_evidence_exists")
	}
	if _, err := issueResolutionSigned(t, admin, org, opID, "failed", "evidence_exhausted",
		"TICKET-9", "", map[string]any{"device_unreachable": "true",
			"lease_or_revocation_checked": "true", "seal_checked": "true"}); err == nil {
		t.Fatal("an exhausted verdict was issued while the dispatch gate held a fact")
	} else {
		assertPgMessage(t, err, "resolution_evidence_exists")
	}

	// Only the settlement pair may issue: the API role has no path here, which is why
	// §1.4 lists no reconcile endpoint by design.
	api := connect(t, appURL(dbName))
	defer api.Close(testContext(t))
	if _, err := api.Exec(testContext(t), "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}
	_, err := api.Exec(testContext(t),
		`SELECT work.issue_operation_resolution($1, $2::uuid, 'failed', NULL, NULL,
		  $3, 'sub_operator', '{}'::jsonb)`, org, opID, "sha256:"+repeatHex(t, 64))
	assertPermissionDenied(t, err)
}
