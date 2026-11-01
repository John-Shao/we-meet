package api_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/host"
)

func retryCall(t *testing.T, serverURL, csrf, taskID, body string) (int, map[string]any) {
	t.Helper()
	request, err := http.NewRequest(
		http.MethodPost, serverURL+"/work/v1/tasks/"+taskID+"/runs", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
	request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: csrf})
	request.Header.Set("X-CSRF-Token", csrf)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(response.Body)
	var out map[string]any
	if len(payload) > 0 {
		_ = json.Unmarshal(payload, &out)
	}
	return response.StatusCode, out
}

func workspaceCSRF(t *testing.T, serverURL string) string {
	t.Helper()
	response := doBootstrap(t, serverURL, "session-value", "corr-retry")
	defer response.Body.Close()
	var boot map[string]any
	if err := json.NewDecoder(response.Body).Decode(&boot); err != nil {
		t.Fatal(err)
	}
	token, _ := boot["csrf_token"].(string)
	if token == "" {
		t.Fatal("missing csrf token")
	}
	return token
}

func TestRetryTaskValidationAndGuards(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)

	const target = `"target":{"kind":"cloud","profile":"text-v1"}`

	// Body validation happens before the domain function is called.
	if status, body := retryCall(t, server.URL, csrf, activeTaskID,
		`{`+target+`}`); status != http.StatusBadRequest || body["code"] != "invalid_request" {
		t.Fatalf("missing client_request_id = %d %#v", status, body)
	}
	if status, body := retryCall(t, server.URL, csrf, activeTaskID,
		`{"client_request_id":"retry-0001","expected_revision":9`+
			`,"target":{"kind":"local","profile":"text-v1"}}`); status != http.StatusUnprocessableEntity ||
		body["code"] != "execution_target_unavailable" {
		t.Fatalf("non-cloud target = %d %#v", status, body)
	}
	if status, body := retryCall(t, server.URL, csrf, "not-a-uuid",
		`{"client_request_id":"retry-0002","expected_revision":1,`+target+`}`); status != http.StatusNotFound ||
		body["code"] != "task_not_found" {
		t.Fatalf("bad task id = %d %#v", status, body)
	}
	// Task A owns an active run: the domain function refuses with its own public code
	// rather than starting a second concurrent execution.
	if status, body := retryCall(t, server.URL, csrf, activeTaskID,
		`{"client_request_id":"retry-0003","expected_revision":1,`+target+`}`); status != http.StatusConflict {
		t.Fatalf("active run retry status = %d %#v", status, body)
	} else if body["code"] != "task_has_active_run" && body["code"] != "version_conflict" {
		t.Fatalf("active run retry code = %#v", body)
	}
	// A missing CSRF header must not reach the domain function.
	request, err := http.NewRequest(http.MethodPost,
		server.URL+"/work/v1/tasks/"+activeTaskID+"/runs",
		strings.NewReader(`{"client_request_id":"retry-0004","expected_revision":1,`+target+`}`))
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("no csrf status = %d", response.StatusCode)
	}
}
