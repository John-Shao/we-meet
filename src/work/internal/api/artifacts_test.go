package api_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/testpg"
)

const (
	artifactA       = "51111111-1111-4111-8111-111111111111"
	artifactC       = "51111111-1111-4111-8111-333333333333"
	artifactD       = "51111111-1111-4111-8111-444444444444"
	artifactStaged  = "51111111-1111-4111-8111-222222222222"
	artifactCorrupt = "51111111-1111-4111-8111-555555555555"
)

type artifactSeed struct {
	artifactID   string
	orgID        string
	taskID       string
	logicalName  string
	content      string
	versionState string
	contentHash  string
}

func TestArtifactVersionMetadataAndContent(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: artifactA, orgID: "org_a", taskID: "11111111-1111-4111-8111-111111111111",
		logicalName: "result", content: "# 上线计划\n\n第一行", versionState: "published",
	})

	server := newHTTPServerWithContent(t, pool, store)
	metadataURL := server.URL + "/work/v1/artifacts/" + artifactA + "/versions/1"
	response := taskRequest(t, http.MethodGet, metadataURL, "", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("metadata status = %d body=%s", response.StatusCode, readBody(response))
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
	assertExactKeys(t, raw, "artifact_id", "version_no", "logical_name", "media_type", "bytes",
		"content_hash", "state", "content_url", "created_at", "published_at")
	var version api.ArtifactVersion
	if err := json.Unmarshal(body, &version); err != nil {
		t.Fatal(err)
	}
	if version.ArtifactID != artifactA || version.VersionNo != 1 || version.LogicalName != "result" ||
		version.MediaType != "text/markdown" || version.Bytes != int64(len("# 上线计划\n\n第一行")) ||
		version.State != "published" || !strings.HasSuffix(version.ContentURL, "/work/v1/artifacts/"+artifactA+"/versions/1/content") ||
		version.ContentHash == "" || version.PublishedAt == nil {
		t.Fatalf("version = %#v", version)
	}

	inline := taskRequest(t, http.MethodGet, metadataURL+"/content", "", "")
	if inline.StatusCode != http.StatusOK {
		t.Fatalf("inline status = %d body=%s", inline.StatusCode, readBody(inline))
	}
	inlineBody, _ := io.ReadAll(inline.Body)
	inline.Body.Close()
	if string(inlineBody) != "# 上线计划\n\n第一行" ||
		inline.Header.Get("Content-Type") != "text/markdown; charset=utf-8" ||
		inline.Header.Get("Cache-Control") != "no-store" ||
		inline.Header.Get("X-Content-Type-Options") != "nosniff" ||
		inline.Header.Get("Content-Disposition") != "" {
		t.Fatalf("inline headers=%v body=%q", inline.Header, inlineBody)
	}
	if got := auditExportCount(t, dbName, artifactA); got != 0 {
		t.Fatalf("inline audit count = %d", got)
	}

	attachment := taskRequest(t, http.MethodGet, metadataURL+"/content?disposition=attachment", "", "")
	if attachment.StatusCode != http.StatusOK {
		t.Fatalf("attachment status = %d body=%s", attachment.StatusCode, readBody(attachment))
	}
	attachmentBody, _ := io.ReadAll(attachment.Body)
	attachment.Body.Close()
	if string(attachmentBody) != "# 上线计划\n\n第一行" {
		t.Fatalf("attachment body = %q", attachmentBody)
	}
	expectedDisposition := `attachment; filename="work-51111111-v1.md"; filename*=UTF-8''Task%20A-v1.md`
	if got := attachment.Header.Get("Content-Disposition"); got != expectedDisposition {
		t.Fatalf("content-disposition = %q, want %q", got, expectedDisposition)
	}
	if got := auditExportCount(t, dbName, artifactA); got != 1 {
		t.Fatalf("attachment audit count = %d", got)
	}
	if got := auditExportMetadataContains(t, dbName, artifactA, "第一行"); got {
		t.Fatal("export audit contains artifact body")
	}
}

