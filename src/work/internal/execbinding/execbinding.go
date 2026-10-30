// Package execbinding materialises the content references one runtime
// execution may read.
//
// The signed decision of 2026-10-30 (option A, D1 §5.5) keeps the trusted
// content proxy's authorization rule singular: a readable reference must carry
// ExecutionID == the execution presented by the caller. Inputs and templates
// are shared Content Store objects, so at plan/execute fragment registration
// the control plane copies their metadata into one execution-bound row per
// execution and kind. The object body stays outside PostgreSQL and is never
// duplicated.
//
// Because work.content_reference enforces UNIQUE (org_id, logical_slot), the
// slot names carry the execution dimension required by the decision:
//
//	input:<executionID>:<inputID>
//	template:<executionID>:<templateID>:<version>
//
// Binding is idempotent for one execution: an existing committed row with the
// same binding is reused (including its ref_id and, for templates, its object
// location), and replaying Register with those values is the registry's
// idempotent path. A different execution always gets its own rows and cannot
// see the first execution's references through the proxy rule.
//
// Input bytes are read from the Content Store and their SHA-256/size are
// verified before any row is written. Template bytes are supplied by the
// caller's frozen TemplateSource, verified the same way, Put into the Content
// Store once per committed slot (a replay reuses the stored object location
// instead of writing again), and only then registered.
//
// Errors are enumeration codes only. They never echo content, references,
// hashes or database statements.
package execbinding

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	workdb "github.com/we-meet/work/internal/db"
)

// TemplateSource supplies the frozen template bytes for one template
// id/version pair and their sha256 digest in "sha256:<64 hex>" form.
type TemplateSource interface {
	Lookup(id string, version int) (body []byte, contentHash string, ok bool)
}

// Binding is the pair of execution-bound references materialised for one
// execution. Both values were registered (or replayed idempotently). InputID,
// TemplateID and TemplateVersion name the frozen assets, so a binding can be
// projected onto another execution without re-reading the task.
type Binding struct {
	InputRef        contentref.Reference
	TemplateRef     contentref.Reference
	InputID         string
	TemplateID      string
	TemplateVersion int
}

// Binder materialises execution-bound input/template references. Pool must be
// a work_worker pool: the reads run under an explicit tenant context and
// contentref.Registry performs the writes as work_worker.
type Binder struct {
	Pool      *pgxpool.Pool
	Content   content.Store
	Templates TemplateSource
}

// Error is an enumerated execbinding failure code.
type Error struct {
	Code string
}

func (e *Error) Error() string { return "execbinding: " + e.Code }

// Is matches another enumerated error by code.
func (e *Error) Is(target error) bool {
	other, ok := target.(*Error)
	return ok && other != nil && other.Code == e.Code
}

// Enumeration codes. They are the only failure detail this package exposes.
const (
	CodeInvalidRequest            = "invalid_request"
	CodePoolRequired              = "pool_required"
	CodeContentStoreUnavailable   = "content_store_unavailable"
	CodeTemplateSourceUnavailable = "template_source_unavailable"
	CodeExecutionNotFound         = "execution_not_found"
	CodeInputNotFound             = "input_not_found"
	CodeSnapshotManifestInvalid   = "snapshot_manifest_invalid"
	CodeInputUnavailable          = "input_unavailable"
	CodeInputHashMismatch         = "input_hash_mismatch"
	CodeTemplateNotFound          = "template_not_found"
	CodeTemplateInvalid           = "template_invalid"
	CodeTemplateHashMismatch      = "template_hash_mismatch"
	CodeContentSlotConflict       = "content_slot_conflict"
	CodeBindingUnavailable        = "binding_unavailable"
	CodeReferenceUnavailable      = "content_reference_unavailable"
)

func codeError(code string) *Error { return &Error{Code: code} }

const objectVersion = "v1"

