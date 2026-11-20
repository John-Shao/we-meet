package runflow_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"

	"github.com/we-meet/work/internal/runflow"
)

// These are SDK virtual-time/version-mock tests, NOT production-history replay.
// Real pre-change histories must still be replayed before release.
const finishRecoveryChangeID = "advance-finish-recovery-wait-v1"

func newFinishRecoveryEnv(t *testing.T) (*testsuite.TestWorkflowEnvironment, runflow.Input, runflow.AdvanceFinishInput) {
	t.Helper()
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.SetStartTime(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC))
	env.RegisterWorkflow(runflow.RunWorkflowAdvance)
	env.RegisterActivity(&runflow.Activities{})
	prepared, head, input := quotaAdvanceFixture()
	finishInput := runflow.AdvanceFinishInput{
		Prepared: prepared, Head: head,
		Execution: runflow.AdvanceExecution{
			ExecutionID: advanceExecutionID, OperationID: advanceOperationID,
			AttemptID: advanceAttemptID, ReservationID: advanceReservationID,
			RequestHash: advanceHash, IntentRef: advanceRefID, IntentHash: advanceHash,
			DeadlineUnixMs: env.Now().Add(time.Minute).UnixMilli(),
		},
	}
	env.OnActivity(runflow.ActivityPrepareAdvance, mock.Anything, input).Return(prepared, nil).Once()
	env.OnActivity(runflow.ActivityEnsureHead, mock.Anything, prepared).Return(head, nil).Once()
	env.OnActivity(runflow.ActivityPrepareExecution, mock.Anything, runflow.PrepareExecutionInput{
		Prepared: prepared, Head: head,
	}).Return(finishInput.Execution, nil).Once()
	env.OnActivity(runflow.ActivityAdvanceRuntime, mock.Anything, mock.Anything).
		Return(checkpointedResult(), nil).Once()
	t.Cleanup(func() {
		env.AssertExpectations(t)
		env.AssertNumberOfCalls(t, runflow.ActivityPrepareAdvance, 1)
		env.AssertNumberOfCalls(t, runflow.ActivityEnsureHead, 1)
		env.AssertNumberOfCalls(t, runflow.ActivityPrepareExecution, 1)
		env.AssertNumberOfCalls(t, runflow.ActivityAdvanceRuntime, 1)
		env.AssertNotCalled(t, runflow.ActivityResumeRun, mock.Anything, mock.Anything)
	})
	return env, input, finishInput
}

func finishRecoveryError() error {
	return temporal.NewApplicationError("durable success; answer registration unavailable", runflow.AdvanceErrRecoveryUnavailable)
}

func expectFinishRecoveryAbort(env *testsuite.TestWorkflowEnvironment, input runflow.Input, finish runflow.AdvanceFinishInput, outcome, reason string) {
	env.OnActivity(runflow.ActivityRevokeExecution, mock.Anything, runflow.RevokeExecutionInput{
		RunID: input.RunID, OrgID: input.OrgID, ExecutionID: finish.Execution.ExecutionID, Reason: reason,
	}).Return(nil).Once()
	env.OnActivity(runflow.ActivityAbortRun, mock.Anything, runflow.AbortRunInput{
		RunID: input.RunID, OrgID: input.OrgID,
		OperationID: finish.Execution.OperationID, ReservationID: finish.Execution.ReservationID,
		Outcome: outcome, Reason: reason,
	}).Return(nil).Once()
}

func assertFinishRecoveryResult(t *testing.T, env *testsuite.TestWorkflowEnvironment, reason string) {
	t.Helper()
	if !env.IsWorkflowCompleted() {
		t.Fatal("workflow did not complete")
	}
	err := env.GetWorkflowError()
	if reason == "" {
		if err != nil {
			t.Fatalf("workflow: %v", err)
		}
	} else if err == nil || !strings.Contains(err.Error(), reason) {
		t.Fatalf("workflow error = %v, want %s", err, reason)
	}
}

