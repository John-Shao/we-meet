package runflow_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/suite"
	"go.temporal.io/sdk/testsuite"

	"github.com/we-meet/work/internal/runflow"
)

type WorkflowSuite struct {
	suite.Suite
	testsuite.WorkflowTestSuite
}

func TestWorkflowSuite(t *testing.T) {
	suite.Run(t, new(WorkflowSuite))
}

func (s *WorkflowSuite) TestHappyPathRunsOneStepAndFinishesSucceeded() {
	env := s.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(runflow.RunWorkflow)
	env.RegisterActivity(&runflow.Activities{})
	input := runflow.Input{RunID: flowRun, OrgID: flowOrg}
	prepared := runflow.PreparedRun{
		RunID: flowRun, OrgID: flowOrg, TaskID: flowTask, SubjectID: "sub_runflow",
		RunState: "queued", Goal: "目标", TemplateID: "summary",
		TokenUpperBound: 100000, PolicyRevision: 1, RequestHash: "sha256:test",
		StepCount: 2,
	}
	env.OnActivity(runflow.ActivityPrepareRun, mock.Anything, input).Return(prepared, nil)
	env.OnActivity(runflow.ActivityAcquireRun, mock.Anything, input).
		Return(runflow.AcquireRunOutput{State: "active", Fence: 2}, nil)
	env.OnActivity(runflow.ActivityCheckRun, mock.Anything, input).
		Return(runflow.RunControl{State: "active"}, nil).Twice()
	env.OnActivity(runflow.ActivityExecuteStep, mock.Anything,
		mock.MatchedBy(func(step runflow.ExecuteStepInput) bool {
			return step.Step == 1 && !step.Final
		})).
		Return(runflow.ExecuteStepOutput{
			Step: 1, OperationID: "op-1", ReservationID: "res-1",
			ContentRef: "content://step-1", ContentHash: "sha256:step-1",
			Bytes: 10, UsageTokens: 50, Settled: true,
		}, nil).Once()
	env.OnActivity(runflow.ActivityExecuteStep, mock.Anything,
		mock.MatchedBy(func(step runflow.ExecuteStepInput) bool {
			return step.Step == 2 && step.Final && step.PreviousContentRef == "content://step-1"
		})).
		Return(runflow.ExecuteStepOutput{
			Step: 2, OperationID: "op-2", ReservationID: "res-2", ArtifactID: "artifact-1",
			VersionNo: 1, ContentRef: "content://step-2", ContentHash: "sha256:step-2",
			Bytes: 20, UsageTokens: 100, Settled: true,
		}, nil).Once()
	env.OnActivity(runflow.ActivityFinishRun, mock.Anything, mock.Anything).Return(nil)

	env.ExecuteWorkflow(runflow.RunWorkflow, input)

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	env.AssertExpectations(s.T())
}

func (s *WorkflowSuite) TestCanceledBeforeStartFinishesCanceledWithoutExecution() {
	env := s.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(runflow.RunWorkflow)
	env.RegisterActivity(&runflow.Activities{})
	input := runflow.Input{RunID: flowRun, OrgID: flowOrg}
	env.OnActivity(runflow.ActivityPrepareRun, mock.Anything, input).
		Return(runflow.PreparedRun{RunID: flowRun, OrgID: flowOrg, Canceled: true}, nil)
	env.OnActivity(runflow.ActivityFinishRun, mock.Anything, runflow.FinishRunInput{
		RunID: flowRun, OrgID: flowOrg, Outcome: "canceled", Reason: "run_canceled",
	}).Return(nil)

	env.ExecuteWorkflow(runflow.RunWorkflow, input)

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	env.AssertExpectations(s.T())
}

func (s *WorkflowSuite) TestCancelBetweenStepsFinishesCanceled() {
	env := s.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(runflow.RunWorkflow)
	env.RegisterActivity(&runflow.Activities{})
	input := runflow.Input{RunID: flowRun, OrgID: flowOrg}
	env.OnActivity(runflow.ActivityPrepareRun, mock.Anything, input).
		Return(runflow.PreparedRun{RunID: flowRun, OrgID: flowOrg, TaskID: flowTask, StepCount: 2}, nil)
	env.OnActivity(runflow.ActivityAcquireRun, mock.Anything, input).
		Return(runflow.AcquireRunOutput{State: "active", Fence: 2}, nil)
	env.OnActivity(runflow.ActivityCheckRun, mock.Anything, input).
		Return(runflow.RunControl{State: "active"}, nil).Once()
	env.OnActivity(runflow.ActivityCheckRun, mock.Anything, input).
		Return(runflow.RunControl{State: "cancel_requested", Canceled: true}, nil).Once()
	env.OnActivity(runflow.ActivityExecuteStep, mock.Anything, mock.Anything).
		Return(runflow.ExecuteStepOutput{
			Step: 1, OperationID: "op-1", ContentRef: "content://step-1",
			ContentHash: "sha256:step-1", Settled: true,
		}, nil).Once()
	env.OnActivity(runflow.ActivityFinishRun, mock.Anything, runflow.FinishRunInput{
		RunID: flowRun, OrgID: flowOrg, Outcome: "canceled", Reason: "run_canceled",
	}).Return(nil)

	env.ExecuteWorkflow(runflow.RunWorkflow, input)

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	env.AssertExpectations(s.T())
}

