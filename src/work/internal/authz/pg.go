package authz

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/capability"
	workdb "github.com/we-meet/work/internal/db"
)

// capabilityTTL is the issuance policy ceiling. The database further clamps
// the stored expiry to the execution lease and hard deadline.
const capabilityTTL = 30 * time.Second

// PGCommands implements the Node/egress facing commands on top of the
// work_worker domain functions. No SQL runs on a caller-provided connection
// and no body text is ever passed to PostgreSQL.
type PGCommands struct {
	Pool *pgxpool.Pool
}

var commandCode = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}(?::[a-z0-9_]{2,63})?$`)

// mapCommandError reduces a database failure to an enumeration code. A
// message that is not a bare code (constraint text, SQL detail) becomes
// command_failed so nothing leaks through the internal RPC.
func mapCommandError(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && commandCode.MatchString(pgErr.Message) {
		return Fail(pgErr.Message)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Fail("not_found")
	}
	return Fail("command_failed")
}

func (p *PGCommands) ClaimRuntimeExecution(
	ctx context.Context, _ Caller, request ExecutionRequest, holderID string,
) (ExecutionLease, error) {
	var state string
	err := workdb.WithWorkerOrgContext(ctx, p.Pool, request.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.claim_runtime_execution($1, $2, $3)`,
			request.OrgID, request.ExecutionID, holderID).Scan(&state)
	})
	if err != nil {
		return ExecutionLease{}, mapCommandError(err)
	}
	return ExecutionLease{ExecutionID: request.ExecutionID, HolderID: holderID, State: state}, nil
}

func (p *PGCommands) RenewRuntimeExecution(
	ctx context.Context, _ Caller, request ExecutionRequest,
) (ExecutionLease, error) {
	var lease *time.Time
	err := workdb.WithWorkerOrgContext(ctx, p.Pool, request.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.renew_runtime_execution($1, $2, $3, $4)`,
			request.OrgID, request.ExecutionID, request.HolderID, request.HeartbeatSeq).Scan(&lease)
	})
	if err != nil {
		return ExecutionLease{}, mapCommandError(err)
	}
	leaseRow := ExecutionLease{ExecutionID: request.ExecutionID, HolderID: request.HolderID, State: "active"}
	if lease == nil {
		// The command committed expiry and returned no lease; the caller must
		// stop the child rather than treat this as a transient failure.
		leaseRow.State = "expired"
		return leaseRow, nil
	}
	leaseRow.LeaseUntil = lease
	return leaseRow, nil
}

// IssueRuntimeCapability mints one audience-specific bearer for the caller.
// Authorization is re-derived from the locked execution, never from the body:
// the caller must be the workload prefix of the current holder, the execution
// must be active and unexpired, and the fragment mode fixes the only allowed
// audience (plan -> work-content, execute -> work-egress). The database command
// then re-checks state, holder, lease, hard deadline, run fence and mode while
// storing only the token digest.
func (p *PGCommands) IssueRuntimeCapability(
	ctx context.Context, caller Caller, request IssueCapabilityRequest,
) (IssuedCapability, error) {
	if caller.Kind != KindRuntimeParent {
		return IssuedCapability{}, Fail("caller_not_permitted")
	}
	if !validID(request.OrgID) || !validID(request.ExecutionID) ||
		(request.Audience != capability.AudienceContent && request.Audience != capability.AudienceEgress) {
		return IssuedCapability{}, Fail("invalid_request")
	}

	var mode, state string
	var holderID *string
	var leaseUntil, hardDeadline *time.Time
	err := workdb.WithWorkerOrgContext(ctx, p.Pool, request.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT mode, state, holder_id, lease_until, hard_deadline
			FROM work.runtime_execution
			WHERE org_id = $1 AND execution_id = $2`,
			request.OrgID, request.ExecutionID,
		).Scan(&mode, &state, &holderID, &leaseUntil, &hardDeadline)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return IssuedCapability{}, Fail("runtime_execution_not_found")
	}
	if err != nil {
		return IssuedCapability{}, mapCommandError(err)
	}
	if holderID == nil || !holderBelongsTo(caller, *holderID) {
		return IssuedCapability{}, Fail("holder_not_owned")
	}
	if state != "active" {
		return IssuedCapability{}, Fail("runtime_execution_not_active")
	}
	now := time.Now()
	if leaseUntil == nil || hardDeadline == nil ||
		!now.Before(*leaseUntil) || !now.Before(*hardDeadline) {
		return IssuedCapability{}, Fail("runtime_execution_expired")
	}

	var audience string
	switch mode {
	case "plan":
		audience = capability.AudienceContent
	case "execute":
		audience = capability.AudienceEgress
	default:
		return IssuedCapability{}, Fail("runtime_execution_mode_unsupported")
	}
	if request.Audience != audience {
		return IssuedCapability{}, Fail("runtime_capability_audience_not_allowed")
	}

	token, generation, expiresAt, issueErr := capability.NewIssuer(p.Pool).IssueWithExpiry(
		ctx, request.OrgID, request.ExecutionID, *holderID, audience, capabilityTTL,
	)
	if issueErr != nil {
		var capabilityErr *capability.Error
		if errors.As(issueErr, &capabilityErr) && commandCode.MatchString(capabilityErr.Code) {
			return IssuedCapability{}, Fail(capabilityErr.Code)
		}
		return IssuedCapability{}, Fail("command_failed")
	}
	// The database clamps the stored expiry to the lease and hard deadline;
	// report the same effective value from the lease already verified above.
	if leaseUntil.Before(expiresAt) {
		expiresAt = *leaseUntil
	}
	if hardDeadline.Before(expiresAt) {
		expiresAt = *hardDeadline
	}
	return IssuedCapability{
		Token:      token,
		Generation: generation,
		ExpiresAt:  expiresAt,
	}, nil
}

