package runflow

import (
	"context"
	"errors"
	"net"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/we-meet/work/internal/contentref"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/egress"
	"github.com/we-meet/work/internal/finishing"
	"go.temporal.io/sdk/temporal"
)

type recoveryReadError struct {
	code  string
	cause error
}

func (e *recoveryReadError) Error() string { return e.code }
func (e *recoveryReadError) Unwrap() []error {
	return []error{egress.ErrOutputRecoveryUnavailable, e.cause}
}

func recoverablePersistence(err error) bool {
	if errors.Is(err, egress.ErrOutputRecoveryUnavailable) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return strings.HasPrefix(pgErr.Code, "08") || strings.HasPrefix(pgErr.Code, "40") || strings.HasPrefix(pgErr.Code, "53") || pgErr.Code == "57P01" || pgErr.Code == "57P02" || pgErr.Code == "57P03"
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	var dbErr *workdb.Error
	if errors.As(err, &dbErr) {
		return dbErr.Code == "begin_failed" || dbErr.Code == "commit_failed"
	}
	var refErr *contentref.Error
	if errors.As(err, &refErr) {
		return refErr.Code == "begin_failed" || refErr.Code == "commit_failed" || refErr.Code == "content_reference_unavailable"
	}
	return false
}

func finishFailure(err error, code string) (AdvanceFinishOutput, error) {
	if errors.Is(err, context.Canceled) || temporal.IsCanceledError(err) {
		return AdvanceFinishOutput{}, temporal.NewCanceledError()
	}
	if recoverablePersistence(err) {
		return AdvanceFinishOutput{}, temporal.NewApplicationError(AdvanceErrRecoveryUnavailable, AdvanceErrRecoveryUnavailable)
	}
	return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: code}, nil
}

func finishReceiptFailure(err error) (AdvanceFinishOutput, error) {
	var finishErr *finishing.Error
	verifiedSuccess := errors.As(err, &finishErr) && finishErr.VerifiedSuccess
	if !verifiedSuccess && !errors.Is(err, egress.ErrOutputRecoveryUnavailable) && recoverablePersistence(err) {
		return AdvanceFinishOutput{}, activityFailure(err, "finish_receipt_unavailable")
	}
	return finishFailure(err, finishErrorCode(err))
}

func waitRunFailure(err error, recovery bool) error {
	if !recovery {
		return activityFailure(err, "wait_run_failed")
	}
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || temporal.IsCanceledError(err) {
		return temporal.NewCanceledError()
	}
	var pgErr *pgconn.PgError
	stateChanged := errors.As(err, &pgErr) && pgErr.Code == "P0001" && pgErr.Message == "run_not_active"
	if recoverablePersistence(err) || stateChanged {
		return temporal.NewApplicationError("wait_run_failed", "wait_run_unavailable")
	}
	return temporal.NewNonRetryableApplicationError("wait_run_failed", "wait_run_refused", nil)
}
