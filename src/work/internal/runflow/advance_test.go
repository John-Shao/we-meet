package runflow_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"

	"github.com/we-meet/work/internal/advance"
	"github.com/we-meet/work/internal/fragment"
	"github.com/we-meet/work/internal/runflow"
)

const (
	advanceExecutionID   = "11111111-1111-4111-8111-111111111111"
	advanceRunID         = "22222222-2222-4222-8222-222222222222"
	advanceTaskID        = "33333333-3333-4333-8333-333333333333"
	advanceSnapshotID    = "44444444-4444-4444-8444-444444444444"
	advanceOperationID   = "55555555-5555-4555-8555-555555555555"
	advanceAttemptID     = "66666666-6666-4666-8666-666666666666"
	advanceRefID         = "77777777-7777-4777-8777-777777777777"
	advanceReservationID = "88888888-8888-4888-8888-888888888888"
	advanceHash          = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

type fakeAdvanceClient struct {
	result  fragment.Result
	err     error
	calls   int
	request fragment.Request
}

func (f *fakeAdvanceClient) Advance(_ context.Context, request fragment.Request) (fragment.Result, error) {
	f.calls++
	f.request = request
	return f.result, f.err
}

func advancePlanRequest() fragment.Request {
	return fragment.Request{
		Kind: fragment.KindRequest, Contract: fragment.ContractVersion,
		ExecutionID: advanceExecutionID, RunID: advanceRunID, TaskID: advanceTaskID,
		OrgID: "org_advance", SnapshotID: advanceSnapshotID,
		RuntimeVersion: "runtime-v1", Fence: "7",
		DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
		Mode:           "plan",
	}
}

func advanceExecuteRequest() fragment.Request {
	request := advancePlanRequest()
	request.Mode = "execute"
	request.Checkpoint = &fragment.Reference{RefID: advanceRefID, Hash: advanceHash}
	request.Intent = &fragment.Intent{
		Request:     fragment.Reference{RefID: advanceRefID, Hash: advanceHash},
		RequestHash: advanceHash,
		LogicalKey:  "model:1",
	}
	request.Permit = &fragment.Permit{
		OperationID: advanceOperationID, DispatchAttemptID: advanceAttemptID, RequestHash: advanceHash,
	}
	return request
}

func checkpointedResult() fragment.Result {
	return fragment.Result{
		Kind: fragment.KindResult, Contract: fragment.ContractVersion,
		ExecutionID: advanceExecutionID, State: fragment.StateCheckpointed,
		Checkpoint: &fragment.Reference{RefID: advanceRefID, Hash: advanceHash},
		Receipt:    &fragment.Reference{RefID: advanceRefID, Hash: advanceHash},
	}
}

func TestAdvanceRuntimeValidatesRequestBeforeCallingClient(t *testing.T) {
	client := &fakeAdvanceClient{result: checkpointedResult()}
	activities := &runflow.Activities{Advance: client}
	request := advanceExecuteRequest()
	request.Fence = "not-a-fence"

	if _, err := activities.AdvanceRuntime(context.Background(), request); err == nil ||
		err.Error() != "advance_request_invalid" {
		t.Fatalf("error = %v", err)
	}
	if client.calls != 0 {
		t.Fatalf("client calls = %d", client.calls)
	}
}

func TestAdvanceRuntimeReturnsValidatedResult(t *testing.T) {
	client := &fakeAdvanceClient{result: checkpointedResult()}
	activities := &runflow.Activities{Advance: client}
	request := advanceExecuteRequest()

	result, err := activities.AdvanceRuntime(context.Background(), request)
	if err != nil {
		t.Fatalf("advance: %v", err)
	}
	if result.State != fragment.StateCheckpointed || result.ExecutionID != advanceExecutionID {
		t.Fatalf("result = %#v", result)
	}
	if client.calls != 1 || client.request.ExecutionID != advanceExecutionID {
		t.Fatalf("client = %#v", client)
	}
}

func TestAdvanceRuntimeMapsTransportUnknownToReconcile(t *testing.T) {
	cases := map[string]error{
		"deadline":          context.DeadlineExceeded,
		"transport timeout": &advance.TransportError{Code: advance.CodeTransportTimeout},
		"transport unknown": &advance.TransportError{Code: advance.CodeTransportUnknown},
		"invalid response":  &advance.TransportError{Code: advance.CodeInvalidResponse},
	}
	for name, cause := range cases {
		t.Run(name, func(t *testing.T) {
			activities := &runflow.Activities{Advance: &fakeAdvanceClient{err: cause}}
			result, err := activities.AdvanceRuntime(context.Background(), advanceExecuteRequest())
			if err != nil {
				t.Fatalf("advance: %v", err)
			}
			if result.State != fragment.StateWaitingReconcile ||
				result.Reason != "provider_unknown" ||
				result.OperationID != advanceOperationID ||
				result.Checkpoint == nil {
				t.Fatalf("result = %#v", result)
			}
			if err := result.Validate(); err != nil {
				t.Fatalf("result validation: %v", err)
			}
		})
	}
}

func TestAdvanceRuntimeMapsRemoteEnumerationToError(t *testing.T) {
	activities := &runflow.Activities{Advance: &fakeAdvanceClient{err: &advance.RemoteError{
		Status: 429, Code: advance.CodeResourceExhausted,
	}}}
	result, err := activities.AdvanceRuntime(context.Background(), advanceExecuteRequest())
	if err == nil || err.Error() != advance.CodeResourceExhausted {
		t.Fatalf("error = %v, result = %#v", err, result)
	}
	var remote *advance.RemoteError
	if !errors.As(err, &remote) || remote.Code != advance.CodeResourceExhausted {
		t.Fatalf("remote error type was lost: %v", err)
	}
	if result.State == fragment.StateWaitingReconcile {
		t.Fatal("scheduling refusal must not become WAITING_RECONCILE")
	}
}

func TestAdvanceRuntimeRejectsInvalidOrMismatchedResults(t *testing.T) {
	wrongID := checkpointedResult()
	wrongID.ExecutionID = "99999999-9999-4999-8999-999999999999"

	invalidState := checkpointedResult()
	invalidState.State = "DONE"

	executeWithModelRequest := checkpointedResult()
	executeWithModelRequest.State = fragment.StateModelRequest
	executeWithModelRequest.Receipt = nil
	executeWithModelRequest.Intent = &fragment.Intent{
		Request:     fragment.Reference{RefID: advanceRefID, Hash: advanceHash},
		RequestHash: advanceHash,
		LogicalKey:  "model:1",
	}

	planWithCheckpointed := checkpointedResult()

	cases := map[string]struct {
		request fragment.Request
		result  fragment.Result
	}{
		"wrong execution id":           {advanceExecuteRequest(), wrongID},
		"unknown state":                {advanceExecuteRequest(), invalidState},
		"execute cannot model request": {advanceExecuteRequest(), executeWithModelRequest},
		"plan cannot checkpoint":       {advancePlanRequest(), planWithCheckpointed},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			activities := &runflow.Activities{Advance: &fakeAdvanceClient{result: testCase.result}}
			if _, err := activities.AdvanceRuntime(context.Background(), testCase.request); err == nil {
				t.Fatal("invalid result was accepted")
			}
		})
	}
}

