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
	"go.temporal.io/sdk/temporal"

	"github.com/we-meet/work/internal/advance"
	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/execbinding"
	"github.com/we-meet/work/internal/fragment"
	"github.com/we-meet/work/internal/providerctx"
	workruntime "github.com/we-meet/work/internal/runtime"
)

// AdvanceClient is the Node internal advanceRuntime transport. Tests may
// substitute a fake; production uses *advance.Client.
type AdvanceClient interface {
	Advance(ctx context.Context, request fragment.Request) (fragment.Result, error)
}

type Activities struct {
	Pool             *pgxpool.Pool
	Content          content.Store
	Runtime          workruntime.Runtime
	Advance          AdvanceClient
	Templates        execbinding.TemplateSource
	Providers        *providerctx.Resolver
	AccountKey       string
	QuotaPeriod      string
	QuotaLimit       int64
	QuotaEnforcement string
	ConsumerID       string
	StepCount        int
	Now              func() time.Time
}

// Raw error causes and details must not enter Temporal history.
func activityFailure(err error, code string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || temporal.IsCanceledError(err) {
		return temporal.NewCanceledError()
	}
	return errors.New(code)
}

type preparedRow struct {
	taskID, subjectID, runState  string
	contentRef, contentHash      string
	manifest                     []byte
	policyRevision, runCapTokens int64
}

