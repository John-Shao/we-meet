// Package contentref is the control-plane registry for Content Store
// references used by the trusted content proxy.
//
// A reference is metadata only: it binds one immutable object version to an
// organization, an optional task/run/execution, a kind, a logical slot, a
// content hash and byte count, and the writer that produced it. The object
// body never enters PostgreSQL. Registration/tombstoning are domain commands
// executed as work_worker with an explicit tenant context; work_api has no
// EXECUTE and no table DML (D1 §5.5, D4 §8.1/§6.3).
//
// Errors carry an enumeration code only. They never echo a content reference,
// hash or database statement, so callers may log them safely.
package contentref

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
)

// Kind is one logical class of content reference. The database enforces the
// same closed set.
type Kind string

const (
	KindInput               Kind = "input"
	KindTemplate            Kind = "template"
	KindCheckpointCandidate Kind = "checkpoint_candidate"
	KindModelRequest        Kind = "model_request" // control_plane-only (0013)
	KindAnswer              Kind = "answer"
	KindReceipt             Kind = "receipt"
	KindRejectionEvidence   Kind = "rejection_evidence"
)

// WriterKind is the trusted writer identity recorded with the reference.
type WriterKind string

const (
	WriterControlPlane WriterKind = "control_plane"
	WriterEgress       WriterKind = "egress"
	WriterRuntimeChild WriterKind = "runtime_child"
)

// SlotState distinguishes a reserved candidate slot from a committed fact.
// Reserved rows are not readable: Resolve only returns committed rows.
type SlotState string

const (
	SlotReserved  SlotState = "reserved"
	SlotCommitted SlotState = "committed"
)

const refMaxRunes = 512

// Reference is one content-reference binding. Empty task/run/execution fields
// are stored as SQL NULL. A fragment-bound row (ExecutionID != "") must carry
// both TaskID and RunID; checkpoint candidates and receipts must be bound.
type Reference struct {
	RefID         string
	OrgID         string
	TaskID        string
	RunID         string
	ExecutionID   string
	Kind          Kind
	LogicalSlot   string
	ObjectVersion string
	ContentRef    string
	ContentHash   string
	Bytes         int64
	WriterKind    WriterKind
	SlotState     SlotState
}

// Error is an enumerated content-reference failure code.
type Error struct {
	Code string
}

func (e *Error) Error() string { return "contentref: " + e.Code }

// Is matches another enumerated error by code, so callers can use
// errors.Is(err, contentref.ErrSlotConflict).
func (e *Error) Is(target error) bool {
	other, ok := target.(*Error)
	return ok && other != nil && other.Code == e.Code
}

// ErrSlotConflict is returned when a live slot already holds a different
// binding, or when a tombstoned slot is offered for registration again.
var ErrSlotConflict = &Error{Code: "content_slot_conflict"}

// ErrNotFound is returned when a reference is missing, belongs to another
// tenant, or has been tombstoned. The three cases are deliberately
// indistinguishable so a tombstone cannot be used to probe old content.
var ErrNotFound = &Error{Code: "content_reference_not_found"}

func codeError(code string) *Error { return &Error{Code: code} }

// Registry reads and writes content references through the work_worker pool.
// It keeps no cache: every call re-reads the authoritative row.
type Registry struct {
	pool *pgxpool.Pool
}

func NewRegistry(pool *pgxpool.Pool) *Registry {
	return &Registry{pool: pool}
}

// Register inserts one immutable reference. Replaying the exact same binding
// is idempotent. Reusing a live slot with any different binding surfaces as
// ErrSlotConflict, and a tombstoned slot can never be registered again.
func (r *Registry) Register(ctx context.Context, reference Reference) error {
	if err := reference.validate(); err != nil {
		return err
	}
	if !r.usable() {
		return codeError("pool_required")
	}
	var outcome []byte
	err := workdb.WithWorkerOrgContext(ctx, r.pool, reference.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.register_content_reference(
			   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
			reference.OrgID,
			reference.RefID,
			nullUUID(reference.TaskID),
			nullUUID(reference.RunID),
			nullUUID(reference.ExecutionID),
			string(reference.Kind),
			reference.LogicalSlot,
			reference.ObjectVersion,
			reference.ContentRef,
			reference.ContentHash,
			reference.Bytes,
			string(reference.WriterKind),
		).Scan(&outcome)
	})
	if err != nil {
		return sanitize(err)
	}
	return nil
}

