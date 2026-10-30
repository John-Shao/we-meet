package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/api"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/testpg"
)

func TestGetTaskReturnsOwnedDetail(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServerWithContent(t, pool, newTestContentStore(t))
	token := bootstrapCSRF(t, server.URL)
	created := createTaskForTest(t, server.URL, token, "detail-input-0001", "写一份上线计划", "需要包含风险和回滚")

	response := taskRequest(t, http.MethodGet, server.URL+"/work/v1/tasks/"+created.TaskID, "", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("detail status = %d body=%s", response.StatusCode, readBody(response))
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	assertExactKeys(t, raw, "summary", "input_ref", "goal", "background", "template", "snapshot", "latest_event_id")
	var rawSummary map[string]json.RawMessage
	if err := json.Unmarshal(raw["summary"], &rawSummary); err != nil {
		t.Fatal(err)
	}
	assertExactKeys(t, rawSummary, "task_id", "title", "display_state", "task_state", "permission_mode",
		"active_run_id", "latest_run_id", "latest_run", "latest_artifact", "revision",
		"pending_acceptance", "blocking_operations", "quota", "created_at", "updated_at")
	var rawRun map[string]json.RawMessage
	if err := json.Unmarshal(rawSummary["latest_run"], &rawRun); err != nil {
		t.Fatal(err)
	}
	assertExactKeys(t, rawRun, "id", "task_id", "attempt_no", "state", "wait_reason", "terminal_reason",
		"control_revision", "runtime_version", "created_at", "updated_at")
	var detail api.TaskDetail
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Summary.TaskID != created.TaskID || detail.Summary.Revision != 1 ||
		detail.Summary.PermissionMode != "ask_each" || detail.Summary.LatestRun == nil ||
		detail.Summary.LatestRun.ID != created.RunID || detail.Summary.LatestRun.State != "queued" ||
		detail.Summary.ActiveRunID == nil || *detail.Summary.ActiveRunID != created.RunID {
		t.Fatalf("summary = %#v", detail.Summary)
	}
	if detail.InputRef != created.InputRef || detail.Goal != "写一份上线计划" ||
		detail.Background == nil || *detail.Background != "需要包含风险和回滚" {
		t.Fatalf("input = %#v", detail)
	}
	if detail.Template == nil || detail.Template.ID != "summary" || detail.Template.ContentHash == "" {
		t.Fatalf("template = %#v", detail.Template)
	}
	if detail.Snapshot == nil || detail.Snapshot.SnapshotID == "" ||
		detail.Snapshot.SnapshotRevision != 1 ||
		detail.Snapshot.Template.ID != "summary" || detail.Snapshot.Template.ContentHash == "" ||
		detail.Snapshot.Limits.TokenUpperBound <= 0 ||
		detail.Snapshot.PermissionMode != "ask_each" || detail.Snapshot.CreatedAt.IsZero() {
		t.Fatalf("snapshot = %#v", detail.Snapshot)
	}
	if detail.LatestEventID == nil || *detail.LatestEventID == "" {
		t.Fatal("latest_event_id is missing")
	}

	for _, hidden := range []string{taskC, taskD, "99999999-9999-4999-8999-999999999999"} {
		hiddenResponse := taskRequest(t, http.MethodGet, server.URL+"/work/v1/tasks/"+hidden, "", "")
		assertAPICode(t, hiddenResponse, http.StatusNotFound, "task_not_found")
	}
	missing := taskRequest(t, http.MethodGet, server.URL+"/work/v1/tasks/"+created.TaskID, "", "")
	if missing.StatusCode != http.StatusOK {
		t.Fatalf("detail without csrf status = %d", missing.StatusCode)
	}
	missing.Body.Close()
}

func TestGetTaskKeepsSummaryAndCursorOnSameSnapshot(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	ctx, cancel := context.WithCancel(testContext(t))
	defer cancel()
	store := newTestContentStore(t)
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)
	created := createTaskForTest(t, server.URL, token, "snapshot-input-0001", "Snapshot goal", "")
	url := server.URL + "/work/v1/tasks/" + created.TaskID
	readDetail := func() api.TaskDetail {
		t.Helper()
		response := taskRequest(t, http.MethodGet, url, "", "")
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("detail status = %d body=%s", response.StatusCode, readBody(response))
		}
		var detail api.TaskDetail
		if err := json.NewDecoder(response.Body).Decode(&detail); err != nil {
			t.Fatal(err)
		}
		return detail
	}
	before := readDetail()
	if before.LatestEventID == nil || before.Summary.Revision != 1 ||
		before.Summary.LatestRun == nil || before.Summary.LatestRun.State != "queued" {
		t.Fatalf("initial detail = %#v", before)
	}

	// Commit state and events between the handler's summary and cursor reads.
	pause := &taskDetailCursorPause{reached: make(chan struct{}), resume: make(chan struct{})}
	config := pool.Config()
	config.ConnConfig.Tracer = pause
	readerPool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(readerPool.Close)
	readerServer := newHTTPServerWithContent(t, readerPool, store)
	writerPool, err := workdb.OpenPool(ctx, testpg.WorkerURL(dbName), "work-snapshot-writer-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writerPool.Close)

	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		readerServer.URL+"/work/v1/tasks/"+created.TaskID, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	type detailResult struct {
		detail api.TaskDetail
		err    error
	}
	result := make(chan detailResult, 1)
	go func() {
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			result <- detailResult{err: err}
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			result <- detailResult{err: fmt.Errorf("detail status = %d body=%s", response.StatusCode, readBody(response))}
			return
		}
		var detail api.TaskDetail
		err = json.NewDecoder(response.Body).Decode(&detail)
		result <- detailResult{detail: detail, err: err}
	}()
	select {
	case <-pause.reached:
	case got := <-result:
		t.Fatalf("detail returned before cursor barrier: %v", got.err)
	case <-ctx.Done():
		t.Fatalf("waiting for cursor barrier: %v", ctx.Err())
	}

	var committedEventID string
	err = workdb.WithWorkerOrgContext(ctx, writerPool, testOrg, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT work.acquire_run($1, $2)`, created.RunID, testOrg); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT work.finish_run($1, $2, 'succeeded', NULL)`, created.RunID, testOrg); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `
			SELECT id FROM work.task_event WHERE task_id = $1 AND org_id = $2
			ORDER BY seq DESC LIMIT 1`, created.TaskID, testOrg).Scan(&committedEventID)
	})
	if err != nil {
		t.Fatal(err)
	}
	if committedEventID == *before.LatestEventID {
		t.Fatal("writer did not append a new event")
	}
	close(pause.resume)

	var during api.TaskDetail
	select {
	case got := <-result:
		if got.err != nil {
			t.Fatal(got.err)
		}
		during = got.detail
	case <-ctx.Done():
		t.Fatalf("waiting for paused detail: %v", ctx.Err())
	}
	if !reflect.DeepEqual(during.Summary, before.Summary) {
		t.Fatalf("paused summary = %#v, want %#v", during.Summary, before.Summary)
	}
	if during.LatestEventID == nil || *during.LatestEventID != *before.LatestEventID {
		t.Fatalf("cursor advanced beyond the snapshot: got %v, want %s (concurrent event %s)",
			during.LatestEventID, *before.LatestEventID, committedEventID)
	}

	after := readDetail()
	if after.Summary.TaskState != "awaiting_acceptance" || after.Summary.Revision != 2 ||
		after.Summary.ActiveRunID != nil || after.Summary.LatestRun == nil ||
		after.Summary.LatestRun.State != "succeeded" || after.LatestEventID == nil ||
		*after.LatestEventID != committedEventID {
		t.Fatalf("post-commit detail = %#v", after)
	}
	// Both events remain after the response's cursor and are available for replay.
	err = workdb.WithWorkContext(ctx, pool,
		workdb.Identity{OrgID: testOrg, SubjectID: testSubject}, workdb.RoleAPI,
		workdb.Options{ReadOnly: true}, func(tx pgx.Tx) error {
			var count int
			if err := tx.QueryRow(ctx, `
				SELECT count(*) FROM work.task_event
				WHERE task_id = $1 AND org_id = $2
				  AND seq > (SELECT seq FROM work.task_event WHERE id = $3 AND task_id = $1 AND org_id = $2)
				  AND type IN ('run.succeeded', 'task.awaiting_acceptance')`,
				created.TaskID, testOrg, *during.LatestEventID).Scan(&count); err != nil {
				return err
			}
			if count != 2 {
				return fmt.Errorf("replayable completion events = %d, want 2", count)
			}
			return nil
		})
	if err != nil {
		t.Fatal(err)
	}
}