func TestRunWorkflowAdvanceFinishCancellationPreservesVersionedOutcome(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		name := "current"
		if legacy {
			name = "legacy"
		}
		t.Run(name, func(t *testing.T) {
			env, input, finish := newFinishRecoveryEnv(t)
			env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
				Return(runflow.AdvanceFinishOutput{}, temporal.NewCanceledError()).Once()
			outcome, reason, wantError := "canceled", "run_canceled", ""
			if legacy {
				env.OnGetVersion(finishRecoveryChangeID, workflow.DefaultVersion, 1).Return(workflow.DefaultVersion).Once()
				outcome, reason, wantError = "failed", "finish_failed", "finish_failed"
			}
			expectFinishRecoveryAbort(env, input, finish, outcome, reason)
			env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)
			assertFinishRecoveryResult(t, env, wantError)
			env.AssertNotCalled(t, runflow.ActivityWaitRun, mock.Anything, mock.Anything)
		})
	}
}

func TestRunWorkflowAdvanceFinishRecoveryResumesWithoutRedispatch(t *testing.T) {
	env, input, finish := newFinishRecoveryEnv(t)
	start := env.Now()
	var timers []time.Time
	env.SetOnTimerScheduledListener(func(_ string, duration time.Duration) {
		if duration == 24*time.Hour {
			timers = append(timers, env.Now())
		}
	})
	// The retryable ApplicationError is wrapped in an ActivityError by the SDK.
	// All three internal attempts must exhaust before any recovery park appears.
	env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
		Return(runflow.AdvanceFinishOutput{}, finishRecoveryError()).Times(3)
	env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
		Return(runflow.AdvanceFinishOutput{Status: runflow.AdvanceStatusSucceeded}, nil).Once()
	env.OnActivity(runflow.ActivityWaitRun, mock.Anything, runflow.WaitRunInput{
		RunID: input.RunID, OrgID: input.OrgID, Reason: "reconcile", Recovery: true,
	}).Return(nil).Once()
	env.OnActivity(runflow.ActivityFinishRun, mock.Anything, runflow.FinishRunInput{
		RunID: input.RunID, OrgID: input.OrgID, Outcome: "succeeded",
	}).Return(nil).Once()
	env.RegisterDelayedCallback(func() {
		env.AssertNumberOfCalls(t, runflow.ActivityFinishAdvance, 2)
		env.AssertNotCalled(t, runflow.ActivityWaitRun, mock.Anything, mock.Anything)
	}, 2*time.Second)
	env.RegisterDelayedCallback(func() {
		if env.IsWorkflowCompleted() {
			t.Error("workflow completed without explicit resume")
		}
		env.AssertNumberOfCalls(t, runflow.ActivityFinishAdvance, 3)
		env.AssertNumberOfCalls(t, runflow.ActivityWaitRun, 1)
		env.SignalWorkflow("resume", nil)
	}, time.Hour)

	env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

	assertFinishRecoveryResult(t, env, "")
	if len(timers) != 1 || !timers[0].Equal(start.Add(3*time.Second)) {
		t.Fatalf("recovery timer starts = %v, want first exhausted failure at %v", timers, start.Add(3*time.Second))
	}
	env.AssertNumberOfCalls(t, runflow.ActivityFinishAdvance, 4)
	env.AssertNotCalled(t, runflow.ActivityAbortRun, mock.Anything, mock.Anything)
	env.AssertNotCalled(t, runflow.ActivityRevokeExecution, mock.Anything, mock.Anything)
}

