package migrate

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for increment 0017: the R0b transition authority and the column
// increments it puts on `operation` and `artifact_version`.
//
// These cover the exits named in control §4.1 for this slice: the three
// state_transition judgments including the two edges that must stay absent, the
// classification backfill order and the immutability consequence of a nullable
// content_ref, and the one-open-step plus supersede-shape rules behind EV71 and
// EV113.

// liveOperationStates are the states an Operation can be in when a resolution or
// a supersede is issued; terminal states are excluded by definition.
var liveOperationStates = "('prepared','waiting_approval','authorized','dispatching','unknown','unresolved')"

// r0bExec runs a statement batch with the tenant context set. Baseline 0002
// turns every work function into SECURITY DEFINER, so guard triggers such as
// enforce_org_execution read work.org as work_owner under FORCE RLS: without
// app.org_id the lookup finds nothing and the guard reports a business denial
// instead of the transition under test.
func r0bExec(t *testing.T, dbName, org, sql string) {
	t.Helper()
	execAdmin(t, dbName, fmt.Sprintf("SET app.org_id = %s;\n%s", quoteLiteral(org), sql))
}

// r0bAdminSubject is the owner the seedRun fixture writes: `work.member` rows arrive as
// ('sub_' || org, role 'owner'), and the admin commands now bind their actor to a real
// projected row instead of a free-text argument.
func r0bAdminSubject(org string) string {
	return "sub_" + org
}

// r0bAdmin sets the tenant context on the long-lived admin session so that
// single statements sent through it hit the same guards. It also sets
// app.subject_id, because assert_org_admin compares the command's actor against the
// session subject - leaving that GUC unset would make every admin command refuse with
// actor_mismatch for a reason that has nothing to do with what is under test.
func r0bAdmin(t *testing.T, admin *pgx.Conn, org string) {
	t.Helper()
	if _, err := admin.Exec(testContext(t), "SET app.org_id = "+quoteLiteral(org)+
		"; SET app.subject_id = "+quoteLiteral(r0bAdminSubject(org))); err != nil {
		t.Fatal(err)
	}
}

func TestR0bResolutionMapIsRealizable(t *testing.T) {
	_, admin := newGateDB(t)

	// A mapping row whose target cannot be reached from any live Operation state
	// is dead data: the command that consults it could never satisfy it.
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.resolution_state_map m
		  WHERE NOT EXISTS (
		    SELECT 1 FROM work.state_transition e
		    WHERE e.entity = 'operation' AND e.to_state = m.operation_state
		      AND e.from_state IN `+liveOperationStates+`)`); got != 0 {
		t.Fatalf("unrealizable resolution mappings = %d", got)
	}

	// §4.1 judgment 1: an unknown Operation may only be settled to
	// reconciled/unresolved, so a degradation issued there must land reconciled.
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.state_transition
		  WHERE entity = 'operation' AND from_state = 'unknown'
		    AND to_state NOT IN ('reconciled','unresolved')`); got != 0 {
		t.Fatalf("extra transitions registered from operation.unknown = %d", got)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.resolution_state_map
		  WHERE resolution_state = 'failed' AND operation_state = 'reconciled'`); got != 1 {
		t.Fatalf("failed -> reconciled mapping rows = %d, want 1", got)
	}

	// §4.1 judgments 2 and 3 name the edges that must NOT exist: run
	// waiting->succeeded would skip the task-level finish gate, and operation
	// dispatching->canceled would claim a cancellation the server cannot prove.
	for _, forbidden := range [][3]string{
		{"run", "waiting", "succeeded"},
		{"operation", "dispatching", "canceled"},
	} {
		if got := scalarCount(t, admin,
			`SELECT count(*) FROM work.state_transition
			  WHERE entity = $1 AND from_state = $2 AND to_state = $3`,
			forbidden[0], forbidden[1], forbidden[2]); got != 0 {
			t.Fatalf("%s.%s->%s must stay unregistered, found %d",
				forbidden[0], forbidden[1], forbidden[2], got)
		}
	}
}

func TestR0bRunGuardRejectsWaitingToSucceeded(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_run_guard"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	// A local finish may not jump the Run from waiting straight to succeeded.
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.run SET state = 'waiting', wait_reason = 'reconcile' WHERE id = '%s'",
		run.runID))
	_, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.run SET state = 'succeeded' WHERE id = '%s'", run.runID))
	assertPgMessage(t, err, "invalid_transition:run:waiting->succeeded")

	// The two registered steps do work: waiting -> active, then active -> succeeded.
	r0bExec(t, dbName, org, fmt.Sprintf(`
		UPDATE work.run SET state = 'active' WHERE id = '%[1]s';
		UPDATE work.run SET state = 'succeeded' WHERE id = '%[1]s';
	`, run.runID))
	if got := scalarString(t, admin,
		`SELECT state FROM work.run WHERE id = $1`, run.runID); got != "succeeded" {
		t.Fatalf("run state after the two registered steps = %q", got)
	}
}

func TestR0bOperationGuardRejectsDispatchingToCanceled(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_operation_guard"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	// A dispatched Operation may not be cancelled: only a step that never reached
	// dispatch can be, which is what limits the supersede path.
	second := newUUID(t)
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.operation SET state = 'dispatching' WHERE id = '%s'", run.opID))
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state)
		VALUES ('%s', '%s', '%s', 'tool:2', 'tool', repeat('d', 64), 'authorized');
	`, second, org, run.runID))
	if got := scalarString(t, admin,
		`SELECT state FROM work.operation WHERE id = $1`, run.opID); got != "dispatching" {
		t.Fatalf("fixture operation state = %q, want dispatching", got)
	}
	_, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.operation SET state = 'canceled' WHERE id = '%s'", run.opID))
	assertPgMessage(t, err, "invalid_transition:operation:dispatching->canceled")

	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.operation SET state = 'canceled' WHERE id = '%s'", second))
	if got := scalarString(t, admin,
		`SELECT state FROM work.operation WHERE id = $1`, second); got != "canceled" {
		t.Fatalf("authorized -> canceled state = %q", got)
	}
}

