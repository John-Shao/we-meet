// Package finishing recovers the internal finish of a confirmed model call
// from the trusted receipt.
//
// The invariant this package implements is signed in D1 §5.4 "回执与用量的原子
// 收尾" and D4 §8.1 "Canonical 提交点与恢复算法" / "可信回执的持久性与迟到处理":
// once the model call is confirmed successful, a later internal failure
// (content write, settlement, publication) is finished forward from the
// receipt. It is never reclassified as an external unknown, and a failure to
// finish internally is never turned into a second model call.
//
// The resolver deliberately takes only (org, operation). Everything it acts on
// is read back from the database and the immutable Content Store documents:
// the activity that held the provider response may be gone, so activity input
// is not evidence.
package finishing

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/receipt"
)

// Outcome.Status values.
const (
	StatusConfirmed        = "confirmed"
	StatusAlreadyConfirmed = "already_confirmed"
	StatusUsageUnavailable = "usage_unavailable"
)

var (
	// ErrGateNotFound means no dispatch gate exists for the operation in this
	// tenant. A foreign tenant's gate is indistinguishable from a missing one.
	ErrGateNotFound = errors.New("dispatch_gate_not_found")
	// ErrReceiptNotAttached means the gate is consumed but no terminal receipt
	// has been bound. Success is never inferred from a consumed gate.
	ErrReceiptNotAttached = errors.New("receipt_not_attached")
	// ErrSealedNotSent means the database sealed this operation as not sent.
	// There is no receipt to recover.
	ErrSealedNotSent = errors.New("sealed_not_sent")
	// ErrRejectedWithoutFinishingPath means the terminal receipt is a provable
	// not-executed rejection. The signed reconcile-resolution enum has no
	// rejection branch and 0009's finishing command refuses such a gate, so
	// this resolver mutates nothing.
	ErrRejectedWithoutFinishingPath = errors.New("rejected_without_finishing_path")
	// ErrOperationNotFound means the gate references no readable operation.
	ErrOperationNotFound = errors.New("operation_not_found")
	// ErrExecutionNotFound means the gate references no readable execution.
	ErrExecutionNotFound = errors.New("runtime_execution_not_found")
	// ErrExecutionBindingMismatch means the gate, operation and execution
	// fragments do not describe the same request.
	ErrExecutionBindingMismatch = errors.New("runtime_execution_binding_mismatch")
	// ErrOperationBindingMismatch means the operation and the gate disagree.
	ErrOperationBindingMismatch = errors.New("operation_binding_mismatch")
	// ErrReceiptUnavailable means the receipt document cannot be read.
	ErrReceiptUnavailable = errors.New("receipt_document_unavailable")
	// ErrReceiptInvalid means the receipt document is not a valid terminal
	// receipt. Parse and schema detail is deliberately not rendered.
	ErrReceiptInvalid = errors.New("receipt_invalid")
	// ErrIntentUnavailable means the frozen model request cannot be read.
	ErrIntentUnavailable = errors.New("intent_document_unavailable")
	// ErrIntentInvalid means the frozen model request is not a valid document.
	ErrIntentInvalid = errors.New("intent_document_invalid")
	// ErrUsageIncomplete means a known-usage receipt is missing a token count.
	ErrUsageIncomplete = errors.New("usage_incomplete")
	// ErrFinishCommand means work.finish_operation_from_receipt rejected the
	// recovery. The operation is not reported as finished.
	ErrFinishCommand = errors.New("finish_command_failed")
	// ErrReadPrivilegeMissing means the worker role cannot read the 0009
	// ledgers. It is an environment/schema gap, not a receipt decision.
	ErrReadPrivilegeMissing = errors.New("finishing_read_privilege_missing")
	// ErrContentStore means no Content Store was configured.
	ErrContentStore = errors.New("content_store_required")
	// ErrPool means no database pool was configured.
	ErrPool = errors.New("database_pool_required")
)

// Error is a code-only error. Its message is an enumeration code; the cause is
// available through errors.Is/errors.As for callers, but is never rendered, so
// task text, prompts, receipts and key material cannot leak through logs.
type Error struct {
	Code string
	Err  error
}

func (e *Error) Error() string { return e.Code }

func (e *Error) Unwrap() error { return e.Err }