func TestArtifactReadRejectsForeignUnpublishedAndCorrupt(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: artifactC, orgID: "org_a", taskID: "11111111-1111-4111-8111-333333333333",
		logicalName: "result", content: "other owner", versionState: "published",
	})
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: artifactD, orgID: "org_other", taskID: "11111111-1111-4111-8111-444444444444",
		logicalName: "result", content: "other org", versionState: "published",
	})
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: artifactStaged, orgID: "org_a", taskID: "11111111-1111-4111-8111-111111111111",
		logicalName: "staged", content: "staged", versionState: "staged",
	})
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: artifactCorrupt, orgID: "org_a", taskID: "11111111-1111-4111-8111-111111111111",
		logicalName: "corrupt", content: "corrupt", versionState: "published",
		contentHash: "sha256:deadbeef",
	})
	server := newHTTPServerWithContent(t, pool, store)

	for _, path := range []string{
		"/work/v1/artifacts/" + artifactC + "/versions/1",
		"/work/v1/artifacts/" + artifactD + "/versions/1",
		"/work/v1/artifacts/" + artifactStaged + "/versions/1",
		"/work/v1/artifacts/" + artifactA + "/versions/1",
		"/work/v1/artifacts/not-a-uuid/versions/1",
		"/work/v1/artifacts/" + artifactA + "/versions/0",
	} {
		response := taskRequest(t, http.MethodGet, server.URL+path, "", "")
		assertAPICode(t, response, http.StatusNotFound, "artifact_not_found")
	}
	response := taskRequest(t, http.MethodGet,
		server.URL+"/work/v1/artifacts/"+artifactA+"/versions/1/content?disposition=weird", "", "")
	assertAPICode(t, response, http.StatusBadRequest, "invalid_request")
	response = taskRequest(t, http.MethodGet,
		server.URL+"/work/v1/artifacts/"+artifactCorrupt+"/versions/1/content", "", "")
	assertAPICode(t, response, http.StatusServiceUnavailable, "service_degraded")
	response = taskRequest(t, http.MethodGet,
		server.URL+"/work/v1/artifacts/"+artifactStaged+"/versions/1/content", "", "")
	assertAPICode(t, response, http.StatusNotFound, "artifact_not_found")
}

