package api_test

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

const (
	quietTaskID   = "11111111-1111-4111-8111-222222222222"
	activeTaskID  = "11111111-1111-4111-8111-111111111111"
	foreignTaskID = "11111111-1111-4111-8111-333333333333"
)

func deleteCode(t *testing.T, serverURL, csrf, taskID, revision string) (int, map[string]any) {
	t.Helper()
	path := "/work/v1/tasks/" + taskID + "?expected_revision=" + revision
	response := taskRequest(t, http.MethodDelete, serverURL+path, csrf, "")
	defer response.Body.Close()
	payload, _ := io.ReadAll(response.Body)
	var body map[string]any
	if len(payload) > 0 {
		_ = json.Unmarshal(payload, &body)
	}
	return response.StatusCode, body
}

func TestDeleteTaskContract(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	bootstrap := doBootstrap(t, server.URL, "session-value", "corr-delete")
	defer bootstrap.Body.Close()
	var boot map[string]any
	if err := json.NewDecoder(bootstrap.Body).Decode(&boot); err != nil {
		t.Fatal(err)
	}
	csrf, _ := boot["csrf_token"].(string)
	if csrf == "" {
		t.Fatal("missing csrf token")
	}

	if status, body := deleteCode(t, server.URL, csrf, activeTaskID, "1"); status != http.StatusConflict ||
		body["code"] != "run_not_quiescent" {
		t.Fatalf("non-quiescent delete = %d %#v", status, body)
	}
	if status, body := deleteCode(t, server.URL, csrf, quietTaskID, "5"); status != http.StatusConflict ||
		body["code"] != "version_conflict" || body["current_revision"] != float64(0) {
		t.Fatalf("stale revision delete = %d %#v", status, body)
	}
	if status, body := deleteCode(t, server.URL, csrf, foreignTaskID, "1"); status != http.StatusNotFound ||
		body["code"] != "task_not_found" {
		t.Fatalf("foreign owner delete = %d %#v", status, body)
	}
	if status, body := deleteCode(t, server.URL, csrf, quietTaskID, ""); status != http.StatusBadRequest ||
		body["code"] != "invalid_request" {
		t.Fatalf("missing revision delete = %d %#v", status, body)
	}

	status, body := deleteCode(t, server.URL, csrf, quietTaskID, "0")
	if status != http.StatusOK {
		t.Fatalf("delete status = %d body=%#v", status, body)
	}
	if len(body) != 3 {
		t.Fatalf("delete payload keys = %#v", body)
	}
	if body["task_id"] != quietTaskID || body["content_purge"] != "scheduled" {
		t.Fatalf("delete body = %#v", body)
	}
	if stamp, _ := body["deleted_at"].(string); stamp == "" {
		t.Fatalf("deleted_at missing: %#v", body)
	}

	// Repeating the delete stays 200 and skips the revision check.
	if again, _ := deleteCode(t, server.URL, csrf, quietTaskID, "999"); again != http.StatusOK {
		t.Fatalf("idempotent delete status = %d", again)
	}
}