func fail(code string, cause error) error { return &Error{Code: code, Err: cause} }

// Finisher recovers finishing from database facts.
type Finisher struct {
	Pool    *pgxpool.Pool
	Content content.Store
	// Now is the caller's clock. It is not used to derive the usage date: a
	// late recovery must book the day recorded in the receipt, never the day
	// recovery happens to run.
	Now func() time.Time
}

// Outcome is the observable result of a recovery. SettlementTokens is nil when
// usage is unavailable because the reservation must stay held.
type Outcome struct {
	Status           string
	ReceiptHash      string
	UsageSource      string
	SettlementTokens *int64
}

type gateFacts struct {
	state         string
	executionID   string
	attemptID     string
	requestHash   string
	receiptRef    string
	receiptHash   string
	receiptResult string
}

type operationFacts struct {
	runID          string
	taskID         string
	snapshotID     string
	subjectID      string
	requestHash    string
	state          string
	logicalKey     string
	runtimeVersion string
}

type executionFacts struct {
	executionID    string
	operationID    string
	attemptID      string
	requestHash    string
	intentRef      string
	intentHash     string
	mode           string
	runtimeVersion string
}

type finishResult struct {
	Outcome       string `json:"outcome"`
	Usage         string `json:"usage"`
	UsageRevision int    `json:"usage_revision"`
	UsageCounted  bool   `json:"usage_counted"`
	Settled       bool   `json:"settled"`
}