// Reserve creates or replays one reserved checkpoint-candidate slot for the
// runtime child. The execution must exist under the same organization and be
// registered or active; task/run are derived from it by the database. A live
// occupied slot with a different ref_id or execution is ErrSlotConflict, and
// a tombstoned or committed slot can never be reserved. Replaying the exact
// same reservation is idempotent. The reserved row carries no readable
// content until Commit.
func (r *Registry) Reserve(ctx context.Context, orgID, refID, executionID string,
	kind Kind, logicalSlot string,
) error {
	if err := validateOrgID(orgID); err != nil {
		return err
	}
	if !uuidPattern.MatchString(refID) || !uuidPattern.MatchString(executionID) {
		return codeError("invalid_request")
	}
	if kind != KindCheckpointCandidate || !slotPattern.MatchString(logicalSlot) {
		return codeError("invalid_request")
	}
	if !r.usable() {
		return codeError("pool_required")
	}
	var outcome []byte
	err := workdb.WithWorkerOrgContext(ctx, r.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.reserve_content_slot($1, $2, $3, $4, $5)`,
			orgID, refID, executionID, string(kind), logicalSlot,
		).Scan(&outcome)
	})
	if err != nil {
		return sanitize(err)
	}
	return nil
}

// Commit turns one reserved checkpoint-candidate slot into a committed fact.
// Only a runtime_child reservation can commit; the execution binding must
// still hold. Replaying the exact content is idempotent, while any different
// content or hash for the same slot is ErrSlotConflict. A tombstoned slot can
// never commit.
func (r *Registry) Commit(ctx context.Context, orgID, refID, contentRef,
	contentHash string, bytes int64,
) error {
	if err := validateOrgID(orgID); err != nil {
		return err
	}
	if !uuidPattern.MatchString(refID) {
		return codeError("invalid_request")
	}
	if contentRef == "" || strings.TrimSpace(contentRef) == "" ||
		utf8.RuneCountInString(contentRef) > refMaxRunes ||
		strings.ContainsRune(contentRef, '\x00') {
		return codeError("invalid_request")
	}
	if !hashPattern.MatchString(contentHash) || bytes < 0 {
		return codeError("invalid_request")
	}
	if !r.usable() {
		return codeError("pool_required")
	}
	var outcome []byte
	err := workdb.WithWorkerOrgContext(ctx, r.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.commit_content_slot($1, $2, $3, $4, $5)`,
			orgID, refID, contentRef, contentHash, bytes,
		).Scan(&outcome)
	})
	if err != nil {
		return sanitize(err)
	}
	return nil
}

// Resolve returns the live binding for one reference. A missing, foreign or
// tombstoned reference yields ErrNotFound and never returns old content
// authorisation. Reserved candidates are not facts and are likewise hidden.
func (r *Registry) Resolve(ctx context.Context, orgID, refID string) (Reference, error) {
	if err := validateOrgID(orgID); err != nil {
		return Reference{}, err
	}
	if !uuidPattern.MatchString(refID) {
		return Reference{}, codeError("invalid_request")
	}
	if !r.usable() {
		return Reference{}, codeError("pool_required")
	}
	var raw []byte
	err := workdb.WithWorkerOrgContext(ctx, r.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.resolve_content_reference($1, $2)`, orgID, refID,
		).Scan(&raw)
	})
	if err != nil {
		return Reference{}, sanitize(err)
	}
	var payload resolvePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		// The payload is trusted database output, but never propagate its text.
		return Reference{}, codeError("content_reference_unavailable")
	}
	return payload.reference(), nil
}

// Tombstone transitions one reference to its terminal tombstoned state and
// returns true only for the call that performed the transition. Replays return
// false and are audited; the row is never deleted.
func (r *Registry) Tombstone(ctx context.Context, orgID, refID, reason string) (bool, error) {
	if err := validateOrgID(orgID); err != nil {
		return false, err
	}
	if !uuidPattern.MatchString(refID) {
		return false, codeError("invalid_request")
	}
	if !reasonPattern.MatchString(reason) {
		return false, codeError("invalid_request")
	}
	if !r.usable() {
		return false, codeError("pool_required")
	}
	var changed bool
	err := workdb.WithWorkerOrgContext(ctx, r.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.tombstone_content_reference($1, $2, $3)`,
			orgID, refID, reason,
		).Scan(&changed)
	})
	if err != nil {
		return false, sanitize(err)
	}
	return changed, nil
}

func (r *Registry) usable() bool {
	return r != nil && r.pool != nil
}

