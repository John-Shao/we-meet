package api_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

// GET /work/v1/inbox and GET /work/v1/runs/{runId}/operations. Both project rows
// the write path already owns, so the assertions that matter are which rows
// appear, in what order, and what a caller who does not own the run gets.

type ibxSeed struct {
	n          int
	org        string
	owner      string
	taskState  string
	runState   string // "" keeps the task run-less
	waitReason string
	openRun    bool   // also sets task.active_run_id, not only latest_run_id
	operation  string // "" writes no operation row
}

func ibxUUID(kind string, n int) string {
	return fmt.Sprintf("%s1111111-1111-4111-8111-%012d", kind, n)
}

// ibxScript writes one task and, when asked, its snapshot, run and operation.
// updated_at is derived from the seed index so a page has a deterministic order
// instead of depending on now() landing differently per statement.
func ibxScript(s ibxSeed) string {
	updatedAt := fmt.Sprintf("now() - (%d * interval '1 minute')", s.n)
	org := s.org
	if org == "" {
		org = "org_a"
	}
	owner := s.owner
	if owner == "" {
		owner = "sub_a"
	}
	taskID := ibxUUID("8", s.n)
	inputID := ibxUUID("9", s.n)
	script := fmt.Sprintf(`
		SELECT set_config('app.org_id', '%s', false);
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%s', '%s', '%s', 'content://ibx/%d', 'sha256:ibx-%d', 10);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode,
		                        title, input_id, revision, updated_at)
		VALUES ('%s', '%s', '%s', '%s', 'ask_each', 'Inbox %d', '%s', 0, %s);`,
		org, inputID, org, owner, s.n, s.n,
		taskID, org, owner, s.taskState, s.n, inputID, updatedAt)
	if s.runState == "" {
		return script
	}
	snapshotID := ibxUUID("a", s.n)
	runID := ibxUUID("b", s.n)
	waitReason := "NULL"
	if s.waitReason != "" {
		waitReason = fmt.Sprintf("'%s'", s.waitReason)
	}
	active := "NULL"
	if s.openRun {
		active = fmt.Sprintf("'%s'", runID)
	}
	script += fmt.Sprintf(`
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		VALUES ('%s', '%s', '%s', 'test', 'sha256:ibx-%d', ARRAY['model_call']::text[],
		        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, wait_reason,
		                      snapshot_id, workflow_id, runtime_version)
		VALUES ('%s', '%s', '%s', 1, '%s', %s, '%s', 'wf-ibx-%d', 'test');
		UPDATE work.task SET active_run_id = %s, latest_run_id = '%s'
		WHERE id = '%s' AND org_id = '%s';`,
		snapshotID, org, taskID, s.n,
		runID, org, taskID, s.runState, waitReason, snapshotID, s.n,
		active, runID, taskID, org)
	if s.operation == "" {
		return script
	}
	return script + fmt.Sprintf(`
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind,
		                            request_hash, state, created_at)
		VALUES ('%s', '%s', '%s', 'model:1', 'model', 'sha256:op', '%s',
		        now() - (%d * interval '1 minute'));`,
		ibxUUID("c", s.n), org, runID, s.operation, s.n)
}

func ibxSeedTasks(t *testing.T, dbName string, seeds ...ibxSeed) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	for _, seed := range seeds {
		if err := testpg.ExecRaw(ctx, conn, ibxScript(seed)); err != nil {
			t.Fatalf("seed %d: %v", seed.n, err)
		}
	}
}

func ibxSessionGet(t *testing.T, url string) *http.Response {
	t.Helper()
	return taskRequest(t, http.MethodGet, url, "", "")
}

