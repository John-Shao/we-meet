package api_test

import (
	"testing"
)

// work.enforce_org_execution (baseline/0002:2685-2699) is the row-level kill switch. Five arms
// refuse a write with org_execution_unavailable (P0001) unless the organization is active,
// execution_enabled and not operator_suspended:
//
//	run_org_execution_insert        BEFORE INSERT  ON work.run               (0002:2701)
//	run_org_execution_active        BEFORE UPDATE OF state ON work.run, when
//	                                a run enters 'active'                   (0002:2704)
//	operation_org_execution_insert  BEFORE INSERT  ON work.operation        (0002:2710)
//	operation_org_execution_start   BEFORE UPDATE OF state ON work.operation,
//	                                when it enters authorized/dispatching   (0002:2713)
//	reservation_org_execution       BEFORE INSERT  ON work.quota_reservation (0002:2719)
//
// R0a had asserted the endpoint half only: audit_export_gate_pg_test.go proves the API answers
// 403 org_execution_unavailable for a disabled or archived org, and internal/migrate covers
// R0b's governance rows. Nothing pinned the database arms - which is the control that exists
// precisely for a writer that skips the domain commands' own checks. And the only role that can
// write these tables at all is work_owner, the identity every SECURITY DEFINER command runs as
// (permission snapshot: migrations/catalogs/0027).
//
// Every refusal is paired with the same write succeeding once the organization is switched back
// on, so the case cannot be satisfied by a blanket block, and the rows it pushes are the ones
// the dispatch path actually touches.

const (
	guardTaskF      = "11111111-1111-4111-8111-666666666666"
	guardInputF     = "31111111-1111-4111-8111-666666666666"
	guardSnapF      = "41111111-1111-4111-8111-666666666666"
	guardRunF       = "c1111111-1111-4111-8111-111111111111"
	guardRunQueued  = "c1111111-1111-4111-8111-222222222222"
	guardSnapshotB  = "41111111-1111-4111-8111-222222222222"
	guardOperation  = "c1111111-1111-4111-8111-333333333333"
	guardOperation2 = "c1111111-1111-4111-8111-444444444444"
)

// guardSeed writes the row types the gate guards while the organization is still
// switchable-on, respecting two ordering rules instead of working around them: an operation
// may only be created against an active run (so it hangs off the seeded run A), and every new
// run belongs to its own task, because a task may hold only one open run.
func guardSeed(t *testing.T, dbName string) {
	t.Helper()
	owner := func(what, statement string) {
		t.Helper()
		if _, err := ownerExec(dbName, statement); err != nil {
			t.Fatalf("%s: %v", what, err)
		}
	}
	owner("seed task F's input", `
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('`+guardInputF+`', 'org_a', 'sub_a', 'content://f', 'sha256:f', 10)`)
	owner("seed task F", `
		INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode, title,
		                       input_id, revision)
		VALUES ('`+guardTaskF+`', 'org_a', 'sub_a', 'open', 'ask_each', 'Guard task',
		        '`+guardInputF+`', 0)`)
	owner("bind task F's input to it", `
		UPDATE work.input_object SET task_id = '`+guardTaskF+`' WHERE id = '`+guardInputF+`'`)
	owner("seed task F's snapshot", `
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		VALUES ('`+guardSnapF+`', 'org_a', '`+guardTaskF+`', 'test', 'sha256:f',
		        ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`)
	owner("point task F at its snapshot", `
		UPDATE work.task SET snapshot_id = '`+guardSnapF+`' WHERE id = '`+guardTaskF+`'`)
	owner("seed task B's snapshot", `
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		VALUES ('`+guardSnapshotB+`', 'org_a', '`+taskB+`', 'test', 'sha256:b',
		        ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`)
	owner("point task B at its snapshot", `
		UPDATE work.task SET snapshot_id = '`+guardSnapshotB+`' WHERE id = '`+taskB+`'`)
	owner("seed the queued run on task B", `
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('`+guardRunQueued+`', 'org_a', '`+taskB+`', 1, 'queued',
		        '`+guardSnapshotB+`', 'wf-guard-queued', 'test')`)
	owner("seed the prepared operation on the active run A", `
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, kind, request_hash, state, revision)
		VALUES ('`+guardOperation+`', 'org_a', '`+runA+`', 'model:1', 'model',
		        'sha256:guard-op', 'prepared', 0)`)
}

func guardRefused(t *testing.T, dbName, statement string, args ...any) {
	t.Helper()
	rows, err := ownerExec(dbName, statement, args...)
	if err == nil {
		t.Fatalf("guarded write touched %d rows while the org is switched off, want "+
			"org_execution_unavailable: %s", rows, statement)
	}
	if pgErr := opsPgError(t, err); pgErr.SQLState() != "P0001" ||
		pgErr.Message != "org_execution_unavailable" {
		t.Fatalf("guard refusal = %s %q, want P0001 org_execution_unavailable",
			pgErr.SQLState(), pgErr.Message)
	}
}

