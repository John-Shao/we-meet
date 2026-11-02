package api_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/apierr"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/testpg"
)

// POST /work/v1/artifacts/{artifactId}/versions. The task and artifact ids below
// are seeded per test database, so they do not collide with artifacts_test.go's
// read-path fixtures.
const (
	avEditableTaskID    = "11111111-1111-4111-8111-222222222222" // Task B: open, no Run
	avBusyTaskID        = "11111111-1111-4111-8111-111111111111" // Task A: has a Run
	avBusyRunID         = "21111111-1111-4111-8111-111111111111"
	avForeignTaskID     = "11111111-1111-4111-8111-333333333333" // Task C: owned by sub_other
	avEditableArtifact  = "61111111-1111-4111-8111-111111111111"
	avBusyArtifact      = "61111111-1111-4111-8111-222222222222"
	avForeignArtifactID = "61111111-1111-4111-8111-333333333333"
	avMissingArtifact   = "61111111-1111-4111-8111-444444444444"
)

func avVersionsURL(baseURL, artifactID string) string {
	return baseURL + "/work/v1/artifacts/" + artifactID + "/versions"
}

func avBody(clientRequestID string, baseVersionNo int, text string) string {
	return fmt.Sprintf(`{"client_request_id":%q,"base_version_no":%d,"content":%q}`,
		clientRequestID, baseVersionNo, text)
}

func avSeedArtifact(t *testing.T, dbName, taskID, artifactID string, store content.Store, text string) {
	t.Helper()
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID:   artifactID,
		orgID:        "org_a",
		taskID:       taskID,
		logicalName:  "result",
		content:      text,
		versionState: "published",
	})
}

// avCreate posts one version and returns the parsed 201 body, so a non-201
// response fails with the server's own text instead of a decode error.
func avCreate(t *testing.T, baseURL, artifactID, token, body string) api.ArtifactVersion {
	t.Helper()
	response := taskRequest(t, http.MethodPost, avVersionsURL(baseURL, artifactID), token, body)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d body=%s", response.StatusCode, readBody(response))
	}
	payload, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var version api.ArtifactVersion
	if err := json.Unmarshal(payload, &version); err != nil {
		t.Fatal(err)
	}
	return version
}

func TestCreateArtifactVersionPublishesWithoutTouchingTheOldVersion(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	avSeedArtifact(t, dbName, avEditableTaskID, avEditableArtifact, store, "# 第一版")
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)

	edited := "# 第二版\n\n用户编辑的正文"
	created := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avEditableArtifact),
		token, avBody("aversion-create-0001", 1, edited))
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d body=%s", created.StatusCode, readBody(created))
	}
	body, err := io.ReadAll(created.Body)
	created.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	// ArtifactVersion sets additionalProperties:false, so the 201 body may not
	// carry the task revision the command also returns.
	assertExactKeys(t, raw, "artifact_id", "version_no", "logical_name", "media_type",
		"bytes", "content_hash", "state", "content_url", "created_at", "published_at")
	var version api.ArtifactVersion
	if err := json.Unmarshal(body, &version); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(edited))
	wantHash := "sha256:" + hex.EncodeToString(digest[:])
	if version.ArtifactID != avEditableArtifact || version.VersionNo != 2 ||
		version.LogicalName != "result" || version.MediaType != "text/markdown" ||
		version.Bytes != int64(len(edited)) || version.ContentHash != wantHash ||
		version.State != "published" || version.PublishedAt == nil ||
		!strings.HasSuffix(version.ContentURL,
			"/work/v1/artifacts/"+avEditableArtifact+"/versions/2/content") {
		t.Fatalf("version = %#v hash = %s", version, wantHash)
	}

	// "不覆盖旧版本" is the whole point: v1 still serves its own bytes.
	first := taskRequest(t, http.MethodGet,
		server.URL+"/work/v1/artifacts/"+avEditableArtifact+"/versions/1/content", "", "")
	if first.StatusCode != http.StatusOK {
		t.Fatalf("v1 status = %d body=%s", first.StatusCode, readBody(first))
	}
	firstBody, _ := io.ReadAll(first.Body)
	first.Body.Close()
	if string(firstBody) != "# 第一版" {
		t.Fatalf("v1 body = %q", firstBody)
	}
	second := taskRequest(t, http.MethodGet,
		server.URL+"/work/v1/artifacts/"+avEditableArtifact+"/versions/2/content", "", "")
	if second.StatusCode != http.StatusOK {
		t.Fatalf("v2 status = %d body=%s", second.StatusCode, readBody(second))
	}
	secondBody, _ := io.ReadAll(second.Body)
	second.Body.Close()
	if string(secondBody) != edited {
		t.Fatalf("v2 body = %q", secondBody)
	}

	if got := avVersionCount(t, dbName, avEditableArtifact); got != 2 {
		t.Fatalf("version rows = %d, want 2", got)
	}
	if got := avArtifactRevision(t, dbName); got != 1 {
		t.Fatalf("artifact revision = %d, want 1", got)
	}
	// The command bumps the task revision so a view built on the older snapshot
	// cannot accept the version it never saw.
	if got := avTaskRevision(t, dbName, avEditableTaskID); got != 1 {
		t.Fatalf("task revision = %d, want 1", got)
	}
	if got := avTaskEventCount(t, dbName, "artifact.published"); got != 1 {
		t.Fatalf("artifact.published events = %d, want 1", got)
	}
	if got := avAuditCount(t, dbName, "artifact.version_create"); got != 1 {
		t.Fatalf("version_create audit rows = %d, want 1", got)
	}
}