func TestR0bArtifactVersionLocationShapeAndImmutability(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_version"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)
	artifactID := newUUID(t)
	deviceID := newUUID(t)
	hash := fmt.Sprintf("sha256:%s", repeatHex(t, 64))

	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.artifact (id, org_id, task_id, logical_name, state)
		VALUES ('%[1]s', '%[2]s', '%[3]s', 'notes.md', 'published');
		INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_ref, content_hash, bytes, media_type,
		   state, provenance, location, classification)
		VALUES ('%[1]s', '%[2]s', 1, 'artifact/cloud', '%[4]s', 24, 'text/markdown',
		        'published', '{}'::jsonb, 'cloud', 'remote_excerpt_allowed');
	`, artifactID, org, run.taskID, hash))

	// A cloud version without content_ref is refused by the location shape.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_ref, content_hash, bytes, media_type,
		   state, provenance, location, classification)
		VALUES ('%s', '%s', 9, NULL, '%s', 1, 'text/markdown', 'published',
		        '{}'::jsonb, 'cloud', 'remote_excerpt_allowed')
	`, artifactID, org, hash)); err == nil {
		t.Fatal("cloud version with a null content_ref was accepted")
	}

	// local_only is the row 0017 makes possible: content_ref must be absent and
	// the local binding must be complete.
	//
	// 0040 closed the foreign key 0017:156-158 promised ("the FK lands with the table
	// it points at"), so the binding now has to name a real device. Seeding one is the
	// closure being exercised, not a way around it.
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.device
		  (org_id, id, owner_subject_id, device_name, platform, public_key_jwk,
		   public_key_thumbprint, auth_plane, auth_epoch, status)
		VALUES ('%s', '%s', 'sub_%s', 'fixture desk', 'windows-x64',
		        '{"crv":"P-256","kty":"EC","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}'::jsonb,
		        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		        'bearer', 0, 'active')
	`, org, deviceID, org))
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_ref, content_hash, bytes, media_type,
		   state, provenance, location, local_ref, device_id, classification)
		VALUES ('%s', '%s', 2, NULL, '%s', 12, 'text/markdown', 'staged',
		        '{}'::jsonb, 'local_only', 'local/notes.md', '%s', 'local_only')
	`, artifactID, org, hash, deviceID))

	// This is the regression the IS DISTINCT FROM rewrite buys: with the old `<>`
	// comparison, NEW.content_ref IS NULL makes the predicate NULL, so attaching a
	// content reference to a local_only version slipped past the immutability
	// guard instead of failing it.
	_, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.artifact_version SET content_ref = 'artifact/late' WHERE artifact_id = '%s' AND version_no = 2",
		artifactID))
	assertPgMessage(t, err, "artifact_version_content_immutable")

	// Classification has exactly one writer path in the command layer; the row
	// itself must not be a downgrade channel.
	_, err = admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.artifact_version SET classification = 'remote_excerpt_allowed' WHERE artifact_id = '%s' AND version_no = 2",
		artifactID))
	assertPgMessage(t, err, "artifact_version_content_immutable")

	// A local_only version missing its device binding is refused, and an
	// unknown classification value is refused rather than defaulted.
	for _, insert := range []string{
		fmt.Sprintf(`INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_hash, bytes, media_type, state, provenance,
		   location, local_ref, classification)
		VALUES ('%s', '%s', 3, '%s', 1, 'text/markdown', 'staged', '{}'::jsonb,
		        'local_only', 'local/x.md', 'local_only')`, artifactID, org, hash),
		fmt.Sprintf(`INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_ref, content_hash, bytes, media_type, state, provenance,
		   location, classification)
		VALUES ('%s', '%s', 4, 'artifact/y', '%s', 1, 'text/markdown', 'staged', '{}'::jsonb,
		        'cloud', 'restricted')`, artifactID, org, hash),
	} {
		if _, err := admin.Exec(testContext(t), insert); err == nil {
			t.Fatal("artifact_version accepted a row outside its location and classification shape")
		}
	}
}

