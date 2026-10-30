// Package intent freezes the canonical model_request document of one runtime
// execution and registers it as a content reference.
//
// Authority: docs/plan/work-r0a-runtime-egress-design-2026-10-25.md §8.1
// ("三类不可变文档", "规范化与模型消息装配" items 1-5). The document is the
// logical request only: binding, logical key, input/template references, prior
// receipts in order, route and parameters. It carries no base URL, credential,
// raw messages, execution id, fence or timestamp, so instance and authorization
// changes never alter it while a route or parameter change must produce a new
// approved intent.
//
// One slot exists per execution and logical key:
//
//	model-request:<executionID>:<logicalKey>
//
// The reference id is derived from the organization and that slot, so a replay
// converges on the same ref_id. The registered content_hash is the
// domain-prefixed document hash (canonical.ModelRequest.Hash), never the plain
// body digest the Content Store returns for the stored bytes. Writing different
// bytes for an occupied slot is a typed conflict; an exact replay keeps the
// first object location and registers nothing new.
//
// Migration 0013 permits the model_request kind only for control_plane
// writers. Reads of the execution binding run as work_worker under an explicit
// tenant context, exactly like the registry writes.
//
// Errors are enumeration codes only. They never echo document bytes,
// references, hashes or database statements.
package intent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/execbinding"
)

// Bindings materialises the execution-bound input and template references the
// frozen document names. *execbinding.Binder implements it.
type Bindings interface {
	Bind(ctx context.Context, orgID, executionID string) (execbinding.Binding, error)
}

// Freezer freezes and registers one model_request document. Pool must be a
// work_worker pool: both the binding read and the registry write run under an
// explicit tenant context.
type Freezer struct {
	Pool     *pgxpool.Pool
	Content  content.Store
	Bindings Bindings
}

// Error is an enumerated intent failure code.
type Error struct {
	Code string
}

func (e *Error) Error() string { return "intent: " + e.Code }

// Is matches another enumerated error by code.
func (e *Error) Is(target error) bool {
	other, ok := target.(*Error)
	return ok && other != nil && other.Code == e.Code
}

// Enumeration codes. They are the only failure detail this package exposes.
const (
	CodeInvalidRequest          = "invalid_request"
	CodePoolRequired            = "pool_required"
	CodeContentStoreUnavailable = "content_store_unavailable"
	CodeBindingsUnavailable     = "bindings_unavailable"
	CodeExecutionNotFound       = "execution_not_found"
	CodeExecutionUnavailable    = "runtime_execution_unavailable"
	CodeDocumentInvalid         = "model_request_invalid"
	CodeContentHashMismatch     = "content_hash_mismatch"
	CodeRegistryUnavailable     = "content_reference_unavailable"
	CodeConflict                = "content_slot_conflict"
)

var (
	// ErrExecutionNotFound means no readable execution binding exists for the
	// organization. A foreign tenant's execution is indistinguishable from a
	// missing one.
	ErrExecutionNotFound = &Error{Code: CodeExecutionNotFound}
	// ErrConflict means the slot is already occupied by a different model
	// request. The first registered document stays authoritative.
	ErrConflict = &Error{Code: CodeConflict}
)

func codeError(code string) *Error { return &Error{Code: code} }

const objectVersion = "v1"

