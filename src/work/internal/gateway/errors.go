package gateway

import (
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	workdb "github.com/we-meet/work/internal/db"
)

// mapError translates a domain/gateway error into the gRPC status mapping of
// control-design §580: identity failure UNAUTHENTICATED, permission
// PERMISSION_DENIED, version FAILED_PRECONDITION, revision/hash conflict ABORTED,
// size/rate RESOURCE_EXHAUSTED, service unavailable UNAVAILABLE. The business code
// is preserved in the status message; no path/body/key is echoed.
func mapError(err error) error {
	if err == nil {
		return nil
	}
	code := errorCode(err)
	switch {
	case code == "unauthorized":
		return status.Error(codes.Unauthenticated, "unauthorized")
	case code == "device_revoked":
		return status.Error(codes.PermissionDenied, "device_revoked")
	case code == "not_found":
		return status.Error(codes.NotFound, "not_found")
	case code == "run_not_found":
		// The Run does not exist (acquire_device_lease, record_device_checkpoint,
		// finish_local_run). Without this it fell through to Internal/service_degraded, so a
		// device could not tell "no such Run" from "server broken" — the same observability
		// gap GW10 closed for resync_required. The code is already registered.
		return status.Error(codes.NotFound, code)
	case code == "rate_limited":
		return status.Error(codes.ResourceExhausted, "rate_limited")
	case code == "idempotency_key_conflict" || code == "idempotency_conflict":
		return status.Error(codes.Aborted, code)
	case strings.HasPrefix(code, "unknown_required_feature"):
		return status.Error(codes.FailedPrecondition, code)
	case code == "resync_required":
		// An expired lease is never revived (0051 restates 0041's J12 rule). The device
		// must reconcile and re-acquire, which is a state precondition, not a service
		// failure: §582 maps version/precondition failures to FAILED_PRECONDITION and the
		// catalog already registers resync_required (409, recovery_action=resync).
		return status.Error(codes.FailedPrecondition, code)
	case strings.HasPrefix(code, "invalid_request"):
		return status.Error(codes.InvalidArgument, code)
	case code == "org_context_mismatch" || code == "service_degraded":
		return status.Error(codes.Internal, "service_degraded")
	default:
		return status.Error(codes.Internal, "service_degraded")
	}
}

// errorCode extracts the domain code from a wrapped db error, a raw PostgreSQL
// exception (the SQL RAISE message, e.g. "unauthorized", "device_revoked"), or a
// gateway-local error string.
func errorCode(err error) string {
	var dbErr *workdb.Error
	if errors.As(err, &dbErr) {
		return dbErr.Code
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Message
	}
	return err.Error()
}