func TestR0bSupersedeShapeAndOneOpenStep(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_supersede"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)
	assertion := fmt.Sprintf("sha256:%s", repeatHex(t, 64))

	// seedRun's Operation is 'authorized' with step_key NULL, so it sits outside
	// the step index. Put it on a step first; the shape rule then wants the
	// logical key derived from step and supersede number.
	r0bExec(t, dbName, org, fmt.Sprintf(`
		UPDATE work.operation SET step_key = 'tool:7', supersede_no = 0,
		       logical_key = 'tool:7#0' WHERE id = '%s'
	`, run.opID))
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.operation WHERE id = $1 AND step_key IS NOT NULL`,
		run.opID); got != 1 {
		t.Fatalf("step key rows = %d, want 1", got)
	}

	// A logical key that does not match step_key || '#' || supersede_no is
	// refused, and cloud rows (step_key NULL) are exempt by design.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.operation SET logical_key = 'other:1' WHERE id = '%s'", run.opID)); err == nil {
		t.Fatal("a mismatched step logical key was accepted")
	}

	// A second open Operation on the same step is refused by the partial unique
	// index, which is what keeps "one un-finished action per step" enforceable.
	_, err := admin.Exec(testContext(t), fmt.Sprintf(`
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, step_key, supersede_no, kind, request_hash, state)
		VALUES ('%s', '%s', '%s', 'tool:7#1', 'tool:7', 1, 'tool', repeat('e', 64), 'prepared')
	`, newUUID(t), org, run.runID))
	if err == nil {
		t.Fatal("a second open Operation on one step was accepted")
	}

	// Only a supersede-shaped row may occupy the step: the assertion hash and the
	// reason travel together with the pointer.
	for _, insert := range []string{
		fmt.Sprintf(`INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, step_key, supersede_no, kind, request_hash, state,
		   supersedes_operation_id, supersede_reason)
		VALUES ('%s', '%s', '%s', 'tool:7#1', 'tool:7', 1, 'tool', repeat('e', 64), 'prepared',
		        '%s', 'reauthorized')`, newUUID(t), org, run.runID, run.opID),
		fmt.Sprintf(`INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, step_key, supersede_no, kind, request_hash, state,
		   supersedes_operation_id, supersede_reason, supersede_assertion_hash)
		VALUES ('%s', '%s', '%s', 'tool:7#9', 'tool:7', 1, 'tool', repeat('e', 64), 'prepared',
		        '%s', 'reauthorized', '%s')`, newUUID(t), org, run.runID, run.opID, assertion),
	} {
		if _, err := admin.Exec(testContext(t), insert); err == nil {
			t.Fatal("a malformed supersede row was accepted")
		}
	}

	// A well-formed supersede is still refused while the step holds an open
	// Operation, and lands once that Operation reaches a terminal state.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, step_key, supersede_no, kind, request_hash, state,
		   supersedes_operation_id, supersede_reason, supersede_assertion_hash)
		VALUES ('%s', '%s', '%s', 'tool:7#1', 'tool:7', 1, 'tool', repeat('e', 64), 'prepared',
		        '%s', 'reauthorized', '%s')
	`, newUUID(t), org, run.runID, run.opID, assertion)); err == nil {
		t.Fatal("a supersede was accepted while the step still held an open Operation")
	}
	replacement := newUUID(t)
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.operation SET state = 'canceled' WHERE id = '%s'", run.opID))
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, step_key, supersede_no, kind, request_hash, state,
		   supersedes_operation_id, supersede_reason, supersede_assertion_hash)
		VALUES ('%s', '%s', '%s', 'tool:7#1', 'tool:7', 1, 'tool', repeat('e', 64), 'prepared',
		        '%s', 'reauthorized', '%s')
	`, replacement, org, run.runID, run.opID, assertion))

	// One Operation may be superseded only once, so the chain cannot fork.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, step_key, supersede_no, kind, request_hash, state,
		   supersedes_operation_id, supersede_reason, supersede_assertion_hash)
		VALUES ('%s', '%s', '%s', 'tool:7#2', 'tool:7', 2, 'tool', repeat('f', 64), 'prepared',
		        '%s', 'source_changed', '%s')
	`, newUUID(t), org, run.runID, run.opID, assertion)); err == nil {
		t.Fatal("the same Operation was superseded twice")
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.operation WHERE supersedes_operation_id = $1`,
		run.opID); got != 1 {
		t.Fatalf("supersede rows for one Operation = %d, want 1", got)
	}
}

// TestR0bReconcileClockHasAWriter is the producer check for the column J16's wait
// duration depends on: entering unknown or unresolved stamps it, arriving by any of
// the R0a paths rather than by convention, and reaching a terminal state keeps the
// original entry time. A column nobody writes is a UI promise with nothing behind it.
func TestR0bReconcileClockHasAWriter(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_reconcile_clock"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	if got := scalarCount(t, admin, `SELECT count(*) FROM work.operation
		WHERE id = $1 AND reconcile_requested_at IS NOT NULL`, run.opID); got != 0 {
		t.Fatalf("clock set before any wait = %d, want 0", got)
	}

	r0bExec(t, dbName, org, fmt.Sprintf(`
		UPDATE work.operation SET state = 'dispatching' WHERE id = '%[1]s';
		UPDATE work.operation SET state = 'unknown' WHERE id = '%[1]s';
	`, run.opID))
	first := scalarString(t, admin, `SELECT COALESCE(reconcile_requested_at::text, 'null')
		FROM work.operation WHERE id = $1`, run.opID)
	if first == "null" {
		t.Fatal("dispatching -> unknown did not start the reconcile clock")
	}

	// Settling through reconciled must not erase when the wait began, and a second
	// entry into unknown keeps the first stamp rather than overwriting history.
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.operation SET state = 'reconciled' WHERE id = '%s'", run.opID))
	after := scalarString(t, admin, `SELECT reconcile_requested_at::text
		FROM work.operation WHERE id = $1`, run.opID)
	if after != first {
		t.Fatalf("clock changed across settlement: %q -> %q", first, after)
	}
}

func TestR0bResolutionMapGrantsAreReadOnly(t *testing.T) {
	dbName, admin := newGateDB(t)
	ctx := testContext(t)

	var count int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM work.resolution_state_map`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 8 {
		t.Fatalf("resolution map rows = %d, want 8", count)
	}

	app := connect(t, appURL(dbName))
	defer app.Close(ctx)
	if _, err := app.Exec(ctx, `SELECT count(*) FROM work.resolution_state_map`); err != nil {
		t.Fatalf("work_api cannot read the resolution map: %v", err)
	}
	// No service role writes the whitelist; only the migration owner can.
	_, err := app.Exec(ctx,
		`INSERT INTO work.resolution_state_map (resolution_state, operation_state)
		 VALUES ('succeeded', 'canceled')`)
	assertPermissionDenied(t, err)

	worker := connect(t, testpg.WorkerURL(dbName))
	defer worker.Close(ctx)
	_, err = worker.Exec(ctx,
		`DELETE FROM work.resolution_state_map WHERE resolution_state = 'failed'`)
	assertPermissionDenied(t, err)
}

