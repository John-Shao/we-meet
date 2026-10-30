package runflow

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/contentref"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/execbinding"
	"github.com/we-meet/work/internal/finishing"
	"github.com/we-meet/work/internal/intent"
	"github.com/we-meet/work/internal/providerctx"
	"github.com/we-meet/work/internal/receipt"
)

const (
	canonicalObjectVersion = "v1"
	advancePlanLease       = 10 * time.Minute
	advanceExecuteDeadline = 30 * time.Minute
	advanceMediaType       = "text/markdown"
)

type runtimeHead struct {
	Revision       int64
	Ref            string
	Hash           string
	RuntimeVersion string
	ExecutionID    string
}

type advanceParameters struct {
	MaxOutputTokens  int64  `json:"maxOutputTokens"`
	TemperatureMilli int64  `json:"temperatureMilli"`
	OutputFormat     string `json:"outputFormat"`
}

func (a *Activities) providerResolver() *providerctx.Resolver {
	if a.Providers != nil {
		return a.Providers
	}
	return &providerctx.Resolver{Pool: a.Pool}
}

func (a *Activities) binder() *execbinding.Binder {
	return &execbinding.Binder{Pool: a.Pool, Content: a.Content, Templates: a.Templates}
}

// PrepareAdvance reads the Run graph, acquires a queued Run and validates the
// input bytes. It returns identifiers, hashes and counters only.
func (a *Activities) PrepareAdvance(ctx context.Context, input Input) (AdvancePrepared, error) {
	prepared := AdvancePrepared{RunID: input.RunID, OrgID: input.OrgID}
	var (
		inputContentRef, inputHash string
		manifest                   []byte
	)
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT r.task_id::text, r.snapshot_id::text, r.state, r.fence,
			       r.runtime_version, i.id::text, i.content_ref, i.content_hash,
			       c.manifest, p.revision, p.run_cap_tokens
			FROM work.run r
			JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
			JOIN work.input_object i ON i.id = t.input_id AND i.org_id = t.org_id
			JOIN work.capability_snapshot c ON c.id = r.snapshot_id AND c.org_id = r.org_id
			JOIN work.org_policy p ON p.org_id = r.org_id
			WHERE r.id = $1 AND r.org_id = $2
			  AND t.deleted_at IS NULL AND i.status = 'active'`,
			input.RunID, input.OrgID,
		).Scan(&prepared.TaskID, &prepared.SnapshotID, &prepared.RunState, &prepared.Fence,
			&prepared.RuntimeVersion, &prepared.InputID, &inputContentRef, &inputHash,
			&manifest, &prepared.PolicyRevision, &prepared.TokenUpperBound); err != nil {
			return err
		}
		if prepared.RunState == "queued" {
			if err := tx.QueryRow(ctx, `SELECT state, fence FROM work.acquire_run($1, $2)`,
				input.RunID, input.OrgID,
			).Scan(&prepared.RunState, &prepared.Fence); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return AdvancePrepared{}, fmt.Errorf("run_not_found")
		}
		return AdvancePrepared{}, activityFailure(err, "advance_prepare_failed")
	}
	prepared.InputHash = inputHash
	if prepared.RunState == "cancel_requested" || terminalRun(prepared.RunState) {
		prepared.Canceled = true
		return prepared, nil
	}
	if prepared.RunState != "active" {
		prepared.ErrCode = "run_not_active"
		return prepared, nil
	}
	if a.Content == nil {
		return AdvancePrepared{}, fmt.Errorf("content_store_unavailable")
	}
	body, err := a.Content.Get(ctx, input.OrgID, inputContentRef)
	if err != nil {
		return AdvancePrepared{}, activityFailure(err, "advance_input_read_failed")
	}
	hash, err := canonical.BodyHash(body)
	if err != nil || hash != inputHash {
		return AdvancePrepared{}, fmt.Errorf("advance_input_hash_mismatch")
	}
	var payload struct {
		Goal       string `json:"goal"`
		Background string `json:"background"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || strings.TrimSpace(payload.Goal) == "" {
		return AdvancePrepared{}, fmt.Errorf("advance_input_invalid")
	}
	if err := parseAdvanceManifest(manifest, &prepared); err != nil {
		return AdvancePrepared{}, err
	}
	return prepared, nil
}

func parseAdvanceManifest(manifest []byte, prepared *AdvancePrepared) error {
	var payload struct {
		Template struct {
			ID      string `json:"id"`
			Version int    `json:"version"`
		} `json:"template"`
	}
	if err := json.Unmarshal(manifest, &payload); err != nil || payload.Template.ID == "" ||
		payload.Template.Version <= 0 {
		return fmt.Errorf("advance_snapshot_manifest_invalid")
	}
	prepared.TemplateID = payload.Template.ID
	prepared.TemplateVersion = payload.Template.Version
	return nil
}

