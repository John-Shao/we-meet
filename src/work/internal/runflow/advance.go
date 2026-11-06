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
	ActivityResumeRun        = "ResumeRun"
)

const advanceLogicalKey = "model:1"

// AdvanceErrQuotaExhausted is reserve_quota's saturation code. Unlike every other
// prepare failure it is curable without a new Run, so the workflow parks on
// wait_reason='quota' (which is what makes display_state='quota_exhausted' in
// baseline/0002:2779 reachable) instead of failing the Run.
const (
	AdvanceErrQuotaExhausted = "quota_exhausted"
	advanceWaitReasonQuota   = "quota"
	// advanceQuotaWaitLimit and the quota_wait_timeout terminal code are §8.3 of the
	// orchestration design; the wait bound is measured from the first saturation, not
	// per attempt, so a run cannot live forever on repeated replenishment signals.
	advanceQuotaWaitLimit     = 24 * time.Hour
	AdvanceReasonQuotaTimeout = "quota_wait_timeout"
	// advanceReconcileWaitLimit is #81 = B2. It bounds the wait ONLY: at expiry the
	// Run is failed with reconcile_timeout and nothing is settled or released, because
	// #34 = A keeps the reconcile write path manual and evidence-gated. The bound
	// mirrors the quota branch's 24h; changing the number is one edit here.
	advanceReconcileWaitLimit     = 24 * time.Hour
	AdvanceReasonReconcileTimeout = "reconcile_timeout"
	advanceReasonQuotaWaitFail    = "quota_wait_failed"
	advanceReasonQuotaResumeFail  = "quota_resume_failed"
)

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

