package migrate

import (
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for increment 0023: the operator suspension and the cancellation intents get
// their producers.
//
// Two rules had no carrier before this increment. §3.3 P2 requires an operator suspension
// to build a deny, retire an epoch and queue cancellions *before* the Host is called, yet
// `work.org.operator_suspended` - the column every shipped execution guard reads - was only
// ever set by tests. And §6.1 requires a cancellation intent beside every narrowing deny,
// while `work.cancellation_intent` had zero INSERT statements in the whole chain.
//
// The asymmetry these tests protect is deliberate and comes from P2: narrowing lands
// immediately, restoration only after the Host acknowledges that exact revision. A restore
// that took effect on request would let one unacknowledged command reopen an organization
// the operator stopped.

type entitlementCall struct {
	org       string
	actor     string
	ref       string
	enabled   bool
	suspended bool
	seatLimit any
	revision  int64
	ack       any
	requestID string
}

const applySQL = `
	SELECT work.apply_execution_entitlement(
		$1, $2, $3, $4, $5, $6, $7, $8, $9)`

// operatorSession connects as the operator workload. The command binds the actor argument
// to app.subject_id and its org argument to app.org_id, so a session that sets neither is
// refused for reasons that have nothing to do with what is under test.
func operatorSession(t *testing.T, dbName, org, subject string) *pgx.Conn {
	t.Helper()
	conn := connect(t, testpg.OperatorURL(dbName))
	ctx := testContext(t)
	if _, err := conn.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)+
		"; SET app.subject_id = "+quoteLiteral(subject)); err != nil {
		t.Fatal(err)
	}
	return conn
}