// EnsureAdvanceHead materialises the explicit revision 0 head. A replay reads
// the committed head first and never writes a second revision 0.
func (a *Activities) EnsureAdvanceHead(ctx context.Context, prepared AdvancePrepared) (AdvanceHead, error) {
	var taskID, snapshotID, runtimeVersion, state string
	var fence int64
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, prepared.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT task_id::text, snapshot_id::text, state, fence, runtime_version
			FROM work.run WHERE id = $1 AND org_id = $2`,
			prepared.RunID, prepared.OrgID,
		).Scan(&taskID, &snapshotID, &state, &fence, &runtimeVersion)
	})
	if err != nil {
		return AdvanceHead{}, activityFailure(err, "advance_head_run_read_failed")
	}
	if state == "cancel_requested" || terminalRun(state) {
		return AdvanceHead{Canceled: true}, nil
	}
	if state != "active" {
		return AdvanceHead{ErrCode: "run_not_active"}, nil
	}
	if taskID != prepared.TaskID || snapshotID != prepared.SnapshotID || fence != prepared.Fence ||
		runtimeVersion != prepared.RuntimeVersion {
		return AdvanceHead{ErrCode: "run_changed"}, nil
	}
	binding := canonical.Binding{
		OrgID: prepared.OrgID, TaskID: taskID, RunID: prepared.RunID,
		SnapshotID: snapshotID, RuntimeVersion: runtimeVersion,
	}
	head, err := a.readAdvanceHead(ctx, prepared.OrgID, prepared.RunID)
	if err == nil {
		return a.verifyAdvanceHead(ctx, prepared, binding, head)
	}
	if !headMissing(err) {
		return AdvanceHead{}, activityFailure(err, "advance_head_read_failed")
	}

	planExecutionID := deterministicExecutionID(prepared.OrgID, prepared.RunID, "plan:"+advanceLogicalKey)
	executeExecutionID := deterministicExecutionID(prepared.OrgID, prepared.RunID, "execute:"+advanceLogicalKey)
	deadline, err := a.executionDeadline(ctx, prepared.OrgID, planExecutionID)
	if err != nil {
		return AdvanceHead{}, err
	}
	if deadline.IsZero() {
		deadline = time.Now().Add(advancePlanLease)
	}
	if err := a.registerExecution(ctx, prepared.OrgID, planExecutionID, prepared.RunID,
		"plan", prepared.Fence, runtimeVersion, deadline, "", "", "", "", "", "", "",
	); err != nil {
		return AdvanceHead{}, err
	}
	if err := a.claimExecution(ctx, prepared.OrgID, planExecutionID, advancePlanHolder(planExecutionID)); err != nil {
		return AdvanceHead{}, err
	}
	planBinding, err := a.binder().Bind(ctx, prepared.OrgID, planExecutionID)
	if err != nil {
		return AdvanceHead{}, executionBindingError(err)
	}
	projected, err := execbinding.Project(prepared.OrgID, executeExecutionID, planBinding)
	if err != nil {
		return AdvanceHead{}, executionBindingError(err)
	}
	input := canonical.Reference{RefID: projected.InputRef.RefID, Hash: projected.InputRef.ContentHash}
	template := canonical.Reference{RefID: projected.TemplateRef.RefID, Hash: projected.TemplateRef.ContentHash}
	initial := canonical.CanonicalState{
		Binding:           binding,
		Revision:          0,
		WriterExecutionID: planExecutionID,
		Input:             input,
		Template:          &template,
		CompletedModels:   []canonical.CompletedModel{},
		Phase:             canonical.PhaseReady,
	}
	if err := initial.Validate(); err != nil {
		return AdvanceHead{}, fmt.Errorf("advance_head_invalid")
	}
	stateRef, err := a.putCanonicalState(ctx, prepared.OrgID, initial, planExecutionID, 0)
	if err != nil {
		return AdvanceHead{}, err
	}
	revision, err := a.commitHead(ctx, prepared.OrgID, prepared.RunID, planExecutionID,
		nil, stateRef, runtimeVersion)
	if err != nil {
		// A concurrent writer may have committed revision 0 after our read.
		head, readErr := a.readAdvanceHead(ctx, prepared.OrgID, prepared.RunID)
		if readErr == nil {
			return a.verifyAdvanceHead(ctx, prepared, binding, head)
		}
		return AdvanceHead{}, err
	}
	if revision != 0 {
		return AdvanceHead{}, fmt.Errorf("advance_head_revision_invalid")
	}
	return AdvanceHead{
		PlanExecutionID: planExecutionID, Revision: 0,
		Ref: stateRef.RefID, Hash: stateRef.Hash, RuntimeVersion: runtimeVersion,
		InputRef: input.RefID, InputHash: input.Hash,
		TemplateRef: template.RefID, TemplateHash: template.Hash,
	}, nil
}

func (a *Activities) verifyAdvanceHead(
	ctx context.Context, prepared AdvancePrepared, binding canonical.Binding, head runtimeHead,
) (AdvanceHead, error) {
	ref := canonical.Reference{RefID: head.Ref, Hash: head.Hash}
	state, err := a.loadCanonicalState(ctx, prepared.OrgID, ref)
	if err != nil {
		return AdvanceHead{}, err
	}
	if state.Binding != binding || state.Revision != head.Revision ||
		head.RuntimeVersion != prepared.RuntimeVersion {
		return AdvanceHead{}, fmt.Errorf("advance_head_binding_mismatch")
	}
	if head.Revision == 0 {
		if state.Previous != nil || state.Phase != canonical.PhaseReady ||
			len(state.CompletedModels) != 0 || state.Pending != nil || state.Artifact != nil {
			return AdvanceHead{}, fmt.Errorf("advance_head_shape_invalid")
		}
	}
	result := AdvanceHead{
		PlanExecutionID: head.ExecutionID, Revision: head.Revision,
		Ref: head.Ref, Hash: head.Hash, RuntimeVersion: head.RuntimeVersion,
		InputRef: state.Input.RefID, InputHash: state.Input.Hash,
		AlreadyAdvanced: head.Revision > 0,
	}
	if state.Template != nil {
		result.TemplateRef = state.Template.RefID
		result.TemplateHash = state.Template.Hash
	}
	return result, nil
}

// PrepareAdvanceExecution creates/authorizes/reserves/claims the operation,
// registers the execute fragment against the head, and freezes the intent.
func (a *Activities) PrepareAdvanceExecution(
	ctx context.Context, input PrepareExecutionInput,
) (AdvanceExecution, error) {
	prepared, head := input.Prepared, input.Head
	if head.AlreadyAdvanced {
		return AdvanceExecution{}, nil
	}
	var (
		taskID, snapshotID, runtimeVersion, state string
		fence                                     int64
		manifest, modelRoute                      []byte
		policyRevision, tokenUpperBound           int64
	)
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, prepared.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT r.task_id::text, r.snapshot_id::text, r.state, r.fence,
			       r.runtime_version, c.manifest, c.model_route,
			       p.revision, p.run_cap_tokens
			FROM work.run r
			JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
			JOIN work.capability_snapshot c ON c.id = r.snapshot_id AND c.org_id = r.org_id
			JOIN work.org_policy p ON p.org_id = r.org_id
			WHERE r.id = $1 AND r.org_id = $2 AND t.deleted_at IS NULL`,
			prepared.RunID, prepared.OrgID,
		).Scan(&taskID, &snapshotID, &state, &fence, &runtimeVersion,
			&manifest, &modelRoute, &policyRevision, &tokenUpperBound)
	})
	if err != nil {
		return AdvanceExecution{}, activityFailure(err, "advance_execution_read_failed")
	}
	if state == "cancel_requested" || terminalRun(state) {
		return AdvanceExecution{Canceled: true}, nil
	}
	if state != "active" {
		return AdvanceExecution{ErrCode: "run_not_active"}, nil
	}
	if taskID != prepared.TaskID || snapshotID != prepared.SnapshotID || fence != prepared.Fence ||
		runtimeVersion != prepared.RuntimeVersion {
		return AdvanceExecution{ErrCode: "run_changed"}, nil
	}
	headRef := canonical.Reference{RefID: head.Ref, Hash: head.Hash}
	if err := headRef.Validate("head"); err != nil || head.Revision != 0 {
		return AdvanceExecution{ErrCode: "head_invalid"}, nil
	}
	inputRef := canonical.Reference{RefID: head.InputRef, Hash: head.InputHash}
	if err := inputRef.Validate("head.input"); err != nil {
		return AdvanceExecution{ErrCode: "head_invalid"}, nil
	}
	var templateRef *canonical.Reference
	if head.TemplateRef != "" || head.TemplateHash != "" {
		value := canonical.Reference{RefID: head.TemplateRef, Hash: head.TemplateHash}
		if err := value.Validate("head.template"); err != nil {
			return AdvanceExecution{ErrCode: "head_invalid"}, nil
		}
		templateRef = &value
	}
	params, err := decodeAdvanceParameters(manifest, modelRoute)
	if err != nil {
		return AdvanceExecution{ErrCode: "model_parameters_unavailable"}, nil
	}
	route, err := a.providerResolver().ResolveRoute(ctx, prepared.OrgID)
	if err != nil {
		return AdvanceExecution{}, providerContextError(err)
	}
	binding := canonical.Binding{
		OrgID: prepared.OrgID, TaskID: taskID, RunID: prepared.RunID,
		SnapshotID: snapshotID, RuntimeVersion: runtimeVersion,
	}
	executeExecutionID := deterministicExecutionID(prepared.OrgID, prepared.RunID, "execute:"+advanceLogicalKey)
	preview, previewDocument, err := intent.Preview(prepared.OrgID, executeExecutionID, advanceLogicalKey,
		binding, inputRef, templateRef, canonicalRoute(route), params, nil)
	if err != nil {
		return AdvanceExecution{ErrCode: "intent_invalid"}, nil
	}
	requestHash := preview.Hash

	var operationID string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, prepared.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.create_operation($1, $2, $3, 'model', $4)`,
			prepared.RunID, prepared.OrgID, advanceLogicalKey, requestHash,
		).Scan(&operationID)
	}); err != nil {
		return AdvanceExecution{}, activityFailure(err, "advance_operation_create_failed")
	}
	execution := AdvanceExecution{
		ExecutionID: executeExecutionID, OperationID: operationID,
		RequestHash: requestHash, IntentRef: preview.RefID, IntentHash: preview.Hash,
	}
	if err := a.authorizeAdvanceOperation(ctx, prepared.OrgID, operationID, policyRevision); err != nil {
		return AdvanceExecution{}, err
	}
	reservationID, err := a.ensureAdvanceReservation(ctx, prepared.OrgID, operationID, tokenUpperBound)
	if err != nil {
		return AdvanceExecution{}, err
	}
	execution.ReservationID = reservationID
	canceled, err := a.runCanceled(ctx, prepared.OrgID, prepared.RunID)
	if err != nil {
		return AdvanceExecution{}, activityFailure(err, "advance_run_state_read_failed")
	}
	if canceled {
		execution.Canceled = true
		return execution, nil
	}
	attemptID, err := a.claimAdvanceOperation(ctx, prepared.OrgID, prepared.RunID, operationID, fence)
	if err != nil {
		return AdvanceExecution{}, err
	}
	if attemptID == "" {
		return AdvanceExecution{Superseded: true}, nil
	}
	execution.AttemptID = attemptID
	deadline, registeredIntentRef, registered, err := a.executionRegistration(
		ctx, prepared.OrgID, prepared.RunID, executeExecutionID, "execute")
	if err != nil {
		return AdvanceExecution{}, err
	}
	if deadline.IsZero() {
		deadline = time.Now().Add(advanceExecuteDeadline)
	}
	execution.DeadlineUnixMs = deadline.UnixMilli()
	intentLocator := registeredIntentRef
	if !registered || intentLocator == "" {
		raw, err := previewDocument.Canonical()
		if err != nil {
			return AdvanceExecution{ErrCode: "intent_invalid"}, nil
		}
		put, err := a.Content.Put(ctx, prepared.OrgID, raw)
		if err != nil {
			return AdvanceExecution{}, activityFailure(err, "advance_intent_store_failed")
		}
		if put.Hash != bodyDigest(raw) {
			return AdvanceExecution{ErrCode: "intent_hash_mismatch"}, nil
		}
		intentLocator = put.ContentRef
	}
	if err := a.registerExecution(ctx, prepared.OrgID, executeExecutionID, prepared.RunID,
		"execute", fence, runtimeVersion, deadline,
		head.Ref, head.Hash, intentLocator, preview.Hash, requestHash, operationID, attemptID,
	); err != nil {
		return AdvanceExecution{}, err
	}
	if err := a.bindRegisteredExecution(ctx, prepared.OrgID, executeExecutionID, operationID, attemptID,
		head, preview, intentLocator, requestHash); err != nil {
		return AdvanceExecution{ErrCode: "execution_binding_conflict"}, nil
	}
	frozen, err := (&intent.Freezer{Pool: a.Pool, Content: a.Content, Bindings: a.binder()}).
		Freeze(ctx, prepared.OrgID, executeExecutionID, advanceLogicalKey,
			canonicalRoute(route), params, nil)
	if err != nil {
		code := "intent_freeze_failed"
		var intentErr *intent.Error
		if errors.As(err, &intentErr) && intentErr.Code != "" {
			code = "intent_" + intentErr.Code
		}
		return AdvanceExecution{ErrCode: code}, nil
	}
	if frozen != preview {
		return AdvanceExecution{ErrCode: "intent_mismatch"}, nil
	}
	return execution, nil
}

func (a *Activities) authorizeAdvanceOperation(
	ctx context.Context, orgID, operationID string, policyRevision int64,
) error {
	var state string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM work.operation WHERE id = $1 AND org_id = $2`,
			operationID, orgID).Scan(&state)
	}); err != nil {
		return activityFailure(err, "advance_operation_read_failed")
	}
	switch state {
	case "authorized", "dispatching":
		return nil
	case "prepared":
		if err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT work.authorize_operation($1, $2, $3, 'policy_auto')`,
				orgID, operationID, policyRevision)
			return err
		}); err != nil {
			return activityFailure(err, "advance_operation_authorize_failed")
		}
		return nil
	case "waiting_approval":
		return fmt.Errorf("advance_operation_approval_required")
	default:
		return fmt.Errorf("advance_operation_not_authorizable")
	}
}

func (a *Activities) ensureAdvanceReservation(
	ctx context.Context, orgID, operationID string, amount int64,
) (string, error) {
	var reservationID string
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM work.quota_reservation
			WHERE operation_id = $1 AND org_id = $2 AND state IN ('held', 'unknown')
			ORDER BY reservation_seq DESC LIMIT 1`,
			operationID, orgID,
		).Scan(&reservationID)
		if err == nil {
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var accountID string
		if err := tx.QueryRow(ctx, `SELECT work.ensure_quota_account($1, $2, $3, $4, $5)`,
			orgID, a.accountKey(), a.quotaPeriod(), a.quotaLimit(), a.quotaEnforcement(),
		).Scan(&accountID); err != nil {
			return err
		}
		if amount <= 0 {
			amount = 1
		}
		return tx.QueryRow(ctx, `SELECT work.reserve_quota($1, $2, $3, $4, $5)`,
			orgID, a.accountKey(), a.quotaPeriod(), operationID, amount,
		).Scan(&reservationID)
	})
	if err != nil {
		message := err.Error()
		switch {
		case strings.Contains(message, "quota_account_not_found"):
			return "", fmt.Errorf("quota_account_missing")
		case strings.Contains(message, "quota_exhausted"), strings.Contains(message, "run_cap_exceeded"):
			return "", fmt.Errorf("quota_exhausted")
		default:
			return "", activityFailure(err, "advance_quota_reserve_failed")
		}
	}
	return reservationID, nil
}

