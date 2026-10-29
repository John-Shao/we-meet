package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

const (
	taskA = "11111111-1111-4111-8111-111111111111"
	runA  = "21111111-1111-4111-8111-111111111111"
	taskB = "11111111-1111-4111-8111-222222222222"
	taskC = "11111111-1111-4111-8111-333333333333"
	runC  = "21111111-1111-4111-8111-333333333333"
	taskD = "11111111-1111-4111-8111-444444444444"
	runD  = "21111111-1111-4111-8111-444444444444"

	otherSubject = "sub_other"
	otherOrg     = "org_other"
)

func TestListTasksProjectsOwnTasksAndViews(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	body := getTasks(t, server.URL, "?limit=10")
	if len(body.Items) != 2 {
		t.Fatalf("items = %#v", body.Items)
	}
	byID := map[string]api.TaskSummary{}
	for _, item := range body.Items {
		byID[item.TaskID] = item
	}
	a, ok := byID[taskA]
	if !ok || a.DisplayState != "running" || a.LatestRun == nil || a.LatestRun.RunID != runA {
		t.Fatalf("task A = %#v", a)
	}
	b, ok := byID[taskB]
	if !ok || b.DisplayState != "open" || b.LatestRun != nil {
		t.Fatalf("task B = %#v", b)
	}
	for _, hidden := range []string{taskC, taskD} {
		if _, ok := byID[hidden]; ok {
			t.Fatalf("task %s leaked into list", hidden)
		}
	}

	if got := getTasks(t, server.URL, "?view=pending"); len(got.Items) != 1 || got.Items[0].TaskID != taskB {
		t.Fatalf("pending = %#v", got.Items)
	}
	if got := getTasks(t, server.URL, "?view=running"); len(got.Items) != 1 || got.Items[0].TaskID != taskA {
		t.Fatalf("running = %#v", got.Items)
	}
	if got := getTasks(t, server.URL, "?view=completed"); len(got.Items) != 0 {
		t.Fatalf("completed = %#v", got.Items)
	}
}

func TestListTasksKeysetPagination(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	first := getTasks(t, server.URL, "?limit=1")
	if len(first.Items) != 1 || first.NextCursor == nil {
		t.Fatalf("first page = %#v", first)
	}
	second := getTasks(t, server.URL, "?limit=1&cursor="+*first.NextCursor)
	if len(second.Items) != 1 {
		t.Fatalf("second page = %#v", second)
	}
	if first.Items[0].TaskID == second.Items[0].TaskID {
		t.Fatal("keyset pagination repeated a task")
	}
}

func TestListTasksRejectsInvalidQuery(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, true)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	cases := []struct{ query, code string }{
		{"?view=ghost", "invalid_view"},
		{"?limit=0", "invalid_pagination"},
		{"?limit=101", "invalid_pagination"},
		{"?cursor=not-a-cursor", "invalid_pagination"},
	}
	for _, tc := range cases {
		request, err := http.NewRequest(http.MethodGet, server.URL+api.TasksPath+tc.query, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		assertAPICode(t, response, http.StatusBadRequest, tc.code)
	}
}

func TestListTasksRequiresSeat(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, true, true, false)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	request, _ := http.NewRequest(http.MethodGet, server.URL+api.TasksPath, nil)
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, response, http.StatusForbidden, "work_seat_required")
}

func TestGetRunEnforcesOwnershipAndOrganization(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	if got := getRun(t, server.URL, runA); got.RunID != runA || got.State != "active" || got.TaskID != taskA {
		t.Fatalf("run = %#v", got)
	}
	for _, hidden := range []string{runC, runD, "99999999-9999-4999-8999-999999999999"} {
		request, _ := http.NewRequest(http.MethodGet, server.URL+"/work/v1/runs/"+hidden, nil)
		request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		assertAPICode(t, response, http.StatusNotFound, "run_not_found")
	}
}

func TestCancelRunRejectsViewer(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	_, err = admin.Exec(ctx, `UPDATE work.member SET role = 'viewer' WHERE org_id = 'org_a' AND subject_id = 'sub_a'`)
	_ = admin.Close(ctx)
	if err != nil {
		t.Fatal(err)
	}
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	token := bootstrapCSRF(t, server.URL)

	response := cancelRun(t, server.URL, runA, token, true)
	assertAPICode(t, response, http.StatusForbidden, "forbidden")
	if got := runState(t, dbName, runA); got != "active" {
		t.Fatalf("viewer cancel changed state to %q", got)
	}
}

func TestCancelRunRequiresCSRFAndIsIdempotent(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	token := bootstrapCSRF(t, server.URL)

	response := cancelRun(t, server.URL, runA, token, true)
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", response.StatusCode, response.Body)
	}
	var canceled api.RunView
	_ = json.NewDecoder(response.Body).Decode(&canceled)
	response.Body.Close()
	if canceled.State != "cancel_requested" {
		t.Fatalf("run = %#v", canceled)
	}
	if got := runState(t, dbName, runA); got != "cancel_requested" {
		t.Fatalf("db state = %q", got)
	}

	replay := cancelRun(t, server.URL, runA, token, true)
	if replay.StatusCode != http.StatusAccepted {
		t.Fatalf("replay status = %d", replay.StatusCode)
	}
	replay.Body.Close()

	missing := cancelRun(t, server.URL, runA, "", false)
	assertAPICode(t, missing, http.StatusForbidden, "csrf_invalid")
	if got := runState(t, dbName, runA); got != "cancel_requested" {
		t.Fatalf("unauthenticated cancel changed state to %q", got)
	}

	other := cancelRun(t, server.URL, runC, token, true)
	assertAPICode(t, other, http.StatusNotFound, "run_not_found")
}