func TestAdvanceRuntimePlanUnknownHasNoOperation(t *testing.T) {
	activities := &runflow.Activities{Advance: &fakeAdvanceClient{err: context.DeadlineExceeded}}
	if _, err := activities.AdvanceRuntime(context.Background(), advancePlanRequest()); err == nil ||
		err.Error() != "advance_unknown_without_operation" {
		t.Fatalf("error = %v", err)
	}
}

func TestAdvanceRuntimeMapsCancellation(t *testing.T) {
	causes := []error{
		context.Canceled,
		&advance.TransportError{Code: advance.CodeTransportCanceled},
	}
	for _, cause := range causes {
		activities := &runflow.Activities{Advance: &fakeAdvanceClient{err: cause}}
		if _, err := activities.AdvanceRuntime(context.Background(), advanceExecuteRequest()); !temporal.IsCanceledError(err) {
			t.Fatalf("cause %v: error = %v", cause, err)
		}
	}
}

func TestAdvanceRuntimeRequiresClient(t *testing.T) {
	activities := &runflow.Activities{}
	if _, err := activities.AdvanceRuntime(context.Background(), advanceExecuteRequest()); err == nil ||
		err.Error() != "advance_unavailable" {
		t.Fatalf("error = %v", err)
	}
}

func advancePreparedFixture() runflow.AdvancePrepared {
	return runflow.AdvancePrepared{
		RunID: advanceRunID, OrgID: "org_advance", TaskID: advanceTaskID,
		SnapshotID: advanceSnapshotID, RunState: "active", Fence: 7,
		RuntimeVersion: "reference-text-v1", InputID: advanceRefID,
		InputHash: advanceHash, TemplateID: "summary", TemplateVersion: 1,
		TokenUpperBound: 100000, PolicyRevision: 1,
	}
}

func advanceHeadFixture() runflow.AdvanceHead {
	return runflow.AdvanceHead{
		PlanExecutionID: advanceExecutionID, Revision: 0,
		Ref: advanceRefID, Hash: advanceHash, RuntimeVersion: "reference-text-v1",
		InputRef: advanceRefID, InputHash: advanceHash,
		TemplateRef: advanceRefID, TemplateHash: advanceHash,
	}
}

