package runflow

import (
	"errors"
	"strconv"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/we-meet/work/internal/fragment"
)

const (
	// WorkflowAdvanceName is the R0a advance workflow: one model step with an
	// explicit canonical checkpoint head on both sides of the execute fragment.
	WorkflowAdvanceName = "RunWorkflowAdvance"

	ActivityPrepareAdvance   = "PrepareAdvance"
	ActivityEnsureHead       = "EnsureAdvanceHead"
	ActivityPrepareExecution = "PrepareAdvanceExecution"
	ActivityAdvanceRuntime   = "AdvanceRuntime"
	ActivityFinishAdvance    = "FinishAdvance"
	ActivityRevokeExecution  = "RevokeAdvanceExecution"
)

const advanceLogicalKey = "model:1"

// AdvancePrepared is the read-only preparation result. It carries identifiers,
// hashes and counters only; the task text stays in the Content Store and is
// re-read inside each activity that needs it.
type AdvancePrepared struct {
	RunID           string `json:"run_id"`
	OrgID           string `json:"org_id"`
	TaskID          string `json:"task_id"`
	SnapshotID      string `json:"snapshot_id"`
	RunState        string `json:"run_state"`
	Fence           int64  `json:"fence"`
	RuntimeVersion  string `json:"runtime_version"`
	InputID         string `json:"input_id"`
	InputHash       string `json:"input_hash"`
	TemplateID      string `json:"template_id"`
	TemplateVersion int    `json:"template_version"`
	TokenUpperBound int64  `json:"token_upper_bound"`
	PolicyRevision  int64  `json:"policy_revision"`
	Canceled        bool   `json:"canceled"`
	ErrCode         string `json:"err_code,omitempty"`
}

// AdvanceHead is the committed canonical head named by the execute fragment.
// Ref/Hash are the registry reference of the canonical_state document, and
// Input/Template are the approved execution-bound references inside it.
type AdvanceHead struct {
	PlanExecutionID string `json:"plan_execution_id"`
	Revision        int64  `json:"revision"`
	Ref             string `json:"ref"`
	Hash            string `json:"hash"`
	RuntimeVersion  string `json:"runtime_version"`
	InputRef        string `json:"input_ref"`
	InputHash       string `json:"input_hash"`
	TemplateRef     string `json:"template_ref,omitempty"`
	TemplateHash    string `json:"template_hash,omitempty"`
	Canceled        bool   `json:"canceled"`
	AlreadyAdvanced bool   `json:"already_advanced"`
	ErrCode         string `json:"err_code,omitempty"`
}

type PrepareExecutionInput struct {
	Prepared AdvancePrepared `json:"prepared"`
	Head     AdvanceHead     `json:"head"`
}

// AdvanceExecution is the registered execute fragment and the permit the
// fragment wire carries. It is ids/hashes plus the absolute deadline.
type AdvanceExecution struct {
	ExecutionID    string `json:"execution_id"`
	OperationID    string `json:"operation_id"`
	AttemptID      string `json:"attempt_id"`
	ReservationID  string `json:"reservation_id,omitempty"`
	RequestHash    string `json:"request_hash"`
	IntentRef      string `json:"intent_ref"`
	IntentHash     string `json:"intent_hash"`
	DeadlineUnixMs int64  `json:"deadline_unix_ms"`
	Canceled       bool   `json:"canceled"`
	Superseded     bool   `json:"superseded"`
	ErrCode        string `json:"err_code,omitempty"`
}

type AdvanceFinishInput struct {
	Prepared  AdvancePrepared  `json:"prepared"`
	Head      AdvanceHead      `json:"head"`
	Execution AdvanceExecution `json:"execution"`
}

// Advance finish statuses.
const (
	AdvanceStatusSucceeded        = "succeeded"
	AdvanceStatusUsageUnavailable = "usage_unavailable"
	AdvanceStatusCanceled         = "canceled"
	AdvanceStatusFailed           = "failed"
)