func (a *Activities) claimAdvanceOperation(
	ctx context.Context, orgID, runID, operationID string, fence int64,
) (string, error) {
	var state, attemptID string
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT state, COALESCE(dispatch_attempt_id::text, '')
			FROM work.operation WHERE id = $1 AND org_id = $2 AND run_id = $3`,
			operationID, orgID, runID,
		).Scan(&state, &attemptID)
	})
	if err != nil {
		return "", activityFailure(err, "advance_operation_read_failed")
	}
	switch state {
	case "dispatching":
		if attemptID == "" {
			return "", nil
		}
		return attemptID, nil
	case "authorized":
		var claimed *string
		if err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT work.claim_dispatch($1, $2, $3, $4)`,
				operationID, orgID, a.consumerID(), fence).Scan(&claimed)
		}); err != nil {
			return "", activityFailure(err, "advance_dispatch_claim_failed")
		}
		if claimed == nil || *claimed == "" {
			// Another consumer owns the attempt or the Run is no longer current.
			return "", nil
		}
		if err := a.ensureAdvanceReservationForClaimed(ctx, orgID, operationID); err != nil {
			return "", err
		}
		return *claimed, nil
	default:
		return "", nil
	}
}

// ensureAdvanceReservationForClaimed re-checks the reservation after the
// dispatch claim. The pre-claim reserve normally already created it; this read
// keeps a retry after a crash between reserve and claim convergent.
func (a *Activities) ensureAdvanceReservationForClaimed(ctx context.Context, orgID, operationID string) error {
	var exists bool
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM work.quota_reservation
			WHERE operation_id = $1 AND org_id = $2 AND state IN ('held', 'unknown'))`,
			operationID, orgID,
		).Scan(&exists)
	}); err != nil {
		return activityFailure(err, "advance_quota_read_failed")
	}
	if !exists {
		return fmt.Errorf("advance_reservation_missing")
	}
	return nil
}

func (a *Activities) bindRegisteredExecution(
	ctx context.Context, orgID, executionID, operationID, attemptID string,
	head AdvanceHead, preview canonical.Reference, intentLocator, requestHash string,
) error {
	var (
		runID, mode, runtimeVersion    string
		inputRef, inputHash            *string
		intentRef, intentHash, reqHash *string
		opID, attempt                  *string
	)
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT run_id::text, mode, runtime_version, input_checkpoint_ref,
			       input_checkpoint_hash, intent_ref, intent_hash, request_hash,
			       operation_id::text, dispatch_attempt_id::text
			FROM work.runtime_execution WHERE execution_id = $1 AND org_id = $2`,
			executionID, orgID,
		).Scan(&runID, &mode, &runtimeVersion, &inputRef, &inputHash,
			&intentRef, &intentHash, &reqHash, &opID, &attempt)
	})
	if err != nil {
		return err
	}
	value := func(v *string) string {
		if v == nil {
			return ""
		}
		return *v
	}
	if mode != "execute" || value(inputRef) != head.Ref || value(inputHash) != head.Hash ||
		value(intentRef) != intentLocator || value(intentHash) != preview.Hash ||
		value(reqHash) != requestHash || value(opID) != operationID || value(attempt) != attemptID {
		return fmt.Errorf("advance_execution_binding_mismatch")
	}
	return nil
}