func TestCreateArtifactVersionIsIdempotentPerClientRequestID(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	avSeedArtifact(t, dbName, avEditableTaskID, avEditableArtifact, store, "# 第一版")
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)

	body := avBody("aversion-replay-01", 1, "# 同一份编辑")
	first := avCreate(t, server.URL, avEditableArtifact, token, body)
	retry := avCreate(t, server.URL, avEditableArtifact, token, body)
	if first.VersionNo != 2 || retry.VersionNo != 2 {
		t.Fatalf("first = %d retry = %d, want both version 2", first.VersionNo, retry.VersionNo)
	}
	if got := avVersionCount(t, dbName, avEditableArtifact); got != 2 {
		t.Fatalf("version rows after replay = %d, want 2", got)
	}
	if got := avTaskEventCount(t, dbName, "artifact.published"); got != 1 {
		t.Fatalf("artifact.published events after replay = %d, want 1", got)
	}
	if got := avTaskRevision(t, dbName, avEditableTaskID); got != 1 {
		t.Fatalf("task revision after replay = %d, want 1", got)
	}

	// The same key with a different body is a client bug, not a retry.
	conflict := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avEditableArtifact),
		token, avBody("aversion-replay-01", 1, "# 另一份编辑"))
	assertAPICode(t, conflict, http.StatusConflict, "idempotency_key_conflict")
	if got := avVersionCount(t, dbName, avEditableArtifact); got != 2 {
		t.Fatalf("version rows after key conflict = %d, want 2", got)
	}
}

func TestCreateArtifactVersionBaseMustBeThePublishedHead(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	avSeedArtifact(t, dbName, avEditableTaskID, avEditableArtifact, store, "# 第一版")
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)

	avCreate(t, server.URL, avEditableArtifact, token, avBody("aversion-base-000001", 1, "# 第二版"))

	stale := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avEditableArtifact),
		token, avBody("aversion-base-000002", 1, "# 第三版"))
	if stale.StatusCode != http.StatusConflict {
		t.Fatalf("stale base status = %d body=%s", stale.StatusCode, readBody(stale))
	}
	payload := avDecodeError(t, stale)
	if payload.Code != "version_conflict" {
		t.Fatalf("code = %s", payload.Code)
	}
	// work.create_user_artifact_version puts the published head in DETAIL and the
	// client needs it to reload instead of guessing - the same detail requirement
	// 0025 had to supply for provider config.
	if payload.CurrentRevision == nil || *payload.CurrentRevision != 2 {
		t.Fatalf("current_revision = %v, want 2", payload.CurrentRevision)
	}

	zero := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avEditableArtifact),
		token, avBody("aversion-base-000003", 0, "# 第X版"))
	assertAPICode(t, zero, http.StatusBadRequest, "invalid_request")
	if got := avVersionCount(t, dbName, avEditableArtifact); got != 2 {
		t.Fatalf("version rows = %d, want 2 (v1 seeded, v2 published)", got)
	}
}