// FinishFromReceipt loads the gate, operation, fragment and frozen request,
// verifies the receipt document against that binding, and then calls the
// receipt-driven finishing command. It is idempotent: the gate's receipt hash
// is the idempotency key.
func (f *Finisher) FinishFromReceipt(ctx context.Context, orgID, operationID string) (Outcome, error) {
	if f == nil || f.Pool == nil {
		return Outcome{}, ErrPool
	}
	if f.Content == nil {
		return Outcome{}, ErrContentStore
	}

	gate, operation, execution, err := f.load(ctx, orgID, operationID)
	if err != nil {
		return Outcome{}, err
	}

	receiptBody, err := f.Content.Get(ctx, orgID, gate.receiptRef)
	if err != nil {
		return Outcome{}, fail("receipt_document_unavailable", err)
	}
	verified, err := receipt.Verify(receiptBody, receipt.Expectation{
		OrgID:       orgID,
		TaskID:      operation.taskID,
		RunID:       operation.runID,
		OperationID: operationID,
		AttemptID:   execution.attemptID,
		ExecutionID: execution.executionID,
		RequestHash: execution.requestHash,
		ReceiptHash: gate.receiptHash,
	})
	if err != nil {
		switch {
		case errors.Is(err, receipt.ErrHashMismatch):
			return Outcome{}, fail("receipt_hash_mismatch", receipt.ErrHashMismatch)
		case errors.Is(err, receipt.ErrBindingMismatch):
			return Outcome{}, fail("receipt_binding_mismatch", receipt.ErrBindingMismatch)
		default:
			return Outcome{}, fail("receipt_invalid", err)
		}
	}

	// The gate's attested result and the body's terminal outcome must agree.
	// A mismatch is tampering, not a rejection-without-path decision.
	switch verified.Outcome {
	case canonical.OutcomeSucceeded:
		if gate.receiptResult != "success" {
			return Outcome{}, fail("receipt_binding_mismatch", receipt.ErrBindingMismatch)
		}
	case canonical.OutcomeRejectedNotExec:
		if gate.receiptResult != "rejected_not_executed" {
			return Outcome{}, fail("receipt_binding_mismatch", receipt.ErrBindingMismatch)
		}
		// 0009's finishing command only accepts successful gates and the
		// signed reconcile-resolution enum has no rejection branch. Do not
		// fake a failure through an unrelated command.
		return Outcome{}, ErrRejectedWithoutFinishingPath
	default:
		return Outcome{}, fail("receipt_invalid", nil)
	}

	requestBody, err := f.Content.Get(ctx, orgID, execution.intentRef)
	if err != nil {
		return Outcome{}, fail("intent_document_unavailable", err)
	}
	request, err := canonical.ParseModelRequest(requestBody)
	if err != nil {
		return Outcome{}, fail("intent_document_invalid", err)
	}
	requestHash, err := request.Hash()
	if err != nil {
		return Outcome{}, fail("intent_document_invalid", err)
	}
	if requestHash != execution.intentHash ||
		requestHash != execution.requestHash ||
		requestHash != verified.Receipt.RequestHash {
		return Outcome{}, fail("intent_hash_mismatch", canonical.ErrHashMismatch)
	}
	expectedBinding := canonical.Binding{
		OrgID:          orgID,
		TaskID:         operation.taskID,
		RunID:          operation.runID,
		SnapshotID:     operation.snapshotID,
		RuntimeVersion: execution.runtimeVersion,
	}
	if request.Binding != expectedBinding ||
		verified.Receipt.Binding != expectedBinding {
		return Outcome{}, fail("request_binding_mismatch", receipt.ErrBindingMismatch)
	}
	if string(request.LogicalKey) != operation.logicalKey ||
		string(verified.Receipt.LogicalKey) != operation.logicalKey {
		return Outcome{}, fail("request_binding_mismatch", receipt.ErrBindingMismatch)
	}

	// The usage day is the receipt's recorded time in UTC. A late recovery
	// books the original day, never the wall-clock day of the recovery.
	recorded := time.UnixMilli(verified.Receipt.RecordedAtUnixMs).UTC()
	usageDate := time.Date(recorded.Year(), recorded.Month(), recorded.Day(), 0, 0, 0, 0, time.UTC)

	var inputTokens, outputTokens, cachedInputTokens, settlementTokens *int64
	if verified.UsageSource != canonical.UsageUnavailable {
		inputTokens = verified.Receipt.Usage.InputTokens
		outputTokens = verified.Receipt.Usage.OutputTokens
		cachedInputTokens = verified.Receipt.Usage.CachedInputTokens
		settlementTokens = verified.SettlementTokens
		if inputTokens == nil || outputTokens == nil || cachedInputTokens == nil || settlementTokens == nil {
			return Outcome{}, ErrUsageIncomplete
		}
	}

	result, err := f.finish(ctx, orgID, operationID, gate.receiptHash, verified.UsageSource,
		request.Route.Provider, request.Route.Model, usageDate,
		inputTokens, outputTokens, cachedInputTokens, settlementTokens)
	if err != nil {
		return Outcome{}, err
	}
	switch result.Outcome {
	case "confirmed", "already_confirmed":
	default:
		return Outcome{}, fail("finish_result_invalid", nil)
	}

	status := result.Outcome
	if verified.UsageSource == canonical.UsageUnavailable {
		// The operation may be confirmed, but usage is not settled and the
		// caller must not publish. The reservation stays held.
		status = StatusUsageUnavailable
	}
	return Outcome{
		Status:           status,
		ReceiptHash:      gate.receiptHash,
		UsageSource:      string(verified.UsageSource),
		SettlementTokens: settlementTokens,
	}, nil
}

