package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

type previewReply struct {
	PreviewHash     string       `json:"preview_hash"`
	ExpiresAt       string       `json:"expires_at"`
	TokenUpperBound int64        `json:"token_upper_bound"`
	Template        api.Template `json:"template"`
	InputRef        string       `json:"input_ref"`
	InputHash       string       `json:"input_hash"`
	InputBytes      int64        `json:"input_bytes"`
}

type submitReply struct {
	TaskID       string `json:"task_id"`
	RunID        string `json:"run_id"`
	Revision     int64  `json:"revision"`
	TaskState    string `json:"task_state"`
	DisplayState string `json:"display_state"`
	InputRef     string `json:"input_ref"`
}

func TestTemplatesPreviewAndSubmit(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	server := newHTTPServerWithContent(t, pool, newTestContentStore(t))
	token := bootstrapCSRF(t, server.URL)

	templates := getTemplates(t, server.URL)
	if len(templates) != 3 {
		t.Fatalf("templates = %#v", templates)
	}

	created := postInput(t, server.URL, token,
		`{"client_request_id":"submit-input-0001","goal":"写一份上线计划","background":"需要包含风险和回滚"}`)
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("input status = %d", created.StatusCode)
	}
	var input inputReply
	_ = json.NewDecoder(created.Body).Decode(&input)
	created.Body.Close()
	preview := postPreview(t, server.URL, token, input.InputRef, "summary", "ask_each")
	if preview.Template.ID != "summary" || preview.TokenUpperBound != 100000 || preview.PreviewHash == "" {
		t.Fatalf("preview = %#v", preview)
	}
	if preview.InputHash != input.ContentHash || preview.InputBytes != input.Bytes {
		t.Fatalf("preview input = %#v", preview)
	}

	body := submitBody("submit-request-0001", input.InputRef, "summary", "ask_each", preview.PreviewHash)
	submitted := postSubmit(t, server.URL, token, body)
	if submitted.StatusCode != http.StatusAccepted {
		t.Fatalf("submit status = %d", submitted.StatusCode)
	}
	var task submitReply
	_ = json.NewDecoder(submitted.Body).Decode(&task)
	submitted.Body.Close()
	if task.TaskID == "" || task.RunID == "" || task.TaskState != "open" || task.DisplayState != "queued" {
		t.Fatalf("task = %#v", task)
	}
	assertTaskRun(t, dbName, task.TaskID, task.RunID)
	if kind := taskOutboxKind(t, dbName, task.TaskID); kind != "task_event" {
		t.Fatalf("task outbox kind = %q", kind)
	}

	replay := postSubmit(t, server.URL, token, body)
	if replay.StatusCode != http.StatusAccepted {
		t.Fatalf("replay status = %d", replay.StatusCode)
	}
	var replayed submitReply
	_ = json.NewDecoder(replay.Body).Decode(&replayed)
	replay.Body.Close()
	if replayed.TaskID != task.TaskID || replayed.RunID != task.RunID {
		t.Fatalf("replay = %#v", replayed)
	}
}

func TestPreviewRejectsUnavailableModeAndSubmitRejectsStalePreview(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, true)
	server := newHTTPServerWithContent(t, pool, newTestContentStore(t))
	token := bootstrapCSRF(t, server.URL)
	created := postInput(t, server.URL, token,
		`{"client_request_id":"submit-input-0002","goal":"target"}`)
	var input inputReply
	_ = json.NewDecoder(created.Body).Decode(&input)
	created.Body.Close()

	request, _ := http.NewRequest(http.MethodPost, server.URL+api.TaskPreviewsPath,
		strings.NewReader(fmt.Sprintf(`{"input_ref":%q,"template_id":"summary","permission_mode":"plan_then_run"}`, input.InputRef)))
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: token})
	request.Header.Set(api.CSRFHeaderName, token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, response, http.StatusUnprocessableEntity, "permission_mode_unavailable")

	preview := postPreview(t, server.URL, token, input.InputRef, "summary", "ask_each")
	stale := strings.TrimSuffix(preview.PreviewHash, "x") + "x"
	submitted := postSubmit(t, server.URL, token,
		submitBody("submit-request-0002", input.InputRef, "summary", "ask_each", stale))
	assertAPICode(t, submitted, http.StatusConflict, "preview_stale")
}

func getTemplates(t *testing.T, baseURL string) []api.Template {
	t.Helper()
	request, _ := http.NewRequest(http.MethodGet, baseURL+api.TemplatesPath, nil)
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("templates status = %d", response.StatusCode)
	}
	var body struct {
		Items []api.Template `json:"items"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Items
}

func postPreview(t *testing.T, baseURL, token, inputRef, templateID, mode string) previewReply {
	t.Helper()
	body := fmt.Sprintf(`{"input_ref":%q,"template_id":%q,"permission_mode":%q}`, inputRef, templateID, mode)
	request, _ := http.NewRequest(http.MethodPost, baseURL+api.TaskPreviewsPath, strings.NewReader(body))
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: token})
	request.Header.Set(api.CSRFHeaderName, token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("preview status = %d", response.StatusCode)
	}
	var reply previewReply
	if err := json.NewDecoder(response.Body).Decode(&reply); err != nil {
		t.Fatal(err)
	}
	return reply
}

func submitBody(clientID, inputRef, templateID, mode, previewHash string) string {
	return fmt.Sprintf(`{"client_request_id":%q,"input_ref":%q,"template_id":%q,"permission_mode":%q,"preview_hash":%q}`,
		clientID, inputRef, templateID, mode, previewHash)
}

func postSubmit(t *testing.T, baseURL, token, body string) *http.Response {
	t.Helper()
	request, _ := http.NewRequest(http.MethodPost, baseURL+api.TasksPath, strings.NewReader(body))
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: token})
	request.Header.Set(api.CSRFHeaderName, token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func assertTaskRun(t *testing.T, dbName, taskID, runID string) {
	t.Helper()
	conn, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var taskState, runState, owner, workflowID, outboxWorkflowID string
	if err := conn.QueryRow(context.Background(), `
		SELECT t.state, r.state, t.owner_subject_id, r.workflow_id, o.payload->>'workflow_id'
		FROM work.task t
		JOIN work.run r ON r.task_id = t.id AND r.org_id = t.org_id
		JOIN work.outbox o ON o.aggregate_type = 'run' AND o.aggregate_id = r.id
		  AND o.payload->>'kind' = 'start_workflow'
		WHERE t.id = $1 AND r.id = $2`, taskID, runID,
	).Scan(&taskState, &runState, &owner, &workflowID, &outboxWorkflowID); err != nil {
		t.Fatal(err)
	}
	if taskState != "open" || runState != "queued" || owner != "sub_a" {
		t.Fatalf("task=%s run=%s owner=%s", taskState, runState, owner)
	}
	if workflowID != "run:"+runID || outboxWorkflowID != workflowID {
		t.Fatalf("workflow_id=%q outbox=%q", workflowID, outboxWorkflowID)
	}
}