func TestTaskArtifactWorkspaceDeepLinkAuthorization(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: artifactA, orgID: "org_a", taskID: "11111111-1111-4111-8111-111111111111",
		logicalName: "result", content: "version one", versionState: "published",
	})
	seedArtifactVersion(t, dbName, store, "org_a", artifactA, 2, "version two", "published")
	seedAcceptance(t, dbName, "org_a", "11111111-1111-4111-8111-111111111111", artifactA, 1)
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: artifactC, orgID: "org_a", taskID: "11111111-1111-4111-8111-333333333333",
		logicalName: "result", content: "other owner", versionState: "published",
	})
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: artifactD, orgID: "org_other", taskID: "11111111-1111-4111-8111-444444444444",
		logicalName: "result", content: "other org", versionState: "published",
	})

	server := newHTTPServerWithContent(t, pool, store)
	workspaceURL := server.URL + "/work/v1/tasks/11111111-1111-4111-8111-111111111111/artifacts/" + artifactA
	response := taskRequest(t, http.MethodGet, workspaceURL, "", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("workspace status = %d body=%s", response.StatusCode, readBody(response))
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
	assertExactKeys(t, raw, "summary", "artifact")
	var artifactRaw map[string]json.RawMessage
	if err := json.Unmarshal(raw["artifact"], &artifactRaw); err != nil {
		t.Fatal(err)
	}
	assertExactKeys(t, artifactRaw, "artifact_id", "logical_name", "state", "revision",
		"created_at", "updated_at", "accepted_version_no", "versions")
	var workspace api.TaskArtifactWorkspace
	if err := json.Unmarshal(body, &workspace); err != nil {
		t.Fatal(err)
	}
	if workspace.Summary.Title != "Task A" || workspace.Artifact.ArtifactID != artifactA ||
		workspace.Artifact.AcceptedVersionNo == nil || *workspace.Artifact.AcceptedVersionNo != 1 ||
		len(workspace.Artifact.Versions) != 2 {
		t.Fatalf("workspace = %#v", workspace)
	}
	latest := workspace.Artifact.Versions[0]
	if latest.VersionNo != 2 || latest.ContentHash == "" ||
		!strings.HasSuffix(latest.ContentURL,
			"/work/v1/tasks/11111111-1111-4111-8111-111111111111/artifacts/"+artifactA+"/versions/2/content") {
		t.Fatalf("latest version = %#v", latest)
	}

	versionURL := workspaceURL + "/versions/2"
	versionResponse := taskRequest(t, http.MethodGet, versionURL, "", "")
	if versionResponse.StatusCode != http.StatusOK {
		t.Fatalf("version status = %d body=%s", versionResponse.StatusCode, readBody(versionResponse))
	}
	var version api.ArtifactVersion
	if err := json.NewDecoder(versionResponse.Body).Decode(&version); err != nil {
		t.Fatal(err)
	}
	versionResponse.Body.Close()
	if version.VersionNo != 2 || !strings.HasSuffix(version.ContentURL,
		"/work/v1/tasks/11111111-1111-4111-8111-111111111111/artifacts/"+artifactA+"/versions/2/content") {
		t.Fatalf("version = %#v", version)
	}
	contentResponse := taskRequest(t, http.MethodGet, versionURL+"/content", "", "")
	if contentResponse.StatusCode != http.StatusOK {
		t.Fatalf("content status = %d body=%s", contentResponse.StatusCode, readBody(contentResponse))
	}
	contentBody, _ := io.ReadAll(contentResponse.Body)
	contentResponse.Body.Close()
	if string(contentBody) != "version two" {
		t.Fatalf("content body = %q", contentBody)
	}

	for _, path := range []string{
		"/work/v1/tasks/11111111-1111-4111-8111-222222222222/artifacts/" + artifactA,
		"/work/v1/tasks/11111111-1111-4111-8111-333333333333/artifacts/" + artifactC,
		"/work/v1/tasks/11111111-1111-4111-8111-444444444444/artifacts/" + artifactD,
		"/work/v1/tasks/not-a-uuid/artifacts/" + artifactA,
		"/work/v1/tasks/11111111-1111-4111-8111-111111111111/artifacts/not-a-uuid",
	} {
		response := taskRequest(t, http.MethodGet, server.URL+path, "", "")
		assertAPICode(t, response, http.StatusNotFound, "artifact_not_found")
	}
	response = taskRequest(t, http.MethodGet,
		server.URL+"/work/v1/tasks/11111111-1111-4111-8111-222222222222/artifacts/"+artifactA+"/versions/2/content", "", "")
	assertAPICode(t, response, http.StatusNotFound, "artifact_not_found")
}

func TestArtifactContentRequiresStoreAndSeat(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: artifactA, orgID: "org_a", taskID: "11111111-1111-4111-8111-111111111111",
		logicalName: "result", content: "hello", versionState: "published",
	})
	noStore := newHTTPServerWithContent(t, pool, nil)
	response := taskRequest(t, http.MethodGet,
		noStore.URL+"/work/v1/artifacts/"+artifactA+"/versions/1/content", "", "")
	assertAPICode(t, response, http.StatusServiceUnavailable, "service_degraded")

	noSeatPool, noSeatDB := newBootstrapDB(t, true, true, true, false)
	seedTaskGraph(t, noSeatDB)
	noSeatStore := newTestContentStore(t)
	seedArtifact(t, noSeatDB, noSeatStore, artifactSeed{
		artifactID: artifactA, orgID: "org_a", taskID: "11111111-1111-4111-8111-111111111111",
		logicalName: "result", content: "hello", versionState: "published",
	})
	noSeat := newHTTPServerWithContent(t, noSeatPool, noSeatStore)
	response = taskRequest(t, http.MethodGet,
		noSeat.URL+"/work/v1/artifacts/"+artifactA+"/versions/1", "", "")
	assertAPICode(t, response, http.StatusForbidden, "work_seat_required")
	response = taskRequest(t, http.MethodGet,
		noSeat.URL+"/work/v1/artifacts/"+artifactA+"/versions/1/content", "", "")
	assertAPICode(t, response, http.StatusForbidden, "work_seat_required")
	response = taskRequest(t, http.MethodGet,
		noSeat.URL+"/work/v1/tasks/11111111-1111-4111-8111-111111111111/artifacts/"+artifactA, "", "")
	assertAPICode(t, response, http.StatusForbidden, "work_seat_required")
	response = taskRequest(t, http.MethodGet,
		noSeat.URL+"/work/v1/tasks/11111111-1111-4111-8111-111111111111/artifacts/"+artifactA+"/versions/1", "", "")
	assertAPICode(t, response, http.StatusForbidden, "work_seat_required")
}