// ibxTestCursor builds a cursor payload without going through the server, so the
// malformed-input cases can name the shape they are breaking.
func ibxTestCursor(payload string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

func ibxDecodeInbox(t *testing.T, response *http.Response) (api.InboxPage, map[string]json.RawMessage) {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	var page api.InboxPage
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatalf("decode inbox page: %v body=%s", err, body)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	return page, raw
}

func ibxDecodeOperations(t *testing.T, response *http.Response) (api.OperationPage, map[string]json.RawMessage) {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	var page api.OperationPage
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatalf("decode operation page: %v body=%s", err, body)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	return page, raw
}

func TestListInboxProjectsOnlyActionableTasks(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	ibxSeedTasks(t, dbName,
		// The three reasons the contract names, newest first by construction.
		ibxSeed{n: 1, taskState: "awaiting_acceptance"},
		ibxSeed{n: 2, taskState: "open", runState: "failed"},
		ibxSeed{n: 3, taskState: "open", runState: "active", openRun: true, operation: "unknown"},
		// Not inbox material: still executing, stopped on quota, and finished.
		ibxSeed{n: 4, taskState: "open", runState: "active", openRun: true},
		ibxSeed{n: 5, taskState: "open", runState: "active", openRun: true, waitReason: "quota"},
		ibxSeed{n: 6, taskState: "completed", runState: "succeeded"},
		// Somebody else's task in this organization, and this subject's task in
		// another organization: neither may appear.
		ibxSeed{n: 7, taskState: "awaiting_acceptance", owner: "sub_other"},
		ibxSeed{n: 8, org: "org_other", taskState: "awaiting_acceptance"},
	)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	response := ibxSessionGet(t, server.URL+api.InboxPath)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.StatusCode, readBody(response))
	}
	page, raw := ibxDecodeInbox(t, response)
	assertExactKeys(t, raw, "items", "next_cursor")
	if len(page.Items) != 3 {
		t.Fatalf("items = %d, want 3: %#v", len(page.Items), page.Items)
	}
	types := []string{"acceptance_required", "failed", "reconciling"}
	states := []string{"awaiting_acceptance", "failed", "reconciling"}
	for i, item := range page.Items {
		if item.TaskID != ibxUUID("8", i+1) || item.Type != types[i] ||
			item.DisplayState != states[i] ||
			item.Title != fmt.Sprintf("Inbox %d", i+1) || item.UpdatedAt.IsZero() {
			t.Fatalf("item %d = %#v, want type %s", i, item, types[i])
		}
		if i > 0 && !item.UpdatedAt.Before(page.Items[i-1].UpdatedAt) {
			t.Fatalf("page is not newest-first: %v then %v",
				page.Items[i-1].UpdatedAt, item.UpdatedAt)
		}
	}
	// InboxItem is additionalProperties:false with exactly five required keys.
	var itemsRaw []map[string]json.RawMessage
	if err := json.Unmarshal(raw["items"], &itemsRaw); err != nil {
		t.Fatal(err)
	}
	assertExactKeys(t, itemsRaw[0], "task_id", "type", "title", "display_state", "updated_at")
	if page.NextCursor != nil {
		t.Fatalf("next_cursor = %q, want null on a complete page", *page.NextCursor)
	}
}

func TestListInboxPagesWithTheContractDefault(t *testing.T) {
	seeds := make([]ibxSeed, 0, 21)
	for n := 1; n <= 21; n++ {
		seeds = append(seeds, ibxSeed{n: n, taskState: "awaiting_acceptance"})
	}
	pool, dbName := newBootstrapDB(t, true, true)
	ibxSeedTasks(t, dbName, seeds...)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	// The shared Limit parameter declares default 20; the task list answers 50 and
	// that offset is tracked for adjudication. A surface added afterwards follows
	// the declared default instead of inheriting the deviation.
	first := ibxSessionGet(t, server.URL+api.InboxPath)
	page, _ := ibxDecodeInbox(t, first)
	if len(page.Items) != 20 || page.NextCursor == nil {
		t.Fatalf("first page = %d items, cursor = %v", len(page.Items), page.NextCursor)
	}
	if page.Items[0].TaskID != ibxUUID("8", 1) || page.Items[19].TaskID != ibxUUID("8", 20) {
		t.Fatalf("first page spans %s..%s", page.Items[0].TaskID, page.Items[19].TaskID)
	}
	second := ibxSessionGet(t, server.URL+api.InboxPath+"?cursor="+*page.NextCursor)
	next, _ := ibxDecodeInbox(t, second)
	if len(next.Items) != 1 || next.Items[0].TaskID != ibxUUID("8", 21) || next.NextCursor != nil {
		t.Fatalf("second page = %#v", next)
	}

	// limit=1 must chain through all 21 rows without repeating or dropping one.
	seen := map[string]bool{}
	cursor := ""
	for page := 0; page < 25; page++ {
		url := server.URL + api.InboxPath + "?limit=1"
		if cursor != "" {
			url += "&cursor=" + cursor
		}
		response := ibxSessionGet(t, url)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("page %d status = %d body=%s", page, response.StatusCode, readBody(response))
		}
		inboxPage, _ := ibxDecodeInbox(t, response)
		if len(inboxPage.Items) != 1 {
			t.Fatalf("page %d items = %d", page, len(inboxPage.Items))
		}
		seen[inboxPage.Items[0].TaskID] = true
		if inboxPage.NextCursor == nil {
			break
		}
		cursor = *inboxPage.NextCursor
	}
	if len(seen) != 21 {
		t.Fatalf("distinct tasks across pages = %d, want 21", len(seen))
	}
}