func applyEntitlement(t *testing.T, conn *pgx.Conn, call entitlementCall) map[string]any {
	t.Helper()
	var payload string
	if err := conn.QueryRow(testContext(t), applySQL,
		call.org, call.actor, call.ref, call.enabled, call.suspended,
		call.seatLimit, call.revision, call.ack, call.requestID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(payload), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func entitlementError(t *testing.T, conn *pgx.Conn, call entitlementCall) error {
	t.Helper()
	_, err := conn.Exec(testContext(t), applySQL,
		call.org, call.actor, call.ref, call.enabled, call.suspended,
		call.seatLimit, call.revision, call.ack, call.requestID)
	return err
}

func wantInt(t *testing.T, out map[string]any, key string, want int) {
	t.Helper()
	value, ok := out[key].(float64)
	if !ok {
		t.Fatalf("result key %q = %#v, want a number", key, out[key])
	}
	if int(value) != want {
		t.Fatalf("result %q = %d, want %d", key, int(value), want)
	}
}

func wantStr(t *testing.T, out map[string]any, key, want string) {
	t.Helper()
	if out[key] != want {
		t.Fatalf("result %q = %#v, want %q", key, out[key], want)
	}
}

func wantBool(t *testing.T, out map[string]any, key string, want bool) {
	t.Helper()
	if out[key] != want {
		t.Fatalf("result %q = %#v, want %v", key, out[key], want)
	}
}

// seedExtraRun adds a second Task and Run for `subject`, cloned from an existing Run so
// the composite facts line up. It exists because `work_run_one_open_per_task` allows one
// open Run per Task, `run.snapshot_id` is composite-keyed to the snapshot of its own Task,
// and seedRun cannot be called twice in one organization (the active input hash is unique
// per subject).
func seedExtraRun(t *testing.T, dbName, org, subject, fromRun string) string {
	t.Helper()
	task := newUUID(t)
	run := newUUID(t)
	snapshot := newUUID(t)
	input := newUUID(t)
	r0bExec(t, dbName, org, `
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('`+input+`', '`+org+`', '`+subject+`', 'input-`+task+`',
		        repeat('d', 64), 12);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, title, input_id)
		VALUES ('`+task+`', '`+org+`', '`+subject+`', 'open', 'extra task',
		        '`+input+`');
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		SELECT '`+snapshot+`', '`+org+`', '`+task+`', 'v1', repeat('b', 64),
		       ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb;
		UPDATE work.task SET snapshot_id = '`+snapshot+`' WHERE id = '`+task+`';
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id,
		                      workflow_id, runtime_version)
		SELECT '`+run+`', r.org_id, '`+task+`', 1, 'active', '`+snapshot+`',
		       'run-`+run+`', 'pi-1'
		FROM work.run r WHERE r.id = '`+fromRun+`';
		UPDATE work.task SET active_run_id = '`+run+`', latest_run_id = '`+run+`'
		WHERE id = '`+task+`';`)
	return run
}

func TestR0bOperatorSuspendBuildsDenyAndQueuesCancellations(t *testing.T) {
	dbName, admin := newGateDB(t)
	ctx := testContext(t)
	org := "org_r0b_ops_suspend"
	first := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	epochBefore := scalarCount(t, admin,
		`SELECT access_epoch FROM work.org WHERE id = $1`, org)
	ops := operatorSession(t, dbName, org, "ops_root")
	defer ops.Close(ctx)

	result := applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		enabled: false, revision: 1, requestID: "req-suspend-1",
	})
	// The command answers with the facts the caller must not have to recompute.
	wantStr(t, result, "outcome", "suspended")
	wantBool(t, result, "denial_active", true)
	wantInt(t, result, "cancellation_intents", 1)

	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'operator' AND state = 'active'`, org); got != 1 {
		t.Fatalf("active operator denys = %d, want 1", got)
	}
	// The deny stores the epoch it retires, so a Run admitted after this point is
	// outside the cancel scope by construction.
	if got := scalarCount(t, admin, `SELECT epoch FROM work.access_restriction
		WHERE org_id = $1 AND source = 'operator'`, org); got != epochBefore {
		t.Fatalf("deny cutoff epoch = %d, want the retired %d", got, epochBefore)
	}
	if got := scalarCount(t, admin, `SELECT access_epoch FROM work.org WHERE id = $1`, org); got != epochBefore+1 {
		t.Fatalf("access_epoch = %d, want %d", got, epochBefore+1)
	}
	if got := scalarCount(t, admin, `SELECT release_floor_revision
		FROM work.access_restriction WHERE org_id = $1 AND source = 'operator'`, org); got != 1 {
		t.Fatalf("deny release floor = %d, want the suspension's entitlement revision 1", got)
	}
	if got := scalarString(t, admin, `SELECT execution_enabled::text FROM work.org WHERE id = $1`, org); got != "false" {
		t.Fatalf("work.org.execution_enabled = %s, want false - the guards read this column, not the entitlement row", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.cancellation_intent
		WHERE org_id = $1 AND run_id = $2 AND reason = 'entitlement_disabled'`,
		org, first.runID); got != 1 {
		t.Fatalf("intents for the admitted Run = %d, want 1", got)
	}

	// P5: the Host has not acknowledged revision 1 yet, so a second Apply is refused
	// rather than racing the first.
	if err := entitlementError(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-2",
		enabled: false, revision: 2, requestID: "req-suspend-2",
	}); err == nil {
		t.Fatal("a second Apply landed while the first was still unacknowledged")
	} else {
		assertPgMessage(t, err, "governance_revision_conflict")
	}

	// Recording the acknowledgement settles it. The state is still "not allowed", so
	// this restates the suspension instead of building a second one.
	acked := applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		enabled: false, revision: 1, ack: int64(1), requestID: "req-ack-1",
	})
	wantStr(t, acked, "outcome", "already_suspended")
	wantInt(t, acked, "cancellation_intents", 0)
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'operator'`, org); got != 1 {
		t.Fatalf("operator denys = %d, want 1 - the epoch may move exactly once per narrowing", got)
	}

	restated := applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-3",
		enabled: false, revision: 2, requestID: "req-suspend-3",
	})
	wantStr(t, restated, "outcome", "already_suspended")
	wantInt(t, restated, "cancellation_intents", 0)
	if got := scalarCount(t, admin, `SELECT access_epoch FROM work.org WHERE id = $1`, org); got != epochBefore+1 {
		t.Fatalf("access_epoch moved to %d on a restated suspension, want %d", got, epochBefore+1)
	}
	// P5 applies to every recorded revision, including the restatement: the restore may
	// not be submitted until the Host has acknowledged revision 2.
	applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-3",
		enabled: false, revision: 2, ack: int64(2), requestID: "req-ack-2",
	})

	// Restoration is recorded, but the organization only reopens when the Host
	// acknowledges this revision (P2's reverse ordering).
	pending := applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-4",
		enabled: true, revision: 3, requestID: "req-restore",
	})
	wantStr(t, pending, "outcome", "pending_ack")
	restored := applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-4",
		enabled: true, revision: 3, ack: int64(3), requestID: "req-ack-restore",
	})
	wantStr(t, restored, "outcome", "restored")

	// Only now can a Run be admitted at all: the shipped admission guard reads the same
	// mirror columns this command moves, so a refusal here would mean the mirror is
	// decorative.
	lateRun := seedExtraRun(t, dbName, org, "sub_"+org, first.runID)

	// A Run admitted after the suspension's retired epoch is not in that narrowing's
	// cancel scope - and never enters it later either.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.cancellation_intent
		WHERE org_id = $1 AND run_id = $2`, org, lateRun); got != 0 {
		t.Fatalf("intents for the post-suspension Run = %d, want 0", got)
	}
	// No intent may point at a Run whose admission is above the deny that queued it.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.cancellation_intent ci
		JOIN work.run r ON r.id = ci.run_id AND r.org_id = ci.org_id
		WHERE ci.org_id = $1
		  AND r.admission_access_epoch > (
		    SELECT ar.epoch FROM work.access_restriction ar
		    WHERE ar.org_id = $1 AND ar.source = 'operator')`, org); got != 0 {
		t.Fatalf("intents above their deny cutoff = %d, want 0", got)
	}
}

func TestR0bOperatorRestoreWaitsForTheHostAckAndReleasesOnlyItsOwn(t *testing.T) {
	dbName, admin := newGateDB(t)
	ctx := testContext(t)
	org := "org_r0b_ops_restore"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	// A seat deny from the projection, on a member who is not the task owner: restoring
	// service must not touch it (P6).
	r0bExec(t, dbName, org, `
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ('`+org+`', 'sub_seatloss', 'active', 'member', true);
		UPDATE work.member SET work_seat = false
		WHERE org_id = '`+org+`' AND subject_id = 'sub_seatloss'`)
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'host_seat' AND state = 'active'`, org); got != 1 {
		t.Fatalf("host_seat denys = %d, want 1 before the operator acts", got)
	}

	ops := operatorSession(t, dbName, org, "ops_root")
	defer ops.Close(ctx)

	applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		suspended: true, revision: 1, requestID: "req-suspend",
	})
	applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		suspended: true, revision: 1, ack: int64(1), requestID: "req-ack-suspend",
	})

	// The restore request: recorded, but the effective state stays closed until the
	// Host acknowledges this exact revision.
	pending := applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-2",
		enabled: true, revision: 2, requestID: "req-restore",
	})
	wantStr(t, pending, "outcome", "pending_ack")
	wantBool(t, pending, "denial_active", true)
	if got := scalarString(t, admin, `SELECT execution_enabled::text FROM work.org WHERE id = $1`, org); got != "false" {
		t.Fatalf("execution_enabled reopened on an unacknowledged restore (%s), want false", got)
	}

	restored := applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-2",
		enabled: true, revision: 2, ack: int64(2), requestID: "req-ack-restore",
	})
	wantStr(t, restored, "outcome", "restored")
	wantBool(t, restored, "denial_active", false)
	wantInt(t, restored, "released_denials", 1)
	if got := scalarString(t, admin, `SELECT execution_enabled::text FROM work.org WHERE id = $1`, org); got != "true" {
		t.Fatalf("execution_enabled = %s after the acknowledgement, want true", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'operator' AND state = 'released'
		  AND released_by_revision = 2`, org); got != 1 {
		t.Fatalf("released operator denys = %d, want 1", got)
	}
	// P6: an operator restore is not a general amnesty.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'host_seat' AND state = 'active'`, org); got != 1 {
		t.Fatalf("host_seat denys still active = %d, want 1 - §3.3 P6 forbids releasing them here", got)
	}
	// The release is a fact with a timestamp and a revision, never a bare state flip.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND state = 'released' AND released_at IS NULL`, org); got != 0 {
		t.Fatalf("released denys without released_at = %d, want 0", got)
	}
}

