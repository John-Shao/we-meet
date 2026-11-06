package runflow_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/runflow"
	"github.com/we-meet/work/internal/testpg"
)

// TestAdvanceFinishCommitsDurableAnswerAfterParkingPastDeadline reproduces what the
// 2026-11-06 SIGKILL drill left in production (pilot run e24eb42c, execution d2c73e8e).
//
// Production sequence, every reading from the drill attachment: the execute step claimed
// its lease at 08:44:23 with hard_deadline 09:14:23; the server was SIGKILLed at 08:44:24;
// the lease elapsed and the step was taken over at 08:48:33 (increment 0028 working); the
// answer and its receipt stayed durable; the Run then parked in wait_reason='reconcile'
// until an operator resumed it at 11:41:56, 2h27m past the hard deadline. FinishAdvance
// published the artifact and settled the Operation from the receipt, but the head commit
// was refused because claim_runtime_execution rejects `hard_deadline <= now()` even in the
// takeover shape, so reclaim never ran and the activity returned finish_head_conflict. The
// workflow failed, AbortRun could not close the Run either (abort_run_failed x3), and the
// Run stayed 'active' with a published artifact.
//
// Ruled behaviour (#82 = F1): a durable success receipt is proof the step was already paid
// for, so the finish must commit it instead of leaving a Run nothing can ever terminalise.
// The deadline keeps forbidding a late re-dispatch - this path sends nothing again - which
// is what the gate assertions below pin.
func TestAdvanceFinishCommitsDurableAnswerAfterParkingPastDeadline(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedAdvanceTask(t, dbName, store)
	activities := newAdvanceActivities(pool, store)
	ctx := context.Background()

	// hard_deadline is a binding column, so the deadline can only be made to pass by
	// registering it short and waiting it out - the method internal/authz uses for its
	// takeover cases. Production used the full 30 minute window and the operator signal
	// arrived 2h27m after the deadline.
	activities.ExecuteDeadline = 3 * time.Second

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
	// The provider answer and its receipt are durable: this is the paid-for step.
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
	defer func() { _ = admin.Close(context.Background()) }()

	// Nothing is forged here. The lease was already capped at the deadline, so waiting the
	// window out leaves exactly the row production showed: still 'active', lease over,
	// deadline over, held by the parent that never came back.
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
	// The gate must already show the send as done before finish runs, otherwise this test
	// would be asking the fix to permit a second call.
	var gateBefore, recordedBefore int64
	if err := admin.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE gate_state = 'receipt_recorded')
		FROM work.dispatch_delivery WHERE execution_id = $1`, execution.ExecutionID).
		Scan(&gateBefore, &recordedBefore); err != nil {
		t.Fatal(err)
	}
	if gateBefore != 1 || recordedBefore != 1 {
		t.Fatalf("gate rows=%d receipt_recorded=%d, want 1 and 1 before finish", gateBefore, recordedBefore)
	}

	finished, err := activities.FinishAdvance(ctx, runflow.AdvanceFinishInput{
		Prepared: prepared, Head: head, Execution: execution,
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
	row := readAdvanceHeadRow(t, pool, flowOrg, flowRun)
	if row.Revision != 1 || row.Ref != finished.HeadRef || row.Hash != finished.HeadHash ||
		row.ExecutionID != execution.ExecutionID {
		t.Fatalf("head row = %#v", row)
	}
	var state, holder string
	if err := admin.QueryRow(ctx, `
		SELECT state, holder_id FROM work.runtime_execution
		WHERE org_id = $1 AND execution_id = $2`, flowOrg, execution.ExecutionID).
		Scan(&state, &holder); err != nil {
		t.Fatal(err)
	}
	if state != "completed" {
		t.Fatalf("execution state after finish = %q", state)
	}
	if want := "work-worker-finish:" + execution.ExecutionID; holder != want {
		t.Fatalf("holder after finish = %q, want the reclaiming holder %q", holder, want)
	}

	// The narrowing that must not regress: committing a paid-for answer re-sends nothing.
	// The gate row count and its consumed-once state are what distinguishes this from a
	// build that simply ignores the deadline and dispatches again.
	var gateAfter, recorded, consumptions int64
	if err := admin.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE gate_state = 'receipt_recorded'),
		       (SELECT count(*) FROM work.audit_event
		        WHERE action = 'dispatch.gate_consumed'
		          AND target_id IN (SELECT operation_id::text FROM work.dispatch_delivery
		                            WHERE execution_id = $1))
		FROM work.dispatch_delivery WHERE execution_id = $1`, execution.ExecutionID).
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
	if err := activities.FinishRun(ctx, runflow.FinishRunInput{
		RunID: flowRun, OrgID: flowOrg, Outcome: "succeeded",
	}); err != nil {
		t.Fatalf("finish_run after the resumed finish: %v", err)
	}
	var runState string
	if err := workdb.WithWorkerOrgContext(ctx, pool, flowOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM work.run WHERE id = $1 AND org_id = $2`,
			flowRun, flowOrg).Scan(&runState)
	}); err != nil {
		t.Fatal(err)
	}
	if runState != "succeeded" {
		t.Fatalf("run state = %q, want succeeded", runState)
	}
}