func TestListInboxRejectsBadPagingAndMissingSession(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	ibxSeedTasks(t, dbName, ibxSeed{n: 1, taskState: "awaiting_acceptance"})
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	bad := []string{
		"?limit=0", "?limit=101", "?limit=abc", "?cursor=not-base64-$$$",
		"?cursor=" + ibxTestCursor("2026-11-02T10:00:00Z|not-a-uuid"),
		"?cursor=" + ibxTestCursor("not-a-time|11111111-1111-4111-8111-111111111111"),
	}
	for _, query := range bad {
		response := ibxSessionGet(t, server.URL+api.InboxPath+query)
		assertAPICode(t, response, http.StatusBadRequest, "invalid_pagination")
	}

	// No session cookie at all: the verifier is not reached with claims, so this
	// is the 401 the contract declares rather than a seat refusal.
	anonymous, err := http.Get(server.URL + api.InboxPath)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, anonymous, http.StatusUnauthorized, "unauthorized")

	noSeatPool, noSeatDB := newBootstrapDB(t, true, true, true, false)
	ibxSeedTasks(t, noSeatDB, ibxSeed{n: 1, taskState: "awaiting_acceptance"})
	noSeat := newHTTPServer(t, noSeatPool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	// A GET carries no CSRF requirement, so this reaches the seat guard itself
	// instead of being refused as a cross-site write.
	response := ibxSessionGet(t, noSeat.URL+api.InboxPath)
	assertAPICode(t, response, http.StatusForbidden, "work_seat_required")
}

func TestListRunOperationsScopesToTheOwningRun(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	ibxSeedTasks(t, dbName,
		ibxSeed{n: 1, taskState: "open", runState: "active", openRun: true, operation: "unknown"},
		ibxSeed{n: 2, taskState: "open", runState: "active", openRun: true,
			owner: "sub_other", operation: "prepared"},
		ibxSeed{n: 3, org: "org_other", taskState: "open", runState: "active",
			openRun: true, operation: "prepared"},
	)
	ctx := context.Background()
	conn := avAdminConn(t, dbName)
	// Two more operations on run 1 (tool and artifact kinds), older than the
	// seeded model row so created_at ordering is testable, with the nullable
	// locator columns set only on the model row.
	if err := testpg.ExecRaw(ctx, conn, fmt.Sprintf(`
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, kind, request_hash, state,
		   revision, created_at, updated_at)
		VALUES
		  ('%s', 'org_a', '%s', 'tool:1', 'tool', 'sha256:tool', 'waiting_approval',
		   0, now() - interval '2 minutes', now() - interval '2 minutes'),
		  ('%s', 'org_a', '%s', 'artifact:1', 'artifact', 'sha256:art', 'dispatching',
		   3, now() - interval '3 minutes', now() - interval '3 minutes');
		UPDATE work.operation
		SET provider_request_id = 'req-1', receipt_ref = 'content://receipt'
		WHERE id = '%s' AND org_id = 'org_a';`,
		ibxUUID("d", 1), ibxUUID("b", 1), ibxUUID("d", 2), ibxUUID("b", 1),
		ibxUUID("c", 1))); err != nil {
		t.Fatal(err)
	}
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	response := ibxSessionGet(t, server.URL+"/work/v1/runs/"+ibxUUID("b", 1)+"/operations")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.StatusCode, readBody(response))
	}
	page, raw := ibxDecodeOperations(t, response)
	assertExactKeys(t, raw, "items", "next_cursor")
	if len(page.Items) != 3 || page.NextCursor != nil {
		t.Fatalf("items = %d, next_cursor = %v", len(page.Items), page.NextCursor)
	}
	var itemsRaw []map[string]json.RawMessage
	if err := json.Unmarshal(raw["items"], &itemsRaw); err != nil {
		t.Fatal(err)
	}
	// Operation is additionalProperties:false, so no body column can ride along -
	// the query never names the request, answer or receipt tables at all.
	assertExactKeys(t, itemsRaw[0], "id", "run_id", "logical_key", "kind", "state",
		"request_hash", "provider_request_id", "receipt_ref", "revision",
		"created_at", "updated_at")
	byKind := map[string]api.Operation{}
	for _, item := range page.Items {
		if item.RunID != ibxUUID("b", 1) {
			t.Fatalf("item %s belongs to run %s", item.ID, item.RunID)
		}
		byKind[item.Kind] = item
	}
	if len(byKind) != 3 {
		t.Fatalf("kinds = %d, want 3: %#v", len(byKind), page.Items)
	}
	model := byKind["model"]
	if model.State != "unknown" || model.LogicalKey != "model:1" ||
		model.ProviderRequestID == nil || *model.ProviderRequestID != "req-1" ||
		model.ReceiptRef == nil || *model.ReceiptRef != "content://receipt" {
		t.Fatalf("model row = %#v", model)
	}
	tool := byKind["tool"]
	if tool.State != "waiting_approval" || tool.ProviderRequestID != nil ||
		tool.ReceiptRef != nil {
		t.Fatalf("tool row = %#v", tool)
	}
	artifact := byKind["artifact"]
	if artifact.State != "dispatching" || artifact.Revision != 3 {
		t.Fatalf("artifact row = %#v", artifact)
	}
	for i := 1; i < len(page.Items); i++ {
		if !page.Items[i-1].CreatedAt.After(page.Items[i].CreatedAt) {
			t.Fatalf("page %d is not newest-first: %v then %v", i,
				page.Items[i-1].CreatedAt, page.Items[i].CreatedAt)
		}
	}

	// A run somebody else owns is a 404 and never an empty 200: an empty page
	// would be a claim about that run's execution.
	foreign := ibxSessionGet(t, server.URL+"/work/v1/runs/"+ibxUUID("b", 2)+"/operations")
	assertAPICode(t, foreign, http.StatusNotFound, "run_not_found")
	otherOrg := ibxSessionGet(t, server.URL+"/work/v1/runs/"+ibxUUID("b", 3)+"/operations")
	assertAPICode(t, otherOrg, http.StatusNotFound, "run_not_found")
	missing := ibxSessionGet(t, server.URL+"/work/v1/runs/"+ibxUUID("b", 9)+"/operations")
	assertAPICode(t, missing, http.StatusNotFound, "run_not_found")
	notUUID := ibxSessionGet(t, server.URL+"/work/v1/runs/not-a-uuid/operations")
	assertAPICode(t, notUUID, http.StatusNotFound, "run_not_found")
}

