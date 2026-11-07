package runflow_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/runflow"
	"github.com/we-meet/work/internal/testpg"
)

// parkedAdvance is the state the 2026-11-06 SIGKILL drill left in production (pilot run
// e24eb42c, execution d2c73e8e): the answer and its receipt are durable, the Run parked in
// wait_reason='reconcile', and the operator signal only arrived 2h27m after the fragment's
// hard deadline. Every reading in that sentence came from the drill attachment: claim at
// 08:44:23 with hard_deadline 09:14:23, SIGKILL at 08:44:24, takeover at 08:48:33 (increment
// 0028 working), resume at 11:41:56.
type parkedAdvance struct {
	activities *runflow.Activities
	pool       *pgxpool.Pool
	admin      *pgx.Conn
	prepared   runflow.AdvancePrepared
	head       runflow.AdvanceHead
	execution  runflow.AdvanceExecution
}

// parkAdvancePastDeadline drives the flow through execute and egress, then waits the
// deadline out. hard_deadline is a binding column, so the window cannot be shortened after
// the fact: register_runtime_execution also refuses an already past deadline
// (migrations/increments/0009_runtime_execution_dispatch_gate.sql:585-587). The only honest
// fixture is a short window registered up front and then waited out, which is the method
// internal/authz/lease_takeover_pg_test.go:55 already uses.
func parkAdvancePastDeadline(t *testing.T) *parkedAdvance {
	t.Helper()
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedAdvanceTask(t, dbName, store)
	activities := newAdvanceActivities(pool, store)
	activities.ExecuteDeadline = 3 * time.Second
	ctx := context.Background()

	prepared, err := activities.PrepareAdvance(ctx, runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	head, err := activities.EnsureAdvanceHead(ctx, prepared)
	if err != nil {
		t.Fatal(err)
	}
	execution, err := activities.PrepareAdvanceExecution(ctx, runflow.PrepareExecutionInput{
		Prepared: prepared, Head: head,
	})
	if err != nil {
		t.Fatal(err)
	}
	seedAdvanceEgress(t, pool, store, egressSeed{
		OrgID: prepared.OrgID, TaskID: prepared.TaskID, RunID: prepared.RunID,
		SnapshotID: prepared.SnapshotID, RuntimeVersion: prepared.RuntimeVersion,
		ExecutionID: execution.ExecutionID, OperationID: execution.OperationID,
		AttemptID: execution.AttemptID, RequestHash: execution.RequestHash,
		Fence: prepared.Fence,
	})
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })

	// The lease was already capped at the deadline, so waiting the window out leaves exactly
	// the row production showed: still 'active', lease over, deadline over, held by the parent
	// that never came back. Nothing is forged here.
	time.Sleep(4 * time.Second)
	var parked int64
	if err := admin.QueryRow(ctx, `
		SELECT count(*) FROM work.runtime_execution
		WHERE org_id = $1 AND execution_id = $2
		  AND state = 'active' AND lease_until <= clock_timestamp()
		  AND hard_deadline <= clock_timestamp()`,
		flowOrg, execution.ExecutionID).Scan(&parked); err != nil {
		t.Fatal(err)
	}
	if parked != 1 {
		t.Fatalf("fixture did not leave an active execution past both lease and hard deadline (rows=%d)", parked)
	}
	// The gate must already show the send as done, otherwise these tests would be asking the
	// code to permit a second call.
	var gate int64
	if err := admin.QueryRow(ctx, `
		SELECT count(*) FROM work.dispatch_delivery
		WHERE execution_id = $1 AND gate_state = 'receipt_recorded'`, execution.ExecutionID).
		Scan(&gate); err != nil {
		t.Fatal(err)
	}
	if gate != 1 {
		t.Fatalf("receipt_recorded gate rows = %d, want 1 before finish", gate)
	}
	return &parkedAdvance{activities: activities, pool: pool, admin: admin,
		prepared: prepared, head: head, execution: execution}
}