func (a *Activities) registerExecution(
	ctx context.Context, orgID, executionID, runID, mode string, fence int64,
	runtimeVersion string, deadline time.Time,
	inputRef, inputHash, intentRef, intentHash, requestHash, operationID, attemptID string,
) error {
	var checkpointRef, checkpointHash, intentRefArg, intentHashArg, requestHashArg any
	var operationArg, attemptArg any
	if inputRef != "" {
		checkpointRef, checkpointHash = inputRef, inputHash
	}
	if intentRef != "" {
		intentRefArg, intentHashArg = intentRef, intentHash
	}
	if requestHash != "" {
		requestHashArg = requestHash
	}
	if operationID != "" {
		operationArg, attemptArg = operationID, attemptID
	}
	var state string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT work.register_runtime_execution(
				$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
			orgID, executionID, runID, mode, fence, runtimeVersion, deadline,
			checkpointRef, checkpointHash, intentRefArg, intentHashArg, requestHashArg,
			operationArg, attemptArg,
		).Scan(&state)
	}); err != nil {
		return executionCommandError(err)
	}
	switch state {
	case "registered", "active":
		return nil
	default:
		return fmt.Errorf("advance_execution_%s", state)
	}
}

func (a *Activities) claimExecution(ctx context.Context, orgID, executionID, holderID string) error {
	var state string
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.claim_runtime_execution($1, $2, $3)`,
			orgID, executionID, holderID).Scan(&state)
	})
	if err != nil {
		return executionCommandError(err)
	}
	switch state {
	case "claimed", "already_claimed":
		return nil
	default:
		return fmt.Errorf("advance_execution_not_claimable")
	}
}

func (a *Activities) executionDeadline(
	ctx context.Context, orgID, executionID string,
) (time.Time, error) {
	var deadline time.Time
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT hard_deadline FROM work.runtime_execution
			WHERE execution_id = $1 AND org_id = $2`,
			executionID, orgID,
		).Scan(&deadline)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, activityFailure(err, "advance_execution_read_failed")
	}
	return deadline, nil
}