// Freeze builds the canonical model_request for one execution and logical key,
// stores its canonical bytes, verifies what was stored, and registers it as a
// committed control-plane content reference bound to the execution.
//
// It is idempotent for the same execution, logical key, route and parameters:
// the replay returns the same ref_id and document hash. Different bytes for an
// occupied slot are ErrConflict. A plan-mode execution has no operation and is
// acceptable; the document itself never names one.
func (f *Freezer) Freeze(
	ctx context.Context,
	orgID, executionID, logicalKey string,
	route canonical.Route,
	parameters canonical.Parameters,
	priorReceipts []canonical.Reference,
) (canonical.Reference, error) {
	if err := validateOrgID(orgID); err != nil {
		return canonical.Reference{}, err
	}
	if !uuidPattern.MatchString(executionID) {
		return canonical.Reference{}, codeError(CodeInvalidRequest)
	}
	key := canonical.LogicalKey(logicalKey)
	if err := key.Validate("logicalKey"); err != nil {
		return canonical.Reference{}, codeError(CodeInvalidRequest)
	}
	if f == nil || f.Pool == nil {
		return canonical.Reference{}, codeError(CodePoolRequired)
	}
	if f.Content == nil {
		return canonical.Reference{}, codeError(CodeContentStoreUnavailable)
	}
	if f.Bindings == nil {
		return canonical.Reference{}, codeError(CodeBindingsUnavailable)
	}

	taskID, runID, snapshotID, runtimeVersion, err := f.loadBinding(ctx, orgID, executionID)
	if err != nil {
		return canonical.Reference{}, err
	}

	binding, err := f.Bindings.Bind(ctx, orgID, executionID)
	if err != nil {
		// execbinding reports enumeration codes only; pass the code through and
		// never a foreign error body.
		var bindingErr *execbinding.Error
		if errors.As(err, &bindingErr) {
			return canonical.Reference{}, bindingErr
		}
		return canonical.Reference{}, codeError(CodeBindingsUnavailable)
	}
	input := canonical.Reference{
		RefID: binding.InputRef.RefID,
		Hash:  binding.InputRef.ContentHash,
	}
	template := canonical.Reference{
		RefID: binding.TemplateRef.RefID,
		Hash:  binding.TemplateRef.ContentHash,
	}

	_, reference, raw, err := buildDocument(
		orgID, executionID, logicalKey,
		canonical.Binding{
			OrgID:          orgID,
			TaskID:         taskID,
			RunID:          runID,
			SnapshotID:     snapshotID,
			RuntimeVersion: runtimeVersion,
		},
		input, &template, route, parameters, priorReceipts,
	)
	if err != nil {
		return canonical.Reference{}, err
	}
	slot := makeModelRequestSlot(executionID, logicalKey)
	refID := reference.RefID
	documentHash := reference.Hash

	desired := contentref.Reference{
		RefID:         refID,
		OrgID:         orgID,
		TaskID:        taskID,
		RunID:         runID,
		ExecutionID:   executionID,
		Kind:          contentref.KindModelRequest,
		LogicalSlot:   slot,
		ObjectVersion: objectVersion,
		ContentHash:   documentHash,
		Bytes:         int64(len(raw)),
		WriterKind:    contentref.WriterControlPlane,
		SlotState:     contentref.SlotCommitted,
	}
	registry := contentref.NewRegistry(f.Pool)
	current, err := registry.Resolve(ctx, orgID, refID)
	switch {
	case err == nil:
		if !sameDocument(current, desired) {
			return canonical.Reference{}, ErrConflict
		}
		// Exact replay: keep the first object location and register nothing.
		return canonical.Reference{RefID: current.RefID, Hash: current.ContentHash}, nil
	case errors.Is(err, contentref.ErrNotFound):
		// A fresh slot, or a tombstoned one that Register will refuse.
	default:
		return canonical.Reference{}, codeError(CodeRegistryUnavailable)
	}

	put, err := f.Content.Put(ctx, orgID, raw)
	if err != nil {
		return canonical.Reference{}, codeError(CodeContentStoreUnavailable)
	}
	if put.ContentRef == "" || put.Bytes != int64(len(raw)) || put.Hash != bodyDigest(raw) {
		return canonical.Reference{}, codeError(CodeContentHashMismatch)
	}
	// Verify the stored object itself, not only the Put result: the bytes read
	// back must parse as a model_request and hash to the reference hash.
	stored, err := f.Content.Get(ctx, orgID, put.ContentRef)
	if err != nil {
		return canonical.Reference{}, codeError(CodeContentStoreUnavailable)
	}
	if !bytes.Equal(stored, raw) {
		return canonical.Reference{}, codeError(CodeContentHashMismatch)
	}
	storedHash, err := canonical.HashDocumentBytes(stored)
	if err != nil || storedHash != documentHash {
		return canonical.Reference{}, codeError(CodeContentHashMismatch)
	}

	desired.ContentRef = put.ContentRef
	if err := registry.Register(ctx, desired); err != nil {
		if errors.Is(err, contentref.ErrSlotConflict) {
			// A concurrent writer may have committed the same document between
			// Resolve and Register. Converge only on identical bytes.
			current, resolveErr := registry.Resolve(ctx, orgID, refID)
			if resolveErr == nil && sameDocument(current, desired) {
				return canonical.Reference{RefID: current.RefID, Hash: current.ContentHash}, nil
			}
			return canonical.Reference{}, ErrConflict
		}
		return canonical.Reference{}, codeError(CodeRegistryUnavailable)
	}
	return canonical.Reference{RefID: refID, Hash: documentHash}, nil
}