type AdvanceFinishOutput struct {
	Status       string `json:"status"`
	ArtifactID   string `json:"artifact_id,omitempty"`
	VersionNo    int    `json:"version_no,omitempty"`
	HeadRef      string `json:"head_ref,omitempty"`
	HeadHash     string `json:"head_hash,omitempty"`
	HeadRevision int64  `json:"head_revision,omitempty"`
	ErrCode      string `json:"err_code,omitempty"`
}

type RevokeExecutionInput struct {
	RunID       string `json:"run_id"`
	OrgID       string `json:"org_id"`
	ExecutionID string `json:"execution_id"`
	Reason      string `json:"reason"`
}

// RunWorkflowAdvance executes exactly one model step. The plan fragment creates
// revision 0 of the canonical state; the execute fragment is registered against
// that head; Go finishes the receipt and commits revision 1 itself, so the
// child candidate is never treated as the head.
func RunWorkflowAdvance(ctx workflow.Context, input Input) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: time.Second, BackoffCoefficient: 2,
			MaximumInterval: 10 * time.Second, MaximumAttempts: 3,
		},
	})
	cancelCh := workflow.GetSignalChannel(ctx, "cancel")
	resumeCh := workflow.GetSignalChannel(ctx, "resume")

	var prepared AdvancePrepared
	if err := workflow.ExecuteActivity(ctx, ActivityPrepareAdvance, input).Get(ctx, &prepared); err != nil {
		return abortAdvance(ctx, input, AdvanceExecution{}, "failed", "prepare_failed")
	}
	if prepared.Canceled {
		return finishAdvanceRun(ctx, input, "canceled", "run_canceled")
	}
	if prepared.ErrCode != "" {
		return abortAdvance(ctx, input, AdvanceExecution{}, "failed", prepared.ErrCode)
	}

	var head AdvanceHead
	if err := workflow.ExecuteActivity(ctx, ActivityEnsureHead, prepared).Get(ctx, &head); err != nil {
		return abortAdvance(ctx, input, AdvanceExecution{}, "failed", "head_failed")
	}
	if head.Canceled {
		return finishAdvanceRun(ctx, input, "canceled", "run_canceled")
	}
	if head.ErrCode != "" {
		return abortAdvance(ctx, input, AdvanceExecution{}, "failed", head.ErrCode)
	}
	if head.AlreadyAdvanced {
		return finishAdvanceRun(ctx, input, "succeeded", "")
	}
	if cancelRequested(ctx, cancelCh) {
		return finishAdvanceRun(ctx, input, "canceled", "run_canceled")
	}

	var execution AdvanceExecution
	if err := workflow.ExecuteActivity(ctx, ActivityPrepareExecution, PrepareExecutionInput{
		Prepared: prepared, Head: head,
	}).Get(ctx, &execution); err != nil {
		return abortAdvance(ctx, input, AdvanceExecution{}, "failed", "execution_prepare_failed")
	}
	if execution.Canceled {
		return abortAdvance(ctx, input, execution, "canceled", "run_canceled")
	}
	if execution.Superseded {
		return nil
	}
	if execution.ErrCode != "" {
		return abortAdvance(ctx, input, execution, "failed", execution.ErrCode)
	}
	if cancelRequested(ctx, cancelCh) {
		return abortAdvance(ctx, input, execution, "canceled", "run_canceled")
	}

	request := fragment.Request{
		Kind: fragment.KindRequest, Contract: fragment.ContractVersion,
		ExecutionID: execution.ExecutionID, RunID: prepared.RunID,
		TaskID: prepared.TaskID, OrgID: prepared.OrgID,
		SnapshotID: prepared.SnapshotID, RuntimeVersion: prepared.RuntimeVersion,
		Fence:          strconv.FormatInt(prepared.Fence, 10),
		DeadlineUnixMs: execution.DeadlineUnixMs, Mode: "execute",
		Checkpoint: &fragment.Reference{RefID: head.Ref, Hash: head.Hash},
		Intent: &fragment.Intent{
			Request:     fragment.Reference{RefID: execution.IntentRef, Hash: execution.IntentHash},
			RequestHash: execution.IntentHash,
			LogicalKey:  advanceLogicalKey,
		},
		Permit: &fragment.Permit{
			OperationID:       execution.OperationID,
			DispatchAttemptID: execution.AttemptID,
			RequestHash:       execution.RequestHash,
		},
	}
	result, cancelConfirmed, err := advanceWithCancel(ctx, cancelCh, request)
	if cancelConfirmed || isCanceled(err) {
		return abortAdvance(ctx, input, execution, "canceled", "run_canceled")
	}
	if err != nil {
		return abortAdvance(ctx, input, execution, "failed", "advance_failed")
	}

	switch result.State {
	case fragment.StateCheckpointed:
		return finishCheckpointed(ctx, input, prepared, head, execution, cancelCh, resumeCh)
	case fragment.StateWaitingReconcile:
		if err := workflow.ExecuteActivity(ctx, ActivityWaitRun, WaitRunInput{
			RunID: input.RunID, OrgID: input.OrgID, Reason: "reconcile",
		}).Get(ctx, nil); err != nil {
			return abortAdvance(ctx, input, execution, "failed", "reconcile_wait_failed")
		}
		switch awaitResumeOrCancel(ctx, cancelCh, resumeCh) {
		case "cancel":
			return abortAdvance(ctx, input, execution, "canceled", "run_canceled")
		default:
			// The operator reconciled the unknown operation (for example with
			// work-reconcile -finish-from-receipt). Re-enter finishing so a
			// trusted receipt can still commit the canonical successor; a run
			// without a confirmed receipt fails closed.
			var finished AdvanceFinishOutput
			if err := workflow.ExecuteActivity(ctx, ActivityFinishAdvance, AdvanceFinishInput{
				Prepared: prepared, Head: head, Execution: execution,
			}).Get(ctx, &finished); err != nil {
				return abortAdvance(ctx, input, execution, "failed", "reconcile_finish_failed")
			}
			if finished.Status == AdvanceStatusSucceeded {
				return finishAdvanceRun(ctx, input, "succeeded", "")
			}
			return abortAdvance(ctx, input, execution, "failed", "reconcile_resolved")
		}
	case fragment.StateCanceled:
		return abortAdvance(ctx, input, execution, "canceled", "run_canceled")
	case fragment.StateFailed:
		reason := result.Reason
		if reason == "" {
			reason = "advance_failed"
		}
		return abortAdvance(ctx, input, execution, "failed", reason)
	default:
		return abortAdvance(ctx, input, execution, "failed", "advance_result_mismatch")
	}
}

