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
	case code == "operation_key_conflict":
		// prepare_local_operation's idempotency authority is (org, run, logical_key), not
		// prepare_id (O-9 = jia): the same key with a DIFFERENT request_hash is a hash conflict,
		// which §582 maps to ABORTED. The device must not retry it unchanged.
		return status.Error(codes.Aborted, code)
	case code == "revision_conflict":
		// acknowledge_device_cancel compares the acked cancel_revision against the Run's
		// current control_revision (0056). §582 maps a revision conflict to ABORTED: the device
		// must re-read the cancel downlink rather than retry the same revision unchanged.
		return status.Error(codes.Aborted, code)
	case code == "run_cancel_requested":
		// The Run has no cancel to acknowledge (0056), or finish_local_run_state refused a
		// succeeded outcome under cancel_requested (0042:1808). Both are state preconditions:
		// the caller is authenticated and allowed to ask, but the Run's state refuses it now.
		return status.Error(codes.FailedPrecondition, code)
	case code == "stale_fence" || code == "run_has_unreconciled_operation" ||
		code == "supersede_not_allowed" || code == "supersede_limit_exceeded" ||
		code == "classification_floor_required" || code == "destination_not_allowed_for_local_only" ||
		code == "local_policy_not_configured" || code == "local_policy_incomplete":
		// State preconditions, not identity failures and not service faults: the caller is
		// authenticated and allowed to ask, but the Run/lease/grant/policy state refuses this
		// action now. §582 maps version/precondition failures to FAILED_PRECONDITION, which is
		// the gRPC analogue of the 409 these codes carry in control-design §9. In particular
		// run_has_unreconciled_operation means "wait for reconciliation", not "reconnect"
		// (device-design §6.2), and destination_not_allowed_for_local_only is derived from the
		// Run's taint rather than from the caller's permissions, so it is not PERMISSION_DENIED.
		return status.Error(codes.FailedPrecondition, code)
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