type taskDetailCursorPause struct {
	once    sync.Once
	reached chan struct{}
	resume  chan struct{}
}

func (p *taskDetailCursorPause) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(strings.Join(strings.Fields(data.SQL), " "), "SELECT id FROM work.task_event") {
		p.once.Do(func() {
			close(p.reached)
			select {
			case <-p.resume:
			case <-ctx.Done():
			}
		})
	}
	return ctx
}

func (*taskDetailCursorPause) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestUpdateTaskTitleIdempotencyAndConflicts(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServerWithContent(t, pool, newTestContentStore(t))
	token := bootstrapCSRF(t, server.URL)
	created := createTaskForTest(t, server.URL, token, "title-input-0001", "原始目标", "")

	url := server.URL + "/work/v1/tasks/" + created.TaskID
	body := fmt.Sprintf(`{"client_request_id":"title-request-0001","expected_revision":1,"title":"  修改后的标题  "}`)

	response := taskRequest(t, http.MethodPatch, url, token, body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("patch status = %d body=%s", response.StatusCode, readBody(response))
	}
	var summary api.TaskSummary
	if err := json.NewDecoder(response.Body).Decode(&summary); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if summary.Title != "修改后的标题" || summary.Revision != 2 {
		t.Fatalf("summary = %#v", summary)
	}

	replay := taskRequest(t, http.MethodPatch, url, token, body)
	if replay.StatusCode != http.StatusOK {
		t.Fatalf("replay status = %d", replay.StatusCode)
	}
	var replayed api.TaskSummary
	_ = json.NewDecoder(replay.Body).Decode(&replayed)
	replay.Body.Close()
	if replayed.Title != summary.Title || replayed.Revision != summary.Revision {
		t.Fatalf("replay = %#v", replayed)
	}

	conflict := taskRequest(t, http.MethodPatch, url, token,
		`{"client_request_id":"title-request-0001","expected_revision":1,"title":"另一个标题"}`)
	assertAPICode(t, conflict, http.StatusConflict, "idempotency_key_conflict")

	stale := taskRequest(t, http.MethodPatch, url, token,
		`{"client_request_id":"title-request-0002","expected_revision":1,"title":"过期修订"}`)
	staleResponse := readError(t, stale)
	if staleResponse.Status != http.StatusConflict || staleResponse.Code != "version_conflict" ||
		staleResponse.CurrentRevision == nil || *staleResponse.CurrentRevision != 2 {
		t.Fatalf("stale = %#v", staleResponse)
	}

	control := taskRequest(t, http.MethodPatch, url, token,
		`{"client_request_id":"title-request-0003","expected_revision":2,"title":"bad\nline"}`)
	assertAPICode(t, control, http.StatusUnprocessableEntity, "title_invalid")

	noCSRF := taskRequest(t, http.MethodPatch, url, "", body)
	assertAPICode(t, noCSRF, http.StatusForbidden, "csrf_invalid")

	other := taskRequest(t, http.MethodPatch, server.URL+"/work/v1/tasks/"+taskC, token,
		`{"client_request_id":"title-request-0004","expected_revision":1,"title":"越权"}`)
	assertAPICode(t, other, http.StatusNotFound, "task_not_found")

	setTaskState(t, dbName, created.TaskID, "archived")
	archived := taskRequest(t, http.MethodPatch, url, token,
		`{"client_request_id":"title-request-0005","expected_revision":2,"title":"归档后"}`)
	assertAPICode(t, archived, http.StatusConflict, "task_archived")

	setMemberRole(t, dbName, "viewer")
	viewer := taskRequest(t, http.MethodPatch, url, token,
		`{"client_request_id":"title-request-0006","expected_revision":2,"title":"只读"}`)
	assertAPICode(t, viewer, http.StatusForbidden, "forbidden")
}