type taskListBody struct {
	Items      []api.TaskSummary `json:"items"`
	NextCursor *string           `json:"next_cursor"`
}

func getTasks(t *testing.T, baseURL, query string) taskListBody {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, baseURL+api.TasksPath+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var body taskListBody
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body
}

func getRun(t *testing.T, baseURL, runID string) api.RunView {
	t.Helper()
	request, _ := http.NewRequest(http.MethodGet, baseURL+fmt.Sprintf("/work/v1/runs/%s", runID), nil)
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var view api.RunView
	if err := json.NewDecoder(response.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	return view
}

func bootstrapCSRF(t *testing.T, baseURL string) string {
	t.Helper()
	request, _ := http.NewRequest(http.MethodGet, baseURL+api.BootstrapPath, nil)
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap status = %d", response.StatusCode)
	}
	var body struct {
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil || body.CSRFToken == "" {
		t.Fatalf("bootstrap csrf = %#v err=%v", body, err)
	}
	return body.CSRFToken
}

func cancelRun(t *testing.T, baseURL, runID, token string, withCookie bool) *http.Response {
	t.Helper()
	request, _ := http.NewRequest(http.MethodPost, baseURL+fmt.Sprintf("/work/v1/runs/%s/cancel", runID), nil)
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	if withCookie && token != "" {
		request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: token})
		request.Header.Set(api.CSRFHeaderName, token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func runState(t *testing.T, dbName, runID string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var state string
	if err := conn.QueryRow(ctx, `SELECT state FROM work.run WHERE id = $1`, runID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func seedTaskGraph(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES
		  ('31111111-1111-4111-8111-111111111111', 'org_a', 'sub_a', 'content://a', 'sha256:a', 10),
		  ('31111111-1111-4111-8111-222222222222', 'org_a', 'sub_a', 'content://b', 'sha256:b', 10),
		  ('31111111-1111-4111-8111-333333333333', 'org_a', 'sub_other', 'content://c', 'sha256:c', 10),
		  ('31111111-1111-4111-8111-444444444444', 'org_other', 'sub_a', 'content://d', 'sha256:d', 10);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode, title, input_id, revision)
		VALUES
		  ('11111111-1111-4111-8111-111111111111', 'org_a', 'sub_a', 'open', 'ask_each', 'Task A', '31111111-1111-4111-8111-111111111111', 0),
		  ('11111111-1111-4111-8111-222222222222', 'org_a', 'sub_a', 'open', 'ask_each', 'Task B', '31111111-1111-4111-8111-222222222222', 0),
		  ('11111111-1111-4111-8111-333333333333', 'org_a', 'sub_other', 'open', 'ask_each', 'Task C', '31111111-1111-4111-8111-333333333333', 0),
		  ('11111111-1111-4111-8111-444444444444', 'org_other', 'sub_a', 'open', 'ask_each', 'Task D', '31111111-1111-4111-8111-444444444444', 0);
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		VALUES
		  ('41111111-1111-4111-8111-111111111111', 'org_a', '11111111-1111-4111-8111-111111111111', 'test', 'sha256:a', ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
		  ('41111111-1111-4111-8111-333333333333', 'org_a', '11111111-1111-4111-8111-333333333333', 'test', 'sha256:c', ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
		  ('41111111-1111-4111-8111-444444444444', 'org_other', '11111111-1111-4111-8111-444444444444', 'test', 'sha256:d', ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES
		  ('21111111-1111-4111-8111-111111111111', 'org_a', '11111111-1111-4111-8111-111111111111', 1, 'active', '41111111-1111-4111-8111-111111111111', 'wf-a', 'test'),
		  ('21111111-1111-4111-8111-333333333333', 'org_a', '11111111-1111-4111-8111-333333333333', 1, 'active', '41111111-1111-4111-8111-333333333333', 'wf-c', 'test');
		SELECT set_config('app.org_id', 'org_other', false);
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('21111111-1111-4111-8111-444444444444', 'org_other', '11111111-1111-4111-8111-444444444444', 1, 'active', '41111111-1111-4111-8111-444444444444', 'wf-d', 'test');
		UPDATE work.task SET active_run_id = '21111111-1111-4111-8111-111111111111',
		  latest_run_id = '21111111-1111-4111-8111-111111111111', revision = 1
		WHERE id = '11111111-1111-4111-8111-111111111111';
		UPDATE work.task SET active_run_id = '21111111-1111-4111-8111-333333333333',
		  latest_run_id = '21111111-1111-4111-8111-333333333333', revision = 1
		WHERE id = '11111111-1111-4111-8111-333333333333';
		UPDATE work.task SET active_run_id = '21111111-1111-4111-8111-444444444444',
		  latest_run_id = '21111111-1111-4111-8111-444444444444', revision = 1
		WHERE id = '11111111-1111-4111-8111-444444444444';
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

func assertAPICode(t *testing.T, response *http.Response, status int, code string) {
	t.Helper()
	defer response.Body.Close()
	if response.StatusCode != status {
		t.Fatalf("status = %d, want %d", response.StatusCode, status)
	}
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Code != code {
		t.Fatalf("code = %q, want %q", payload.Code, code)
	}
}