// load reads every authoritative fact in one tenant-scoped transaction. It
// does not trust activity input, object timestamps or "newest file wins".
//
// The reads run under work_worker so that FORCE RLS applies. 0009 grants that
// role EXECUTE on its commands but, as shipped, does not grant SELECT on
// dispatch_delivery/runtime_execution; a deployment must grant exactly those
// two reads to the same control-plane identity. Missing privilege is reported
// as ErrReadPrivilegeMissing, never worked around by assuming a stronger role.
func (f *Finisher) load(ctx context.Context, orgID, operationID string) (gateFacts, operationFacts, executionFacts, error) {
	var (
		gate      gateFacts
		operation operationFacts
		execution executionFacts
	)
	err := workdb.WithWorkerOrgContext(ctx, f.Pool, orgID, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			SELECT gate_state,
			       COALESCE(execution_id::text, ''),
			       COALESCE(attempt_id::text, ''),
			       COALESCE(request_hash, ''),
			       COALESCE(receipt_ref, ''),
			       COALESCE(receipt_hash, ''),
			       COALESCE(receipt_result, '')
			  FROM work.dispatch_delivery
			 WHERE org_id = $1 AND operation_id = $2`,
			orgID, operationID,
		).Scan(
			&gate.state, &gate.executionID, &gate.attemptID, &gate.requestHash,
			&gate.receiptRef, &gate.receiptHash, &gate.receiptResult,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrGateNotFound
		}
		if err != nil {
			return readError(err)
		}
		switch gate.state {
		case "sealed_not_sent":
			return ErrSealedNotSent
		case "consumed":
			return ErrReceiptNotAttached
		case "receipt_recorded":
			// Required by the gate's shape constraint; checked again because
			// this resolver never guesses success.
			if gate.receiptRef == "" || gate.receiptHash == "" || gate.receiptResult == "" {
				return ErrReceiptNotAttached
			}
			if gate.executionID == "" || gate.attemptID == "" || gate.requestHash == "" {
				return ErrExecutionBindingMismatch
			}
		default:
			return fail("dispatch_gate_state_invalid", nil)
		}

		err = tx.QueryRow(ctx, `
			SELECT o.run_id::text, o.request_hash, o.state, o.logical_key,
			       r.task_id::text, r.snapshot_id::text, r.runtime_version,
			       t.owner_subject_id
			  FROM work.operation o
			  JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
			  JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
			 WHERE o.id = $1 AND o.org_id = $2`,
			operationID, orgID,
		).Scan(
			&operation.runID, &operation.requestHash, &operation.state,
			&operation.logicalKey, &operation.taskID, &operation.snapshotID,
			&operation.runtimeVersion, &operation.subjectID,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrOperationNotFound
		}
		if err != nil {
			return readError(err)
		}

		err = tx.QueryRow(ctx, `
			SELECT execution_id::text, COALESCE(operation_id::text, ''),
			       COALESCE(dispatch_attempt_id::text, ''),
			       COALESCE(request_hash, ''), COALESCE(intent_ref, ''),
			       COALESCE(intent_hash, ''), mode, runtime_version
			  FROM work.runtime_execution
			 WHERE org_id = $1 AND execution_id = $2`,
			orgID, gate.executionID,
		).Scan(
			&execution.executionID, &execution.operationID, &execution.attemptID,
			&execution.requestHash, &execution.intentRef, &execution.intentHash,
			&execution.mode, &execution.runtimeVersion,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrExecutionNotFound
		}
		if err != nil {
			return readError(err)
		}
		if execution.executionID != gate.executionID ||
			execution.operationID != operationID ||
			execution.mode != "execute" ||
			execution.attemptID == "" ||
			execution.attemptID != gate.attemptID ||
			execution.requestHash == "" ||
			execution.requestHash != gate.requestHash ||
			execution.requestHash != operation.requestHash ||
			execution.runtimeVersion != operation.runtimeVersion ||
			execution.intentRef == "" ||
			!canonical.ValidHash(execution.intentHash) {
			return ErrExecutionBindingMismatch
		}
		if gate.requestHash != operation.requestHash {
			return ErrOperationBindingMismatch
		}
		return nil
	})
	if err != nil {
		return gateFacts{}, operationFacts{}, executionFacts{}, err
	}
	return gate, operation, execution, nil
}

// finish calls the 0009 command in its own worker transaction. Content Store
// I/O already happened outside this transaction.
func (f *Finisher) finish(
	ctx context.Context,
	orgID, operationID, receiptHash string,
	usageSource canonical.UsageSource,
	provider, model string,
	usageDate time.Time,
	inputTokens, outputTokens, cachedInputTokens, settlementTokens *int64,
) (finishResult, error) {
	var result finishResult
	err := workdb.WithWorkerOrgContext(ctx, f.Pool, orgID, func(tx pgx.Tx) error {
		var body []byte
		err := tx.QueryRow(ctx, `
			SELECT work.finish_operation_from_receipt(
				$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			orgID, operationID, receiptHash, string(usageSource),
			provider, model, usageDate,
			inputTokens, outputTokens, cachedInputTokens, settlementTokens,
		).Scan(&body)
		if err != nil {
			return err
		}
		return json.Unmarshal(body, &result)
	})
	if err != nil {
		return finishResult{}, fail("finish_command_failed", err)
	}
	return result, nil
}

func readError(err error) error {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) && pgErr.SQLState() == "42501" {
		return fail("finishing_read_privilege_missing", ErrReadPrivilegeMissing)
	}
	return fail("finishing_read_failed", err)
}
