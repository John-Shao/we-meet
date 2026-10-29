package runflow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	workruntime "github.com/we-meet/work/internal/runtime"
)

type Activities struct {
	Pool             *pgxpool.Pool
	Content          content.Store
	Runtime          workruntime.Runtime
	AccountKey       string
	QuotaPeriod      string
	QuotaLimit       int64
	QuotaEnforcement string
	ConsumerID       string
	StepCount        int
	Now              func() time.Time
}

type preparedRow struct {
	taskID, subjectID, runState, title string
	contentRef, contentHash            string
	manifest                           []byte
	policyRevision, runCapTokens       int64
}

func (a *Activities) PrepareRun(ctx context.Context, input Input) (PreparedRun, error) {
	var row preparedRow
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT r.task_id, t.owner_subject_id, r.state, t.title,
			       i.content_ref, i.content_hash, c.manifest,
			       p.revision, p.run_cap_tokens
			FROM work.run r
			JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
			JOIN work.input_object i ON i.id = t.input_id AND i.org_id = t.org_id
			JOIN work.capability_snapshot c ON c.id = r.snapshot_id AND c.org_id = r.org_id
			JOIN work.org_policy p ON p.org_id = r.org_id
			WHERE r.id = $1 AND r.org_id = $2 AND t.deleted_at IS NULL AND i.status = 'active'`,
			input.RunID, input.OrgID,
		).Scan(&row.taskID, &row.subjectID, &row.runState, &row.title,
			&row.contentRef, &row.contentHash, &row.manifest,
			&row.policyRevision, &row.runCapTokens)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PreparedRun{}, fmt.Errorf("run_not_found")
		}
		return PreparedRun{}, err
	}
	prepared := PreparedRun{
		RunID: input.RunID, OrgID: input.OrgID, TaskID: row.taskID,
		SubjectID: row.subjectID, RunState: row.runState, Title: row.title,
		InputHash: row.contentHash, TokenUpperBound: row.runCapTokens,
		PolicyRevision: row.policyRevision, StepCount: a.stepCount(),
	}
	if row.runState == "cancel_requested" || terminalRun(row.runState) {
		prepared.Canceled = true
		return prepared, nil
	}
	var manifest struct {
		Template struct {
			ID      string `json:"id"`
			Version int    `json:"version"`
		} `json:"template"`
	}
	if err := json.Unmarshal(row.manifest, &manifest); err != nil || manifest.Template.ID == "" {
		return PreparedRun{}, fmt.Errorf("snapshot_manifest_invalid")
	}
	prepared.TemplateID = manifest.Template.ID
	prepared.TemplateVersion = manifest.Template.Version
	if a.Content == nil {
		return PreparedRun{}, fmt.Errorf("content_store_unavailable")
	}
	plaintext, err := a.Content.Get(ctx, input.OrgID, row.contentRef)
	if err != nil {
		return PreparedRun{}, fmt.Errorf("input_read_failed: %w", err)
	}
	digest := sha256.Sum256(plaintext)
	if "sha256:"+hex.EncodeToString(digest[:]) != row.contentHash {
		return PreparedRun{}, fmt.Errorf("input_hash_mismatch")
	}
	var payload struct {
		Goal       string `json:"goal"`
		Background string `json:"background"`
	}
	if err := json.Unmarshal(plaintext, &payload); err != nil || strings.TrimSpace(payload.Goal) == "" {
		return PreparedRun{}, fmt.Errorf("input_invalid")
	}
	prepared.Goal = payload.Goal
	prepared.Background = payload.Background
	prepared.RequestHash = requestHash(prepared)
	return prepared, nil
}

func (a *Activities) AcquireRun(ctx context.Context, input Input) (AcquireRunOutput, error) {
	var state string
	var fence int64
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT state, fence FROM work.run WHERE id = $1 AND org_id = $2`,
			input.RunID, input.OrgID,
		).Scan(&state, &fence)
	})
	if err != nil {
		return AcquireRunOutput{}, err
	}
	if state == "cancel_requested" || terminalRun(state) {
		return AcquireRunOutput{State: state, Fence: fence, Canceled: true}, nil
	}
	if state == "queued" {
		err = workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT state, fence FROM work.acquire_run($1, $2)`,
				input.RunID, input.OrgID,
			).Scan(&state, &fence)
		})
		if err != nil {
			return AcquireRunOutput{}, err
		}
	}
	if state != "active" {
		return AcquireRunOutput{State: state, Fence: fence, Canceled: terminalRun(state) || state == "cancel_requested"}, nil
	}
	return AcquireRunOutput{State: state, Fence: fence}, nil
}

func (a *Activities) ExecuteStep(ctx context.Context, input ExecuteStepInput) (ExecuteStepOutput, error) {
	out := ExecuteStepOutput{Step: input.Step}
	fail := func(code string, err error) (ExecuteStepOutput, error) {
		out.ErrCode = code
		if err != nil {
			out.ErrMessage = err.Error()
		}
		return out, nil
	}
	if input.Step < 1 || input.StepCount < 1 || input.Step > input.StepCount {
		return fail("step_invalid", nil)
	}
	if a.Content == nil {
		return fail("content_store_unavailable", nil)
	}
	var previousContent string
	if input.PreviousContentRef != "" {
		body, err := a.Content.Get(ctx, input.Prepared.OrgID, input.PreviousContentRef)
		if err != nil || !checkpointHashMatches(body, input.PreviousContentHash) {
			return fail("checkpoint_read_failed", err)
		}
		previousContent = string(body)
	}
	requestHash := stepRequestHash(input.Prepared, input.Step, input.PreviousContentHash)
	var operationID string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.Prepared.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT work.create_operation($1, $2, $3, 'model', $4)`,
			input.Prepared.RunID, input.Prepared.OrgID,
			fmt.Sprintf("model:%d", input.Step), requestHash,
		).Scan(&operationID)
	}); err != nil {
		return fail("operation_create_failed", err)
	}
	out.OperationID = operationID
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.Prepared.OrgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.authorize_operation($1, $2, $3, 'policy_auto')`,
			input.Prepared.OrgID, operationID, input.Prepared.PolicyRevision)
		return err
	}); err != nil {
		return fail("operation_authorize_failed", err)
	}
	canceled, err := a.runCanceled(ctx, input.Prepared.OrgID, input.Prepared.RunID)
	if err != nil {
		return fail("run_state_read_failed", err)
	}
	if canceled {
		if err := a.cancelOperation(ctx, input.Prepared.OrgID, operationID, "user_requested"); err != nil {
			return fail("operation_cancel_failed", err)
		}
		out.Canceled = true
		return out, nil
	}
	var reservationID string
	amount := input.Prepared.TokenUpperBound / int64(input.StepCount)
	if amount <= 0 {
		amount = 1
	}
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.Prepared.OrgID, func(tx pgx.Tx) error {
		var accountID string
		if err := tx.QueryRow(ctx, `SELECT work.ensure_quota_account($1, $2, $3, $4, $5)`,
			input.Prepared.OrgID, a.accountKey(), a.quotaPeriod(), a.quotaLimit(), a.quotaEnforcement(),
		).Scan(&accountID); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT work.reserve_quota($1, $2, $3, $4, $5)`,
			input.Prepared.OrgID, a.accountKey(), a.quotaPeriod(), operationID, amount,
		).Scan(&reservationID)
	}); err != nil {
		if strings.Contains(err.Error(), "quota_account_not_found") {
			return fail("quota_account_missing", err)
		}
		if strings.Contains(err.Error(), "quota_exhausted") {
			return fail("quota_exhausted", err)
		}
		return fail("quota_reserve_failed", err)
	}
	out.ReservationID = reservationID
	canceled, err = a.runCanceled(ctx, input.Prepared.OrgID, input.Prepared.RunID)
	if err != nil {
		return fail("run_state_read_failed", err)
	}
	if canceled {
		if err := a.cancelOperation(ctx, input.Prepared.OrgID, operationID, "user_requested"); err != nil {
			return fail("operation_cancel_failed", err)
		}
		out.Canceled = true
		return out, nil
	}
	var attemptID *string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.Prepared.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.claim_dispatch($1, $2, $3, $4)`,
			operationID, input.Prepared.OrgID, a.consumerID(), input.Fence,
		).Scan(&attemptID)
	}); err != nil {
		return fail("dispatch_failed", err)
	}
	if attemptID == nil || *attemptID == "" {
		return fail("dispatch_lost", nil)
	}
	if a.Runtime == nil {
		return fail("runtime_unavailable", nil)
	}
	result, err := a.Runtime.Execute(ctx, workruntime.Request{
		RunID: input.Prepared.RunID, TaskID: input.Prepared.TaskID, OrgID: input.Prepared.OrgID,
		TemplateID: input.Prepared.TemplateID, TemplateName: input.Prepared.TemplateID,
		TemplateVersion: input.Prepared.TemplateVersion, Goal: input.Prepared.Goal,
		Background: input.Prepared.Background, TokenUpperBound: input.Prepared.TokenUpperBound,
		Step: input.Step, StepCount: input.StepCount, PreviousContent: previousContent,
	})
	if err != nil {
		if workruntime.IsUnknown(err) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			out.Unknown = true
			out.ErrCode = "runtime_unknown"
			out.ErrMessage = err.Error()
			if markErr := a.markOperationUnknown(ctx, input.Prepared.OrgID, operationID, "runtime_unknown"); markErr != nil {
				return fail("operation_unknown_failed", markErr)
			}
			canceled, _ = a.runCanceled(ctx, input.Prepared.OrgID, input.Prepared.RunID)
			out.Canceled = canceled
			return out, nil
		}
		out.ErrCode = "runtime_failed"
		out.ErrMessage = err.Error()
		if finishErr := a.finishOperation(ctx, input.Prepared.OrgID, operationID, "failed", "", ""); finishErr != nil {
			return fail("operation_finish_failed", finishErr)
		}
		if releaseErr := a.releaseReservation(ctx, input.Prepared.OrgID, reservationID); releaseErr != nil {
			return fail("quota_release_failed", releaseErr)
		}
		return out, nil
	}
	out.UsageTokens = result.InputTokens + result.OutputTokens + result.CachedInputTokens
	if result.Provider != "" && result.Model != "" && usageProviderAllowed(result.Provider) {
		usageDate := a.now().UTC().Format("2006-01-02")
		if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.Prepared.OrgID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT work.record_usage($1, $2, $3, $4, $5, $6::date, $7, $8, $9, 1)`,
				input.Prepared.OrgID, input.Prepared.SubjectID, operationID,
				result.Provider, result.Model, usageDate,
				result.InputTokens, result.OutputTokens, result.CachedInputTokens)
			return err
		}); err != nil {
			return fail("usage_record_failed", err)
		}
	}
	ref, err := a.Content.Put(ctx, input.Prepared.OrgID, result.Content)
	if err != nil {
		out.ErrCode = "content_write_failed"
		out.ErrMessage = err.Error()
		if finishErr := a.finishOperation(ctx, input.Prepared.OrgID, operationID, "failed", "", ""); finishErr != nil {
			return fail("operation_finish_failed", finishErr)
		}
		if settleErr := a.settleReservation(ctx, input.Prepared.OrgID, reservationID, out.UsageTokens); settleErr != nil {
			return fail("quota_settle_failed", settleErr)
		}
		out.Settled = true
		return out, nil
	}
	out.ContentRef = ref.ContentRef
	out.ContentHash = ref.Hash
	out.Bytes = ref.Bytes
	out.MediaType = result.MediaType
	if out.MediaType == "" {
		out.MediaType = "text/markdown"
	}
	out.RuntimeVersion = result.RuntimeVersion
	providerRequestID := result.ProviderRequestID
	if providerRequestID == "" {
		providerRequestID = fmt.Sprintf("runtime:%s:%d", input.Prepared.RunID, input.Step)
	}
	if err := a.finishOperation(ctx, input.Prepared.OrgID, operationID, "succeeded", providerRequestID, out.ContentRef); err != nil {
		return fail("operation_finish_failed", err)
	}
	if err := a.settleReservation(ctx, input.Prepared.OrgID, reservationID, out.UsageTokens); err != nil {
		return fail("quota_settle_failed", err)
	}
	out.Settled = true
	canceled, err = a.runCanceled(ctx, input.Prepared.OrgID, input.Prepared.RunID)
	if err != nil {
		return fail("run_state_read_failed", err)
	}
	if canceled {
		out.Canceled = true
		return out, nil
	}
	if !input.Final {
		return out, nil
	}
	provenance, _ := json.Marshal(map[string]any{
		"runtime_version":  out.RuntimeVersion,
		"template_id":      input.Prepared.TemplateID,
		"template_version": input.Prepared.TemplateVersion,
		"execution":        "runtime",
		"step":             input.Step,
	})
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.Prepared.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT artifact_id, version_no FROM work.publish_artifact(
				$1, $2, $3, 'result', $4, $5, $6, $7, $8::jsonb)`,
			input.Prepared.OrgID, input.Prepared.TaskID, input.Prepared.RunID,
			out.ContentRef, out.ContentHash, out.Bytes, out.MediaType, string(provenance),
		).Scan(&out.ArtifactID, &out.VersionNo)
	}); err != nil {
		return fail("artifact_publish_failed", err)
	}
	return out, nil
}

func checkpointHashMatches(body []byte, expected string) bool {
	digest := sha256.Sum256(body)
	return "sha256:"+hex.EncodeToString(digest[:]) == expected
}

func stepRequestHash(prepared PreparedRun, step int, previousHash string) string {
	body := fmt.Sprintf("%s|step:%d|previous:%s", prepared.RequestHash, step, previousHash)
	digest := sha256.Sum256([]byte(body))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func (a *Activities) runCanceled(ctx context.Context, orgID, runID string) (bool, error) {
	var state string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM work.run WHERE id = $1 AND org_id = $2`,
			runID, orgID).Scan(&state)
	}); err != nil {
		return false, err
	}
	return state == "cancel_requested", nil
}