// TestAdvanceFinishCommitsDurableAnswerAfterParkingPastDeadline pins the ruled behaviour for
// #82 (F1): a durable success receipt is proof the step was already paid for, so the finish
// must commit it instead of leaving a Run nothing can ever terminalise. The deadline keeps
// forbidding a late re-dispatch - this path sends nothing again - which the gate assertions
// below pin.
//
// It is red today with ErrCode finish_head_conflict, the same symptom production showed at
// 11:41:56: commitHead is refused (0009:1284 guards lease AND hard_deadline), the reclaim
// fallback cannot claim either (0028:127 refuses the takeover past the deadline), and the
// activity reports the conflict.
func TestAdvanceFinishCommitsDurableAnswerAfterParkingPastDeadline(t *testing.T) {
	parked := parkAdvancePastDeadline(t)
	ctx := context.Background()

	finished, err := parked.activities.FinishAdvance(ctx, runflow.AdvanceFinishInput{
		Prepared: parked.prepared, Head: parked.head, Execution: parked.execution,
	})
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != runflow.AdvanceStatusSucceeded || finished.HeadRevision != 1 ||
		finished.ArtifactID == "" || finished.VersionNo != 1 {
		t.Fatalf("finish after parking past the hard deadline = %#v, want the paid-for answer committed",
			finished)
	}

	// Head is revision 1, committed by the finish holder, on the same execution.
	row := readAdvanceHeadRow(t, parked.pool, flowOrg, flowRun)
	if row.Revision != 1 || row.Ref != finished.HeadRef || row.Hash != finished.HeadHash ||
		row.ExecutionID != parked.execution.ExecutionID {
		t.Fatalf("head row = %#v", row)
	}
	var state, holder string
	if err := parked.admin.QueryRow(ctx, `
		SELECT state, holder_id FROM work.runtime_execution
		WHERE org_id = $1 AND execution_id = $2`, flowOrg, parked.execution.ExecutionID).
		Scan(&state, &holder); err != nil {
		t.Fatal(err)
	}
	if state != "completed" {
		t.Fatalf("execution state after finish = %q", state)
	}
	// The commit does not take the lease over. A takeover is how a worker acquires the right
	// to do work that is not yet done; here there is no work left to do, so the row keeps the
	// holder that died. If this ever reads "work-worker-finish:...", the arm stopped being a
	// bookkeeping commit and became a re-drive, which is what the deadline forbids.
	if holder != "work-fake-parent" {
		t.Fatalf("holder after the past-deadline commit = %q, want the dead parent untouched", holder)
	}
	// What distinguishes the narrow arm from a blanket deadline removal: the revision-1 commit
	// says out loud that it fired because a success receipt was already bound to this
	// execution. Revision 0 (EnsureAdvanceHead, while the lease was live) must keep saying
	// false, so the predicate is pinned to the row that actually went past the deadline.
	var afterDeadline string
	if err := parked.admin.QueryRow(ctx, `
		SELECT metadata->>'durable_receipt_after_deadline' FROM work.audit_event
		WHERE org_id = $1 AND action = 'runtime.checkpoint_committed' AND target_id = $2
		  AND metadata->>'checkpoint_revision' = '1'`,
		flowOrg, flowRun).Scan(&afterDeadline); err != nil {
		t.Fatal(err)
	}
	if afterDeadline != "true" {
		t.Fatalf("durable_receipt_after_deadline = %q, want true", afterDeadline)
	}

	// The narrowing that must not regress: committing a paid-for answer re-sends nothing. This
	// is what distinguishes the fix from a build that simply ignores the deadline and calls the
	// provider again.
	var gateAfter, recorded, consumptions int64
	if err := parked.admin.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE gate_state = 'receipt_recorded'),
		       (SELECT count(*) FROM work.audit_event
		        WHERE action = 'dispatch.gate_consumed'
		          AND target_id IN (SELECT operation_id::text FROM work.dispatch_delivery
		                            WHERE execution_id = $1))
		FROM work.dispatch_delivery WHERE execution_id = $1`, parked.execution.ExecutionID).
		Scan(&gateAfter, &recorded, &consumptions); err != nil {
		t.Fatal(err)
	}
	if gateAfter != 1 || recorded != 1 {
		t.Fatalf("gate rows=%d receipt_recorded=%d after finish, want 1 and 1", gateAfter, recorded)
	}
	if consumptions != 1 {
		t.Fatalf("dispatch.gate_consumed audit rows=%d, want exactly 1 (no re-send)", consumptions)
	}

	// The Run is terminalisable now: finish_run accepts the paid-for outcome. This is the
	// symptom the drill actually left behind - an 'active' Run whose artifact was published.
	if err := parked.activities.FinishRun(ctx, runflow.FinishRunInput{
		RunID: flowRun, OrgID: flowOrg, Outcome: "succeeded",
	}); err != nil {
		t.Fatalf("finish_run after the resumed finish: %v", err)
	}
	if runState := readFlowRunState(t, parked.pool); runState != "succeeded" {
		t.Fatalf("run state = %q, want succeeded", runState)
	}
}

// TestAbortRunClosesRunAfterFinishRefusalPastDeadline pins the half of #82 that the ruling
// made mandatory alongside F1: when the finish cannot commit, the cleanup chain still has to
// terminalise the Run. Production showed the opposite - finish_head_conflict, then three
// abort_run_failed, then a Run left 'active' with a published artifact, which is a wrong
// state rather than a wrong bill. The raw cause never reached the operator because
// activityFailure strips it before Temporal history.
func TestAbortRunClosesRunAfterFinishRefusalPastDeadline(t *testing.T) {
	parked := parkAdvancePastDeadline(t)
	ctx := context.Background()

	if _, err := parked.activities.FinishAdvance(ctx, runflow.AdvanceFinishInput{
		Prepared: parked.prepared, Head: parked.head, Execution: parked.execution,
	}); err != nil {
		t.Fatal(err)
	}
	// What advance.go:367 hands the cleanup path on its way out: the operation id, the
	// reservation id, failed as the outcome and the error code as the reason.
	if err := parked.activities.AbortRun(ctx, runflow.AbortRunInput{
		RunID: flowRun, OrgID: flowOrg,
		OperationID: parked.execution.OperationID, ReservationID: parked.execution.ReservationID,
		Outcome: "failed", Reason: "finish_head_conflict",
	}); err != nil {
		t.Fatalf("abort after the refused finish: %v", err)
	}
	var state, reason string
	if err := workdb.WithWorkerOrgContext(ctx, parked.pool, flowOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT state, COALESCE(terminal_reason, '') FROM work.run
			WHERE id = $1 AND org_id = $2`, flowRun, flowOrg).Scan(&state, &reason)
	}); err != nil {
		t.Fatal(err)
	}
	if state != "failed" || reason == "" {
		t.Fatalf("run after the cleanup chain = %q/%q, want failed with a reason", state, reason)
	}
}

func readFlowRunState(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var state string
	if err := workdb.WithWorkerOrgContext(context.Background(), pool, flowOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT state FROM work.run WHERE id = $1 AND org_id = $2`, flowRun, flowOrg).Scan(&state)
	}); err != nil {
		t.Fatal(err)
	}
	return state
}
