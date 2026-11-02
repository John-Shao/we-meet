package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/host"
)

// Second half of the error-code audit (see export_error_surface_pg_test.go for the admin
// half). Three more public codes are producible by a shipped endpoint and were asserted
// nowhere: input_not_found, task_not_runnable and artifact_not_published.
//
// Each of them has two or three distinct producers on the way out, and the interesting part
// is which one answers first:
//
//   - input_not_found comes from Go at the preview step (previews.go:274-282 turns "no row",
//     "expired" and "already bound" into a domain error before any command runs) and from SQL
//     inside work.submit_task, whose input lookup additionally requires task_id IS NULL
//     (baseline/0002:1580-1587). The second one is reachable because a preview token is a
//     stateless HMAC that the first submit never consumes (previews.go:299-321).
//   - task_not_runnable is the third refusal in retry_task (0002:3520-3531): a stale revision
//     answers version_conflict and a live run answers task_has_active_run first, so the state
//     rules are only visible once those two are ruled out. task_retry_test.go accepted either
//     of the first two codes; this pins the third.
//   - artifact_not_published is the last guard in accept_task (0002:3630), after the ownership,
//     revision, state and quiescence checks, and it is what a staged version, a version that
//     does not exist, and an artifact belonging to another task all answer with.

const (
	surfaceStagedArtifact    = "61111111-1111-4111-8111-818181818181"
	surfacePublishedArtifact = "61111111-1111-4111-8111-828282828282"
	surfaceRetryTarget       = `"target":{"kind":"cloud","profile":"text-v1"}`
)

// surfacePreviewResponse is postPreview without the "200 or fatal" shortcut, so a refusal can
// be read as an error code instead of ending the test.
func surfacePreviewResponse(t *testing.T, serverURL, token, inputRef, templateID, mode string) *http.Response {
	t.Helper()
	body := fmt.Sprintf(`{"input_ref":%q,"template_id":%q,"permission_mode":%q}`,
		inputRef, templateID, mode)
	request, err := http.NewRequest(http.MethodPost, serverURL+api.TaskPreviewsPath,
		strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
	request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: token})
	request.Header.Set(api.CSRFHeaderName, token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func surfaceTaskDetail(t *testing.T, serverURL, token, taskID string) api.TaskDetail {
	t.Helper()
	response := taskRequest(t, http.MethodGet, serverURL+"/work/v1/tasks/"+taskID, token, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("detail status = %d body=%s", response.StatusCode, readBody(response))
	}
	var detail api.TaskDetail
	if err := json.NewDecoder(response.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	return detail
}

// surfaceExec runs one statement as the owning role and fails the test on error; pgx uses the
// extended protocol as soon as an argument is present, so multi-statement scripts would raise
// 42601 and each call here carries exactly one statement.
func surfaceExec(t *testing.T, dbName, statement string, args ...any) {
	t.Helper()
	if _, err := ownerExec(dbName, statement, args...); err != nil {
		t.Fatalf("%s: %v", statement, err)
	}
}

// finishRunFailed is finishRunSucceeded's other branch: the task stays open with
// active_run_id cleared and latest_run_id pointing at the failed run, which is the state a
// retry is supposed to accept (0002:779-785).
func finishRunFailed(t *testing.T, dbName, runID string) {
	t.Helper()
	surfaceExec(t, dbName, `SELECT work.acquire_run($1::uuid, 'org_a')`, runID)
	surfaceExec(t, dbName, `SELECT work.finish_run($1::uuid, 'org_a', 'failed', 'model_error')`, runID)
}

func TestInputNotFoundHasAProducerAtPreviewAndAtSubmit(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	store := newTestContentStore(t)
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)

	// Producer one: a well-formed id with no row. The same code is what an expired or an
	// already-bound input gets, so the preview cannot be used to tell them apart.
	missing := "31111111-1111-4111-8111-999999999999"
	assertAPICode(t, surfacePreviewResponse(t, server.URL, token, missing, "summary", "ask_each"),
		http.StatusUnprocessableEntity, "input_not_found")

	created := postInput(t, server.URL, token,
		`{"client_request_id":"surface-input-00001","goal":"把会议记录整理成纪要","background":""}`)
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("input status = %d body=%s", created.StatusCode, readBody(created))
	}
	var input inputReply
	if err := json.NewDecoder(created.Body).Decode(&input); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()
	preview := postPreview(t, server.URL, token, input.InputRef, "summary", "ask_each")

	first := postSubmit(t, server.URL, token,
		submitBody("surface-submit-00001", input.InputRef, "summary", "ask_each", preview.PreviewHash))
	if first.StatusCode != http.StatusAccepted {
		t.Fatalf("first submit status = %d body=%s", first.StatusCode, readBody(first))
	}
	var submitted submitReply
	if err := json.NewDecoder(first.Body).Decode(&submitted); err != nil {
		t.Fatal(err)
	}
	first.Body.Close()

	// Producer two: the input now belongs to a task. Submit reads it with allowBound=true,
	// so the Go guard lets it through and work.submit_task's own filter refuses. The code is
	// the same as "no such input" on purpose - the answer must not tell a caller whether the
	// input exists and was already consumed.
	second := postSubmit(t, server.URL, token,
		submitBody("surface-submit-00002", input.InputRef, "summary", "ask_each", preview.PreviewHash))
	assertAPICode(t, second, http.StatusUnprocessableEntity, "input_not_found")

	if tasks := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.task WHERE org_id = 'org_a'`); tasks != "1" {
		t.Fatalf("tasks after the refused submit = %s, want only the accepted one", tasks)
	}
	if runs := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.run WHERE org_id = 'org_a'`); runs != "1" {
		t.Fatalf("runs after the refused submit = %s, want the one the accepted submit made", runs)
	}
	if owner := opsScalar(t, dbName,
		`SELECT coalesce(task_id::text, '-') FROM work.input_object WHERE id = $1::uuid`,
		input.InputRef); owner != submitted.TaskID {
		t.Fatalf("input binding after the refused submit = %s, want %s", owner, submitted.TaskID)
	}
}