func TestR0bSeatLimitChangeIsNotADenySource(t *testing.T) {
	dbName, admin := newGateDB(t)
	ctx := testContext(t)
	org := "org_r0b_ops_seatlimit"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	ops := operatorSession(t, dbName, org, "ops_root")
	defer ops.Close(ctx)

	// §3.3 P4: lowering the ceiling marks the organization overallocated and blocks new
	// grants; it is not a narrowing of service and must not retire an epoch.
	result := applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		enabled: true, seatLimit: int64(2), revision: 1, requestID: "req-limit",
	})
	wantStr(t, result, "outcome", "pending_ack")
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1`, org); got != 0 {
		t.Fatalf("denys from a seat_limit change = %d, want 0", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.cancellation_intent
		WHERE org_id = $1`, org); got != 0 {
		t.Fatalf("intents from a seat_limit change = %d, want 0", got)
	}
}

func TestR0bOperatorCommandRefusesEveryWrongCaller(t *testing.T) {
	dbName, admin := newGateDB(t)
	ctx := testContext(t)
	org := "org_r0b_ops_authz"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)
	other := "org_r0b_ops_other"

	app := connect(t, testpg.AppURL(dbName))
	defer app.Close(ctx)
	if _, err := app.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)+
		"; SET app.subject_id = "+quoteLiteral("sub_"+org)); err != nil {
		t.Fatal(err)
	}
	// The command is EXECUTE-granted to work_operator alone. An application role reaching
	// it would let any service holding work_api suspend an organization.
	err := entitlementError(t, app, entitlementCall{
		org: org, actor: "sub_" + org, ref: "TICKET-1",
		enabled: false, revision: 1, requestID: "req-app",
	})
	if err == nil {
		t.Fatal("work_api executed the operator command")
	}
	assertPgMessage(t, err, "permission denied for function")

	ops := operatorSession(t, dbName, org, "ops_root")
	defer ops.Close(ctx)

	cases := []struct {
		name string
		call entitlementCall
		want string
	}{
		{"actor is not the session subject", entitlementCall{
			org: org, actor: "somebody_else", ref: "TICKET-1",
			enabled: false, revision: 1, requestID: "req-actor",
		}, "actor_mismatch"},
		{"no authorization reference", entitlementCall{
			org: org, actor: "ops_root", ref: "  ",
			enabled: false, revision: 1, requestID: "req-noref",
		}, "invalid_request:operator_authorization_ref"},
		{"no client request id", entitlementCall{
			org: org, actor: "ops_root", ref: "TICKET-1",
			enabled: false, revision: 1,
		}, "invalid_request:client_request_id"},
		{"ack for a revision nobody recorded", entitlementCall{
			org: org, actor: "ops_root", ref: "TICKET-1",
			enabled: false, revision: 1, ack: int64(1), requestID: "req-earlyack",
		}, "invalid_request:host_ack_revision"},
		{"negative seat ceiling", entitlementCall{
			org: org, actor: "ops_root", ref: "TICKET-1",
			enabled: true, seatLimit: int64(-1), revision: 1, requestID: "req-neglimit",
		}, "invalid_request:entitlement"},
		{"another organization", entitlementCall{
			org: other, actor: "ops_root", ref: "TICKET-1",
			enabled: false, revision: 1, requestID: "req-crosstenant",
		}, "org_context_mismatch"},
	}
	for _, tc := range cases {
		got := entitlementError(t, ops, tc.call)
		if got == nil {
			t.Fatalf("%s: command succeeded, want %q", tc.name, tc.want)
		}
		assertPgMessage(t, got, tc.want)
	}

	// None of the refusals above may leave a decision behind.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.execution_entitlement
		WHERE org_id = $1`, org); got != 0 {
		t.Fatalf("entitlement rows after refusals = %d, want 0", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'operator'`, org); got != 0 {
		t.Fatalf("operator denys after refusals = %d, want 0", got)
	}
}

