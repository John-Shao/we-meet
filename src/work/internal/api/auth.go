package api

import (
	"crypto/subtle"
	"net/http"
	"regexp"
	"strings"

	"github.com/we-meet/work/internal/apierr"
	"github.com/we-meet/work/internal/host"
)

// correlationIDPattern is the only shape a client-supplied correlation ID may
// take. The value is echoed into the response header, every error envelope and
// the server log, so anything outside this closed set - CR/LF above all - would
// let a caller forge or split log lines. A rejected or absent value is replaced
// by a server-minted random ID rather than being partially sanitised, so the
// caller can never choose what appears in the logs.
var correlationIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// correlationIDFor returns the client's correlation ID when it satisfies
// correlationIDPattern, and a freshly minted random ID otherwise.
func correlationIDFor(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if !correlationIDPattern.MatchString(trimmed) {
		return newCorrelationID()
	}
	return trimmed
}

// authenticate resolves the Host session for every /work/v1 request. It writes
// the public error and returns false when the request must stop.
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (host.Claims, string, bool) {
	correlationID := correlationIDFor(r.Header.Get("X-Correlation-ID"))
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
