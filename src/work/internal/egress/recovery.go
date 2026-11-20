package egress

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/receipt"
)

type OutputManifest struct {
	ExecutionID         string `json:"execution_id"`
	AttemptID           string `json:"attempt_id"`
	RequestHash         string `json:"request_hash"`
	GatewayInvocationID string `json:"gateway_invocation_id"`
	WriterGatewayID     string `json:"writer_gateway_id"`
	ReceiptSlotID       string `json:"receipt_slot_id"`
	AnswerRefID         string `json:"answer_ref_id"`
	AnswerLocator       string `json:"answer_locator"`
	AnswerHash          string `json:"answer_hash"`
	AnswerBytes         int64  `json:"answer_bytes"`
	ReceiptLocator      string `json:"receipt_locator"`
	ReceiptHash         string `json:"receipt_hash"`
	ReceiptBodyHash     string `json:"receipt_body_hash"`
	ReceiptBytes        int64  `json:"receipt_bytes"`
	LogicalKey          string `json:"logical_key"`
}

type OutputStager interface {
	Stage(context.Context, string, string, OutputManifest) error
}

type OutputRecovery struct {
	Pool    *pgxpool.Pool
	Content content.Store
}

var ErrOutputRecoveryUnavailable = errors.New("egress_output_recovery_unavailable")
var ErrOutputRecoveryInvalid = errors.New("egress_output_recovery_invalid")

type outputRecoveryLookupError struct{ cause error }

func (e *outputRecoveryLookupError) Error() string { return "egress_output_recovery_lookup_failed" }
func (e *outputRecoveryLookupError) Unwrap() error { return e.cause }

func (r *OutputRecovery) Stage(ctx context.Context, orgID, operationID string, manifest OutputManifest) error {
	body, err := json.Marshal(manifest)
	if err != nil {
		return ErrOutputRecoveryInvalid
	}
	err = workdb.WithWorkerOrgContext(ctx, r.Pool, orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.stage_egress_output($1, $2, $3::jsonb)`, orgID, operationID, body)
		return err
	})
	if err != nil {
		return classifyOutputRecoveryError(err)
	}
	return nil
}

func (r *OutputRecovery) Restore(ctx context.Context, orgID, operationID string) error {
	var raw []byte
	var taskID, runID string
	err := workdb.WithWorkerOrgContext(ctx, r.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT manifest, task_id, run_id FROM work.egress_output_recovery
   WHERE org_id=$1 AND operation_id=$2`, orgID, operationID).Scan(&raw, &taskID, &runID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return &outputRecoveryLookupError{cause: err}
	}
	var m OutputManifest
	if json.Unmarshal(raw, &m) != nil {
		return ErrOutputRecoveryInvalid
	}
	if err := r.Stage(ctx, orgID, operationID, m); err != nil {
		return err
	}
	receiptBody, err := r.Content.Get(ctx, orgID, m.ReceiptLocator)
	if err != nil {
		return classifyOutputRecoveryError(err)
	}
	bodyHash, err := canonical.BodyHash(receiptBody)
	if err != nil || bodyHash != m.ReceiptBodyHash || int64(len(receiptBody)) != m.ReceiptBytes {
		return ErrOutputRecoveryInvalid
	}
	verified, err := receipt.Verify(receiptBody, receipt.Expectation{
		OrgID: orgID, TaskID: taskID, RunID: runID, OperationID: operationID,
		AttemptID: m.AttemptID, ExecutionID: m.ExecutionID, RequestHash: m.RequestHash, ReceiptHash: m.ReceiptHash,
	})
	if err != nil || verified.Outcome != canonical.OutcomeSucceeded || verified.Content == nil ||
		verified.Content.RefID != m.AnswerRefID || verified.Content.Hash != m.AnswerHash ||
		verified.Receipt.ContentBytes != m.AnswerBytes || verified.Receipt.WriterGatewayID != m.WriterGatewayID ||
		string(verified.Receipt.LogicalKey) != m.LogicalKey {
		return ErrOutputRecoveryInvalid
	}
	answer, err := r.Content.Get(ctx, orgID, m.AnswerLocator)
	if err != nil {
		return classifyOutputRecoveryError(err)
	}
	answerHash, err := canonical.BodyHash(answer)
	if err != nil || answerHash != m.AnswerHash || int64(len(answer)) != m.AnswerBytes {
		return ErrOutputRecoveryInvalid
	}
	err = workdb.WithWorkerOrgContext(ctx, r.Pool, orgID, func(tx pgx.Tx) error {
		// Revalidate the immutable manifest under the same locks as registration and attach.
		if _, err := tx.Exec(ctx, `SELECT work.stage_egress_output($1,$2,$3::jsonb)`, orgID, operationID, raw); err != nil {
			return err
		}
		for _, ref := range []struct {
			id, kind, locator, hash string
			bytes                   int64
		}{
			{m.AnswerRefID, "answer", m.AnswerLocator, m.AnswerHash, m.AnswerBytes},
			{m.ReceiptSlotID, "receipt", m.ReceiptLocator, m.ReceiptBodyHash, m.ReceiptBytes},
		} {
			if _, err := tx.Exec(ctx, `SELECT work.register_content_reference($1,$2,$3,$4,$5,$6,$7,'v1',$8,$9,$10,'egress')`,
				orgID, ref.id, taskID, runID, m.ExecutionID, ref.kind, ref.kind+":"+m.ExecutionID+":"+m.LogicalKey,
				ref.locator, ref.hash, ref.bytes); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `SELECT work.attach_dispatch_receipt($1,$2,$3,$4,$5,'success',$6)`,
			orgID, operationID, m.ReceiptSlotID, m.ReceiptLocator, m.ReceiptHash, verified.Receipt.ProviderRequestID)
		return err
	})
	if err != nil {
		return classifyOutputRecoveryError(err)
	}
	return nil
}

func classifyOutputRecoveryError(err error) error {
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "P0001" || pgErr.Code == "P0002" || pgErr.Code == "42501" || pgErr.Code == "22023" || len(pgErr.Code) >= 2 && pgErr.Code[:2] == "23") {
		return ErrOutputRecoveryInvalid
	}
	return ErrOutputRecoveryUnavailable
}