func TestRetryTaskRefusesWhenTheTaskOrItsLatestRunIsNotRunnable(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	store := newTestContentStore(t)
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)

	retry := func(clientID, taskID string, revision int64) *http.Response {
		return taskRequest(t, http.MethodPost,
			server.URL+"/work/v1/tasks/"+taskID+"/runs", token,
			fmt.Sprintf(`{"client_request_id":%q,"expected_revision":%s,%s}`,
				clientID, itoa64(revision), surfaceRetryTarget))
	}

	// Control first: a failed run is the state retry_task exists for, so the refusals below
	// cannot be explained by an endpoint that never retries anything.
	failed := createTaskForTest(t, server.URL, token, "surface-retry-a", "跑失败的纪要要能重跑", "")
	finishRunFailed(t, dbName, failed.RunID)
	accepted := retry("surface-retry-a-run2", failed.TaskID,
		surfaceTaskDetail(t, server.URL, token, failed.TaskID).Summary.Revision)
	if accepted.StatusCode != http.StatusAccepted {
		t.Fatalf("retry after a failed run = %d body=%s", accepted.StatusCode, readBody(accepted))
	}
	var secondRun struct {
		RunID string `json:"run_id"`
	}
	if err := json.NewDecoder(accepted.Body).Decode(&secondRun); err != nil {
		t.Fatal(err)
	}
	accepted.Body.Close()
	if secondRun.RunID == "" {
		t.Fatal("accepted retry returned no run id")
	}

	// The accepted retry left a queued run as the task's active run, so the next one is the
	// neighbour code, not task_not_runnable. Pinning which of the three guards answers is the
	// point: task_retry_test.go accepted either name for this state.
	assertAPICode(t, retry("surface-retry-a-run3", failed.TaskID,
		surfaceTaskDetail(t, server.URL, token, failed.TaskID).Summary.Revision),
		http.StatusConflict, "task_has_active_run")

	// A crashed dispatch clears the active run without clearing the queued latest run. With
	// the first guard out of the way, the run-state clause of 0002:3529 is what refuses: a
	// queued run is neither failed nor canceled, so there is nothing to retry.
	surfaceExec(t, dbName, `
		UPDATE work.task SET active_run_id = NULL
		WHERE id = $1::uuid AND org_id = 'org_a'`, failed.TaskID)
	revisionBefore := surfaceTaskDetail(t, server.URL, token, failed.TaskID).Summary.Revision
	assertAPICode(t, retry("surface-retry-a-run4", failed.TaskID, revisionBefore),
		http.StatusConflict, "task_not_runnable")
	if runs := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.run WHERE task_id = $1::uuid`, failed.TaskID); runs != "2" {
		t.Fatalf("runs after the refused retry = %s, want the two accepted ones", runs)
	}
	if after := surfaceTaskDetail(t, server.URL, token, failed.TaskID); after.Summary.Revision !=
		revisionBefore || after.Summary.TaskState != "open" {
		t.Fatalf("refused retry moved the task: %#v", after.Summary)
	}

	// The other clause: a succeeded run completes the task, and a completed-by-outcome task is
	// not runnable even though no run is active.
	succeeded := createTaskForTest(t, server.URL, token, "surface-retry-b", "已经成功的任务不能重跑", "")
	finishRunSucceeded(t, dbName, succeeded.RunID)
	detail := surfaceTaskDetail(t, server.URL, token, succeeded.TaskID)
	if detail.Summary.TaskState != "awaiting_acceptance" {
		t.Fatalf("task state after a succeeded run = %q", detail.Summary.TaskState)
	}
	assertAPICode(t, retry("surface-retry-b-run2", succeeded.TaskID, detail.Summary.Revision),
		http.StatusConflict, "task_not_runnable")
	if runs := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.run WHERE task_id = $1::uuid`, succeeded.TaskID); runs != "1" {
		t.Fatalf("runs after the refused retry = %s, want the original one", runs)
	}
}

