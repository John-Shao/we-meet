package runflow

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/we-meet/work/internal/egress"
	"github.com/we-meet/work/internal/finishing"
	"go.temporal.io/sdk/temporal"
)

func TestFinishReceiptRecoveryRequiresSuccessEvidence(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		recovery bool
	}{
		{"lookup_unavailable", &pgconn.PgError{Code: "08006"}, false},
		{"rejected_reconcile_unavailable", &finishing.Error{Code: "finish_command_failed", Err: &pgconn.PgError{Code: "40001"}}, false},
		{"verified_success_unavailable", &finishing.Error{Code: "finish_command_failed", Err: &pgconn.PgError{Code: "40001"}, VerifiedSuccess: true}, true},
		{"verified_success_refused", &finishing.Error{Code: "finish_command_failed", Err: &pgconn.PgError{Code: "42501"}, VerifiedSuccess: true}, false},
		{"staged_output_unavailable", egress.ErrOutputRecoveryUnavailable, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := finishReceiptFailure(tc.err)
			var app *temporal.ApplicationError
			got := errors.As(err, &app) && app.Type() == AdvanceErrRecoveryUnavailable && !app.NonRetryable()
			if got != tc.recovery {
				t.Fatalf("recovery=%t want %t: %v", got, tc.recovery, err)
			}
		})
	}
}

func TestRecoveryReadPreservesCancellation(t *testing.T) {
	_, err := finishFailure(&recoveryReadError{code: "safe_code", cause: context.Canceled}, "safe_code")
	if !temporal.IsCanceledError(err) {
		t.Fatalf("cancellation converted to recovery: %v", err)
	}
	_, err = finishReceiptFailure(&finishing.Error{Code: "safe_code", Err: context.Canceled, VerifiedSuccess: true})
	if !temporal.IsCanceledError(err) {
		t.Fatalf("verified success swallowed cancellation: %v", err)
	}
}

func TestWaitRunRecoveryClassificationIsOptIn(t *testing.T) {
	for _, tc := range []struct {
		name    string
		err     error
		refused bool
	}{
		{"transient", &pgconn.PgError{Code: "08006"}, false},
		{"cancel_race", &pgconn.PgError{Code: "P0001", Message: "run_not_active"}, false},
		{"permanent", &pgconn.PgError{Code: "42501"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			legacy := waitRunFailure(tc.err, false)
			if legacy == nil || legacy.Error() != "wait_run_failed" {
				t.Fatalf("ordinary wait error changed: %v", legacy)
			}
			failure := temporal.GetDefaultFailureConverter().ErrorToFailure(legacy)
			if failure.GetApplicationFailureInfo().GetNonRetryable() {
				t.Fatal("ordinary wait became nonretryable")
			}
			var app *temporal.ApplicationError
			err := waitRunFailure(tc.err, true)
			if !errors.As(err, &app) || app.NonRetryable() != tc.refused {
				t.Fatalf("recovery wait classification: %v", err)
			}
			wantType := "wait_run_unavailable"
			if tc.refused {
				wantType = "wait_run_refused"
			}
			if app.Type() != wantType {
				t.Fatalf("type=%q want %q", app.Type(), wantType)
			}
		})
	}
	if !temporal.IsCanceledError(waitRunFailure(context.Canceled, true)) {
		t.Fatal("recovery wait swallowed cancellation")
	}
	body, err := json.Marshal(WaitRunInput{RunID: "run", OrgID: "org", Reason: "reconcile"})
	if err != nil || string(body) != `{"run_id":"run","org_id":"org","reason":"reconcile"}` {
		t.Fatalf("ordinary wait payload changed: %s, %v", body, err)
	}
}