func TestRunWorkflowAdvanceFinishRecoveryWaitRunRetries(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		resumeAt time.Duration
	}{
		{"unavailable", temporal.NewApplicationError("wait_run_unavailable", "wait_run_unavailable"), time.Hour},
		{"queued_resume", temporal.NewApplicationError("wait_run_unavailable", "wait_run_unavailable"), 30 * time.Second},
		{"timeout", temporal.NewTimeoutError(enumspb.TIMEOUT_TYPE_START_TO_CLOSE, nil), time.Hour},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env, input, finish := newFinishRecoveryEnv(t)
			start := env.Now()
			env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
				Return(runflow.AdvanceFinishOutput{}, finishRecoveryError()).Times(3)
			env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
				Return(runflow.AdvanceFinishOutput{Status: runflow.AdvanceStatusSucceeded}, nil).Once()
			waitInput := runflow.WaitRunInput{RunID: input.RunID, OrgID: input.OrgID, Reason: "reconcile", Recovery: true}
			env.OnActivity(runflow.ActivityWaitRun, mock.Anything, waitInput).Return(tc.err).Times(3)
			env.OnActivity(runflow.ActivityWaitRun, mock.Anything, waitInput).Return(nil).Once().
				Run(func(mock.Arguments) {
					if elapsed := env.Now().Sub(start); elapsed != 66*time.Second {
						t.Errorf("WaitRun retry at %s, want 66s", elapsed)
					}
				})
			env.OnActivity(runflow.ActivityFinishRun, mock.Anything, runflow.FinishRunInput{
				RunID: input.RunID, OrgID: input.OrgID, Outcome: "succeeded",
			}).Return(nil).Once()
			env.RegisterDelayedCallback(func() {
				env.AssertNumberOfCalls(t, runflow.ActivityWaitRun, 3)
				env.AssertNumberOfCalls(t, runflow.ActivityFinishAdvance, 3)
			}, time.Minute)
			env.RegisterDelayedCallback(func() {
				if env.IsWorkflowCompleted() {
					t.Error("completed without resume")
				}
				env.AssertNumberOfCalls(t, runflow.ActivityFinishAdvance, 3)
				env.SignalWorkflow("resume", nil)
			}, tc.resumeAt)

			env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

			assertFinishRecoveryResult(t, env, "")
			wantElapsed := tc.resumeAt
			if wantElapsed < 66*time.Second {
				wantElapsed = 66 * time.Second
			}
			if elapsed := env.Now().Sub(start); elapsed != wantElapsed {
				t.Fatalf("elapsed = %s, want %s", elapsed, wantElapsed)
			}
			env.AssertNumberOfCalls(t, runflow.ActivityFinishAdvance, 4)
			env.AssertNumberOfCalls(t, runflow.ActivityWaitRun, 4)
			env.AssertNotCalled(t, runflow.ActivityAbortRun, mock.Anything, mock.Anything)
		})
	}
}

func TestRunWorkflowAdvanceFinishRecoveryWaitRunRejectsPermanentErrors(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		attempts int
	}{
		{"non_retryable", temporal.NewNonRetryableApplicationError("denied", "wait_run_unavailable", nil), 1},
		{"different_type", temporal.NewApplicationError("wait_run_unavailable", "wait_run_denied"), 3},
		{"unclassified", errors.New("wait_run_unavailable"), 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env, input, finish := newFinishRecoveryEnv(t)
			start := env.Now()
			env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
				Return(runflow.AdvanceFinishOutput{}, finishRecoveryError()).Times(3)
			env.OnActivity(runflow.ActivityWaitRun, mock.Anything, mock.Anything).
				Return(tc.err).Times(tc.attempts)
			expectFinishRecoveryAbort(env, input, finish, "failed", "reconcile_wait_failed")

			env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

			assertFinishRecoveryResult(t, env, "reconcile_wait_failed")
			if elapsed := env.Now().Sub(start); elapsed > 6*time.Second {
				t.Fatalf("permanent WaitRun failure parked for %s", elapsed)
			}
			env.AssertNumberOfCalls(t, runflow.ActivityFinishAdvance, 3)
			env.AssertNumberOfCalls(t, runflow.ActivityWaitRun, tc.attempts)
		})
	}
}

func TestRunWorkflowAdvanceFinishRecoveryWaitRunFailureDeadline(t *testing.T) {
	env, input, finish := newFinishRecoveryEnv(t)
	start := env.Now()
	timers := 0
	env.SetOnTimerScheduledListener(func(_ string, duration time.Duration) {
		if duration == 24*time.Hour {
			timers++
		}
	})
	env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
		Return(runflow.AdvanceFinishOutput{}, finishRecoveryError()).Times(3)
	env.OnActivity(runflow.ActivityWaitRun, mock.Anything, mock.Anything).
		Return(temporal.NewApplicationError("wait_run_unavailable", "wait_run_unavailable"))
	for i := 1; i <= 24; i++ {
		env.RegisterDelayedCallback(func() { env.SignalWorkflow("resume", nil) }, time.Duration(i)*time.Hour)
	}
	expectFinishRecoveryAbort(env, input, finish, "failed", runflow.AdvanceReasonReconcileTimeout)

	env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

	assertFinishRecoveryResult(t, env, runflow.AdvanceReasonReconcileTimeout)
	if elapsed := env.Now().Sub(start); elapsed != 24*time.Hour+3*time.Second {
		t.Fatalf("WaitRun failures extended recovery window: %s", elapsed)
	}
	if timers != 1 {
		t.Fatalf("24h timers = %d, want 1", timers)
	}
	env.AssertNumberOfCalls(t, runflow.ActivityFinishAdvance, 3)
	env.AssertNotCalled(t, runflow.ActivityFinishRun, mock.Anything, mock.Anything)
}

