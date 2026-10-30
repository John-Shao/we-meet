package contentproxy

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"

	"github.com/we-meet/work/internal/contentref"
)

var hashPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type checkpointResponse struct {
	RefID       string `json:"ref_id"`
	ContentHash string `json:"content_hash"`
	Bytes       int64  `json:"bytes"`
}

// handleCheckpoint accepts one child-written checkpoint candidate.
//
// Order (each failure is final and leaves the slot reserved, never committed):
//  1. capability and shape checks (401/422);
//  2. reserve the preallocated slot for this execution (409 on conflict);
//  3. write the object and require its digest to equal the declared one (422);
//  4. commit the reservation so the candidate becomes resolvable.
//
// The child chooses neither the slot ownership nor the execution binding; the
// registry enforces both. A mismatch between declared and stored content keeps
// the slot reserved rather than publishing a different object.
func (s *Server) handleCheckpoint(w http.ResponseWriter, r *http.Request) {
	presented, ok := readCredential(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, codeCapabilityInvalid)
		return
	}
	allowed, err := s.authorizer.Authorize(r.Context(), presented.org, presented.execution,
		audience, presented.generation, presented.token)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, codeAuthorizationUnavailable)
		return
	}
	if !allowed {
		writeError(w, http.StatusUnauthorized, codeCapabilityInvalid)
		return
	}

	refID := r.Header.Get(HeaderRefID)
	logicalSlot := r.Header.Get(HeaderLogicalSlot)
	declaredHash := r.Header.Get(HeaderContentHash)
	if !uuidPattern.MatchString(refID) || logicalSlot == "" || !hashPattern.MatchString(declaredHash) {
		writeError(w, http.StatusUnprocessableEntity, codeInvalidRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, codeRequestTooLarge)
			return
		}
		writeError(w, http.StatusUnprocessableEntity, codeInvalidRequest)
		return
	}
	if len(body) == 0 {
		writeError(w, http.StatusUnprocessableEntity, codeInvalidRequest)
		return
	}

	if err := s.references.Reserve(r.Context(), presented.org, refID, presented.execution,
		contentref.KindCheckpointCandidate, logicalSlot); err != nil {
		writeReserveError(w, err)
		return
	}
	ref, err := s.store.Put(r.Context(), presented.org, body)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, codeContentUnavailable)
		return
	}
	if ref.Hash != declaredHash {
		writeError(w, http.StatusUnprocessableEntity, codeHashMismatch)
		return
	}
	if err := s.references.Commit(r.Context(), presented.org, refID,
		ref.ContentRef, ref.Hash, ref.Bytes); err != nil {
		writeReserveError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(checkpointResponse{
		RefID: refID, ContentHash: ref.Hash, Bytes: ref.Bytes,
	})
}

func writeReserveError(w http.ResponseWriter, err error) {
	if errors.Is(err, contentref.ErrSlotConflict) {
		writeError(w, http.StatusConflict, codeSlotConflict)
		return
	}
	writeError(w, http.StatusServiceUnavailable, codeContentReferenceUnavailable)
}