// executionRegistration reads the fragment row an earlier attempt of this
// activity may already have registered. register_runtime_execution is
// idempotent only when the whole binding, including hard_deadline, matches, so
// a replay must reuse the deadline and intent locator that were committed
// first. A missing row is the ordinary "not registered yet" answer; a row that
// already reached a terminal state can never be re-registered under the same
// deterministic execution id.
func (a *Activities) executionRegistration(
	ctx context.Context, orgID, runID, executionID, mode string,
) (time.Time, string, bool, error) {
	var (
		deadline  time.Time
		intentRef string
		rowRunID  string
		rowMode   string
		state     string
	)
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT hard_deadline, COALESCE(intent_ref, ''), run_id::text, mode, state
			FROM work.runtime_execution
			WHERE execution_id = $1 AND org_id = $2`,
			executionID, orgID,
		).Scan(&deadline, &intentRef, &rowRunID, &rowMode, &state)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, "", false, nil
	}
	if err != nil {
		return time.Time{}, "", false, activityFailure(err, "advance_execution_read_failed")
	}
	if rowRunID != runID || rowMode != mode {
		return time.Time{}, "", false, fmt.Errorf("advance_execution_binding_mismatch")
	}
	switch state {
	case "registered", "active":
		return deadline, intentRef, true, nil
	default:
		return time.Time{}, "", false, fmt.Errorf("advance_execution_%s", state)
	}
}

func (a *Activities) readAdvanceHead(ctx context.Context, orgID, runID string) (runtimeHead, error) {
	var head runtimeHead
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT checkpoint_revision, checkpoint_ref, checkpoint_hash,
			       runtime_version, committed_execution_id::text
			FROM work.read_runtime_checkpoint_head($1, $2)`,
			orgID, runID,
		).Scan(&head.Revision, &head.Ref, &head.Hash, &head.RuntimeVersion, &head.ExecutionID)
	})
	return head, err
}

func (a *Activities) commitHead(
	ctx context.Context, orgID, runID, executionID string,
	expected *runtimeHead, stateRef canonical.Reference, runtimeVersion string,
) (int64, error) {
	var expectedRevision, expectedRef, expectedHash any
	if expected != nil {
		expectedRevision = expected.Revision
		expectedRef = expected.Ref
		expectedHash = expected.Hash
	}
	var revision int64
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT work.commit_runtime_checkpoint(
				$1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			orgID, runID, executionID, expectedRevision, expectedRef, expectedHash,
			stateRef.RefID, stateRef.Hash, runtimeVersion,
		).Scan(&revision)
	})
	if err != nil {
		return 0, executionCommandError(err)
	}
	return revision, nil
}

func (a *Activities) putCanonicalState(
	ctx context.Context, orgID string, state canonical.CanonicalState, executionID string, revision int64,
) (canonical.Reference, error) {
	if a.Content == nil || a.Pool == nil {
		return canonical.Reference{}, fmt.Errorf("advance_content_unavailable")
	}
	raw, err := state.Canonical()
	if err != nil {
		return canonical.Reference{}, fmt.Errorf("advance_state_invalid")
	}
	hash, err := state.Hash()
	if err != nil {
		return canonical.Reference{}, fmt.Errorf("advance_state_invalid")
	}
	slot := fmt.Sprintf("canonical-state:%s:%d", state.Binding.RunID, revision)
	refID := deterministicUUID("work.runflow.canonical.v1", orgID, slot)
	registry := contentref.NewRegistry(a.Pool)
	current, err := registry.Resolve(ctx, orgID, refID)
	if err == nil {
		if current.Kind != contentref.KindCheckpointCandidate ||
			current.ContentHash != hash || current.TaskID != state.Binding.TaskID ||
			current.RunID != state.Binding.RunID || current.ExecutionID != executionID {
			return canonical.Reference{}, fmt.Errorf("advance_state_conflict")
		}
		body, readErr := a.Content.Get(ctx, orgID, current.ContentRef)
		if readErr != nil || !bytes.Equal(body, raw) {
			return canonical.Reference{}, fmt.Errorf("advance_state_conflict")
		}
		return canonical.Reference{RefID: refID, Hash: hash}, nil
	}
	if !errors.Is(err, contentref.ErrNotFound) {
		return canonical.Reference{}, fmt.Errorf("advance_state_unavailable")
	}
	put, err := a.Content.Put(ctx, orgID, raw)
	if err != nil || put.ContentRef == "" || put.Bytes != int64(len(raw)) {
		return canonical.Reference{}, fmt.Errorf("advance_state_unavailable")
	}
	stored, err := a.Content.Get(ctx, orgID, put.ContentRef)
	if err != nil || !bytes.Equal(stored, raw) {
		return canonical.Reference{}, fmt.Errorf("advance_state_unavailable")
	}
	storedHash, err := canonical.HashDocumentBytes(stored)
	if err != nil || storedHash != hash {
		return canonical.Reference{}, fmt.Errorf("advance_state_hash_mismatch")
	}
	desired := contentref.Reference{
		RefID: refID, OrgID: orgID, TaskID: state.Binding.TaskID,
		RunID: state.Binding.RunID, ExecutionID: executionID,
		Kind: contentref.KindCheckpointCandidate, LogicalSlot: slot,
		ObjectVersion: canonicalObjectVersion, ContentRef: put.ContentRef,
		ContentHash: hash, Bytes: int64(len(raw)),
		WriterKind: contentref.WriterControlPlane, SlotState: contentref.SlotCommitted,
	}
	if err := registry.Register(ctx, desired); err != nil {
		if errors.Is(err, contentref.ErrSlotConflict) {
			current, resolveErr := registry.Resolve(ctx, orgID, refID)
			if resolveErr == nil && current.ContentHash == hash && current.ExecutionID == executionID {
				return canonical.Reference{RefID: refID, Hash: hash}, nil
			}
		}
		return canonical.Reference{}, fmt.Errorf("advance_state_conflict")
	}
	return canonical.Reference{RefID: refID, Hash: hash}, nil
}

func (a *Activities) loadCanonicalState(
	ctx context.Context, orgID string, ref canonical.Reference,
) (canonical.CanonicalState, error) {
	if err := ref.Validate("head"); err != nil {
		return canonical.CanonicalState{}, fmt.Errorf("advance_head_invalid")
	}
	if a.Content == nil || a.Pool == nil {
		return canonical.CanonicalState{}, fmt.Errorf("advance_content_unavailable")
	}
	registry := contentref.NewRegistry(a.Pool)
	current, err := registry.Resolve(ctx, orgID, ref.RefID)
	if err != nil {
		return canonical.CanonicalState{}, fmt.Errorf("advance_head_unavailable")
	}
	if current.Kind != contentref.KindCheckpointCandidate || current.ContentHash != ref.Hash ||
		current.ExecutionID == "" {
		return canonical.CanonicalState{}, fmt.Errorf("advance_head_invalid")
	}
	body, err := a.Content.Get(ctx, orgID, current.ContentRef)
	if err != nil {
		return canonical.CanonicalState{}, fmt.Errorf("advance_head_unavailable")
	}
	state, err := canonical.ParseCanonicalState(body)
	if err != nil {
		return canonical.CanonicalState{}, fmt.Errorf("advance_head_invalid")
	}
	hash, err := state.Hash()
	if err != nil || hash != ref.Hash {
		return canonical.CanonicalState{}, fmt.Errorf("advance_head_hash_mismatch")
	}
	return state, nil
}