func (a *Activities) PrepareRun(ctx context.Context, input Input) (PreparedRun, error) {
	var row preparedRow
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT r.task_id, t.owner_subject_id, r.state,
			       i.content_ref, i.content_hash, c.manifest,
			       p.revision, p.run_cap_tokens
			FROM work.run r
			JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
			JOIN work.input_object i ON i.id = t.input_id AND i.org_id = t.org_id
			JOIN work.capability_snapshot c ON c.id = r.snapshot_id AND c.org_id = r.org_id
			JOIN work.org_policy p ON p.org_id = r.org_id
			WHERE r.id = $1 AND r.org_id = $2 AND t.deleted_at IS NULL AND i.status = 'active'`,
			input.RunID, input.OrgID,
		).Scan(&row.taskID, &row.subjectID, &row.runState,
			&row.contentRef, &row.contentHash, &row.manifest,
			&row.policyRevision, &row.runCapTokens)
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PreparedRun{}, fmt.Errorf("run_not_found")
		}
		return PreparedRun{}, activityFailure(err, "prepare_run_failed")
	}
	prepared := PreparedRun{
		RunID: input.RunID, OrgID: input.OrgID, TaskID: row.taskID,
		SubjectID: row.subjectID, RunState: row.runState,
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
		return PreparedRun{}, activityFailure(err, "input_read_failed")
	}
	digest := sha256.Sum256(plaintext)
	if "sha256:"+hex.EncodeToString(digest[:]) != row.contentHash {
		return PreparedRun{}, fmt.Errorf("input_hash_mismatch")
	}
	var payload struct {
		Goal string `json:"goal"`
	}
	if err := json.Unmarshal(plaintext, &payload); err != nil || strings.TrimSpace(payload.Goal) == "" {
		return PreparedRun{}, fmt.Errorf("input_invalid")
	}
	prepared.RequestHash = requestHash(prepared)
	return prepared, nil
}

// loadRunInput re-reads and verifies the run input inside the activity that
// uses it, so the body never becomes part of an activity payload.
func (a *Activities) loadRunInput(ctx context.Context, prepared PreparedRun) (string, string, error) {
	if a.Content == nil {
		return "", "", fmt.Errorf("content_store_unavailable")
	}
	var contentRef, contentHash string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, prepared.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT i.content_ref, i.content_hash
			FROM work.run r
			JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
			JOIN work.input_object i ON i.id = t.input_id AND i.org_id = t.org_id
			WHERE r.id = $1 AND r.org_id = $2
			  AND t.deleted_at IS NULL AND i.status = 'active'`,
			prepared.RunID, prepared.OrgID,
		).Scan(&contentRef, &contentHash)
	}); err != nil {
		return "", "", err
	}
	if contentHash != prepared.InputHash {
		return "", "", fmt.Errorf("input_hash_changed")
	}
	body, err := a.Content.Get(ctx, prepared.OrgID, contentRef)
	if err != nil {
		return "", "", err
	}
	if !checkpointHashMatches(body, contentHash) {
		return "", "", fmt.Errorf("input_hash_mismatch")
	}
	var payload struct {
		Goal       string `json:"goal"`
		Background string `json:"background"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || strings.TrimSpace(payload.Goal) == "" {
		return "", "", fmt.Errorf("input_invalid")
	}
	return payload.Goal, payload.Background, nil
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
		return AcquireRunOutput{}, activityFailure(err, "acquire_run_failed")
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
			return AcquireRunOutput{}, activityFailure(err, "acquire_run_failed")
		}
	}
	if state != "active" {
		return AcquireRunOutput{State: state, Fence: fence, Canceled: terminalRun(state) || state == "cancel_requested"}, nil
	}
	return AcquireRunOutput{State: state, Fence: fence}, nil
}

func (a *Activities) ExecuteStep(ctx context.Context, input ExecuteStepInput) (ExecuteStepOutput, error) {
	out := ExecuteStepOutput{Step: input.Step}
	fail := func(code string) (ExecuteStepOutput, error) {
		out.ErrCode = code
		return out, nil
	}
	if input.Step < 1 || input.StepCount < 1 || input.Step > input.StepCount {
		return fail("step_invalid")
	}
	if a.Content == nil {
		return fail("content_store_unavailable")
	}
	goal, background, err := a.loadRunInput(ctx, input.Prepared)
	if err != nil {
		return fail("input_read_failed")
	}
	var previousContent string
	if input.PreviousContentRef != "" {
		body, err := a.Content.Get(ctx, input.Prepared.OrgID, input.PreviousContentRef)
		if err != nil || !checkpointHashMatches(body, input.PreviousContentHash) {
			return fail("checkpoint_read_failed")
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
		return fail("operation_create_failed")
	}
	out.OperationID = operationID
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.Prepared.OrgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.authorize_operation($1, $2, $3, 'policy_auto')`,
			input.Prepared.OrgID, operationID, input.Prepared.PolicyRevision)
		return err
	}); err != nil {
		return fail("operation_authorize_failed")
	}
	canceled, err := a.runCanceled(ctx, input.Prepared.OrgID, input.Prepared.RunID)
	if err != nil {
		return fail("run_state_read_failed")
	}
	if canceled {
		if err := a.cancelOperation(ctx, input.Prepared.OrgID, operationID, "user_requested"); err != nil {
			return fail("operation_cancel_failed")
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
			return fail("quota_account_missing")
		}
		if strings.Contains(err.Error(), "quota_exhausted") {
			return fail("quota_exhausted")
		}
		return fail("quota_reserve_failed")
	}
	out.ReservationID = reservationID
	canceled, err = a.runCanceled(ctx, input.Prepared.OrgID, input.Prepared.RunID)
	if err != nil {
		return fail("run_state_read_failed")
	}
	if canceled {
		if err := a.cancelOperation(ctx, input.Prepared.OrgID, operationID, "user_requested"); err != nil {
			return fail("operation_cancel_failed")
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
		return fail("dispatch_failed")
	}
	if attemptID == nil || *attemptID == "" {
		runState, opState, stateErr := a.dispatchState(ctx, input.Prepared.OrgID, input.Prepared.RunID, operationID)
		if stateErr != nil {
			return fail("dispatch_state_read_failed")
		}
		if runState == "cancel_requested" {
			switch opState {
			case "prepared", "authorized", "waiting_approval":
				if err := a.cancelOperation(ctx, input.Prepared.OrgID, operationID, "user_requested"); err != nil {
					return fail("operation_cancel_failed")
				}
			}
			out.Canceled = true
			return out, nil
		}
		// Another consumer owns this operation or the run is no longer current.
		// This workflow must not release or rewrite the winner's operation.
		out.Superseded = true
		return out, nil
	}
	if a.Runtime == nil {
		return fail("runtime_unavailable")
	}
	result, err := a.Runtime.Execute(ctx, workruntime.Request{
		RunID: input.Prepared.RunID, TaskID: input.Prepared.TaskID, OrgID: input.Prepared.OrgID,
		TemplateID: input.Prepared.TemplateID, TemplateName: input.Prepared.TemplateID,
		TemplateVersion: input.Prepared.TemplateVersion, Goal: goal,
		Background: background, TokenUpperBound: input.Prepared.TokenUpperBound,
		Step: input.Step, StepCount: input.StepCount, PreviousContent: previousContent,
	})
	if err != nil {
		if workruntime.IsUnknown(err) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			out.Unknown = true
			out.ErrCode = "runtime_unknown"
			if markErr := a.markOperationUnknown(ctx, input.Prepared.OrgID, operationID, "runtime_unknown"); markErr != nil {
				return fail("operation_unknown_failed")
			}
			canceled, _ = a.runCanceled(ctx, input.Prepared.OrgID, input.Prepared.RunID)
			out.Canceled = canceled
			return out, nil
		}
		out.ErrCode = "runtime_failed"
		if finishErr := a.finishOperation(ctx, input.Prepared.OrgID, operationID, "failed", "", ""); finishErr != nil {
			return fail("operation_finish_failed")
		}
		if releaseErr := a.releaseReservation(ctx, input.Prepared.OrgID, reservationID); releaseErr != nil {
			return fail("quota_release_failed")
		}
		return out, nil
	}
	usageTokens, usageKnown := result.Usage.Total()
	out.UsageTokens = usageTokens
	if !usageKnown || out.UsageTokens <= 0 {
		// A content-bearing model call with no usage cannot be settled or
		// published; keep the reservation and wait for reconciliation.
		out.Unknown = true
		out.ErrCode = "usage_unavailable"
		if markErr := a.markOperationUnknown(ctx, input.Prepared.OrgID, operationID, "usage_unavailable"); markErr != nil {
			return fail("operation_unknown_failed")
		}
		canceled, _ = a.runCanceled(ctx, input.Prepared.OrgID, input.Prepared.RunID)
		out.Canceled = canceled
		return out, nil
	}
	inputTokens, outputTokens, cachedInputTokens := *result.Usage.InputTokens,
		*result.Usage.OutputTokens, *result.Usage.CachedInputTokens
	if result.Provider != "" && result.Model != "" && usageProviderAllowed(result.Provider) {
		usageDate := a.now().UTC().Format("2006-01-02")
		if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.Prepared.OrgID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT work.record_usage($1, $2, $3, $4, $5, $6::date, $7, $8, $9, 1)`,
				input.Prepared.OrgID, input.Prepared.SubjectID, operationID,
				result.Provider, result.Model, usageDate,
				inputTokens, outputTokens, cachedInputTokens)
			return err
		}); err != nil {
			return fail("usage_record_failed")
		}
	}
	ref, err := a.Content.Put(ctx, input.Prepared.OrgID, result.Content)
	if err != nil {
		// The model call succeeded and usage was recorded; only the internal
		// content write failed. Keep the reservation and reconcile instead of
		// pretending the external call failed.
		out.Unknown = true
		out.ErrCode = "content_write_failed"
		if markErr := a.markOperationUnknown(ctx, input.Prepared.OrgID, operationID, "content_write_failed"); markErr != nil {
			return fail("operation_unknown_failed")
		}
		canceled, _ = a.runCanceled(ctx, input.Prepared.OrgID, input.Prepared.RunID)
		out.Canceled = canceled
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
		return fail("operation_finish_failed")
	}
	if err := a.settleReservation(ctx, input.Prepared.OrgID, reservationID, out.UsageTokens); err != nil {
		return fail("quota_settle_failed")
	}
	out.Settled = true
	canceled, err = a.runCanceled(ctx, input.Prepared.OrgID, input.Prepared.RunID)
	if err != nil {
		return fail("run_state_read_failed")
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
		return fail("artifact_publish_failed")
	}
	return out, nil
}

// AdvanceRuntime executes exactly one signed fragment through the Node
// internal transport and returns the validated advance_result.
//
// A transport timeout or an unknown/invalid response leaves the outcome of an
// execute fragment unresolved: the caller must reconcile the provider/ledger
// before sending anything again. That case returns WAITING_RECONCILE with
// provider_unknown and the request's permit operation id instead of reporting a
// business failure. A plan fragment cannot have dispatched work, so it has no
// operation id to bind and the transport error is returned as-is.
//
// This activity is not registered in RunWorkflow yet.
func (a *Activities) AdvanceRuntime(ctx context.Context, request fragment.Request) (fragment.Result, error) {
	if err := request.Validate(); err != nil {
		return fragment.Result{}, errors.New("advance_request_invalid")
	}
	if a.Advance == nil {
		return fragment.Result{}, errors.New("advance_unavailable")
	}

	result, err := a.Advance.Advance(ctx, request)
	if err != nil {
		if errors.Is(err, context.Canceled) || temporal.IsCanceledError(err) {
			return fragment.Result{}, temporal.NewCanceledError()
		}
		var transport *advance.TransportError
		if errors.As(err, &transport) && transport.Code == advance.CodeTransportCanceled {
			return fragment.Result{}, temporal.NewCanceledError()
		}
		var remote *advance.RemoteError
		if errors.As(err, &remote) {
			if remote.Code == "" {
				return fragment.Result{}, errors.New("advance_failed")
			}
			// RemoteError.Error() is the enumeration code only.
			return fragment.Result{}, remote
		}
		if advanceOutcomeUnknown(err) {
			return waitingForReconcile(request)
		}
		return fragment.Result{}, errors.New("advance_failed")
	}

	if err := result.Validate(); err != nil {
		return fragment.Result{}, errors.New("advance_result_invalid")
	}
	if result.ExecutionID != request.ExecutionID {
		return fragment.Result{}, errors.New("advance_result_mismatch")
	}
	if !advanceStateAllowed(request.Mode, result.State) {
		return fragment.Result{}, errors.New("advance_result_mismatch")
	}
	return result, nil
}

func advanceOutcomeUnknown(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var transport *advance.TransportError
	if !errors.As(err, &transport) {
		return false
	}
	switch transport.Code {
	case advance.CodeTransportTimeout, advance.CodeTransportUnknown, advance.CodeInvalidResponse:
		return true
	default:
		return false
	}
}

func waitingForReconcile(request fragment.Request) (fragment.Result, error) {
	if request.Mode != "execute" || request.Permit == nil || request.Permit.OperationID == "" {
		return fragment.Result{}, errors.New("advance_unknown_without_operation")
	}
	result := fragment.Result{
		Kind:        fragment.KindResult,
		Contract:    fragment.ContractVersion,
		ExecutionID: request.ExecutionID,
		State:       fragment.StateWaitingReconcile,
		Checkpoint:  request.Checkpoint,
		OperationID: request.Permit.OperationID,
		Reason:      "provider_unknown",
	}
	if err := result.Validate(); err != nil {
		return fragment.Result{}, errors.New("advance_result_invalid")
	}
	return result, nil
}

func advanceStateAllowed(mode, state string) bool {
	switch mode {
	case "plan":
		return state != fragment.StateCheckpointed && state != fragment.StateWaitingReconcile
	case "execute":
		return state != fragment.StateModelRequest && state != fragment.StateFinished
	default:
		return false
	}
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

func (a *Activities) dispatchState(ctx context.Context, orgID, runID, operationID string) (string, string, error) {
	var runState, operationState string
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT r.state, o.state
			FROM work.operation o
			JOIN work.run r ON r.id = o.run_id AND r.org_id = o.org_id
			WHERE o.id = $1 AND o.org_id = $2 AND o.run_id = $3`,
			operationID, orgID, runID,
		).Scan(&runState, &operationState)
	})
	return runState, operationState, err
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