// Preview builds the reference an intent would receive for one execution
// without reading or writing the registry. Freeze produces the same document
// once the execution-binding rows exist; callers use Preview only to register a
// fragment whose registration requires the intent reference before the binding
// rows can be written.
func Preview(
	orgID, executionID, logicalKey string,
	binding canonical.Binding,
	input canonical.Reference,
	template *canonical.Reference,
	route canonical.Route,
	parameters canonical.Parameters,
	priorReceipts []canonical.Reference,
) (canonical.Reference, canonical.ModelRequest, error) {
	if err := validateOrgID(orgID); err != nil {
		return canonical.Reference{}, canonical.ModelRequest{}, err
	}
	if !uuidPattern.MatchString(executionID) {
		return canonical.Reference{}, canonical.ModelRequest{}, codeError(CodeInvalidRequest)
	}
	key := canonical.LogicalKey(logicalKey)
	if err := key.Validate("logicalKey"); err != nil {
		return canonical.Reference{}, canonical.ModelRequest{}, codeError(CodeInvalidRequest)
	}
	document, reference, _, err := buildDocument(
		orgID, executionID, logicalKey, binding, input, template, route, parameters, priorReceipts,
	)
	if err != nil {
		return canonical.Reference{}, canonical.ModelRequest{}, err
	}
	return reference, document, nil
}

func buildDocument(
	orgID, executionID, logicalKey string,
	binding canonical.Binding,
	input canonical.Reference,
	template *canonical.Reference,
	route canonical.Route,
	parameters canonical.Parameters,
	priorReceipts []canonical.Reference,
) (canonical.ModelRequest, canonical.Reference, []byte, error) {
	// Copy the receipts so a caller reusing its slice cannot change the bytes
	// that were hashed. Order is the logical order and is never sorted.
	prior := make([]canonical.Reference, len(priorReceipts))
	copy(prior, priorReceipts)

	document := canonical.ModelRequest{
		Binding:       binding,
		LogicalKey:    canonical.LogicalKey(logicalKey),
		Input:         input,
		Template:      template,
		PriorReceipts: prior,
		Route:         route,
		Parameters:    parameters,
	}
	if err := document.Validate(); err != nil {
		return canonical.ModelRequest{}, canonical.Reference{}, nil, codeError(CodeDocumentInvalid)
	}
	raw, err := document.Canonical()
	if err != nil {
		return canonical.ModelRequest{}, canonical.Reference{}, nil, codeError(CodeDocumentInvalid)
	}
	documentHash, err := document.Hash()
	if err != nil {
		return canonical.ModelRequest{}, canonical.Reference{}, nil, codeError(CodeDocumentInvalid)
	}

	slot := makeModelRequestSlot(executionID, logicalKey)
	refID := deterministicRefID(orgID, slot)
	// Prove the bytes we are about to store carry exactly the document hash
	// form §8.1 requires before any object or row is written.
	if err := canonical.VerifyReference(canonical.RefKindModelRequest,
		canonical.Reference{RefID: refID, Hash: documentHash}, raw); err != nil {
		return canonical.ModelRequest{}, canonical.Reference{}, nil, codeError(CodeContentHashMismatch)
	}
	return document, canonical.Reference{RefID: refID, Hash: documentHash}, raw, nil
}