func (reference Reference) validate() error {
	if err := validateOrgID(reference.OrgID); err != nil {
		return err
	}
	if !uuidPattern.MatchString(reference.RefID) {
		return codeError("invalid_request")
	}
	switch reference.Kind {
	case KindInput, KindTemplate, KindCheckpointCandidate, KindModelRequest,
		KindAnswer, KindReceipt, KindRejectionEvidence:
	default:
		return codeError("invalid_request")
	}
	switch reference.WriterKind {
	case WriterControlPlane, WriterEgress:
	default:
		// runtime_child reservations are created by Reserve, never Register.
		return codeError("invalid_request")
	}
	switch reference.SlotState {
	case "", SlotCommitted:
		// Registration always produces a committed fact.
	default:
		return codeError("invalid_request")
	}
	if !slotPattern.MatchString(reference.LogicalSlot) {
		return codeError("invalid_request")
	}
	if !versionPattern.MatchString(reference.ObjectVersion) {
		return codeError("invalid_request")
	}
	if reference.ContentRef == "" ||
		strings.TrimSpace(reference.ContentRef) == "" ||
		utf8.RuneCountInString(reference.ContentRef) > refMaxRunes ||
		strings.ContainsRune(reference.ContentRef, '\x00') {
		return codeError("invalid_request")
	}
	if !hashPattern.MatchString(reference.ContentHash) {
		return codeError("invalid_request")
	}
	if reference.Bytes < 0 {
		return codeError("invalid_request")
	}
	if reference.TaskID != "" && !uuidPattern.MatchString(reference.TaskID) {
		return codeError("invalid_request")
	}
	if reference.RunID != "" && !uuidPattern.MatchString(reference.RunID) {
		return codeError("invalid_request")
	}
	if reference.ExecutionID != "" && !uuidPattern.MatchString(reference.ExecutionID) {
		return codeError("invalid_request")
	}
	if reference.RunID != "" && reference.TaskID == "" {
		return codeError("invalid_request")
	}
	if reference.ExecutionID != "" && (reference.TaskID == "" || reference.RunID == "") {
		return codeError("invalid_request")
	}
	if (reference.Kind == KindCheckpointCandidate || reference.Kind == KindReceipt) &&
		reference.ExecutionID == "" {
		return codeError("invalid_request")
	}
	if (reference.Kind == KindReceipt || reference.Kind == KindAnswer ||
		reference.Kind == KindRejectionEvidence) &&
		reference.WriterKind != WriterEgress {
		return codeError("content_reference_writer_not_allowed")
	}
	if (reference.Kind == KindInput || reference.Kind == KindTemplate ||
		reference.Kind == KindModelRequest) &&
		reference.WriterKind != WriterControlPlane {
		return codeError("content_reference_writer_not_allowed")
	}
	return nil
}

func validateOrgID(orgID string) error {
	if strings.TrimSpace(orgID) == "" || len(orgID) > 128 ||
		strings.ContainsRune(orgID, '\x00') {
		return codeError("invalid_request")
	}
	return nil
}

func nullUUID(value string) any {
	if value == "" {
		return nil
	}
	return value
}

type resolvePayload struct {
	RefID         string  `json:"ref_id"`
	OrgID         string  `json:"org_id"`
	TaskID        *string `json:"task_id"`
	RunID         *string `json:"run_id"`
	ExecutionID   *string `json:"execution_id"`
	Kind          string  `json:"kind"`
	LogicalSlot   string  `json:"logical_slot"`
	ObjectVersion string  `json:"object_version"`
	ContentRef    string  `json:"content_ref"`
	ContentHash   string  `json:"content_hash"`
	Bytes         int64   `json:"bytes"`
	WriterKind    string  `json:"writer_kind"`
	SlotState     string  `json:"slot_state"`
}

func (p resolvePayload) reference() Reference {
	return Reference{
		RefID:         p.RefID,
		OrgID:         p.OrgID,
		TaskID:        deref(p.TaskID),
		RunID:         deref(p.RunID),
		ExecutionID:   deref(p.ExecutionID),
		Kind:          Kind(p.Kind),
		LogicalSlot:   p.LogicalSlot,
		ObjectVersion: p.ObjectVersion,
		ContentRef:    p.ContentRef,
		ContentHash:   p.ContentHash,
		Bytes:         p.Bytes,
		WriterKind:    WriterKind(p.WriterKind),
		SlotState:     SlotState(p.SlotState),
	}
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

var (
	uuidPattern = regexp.MustCompile(
		`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	slotPattern    = regexp.MustCompile(`^[A-Za-z0-9_.:@/-]{1,512}$`)
	versionPattern = regexp.MustCompile(`^[A-Za-z0-9_.:@+/=-]{1,256}$`)
	hashPattern    = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	reasonPattern  = regexp.MustCompile(`^[a-z][a-z0-9_]{1,63}$`)
	codePattern    = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)
)

// sanitize reduces any failure to an enumeration code. The original message is
// deliberately dropped: it could carry bound values or content references.
func sanitize(err error) error {
	if err == nil {
		return nil
	}
	var dbErr *workdb.Error
	if errors.As(err, &dbErr) && codePattern.MatchString(dbErr.Code) {
		return codeError(dbErr.Code)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if code := messageCode(pgErr.Message); code != "" &&
			(pgErr.Code == "P0001" || pgErr.Code == "P0002" || pgErr.Code == "42501" ||
				pgErr.Code == "22023" || pgErr.Code == "23514" || pgErr.Code == "23505" ||
				pgErr.Code == "23503") {
			return codeError(code)
		}
		switch {
		case pgErr.Code == "42501":
			return codeError("permission_denied")
		case len(pgErr.Code) >= 2 && pgErr.Code[:2] == "22":
			return codeError("invalid_request")
		case pgErr.Code == "23505":
			return ErrSlotConflict
		case pgErr.Code == "23514":
			return codeError("content_reference_invalid")
		case pgErr.Code == "23503":
			return codeError("content_reference_binding_missing")
		}
	}
	return codeError("content_reference_unavailable")
}

// messageCode keeps a leading snake_case code (before any ':') only.
func messageCode(message string) string {
	for index, r := range message {
		if r == ':' {
			message = message[:index]
			break
		}
	}
	if !codePattern.MatchString(message) {
		return ""
	}
	return message
}