// Bind reads the execution's task input and Run snapshot manifest, verifies
// the input bytes, resolves and verifies the frozen template, then registers
// both as execution-bound content references with slots that include the
// execution dimension. Replaying it for the same execution is idempotent; a
// different execution gets distinct rows.
func (b *Binder) Bind(ctx context.Context, orgID, executionID string) (Binding, error) {
	if err := validateOrgID(orgID); err != nil {
		return Binding{}, err
	}
	if !uuidPattern.MatchString(executionID) {
		return Binding{}, codeError(CodeInvalidRequest)
	}
	if b == nil || b.Pool == nil {
		return Binding{}, codeError(CodePoolRequired)
	}
	if b.Content == nil {
		return Binding{}, codeError(CodeContentStoreUnavailable)
	}
	if b.Templates == nil {
		return Binding{}, codeError(CodeTemplateSourceUnavailable)
	}

	var (
		taskID, runID, inputID     string
		inputContentRef, inputHash string
		inputBytes                 int64
		manifest                   []byte
	)
	err := workdb.WithWorkerOrgContext(ctx, b.Pool, orgID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT e.task_id::text, e.run_id::text, t.input_id::text, c.manifest
			FROM work.runtime_execution e
			JOIN work.task t
			  ON t.id = e.task_id AND t.org_id = e.org_id
			JOIN work.run r
			  ON r.id = e.run_id AND r.org_id = e.org_id AND r.task_id = e.task_id
			JOIN work.capability_snapshot c
			  ON c.id = r.snapshot_id AND c.org_id = r.org_id
			WHERE e.execution_id = $1 AND e.org_id = $2
			  AND t.deleted_at IS NULL`,
			executionID, orgID,
		).Scan(&taskID, &runID, &inputID, &manifest); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return codeError(CodeExecutionNotFound)
			}
			return err
		}
		if err := tx.QueryRow(ctx, `
			SELECT content_ref, content_hash, bytes
			FROM work.input_object
			WHERE id = $1 AND org_id = $2 AND status = 'active'`,
			inputID, orgID,
		).Scan(&inputContentRef, &inputHash, &inputBytes); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return codeError(CodeInputNotFound)
			}
			return err
		}
		return nil
	})
	if err != nil {
		return Binding{}, sanitizeReadError(err)
	}

	templateID, templateVersion, err := parseManifest(manifest)
	if err != nil {
		return Binding{}, err
	}
	inputSlot := makeInputSlot(executionID, inputID)
	templateSlot := makeTemplateSlot(executionID, templateID, templateVersion)
	if !slotPattern.MatchString(inputSlot) || !slotPattern.MatchString(templateSlot) {
		return Binding{}, codeError(CodeSnapshotManifestInvalid)
	}

	// Verify the input body before touching the registry. A hash or size
	// mismatch refuses the whole bind, so no row is written for either ref.
	inputBody, err := b.Content.Get(ctx, orgID, inputContentRef)
	if err != nil {
		return Binding{}, codeError(CodeInputUnavailable)
	}
	if int64(len(inputBody)) != inputBytes || digestOf(inputBody) != inputHash {
		return Binding{}, codeError(CodeInputHashMismatch)
	}

	templateBody, templateHash, ok := b.Templates.Lookup(templateID, templateVersion)
	if !ok {
		return Binding{}, codeError(CodeTemplateNotFound)
	}
	if len(templateBody) == 0 {
		return Binding{}, codeError(CodeTemplateInvalid)
	}
	if !hashPattern.MatchString(templateHash) || digestOf(templateBody) != templateHash {
		return Binding{}, codeError(CodeTemplateHashMismatch)
	}

	inputRef := contentref.Reference{
		RefID:         deterministicRefID(orgID, inputSlot),
		OrgID:         orgID,
		TaskID:        taskID,
		RunID:         runID,
		ExecutionID:   executionID,
		Kind:          contentref.KindInput,
		LogicalSlot:   inputSlot,
		ObjectVersion: objectVersion,
		ContentRef:    inputContentRef,
		ContentHash:   inputHash,
		Bytes:         inputBytes,
		WriterKind:    contentref.WriterControlPlane,
		SlotState:     contentref.SlotCommitted,
	}
	templateRef := contentref.Reference{
		RefID:         deterministicRefID(orgID, templateSlot),
		OrgID:         orgID,
		TaskID:        taskID,
		RunID:         runID,
		ExecutionID:   executionID,
		Kind:          contentref.KindTemplate,
		LogicalSlot:   templateSlot,
		ObjectVersion: objectVersion,
		ContentHash:   templateHash,
		Bytes:         int64(len(templateBody)),
		WriterKind:    contentref.WriterControlPlane,
		SlotState:     contentref.SlotCommitted,
	}

	registry := contentref.NewRegistry(b.Pool)
	inputRef, err = resolveAndReconcile(ctx, registry, orgID, inputRef)
	if err != nil {
		return Binding{}, err
	}
	templateRef, err = resolveAndReconcile(ctx, registry, orgID, templateRef)
	if err != nil {
		return Binding{}, err
	}

	// A new template is written under the frozen digest. A replay does not
	// reach this branch: the committed row resolved above already supplied its
	// object location, so no second object is written.
	if templateRef.ContentRef == "" {
		put, err := b.Content.Put(ctx, orgID, templateBody)
		if err != nil {
			return Binding{}, codeError(CodeContentStoreUnavailable)
		}
		if put.ContentRef == "" || put.Hash != templateHash ||
			put.Bytes != int64(len(templateBody)) {
			return Binding{}, codeError(CodeTemplateHashMismatch)
		}
		templateRef.ContentRef = put.ContentRef
	}

	if err := registry.Register(ctx, inputRef); err != nil {
		return Binding{}, referenceError(err)
	}
	if err := registry.Register(ctx, templateRef); err != nil {
		return Binding{}, referenceError(err)
	}
	return Binding{
		InputRef:        inputRef,
		TemplateRef:     templateRef,
		InputID:         inputID,
		TemplateID:      templateID,
		TemplateVersion: templateVersion,
	}, nil
}

// Project returns the binding the same input/template assets would receive for
// another execution. It performs no I/O and writes no row: the caller uses it
// to name an intent before the target execution is registered, then Bind for
// that execution must materialise exactly this projection. The source binding
// must already be committed under the same task/run.
func Project(orgID, executionID string, source Binding) (Binding, error) {
	if err := validateOrgID(orgID); err != nil {
		return Binding{}, err
	}
	if !uuidPattern.MatchString(executionID) {
		return Binding{}, codeError(CodeInvalidRequest)
	}
	inputID := source.InputID
	if inputID == "" {
		if parts := strings.SplitN(source.InputRef.LogicalSlot, ":", 3); len(parts) == 3 {
			inputID = parts[2]
		}
	}
	templateID, templateVersion := source.TemplateID, source.TemplateVersion
	if templateID == "" || templateVersion <= 0 {
		if parts := strings.SplitN(source.TemplateRef.LogicalSlot, ":", 4); len(parts) == 4 {
			templateID = parts[2]
			if parsed, err := strconv.Atoi(parts[3]); err == nil {
				templateVersion = parsed
			}
		}
	}
	if inputID == "" || templateID == "" || templateVersion <= 0 {
		return Binding{}, codeError(CodeBindingUnavailable)
	}
	if !hashPattern.MatchString(source.InputRef.ContentHash) ||
		!hashPattern.MatchString(source.TemplateRef.ContentHash) ||
		source.InputRef.ContentRef == "" || source.TemplateRef.ContentRef == "" {
		return Binding{}, codeError(CodeBindingUnavailable)
	}

	inputSlot := makeInputSlot(executionID, inputID)
	templateSlot := makeTemplateSlot(executionID, templateID, templateVersion)
	if !slotPattern.MatchString(inputSlot) || !slotPattern.MatchString(templateSlot) {
		return Binding{}, codeError(CodeInvalidRequest)
	}

	inputRef := contentref.Reference{
		RefID:         deterministicRefID(orgID, inputSlot),
		OrgID:         orgID,
		TaskID:        source.InputRef.TaskID,
		RunID:         source.InputRef.RunID,
		ExecutionID:   executionID,
		Kind:          contentref.KindInput,
		LogicalSlot:   inputSlot,
		ObjectVersion: source.InputRef.ObjectVersion,
		ContentRef:    source.InputRef.ContentRef,
		ContentHash:   source.InputRef.ContentHash,
		Bytes:         source.InputRef.Bytes,
		WriterKind:    contentref.WriterControlPlane,
		SlotState:     contentref.SlotCommitted,
	}
	templateRef := contentref.Reference{
		RefID:         deterministicRefID(orgID, templateSlot),
		OrgID:         orgID,
		TaskID:        source.TemplateRef.TaskID,
		RunID:         source.TemplateRef.RunID,
		ExecutionID:   executionID,
		Kind:          contentref.KindTemplate,
		LogicalSlot:   templateSlot,
		ObjectVersion: source.TemplateRef.ObjectVersion,
		ContentRef:    source.TemplateRef.ContentRef,
		ContentHash:   source.TemplateRef.ContentHash,
		Bytes:         source.TemplateRef.Bytes,
		WriterKind:    contentref.WriterControlPlane,
		SlotState:     contentref.SlotCommitted,
	}
	if inputRef.TaskID == "" || inputRef.RunID == "" ||
		templateRef.TaskID != inputRef.TaskID || templateRef.RunID != inputRef.RunID {
		return Binding{}, codeError(CodeBindingUnavailable)
	}
	return Binding{
		InputRef:        inputRef,
		TemplateRef:     templateRef,
		InputID:         inputID,
		TemplateID:      templateID,
		TemplateVersion: templateVersion,
	}, nil
}

// resolveAndReconcile reuses an exact committed binding so a replay keeps the
// same ref_id and, for templates, the same object location. The registry is
// the only readable surface: 0011 grants work_worker no table SELECT on
// content_reference, so lookups go through Resolve. A tombstoned or reserved
// slot is hidden by Resolve and then refused by Register as a slot conflict.
func resolveAndReconcile(
	ctx context.Context, registry *contentref.Registry, orgID string,
	desired contentref.Reference,
) (contentref.Reference, error) {
	current, err := registry.Resolve(ctx, orgID, desired.RefID)
	if err != nil {
		if errors.Is(err, contentref.ErrNotFound) {
			return desired, nil
		}
		return contentref.Reference{}, referenceError(err)
	}
	return reconcile(desired, current)
}

func reconcile(
	desired, current contentref.Reference,
) (contentref.Reference, error) {
	if current.SlotState != contentref.SlotCommitted {
		return contentref.Reference{}, codeError(CodeContentSlotConflict)
	}
	if current.OrgID != desired.OrgID ||
		current.TaskID != desired.TaskID ||
		current.RunID != desired.RunID ||
		current.ExecutionID != desired.ExecutionID ||
		current.Kind != desired.Kind ||
		current.LogicalSlot != desired.LogicalSlot ||
		current.ObjectVersion != desired.ObjectVersion ||
		current.ContentHash != desired.ContentHash ||
		current.Bytes != desired.Bytes ||
		current.WriterKind != desired.WriterKind {
		return contentref.Reference{}, codeError(CodeContentSlotConflict)
	}
	if desired.ContentRef != "" && desired.ContentRef != current.ContentRef {
		return contentref.Reference{}, codeError(CodeContentSlotConflict)
	}
	desired.RefID = current.RefID
	desired.ContentRef = current.ContentRef
	return desired, nil
}

func parseManifest(manifest []byte) (string, int, error) {
	var payload struct {
		Template struct {
			ID      string `json:"id"`
			Version int    `json:"version"`
		} `json:"template"`
	}
	if err := json.Unmarshal(manifest, &payload); err != nil {
		return "", 0, codeError(CodeSnapshotManifestInvalid)
	}
	if payload.Template.ID == "" || payload.Template.Version <= 0 {
		return "", 0, codeError(CodeSnapshotManifestInvalid)
	}
	return payload.Template.ID, payload.Template.Version, nil
}

func sanitizeReadError(err error) error {
	var bindingErr *Error
	if errors.As(err, &bindingErr) {
		return bindingErr
	}
	return codeError(CodeBindingUnavailable)
}

func referenceError(err error) error {
	var referenceErr *contentref.Error
	if errors.As(err, &referenceErr) {
		return codeError(referenceErr.Code)
	}
	return codeError(CodeReferenceUnavailable)
}

func validateOrgID(orgID string) error {
	if strings.TrimSpace(orgID) == "" || len(orgID) > 128 ||
		strings.ContainsRune(orgID, '\x00') {
		return codeError(CodeInvalidRequest)
	}
	return nil
}

func makeInputSlot(executionID, inputID string) string {
	return "input:" + executionID + ":" + inputID
}

func makeTemplateSlot(executionID, templateID string, version int) string {
	return fmt.Sprintf("template:%s:%s:%d", executionID, templateID, version)
}

func digestOf(body []byte) string {
	digest := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(digest[:])
}

// deterministicRefID derives a stable UUID-shaped id from the organization
// and logical slot. The slot already contains the execution, so two executions
// never share an id, while a retried registration converges on the same one.
func deterministicRefID(orgID, slot string) string {
	digest := sha256.Sum256([]byte("work.execbinding.v1\x00" + orgID + "\x00" + slot))
	var id [16]byte
	copy(id[:], digest[:16])
	id[6] = (id[6] & 0x0f) | 0x80 // custom UUID version
	id[8] = (id[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x",
		id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

var (
	uuidPattern = regexp.MustCompile(
		`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	slotPattern = regexp.MustCompile(`^[A-Za-z0-9_.:@/-]{1,512}$`)
	hashPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)