func TestR0bEntitlementReceiptIsIdempotent(t *testing.T) {
	dbName, admin := newGateDB(t)
	ctx := testContext(t)
	org := "org_r0b_ops_receipt"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	ops := operatorSession(t, dbName, org, "ops_root")
	defer ops.Close(ctx)

	call := entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		enabled: false, suspended: false, revision: 1, requestID: "req-once",
	}
	first := applyEntitlement(t, ops, call)
	second := applyEntitlement(t, ops, call)
	if !equalJSON(first, second) {
		t.Fatalf("replay returned a different decision: %v vs %v", first, second)
	}
	// A replay must not re-decide anything: no second deny, no second epoch bump, and
	// exactly one receipt row.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'operator'`, org); got != 1 {
		t.Fatalf("operator denys after a replay = %d, want 1", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND action = 'execution_entitlement.applied'`, org); got != 1 {
		t.Fatalf("receipts after a replay = %d, want 1", got)
	}
	// Same key, different body. The receipt is keyed by request id alone, so without a
	// payload comparison this third call was answered with the first one's result and the
	// seat limit it carried was never written - EV106's 异 payload 409, and the same rule
	// 0005:48 already applies to submissions.
	if err := entitlementError(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		enabled: false, suspended: false, seatLimit: int64(7),
		revision: 1, requestID: "req-once",
	}); err == nil {
		t.Fatal("a reused request id with a different body returned the earlier success")
	} else {
		assertPgMessage(t, err, "idempotency_key_conflict")
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND action = 'execution_entitlement.applied'`, org); got != 1 {
		t.Fatalf("receipts after a payload-divergent retry = %d, want 1", got)
	}
	// A different request id is a different command, and restating an already recorded
	// revision without an acknowledgement is refused rather than silently re-run.
	if err := entitlementError(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-2",
		enabled: false, revision: 1, requestID: "req-other-id",
	}); err == nil {
		t.Fatal("restating a recorded revision without an acknowledgement succeeded")
	} else {
		assertPgMessage(t, err, "governance_revision_conflict")
	}
}