func TestRunWorkflowAdvanceFinishRecoveryWaitRunCancelBackoff(t *testing.T) {
	env, input, finish := newFinishRecoveryEnv(t)
	start := env.Now()
	env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
		Return(runflow.AdvanceFinishOutput{}, finishRecoveryError()).Times(3)
	env.OnActivity(runflow.ActivityWaitRun, mock.Anything, mock.Anything).
		Return(temporal.NewApplicationError("wait_run_unavailable", "wait_run_unavailable")).Times(3)
	env.RegisterDelayedCallback(func() { env.SignalWorkflow("resume", nil) }, 10*time.Second)
	env.RegisterDelayedCallback(func() { env.SignalWorkflow("cancel", nil) }, 30*time.Second)
	expectFinishRecoveryAbort(env, input, finish, "canceled", "run_canceled")

	env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

	assertFinishRecoveryResult(t, env, "")
	if elapsed := env.Now().Sub(start); elapsed != 30*time.Second {
		t.Fatalf("cancel completed at %s, want 30s", elapsed)
	}
	env.AssertNumberOfCalls(t, runflow.ActivityFinishAdvance, 3)
	env.AssertNumberOfCalls(t, runflow.ActivityWaitRun, 3)
	env.AssertNotCalled(t, runflow.ActivityFinishRun, mock.Anything, mock.Anything)
}

func TestRunWorkflowAdvanceFinishRecoveryDeadlineDoesNotRefresh(t *testing.T) {
	for _, name := range []string{"no_resume", "repeated_resume", "usage_after_recovery", "usage_before_and_after_recovery"} {
		t.Run(name, func(t *testing.T) {
			env, input, finish := newFinishRecoveryEnv(t)
			start := env.Now()
			wantDuration := 24*time.Hour + 3*time.Second
			waitCalls, finishCalls, timerCalls := 1, 3, 1
			timers := 0
			env.SetOnTimerScheduledListener(func(_ string, duration time.Duration) {
				if duration == 24*time.Hour {
					timers++
				}
			})
			signalAt := func(delay time.Duration) {
				env.RegisterDelayedCallback(func() { env.SignalWorkflow("resume", nil) }, delay)
			}
			if name == "usage_before_and_after_recovery" {
				env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
					Return(runflow.AdvanceFinishOutput{Status: runflow.AdvanceStatusUsageUnavailable}, nil).Once()
				signalAt(2 * time.Hour)
				wantDuration += 2 * time.Hour
				env.OnActivity(runflow.ActivityWaitRun, mock.Anything, runflow.WaitRunInput{
					RunID: input.RunID, OrgID: input.OrgID, Reason: "reconcile",
				}).Return(nil).Once()
				finishCalls++
				timerCalls++ // The original usage timer remains on the historical path.
			}
			recoveryAttempts := 3
			if name == "repeated_resume" {
				for i := 1; i <= 23; i++ {
					signalAt(time.Duration(i) * time.Hour)
				}
				recoveryAttempts, waitCalls, finishCalls = 72, 24, 72
				// Even queued resumes at the boundary cannot trigger another finish.
				env.RegisterDelayedCallback(func() {
					for i := 0; i < 20; i++ {
						env.SignalWorkflow("resume", nil)
					}
				}, wantDuration)
			}
			env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
				Return(runflow.AdvanceFinishOutput{}, finishRecoveryError()).Times(recoveryAttempts)
			if name == "usage_after_recovery" || name == "usage_before_and_after_recovery" {
				signalAt(12 * time.Hour)
				signalAt(23 * time.Hour)
				env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
					Return(runflow.AdvanceFinishOutput{Status: runflow.AdvanceStatusUsageUnavailable}, nil).Times(2)
				waitCalls += 2
				finishCalls += 2
			}
			env.OnActivity(runflow.ActivityWaitRun, mock.Anything, runflow.WaitRunInput{
				RunID: input.RunID, OrgID: input.OrgID, Reason: "reconcile", Recovery: true,
			}).Return(nil).Times(waitCalls)
			expectFinishRecoveryAbort(env, input, finish, "failed", runflow.AdvanceReasonReconcileTimeout)

			env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

			assertFinishRecoveryResult(t, env, runflow.AdvanceReasonReconcileTimeout)
			if elapsed := env.Now().Sub(start); elapsed != wantDuration {
				t.Fatalf("elapsed = %s, want %s from first exhausted recovery failure", elapsed, wantDuration)
			}
			if timers != timerCalls {
				t.Fatalf("24h timers = %d, want %d", timers, timerCalls)
			}
			env.AssertNumberOfCalls(t, runflow.ActivityFinishAdvance, finishCalls)
			env.AssertNotCalled(t, runflow.ActivityFinishRun, mock.Anything, mock.Anything)
		})
	}
}