// finishCheckpointed finishes the trusted receipt, publishes the answer as the
// Run artifact, and commits revision 1 of the canonical state. A receipt whose
// usage is unavailable is confirmed but not settled: the Run waits for
// reconciliation and retries finishing after resume.
func finishCheckpointed(
	ctx workflow.Context, input Input, prepared AdvancePrepared,
	head AdvanceHead, execution AdvanceExecution,
	cancelCh, resumeCh workflow.ReceiveChannel,
) error {
	for {
		if cancelRequested(ctx, cancelCh) {
			return abortAdvance(ctx, input, execution, "canceled", "run_canceled")
		}
		var finished AdvanceFinishOutput
		if err := workflow.ExecuteActivity(ctx, ActivityFinishAdvance, AdvanceFinishInput{
			Prepared: prepared, Head: head, Execution: execution,
		}).Get(ctx, &finished); err != nil {
			return abortAdvance(ctx, input, execution, "failed", "finish_failed")
		}
		switch finished.Status {
		case AdvanceStatusSucceeded:
			return finishAdvanceRun(ctx, input, "succeeded", "")
		case AdvanceStatusUsageUnavailable:
			if err := workflow.ExecuteActivity(ctx, ActivityWaitRun, WaitRunInput{
				RunID: input.RunID, OrgID: input.OrgID, Reason: "reconcile",
			}).Get(ctx, nil); err != nil {
				return abortAdvance(ctx, input, execution, "failed", "reconcile_wait_failed")
			}
			switch awaitResumeOrCancel(ctx, cancelCh, resumeCh) {
			case "cancel":
				return abortAdvance(ctx, input, execution, "canceled", "run_canceled")
			default:
				continue
			}
		case AdvanceStatusCanceled:
			return abortAdvance(ctx, input, execution, "canceled", "run_canceled")
		default:
			code := finished.ErrCode
			if code == "" {
				code = "finish_failed"
			}
			return abortAdvance(ctx, input, execution, "failed", code)
		}
	}
}