// TestR0bEntitlementAckWithNothingToReleaseIsStillRecorded walks the one outcome the
// shipped tests never reached. `restored` and `ack_recorded` share the acknowledgement
// branch, and the release audit is the only difference between them, so a branch with no
// assertion is a branch where a wrong outcome code would go unnoticed.
func TestR0bEntitlementAckWithNothingToReleaseIsStillRecorded(t *testing.T) {
	dbName, admin := newGateDB(t)
	ctx := testContext(t)
	org := "org_r0b_ops_ack_only"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	ops := operatorSession(t, dbName, org, "ops_root")
	defer ops.Close(ctx)

	// Enabling an organization that was never denied is the Apply that has nothing to
	// narrow: it waits for the Host acknowledgement, and when that lands it has nothing to
	// release either.
	pending := applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		enabled: true, suspended: false, revision: 1, requestID: "req-enable",
	})
	wantStr(t, pending, "outcome", "pending_ack")
	acked := applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		enabled: true, suspended: false, revision: 1, ack: int64(1), requestID: "req-ack",
	})
	wantStr(t, acked, "outcome", "ack_recorded")
	wantInt(t, acked, "released_denials", 0)

	// The acknowledgement still settles the revision and still opens the mirror - that is
	// what the admission guard reads - it just produces no release and no release audit.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.org
		WHERE id = $1 AND execution_enabled AND NOT operator_suspended`, org); got != 1 {
		t.Fatalf("mirror rows after an ack with nothing to release = %d, want the org enabled", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'operator'`, org); got != 0 {
		t.Fatalf("operator denys for an organization that was never denied = %d, want 0", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND action = 'access_restriction.released'`, org); got != 0 {
		t.Fatalf("release audits without a released denial = %d, want 0", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND action = 'execution_entitlement.applied'`, org); got != 2 {
		t.Fatalf("receipts for two distinct request ids = %d, want 2", got)
	}
}