// FinishAdvance confirms the operation from the trusted receipt, publishes the
// answer as the Run artifact, and CAS-commits revision 1 built by Go. The
// child's checkpoint_candidate is never used as a head.
func (a *Activities) FinishAdvance(
	ctx context.Context, input AdvanceFinishInput,
) (AdvanceFinishOutput, error) {
	prepared, head, execution := input.Prepared, input.Head, input.Execution
	if a.Content == nil || a.Pool == nil {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_unavailable"}, nil
	}
	var runState string
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, prepared.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM work.run WHERE id = $1 AND org_id = $2`,
			prepared.RunID, prepared.OrgID).Scan(&runState)
	}); err != nil {
		return AdvanceFinishOutput{}, activityFailure(err, "advance_finish_run_read_failed")
	}
	if runState == "cancel_requested" || runState == "canceled" {
		return AdvanceFinishOutput{Status: AdvanceStatusCanceled, ErrCode: "run_canceled"}, nil
	}
	if runState == "failed" {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "run_failed"}, nil
	}
	if runState == "succeeded" {
		// A workflow reset may re-run finishing after finish_run already
		// succeeded. Never publish into a terminal Run; accept only a head that
		// is already the finished successor.
		current, err := a.readAdvanceHead(ctx, prepared.OrgID, prepared.RunID)
		if err == nil && current.Revision > head.Revision {
			state, loadErr := a.loadCanonicalState(ctx, prepared.OrgID,
				canonical.Reference{RefID: current.Ref, Hash: current.Hash})
			if loadErr == nil && state.Revision == current.Revision &&
				state.Phase == canonical.PhaseFinished && state.Artifact != nil {
				return AdvanceFinishOutput{
					Status: AdvanceStatusSucceeded, HeadRef: current.Ref,
					HeadHash: current.Hash, HeadRevision: current.Revision,
				}, nil
			}
		}
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "run_succeeded"}, nil
	}
	if runState == "waiting" {
		if err := workdb.WithWorkerOrgContext(ctx, a.Pool, prepared.OrgID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT work.resume_run($1, $2)`, prepared.OrgID, prepared.RunID)
			return err
		}); err != nil {
			return AdvanceFinishOutput{}, activityFailure(err, "advance_finish_resume_failed")
		}
	}

	finisher := &finishing.Finisher{Pool: a.Pool, Content: a.Content}
	outcome, err := finisher.FinishFromReceipt(ctx, prepared.OrgID, execution.OperationID)
	if err != nil {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: finishErrorCode(err)}, nil
	}
	if outcome.Status == finishing.StatusUsageUnavailable {
		return AdvanceFinishOutput{
			Status: AdvanceStatusUsageUnavailable, HeadRef: head.Ref, HeadHash: head.Hash,
			HeadRevision: head.Revision,
		}, nil
	}
	if outcome.Status != finishing.StatusConfirmed && outcome.Status != finishing.StatusAlreadyConfirmed {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_status_invalid"}, nil
	}

	facts, err := a.loadFinishFacts(ctx, prepared.OrgID, execution)
	if err != nil {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_binding_mismatch"}, nil
	}
	if facts.ReceiptHash != outcome.ReceiptHash {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_receipt_mismatch"}, nil
	}
	receiptBody, err := a.Content.Get(ctx, prepared.OrgID, facts.ReceiptRef)
	if err != nil {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_receipt_unavailable"}, nil
	}
	verified, err := receipt.Verify(receiptBody, receipt.Expectation{
		OrgID: prepared.OrgID, TaskID: prepared.TaskID, RunID: prepared.RunID,
		OperationID: execution.OperationID, AttemptID: execution.AttemptID,
		ExecutionID: execution.ExecutionID, RequestHash: execution.RequestHash,
		ReceiptHash: facts.ReceiptHash,
	})
	if err != nil {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_receipt_invalid"}, nil
	}
	if verified.Outcome != canonical.OutcomeSucceeded || verified.Content == nil {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_receipt_invalid"}, nil
	}
	if verified.Receipt.Binding != (canonical.Binding{
		OrgID: prepared.OrgID, TaskID: prepared.TaskID, RunID: prepared.RunID,
		SnapshotID: prepared.SnapshotID, RuntimeVersion: prepared.RuntimeVersion,
	}) {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_binding_mismatch"}, nil
	}
	answerRef, answerLocator, answerBody, err := a.loadAnswer(ctx, prepared.OrgID,
		execution.ExecutionID, *verified.Content, verified.Receipt.ContentBytes)
	if err != nil {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_content_unavailable"}, nil
	}
	artifactID, versionNo, err := a.publishAdvanceArtifact(ctx, prepared, execution,
		answerLocator.ContentRef, answerRef, facts.ReceiptHash, answerBody)
	if err != nil {
		return AdvanceFinishOutput{}, err
	}

	current, err := a.readAdvanceHead(ctx, prepared.OrgID, prepared.RunID)
	if err != nil {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_head_unavailable"}, nil
	}
	if current.Revision > head.Revision {
		state, err := a.loadCanonicalState(ctx, prepared.OrgID,
			canonical.Reference{RefID: current.Ref, Hash: current.Hash})
		if err != nil {
			return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_head_invalid"}, nil
		}
		if !advanceStateMatches(state, current.Revision, head, facts, *verified.Content) {
			return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_head_conflict"}, nil
		}
		return AdvanceFinishOutput{
			Status: AdvanceStatusSucceeded, ArtifactID: artifactID, VersionNo: versionNo,
			HeadRef: current.Ref, HeadHash: current.Hash, HeadRevision: current.Revision,
		}, nil
	}
	if current.Revision != head.Revision {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_head_conflict"}, nil
	}
	baseRef := canonical.Reference{RefID: current.Ref, Hash: current.Hash}
	base, err := a.loadCanonicalState(ctx, prepared.OrgID, baseRef)
	if err != nil {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_head_invalid"}, nil
	}
	if base.Revision != head.Revision {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_head_conflict"}, nil
	}
	completed := append([]canonical.CompletedModel(nil), base.CompletedModels...)
	completed = append(completed, canonical.CompletedModel{
		LogicalKey:  canonical.LogicalKey1,
		RequestHash: execution.RequestHash,
		Receipt: canonical.Reference{
			RefID: facts.ReceiptSlotID, Hash: facts.ReceiptHash,
		},
	})
	next := canonical.CanonicalState{
		Binding:           base.Binding,
		Revision:          base.Revision + 1,
		Previous:          &baseRef,
		WriterExecutionID: execution.ExecutionID,
		Input:             base.Input,
		Template:          base.Template,
		CompletedModels:   completed,
		Phase:             canonical.PhaseFinished,
		Artifact:          verified.Content,
	}
	if err := canonical.ValidateSuccession(base, baseRef, next); err != nil {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_succession_invalid"}, nil
	}
	nextRef, err := a.putCanonicalState(ctx, prepared.OrgID, next, execution.ExecutionID, next.Revision)
	if err != nil {
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_head_write_failed"}, nil
	}
	revision, err := a.commitHead(ctx, prepared.OrgID, prepared.RunID, execution.ExecutionID,
		&current, nextRef, prepared.RuntimeVersion)
	if err != nil {
		// A replay may have committed the same successor before this call.
		latest, readErr := a.readAdvanceHead(ctx, prepared.OrgID, prepared.RunID)
		if readErr == nil && latest.Revision == head.Revision+1 &&
			latest.Hash == nextRef.Hash && latest.Ref == nextRef.RefID {
			return AdvanceFinishOutput{
				Status: AdvanceStatusSucceeded, ArtifactID: artifactID, VersionNo: versionNo,
				HeadRef: latest.Ref, HeadHash: latest.Hash, HeadRevision: latest.Revision,
			}, nil
		}
		return AdvanceFinishOutput{Status: AdvanceStatusFailed, ErrCode: "finish_head_conflict"}, nil
	}
	return AdvanceFinishOutput{
		Status: AdvanceStatusSucceeded, ArtifactID: artifactID, VersionNo: versionNo,
		HeadRef: nextRef.RefID, HeadHash: nextRef.Hash, HeadRevision: revision,
	}, nil
}