// ResumeRunInput asks the database to flip a waiting Run back to active. Reason is
// deliberately absent: wait_run records why, resume_run clears it.
type ResumeRunInput struct {
	RunID string `json:"run_id"`
	OrgID string `json:"org_id"`
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
	// Created on the first saturation and reused, so the 24h bound runs from "quota
	// first ran out" rather than resetting on every replenishment signal. A Future
	// that already fired returns "timeout" immediately on the next park.
	var quotaDeadline workflow.Future
	for {
		execution = AdvanceExecution{}
		if err := workflow.ExecuteActivity(ctx, ActivityPrepareExecution, PrepareExecutionInput{
			Prepared: prepared, Head: head,
		}).Get(ctx, &execution); err != nil {
			return abortAdvance(ctx, input, AdvanceExecution{}, "failed", "execution_prepare_failed")
		}
		if execution.ErrCode != AdvanceErrQuotaExhausted {
			break
		}
		// Saturation: park the Run and let an operator replenish, per §8.3. The
		// identifiers the activity already committed (operation created and
		// authorized, no reservation) travel with execution so a timeout or a
		// cancel can still revoke and close the Run.
		if err := workflow.ExecuteActivity(ctx, ActivityWaitRun, WaitRunInput{
			RunID: input.RunID, OrgID: input.OrgID, Reason: advanceWaitReasonQuota,
		}).Get(ctx, nil); err != nil {
			return abortAdvance(ctx, input, execution, "failed", advanceReasonQuotaWaitFail)
		}
		if quotaDeadline == nil {
			quotaDeadline = workflow.NewTimer(ctx, advanceQuotaWaitLimit)
		}
		switch awaitQuotaOrSignal(ctx, quotaDeadline, cancelCh, resumeCh) {
		case "cancel":
			return abortAdvance(ctx, input, execution, "canceled", "run_canceled")
		case "timeout":
			return abortAdvance(ctx, input, execution, "failed", AdvanceReasonQuotaTimeout)
		}
		// A resume signal is not proof that quota came back; resume_run flips the
		// Run to active and the next PrepareAdvanceExecution re-reads the account
		// and re-reserves. If it is still saturated, the loop parks it again.
		if err := workflow.ExecuteActivity(ctx, ActivityResumeRun, ResumeRunInput{
			RunID: input.RunID, OrgID: input.OrgID,
		}).Get(ctx, nil); err != nil {
			return abortAdvance(ctx, input, execution, "failed", advanceReasonQuotaResumeFail)
		}
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
		// Created before the await and awaited exactly once, so the test
		// environment's auto-fired timers cannot advance the virtual clock out from
		// under the wait - the same reason the quota timer is created lazily.
		reconcileDeadline := workflow.NewTimer(ctx, advanceReconcileWaitLimit)
		switch awaitQuotaOrSignal(ctx, reconcileDeadline, cancelCh, resumeCh) {
		case "cancel":
			return abortAdvance(ctx, input, execution, "canceled", "run_canceled")
		case "timeout":
			return abortAdvance(ctx, input, execution, "failed", AdvanceReasonReconcileTimeout)
		default:
			return finishCheckpointed(ctx, input, prepared, head, execution, cancelCh, resumeCh)
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
			// Same bound as the park above, so "usage unavailable" cannot hold a Run
			// open forever either. Created fresh per iteration on purpose: this one is
			// inside the finish loop, so the bound restarts with each new park rather
			// than being measured once from the first saturation - the quota branch
			// measures from the first, this one measures from each, and the difference
			// is deliberate (a resume here re-drives finish, it does not re-reserve).
			usageDeadline := workflow.NewTimer(ctx, advanceReconcileWaitLimit)
			switch awaitQuotaOrSignal(ctx, usageDeadline, cancelCh, resumeCh) {
			case "cancel":
				return abortAdvance(ctx, input, execution, "canceled", "run_canceled")
			case "timeout":
				return abortAdvance(ctx, input, execution, "failed", AdvanceReasonReconcileTimeout)
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
		Outcome: outcome, Reason: reason,
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

// awaitQuotaOrSignal waits for whichever comes first: the replenishment signal, a
// cancel, or the 24h bound. A deadline that already passed fires immediately, so a
// Run that bounced between saturated and replenished still terminates.
func awaitQuotaOrSignal(
	ctx workflow.Context,
	deadline workflow.Future, cancelCh, resumeCh workflow.ReceiveChannel,
) string {
	selector := workflow.NewSelector(ctx)
	result := ""
	selector.AddFuture(deadline, func(workflow.Future) { result = "timeout" })
	selector.AddReceive(cancelCh, func(channel workflow.ReceiveChannel, _ bool) {
		var payload any
		channel.Receive(ctx, &payload)
		result = "cancel"
	})
	selector.AddReceive(resumeCh, func(channel workflow.ReceiveChannel, _ bool) {
		var payload any
		channel.Receive(ctx, &payload)
		result = "resume"
	})
	for result == "" {
		selector.Select(ctx)
	}
	return result
}

// advanceWithCancel lets a cancel signal stop the in-flight advance activity.
// The signal is only a hint: the activity never rewrites a dispatched call as
// not sent, and the workflow revokes the registered fragment before closing the
// Run.
//
// The start-to-close window is 4 minutes because that is what a lost completion
// costs: measured on the pilot host 2026-11-04, a model step takes 15-25s and
// the slowest provider exchange seen was 49.9s, while the previous 16-minute
// window meant an interrupted Run sat open until Temporal gave up on it.
//
// What one retry can and cannot recover, both measured on 2026-11-05 (run
// 0fd4f0a8: worker stopped 3s into the activity, attempt 2 started at 4m06s, the
// exchange work-node had already sent finished 2m17s later at 137,216ms):
//
//   - it cannot re-send. consume_dispatch_delivery answers "observed" for any
//     operation that already has a delivery row, before it looks at holder,
//     lease or deadline, and egress turns a non-won decision into not_sent.
//     consume_by_execution_pg_test.go pins "exactly one winner".
//   - before increment 0028 it could not do anything else either: the fragment
//     was still state='active' with an elapsed lease, claim_runtime_execution
//     refused a different holder, and the attempt died as lease_not_claimable.
//     The Run then closed as advance_failed even though the answer of the first
//     attempt might already be durable. That dead end is what 0028 opens.
//   - with the lease taken over, not_sent reaches Node as WAITING_RECONCILE and
//     the Run parks on wait_reason='reconcile'; the finish path then resolves
//     the receipt from dispatch_delivery plus the content reference registry.
//     So a retry finishes the receipt rather than re-sending it - but only
//     because finishing reads the database, never this activity's memory. An
//     exchange that ended unknown (no receipt attached, e.g. a truncated
//     answer) stays an unknown for the operator to settle, because
//     finishing.ErrReceiptNotAttached refuses to infer success from a consumed
//     gate.
//
// Schedule-to-close leaves room for both attempts plus backoff.
func advanceWithCancel(
	ctx workflow.Context, cancelCh workflow.ReceiveChannel, request fragment.Request,
) (fragment.Result, bool, error) {
	advanceCtx, cancelAdvance := workflow.WithCancel(ctx)
	defer cancelAdvance()
	advanceCtx = workflow.WithActivityOptions(advanceCtx, workflow.ActivityOptions{
		StartToCloseTimeout:    4 * time.Minute,
		ScheduleToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: 10 * time.Second, BackoffCoefficient: 2,
			MaximumInterval: 60 * time.Second, MaximumAttempts: 2,
		},
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