func TestRunWorkflowAdvanceFinishRecoveryCancelIsImmediate(t *testing.T) {
	for _, name := range []string{"parked", "wait_activity", "resumed_finish"} {
		t.Run(name, func(t *testing.T) {
			env, input, finish := newFinishRecoveryEnv(t)
			start := env.Now()
			env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
				Return(runflow.AdvanceFinishOutput{}, finishRecoveryError()).Times(3)
			wait := env.OnActivity(runflow.ActivityWaitRun, mock.Anything, runflow.WaitRunInput{
				RunID: input.RunID, OrgID: input.OrgID, Reason: "reconcile", Recovery: true,
			}).Return(nil).Once()
			cancelAt := time.Hour
			finishCalls := 3
			if name == "wait_activity" {
				wait.After(10 * time.Second)
				cancelAt = 4 * time.Second
			}
			if name == "resumed_finish" {
				env.RegisterDelayedCallback(func() { env.SignalWorkflow("resume", nil) }, time.Hour)
				env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
					Return(runflow.AdvanceFinishOutput{Status: runflow.AdvanceStatusSucceeded}, nil).
					After(10 * time.Second).Once()
				cancelAt += time.Second
				finishCalls++
			}
			env.RegisterDelayedCallback(func() { env.SignalWorkflow("cancel", nil) }, cancelAt)
			expectFinishRecoveryAbort(env, input, finish, "canceled", "run_canceled")

			env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

			assertFinishRecoveryResult(t, env, "")
			if elapsed := env.Now().Sub(start); elapsed != cancelAt {
				t.Fatalf("cancel completed at %s, want %s", elapsed, cancelAt)
			}
			env.AssertNumberOfCalls(t, runflow.ActivityFinishAdvance, finishCalls)
			env.AssertNotCalled(t, runflow.ActivityFinishRun, mock.Anything, mock.Anything)
		})
	}
}

func TestRunWorkflowAdvanceFinishRecoveryDeadlineInterruptsResumedActivity(t *testing.T) {
	env, input, finish := newFinishRecoveryEnv(t)
	start := env.Now()
	env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
		Return(runflow.AdvanceFinishOutput{}, finishRecoveryError()).Times(3)
	env.OnActivity(runflow.ActivityWaitRun, mock.Anything, runflow.WaitRunInput{
		RunID: input.RunID, OrgID: input.OrgID, Reason: "reconcile", Recovery: true,
	}).Return(nil).Once()
	env.RegisterDelayedCallback(func() { env.SignalWorkflow("resume", nil) }, 24*time.Hour+2*time.Second)
	env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
		Return(runflow.AdvanceFinishOutput{Status: runflow.AdvanceStatusSucceeded}, nil).
		After(10 * time.Second).Once()
	expectFinishRecoveryAbort(env, input, finish, "failed", runflow.AdvanceReasonReconcileTimeout)

	env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

	assertFinishRecoveryResult(t, env, runflow.AdvanceReasonReconcileTimeout)
	if elapsed := env.Now().Sub(start); elapsed != 24*time.Hour+3*time.Second {
		t.Fatalf("resumed activity extended the 24h recovery window: %s", elapsed)
	}
	env.AssertNotCalled(t, runflow.ActivityFinishRun, mock.Anything, mock.Anything)
}