func (a *Activities) cancelOperation(ctx context.Context, orgID, operationID, reason string) error {
	return workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.cancel_operation($1, $2, $3, $4)`,
			orgID, operationID, "system:work-worker", reason)
		return err
	})
}

func (a *Activities) markOperationUnknown(ctx context.Context, orgID, operationID, reason string) error {
	return workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.mark_operation_unknown($1, $2, $3)`,
			orgID, operationID, reason)
		return err
	})
}

func (a *Activities) finishOperation(
	ctx context.Context,
	orgID, operationID, outcome, providerRequestID, receiptRef string,
) error {
	var provider, receipt any
	if providerRequestID != "" {
		provider = providerRequestID
	}
	if receiptRef != "" {
		receipt = receiptRef
	}
	return workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.finish_operation($1, $2, $3, $4, $5)`,
			orgID, operationID, outcome, provider, receipt)
		return err
	})
}

func (a *Activities) releaseReservation(ctx context.Context, orgID, reservationID string) error {
	return workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.release_quota($1)`, reservationID)
		return err
	})
}

func (a *Activities) settleReservation(ctx context.Context, orgID, reservationID string, usageTokens int64) error {
	usage, _ := json.Marshal(map[string]any{"usage_tokens": usageTokens})
	return workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.settle_quota($1, $2, $3::jsonb, 1)`,
			reservationID, usageTokens, string(usage))
		return err
	})
}

func (a *Activities) CheckRun(ctx context.Context, input Input) (RunControl, error) {
	var state string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM work.run WHERE id = $1 AND org_id = $2`,
			input.RunID, input.OrgID).Scan(&state)
	}); err != nil {
		return RunControl{}, err
	}
	return RunControl{State: state, Canceled: state == "cancel_requested"}, nil
}