func TestAcceptanceRequiresQuiescentTaskAndIsIdempotent(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	server := newHTTPServerWithContent(t, pool, newTestContentStore(t))
	token := bootstrapCSRF(t, server.URL)
	created := createTaskForTest(t, server.URL, token, "accept-input-0001", "完成一份总结", "")
	url := server.URL + "/work/v1/tasks/" + created.TaskID + "/acceptances"

	notQuiescent := taskRequest(t, http.MethodPost, url, token,
		`{"client_request_id":"accept-request-0001","expected_revision":1,"completion_reason":"已完成"}`)
	assertAPICode(t, notQuiescent, http.StatusConflict, "task_not_acceptable")

	stale := taskRequest(t, http.MethodPost, url, token,
		`{"client_request_id":"accept-request-0002","expected_revision":0,"completion_reason":"已完成"}`)
	stalePayload := readError(t, stale)
	if stalePayload.Status != http.StatusConflict || stalePayload.Code != "version_conflict" ||
		stalePayload.CurrentRevision == nil || *stalePayload.CurrentRevision != 1 {
		t.Fatalf("stale = %#v", stalePayload)
	}

	finishRunSucceeded(t, dbName, created.RunID)
	detailResponse := taskRequest(t, http.MethodGet, server.URL+"/work/v1/tasks/"+created.TaskID, "", "")
	var detail api.TaskDetail
	if err := json.NewDecoder(detailResponse.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	detailResponse.Body.Close()
	if detail.Summary.TaskState != "awaiting_acceptance" || detail.Summary.Revision != 2 ||
		detail.Summary.ActiveRunID != nil || detail.Summary.LatestRun == nil ||
		detail.Summary.LatestRun.State != "succeeded" {
		t.Fatalf("detail = %#v", detail.Summary)
	}

	body := `{"client_request_id":"accept-request-0003","expected_revision":2,"completion_reason":"已完成并通过人工检查"}`
	response := taskRequest(t, http.MethodPost, url, token, body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("accept status = %d body=%s", response.StatusCode, readBody(response))
	}
	acceptanceBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	var rawAcceptance map[string]json.RawMessage
	if err := json.Unmarshal(acceptanceBody, &rawAcceptance); err != nil {
		t.Fatal(err)
	}
	assertExactKeys(t, rawAcceptance, "acceptance", "task")
	var acceptanceKeys map[string]json.RawMessage
	if err := json.Unmarshal(rawAcceptance["acceptance"], &acceptanceKeys); err != nil {
		t.Fatal(err)
	}
	assertExactKeys(t, acceptanceKeys, "id", "task_id", "artifact_id", "version_no",
		"completion_reason", "actor_subject_id", "task_revision", "created_at")
	var result acceptanceReply
	if err := json.Unmarshal(acceptanceBody, &result); err != nil {
		t.Fatal(err)
	}
	if result.Acceptance.ID == "" || result.Acceptance.TaskRevision != 3 ||
		result.Acceptance.CompletionReason == nil || *result.Acceptance.CompletionReason != "已完成并通过人工检查" ||
		result.Task.TaskState != "completed" || result.Task.Revision != 3 ||
		result.Task.PendingAcceptance {
		t.Fatalf("result = %#v", result)
	}

	replay := taskRequest(t, http.MethodPost, url, token, body)
	if replay.StatusCode != http.StatusOK {
		t.Fatalf("replay status = %d", replay.StatusCode)
	}
	var replayed acceptanceReply
	_ = json.NewDecoder(replay.Body).Decode(&replayed)
	replay.Body.Close()
	if replayed.Acceptance.ID != result.Acceptance.ID || replayed.Task.Revision != 3 {
		t.Fatalf("replay = %#v", replayed)
	}

	conflict := taskRequest(t, http.MethodPost, url, token,
		`{"client_request_id":"accept-request-0003","expected_revision":2,"completion_reason":"不同理由"}`)
	assertAPICode(t, conflict, http.StatusConflict, "idempotency_key_conflict")

	again := taskRequest(t, http.MethodPost, url, token,
		`{"client_request_id":"accept-request-0004","expected_revision":3,"completion_reason":"再次采纳"}`)
	assertAPICode(t, again, http.StatusConflict, "task_not_acceptable")
}

func TestAcceptanceValidatesRequestShape(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, true)
	server := newHTTPServerWithContent(t, pool, newTestContentStore(t))
	token := bootstrapCSRF(t, server.URL)
	created := createTaskForTest(t, server.URL, token, "accept-shape-0001", "形状校验", "")
	url := server.URL + "/work/v1/tasks/" + created.TaskID + "/acceptances"

	cases := []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{"both intents", `{"client_request_id":"shape-request-0001","expected_revision":1,"artifact_id":"51111111-1111-4111-8111-111111111111","version_no":1,"completion_reason":"完成"}`, http.StatusUnprocessableEntity, "acceptance_requires_artifact_or_reason"},
		{"artifact without version", `{"client_request_id":"shape-request-0002","expected_revision":1,"artifact_id":"51111111-1111-4111-8111-111111111111"}`, http.StatusUnprocessableEntity, "acceptance_requires_artifact_or_reason"},
		{"zero version", `{"client_request_id":"shape-request-0003","expected_revision":1,"artifact_id":"51111111-1111-4111-8111-111111111111","version_no":0}`, http.StatusUnprocessableEntity, "acceptance_requires_artifact_or_reason"},
		{"missing revision", `{"client_request_id":"shape-request-0004","completion_reason":"完成"}`, http.StatusBadRequest, "invalid_request"},
		{"unknown field", `{"client_request_id":"shape-request-0005","expected_revision":1,"completion_reason":"完成","extra":true}`, http.StatusBadRequest, "invalid_request"},
	}
	for _, tc := range cases {
		response := taskRequest(t, http.MethodPost, url, token, tc.body)
		assertAPICode(t, response, tc.status, tc.code)
	}
	missingCSRF := taskRequest(t, http.MethodPost, url, "",
		`{"client_request_id":"shape-request-0006","expected_revision":1,"completion_reason":"完成"}`)
	assertAPICode(t, missingCSRF, http.StatusForbidden, "csrf_invalid")
}

