package runflow_test

import (
	"context"
	"testing"

	"github.com/we-meet/work/internal/runflow"
)

// TestAdvanceReconcileTimeoutKeepsDurableReceiptUncommitted pins #83 = G1, the case where #81 (B2)
// and #82 (F1) pull in opposite directions: the reconcile park expires at a moment when a bound
// success receipt already exists, which is precisely the receipt that lets FinishAdvance commit
// past the hard deadline.
//
// The ruling is to keep failing - reconcile_timeout, with nothing committed, settled or released -
// because #34 = A keeps the reconcile write path manual and evidence-gated. Before this case there
// was no assertion that distinguished "failed because the wait expired" from "failed and quietly
// also decided to bank the answer": the workflow-level timeout tests cannot see the receipt at all,
// and the F1 PG test drives the opposite branch (FinishAdvance). A later change that "helpfully"
// auto-finishes on timeout would have stayed green.
//
// Reusing parkAdvancePastDeadline means the fixture is the production shape end to end: a durable
// receipt, an expired lease, an expired hard deadline. Only the arm driven here differs.
func TestAdvanceReconcileTimeoutKeepsDurableReceiptUncommitted(t *testing.T) {
	parked := parkAdvancePastDeadline(t)
	ctx := context.Background()

	// Pre-conditions that make this the G1 shape rather than a plain timeout.
	head := readAdvanceHeadRow(t, parked.pool, flowOrg, flowRun)
	if head.Revision != 0 {
		t.Fatalf("head before the timeout = %#v, want revision 0", head)
	}
	var before string
	if err := parked.admin.QueryRow(ctx, `
		SELECT state FROM work.quota_reservation WHERE operation_id = $1`,
		parked.execution.OperationID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if before != "held" {
		t.Fatalf("reservation before the timeout = %q, want held", before)
	}
	var recorded int64
	if err := parked.admin.QueryRow(ctx, `
		SELECT count(*) FROM work.dispatch_delivery
		WHERE execution_id = $1 AND gate_state = 'receipt_recorded' AND receipt_result = 'success'`,
		parked.execution.ExecutionID).Scan(&recorded); err != nil {
		t.Fatal(err)
	}
	if recorded != 1 {
		t.Fatalf("bound success receipts = %d, want 1 (this is the F1-eligible shape)", recorded)
	}

	// The timeout arm of #81, in production order: revoke the execution, then abort the Run.
	if err := parked.activities.RevokeAdvanceExecution(ctx, runflow.RevokeExecutionInput{
		RunID: flowRun, OrgID: flowOrg, ExecutionID: parked.execution.ExecutionID,
		Reason: runflow.AdvanceReasonReconcileTimeout,
	}); err != nil {
		t.Fatalf("revoke at the timeout: %v", err)
	}
	if err := parked.activities.AbortRun(ctx, runflow.AbortRunInput{
		RunID: flowRun, OrgID: flowOrg, OperationID: parked.execution.OperationID,
		Outcome: "failed", Reason: runflow.AdvanceReasonReconcileTimeout,
	}); err != nil {
		t.Fatalf("abort_run at the timeout: %v", err)
	}

	// G1 half one: the answer is not banked by this path. Revision 0 still, and 0030's exception
	// arm never ran - that marker is written only by commit_runtime_checkpoint.
	after := readAdvanceHeadRow(t, parked.pool, flowOrg, flowRun)
	if after.Revision != 0 || after.Ref != head.Ref || after.Hash != head.Hash {
		t.Fatalf("head after the timeout = %#v, want the revision 0 head unchanged (%#v)", after, head)
	}
	var banked int64
	if err := parked.admin.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE metadata->>'durable_receipt_after_deadline' = 'true'`).Scan(&banked); err != nil {
		t.Fatal(err)
	}
	if banked != 0 {
		t.Fatalf("durable_receipt_after_deadline=true rows = %d, want 0 (G1 must not commit on timeout)", banked)
	}

	// G1 half two: nothing is settled and nothing is released. The reservation stays held, which is
	// also what #76's default口径 implies here - it releases only operations with NO recorded receipt,
	// and this one has one.
	var now string
	if err := parked.admin.QueryRow(ctx, `
		SELECT state FROM work.quota_reservation WHERE operation_id = $1`,
		parked.execution.OperationID).Scan(&now); err != nil {
		t.Fatal(err)
	}
	if now != "held" {
		t.Fatalf("reservation after the timeout = %q, want held (no settle, no release under G1)", now)
	}

	// And the Run is terminalisable, which is the whole point of bounding the wait.
	if state := readFlowRunState(t, parked.pool); state != "failed" {
		t.Fatalf("run state after the timeout = %q, want failed", state)
	}
}
