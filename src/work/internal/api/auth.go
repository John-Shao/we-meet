package api

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/we-meet/work/internal/apierr"
	"github.com/we-meet/work/internal/host"
)

// authenticate resolves the Host session for every /work/v1 request. It writes
// the public error and returns false when the request must stop.
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (host.Claims, string, bool) {
	correlationID := strings.TrimSpace(r.Header.Get("X-Correlation-ID"))
	if correlationID == "" {
		correlationID = newCorrelationID()
	}
	w.Header().Set("X-Correlation-ID", correlationID)
	w.Header().Set("Cache-Control", "no-store")

	cookie, ok := sessionCookie(r)
	if !ok {
		writeAPIError(w, correlationID, apierr.New("unauthorized"))
		return host.Claims{}, correlationID, false
	}
	claims, err := s.verifier.VerifySession(r.Context(), cookie, correlationID)
	if err != nil {
		apiError := hostFailure(err)
		if apiError.Code == "service_degraded" {
			s.logInternal(correlationID, apiError)
		}
		writeAPIError(w, correlationID, apiError)
		return host.Claims{}, correlationID, false
	}
	return claims, correlationID, true
}

// verifyCSRF enforces the frozen double-submit contract: the token must be in
// the work_csrf cookie, repeated in X-CSRF-Token, and valid for this session.
func (s *Server) verifyCSRF(w http.ResponseWriter, r *http.Request, claims host.Claims, correlationID string) bool {
	cookie, err := r.Cookie(CSRFCookieName)
	header := strings.TrimSpace(r.Header.Get(CSRFHeaderName))
	if err != nil || cookie.Value == "" || header == "" ||
		subtle.ConstantTimeCompare([]byte(header), []byte(cookie.Value)) != 1 {
		writeAPIError(w, correlationID, apierr.New("csrf_invalid"))
		return false
	}
	if err := s.csrf.Verify(header, claims.SubjectID, claims.OrgID, claims.SessionRevision); err != nil {
		writeAPIError(w, correlationID, apierr.New("csrf_invalid"))
		return false
	}
	return true
}
