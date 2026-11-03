package api_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestMaxActiveRunsAdvertisementMatchesEnforcement(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	response := doBootstrap(t, server.URL, "session-value", "corr-mar")
	defer response.Body.Close()
	var boot map[string]any
	if err := json.NewDecoder(response.Body).Decode(&boot); err != nil {
		t.Fatal(err)
	}
	limits, _ := boot["limits"].(map[string]any)
	if limits == nil {
		t.Fatal("missing limits in bootstrap response")
	}
	advertised, ok := limits["max_active_runs"].(float64)
	if !ok {
		t.Fatal("max_active_runs not numeric")
	}
	if int(advertised) != 1 {
		t.Fatalf("advertised max_active_runs = %v, want 1", advertised)
	}

	csrf := boot["csrf_token"].(string)

	// Enforcement check 1: a task that already has an active run is refused.
	// seedTaskGraph gives Task A (activeTaskID) an active run.
	const target = `"target":{"kind":"cloud","profile":"text-v1"}`
	if status, body := retryCall(t, server.URL, csrf, activeTaskID,
		`{"client_request_id":"mar-per-task-001","expected_revision":1,`+target+`}`,
	); status != http.StatusConflict || body["code"] != "task_has_active_run" {
		t.Fatalf("second run on same task = %d %#v; want 409 task_has_active_run", status, body)
	}

	// Enforcement check 2: org-wide concurrency proves max_active_runs is per-task, not org-wide.
	// seedTaskGraph puts active runs on BOTH Task A and Task C (both in org_a),
	// so org_a already has 2 concurrent active runs — exceeding the advertised 1.
	activeCount := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.run
		 WHERE org_id = 'org_a' AND state IN ('active','queued','waiting')`)
	if activeCount != "2" {
		t.Fatalf("org_a concurrent active runs = %s, want 2 (proves per-task, not per-org limit)", activeCount)
	}

	// Pin the interpretation: the advertised value describes the per-task constraint
	// (active_run_id IS NOT NULL → task_has_active_run), not an org-wide cap.
	// If enforcement ever changes to an org-wide limit, this test catches the divergence.
	t.Logf("bootstrap advertises max_active_runs=%d; enforcement is per-task "+
		"(org_a holds %s active runs across Task A + Task C)", int(advertised), activeCount)
}