func seedArtifact(t *testing.T, dbName string, store content.Store, seed artifactSeed) {
	t.Helper()
	ctx := context.Background()
	ref, err := store.Put(ctx, seed.orgID, []byte(seed.content))
	if err != nil {
		t.Fatal(err)
	}
	if seed.contentHash != "" {
		ref.Hash = seed.contentHash
	}
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', $1, false)`, seed.orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO work.artifact (id, org_id, task_id, logical_name, state, revision)
		VALUES ($1, $2, $3, $4, 'published', 0)`,
		seed.artifactID, seed.orgID, seed.taskID, seed.logicalName); err != nil {
		t.Fatal(err)
	}
	var publishedAt any
	if seed.versionState == "published" {
		publishedAt = time.Now()
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_ref, content_hash, bytes,
		   media_type, state, provenance, published_at)
		VALUES ($1, $2, 1, $3, $4, $5, 'text/markdown', $6, '{}'::jsonb, $7)`,
		seed.artifactID, seed.orgID, ref.ContentRef, ref.Hash, ref.Bytes,
		seed.versionState, publishedAt); err != nil {
		t.Fatal(err)
	}
}

func seedArtifactVersion(
	t *testing.T,
	dbName string,
	store content.Store,
	orgID, artifactID string,
	versionNo int,
	contentText, state string,
) {
	t.Helper()
	ctx := context.Background()
	ref, err := store.Put(ctx, orgID, []byte(contentText))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', $1, false)`, orgID); err != nil {
		t.Fatal(err)
	}
	var publishedAt any
	if state == "published" {
		publishedAt = time.Now()
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_ref, content_hash, bytes,
		   media_type, state, provenance, published_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'text/markdown', $7, '{}'::jsonb, $8)`,
		artifactID, orgID, versionNo, ref.ContentRef, ref.Hash, ref.Bytes,
		state, publishedAt); err != nil {
		t.Fatal(err)
	}
}

func seedAcceptance(
	t *testing.T,
	dbName, orgID, taskID, artifactID string,
	versionNo int,
) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', $1, false)`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO work.acceptance
		  (org_id, task_id, artifact_id, version_no, actor_subject_id, task_revision)
		VALUES ($1, $2, $3, $4, 'sub_a', 2)`,
		orgID, taskID, artifactID, versionNo); err != nil {
		t.Fatal(err)
	}
}

func auditExportCount(t *testing.T, dbName, artifactID string) int {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var count int
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = 'org_a' AND action = 'artifact.exported' AND target_id = $1`,
		artifactID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func auditExportMetadataContains(t *testing.T, dbName, artifactID, fragment string) bool {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var found bool
	if err := conn.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM work.audit_event
		  WHERE org_id = 'org_a' AND action = 'artifact.exported'
		    AND target_id = $1 AND metadata::text LIKE '%' || $2 || '%'
		)`, artifactID, fragment).Scan(&found); err != nil {
		t.Fatal(err)
	}
	return found
}
