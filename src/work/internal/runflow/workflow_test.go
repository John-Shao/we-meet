package runflow_test

import (
	"testing"

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
	}
	env.OnActivity(runflow.ActivityPrepareRun, mock.Anything, input).Return(prepared, nil)
	env.OnActivity(runflow.ActivityAcquireRun, mock.Anything, input).
		Return(runflow.AcquireRunOutput{State: "active", Fence: 2}, nil)
	env.OnActivity(runflow.ActivityExecuteStep, mock.Anything, mock.Anything).
		Return(runflow.ExecuteStepOutput{
			OperationID: "op-1", ReservationID: "res-1", ArtifactID: "artifact-1",
			VersionNo: 1, ContentRef: "content://x", ContentHash: "sha256:x",
			Bytes: 10, UsageTokens: 100, Settled: true,
		}, nil)
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

func (s *WorkflowSuite) TestExecuteFailureAbortsRun() {
	env := s.NewTestWorkflowEnvironment()
	env.RegisterWorkflow(runflow.RunWorkflow)
	env.RegisterActivity(&runflow.Activities{})
	input := runflow.Input{RunID: flowRun, OrgID: flowOrg}
	env.OnActivity(runflow.ActivityPrepareRun, mock.Anything, input).
		Return(runflow.PreparedRun{RunID: flowRun, OrgID: flowOrg, TaskID: flowTask}, nil)
	env.OnActivity(runflow.ActivityAcquireRun, mock.Anything, input).
		Return(runflow.AcquireRunOutput{State: "active", Fence: 2}, nil)
	env.OnActivity(runflow.ActivityExecuteStep, mock.Anything, mock.Anything).
		Return(runflow.ExecuteStepOutput{
			OperationID: "op-1", ReservationID: "res-1",
			UsageTokens: 10, ErrCode: "runtime_failed",
		}, nil)
	env.OnActivity(runflow.ActivityAbortRun, mock.Anything, mock.Anything).Return(nil)

	env.ExecuteWorkflow(runflow.RunWorkflow, input)

	s.True(env.IsWorkflowCompleted())
	s.Error(env.GetWorkflowError())
	s.ErrorContains(env.GetWorkflowError(), "runtime_failed")
	env.AssertExpectations(s.T())
}