func TestRunWorkflowAdvanceFinishRecoveryDoesNotParkOtherFailures(t *testing.T) {
	for _, tc := range []struct {
		name     string
		output   runflow.AdvanceFinishOutput
		err      error
		attempts int
		reason   string
	}{
		{name: "unclassified_error", err: errors.New("internal failure"), attempts: 3, reason: "finish_failed"},
		{name: "message_is_not_type", err: errors.New(runflow.AdvanceErrRecoveryUnavailable), attempts: 3, reason: "finish_failed"},
		{name: "different_type", err: temporal.NewApplicationError("unavailable", "other_finish_error"), attempts: 3, reason: "finish_failed"},
		{name: "non_retryable", err: temporal.NewNonRetryableApplicationError("permanent", runflow.AdvanceErrRecoveryUnavailable, nil), attempts: 1, reason: "finish_failed"},
		{name: "invalid_binding", output: runflow.AdvanceFinishOutput{Status: runflow.AdvanceStatusFailed, ErrCode: "finish_binding_mismatch"}, attempts: 1, reason: "finish_binding_mismatch"},
		{name: "failed_output_is_not_recovery_error", output: runflow.AdvanceFinishOutput{Status: runflow.AdvanceStatusFailed, ErrCode: runflow.AdvanceErrRecoveryUnavailable}, attempts: 1, reason: runflow.AdvanceErrRecoveryUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env, input, finish := newFinishRecoveryEnv(t)
			start := env.Now()
			env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
				Return(tc.output, tc.err).Times(tc.attempts)
			expectFinishRecoveryAbort(env, input, finish, "failed", tc.reason)

			env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

			assertFinishRecoveryResult(t, env, tc.reason)
			if elapsed := env.Now().Sub(start); elapsed > 3*time.Second {
				t.Fatalf("terminal failure parked for %s", elapsed)
			}
			env.AssertNotCalled(t, runflow.ActivityWaitRun, mock.Anything, mock.Anything)
			env.AssertNotCalled(t, runflow.ActivityFinishRun, mock.Anything, mock.Anything)
		})
	}
}

func TestRunWorkflowAdvanceFinishRecoveryDefaultVersionStillFailsImmediately(t *testing.T) {
	env, input, finish := newFinishRecoveryEnv(t)
	start := env.Now()
	// This explicitly tests the old version branch, not a replay of real history.
	env.OnGetVersion(finishRecoveryChangeID, workflow.DefaultVersion, workflow.Version(1)).
		Return(workflow.DefaultVersion).Once()
	env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
		Return(runflow.AdvanceFinishOutput{}, finishRecoveryError()).Times(3)
	expectFinishRecoveryAbort(env, input, finish, "failed", "finish_failed")

	env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

	assertFinishRecoveryResult(t, env, "finish_failed")
	if elapsed := env.Now().Sub(start); elapsed != 3*time.Second {
		t.Fatalf("DefaultVersion changed immediate-fail timing: %s", elapsed)
	}
	env.AssertNotCalled(t, runflow.ActivityWaitRun, mock.Anything, mock.Anything)
	env.AssertNotCalled(t, runflow.ActivityFinishRun, mock.Anything, mock.Anything)
}

func TestRunWorkflowAdvanceUsageOnlyStillRestartsWaitAfterEachResume(t *testing.T) {
	env, input, finish := newFinishRecoveryEnv(t)
	start := env.Now()
	env.OnActivity(runflow.ActivityFinishAdvance, mock.Anything, finish).
		Return(runflow.AdvanceFinishOutput{Status: runflow.AdvanceStatusUsageUnavailable}, nil).Times(2)
	env.OnActivity(runflow.ActivityWaitRun, mock.Anything, runflow.WaitRunInput{
		RunID: input.RunID, OrgID: input.OrgID, Reason: "reconcile",
	}).Return(nil).Times(2)
	env.RegisterDelayedCallback(func() { env.SignalWorkflow("resume", nil) }, 23*time.Hour)
	expectFinishRecoveryAbort(env, input, finish, "failed", runflow.AdvanceReasonReconcileTimeout)

	env.ExecuteWorkflow(runflow.RunWorkflowAdvance, input)

	assertFinishRecoveryResult(t, env, runflow.AdvanceReasonReconcileTimeout)
	if elapsed := env.Now().Sub(start); elapsed != 47*time.Hour {
		t.Fatalf("ordinary usage wait no longer restarts after resume: %s", elapsed)
	}
}