func (a *Activities) WaitRun(ctx context.Context, input WaitRunInput) error {
	var state string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM work.run WHERE id = $1 AND org_id = $2`,
			input.RunID, input.OrgID).Scan(&state)
	}); err != nil {
		return err
	}
	if state == "cancel_requested" || terminalRun(state) {
		return nil
	}
	return workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.wait_run($1, $2, $3)`,
			input.OrgID, input.RunID, input.Reason)
		return err
	})
}

func (a *Activities) FinishRun(ctx context.Context, input FinishRunInput) error {
	var state string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM work.run WHERE id = $1 AND org_id = $2`,
			input.RunID, input.OrgID).Scan(&state)
	}); err != nil {
		return err
	}
	if terminalRun(state) {
		return nil
	}
	var reason any
	if input.Reason != "" {
		reason = input.Reason
	}
	return workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.finish_run($1, $2, $3, $4)`,
			input.RunID, input.OrgID, input.Outcome, reason)
		return err
	})
}

func (a *Activities) AbortRun(ctx context.Context, input AbortRunInput) error {
	var state string
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM work.run WHERE id = $1 AND org_id = $2`,
			input.RunID, input.OrgID).Scan(&state)
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && terminalRun(state)) {
		return nil
	}
	if err != nil {
		return err
	}
	if input.OperationID != "" {
		if err := a.abortOperation(ctx, input); err != nil {
			return err
		}
	}
	if err := a.FinishRun(ctx, FinishRunInput{
		RunID: input.RunID, OrgID: input.OrgID, Outcome: input.Outcome, Reason: input.Reason,
	}); err != nil && !strings.Contains(err.Error(), "run_not_current") {
		return err
	}
	return nil
}

func (a *Activities) abortOperation(ctx context.Context, input AbortRunInput) error {
	var opState string
	var reservationID *string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT state FROM work.operation WHERE id = $1 AND org_id = $2`,
			input.OperationID, input.OrgID).Scan(&opState); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT id FROM work.quota_reservation
			WHERE operation_id = $1 AND org_id = $2 AND state IN ('held', 'unknown')
			ORDER BY reservation_seq DESC LIMIT 1`,
			input.OperationID, input.OrgID).Scan(&reservationID)
	}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if reservationID == nil && input.ReservationID != "" {
		reservationID = &input.ReservationID
	}
	switch opState {
	case "prepared", "authorized", "waiting_approval":
		return workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT work.cancel_operation($1, $2, $3, $4)`,
				input.OrgID, input.OperationID, "system:work-worker", input.Reason)
			return err
		})
	case "dispatching":
		return workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT work.mark_operation_unknown($1, $2, $3)`,
				input.OrgID, input.OperationID, input.Reason)
			return err
		})
	case "succeeded":
		if input.Settled || reservationID == nil {
			return nil
		}
		usage, _ := json.Marshal(map[string]any{"aborted": true})
		return workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT work.settle_quota($1, $2, $3::jsonb, 1)`,
				*reservationID, input.UsageTokens, string(usage))
			return err
		})
	case "failed", "canceled":
		if reservationID == nil {
			return nil
		}
		return workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT work.release_quota($1)`, *reservationID)
			return err
		})
	default:
		return nil
	}
}

func (a *Activities) accountKey() string {
	if a.AccountKey == "" {
		return "default"
	}
	return a.AccountKey
}

func (a *Activities) stepCount() int {
	if a.StepCount <= 0 {
		return 2
	}
	if a.StepCount > 3 {
		return 3
	}
	return a.StepCount
}

func (a *Activities) quotaPeriod() string {
	if a.QuotaPeriod != "" {
		return a.QuotaPeriod
	}
	now := time.Now
	if a.Now != nil {
		now = a.Now
	}
	return now().UTC().Format("2006-01")
}

func (a *Activities) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

func usageProviderAllowed(provider string) bool {
	switch provider {
	case "aliyun", "volcengine", "deepseek":
		return true
	default:
		return false
	}
}

func (a *Activities) quotaLimit() int64 {
	if a.QuotaLimit > 0 {
		return a.QuotaLimit
	}
	return 1000000
}

func (a *Activities) quotaEnforcement() string {
	if a.QuotaEnforcement == "" {
		return "soft"
	}
	return a.QuotaEnforcement
}

func (a *Activities) consumerID() string {
	if a.ConsumerID == "" {
		return "work-worker-1"
	}
	return a.ConsumerID
}

func requestHash(prepared PreparedRun) string {
	body := fmt.Sprintf("%s|%s|%s|%d|%d|%d",
		prepared.RunID, prepared.TaskID, prepared.InputHash,
		prepared.TemplateVersion, prepared.TokenUpperBound, prepared.PolicyRevision)
	digest := sha256.Sum256([]byte(body))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func terminalRun(state string) bool {
	switch state {
	case "succeeded", "failed", "canceled":
		return true
	default:
		return false
	}
}
