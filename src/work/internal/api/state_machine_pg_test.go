package api_test

import (
	"testing"
)

// work.state_transition (baseline/0002:490-545) plus enforce_state_transition (:546-563) and
// enforce_approval_transition (:571-588) decide which lifecycle moves are legal for task, run,
// operation and approval. Nothing asserted a refusal: grep for invalid_transition across the
// test tree turned up only R0b's governance rows and the artifact_version case written today,
// so deleting any of these four triggers - or inserting one extra edge row - would have left
// the suite green.
//
// That matters most for the edges that do not exist: a finished run going back to 'active', a
// completed task going back to 'open', a succeeded operation going back to 'authorized'. Those
// are exactly the writes a reconciliation bug or a hand-run UPDATE would produce, and the
// state machine is the only thing between them and the ledger, the timeline and the quota
// accounting that assume a terminal state stays terminal.
//
// Every illegal edge is paired with the legal path that leads to it, so the case cannot pass
// because a row is stuck in the wrong state, and the no-op update (state = state) is asserted
// as allowed because the trigger returns early on it - a fact worth pinning now that something
// depends on touching a row without moving it.

const (
	smTask    = "11111111-1111-4111-8111-777777777777"
	smInput   = "31111111-1111-4111-8111-777777777777"
	smSnap    = "41111111-1111-4111-8111-777777777777"
	smRun     = "c1111111-1111-4111-8111-888888888888"
	smRunID   = "wf-state-machine"
	smOp      = "c1111111-1111-4111-8111-999999999999"
	smApprov  = "c1111111-1111-4111-8111-aaaaaaaaaaaa"
	smApprov2 = "c1111111-1111-4111-8111-bbbbbbbbbbbb"
)

// seedStateMachine builds one task with its own snapshot and a queued run, plus two approvals
// in 'pending'. Nothing is pointed at as a task's active run, so the terminal moves below
// cannot be confused with the active_run_id bookkeeping rules; the operation arms use the
// seeded run A, which is the run its task actually marks active.
func seedStateMachine(t *testing.T, dbName string) {
	t.Helper()
	owner := func(what, statement string) {
		t.Helper()
		if _, err := ownerExec(dbName, statement); err != nil {
			t.Fatalf("%s: %v", what, err)
		}
	}
	owner("seed the state-machine input", `
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('`+smInput+`', 'org_a', 'sub_a', 'content://sm', 'sha256:sm', 10)`)
	owner("seed the state-machine task", `
		INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode, title,
		                       input_id, revision)
		VALUES ('`+smTask+`', 'org_a', 'sub_a', 'open', 'ask_each', 'State machine task',
		        '`+smInput+`', 0)`)
	owner("bind the input", `
		UPDATE work.input_object SET task_id = '`+smTask+`' WHERE id = '`+smInput+`'`)
	owner("seed the snapshot", `
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		VALUES ('`+smSnap+`', 'org_a', '`+smTask+`', 'test', 'sha256:sm',
		        ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`)
	owner("point the task at the snapshot", `
		UPDATE work.task SET snapshot_id = '`+smSnap+`' WHERE id = '`+smTask+`'`)
	owner("seed the queued run", `
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('`+smRun+`', 'org_a', '`+smTask+`', 1, 'queued', '`+smSnap+`',
		        '`+smRunID+`', 'test')`)
	owner("seed the pending approval", `
		INSERT INTO work.approval
		  (id, org_id, target_type, plan_version_id, params_hash, scope, risk,
		   expires_at, policy_epoch, status)
		VALUES ('`+smApprov+`', 'org_a', 'operation', NULL, 'sha256:sm',
		        '{}'::jsonb, 'low', now() + interval '1 hour', 1, 'pending'),
		       ('`+smApprov2+`', 'org_a', 'operation', NULL, 'sha256:sm2',
		        '{}'::jsonb, 'low', now() + interval '1 hour', 1, 'pending')`)
}

func stateOf(t *testing.T, dbName, table, column, id string) string {
	t.Helper()
	return opsScalar(t, dbName, `SELECT `+column+` FROM work.`+table+` WHERE id = $1::uuid`, id)
}

func transitionRefused(t *testing.T, dbName, statement, want string, args ...any) {
	t.Helper()
	rows, err := ownerExec(dbName, statement, args...)
	if err == nil {
		t.Fatalf("statement touched %d rows, want refusal %q: %s", rows, want, statement)
	}
	pgErr := opsPgError(t, err)
	if pgErr.SQLState() != "23514" || pgErr.Message != want {
		t.Fatalf("refusal = %s %q, want 23514 %q", pgErr.SQLState(), pgErr.Message, want)
	}
}

func transitionAllowed(t *testing.T, dbName, statement string, args ...any) {
	t.Helper()
	if _, err := ownerExec(dbName, statement, args...); err != nil {
		t.Fatalf("legal transition refused: %v (%s)", err, statement)
	}
}