func TestAcceptanceRefusesEveryUnpublishedArtifactShapeTheSameWay(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	store := newTestContentStore(t)
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)

	task := createTaskForTest(t, server.URL, token, "surface-accept-a", "定稿一份还没发布的成果", "")
	other := createTaskForTest(t, server.URL, token, "surface-accept-b", "另一个任务的成果", "")
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: surfaceStagedArtifact, orgID: "org_a", taskID: task.TaskID,
		logicalName: "result", content: "# 草稿，还没发布", versionState: "staged",
	})
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: surfacePublishedArtifact, orgID: "org_a", taskID: other.TaskID,
		logicalName: "result", content: "# 别的任务的正式版", versionState: "published",
	})
	finishRunSucceeded(t, dbName, task.RunID)
	revision := surfaceTaskDetail(t, server.URL, token, task.TaskID).Summary.Revision

	accept := func(clientID, artifactID string, versionNo int) *http.Response {
		return taskRequest(t, http.MethodPost,
			server.URL+"/work/v1/tasks/"+task.TaskID+"/acceptances", token,
			fmt.Sprintf(`{"client_request_id":%q,"expected_revision":%s,"artifact_id":%q,"version_no":%d}`,
				clientID, itoa64(revision), artifactID, versionNo))
	}

	// A draft version exists and is readable, but acceptance pins a published fact, so the
	// version has to be published (0002:3622-3630).
	assertAPICode(t, accept("surface-accept-staged", surfaceStagedArtifact, 1),
		http.StatusUnprocessableEntity, "artifact_not_published")
	// A version number that was never minted gets the same answer as an unpublished one.
	assertAPICode(t, accept("surface-accept-missing", surfaceStagedArtifact, 3),
		http.StatusUnprocessableEntity, "artifact_not_published")
	// A published artifact of *another* task also answers artifact_not_published rather than
	// revealing that the id exists somewhere in the organization: the guard is one EXISTS over
	// (id, org, task, version), so all three shapes are indistinguishable from outside.
	assertAPICode(t, accept("surface-accept-foreign", surfacePublishedArtifact, 1),
		http.StatusUnprocessableEntity, "artifact_not_published")

	if rows := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.acceptance WHERE task_id = $1::uuid`, task.TaskID); rows != "0" {
		t.Fatalf("acceptance rows after the refusals = %s, want 0", rows)
	}
	if after := surfaceTaskDetail(t, server.URL, token, task.TaskID); after.Summary.Revision !=
		revision || after.Summary.TaskState != "awaiting_acceptance" {
		t.Fatalf("refused acceptance moved the task: %#v", after.Summary)
	}

	// Control: the same route accepts a published version of an artifact on this task.
	published := "61111111-1111-4111-8111-838383838383"
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: published, orgID: "org_a", taskID: task.TaskID,
		logicalName: "notes", content: "# 正式版", versionState: "published",
	})
	ok := accept("surface-accept-ok", published, 1)
	if ok.StatusCode != http.StatusOK {
		t.Fatalf("acceptance of a published version = %d body=%s", ok.StatusCode, readBody(ok))
	}
	ok.Body.Close()
	if after := surfaceTaskDetail(t, server.URL, token, task.TaskID); after.Summary.TaskState !=
		"completed" {
		t.Fatalf("task state after the accepted pin = %q", after.Summary.TaskState)
	}
}