// rejectionEvidence is the gate's own proof that the provider refused before
// executing. Only a receipt already bound to the dispatch slot counts; the
// runtime's claim alone never closes an Operation.
type rejectionEvidence struct {
	bound             bool
	providerRequestID string
	receiptRef        string
}

func (a *Activities) rejectionEvidence(
	ctx context.Context, orgID, operationID string,
) (rejectionEvidence, error) {
	var gateState string
	var receiptResult, providerRequestID, receiptRef *string
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT gate_state, receipt_result, provider_request_id, receipt_ref
			FROM work.dispatch_delivery
			WHERE org_id = $1 AND operation_id = $2`,
			orgID, operationID,
		).Scan(&gateState, &receiptResult, &providerRequestID, &receiptRef)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return rejectionEvidence{}, nil
	}
	if err != nil {
		return rejectionEvidence{}, err
	}
	if gateState != "receipt_recorded" || receiptResult == nil ||
		*receiptResult != "rejected_not_executed" {
		return rejectionEvidence{}, nil
	}
	evidence := rejectionEvidence{bound: true}
	if providerRequestID != nil {
		evidence.providerRequestID = *providerRequestID
	}
	if receiptRef != nil {
		evidence.receiptRef = *receiptRef
	}
	return evidence, nil
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
		return RunControl{}, activityFailure(err, "check_run_failed")
	}
	return RunControl{State: state, Canceled: state == "cancel_requested"}, nil
}

func (a *Activities) WaitRun(ctx context.Context, input WaitRunInput) error {
	var state string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM work.run WHERE id = $1 AND org_id = $2`,
			input.RunID, input.OrgID).Scan(&state)
	}); err != nil {
		return activityFailure(err, "wait_run_failed")
	}
	if state == "cancel_requested" || terminalRun(state) {
		return nil
	}
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.wait_run($1, $2, $3)`,
			input.OrgID, input.RunID, input.Reason)
		return err
	})
	return activityFailure(err, "wait_run_failed")
}

func (a *Activities) FinishRun(ctx context.Context, input FinishRunInput) error {
	return activityFailure(a.finishRun(ctx, input), "finish_run_failed")
}

// finishRun leaves domain errors available to AbortRun before the public boundary.
func (a *Activities) finishRun(ctx context.Context, input FinishRunInput) error {
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
		return activityFailure(err, "abort_run_failed")
	}
	if input.OperationID != "" {
		if err := a.abortOperation(ctx, input); err != nil {
			return activityFailure(err, "abort_run_failed")
		}
	} else if err := a.abortOpenOperations(ctx, input); err != nil {
		return activityFailure(err, "abort_run_failed")
	}
	if err := a.finishRun(ctx, FinishRunInput{
		RunID: input.RunID, OrgID: input.OrgID, Outcome: input.Outcome, Reason: input.Reason,
	}); err != nil && !strings.Contains(err.Error(), "run_not_current") {
		return activityFailure(err, "abort_run_failed")
	}
	return nil
}

// abortOpenOperations cleans up operations left behind by an activity that
// timed out before it could report its operation id. dispatching operations
// become unknown with their reservation retained; prepared/authorized ones are
// canceled and released.
func (a *Activities) abortOpenOperations(ctx context.Context, input AbortRunInput) error {
	var operationIDs []string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id FROM work.operation
			WHERE run_id = $1 AND org_id = $2
			  AND state IN ('prepared', 'waiting_approval', 'authorized', 'dispatching')
			ORDER BY created_at`,
			input.RunID, input.OrgID,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var operationID string
			if err := rows.Scan(&operationID); err != nil {
				return err
			}
			operationIDs = append(operationIDs, operationID)
		}
		return rows.Err()
	}); err != nil {
		return err
	}
	for _, operationID := range operationIDs {
		if err := a.abortOperation(ctx, AbortRunInput{
			RunID: input.RunID, OrgID: input.OrgID,
			OperationID: operationID, Outcome: input.Outcome, Reason: input.Reason,
		}); err != nil {
			return err
		}
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
		if input.Outcome == "failed" {
			evidence, err := a.rejectionEvidence(ctx, input.OrgID, input.OperationID)
			if err != nil {
				return err
			}
			if evidence.bound {
				// Decision A1 + (a): the gate is the authority. A bound
				// rejected_not_executed receipt proves nothing executed, so the
				// Operation closes as failed and the held reservation is released
				// whether or not the runtime named provider_rejected. Usage stays
				// absent because the receipt itself carries provider zeros.
				if err := a.finishOperation(ctx, input.OrgID, input.OperationID,
					"failed", evidence.providerRequestID, evidence.receiptRef); err != nil {
					return err
				}
				if reservationID == nil {
					return nil
				}
				return a.releaseReservation(ctx, input.OrgID, *reservationID)
			}
		}
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
