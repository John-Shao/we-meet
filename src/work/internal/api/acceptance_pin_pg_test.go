package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

// Acceptance has two request shapes: a completion reason, or the artifact version the
// owner pins. The Work front-end only ever sends the second one - and since the
// artifact editor landed, the version it pins can be one the user just published. The
// shape checks were covered, but nothing asserted the fact the pin is supposed to
// leave behind: work.acceptance carrying artifact_id/version_no with no
// completion_reason, and work.artifact.accepted_version_no pointing at that version.

const pinArtifactID = "61111111-1111-4111-8111-777777777777"

type pinAcceptanceReply struct {
	Acceptance struct {
		ID               string  `json:"id"`
		TaskID           string  `json:"task_id"`
		ArtifactID       *string `json:"artifact_id"`
		VersionNo        *int    `json:"version_no"`
		CompletionReason *string `json:"completion_reason"`
		TaskRevision     int64   `json:"task_revision"`
	} `json:"acceptance"`
	Task api.TaskSummary `json:"task"`
}

// The pin lives in work.acceptance; work.artifact has no accepted_version_no column,
// and the workspace read model derives that field from the newest acceptance row
// (internal/api/artifacts.go:344-355). So the fact is checked in both places: the row
// the command wrote, and the value the UI renders.
func acceptanceFacts(t *testing.T, dbName string) (int, int, bool) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.org_id', 'org_a', false)`); err != nil {
		t.Fatal(err)
	}
	var rows int
	var versionNo int
	var reasonIsNull bool
	if err := conn.QueryRow(ctx, `
		SELECT count(*), max(version_no), coalesce(bool_and(completion_reason IS NULL), false)
		FROM work.acceptance WHERE artifact_id = $1`, pinArtifactID,
	).Scan(&rows, &versionNo, &reasonIsNull); err != nil {
		t.Fatal(err)
	}
	return rows, versionNo, reasonIsNull
}

func workspaceAcceptedVersion(t *testing.T, server, token, taskID string) *int {
	t.Helper()
	response := taskRequest(t, http.MethodGet,
		server+"/work/v1/tasks/"+taskID+"/artifacts/"+pinArtifactID, token, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("workspace status = %d body=%s", response.StatusCode, readBody(response))
	}
	var workspace api.TaskArtifactWorkspace
	if err := json.NewDecoder(response.Body).Decode(&workspace); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	return workspace.Artifact.AcceptedVersionNo
}

func TestAcceptancePinsTheSelectedArtifactVersion(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	store := newTestContentStore(t)
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)
	created := createTaskForTest(t, server.URL, token, "pin-input-0001", "定稿一份纪要", "")
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID:   pinArtifactID,
		orgID:        "org_a",
		taskID:       created.TaskID,
		logicalName:  "result",
		content:      "# 第一版",
		versionState: "published",
	})
	finishRunSucceeded(t, dbName, created.RunID)

	detailResponse := taskRequest(t, http.MethodGet,
		server.URL+"/work/v1/tasks/"+created.TaskID, "", "")
	var detail api.TaskDetail
	if err := json.NewDecoder(detailResponse.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	detailResponse.Body.Close()
	if detail.Summary.TaskState != "awaiting_acceptance" {
		t.Fatalf("task state = %q, want awaiting_acceptance", detail.Summary.TaskState)
	}
	revisionBeforePublish := detail.Summary.Revision

	// Publish a second version through the editor endpoint, so pinning version 1 is a
	// real choice between two published rows rather than a default.
	second := avCreate(t, server.URL, pinArtifactID, token,
		avBody("pin-publish-0001", 1, "# 第二版"))
	if second.VersionNo != 2 {
		t.Fatalf("published version = %d, want 2", second.VersionNo)
	}

	url := server.URL + "/work/v1/tasks/" + created.TaskID + "/acceptances"
	// Publishing moves the task revision, so an acceptance has to be re-anchored -
	// which is what the front-end does by invalidating the task queries after a save.
	// First prove the pre-publish revision is refused, and that the 409 carries the
	// current revision: without that detail the client cannot recover at all.
	stale := readError(t, taskRequest(t, http.MethodPost, url, token,
		`{"client_request_id":"pin-accept-stale","expected_revision":`+
			itoa64(revisionBeforePublish)+`,"artifact_id":"`+pinArtifactID+
			`","version_no":1}`))
	if stale.Status != http.StatusConflict || stale.Code != "version_conflict" ||
		stale.CurrentRevision == nil {
		t.Fatalf("stale acceptance = %#v", stale)
	}

	detailResponse = taskRequest(t, http.MethodGet,
		server.URL+"/work/v1/tasks/"+created.TaskID, "", "")
	if err := json.NewDecoder(detailResponse.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	detailResponse.Body.Close()
	if detail.Summary.Revision != *stale.CurrentRevision {
		t.Fatalf("the 409 detail says %d but the task reads %d",
			*stale.CurrentRevision, detail.Summary.Revision)
	}

	body := `{"client_request_id":"pin-accept-0001","expected_revision":` +
		itoa64(detail.Summary.Revision) + `,"artifact_id":"` + pinArtifactID +
		`","version_no":1}`
	response := taskRequest(t, http.MethodPost, url, token, body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("accept status = %d body=%s", response.StatusCode, readBody(response))
	}
	var result pinAcceptanceReply
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if result.Acceptance.ArtifactID == nil || *result.Acceptance.ArtifactID != pinArtifactID ||
		result.Acceptance.VersionNo == nil || *result.Acceptance.VersionNo != 1 ||
		result.Acceptance.CompletionReason != nil {
		t.Fatalf("acceptance = %#v", result.Acceptance)
	}
	if result.Task.TaskState != "completed" {
		t.Fatalf("task state after acceptance = %q", result.Task.TaskState)
	}

	rows, versionNo, reasonIsNull := acceptanceFacts(t, dbName)
	if rows != 1 || !reasonIsNull {
		t.Fatalf("acceptance rows = %d reason-null = %t, want one pinned row without a reason",
			rows, reasonIsNull)
	}
	if versionNo != 1 {
		t.Fatalf("pinned acceptance version = %d, want 1", versionNo)
	}
	if accepted := workspaceAcceptedVersion(t, server.URL, token, created.TaskID); accepted == nil ||
		*accepted != 1 {
		t.Fatalf("workspace accepted_version_no = %v, want the read model to show 1", accepted)
	}

	// A version published after the pin cannot move it: the task left
	// awaiting_acceptance, and the second acceptance must be refused rather than
	// silently re-pointed.
	switchAttempt := taskRequest(t, http.MethodPost, url, token,
		`{"client_request_id":"pin-accept-0002","expected_revision":`+
			itoa64(result.Task.Revision)+`,"artifact_id":"`+pinArtifactID+
			`","version_no":2}`)
	assertAPICode(t, switchAttempt, http.StatusConflict, "task_not_acceptable")
	afterRows, afterVersion, _ := acceptanceFacts(t, dbName)
	if afterRows != 1 || afterVersion != 1 {
		t.Fatalf("pin moved by a refused acceptance: version=%d rows=%d", afterVersion, afterRows)
	}
	if accepted := workspaceAcceptedVersion(t, server.URL, token, created.TaskID); accepted == nil ||
		*accepted != 1 {
		t.Fatalf("workspace pin moved by a refused acceptance: %v", accepted)
	}
}