func (s *WorkflowSuite) TestUnknownWaitsForReconcileAndResume() {
	env := s.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(runflow.RunWorkflow)
	env.RegisterActivity(&runflow.Activities{})
	input := runflow.Input{RunID: flowRun, OrgID: flowOrg}
	env.OnActivity(runflow.ActivityPrepareRun, mock.Anything, input).
		Return(runflow.PreparedRun{RunID: flowRun, OrgID: flowOrg, TaskID: flowTask, StepCount: 2}, nil)
	env.OnActivity(runflow.ActivityAcquireRun, mock.Anything, input).
		Return(runflow.AcquireRunOutput{State: "active", Fence: 2}, nil)
	env.OnActivity(runflow.ActivityCheckRun, mock.Anything, input).
		Return(runflow.RunControl{State: "active"}, nil).Once()
	env.OnActivity(runflow.ActivityExecuteStep, mock.Anything, mock.Anything).
		Return(runflow.ExecuteStepOutput{
			Step: 1, OperationID: "op-1", ReservationID: "res-1",
			Unknown: true, ErrCode: "runtime_unknown",
		}, nil).Once()
	env.OnActivity(runflow.ActivityWaitRun, mock.Anything, runflow.WaitRunInput{
		RunID: flowRun, OrgID: flowOrg, Reason: "reconcile",
	}).Return(nil).Once()
	env.OnActivity(runflow.ActivityFinishRun, mock.Anything, runflow.FinishRunInput{
		RunID: flowRun, OrgID: flowOrg, Outcome: "failed", Reason: "reconcile_resolved",
	}).Return(nil)
	env.RegisterDelayedCallback(func() {
		env.SignalWorkflow("resume", map[string]any{"request_id": "resume-1"})
	}, time.Second)

	env.ExecuteWorkflow(runflow.RunWorkflow, input)

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	env.AssertExpectations(s.T())
}

func (s *WorkflowSuite) TestUnknownWaitsForCancel() {
	env := s.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(runflow.RunWorkflow)
	env.RegisterActivity(&runflow.Activities{})
	input := runflow.Input{RunID: flowRun, OrgID: flowOrg}
	env.OnActivity(runflow.ActivityPrepareRun, mock.Anything, input).
		Return(runflow.PreparedRun{RunID: flowRun, OrgID: flowOrg, TaskID: flowTask, StepCount: 2}, nil)
	env.OnActivity(runflow.ActivityAcquireRun, mock.Anything, input).
		Return(runflow.AcquireRunOutput{State: "active", Fence: 2}, nil)
	env.OnActivity(runflow.ActivityCheckRun, mock.Anything, input).
		Return(runflow.RunControl{State: "active"}, nil).Once()
	env.OnActivity(runflow.ActivityExecuteStep, mock.Anything, mock.Anything).
		Return(runflow.ExecuteStepOutput{
			Step: 1, OperationID: "op-1", ReservationID: "res-1",
			Unknown: true, ErrCode: "runtime_unknown",
		}, nil).Once()
	env.OnActivity(runflow.ActivityWaitRun, mock.Anything, mock.Anything).Return(nil).Once()
	env.OnActivity(runflow.ActivityFinishRun, mock.Anything, runflow.FinishRunInput{
		RunID: flowRun, OrgID: flowOrg, Outcome: "canceled", Reason: "run_canceled",
	}).Return(nil)
	env.RegisterDelayedCallback(func() {
		env.SignalWorkflow("cancel", map[string]any{"request_id": "cancel-1"})
	}, time.Second)

	env.ExecuteWorkflow(runflow.RunWorkflow, input)

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	env.AssertExpectations(s.T())
}

func (s *WorkflowSuite) TestExecuteFailureAbortsRun() {
	env := s.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(runflow.RunWorkflow)
	env.RegisterActivity(&runflow.Activities{})
	input := runflow.Input{RunID: flowRun, OrgID: flowOrg}
	env.OnActivity(runflow.ActivityPrepareRun, mock.Anything, input).
		Return(runflow.PreparedRun{RunID: flowRun, OrgID: flowOrg, TaskID: flowTask, StepCount: 2}, nil)
	env.OnActivity(runflow.ActivityAcquireRun, mock.Anything, input).
		Return(runflow.AcquireRunOutput{State: "active", Fence: 2}, nil)
	env.OnActivity(runflow.ActivityCheckRun, mock.Anything, input).
		Return(runflow.RunControl{State: "active"}, nil).Once()
	env.OnActivity(runflow.ActivityExecuteStep, mock.Anything, mock.Anything).
		Return(runflow.ExecuteStepOutput{
			Step: 1, OperationID: "op-1", ReservationID: "res-1",
			UsageTokens: 10, ErrCode: "runtime_failed",
		}, nil).Once()
	env.OnActivity(runflow.ActivityAbortRun, mock.Anything, mock.Anything).Return(nil)

	env.ExecuteWorkflow(runflow.RunWorkflow, input)

	s.True(env.IsWorkflowCompleted())
	s.Error(env.GetWorkflowError())
	s.ErrorContains(env.GetWorkflowError(), "runtime_failed")
	env.AssertExpectations(s.T())
}
