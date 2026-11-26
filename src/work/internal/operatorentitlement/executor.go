package operatorentitlement

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/host"
)

type Host interface {
	ApplyExecutionEntitlement(context.Context, host.ExecutionEntitlementCommand, string) (host.ExecutionEntitlementReceipt, error)
	GetExecutionEntitlementCommand(context.Context, string, string) (host.ExecutionEntitlementReceipt, error)
}

type Command struct {
	OrgID                       string
	ActorSubject                string
	OperatorAuthorizationRef    string
	ExpectedEntitlementRevision int64
	TargetEntitlementRevision   int64
	Enabled                     bool
	SeatLimit                   int
	OperatorSuspended           bool
	RequestID                   string
}

type Result struct {
	LocalOutcome string
	FinalOutcome string
	HostStatus   string
	HostRevision int64
}

type Executor struct {
	Pool *pgxpool.Pool
	Host Host
}

func (e *Executor) Execute(ctx context.Context, command Command) (Result, error) {
	if err := validate(command); err != nil {
		return Result{}, err
	}
	local, err := e.record(ctx, command, nil)
	if err != nil {
		return Result{}, fmt.Errorf("record Work entitlement: %w", err)
	}
	hostCommand := host.ExecutionEntitlementCommand{
		CommandID:                   command.RequestID,
		OrgID:                       command.OrgID,
		ExpectedEntitlementRevision: command.ExpectedEntitlementRevision,
		TargetEntitlementRevision:   command.TargetEntitlementRevision,
		Enabled:                     command.Enabled,
		SeatLimit:                   command.SeatLimit,
		OperatorSuspended:           command.OperatorSuspended,
		OperatorAuthorizationRef:    command.OperatorAuthorizationRef,
	}
	receipt, err := e.Host.ApplyExecutionEntitlement(ctx, hostCommand, command.RequestID)
	if err != nil {
		var hostErr *host.Error
		if !errors.As(err, &hostErr) || hostErr.Code != "entitlement_unavailable" {
			return Result{}, fmt.Errorf("apply Host entitlement: %w", err)
		}
		receipt, err = e.Host.GetExecutionEntitlementCommand(ctx, command.RequestID, command.RequestID)
		if err != nil {
			return Result{}, fmt.Errorf("Host entitlement outcome is unknown: %w", err)
		}
	}
	ackRevision := receipt.Revision
	if ackRevision != command.TargetEntitlementRevision {
		return Result{}, fmt.Errorf("Host entitlement revision %d does not match target %d", ackRevision, command.TargetEntitlementRevision)
	}
	final, err := e.record(ctx, command, &ackRevision)
	if err != nil {
		return Result{}, fmt.Errorf("record Host entitlement acknowledgement: %w", err)
	}
	return Result{
		LocalOutcome: local.Outcome,
		FinalOutcome: final.Outcome,
		HostStatus:   receipt.Status,
		HostRevision: receipt.Revision,
	}, nil
}

type localResult struct {
	Outcome string `json:"outcome"`
}

func (e *Executor) record(ctx context.Context, command Command, ackRevision *int64) (localResult, error) {
	var raw []byte
	tx, err := e.Pool.Begin(ctx)
	if err != nil {
		return localResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.org_id',$1,true), set_config('app.subject_id',$2,true)",
		command.OrgID, command.ActorSubject); err != nil {
		return localResult{}, err
	}
	var ack any
	if ackRevision != nil {
		ack = *ackRevision
	}
	requestID := command.RequestID
	if ackRevision != nil {
		requestID += "-ack"
	}
	if err := tx.QueryRow(ctx, `SELECT work.apply_execution_entitlement(
		$1::text,$2::text,$3::text,$4::boolean,$5::boolean,$6::bigint,
		$7::bigint,$8::bigint,$9::text)`,
		command.OrgID, command.ActorSubject, command.OperatorAuthorizationRef,
		command.Enabled, command.OperatorSuspended, command.SeatLimit,
		command.TargetEntitlementRevision, ack, requestID).Scan(&raw); err != nil {
		return localResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return localResult{}, err
	}
	var result localResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return localResult{}, err
	}
	if result.Outcome == "" {
		return localResult{}, errors.New("Work entitlement command returned no outcome")
	}
	return result, nil
}

func validate(command Command) error {
	if strings.TrimSpace(command.OrgID) == "" || strings.TrimSpace(command.ActorSubject) == "" ||
		strings.TrimSpace(command.OperatorAuthorizationRef) == "" || strings.TrimSpace(command.RequestID) == "" {
		return errors.New("org, actor subject, operator authorization and request id are required")
	}
	if _, err := uuid.Parse(command.OrgID); err != nil {
		return errors.New("org must be a UUID")
	}
	if _, err := uuid.Parse(command.RequestID); err != nil {
		return errors.New("request id must be a UUID")
	}
	if command.ExpectedEntitlementRevision < 0 || command.TargetEntitlementRevision < 1 ||
		command.TargetEntitlementRevision <= command.ExpectedEntitlementRevision {
		return errors.New("entitlement revisions must be non-negative and strictly increasing")
	}
	if command.SeatLimit < 1 {
		return errors.New("seat limit must be positive")
	}
	return nil
}