type finishFacts struct {
	ReceiptRef    string
	ReceiptHash   string
	ReceiptSlotID string
}

func (a *Activities) loadFinishFacts(
	ctx context.Context, orgID string, execution AdvanceExecution,
) (finishFacts, error) {
	var (
		executionID, taskID, runID, intentRef, intentHash, requestHash string
		attemptID, receiptRef, receiptHash, receiptResult, slotID      string
	)
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT e.execution_id::text, e.task_id::text, e.run_id::text,
			       COALESCE(e.intent_ref, ''), COALESCE(e.intent_hash, ''),
			       COALESCE(e.request_hash, ''), COALESCE(e.dispatch_attempt_id::text, ''),
			       COALESCE(g.receipt_ref, ''), COALESCE(g.receipt_hash, ''),
			       COALESCE(g.receipt_result, ''), COALESCE(g.receipt_slot_id::text, '')
			FROM work.runtime_execution e
			JOIN work.dispatch_delivery g
			  ON g.org_id = e.org_id AND g.operation_id = e.operation_id
			WHERE e.execution_id = $1 AND e.org_id = $2`,
			execution.ExecutionID, orgID,
		).Scan(&executionID, &taskID, &runID, &intentRef, &intentHash, &requestHash,
			&attemptID, &receiptRef, &receiptHash, &receiptResult, &slotID)
	})
	if err != nil {
		return finishFacts{}, err
	}
	if executionID != execution.ExecutionID || taskID == "" || runID == "" ||
		intentRef == "" || intentHash != execution.IntentHash ||
		requestHash != execution.RequestHash || attemptID != execution.AttemptID ||
		receiptRef == "" || receiptHash == "" || receiptResult != "success" ||
		slotID == "" {
		return finishFacts{}, fmt.Errorf("advance_finish_binding_mismatch")
	}
	return finishFacts{ReceiptRef: receiptRef, ReceiptHash: receiptHash, ReceiptSlotID: slotID}, nil
}

func (a *Activities) loadAnswer(
	ctx context.Context, orgID, executionID string, ref canonical.Reference, expectedBytes int64,
) (canonical.Reference, contentref.Reference, []byte, error) {
	if err := ref.Validate("receipt.content"); err != nil {
		return canonical.Reference{}, contentref.Reference{}, nil, err
	}
	registry := contentref.NewRegistry(a.Pool)
	current, err := registry.Resolve(ctx, orgID, ref.RefID)
	if err != nil || current.Kind != contentref.KindAnswer ||
		current.ExecutionID != executionID || current.ContentHash != ref.Hash {
		return canonical.Reference{}, contentref.Reference{}, nil, fmt.Errorf("advance_answer_unavailable")
	}
	body, err := a.Content.Get(ctx, orgID, current.ContentRef)
	if err != nil || int64(len(body)) != expectedBytes {
		return canonical.Reference{}, contentref.Reference{}, nil, fmt.Errorf("advance_answer_unavailable")
	}
	hash, err := canonical.BodyHash(body)
	if err != nil || hash != ref.Hash {
		return canonical.Reference{}, contentref.Reference{}, nil, fmt.Errorf("advance_answer_hash_mismatch")
	}
	return ref, current, body, nil
}

func (a *Activities) publishAdvanceArtifact(
	ctx context.Context, prepared AdvancePrepared, execution AdvanceExecution,
	answerContentRef string, answerRef canonical.Reference, receiptHash string, answerBody []byte,
) (string, int, error) {
	provenance, err := json.Marshal(map[string]any{
		"runtime_version": prepared.RuntimeVersion,
		"execution":       "advance",
		"step":            1,
		"operation_id":    execution.OperationID,
		"attempt_id":      execution.AttemptID,
		"logical_key":     advanceLogicalKey,
		"receipt_hash":    receiptHash,
	})
	if err != nil {
		return "", 0, fmt.Errorf("advance_artifact_provenance_invalid")
	}
	var artifactID string
	var versionNo int
	if err := workdb.WithWorkerOrgContext(ctx, a.Pool, prepared.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT artifact_id::text, version_no FROM work.publish_artifact(
				$1, $2, $3, 'result', $4, $5, $6, $7, $8::jsonb)`,
			prepared.OrgID, prepared.TaskID, prepared.RunID,
			answerContentRef, answerRef.Hash, int64(len(answerBody)),
			advanceMediaType, string(provenance),
		).Scan(&artifactID, &versionNo)
	}); err != nil {
		return "", 0, activityFailure(err, "advance_artifact_publish_failed")
	}
	return artifactID, versionNo, nil
}

