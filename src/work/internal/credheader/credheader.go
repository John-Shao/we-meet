// Package credheader parses the four credential headers presented to the
// internal content-proxy and egress services.
//
// The two services authorised callers independently, with a copy of the same
// parser in each. That made the auth surface drift-prone: a fix applied to one
// copy (a length bound, a header-duplication rule) would silently leave the
// other accepting the old shape. The rules live here once.
package credheader

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

const (
	HeaderAuthorization = "Authorization"     // "Bearer <opaque token>"
	HeaderOrg           = "X-Work-Org"        // organization id
	HeaderExecution     = "X-Work-Execution"  // runtime execution uuid
	HeaderGeneration    = "X-Work-Generation" // capability generation
)

var (
	uuidPattern       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	generationPattern = regexp.MustCompile(`^[1-9][0-9]{0,8}$`)
)

// Credential is the identity a caller presents through the four headers.
type Credential struct {
	Org        string
	Execution  string
	Generation int
	Token      string
}

// Read extracts the four credential headers. A missing, duplicated or
// malformed credential is a 401: the caller has not presented a usable
// identity, and the services deliberately do not say which part was wrong.
func Read(r *http.Request) (Credential, bool) {
	authorization, ok := singleHeader(r, HeaderAuthorization)
	if !ok {
		return Credential{}, false
	}
	scheme, token, ok := strings.Cut(authorization, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return Credential{}, false
	}
	token = strings.TrimSpace(token)
	if !validToken(token) {
		return Credential{}, false
	}

	org, ok := singleHeader(r, HeaderOrg)
	if !ok || !validOrg(org) {
		return Credential{}, false
	}
	execution, ok := singleHeader(r, HeaderExecution)
	if !ok || !uuidPattern.MatchString(execution) {
		return Credential{}, false
	}
	rawGeneration, ok := singleHeader(r, HeaderGeneration)
	if !ok || !generationPattern.MatchString(rawGeneration) {
		return Credential{}, false
	}
	generation, err := strconv.Atoi(rawGeneration)
	if err != nil || generation < 1 {
		return Credential{}, false
	}
	return Credential{Org: org, Execution: execution, Generation: generation, Token: token}, true
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