func TestCreateArtifactVersionStateGatesStayConflicts(t *testing.T) {
	cases := []struct {
		name string
		seed func(t *testing.T, dbName string)
		code string
	}{
		{
			name: "active run",
			seed: func(t *testing.T, dbName string) {},
			code: "run_not_quiescent",
		},
		{
			name: "task completed",
			seed: func(t *testing.T, dbName string) {
				avUpdateTask(t, dbName, avBusyTaskID, "state = 'completed', active_run_id = NULL")
			},
			code: "artifact_read_only",
		},
		{
			// The UI shows a failed run's artifact as read-only until a later run
			// succeeds, so this is the contract's other 409 reason. Both read-only
			// branches raise without a revision DETAIL, which used to arrive at the
			// client as 503 service_degraded.
			name: "latest run failed",
			seed: func(t *testing.T, dbName string) {
				avSetRunState(t, dbName, avBusyRunID, "failed")
				avUpdateTask(t, dbName, avBusyTaskID, "active_run_id = NULL")
			},
			code: "artifact_read_only",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pool, dbName := newBootstrapDB(t, true, true)
			seedTaskGraph(t, dbName)
			store := newTestContentStore(t)
			avSeedArtifact(t, dbName, avBusyTaskID, avBusyArtifact, store, "# 第一版")
			tc.seed(t, dbName)
			server := newHTTPServerWithContent(t, pool, store)
			token := bootstrapCSRF(t, server.URL)

			response := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avBusyArtifact),
				token, avBody("aversion-state-0001", 1, "# 第二版"))
			if response.StatusCode != http.StatusConflict {
				t.Fatalf("status = %d body=%s, want 409 %s", response.StatusCode,
					readBody(response), tc.code)
			}
			if got := avDecodeError(t, response).Code; got != tc.code {
				t.Fatalf("code = %s, want %s", got, tc.code)
			}
			if got := avVersionCount(t, dbName, avBusyArtifact); got != 1 {
				t.Fatalf("version rows = %d, want 1", got)
			}
		})
	}
}