func TestR0bMemberNarrowingQueuesOnlyThatPersonsRuns(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_ops_absent"
	kept := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	// A second member with a Run of their own, sharing the org but nothing else.
	otherSubject := "sub_gone"
	r0bExec(t, dbName, org, `
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ('`+org+`', '`+otherSubject+`', 'active', 'member', true);`)
	otherRun := seedExtraRun(t, dbName, org, otherSubject, kept.runID)

	r0bExec(t, dbName, org, `UPDATE work.member SET status = 'left'
		WHERE org_id = '`+org+`' AND subject_id = '`+otherSubject+`'`)

	if got := scalarCount(t, admin, `SELECT count(*) FROM work.cancellation_intent
		WHERE org_id = $1 AND run_id = $2 AND reason = 'member_left'`,
		org, otherRun); got != 1 {
		t.Fatalf("intents for the departed member's Run = %d, want 1", got)
	}
	// The scope is the person, not the organization: everyone else keeps their Runs.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.cancellation_intent
		WHERE org_id = $1 AND run_id = $2`, org, kept.runID); got != 0 {
		t.Fatalf("intents for another member's Run = %d, want 0", got)
	}
	// The count is recorded where the operator reads it, not only returned to the caller.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.audit_event ae
		JOIN work.access_restriction ar ON ar.id::text = ae.target_id
		WHERE ae.org_id = $1 AND ae.action = 'access_restriction.created'
		  AND ar.source = 'host_member'
		  AND (ae.metadata ->> 'cancellation_intents')::int = 1`, org); got != 1 {
		t.Fatalf("member-narrowing audits carrying the intent count = %d, want 1", got)
	}
	// The writer never invents its own event: every intent row names the deny that
	// queued it, which is what makes one narrowing idempotent per Run.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.cancellation_intent ci
		WHERE ci.org_id = $1 AND NOT EXISTS (
		  SELECT 1 FROM work.access_restriction ar WHERE ar.id = ci.source_event_id)`,
		org); got != 0 {
		t.Fatalf("intents without a matching deny = %d, want 0", got)
	}
}

func TestR0bHostRestoreDoesNotReopenAnOperatorSuspension(t *testing.T) {
	dbName, admin := newGateDB(t)
	ctx := testContext(t)
	org := "org_r0b_ops_vs_host"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	ops := operatorSession(t, dbName, org, "ops_root")
	defer ops.Close(ctx)
	applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		suspended: true, revision: 1, requestID: "req-suspend",
	})
	applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		suspended: true, revision: 1, ack: int64(1), requestID: "req-ack",
	})

	// Host archives the organization, then restores it. The archive adds a host_org deny;
	// restoring releases it through the projection recovery. This is the exact shape the
	// first draft of 0023 got wrong: keyed off the current mirror, "already not running"
	// swallowed the suspension record, and the archive lifting would have reopened an
	// organization a person had stopped.
	r0bExec(t, dbName, org, `UPDATE work.org SET status = 'archived' WHERE id = '`+org+`'`)
	r0bExec(t, dbName, org, `UPDATE work.org SET status = 'active', revision = revision + 1
		WHERE id = '`+org+`'`)
	if got := scalarCount(t, admin, `SELECT work.apply_directory_recovery($1, NULL, $2::bigint, 'sync')`,
		org, 1); got != 1 {
		t.Fatalf("denys released by the projection recovery = %d, want 1 (the host_org deny)", got)
	}

	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'host_org' AND state = 'released'`, org); got != 1 {
		t.Fatalf("released host_org denys = %d, want 1", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'operator' AND state = 'active'`, org); got != 1 {
		t.Fatalf("active operator denys after the Host restore = %d, want 1 (EV76: 服务方 activate 只解除 host_org)", got)
	}
	if got := scalarString(t, admin, `SELECT execution_enabled::text FROM work.org WHERE id = $1`, org); got != "false" {
		t.Fatalf("execution_enabled = %s after the Host restore, want false - the operator answer is not the Host's to give", got)
	}

	// And the worker sees the human decision, not the projection state.
	worker := connect(t, testpg.WorkerURL(dbName))
	defer worker.Close(ctx)
	if _, err := worker.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.Exec(ctx, `SELECT work.register_runtime_execution(
		$1, $2::uuid, $3::uuid, 'plan', 1, 'pi-restore', now() + interval '10 minutes')`,
		org, newUUID(t), run.runID); err == nil {
		t.Fatal("a worker admitted work for an organization the operator suspended")
	} else {
		assertPgMessage(t, err, "org_operator_suspended")
	}
}

func equalJSON(left, right map[string]any) bool {
	lb, lerr := json.Marshal(left)
	rb, rerr := json.Marshal(right)
	return lerr == nil && rerr == nil && string(lb) == string(rb)
}