type gateResult struct {
	Outcome             string `json:"outcome"`
	GateState           string `json:"gate_state"`
	ReceiptSlotID       string `json:"receipt_slot_id"`
	GatewayInvocationID string `json:"gateway_invocation_id"`
	Reason              string `json:"reason"`
}

func (p *PGCommands) ConsumeDispatchDelivery(
	ctx context.Context, caller Caller, request DeliveryRequest,
) (ConsumeDecision, error) {
	// The module mints the invocation and the receipt slot so the gateway cannot
	// choose a slot that belongs to another attempt.
	gatewayInvocationID := caller.WorkloadID + ":" + uuid.NewString()
	receiptSlotID := uuid.NewString()
	var result gateResult
	err := workdb.WithWorkerOrgContext(ctx, p.Pool, request.OrgID, func(tx pgx.Tx) error {
		var body []byte
		if err := tx.QueryRow(ctx, `SELECT work.consume_dispatch_delivery($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			request.OrgID, request.OperationID, request.ExecutionID, request.HolderID,
			request.AttemptID, request.RequestHash, request.RunFence,
			gatewayInvocationID, receiptSlotID,
		).Scan(&body); err != nil {
			return err
		}
		return json.Unmarshal(body, &result)
	})
	if err != nil {
		return ConsumeDecision{}, mapCommandError(err)
	}
	return ConsumeDecision{
		Won:               result.Outcome == "won",
		GateState:         result.GateState,
		GatewayInvocation: result.GatewayInvocationID,
		ReceiptSlotID:     result.ReceiptSlotID,
	}, nil
}

// ConsumeByExecution accepts only the signed thin wire. The invocation and the
// receipt slot are minted here, exactly as ConsumeDispatchDelivery does, so the
// egress cannot choose a slot belonging to another attempt.
func (p *PGCommands) ConsumeByExecution(
	ctx context.Context, caller Caller, request ExecutionConsumeRequest,
) (ConsumeDecision, error) {
	gatewayInvocationID := caller.WorkloadID + ":" + uuid.NewString()
	receiptSlotID := uuid.NewString()
	var result gateResult
	err := workdb.WithWorkerOrgContext(ctx, p.Pool, request.OrgID, func(tx pgx.Tx) error {
		var body []byte
		if err := tx.QueryRow(ctx, `SELECT work.consume_dispatch_by_execution($1, $2, $3, $4, $5)`,
			request.OrgID, request.ExecutionID, request.RequestHash,
			gatewayInvocationID, receiptSlotID,
		).Scan(&body); err != nil {
			return err
		}
		return json.Unmarshal(body, &result)
	})
	if err != nil {
		return ConsumeDecision{}, mapCommandError(err)
	}
	return ConsumeDecision{
		Won:               result.Outcome == "won",
		GateState:         result.GateState,
		GatewayInvocation: result.GatewayInvocationID,
		ReceiptSlotID:     result.ReceiptSlotID,
	}, nil
}

func (p *PGCommands) AttachDispatchReceipt(
	ctx context.Context, _ Caller, request ReceiptRequest,
) error {
	var providerRequestID *string
	if strings.TrimSpace(request.ProviderRequestID) != "" {
		value := request.ProviderRequestID
		providerRequestID = &value
	}
	storedResult := "success"
	switch request.ReceiptResult {
	case ReceiptSucceeded:
	case ReceiptRejectedNotExecuted:
		storedResult = "rejected_not_executed"
	default:
		return Fail("invalid_request:receipt_result")
	}
	err := workdb.WithWorkerOrgContext(ctx, p.Pool, request.OrgID, func(tx pgx.Tx) error {
		var body []byte
		return tx.QueryRow(ctx,
			`SELECT work.attach_dispatch_receipt($1, $2, $3, $4, $5, $6, $7)`,
			request.OrgID, request.OperationID, request.ReceiptSlotID,
			request.ReceiptRef, request.ReceiptHash, storedResult, providerRequestID,
		).Scan(&body)
	})
	return mapCommandError(err)
}