func TestCreateArtifactVersionRefusesForeignMissingAndMalformed(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	avSeedArtifact(t, dbName, avForeignTaskID, avForeignArtifactID, store, "# 别人的成果")
	avSeedArtifact(t, dbName, avEditableTaskID, avEditableArtifact, store, "# 第一版")
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)

	// Another member's artifact and a id that does not exist answer alike, so the
	// endpoint does not enumerate who owns what.
	foreign := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avForeignArtifactID),
		token, avBody("aversion-scope-00001", 1, "# 改一笔"))
	assertAPICode(t, foreign, http.StatusNotFound, "artifact_not_found")
	missing := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avMissingArtifact),
		token, avBody("aversion-scope-00002", 1, "# 改一笔"))
	assertAPICode(t, missing, http.StatusNotFound, "artifact_not_found")
	notUUID := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, "not-a-uuid"),
		token, avBody("aversion-scope-00003", 1, "# 改一笔"))
	assertAPICode(t, notUUID, http.StatusNotFound, "artifact_not_found")

	noCSRF := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avEditableArtifact),
		"", avBody("aversion-csrf-00001", 1, "# 改一笔"))
	assertAPICode(t, noCSRF, http.StatusForbidden, "csrf_invalid")

	malformed := []struct {
		name string
		body string
	}{
		{"empty content", `{"client_request_id":"aversion-bad-000001","base_version_no":1,"content":""}`},
		{"missing content", `{"client_request_id":"aversion-bad-000002","base_version_no":1}`},
		{"missing request id", `{"base_version_no":1,"content":"正文"}`},
		{"short request id", `{"client_request_id":"short","base_version_no":1,"content":"正文"}`},
		{"unknown field", `{"client_request_id":"aversion-bad-000003","base_version_no":1,` +
			`"content":"正文","admin":true}`},
		{"trailing json", avBody("aversion-bad-000004", 1, "正文") + ` {"base_version_no":2}`},
		{"bad media type", `{"client_request_id":"aversion-bad-000005","base_version_no":1,` +
			`"content":"正文","media_type":"application/pdf"}`},
		{"base beyond int4", `{"client_request_id":"aversion-bad-000008","base_version_no":2147483648,` +
			`"content":"正文"}`},
		{"oversized content", avBody("aversion-bad-000006", 1, strings.Repeat("字", 262145))},
		{"blank logical name", `{"client_request_id":"aversion-bad-000007","base_version_no":1,` +
			`"content":"正文","logical_name":"  "}`},
	}
	for _, tc := range malformed {
		response := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avEditableArtifact),
			token, tc.body)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d body=%s", tc.name, response.StatusCode, readBody(response))
		}
		response.Body.Close()
	}
	if got := avVersionCount(t, dbName, avForeignArtifactID); got != 1 {
		t.Fatalf("foreign artifact version rows = %d, want 1", got)
	}
	if got := avVersionCount(t, dbName, avEditableArtifact); got != 1 {
		t.Fatalf("editable artifact version rows = %d, want 1 (still only v1)", got)
	}

	// A viewer may read the workspace but has no write surface at all. This runs
	// last because every request above needs a writer to reach its own refusal.
	avSetMemberRole(t, dbName, "viewer")
	viewer := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avEditableArtifact),
		token, avBody("aversion-role-000001", 1, "# 第二版"))
	assertAPICode(t, viewer, http.StatusForbidden, "forbidden")
}

func TestCreateArtifactVersionLogicalNameCannotRenameTheArtifact(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	avSeedArtifact(t, dbName, avEditableTaskID, avEditableArtifact, store, "# 第一版")
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)

	mismatch := taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avEditableArtifact),
		token, `{"client_request_id":"aversion-name-000001","base_version_no":1,`+
			`"content":"正文","logical_name":"other"}`)
	assertAPICode(t, mismatch, http.StatusBadRequest, "invalid_request")
	if got := avVersionCount(t, dbName, avEditableArtifact); got != 1 {
		t.Fatalf("version rows after rename attempt = %d, want 1", got)
	}
	if got := avArtifactLogicalName(t, dbName); got != "result" {
		t.Fatalf("logical name = %q, want the original", got)
	}

	matching := avCreate(t, server.URL, avEditableArtifact, token,
		`{"client_request_id":"aversion-name-000002","base_version_no":1,`+
			`"content":"正文","logical_name":"result"}`)
	if matching.VersionNo != 2 || matching.LogicalName != "result" {
		t.Fatalf("version = %#v", matching)
	}
	if got := avVersionCount(t, dbName, avEditableArtifact); got != 2 {
		t.Fatalf("version rows = %d, want 2", got)
	}
}

func TestCreateArtifactVersionMediaTypeAndMissingStore(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	avSeedArtifact(t, dbName, avEditableTaskID, avEditableArtifact, store, "# 第一版")
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)

	version := avCreate(t, server.URL, avEditableArtifact, token,
		`{"client_request_id":"aversion-media-00001","base_version_no":1,`+
			`"content":"纯文本","media_type":"text/plain"}`)
	if version.MediaType != "text/plain" || version.Bytes != int64(len("纯文本")) ||
		version.VersionNo != 2 {
		t.Fatalf("version = %#v", version)
	}
	served := taskRequest(t, http.MethodGet,
		server.URL+"/work/v1/artifacts/"+avEditableArtifact+"/versions/2/content", "", "")
	if served.StatusCode != http.StatusOK ||
		served.Header.Get("Content-Type") != "text/plain; charset=utf-8" {
		t.Fatalf("content status = %d type = %q", served.StatusCode,
			served.Header.Get("Content-Type"))
	}
	served.Body.Close()

	// Without a Content Store the body cannot be made durable, so the write fails
	// closed instead of recording a reference to nothing.
	bare := newHTTPServerWithContent(t, pool, nil)
	bareToken := bootstrapCSRF(t, bare.URL)
	offline := taskRequest(t, http.MethodPost, avVersionsURL(bare.URL, avEditableArtifact),
		bareToken, avBody("aversion-store-00001", 2, "# 第三版"))
	assertAPICode(t, offline, http.StatusServiceUnavailable, "service_degraded")
	if got := avVersionCount(t, dbName, avEditableArtifact); got != 2 {
		t.Fatalf("version rows after store outage = %d, want 2", got)
	}
}

