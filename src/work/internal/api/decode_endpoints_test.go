package api_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/we-meet/work/internal/api"
)

// TestShippedWriteEndpointsRejectTrailingJSON covers the three endpoints that were
// already live with DisallowUnknownFields but no trailing guard. Each pair asserts both
// halves: the trailing body must hit the decode guard, and the same body on its own must
// get past it. Without the second half a handler that rejects everything would pass.
func TestShippedWriteEndpointsRejectTrailingJSON(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)

	cases := []struct {
		name  string
		url   string
		code  string
		clean string
	}{
		{
			name:  "cancel run",
			url:   "/work/v1/runs/" + runA + "/cancel",
			code:  "invalid_request",
			clean: `{}`,
		},
		{
			name:  "retry task",
			url:   "/work/v1/tasks/" + taskA + "/runs",
			code:  "invalid_request",
			clean: `{"client_request_id":"retry-trail-01","expected_revision":1}`,
		},
		{
			name:  "revoke provider config",
			url:   api.AdminProviderConfigRevokePath,
			code:  "invalid_request",
			clean: `{"reason":"切换供应商"}`,
		},
	}

	for _, item := range cases {
		response := taskRequest(t, http.MethodPost, server.URL+item.url, csrf, item.clean+` {}`)
		assertAPICode(t, response, http.StatusBadRequest, item.code)

		response = taskRequest(t, http.MethodPost, server.URL+item.url, csrf, item.clean)
		defer response.Body.Close()
		var payload struct {
			Code string `json:"code"`
		}
		_ = json.NewDecoder(response.Body).Decode(&payload)
		if response.StatusCode == http.StatusBadRequest && payload.Code == item.code {
			t.Fatalf("%s: a lone clean object was refused by the trailing guard (code %s)",
				item.name, payload.Code)
		}
	}
}