func TestRunWorkflowAdvanceRunsOneStepAndFinishesSucceeded(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(runflow.RunWorkflowAdvance)
	env.RegisterActivity(&runflow.Activities{})
	input := runflow.Input{RunID: advanceRunID, OrgID: "org_advance"}
	prepared := advancePreparedFixture()
	head := advanceHeadFixture()
	execution := runflow.AdvanceExecution{
		ExecutionID: advanceExecutionID, OperationID: advanceOperationID,
		AttemptID: advanceAttemptID, RequestHash: advanceHash,
		IntentRef: advanceRefID, IntentHash: advanceHash,
		DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
	}
	env.OnActivity(runflow.ActivityPrepareAdvance, mock.Anything, input).
		Return(prepared, nil).Once()
	env.OnActivity(runflow.ActivityEnsureHead, mock.Anything, prepared).
		Return(head, nil).Once()
	env.OnActivity(runflow.ActivityPrepareExecution, mock.Anything, mock.Anything).
		Return(execution, nil).Once()
	env.OnActivity(runflow.ActivityAdvanceRuntime, mock.Anything, mock.Anything).
		Return(checkpointedResult(), nil).Once()
	env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, mock.Anything).
		Return(runflow.AdvanceFinishOutput{Status: runflow.AdvanceStatusSucceeded}, nil).Once()
	env.OnActivity(runflow.ActivityFinishRun, mock.Anything, runflow.FinishRunInput{
		RunID: advanceRunID, OrgID: "org_advance", Outcome: "succeeded",
	}).Return(nil).Once()

	env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

	if !env.IsWorkflowCompleted() {
		t.Fatal("workflow did not complete")
	}
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	env.AssertExpectations(t)
}

func TestRunWorkflowAdvanceAlreadyAdvancedFinishesWithoutExecution(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(runflow.RunWorkflowAdvance)
	env.RegisterActivity(&runflow.Activities{})
	input := runflow.Input{RunID: advanceRunID, OrgID: "org_advance"}
	prepared := advancePreparedFixture()
	head := advanceHeadFixture()
	head.Revision = 1
	head.AlreadyAdvanced = true
	env.OnActivity(runflow.ActivityPrepareAdvance, mock.Anything, input).
		Return(prepared, nil).Once()
	env.OnActivity(runflow.ActivityEnsureHead, mock.Anything, prepared).
		Return(head, nil).Once()
	env.OnActivity(runflow.ActivityFinishRun, mock.Anything, runflow.FinishRunInput{
		RunID: advanceRunID, OrgID: "org_advance", Outcome: "succeeded",
	}).Return(nil).Once()

	env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	env.AssertExpectations(t)
}

// Decision A1: a provider rejection is terminal. The workflow revokes the
// fragment and aborts the Run with the rejection flag; it never waits for
// reconciliation, finishes the advance or publishes an artifact.
func TestRunWorkflowAdvanceFailsRunOnProviderRejection(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(runflow.RunWorkflowAdvance)
	env.RegisterActivity(&runflow.Activities{})
	input := runflow.Input{RunID: advanceRunID, OrgID: "org_advance"}
	prepared := advancePreparedFixture()
	head := advanceHeadFixture()
	execution := runflow.AdvanceExecution{
		ExecutionID: advanceExecutionID, OperationID: advanceOperationID,
		AttemptID: advanceAttemptID, ReservationID: advanceReservationID,
		RequestHash:    advanceHash,
		DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
	}
	env.OnActivity(runflow.ActivityPrepareAdvance, mock.Anything, input).
		Return(prepared, nil).Once()
	env.OnActivity(runflow.ActivityEnsureHead, mock.Anything, prepared).
		Return(head, nil).Once()
	env.OnActivity(runflow.ActivityPrepareExecution, mock.Anything, mock.Anything).
		Return(execution, nil).Once()
	env.OnActivity(runflow.ActivityAdvanceRuntime, mock.Anything, mock.Anything).
		Return(fragment.Result{
			Kind: fragment.KindResult, Contract: fragment.ContractVersion,
			ExecutionID: advanceExecutionID, State: fragment.StateFailed,
			Checkpoint: &fragment.Reference{RefID: advanceRefID, Hash: advanceHash},
			Reason:     fragment.ReasonProviderRejected,
		}, nil).Once()
	env.OnActivity(runflow.ActivityRevokeExecution, mock.Anything, runflow.RevokeExecutionInput{
		RunID: advanceRunID, OrgID: "org_advance",
		ExecutionID: advanceExecutionID, Reason: fragment.ReasonProviderRejected,
	}).Return(nil).Once()
	env.OnActivity(runflow.ActivityAbortRun, mock.Anything, runflow.AbortRunInput{
		RunID: advanceRunID, OrgID: "org_advance",
		OperationID: advanceOperationID, ReservationID: advanceReservationID,
		ProvenRejection: true, Outcome: "failed", Reason: fragment.ReasonProviderRejected,
	}).Return(nil).Once()

	env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

	if !env.IsWorkflowCompleted() {
		t.Fatal("workflow did not complete")
	}
	err := env.GetWorkflowError()
	if err == nil || !strings.Contains(err.Error(), fragment.ReasonProviderRejected) {
		t.Fatalf("workflow error = %v", err)
	}
	env.AssertExpectations(t)
	env.AssertNotCalled(t, runflow.ActivityFinishAdvance, mock.Anything, mock.Anything)
	env.AssertNotCalled(t, runflow.ActivityWaitRun, mock.Anything, mock.Anything)
}
