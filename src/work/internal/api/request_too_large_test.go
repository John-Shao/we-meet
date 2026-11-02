package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
)

// TestShippedWriteEndpointsAnswer413ForAnOversizedBody pins the split that decision 3 of
// round 23 made: a body the server refused to read to the end is 413 request_too_large,
// while a body it read and could not parse stays 400 invalid_request. Both halves are
// asserted per endpoint, because a handler that answered 413 for everything would satisfy
// the first half alone - and before this change every one of these answered 400 for both,
// which told a client to fix a request it had no way to fix by editing it.
func TestShippedWriteEndpointsAnswer413ForAnOversizedBody(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)

	oversized := func(field string) string {
		return `{"` + field + `":"` + strings.Repeat("a", (64<<10)+1) + `"}`
	}
	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"preview", http.MethodPost, api.TaskPreviewsPath, oversized("input_ref")},
		{"local policy", http.MethodPatch, api.AdminLocalPolicyPath, oversized("classification_default")},
		{"governance cursor", http.MethodPost, api.AdminGovernanceEventCursorPath, oversized("ticket_id")},
	}

	for _, item := range cases {
		assertAPICode(t, taskRequest(t, item.method, server.URL+item.path, csrf, item.body),
			http.StatusRequestEntityTooLarge, "request_too_large")
		// The same endpoint still answers 400 for a body it did read: an unknown member
		// is a malformed request, not a large one.
		assertAPICode(t, taskRequest(t, item.method, server.URL+item.path, csrf,
			`{"not_a_field":1}`), http.StatusBadRequest, "invalid_request")
	}
}