func TestOrgExecutionGateCoversEveryRowArm(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	guardSeed(t, dbName)

	// A quota reservation needs an account; provisioning already opened the org's default one
	// for the current period, so it is resolved rather than invented.
	accountID := opsScalar(t, dbName, `
		SELECT id::text FROM work.quota_account WHERE org_id = 'org_a' ORDER BY created_at LIMIT 1`)
	if _, err := ownerExec(dbName, `
		INSERT INTO work.quota_reservation
		  (id, org_id, account_id, operation_id, reservation_seq, amount_tokens, state)
		VALUES ('c1111111-1111-4111-8111-666666666666', 'org_a', $1::uuid, $2::uuid, 1, 50, 'held')`,
		accountID, guardOperation); err != nil {
		t.Fatalf("seed the reservation while the org is enabled: %v", err)
	}

	// Switch the organization off the way the operator switch does it: operator_suspended
	// alone, so a refusal cannot be blamed on the other flag.
	setOrgFlags(t, dbName, "operator_suspended = true")

	guardRefused(t, dbName, `
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('`+guardRunF+`', 'org_a', '`+guardTaskF+`', 1, 'queued',
		        '`+guardSnapF+`', 'wf-guard-f', 'test')`)
	guardRefused(t, dbName, `
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, kind, request_hash, state, revision)
		VALUES ('`+guardOperation2+`', 'org_a', '`+runA+`', 'model:2', 'model',
		        'sha256:guard-op-2', 'prepared', 0)`)
	guardRefused(t, dbName, `
		INSERT INTO work.quota_reservation
		  (id, org_id, account_id, operation_id, reservation_seq, amount_tokens, state)
		VALUES ('c1111111-1111-4111-8111-777777777777', 'org_a', $1::uuid, $2::uuid, 1, 50, 'held')`,
		accountID, guardOperation)
	// The two UPDATE arms fire only on the way into an executing state, so the rows that
	// already exist are the ones to push.
	guardRefused(t, dbName,
		`UPDATE work.run SET state = 'active' WHERE id = $1::uuid`, guardRunQueued)
	guardRefused(t, dbName,
		`UPDATE work.operation SET state = 'authorized' WHERE id = $1::uuid`, guardOperation)

	// Not one of them moved: each refusal aborted its own statement.
	if got := opsScalar(t, dbName, `
		SELECT count(*)::text || '/' ||
		       coalesce((SELECT state FROM work.run WHERE id = '`+guardRunQueued+`'), '-')
		FROM work.run WHERE org_id = 'org_a'`); got != "3/queued" {
		t.Fatalf("runs after the refusals = %s, want the three seeded runs with the queued one "+
			"still queued", got)
	}
	if got := opsScalar(t, dbName, `
		SELECT count(*)::text || '/' ||
		       coalesce((SELECT state FROM work.operation WHERE id = '`+guardOperation+`'), '-') ||
		       '/' || (SELECT count(*) FROM work.quota_reservation)::text
		FROM work.operation WHERE org_id = 'org_a'`); got != "1/prepared/1" {
		t.Fatalf("operations after the refusals = %s, want one prepared operation and one "+
			"reservation", got)
	}

	// execution_enabled = false and a non-active org status are the other two arms of the same
	// condition, and each has to refuse on its own.
	setOrgFlags(t, dbName, "operator_suspended = false, execution_enabled = false")
	guardRefused(t, dbName, `
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, kind, request_hash, state, revision)
		VALUES ('`+guardOperation2+`', 'org_a', '`+runA+`', 'model:2', 'model',
		        'sha256:guard-op-2', 'prepared', 0)`)
	setOrgFlags(t, dbName, "execution_enabled = true, status = 'suspended'")
	guardRefused(t, dbName,
		`UPDATE work.run SET state = 'active' WHERE id = $1::uuid`, guardRunQueued)

	// Back on, the same writes go through - the pair that separates a conditional gate from a
	// permanent block, and the proof that a run can still be dispatched after a suspension is
	// lifted without touching data.
	setOrgFlags(t, dbName, "status = 'active'")
	if _, err := ownerExec(dbName, `
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('`+guardRunF+`', 'org_a', '`+guardTaskF+`', 1, 'queued',
		        '`+guardSnapF+`', 'wf-guard-f', 'test')`); err != nil {
		t.Fatalf("inserting a run after the org came back: %v", err)
	}
	if _, err := ownerExec(dbName,
		`UPDATE work.run SET state = 'active' WHERE id = $1::uuid`, guardRunQueued); err != nil {
		t.Fatalf("starting the run after the org came back: %v", err)
	}
	if got := opsScalar(t, dbName,
		`SELECT state FROM work.run WHERE id = $1::uuid`, guardRunQueued); got != "active" {
		t.Fatalf("run state after the org came back = %q, want active", got)
	}
}