func assertPermissionDenied(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected the statement to be refused")
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("error = %v, want a PostgreSQL error", err)
	}
	if pgErr.Code != "42501" {
		t.Fatalf("sqlstate = %q message = %q, want 42501 insufficient_privilege",
			pgErr.Code, pgErr.Message)
	}
}

// TestEveryWorkFunctionHasAnExplicitAcl closes the one grant class the catalog
// checkpoint cannot see: a function with a NULL proacl still carries PostgreSQL's
// implicit PUBLIC EXECUTE, and aclexplode(NULL) returns no rows, so both the
// catalog and a reviewer reading it see nothing. Baseline revokes PUBLIC once for
// everything that exists at that point; each increment must revoke its own.
func TestEveryWorkFunctionHasAnExplicitAcl(t *testing.T) {
	_, admin := newGateDB(t)
	var offenders []string
	rows, err := admin.Query(testContext(t), `
		SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'work' AND p.proacl IS NULL
		ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		offenders = append(offenders, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(offenders) > 0 {
		t.Fatalf("work functions left on the default (PUBLIC-executable) ACL: %v", offenders)
	}
}

func repeatHex(t *testing.T, length int) string {
	t.Helper()
	if length != 64 {
		t.Fatalf("unexpected hash length %d", length)
	}
	value := ""
	for i := 0; i < length/4; i++ {
		value += "abcd"
	}
	return value
}
