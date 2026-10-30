package contentproxy

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/contentref"
)

var (
	uuidPattern       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	generationPattern = regexp.MustCompile(`^[1-9][0-9]{0,8}$`)
)

// credential is the capability binding presented by the child. None of it is
// trusted until Authorize re-reads the authoritative records.
type credential struct {
	org        string
	execution  string
	generation int
	token      string
}

// handleRead serves one bound read.
//
// Order (each failure is final):
//  1. credential headers are present and shaped (401);
//  2. capability.Authorize(org, execution, "work-content", generation, token)
//     is true against live records (401/503);
//  3. the reference resolves live in this organization (404/422/503);
//  4. the reference is bound to this execution (403) - the landed registry has
//     no reference-graph authorization, so an unbound template/input is
//     refused rather than granted;
//  5. the object is read and its byte count and SHA-256 digest match the
//     registered binding (503/500). Nothing is written before this check.
func (s *Server) handleRead(w http.ResponseWriter, r *http.Request) {
	presented, ok := readCredential(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, codeCapabilityInvalid)
		return
	}

	allowed, err := s.authorizer.Authorize(r.Context(), presented.org, presented.execution,
		audience, presented.generation, presented.token)
	if err != nil {
		// The authorization service or database is unavailable: deny.
		writeError(w, http.StatusServiceUnavailable, codeAuthorizationUnavailable)
		return
	}
	if !allowed {
		writeError(w, http.StatusUnauthorized, codeCapabilityInvalid)
		return
	}

	refID := r.PathValue("refId")
	if !uuidPattern.MatchString(refID) {
		writeError(w, http.StatusUnprocessableEntity, codeInvalidRequest)
		return
	}
	reference, err := s.references.Resolve(r.Context(), presented.org, refID)
	if err != nil {
		writeResolveError(w, err)
		return
	}
	if reference.RefID != refID || reference.OrgID != presented.org {
		// Defensive: never let a resolution answer cross the presented tenant.
		writeError(w, http.StatusNotFound, codeContentReferenceNotFound)
		return
	}
	if reference.ExecutionID == "" || reference.ExecutionID != presented.execution {
		writeError(w, http.StatusForbidden, codeContentAccessDenied)
		return
	}

	body, err := s.store.Get(r.Context(), presented.org, reference.ContentRef)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, codeContentUnavailable)
		return
	}
	if !verifyReferenceBody(reference, body) {
		// A mismatched object is never streamed: the caller would otherwise
		// receive bytes that do not match the authorised binding.
		writeError(w, http.StatusInternalServerError, codeContentIntegrityFailed)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set(headerContentKind, string(reference.Kind))
	w.Header().Set(headerContentHash, reference.ContentHash)
	w.Header().Set(headerContentBytes, strconv.FormatInt(reference.Bytes, 10))
	w.Header().Set(headerObjectVersion, reference.ObjectVersion)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// writeResolveError maps a typed registry failure to an enumeration code.
// Missing, foreign and tombstoned references are deliberately one answer so a
// tombstone cannot be used to probe for old content.
func writeResolveError(w http.ResponseWriter, err error) {
	if errors.Is(err, contentref.ErrNotFound) {
		writeError(w, http.StatusNotFound, codeContentReferenceNotFound)
		return
	}
	var contentErr *contentref.Error
	if errors.As(err, &contentErr) && contentErr.Code == "invalid_request" {
		writeError(w, http.StatusUnprocessableEntity, codeInvalidRequest)
		return
	}
	writeError(w, http.StatusServiceUnavailable, codeContentReferenceUnavailable)
}

// readCredential extracts the four credential headers. A missing, duplicated
// or malformed credential is a 401: the caller has not presented a usable
// identity, and the proxy deliberately does not say which part was wrong.
func readCredential(r *http.Request) (credential, bool) {
	authorization, ok := singleHeader(r, HeaderAuthorization)
	if !ok {
		return credential{}, false
	}
	scheme, token, ok := strings.Cut(authorization, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return credential{}, false
	}
	token = strings.TrimSpace(token)
	if !validToken(token) {
		return credential{}, false
	}

	org, ok := singleHeader(r, HeaderOrg)
	if !ok || !validOrg(org) {
		return credential{}, false
	}
	execution, ok := singleHeader(r, HeaderExecution)
	if !ok || !uuidPattern.MatchString(execution) {
		return credential{}, false
	}
	rawGeneration, ok := singleHeader(r, HeaderGeneration)
	if !ok || !generationPattern.MatchString(rawGeneration) {
		return credential{}, false
	}
	generation, err := strconv.Atoi(rawGeneration)
	if err != nil || generation < 1 {
		return credential{}, false
	}
	return credential{org: org, execution: execution, generation: generation, token: token}, true
}

// singleHeader returns a header only when exactly one value was sent. A
// repeated Authorization/org/execution header is ambiguous and refused.
func singleHeader(r *http.Request, name string) (string, bool) {
	values := r.Header.Values(name)
	if len(values) != 1 {
		return "", false
	}
	value := strings.TrimSpace(values[0])
	if value == "" {
		return "", false
	}
	return value, true
}

func validToken(token string) bool {
	if len(token) < 16 || len(token) > 512 {
		return false
	}
	return !strings.ContainsFunc(token, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	})
}

func validOrg(org string) bool {
	if org == "" || len(org) > 128 || strings.TrimSpace(org) != org {
		return false
	}
	return !strings.ContainsFunc(org, func(r rune) bool {
		return unicode.IsControl(r)
	})
}

func hashBytes(body []byte) string {
	digest := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(digest[:])
}

// verifyReferenceBody checks the stored object against the binding. Canonical
// documents carry a domain-prefixed hash, so the plain body digest must not be
// used for those kinds.
func verifyReferenceBody(reference contentref.Reference, body []byte) bool {
	if int64(len(body)) != reference.Bytes {
		return false
	}
	if reference.Kind == contentref.KindModelRequest {
		documentHash, err := canonical.HashDocumentBytes(body)
		return err == nil && documentHash == reference.ContentHash
	}
	return hashBytes(body) == reference.ContentHash
}
