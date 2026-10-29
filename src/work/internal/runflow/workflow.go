// Package runflow implements the Go RunWorkflow and its domain activities.
//
// This is the legacy r0a-v1 control-plane path: one model step, one artifact.
// The execution boundary is runtime.Runtime; the reference runtime is for
// lifecycle drills, not a model-backed production runtime.
package runflow

import (
	"errors"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const (
	WorkflowName = "RunWorkflow"

	ActivityPrepareRun  = "PrepareRun"
	ActivityAcquireRun  = "AcquireRun"
	ActivityExecuteStep = "ExecuteStep"
	ActivityFinishRun   = "FinishRun"
	ActivityAbortRun    = "AbortRun"
)

type Input struct {
	RunID string `json:"run_id"`
	OrgID string `json:"org_id"`
}

type PreparedRun struct {
	RunID           string `json:"run_id"`
	OrgID           string `json:"org_id"`
	TaskID          string `json:"task_id"`
	SubjectID       string `json:"subject_id"`
	RunState        string `json:"run_state"`
	Title           string `json:"title"`
	Goal            string `json:"goal"`
	Background      string `json:"background"`
	TemplateID      string `json:"template_id"`
	TemplateVersion int    `json:"template_version"`
	InputHash       string `json:"input_hash"`
	TokenUpperBound int64  `json:"token_upper_bound"`
	PolicyRevision  int64  `json:"policy_revision"`
	RequestHash     string `json:"request_hash"`
	Canceled        bool   `json:"canceled"`
}

type AcquireRunOutput struct {
	Fence    int64  `json:"fence"`
	State    string `json:"state"`
	Canceled bool   `json:"canceled"`
}

type ExecuteStepInput struct {
	Prepared PreparedRun `json:"prepared"`
	Fence    int64       `json:"fence"`
}

type ExecuteStepOutput struct {
	OperationID    string `json:"operation_id,omitempty"`
	ReservationID  string `json:"reservation_id,omitempty"`
	ArtifactID     string `json:"artifact_id,omitempty"`
	VersionNo      int    `json:"version_no,omitempty"`
	ContentRef     string `json:"content_ref,omitempty"`
	ContentHash    string `json:"content_hash,omitempty"`
	MediaType      string `json:"media_type,omitempty"`
	RuntimeVersion string `json:"runtime_version,omitempty"`
	Bytes          int64  `json:"bytes,omitempty"`
	UsageTokens    int64  `json:"usage_tokens,omitempty"`
	Settled        bool   `json:"settled,omitempty"`
	ErrCode        string `json:"err_code,omitempty"`
	ErrMessage     string `json:"err_message,omitempty"`
}

type FinishRunInput struct {
	RunID   string `json:"run_id"`
	OrgID   string `json:"org_id"`
	Outcome string `json:"outcome"`
	Reason  string `json:"reason,omitempty"`
}

type AbortRunInput struct {
	RunID         string `json:"run_id"`
	OrgID         string `json:"org_id"`
	OperationID   string `json:"operation_id,omitempty"`
	ReservationID string `json:"reservation_id,omitempty"`
	UsageTokens   int64  `json:"usage_tokens,omitempty"`
	Settled       bool   `json:"settled,omitempty"`
	Outcome       string `json:"outcome"`
	Reason        string `json:"reason,omitempty"`
}

func RunWorkflow(ctx workflow.Context, input Input) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 15 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: time.Second, BackoffCoefficient: 2,
			MaximumInterval: 10 * time.Second, MaximumAttempts: 3,
		},
	})

	var prepared PreparedRun
	if err := workflow.ExecuteActivity(ctx, ActivityPrepareRun, input).Get(ctx, &prepared); err != nil {
		return abort(ctx, input, AbortRunInput{Outcome: "failed", Reason: "prepare_failed"}, err)
	}
	if prepared.Canceled {
		return finishRun(ctx, FinishRunInput{
			RunID: input.RunID, OrgID: input.OrgID, Outcome: "canceled", Reason: "run_canceled",
		})
	}

	var acquired AcquireRunOutput
	if err := workflow.ExecuteActivity(ctx, ActivityAcquireRun, input).Get(ctx, &acquired); err != nil {
		return abort(ctx, input, AbortRunInput{Outcome: "failed", Reason: "acquire_failed"}, err)
	}
	if acquired.Canceled {
		return finishRun(ctx, FinishRunInput{
			RunID: input.RunID, OrgID: input.OrgID, Outcome: "canceled", Reason: "run_canceled",
		})
	}

	stepCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
	})
	var step ExecuteStepOutput
	if err := workflow.ExecuteActivity(stepCtx, ActivityExecuteStep, ExecuteStepInput{
		Prepared: prepared, Fence: acquired.Fence,
	}).Get(stepCtx, &step); err != nil {
		return abort(ctx, input, AbortRunInput{Outcome: "failed", Reason: "execute_failed"}, err)
	}
	if step.ErrCode != "" {
		return abort(ctx, input, AbortRunInput{
			OperationID: step.OperationID, ReservationID: step.ReservationID,
			UsageTokens: step.UsageTokens, Settled: step.Settled,
			Outcome: "failed", Reason: step.ErrCode,
		}, nil)
	}

	return finishRun(ctx, FinishRunInput{
		RunID: input.RunID, OrgID: input.OrgID, Outcome: "succeeded",
	})
}

func finishRun(ctx workflow.Context, input FinishRunInput) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 15 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: time.Second, BackoffCoefficient: 2,
			MaximumInterval: 10 * time.Second, MaximumAttempts: 3,
		},
	})
	return workflow.ExecuteActivity(ctx, ActivityFinishRun, input).Get(ctx, nil)
}

func abort(ctx workflow.Context, input Input, request AbortRunInput, cause error) error {
	outcome := "failed"
	if isCanceled(cause) {
		outcome = "canceled"
	}
	request.RunID = input.RunID
	request.OrgID = input.OrgID
	request.Outcome = outcome
	if request.Reason == "" {
		request.Reason = "workflow_failed"
	}
	cleanupCtx, cancel := workflow.NewDisconnectedContext(ctx)
	defer cancel()
	cleanupCtx = workflow.WithActivityOptions(cleanupCtx, workflow.ActivityOptions{
		StartToCloseTimeout: 15 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})
	_ = workflow.ExecuteActivity(cleanupCtx, ActivityAbortRun, request).Get(cleanupCtx, nil)
	if cause != nil {
		return cause
	}
	return errors.New(request.Reason)
}

func isCanceled(err error) bool {
	var canceled *temporal.CanceledError
	return errors.As(err, &canceled)
}