func createTaskForTest(t *testing.T, baseURL, token, clientID, goal, background string) submitReply {
	t.Helper()
	payload := fmt.Sprintf(`{"client_request_id":%q,"goal":%q,"background":%q}`, clientID, goal, background)
	created := postInput(t, baseURL, token, payload)
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("input status = %d body=%s", created.StatusCode, readBody(created))
	}
	var input inputReply
	if err := json.NewDecoder(created.Body).Decode(&input); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()
	preview := postPreview(t, baseURL, token, input.InputRef, "summary", "ask_each")
	submitted := postSubmit(t, baseURL, token,
		submitBody(clientID+"-submit", input.InputRef, "summary", "ask_each", preview.PreviewHash))
	if submitted.StatusCode != http.StatusAccepted {
		t.Fatalf("submit status = %d body=%s", submitted.StatusCode, readBody(submitted))
	}
	var task submitReply
	if err := json.NewDecoder(submitted.Body).Decode(&task); err != nil {
		t.Fatal(err)
	}
	submitted.Body.Close()
	task.InputRef = input.InputRef
	return task
}

func taskRequest(t *testing.T, method, url, token, body string) *http.Response {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	if token != "" {
		request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: token})
		request.Header.Set(api.CSRFHeaderName, token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

type acceptanceReply struct {
	Acceptance struct {
		ID               string  `json:"id"`
		TaskID           string  `json:"task_id"`
		CompletionReason *string `json:"completion_reason"`
		TaskRevision     int64   `json:"task_revision"`
	} `json:"acceptance"`
	Task api.TaskSummary `json:"task"`
}

type errorPayload struct {
	Status          int
	Code            string `json:"code"`
	CurrentRevision *int64 `json:"current_revision"`
}

func readError(t *testing.T, response *http.Response) errorPayload {
	t.Helper()
	defer response.Body.Close()
	var payload errorPayload
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	payload.Status = response.StatusCode
	return payload
}

func assertExactKeys(t *testing.T, raw map[string]json.RawMessage, keys ...string) {
	t.Helper()
	got := make([]string, 0, len(raw))
	for key := range raw {
		got = append(got, key)
	}
	want := append([]string(nil), keys...)
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("keys = %v, want %v", got, want)
	}
}

