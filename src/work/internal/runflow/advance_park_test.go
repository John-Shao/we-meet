package runflow_test

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/testsuite"

	"github.com/we-meet/work/internal/fragment"
	"github.com/we-meet/work/internal/runflow"
)

// #81 = B2: the reconcile park is bounded. The test environment fires timers on its own,
// so this case cannot pass unless the branch actually awaits a deadline - the three
// StateWaitingReconcile doors all use advanceReconcileWaitLimit now.
// Expiry only ends the wait: it fails the Run, and settles or releases nothing,
// which is what keeps this inside #34 = A (the reconcile write path stays manual).
func TestRunWorkflowAdvanceFailsRunWhenReconcileWaitTimesOut(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(runflow.RunWorkflowAdvance)
	env.RegisterActivity(&runflow.Activities{})
	prepared, head, input := quotaAdvanceFixture()
	env.OnActivity(runflow.ActivityPrepareAdvance, mock.Anything, input).
		Return(prepared, nil).Once()
	env.OnActivity(runflow.ActivityEnsureHead, mock.Anything, prepared).
		Return(head, nil).Once()
	env.OnActivity(runflow.ActivityPrepareExecution, mock.Anything, mock.Anything).
		Return(runflow.AdvanceExecution{
			ExecutionID: advanceExecutionID, OperationID: advanceOperationID,
			AttemptID: advanceAttemptID,
		}, nil).Once()
	env.OnActivity(runflow.ActivityAdvanceRuntime, mock.Anything, mock.Anything).
		Return(fragment.Result{
			Kind: fragment.KindResult, Contract: fragment.ContractVersion,
			ExecutionID: advanceExecutionID, State: fragment.StateWaitingReconcile,
		}, nil).Once()
	env.OnActivity(runflow.ActivityWaitRun, mock.Anything, runflow.WaitRunInput{
		RunID: advanceRunID, OrgID: "org_advance", Reason: "reconcile",
	}).Return(nil).Once()
	env.OnActivity(runflow.ActivityRevokeExecution, mock.Anything, runflow.RevokeExecutionInput{
		RunID: advanceRunID, OrgID: "org_advance",
		ExecutionID: advanceExecutionID, Reason: runflow.AdvanceReasonReconcileTimeout,
	}).Return(nil).Once()
	env.OnActivity(runflow.ActivityAbortRun, mock.Anything, runflow.AbortRunInput{
		RunID: advanceRunID, OrgID: "org_advance",
		OperationID: advanceOperationID, Outcome: "failed",
		Reason: runflow.AdvanceReasonReconcileTimeout,
	}).Return(nil).Once()

	env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

	if !env.IsWorkflowCompleted() {
		t.Fatal("workflow did not complete")
	}
	err := env.GetWorkflowError()
	if err == nil || !strings.Contains(err.Error(), runflow.AdvanceReasonReconcileTimeout) {
		t.Fatalf("workflow error = %v, want %s", err, runflow.AdvanceReasonReconcileTimeout)
	}
	env.AssertExpectations(t)
	env.AssertNotCalled(t, runflow.ActivityFinishRun, mock.Anything, mock.Anything)
	env.AssertNotCalled(t, runflow.ActivityFinishAdvance, mock.Anything, mock.Anything)
}
