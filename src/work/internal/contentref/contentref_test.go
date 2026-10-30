package contentref

import (
	"errors"
	"strings"
	"testing"
)

func validReference() Reference {
	return Reference{
		RefID:         "11111111-1111-4111-8111-111111111111",
		OrgID:         "org_unit",
		TaskID:        "22222222-2222-4222-8222-222222222222",
		RunID:         "33333333-3333-4333-8333-333333333333",
		ExecutionID:   "44444444-4444-4444-8444-444444444444",
		Kind:          KindCheckpointCandidate,
		LogicalSlot:   "checkpoint:model:1:candidate",
		ObjectVersion: "v1",
		ContentRef:    "org/org_unit/run/checkpoint/1",
		ContentHash:   "sha256:" + strings.Repeat("a", 64),
		Bytes:         128,
		WriterKind:    WriterControlPlane,
	}
}

func TestReferenceValidationRejectsMalformedInputBeforeSQL(t *testing.T) {
	// A nil Registry proves validation runs before any pool/SQL access.
	registry := NewRegistry(nil)

	tests := []struct {
		name   string
		mutate func(*Reference)
		code   string
	}{
		{"ref_id", func(r *Reference) { r.RefID = "not-a-uuid" }, "invalid_request"},
		{"uppercase_uuid", func(r *Reference) { r.RefID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, "invalid_request"},
		{"org", func(r *Reference) { r.OrgID = " " }, "invalid_request"},
		{"kind", func(r *Reference) { r.Kind = "artifact" }, "invalid_request"},
		{"writer", func(r *Reference) { r.WriterKind = "node" }, "invalid_request"},
		{"runtime_child_register", func(r *Reference) {
			r.WriterKind = WriterRuntimeChild
		}, "invalid_request"},
		{"reserved_register", func(r *Reference) {
			r.SlotState = SlotReserved
		}, "invalid_request"},
		{"slot", func(r *Reference) { r.LogicalSlot = "checkpoint slot with spaces" }, "invalid_request"},
		{"slot_control", func(r *Reference) { r.LogicalSlot = "checkpoint:\n1" }, "invalid_request"},
		{"version", func(r *Reference) { r.ObjectVersion = "" }, "invalid_request"},
		{"content_ref_empty", func(r *Reference) { r.ContentRef = " " }, "invalid_request"},
		{"content_ref_too_long", func(r *Reference) { r.ContentRef = strings.Repeat("x", 513) }, "invalid_request"},
		{"hash_prefix", func(r *Reference) {
			r.ContentHash = strings.Repeat("a", 64)
		}, "invalid_request"},
		{"hash_case", func(r *Reference) {
			r.ContentHash = "sha256:" + strings.Repeat("A", 64)
		}, "invalid_request"},
		{"negative_bytes", func(r *Reference) { r.Bytes = -1 }, "invalid_request"},
		{"run_without_task", func(r *Reference) { r.TaskID = "" }, "invalid_request"},
		{"execution_without_task", func(r *Reference) { r.TaskID = "" }, "invalid_request"},
		{"candidate_without_execution", func(r *Reference) { r.ExecutionID = "" }, "invalid_request"},
		{"receipt_without_egress", func(r *Reference) {
			r.Kind = KindReceipt
			r.WriterKind = WriterControlPlane
		}, "content_reference_writer_not_allowed"},
		{"answer_with_control_plane", func(r *Reference) {
			r.Kind = KindAnswer
			r.WriterKind = WriterControlPlane
		}, "content_reference_writer_not_allowed"},
		{"input_with_egress", func(r *Reference) {
			r.Kind = KindInput
			r.ExecutionID = ""
			r.WriterKind = WriterEgress
		}, "content_reference_writer_not_allowed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			reference := validReference()
			test.mutate(&reference)
			err := registry.Register(t.Context(), reference)
			var contentErr *Error
			if !errors.As(err, &contentErr) || contentErr.Code != test.code {
				t.Fatalf("Register error = %v, want code %q", err, test.code)
			}
		})
	}
}

func TestResolveAndTombstoneValidateLocally(t *testing.T) {
	registry := NewRegistry(nil)
	if _, err := registry.Resolve(t.Context(), "org_unit", "bad"); err == nil {
		t.Fatal("malformed ref id reached the database")
	}
	if _, err := registry.Tombstone(t.Context(), "org_unit", validReference().RefID, "Bad Reason!"); err == nil {
		t.Fatal("malformed reason reached the database")
	}
	if _, err := registry.Tombstone(t.Context(), "", validReference().RefID, "cleanup"); err == nil {
		t.Fatal("empty org reached the database")
	}
}

func TestReserveAndCommitValidateLocally(t *testing.T) {
	registry := NewRegistry(nil)
	refID := validReference().RefID
	execID := validReference().ExecutionID
	slot := validReference().LogicalSlot

	if err := registry.Reserve(t.Context(), "org_unit", "bad", execID,
		KindCheckpointCandidate, slot); err == nil {
		t.Fatal("malformed ref id reached Reserve SQL")
	}
	if err := registry.Reserve(t.Context(), "org_unit", refID, "bad",
		KindCheckpointCandidate, slot); err == nil {
		t.Fatal("malformed execution id reached Reserve SQL")
	}
	if err := registry.Reserve(t.Context(), "org_unit", refID, execID,
		KindAnswer, slot); err == nil {
		t.Fatal("non-candidate kind reached Reserve SQL")
	}
	if err := registry.Commit(t.Context(), "org_unit", refID, "",
		validReference().ContentHash, 1); err == nil {
		t.Fatal("empty content ref reached Commit SQL")
	}
	if err := registry.Commit(t.Context(), "org_unit", refID, "objects/x",
		"not-a-hash", 1); err == nil {
		t.Fatal("malformed hash reached Commit SQL")
	}
	if err := registry.Commit(t.Context(), "org_unit", refID, "objects/x",
		validReference().ContentHash, -1); err == nil {
		t.Fatal("negative bytes reached Commit SQL")
	}
}

func TestSlotConflictIsATypedError(t *testing.T) {
	err := codeError("content_slot_conflict")
	if !errors.Is(err, ErrSlotConflict) {
		t.Fatal("content_slot_conflict does not match ErrSlotConflict")
	}
	if errors.Is(err, ErrNotFound) {
		t.Fatal("conflict matched ErrNotFound")
	}
	if strings.Contains(err.Error(), "content_ref") {
		t.Fatalf("error leaked bound data: %q", err)
	}
}