func readBody(response *http.Response) string {
	defer response.Body.Close()
	var body strings.Builder
	buffer := make([]byte, 4096)
	for {
		n, err := response.Body.Read(buffer)
		if n > 0 {
			body.Write(buffer[:n])
		}
		if err != nil {
			break
		}
	}
	return body.String()
}

func finishRunSucceeded(t *testing.T, dbName, runID string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT work.acquire_run($1, 'org_a')`, runID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT work.finish_run($1, 'org_a', 'succeeded', NULL)`, runID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func taskOutboxKind(t *testing.T, dbName, taskID string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var kind string
	if err := conn.QueryRow(ctx, `
		SELECT payload->>'kind'
		FROM work.outbox
		WHERE aggregate_type = 'task' AND aggregate_id = $1
		ORDER BY outbox_seq
		LIMIT 1`, taskID).Scan(&kind); err != nil {
		t.Fatal(err)
	}
	return kind
}

func setTaskState(t *testing.T, dbName, taskID, state string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `UPDATE work.task SET state = $1 WHERE id = $2`, state, taskID); err != nil {
		t.Fatal(err)
	}
}

func setMemberRole(t *testing.T, dbName, role string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `UPDATE work.member SET role = $1 WHERE org_id = 'org_a' AND subject_id = 'sub_a'`, role); err != nil {
		t.Fatal(err)
	}
}