func finishAdvanceRun(ctx workflow.Context, input Input, outcome, reason string) error {
	return workflow.ExecuteActivity(ctx, ActivityFinishRun, FinishRunInput{
		RunID: input.RunID, OrgID: input.OrgID, Outcome: outcome, Reason: reason,
	}).Get(ctx, nil)
}

// abortAdvance revokes the registered fragment first, then closes the Run
// through the legacy abort path, which distinguishes prepared/authorized
// operations from a dispatching one and never seals a dispatch as not sent.
func abortAdvance(
	ctx workflow.Context, input Input, execution AdvanceExecution, outcome, reason string,
) error {
	cleanupCtx, cancel := workflow.NewDisconnectedContext(ctx)
	defer cancel()
	cleanupCtx = workflow.WithActivityOptions(cleanupCtx, workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})
	if execution.ExecutionID != "" {
		_ = workflow.ExecuteActivity(cleanupCtx, ActivityRevokeExecution, RevokeExecutionInput{
			RunID: input.RunID, OrgID: input.OrgID,
			ExecutionID: execution.ExecutionID, Reason: reason,
		}).Get(cleanupCtx, nil)
	}
	_ = workflow.ExecuteActivity(cleanupCtx, ActivityAbortRun, AbortRunInput{
		RunID: input.RunID, OrgID: input.OrgID,
		OperationID: execution.OperationID, ReservationID: execution.ReservationID,
		ProvenRejection: reason == fragment.ReasonProviderRejected,
		Outcome:         outcome, Reason: reason,
	}).Get(cleanupCtx, nil)
	if outcome == "canceled" {
		return nil
	}
	return errors.New(reason)
}

func cancelRequested(ctx workflow.Context, cancelCh workflow.ReceiveChannel) bool {
	selector := workflow.NewSelector(ctx)
	requested := false
	selector.AddReceive(cancelCh, func(ch workflow.ReceiveChannel, _ bool) {
		var payload any
		ch.Receive(ctx, &payload)
		requested = true
	})
	selector.AddDefault(func() {})
	selector.Select(ctx)
	return requested
}

// advanceWithCancel lets a cancel signal stop the in-flight advance activity.
// The signal is only a hint: the activity never rewrites a dispatched call as
// not sent, and the workflow revokes the registered fragment before closing the
// Run.
func advanceWithCancel(
	ctx workflow.Context, cancelCh workflow.ReceiveChannel, request fragment.Request,
) (fragment.Result, bool, error) {
	advanceCtx, cancelAdvance := workflow.WithCancel(ctx)
	defer cancelAdvance()
	advanceCtx = workflow.WithActivityOptions(advanceCtx, workflow.ActivityOptions{
		StartToCloseTimeout: 16 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
	})
	future := workflow.ExecuteActivity(advanceCtx, ActivityAdvanceRuntime, request)
	var out fragment.Result
	cancelConfirmed := false
	cancelSignaled := false
	for !future.IsReady() {
		selector := workflow.NewSelector(ctx)
		selector.AddFuture(future, func(workflow.Future) {})
		selector.AddReceive(cancelCh, func(ch workflow.ReceiveChannel, _ bool) {
			var payload any
			ch.Receive(ctx, &payload)
			cancelSignaled = true
		})
		selector.Select(ctx)
		if cancelSignaled && !cancelConfirmed {
			cancelSignaled = false
			var control RunControl
			checkErr := workflow.ExecuteActivity(ctx, ActivityCheckRun, Input{
				RunID: request.RunID, OrgID: request.OrgID,
			}).Get(ctx, &control)
			if checkErr == nil && control.Canceled {
				cancelConfirmed = true
				cancelAdvance()
			}
		}
	}
	err := future.Get(advanceCtx, &out)
	return out, cancelConfirmed, err
}