func advanceStateMatches(
	state canonical.CanonicalState, revision int64, head AdvanceHead, facts finishFacts,
	artifact canonical.Reference,
) bool {
	return state.Revision == revision && state.Phase == canonical.PhaseFinished &&
		state.Previous != nil && state.Previous.RefID == head.Ref &&
		state.Previous.Hash == head.Hash && len(state.CompletedModels) == 1 &&
		state.CompletedModels[0].LogicalKey == canonical.LogicalKey1 &&
		state.CompletedModels[0].Receipt.RefID == facts.ReceiptSlotID &&
		state.CompletedModels[0].Receipt.Hash == facts.ReceiptHash &&
		state.Artifact != nil && *state.Artifact == artifact
}

func decodeAdvanceParameters(manifest, modelRoute []byte) (canonical.Parameters, error) {
	var values advanceParameters
	found := false
	for _, raw := range [][]byte{modelRoute, manifest} {
		if len(raw) == 0 {
			continue
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil {
			continue
		}
		candidates := []json.RawMessage{raw}
		if nested, ok := object["parameters"]; ok {
			candidates = append([]json.RawMessage{nested}, candidates...)
		}
		for _, candidate := range candidates {
			var decoded advanceParameters
			if err := json.Unmarshal(candidate, &decoded); err != nil {
				continue
			}
			if decoded.MaxOutputTokens > 0 {
				values = decoded
				found = true
				break
			}
		}
		if found {
			break
		}
	}
	if !found {
		return canonical.Parameters{}, fmt.Errorf("advance_parameters_missing")
	}
	if values.OutputFormat == "" {
		values.OutputFormat = canonical.OutputFormatMarkdown
	}
	parameters := canonical.Parameters{
		MaxOutputTokens:  values.MaxOutputTokens,
		TemperatureMilli: values.TemperatureMilli,
		OutputFormat:     values.OutputFormat,
	}
	if parameters.MaxOutputTokens < 1 || parameters.TemperatureMilli < 0 ||
		parameters.TemperatureMilli > 2000 || parameters.OutputFormat != canonical.OutputFormatMarkdown {
		return canonical.Parameters{}, fmt.Errorf("advance_parameters_invalid")
	}
	return parameters, nil
}

func canonicalRoute(route providerctx.Route) canonical.Route {
	return canonical.Route{
		Provider: route.Provider, Model: route.Model,
		ConfigRevision: route.ConfigRevision, CompatProfileVersion: route.CompatProfileVersion,
	}
}

func providerContextError(err error) error {
	var providerErr *providerctx.Error
	if errors.As(err, &providerErr) && providerErr.Code != "" {
		return fmt.Errorf("provider_%s", providerErr.Code)
	}
	return fmt.Errorf("provider_context_unavailable")
}

func executionBindingError(err error) error {
	var bindingErr *execbinding.Error
	if errors.As(err, &bindingErr) && bindingErr.Code != "" {
		return fmt.Errorf("binding_%s", bindingErr.Code)
	}
	return fmt.Errorf("binding_unavailable")
}

func finishErrorCode(err error) string {
	switch {
	case errors.Is(err, finishing.ErrGateNotFound):
		return "finish_gate_missing"
	case errors.Is(err, finishing.ErrReceiptNotAttached):
		return "finish_receipt_missing"
	case errors.Is(err, finishing.ErrSealedNotSent):
		return "finish_sealed_not_sent"
	case errors.Is(err, finishing.ErrRejectedWithoutFinishingPath):
		return "finish_rejected"
	case errors.Is(err, finishing.ErrExecutionBindingMismatch),
		errors.Is(err, finishing.ErrOperationBindingMismatch):
		return "finish_binding_mismatch"
	case errors.Is(err, finishing.ErrReceiptInvalid), errors.Is(err, finishing.ErrIntentInvalid):
		return "finish_receipt_invalid"
	case errors.Is(err, finishing.ErrUsageIncomplete):
		return "finish_usage_incomplete"
	case errors.Is(err, finishing.ErrContentStore), errors.Is(err, finishing.ErrPool):
		return "finish_unavailable"
	default:
		return "finish_failed"
	}
}

func executionCommandError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Message != "" {
		code := strings.SplitN(pgErr.Message, ":", 2)[0]
		if code != "" && len(code) <= 64 {
			return fmt.Errorf("advance_%s", code)
		}
	}
	return fmt.Errorf("advance_execution_command_failed")
}

func headMissing(err error) bool {
	if errors.Is(err, pgx.ErrNoRows) {
		return true
	}
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "P0002" &&
		strings.Contains(pgErr.Message, "runtime_checkpoint_head_not_found")
}

func advancePlanHolder(executionID string) string {
	return "work-worker-plan:" + executionID
}

// bodyDigest is the Content Store's plain body hash: SHA-256 over the stored
// bytes, rendered in the same "sha256:<hex>" form Put returns. It is not the
// domain-prefixed document hash used for canonical JSON documents.
func bodyDigest(body []byte) string {
	sum := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func deterministicExecutionID(orgID, runID, purpose string) string {
	return deterministicUUID("work.runflow.execution.v1", orgID, runID, purpose)
}

func deterministicUUID(domain string, parts ...string) string {
	digest := sha256.Sum256([]byte(domain + "\x00" + strings.Join(parts, "\x00")))
	var id [16]byte
	copy(id[:], digest[:16])
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(id[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" +
		encoded[16:20] + "-" + encoded[20:32]
}

// RevokeAdvanceExecution revokes a registered fragment. It never seals the
// dispatch gate: revocation forbids a not-yet-consumed send, while a send that
// already happened stays reconcilable instead of being reported as not sent.
func (a *Activities) RevokeAdvanceExecution(ctx context.Context, input RevokeExecutionInput) error {
	if input.ExecutionID == "" {
		return nil
	}
	reason := input.Reason
	if reason == "" {
		reason = "run_canceled"
	}
	err := workdb.WithWorkerOrgContext(ctx, a.Pool, input.OrgID, func(tx pgx.Tx) error {
		var state string
		return tx.QueryRow(ctx, `SELECT work.revoke_runtime_execution($1, $2, $3)`,
			input.OrgID, input.ExecutionID, reason).Scan(&state)
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "P0002" {
			return nil
		}
		return activityFailure(err, "advance_revoke_failed")
	}
	return nil
}