func TestListRunOperationsPagesAndValidates(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	ibxSeedTasks(t, dbName, ibxSeed{n: 1, taskState: "open", runState: "active", openRun: true})
	ctx := context.Background()
	values := ""
	for k := 1; k <= 3; k++ {
		values += fmt.Sprintf(`('%s', 'org_a', '%s', 'model:%d', 'model', 'sha256:op%d',
		                        'succeeded', now() - (%d * interval '1 minute')),`,
			ibxUUID("d", k), ibxUUID("b", 1), k, k, k)
	}
	values = values[:len(values)-1]
	conn := avAdminConn(t, dbName)
	if err := testpg.ExecRaw(ctx, conn, fmt.Sprintf(`
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind,
		                            request_hash, state, created_at)
		VALUES %s;`, values)); err != nil {
		t.Fatal(err)
	}
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	base := server.URL + "/work/v1/runs/" + ibxUUID("b", 1) + "/operations"

	first := ibxSessionGet(t, base+"?limit=2")
	page, _ := ibxDecodeOperations(t, first)
	if len(page.Items) != 2 || page.NextCursor == nil {
		t.Fatalf("first page = %#v", page)
	}
	second := ibxSessionGet(t, base+"?limit=2&cursor="+*page.NextCursor)
	next, _ := ibxDecodeOperations(t, second)
	if len(next.Items) != 1 || next.Items[0].ID != ibxUUID("d", 3) || next.NextCursor != nil {
		t.Fatalf("second page = %#v", next)
	}

	bad := []string{"?limit=0", "?limit=101", "?cursor=zzz!!",
		"?cursor=" + ibxTestCursor("2026-11-02T10:00:00Z|not-a-uuid")}
	for _, query := range bad {
		response := ibxSessionGet(t, base+query)
		assertAPICode(t, response, http.StatusBadRequest, "invalid_pagination")
	}

	noSeatPool, _ := newBootstrapDB(t, true, true, true, false)
	noSeat := newHTTPServer(t, noSeatPool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	response := ibxSessionGet(t, noSeat.URL+"/work/v1/runs/"+ibxUUID("b", 1)+"/operations")
	assertAPICode(t, response, http.StatusForbidden, "work_seat_required")
}