func avDecodeError(t *testing.T, response *http.Response) apierr.Payload {
	t.Helper()
	defer response.Body.Close()
	var payload apierr.Payload
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode error payload: %v", err)
	}
	return payload
}

func avAdminConn(t *testing.T, dbName string) *pgx.Conn {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', false)`); err != nil {
		t.Fatal(err)
	}
	return conn
}

func avVersionCount(t *testing.T, dbName, artifactID string) int {
	t.Helper()
	var count int
	if err := avAdminConn(t, dbName).QueryRow(context.Background(),
		`SELECT count(*) FROM work.artifact_version WHERE artifact_id = $1 AND org_id = 'org_a'`,
		artifactID,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func avArtifactRevision(t *testing.T, dbName string) int64 {
	t.Helper()
	var revision int64
	if err := avAdminConn(t, dbName).QueryRow(context.Background(),
		`SELECT revision FROM work.artifact WHERE id = $1 AND org_id = 'org_a'`,
		avEditableArtifact,
	).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	return revision
}

func avArtifactLogicalName(t *testing.T, dbName string) string {
	t.Helper()
	var name string
	if err := avAdminConn(t, dbName).QueryRow(context.Background(),
		`SELECT logical_name FROM work.artifact WHERE id = $1 AND org_id = 'org_a'`,
		avEditableArtifact,
	).Scan(&name); err != nil {
		t.Fatal(err)
	}
	return name
}

func avTaskRevision(t *testing.T, dbName, taskID string) int64 {
	t.Helper()
	var revision int64
	if err := avAdminConn(t, dbName).QueryRow(context.Background(),
		`SELECT revision FROM work.task WHERE id = $1 AND org_id = 'org_a'`, taskID,
	).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	return revision
}

func avTaskEventCount(t *testing.T, dbName, eventType string) int {
	t.Helper()
	var count int
	if err := avAdminConn(t, dbName).QueryRow(context.Background(),
		`SELECT count(*) FROM work.task_event WHERE org_id = 'org_a' AND type = $1`, eventType,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func avAuditCount(t *testing.T, dbName, action string) int {
	t.Helper()
	var count int
	if err := avAdminConn(t, dbName).QueryRow(context.Background(),
		`SELECT count(*) FROM work.audit_event WHERE org_id = 'org_a' AND action = $1`, action,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func avUpdateTask(t *testing.T, dbName, taskID, set string) {
	t.Helper()
	if _, err := avAdminConn(t, dbName).Exec(context.Background(),
		"UPDATE work.task SET "+set+" WHERE id = $1 AND org_id = 'org_a'", taskID); err != nil {
		t.Fatal(err)
	}
}

func avSetMemberRole(t *testing.T, dbName, role string) {
	t.Helper()
	if _, err := avAdminConn(t, dbName).Exec(context.Background(),
		`UPDATE work.member SET role = $1 WHERE org_id = 'org_a' AND subject_id = 'sub_a'`,
		role); err != nil {
		t.Fatal(err)
	}
}

func avSetRunState(t *testing.T, dbName, runID, state string) {
	t.Helper()
	if _, err := avAdminConn(t, dbName).Exec(context.Background(),
		"UPDATE work.run SET state = $2 WHERE id = $1 AND org_id = 'org_a'", runID,
		state); err != nil {
		t.Fatal(err)
	}
}