// loadBinding reads the five binding fields one execution contributes. The
// snapshot comes from the Run, which is the authoritative frozen capability
// snapshot; the execution row carries the runtime version. A soft-deleted task
// is treated as missing: tombstoning revokes new content writes.
func (f *Freezer) loadBinding(
	ctx context.Context, orgID, executionID string,
) (taskID, runID, snapshotID, runtimeVersion string, err error) {
	err = workdb.WithWorkerOrgContext(ctx, f.Pool, orgID, func(tx pgx.Tx) error {
		readErr := tx.QueryRow(ctx, `
			SELECT e.task_id::text, e.run_id::text, r.snapshot_id::text,
			       e.runtime_version
			FROM work.runtime_execution e
			JOIN work.run r
			  ON r.id = e.run_id AND r.org_id = e.org_id
			 AND r.task_id = e.task_id
			JOIN work.task t
			  ON t.id = e.task_id AND t.org_id = e.org_id
			WHERE e.execution_id = $1 AND e.org_id = $2
			  AND t.deleted_at IS NULL`,
			executionID, orgID,
		).Scan(&taskID, &runID, &snapshotID, &runtimeVersion)
		if errors.Is(readErr, pgx.ErrNoRows) {
			return ErrExecutionNotFound
		}
		return readErr
	})
	if err != nil {
		var intentErr *Error
		if errors.As(err, &intentErr) {
			return "", "", "", "", intentErr
		}
		return "", "", "", "", codeError(CodeExecutionUnavailable)
	}
	return taskID, runID, snapshotID, runtimeVersion, nil
}

// sameDocument compares every signed binding field except the object location:
// the slot and the document hash are the identity, so an exact replay reuses
// whatever immutable object the first registration committed.
func sameDocument(current, desired contentref.Reference) bool {
	return current.SlotState == contentref.SlotCommitted &&
		current.RefID == desired.RefID &&
		current.OrgID == desired.OrgID &&
		current.TaskID == desired.TaskID &&
		current.RunID == desired.RunID &&
		current.ExecutionID == desired.ExecutionID &&
		current.Kind == desired.Kind &&
		current.LogicalSlot == desired.LogicalSlot &&
		current.ObjectVersion == desired.ObjectVersion &&
		current.ContentHash == desired.ContentHash &&
		current.Bytes == desired.Bytes &&
		current.WriterKind == desired.WriterKind
}

func makeModelRequestSlot(executionID, logicalKey string) string {
	return "model-request:" + executionID + ":" + logicalKey
}

// deterministicRefID derives a stable UUID-shaped id from the organization and
// logical slot. The slot contains the execution, so two executions never share
// an id while a retried freeze converges on the same one.
func deterministicRefID(orgID, slot string) string {
	digest := sha256.Sum256([]byte("work.intent.v1\x00" + orgID + "\x00" + slot))
	var id [16]byte
	copy(id[:], digest[:16])
	id[6] = (id[6] & 0x0f) | 0x80 // custom UUID version
	id[8] = (id[8] & 0x3f) | 0x80 // RFC 4122 variant
	return hex.EncodeToString(id[:4]) + "-" +
		hex.EncodeToString(id[4:6]) + "-" +
		hex.EncodeToString(id[6:8]) + "-" +
		hex.EncodeToString(id[8:10]) + "-" +
		hex.EncodeToString(id[10:16])
}

// bodyDigest is the plain SHA-256 the Content Store returns for stored bytes.
// It is deliberately kept apart from the domain-prefixed document hash.
func bodyDigest(body []byte) string {
	sum := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func validateOrgID(orgID string) error {
	if strings.TrimSpace(orgID) == "" || len(orgID) > 128 ||
		strings.ContainsRune(orgID, '\x00') {
		return codeError(CodeInvalidRequest)
	}
	return nil
}

var uuidPattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