func TestStateMachineRefusesEveryIllegalLifecycleEdge(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	seedStateMachine(t, dbName)

	// Run: queued -> waiting has no edge, even though both are non-terminal.
	transitionRefused(t, dbName,
		`UPDATE work.run SET state = 'waiting' WHERE id = $1::uuid`,
		"invalid_transition:run:queued->waiting", smRun)
	transitionAllowed(t, dbName,
		`UPDATE work.run SET state = 'active' WHERE id = $1::uuid`, smRun)
	// Operations have to hang off the task's active run, not merely a run in 'active' - the
	// first draft of this case tried the state-machine run and was refused by
	// enforce_operation_creation - so they are created against the seeded run A, whose task
	// does point at it. The run arms keep using their own row for the same reason.
	transitionAllowed(t, dbName, `
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, kind, request_hash, state, revision)
		VALUES ('`+smOp+`', 'org_a', '`+runA+`', 'model:sm', 'model',
		        'sha256:sm-op', 'prepared', 0)`)

	// A run parked for approval comes back, but cannot be pushed back into the queue.
	transitionAllowed(t, dbName,
		`UPDATE work.run SET state = 'waiting', wait_reason = 'approval' WHERE id = $1::uuid`, smRun)
	transitionRefused(t, dbName,
		`UPDATE work.run SET state = 'queued' WHERE id = $1::uuid`,
		"invalid_transition:run:waiting->queued", smRun)
	transitionAllowed(t, dbName,
		`UPDATE work.run SET state = 'active', wait_reason = NULL WHERE id = $1::uuid`, smRun)

	// Terminal is terminal: once a run reports a result it cannot run again, and the
	// accounting that treats 'succeeded' as final keeps holding.
	transitionAllowed(t, dbName,
		`UPDATE work.run SET state = 'succeeded', terminal_reason = 'succeeded' WHERE id = $1::uuid`,
		smRun)
	for _, to := range []string{"active", "queued", "waiting", "cancel_requested"} {
		transitionRefused(t, dbName,
			`UPDATE work.run SET state = '`+to+`' WHERE id = $1::uuid`,
			"invalid_transition:run:succeeded->"+to, smRun)
	}
	if got := stateOf(t, dbName, "run", "state", smRun); got != "succeeded" {
		t.Fatalf("run state after the re-open attempts = %q, want succeeded", got)
	}

	// Operation: back-steps are refused at every stage, including after success.
	transitionRefused(t, dbName,
		`UPDATE work.operation SET state = 'dispatching' WHERE id = $1::uuid`,
		"invalid_transition:operation:prepared->dispatching", smOp)
	transitionAllowed(t, dbName,
		`UPDATE work.operation SET state = 'authorized' WHERE id = $1::uuid`, smOp)
	transitionRefused(t, dbName,
		`UPDATE work.operation SET state = 'prepared' WHERE id = $1::uuid`,
		"invalid_transition:operation:authorized->prepared", smOp)
	transitionAllowed(t, dbName,
		`UPDATE work.operation SET state = 'dispatching' WHERE id = $1::uuid`, smOp)
	transitionAllowed(t, dbName,
		`UPDATE work.operation SET state = 'succeeded' WHERE id = $1::uuid`, smOp)
	transitionRefused(t, dbName,
		`UPDATE work.operation SET state = 'authorized' WHERE id = $1::uuid`,
		"invalid_transition:operation:succeeded->authorized", smOp)

	// Task: the acceptance round-trip is legal in both directions, and archival is final.
	transitionAllowed(t, dbName,
		`UPDATE work.task SET state = 'awaiting_acceptance' WHERE id = $1::uuid`, smTask)
	transitionAllowed(t, dbName,
		`UPDATE work.task SET state = 'open' WHERE id = $1::uuid`, smTask)
	transitionAllowed(t, dbName,
		`UPDATE work.task SET state = 'completed' WHERE id = $1::uuid`, smTask)
	transitionRefused(t, dbName,
		`UPDATE work.task SET state = 'open' WHERE id = $1::uuid`,
		"invalid_transition:task:completed->open", smTask)
	transitionAllowed(t, dbName,
		`UPDATE work.task SET state = 'archived' WHERE id = $1::uuid`, smTask)
	transitionRefused(t, dbName,
		`UPDATE work.task SET state = 'completed' WHERE id = $1::uuid`,
		"invalid_transition:task:archived->completed", smTask)

	// Approval: one decision is final, and the other four outcomes are reachable only from
	// pending. A second engineer deciding the same approval is the real failure mode.
	transitionAllowed(t, dbName,
		`UPDATE work.approval SET status = 'approved' WHERE id = $1::uuid`, smApprov)
	transitionRefused(t, dbName,
		`UPDATE work.approval SET status = 'rejected' WHERE id = $1::uuid`,
		"invalid_transition:approval:approved->rejected", smApprov)
	transitionRefused(t, dbName,
		`UPDATE work.approval SET status = 'pending' WHERE id = $1::uuid`,
		"invalid_transition:approval:approved->pending", smApprov)
	transitionAllowed(t, dbName,
		`UPDATE work.approval SET status = 'expired' WHERE id = $1::uuid`, smApprov2)
	if got := stateOf(t, dbName, "approval", "status", smApprov); got != "approved" {
		t.Fatalf("approval status after the refusals = %q, want approved", got)
	}

	// The trigger returns early when the state does not move, so a touch that keeps the value
	// legal - and nothing else about the lifecycle - stays possible.
	transitionAllowed(t, dbName,
		`UPDATE work.run SET state = state, runtime_version = 'test2' WHERE id = $1::uuid`, smRun)
	if got := opsScalar(t, dbName,
		`SELECT state || '/' || runtime_version FROM work.run WHERE id = $1::uuid`, smRun); got !=
		"succeeded/test2" {
		t.Fatalf("run after the same-state update = %q, want succeeded with the version moved", got)
	}
}
