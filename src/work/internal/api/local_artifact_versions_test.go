package api_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

// seedLocalArtifactTask builds the chain a local user-save needs: an owner Task with no
// active Run (the save requires active_run_id IS NULL), its published artifact, and a
// published local_only base version on the caller's device. The base is seeded directly
// rather than through finalize — these cases test the save command, not how the base got
// there (the same choice internal/migrate's userSaveFixture makes). state controls the
// Task lifecycle so the acceptance face can reuse the fixture at awaiting_acceptance.
func seedLocalArtifactTask(t *testing.T, dbName, deviceID, state string) (string, string, string, string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	const (
		taskID     = "22222222-2222-4222-8222-222222222222"
		snapshotID = "33333333-3333-4333-8333-333333333333"
		inputID    = "44444444-4444-4444-8444-444444444444"
		artifactID = "55555555-5555-4555-8555-555555555555"
		baseID     = "66666666-6666-4666-8666-666666666666"
	)
	baseHash := strings.Repeat("b", 64)
	script := `
		SET app.org_id = '` + testOrg + `';
		SET app.subject_id = '` + testSubject + `';
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status)
		VALUES ('` + inputID + `', '` + testOrg + `', '` + testSubject + `', 'ref', '` + strings.Repeat("a", 64) + `', 1, 'text/plain', 'active');
		INSERT INTO work.capability_snapshot (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		VALUES ('` + snapshotID + `', '` + testOrg + `', '` + taskID + `', 'v1', '` + strings.Repeat("d", 64) + `', ARRAY['workspace.read'], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, input_id, title)
		VALUES ('` + taskID + `', '` + testOrg + `', '` + testSubject + `', '` + state + `', '` + snapshotID + `', '` + inputID + `', 'local save');
		INSERT INTO work.artifact (id, org_id, task_id, logical_name, state)
		VALUES ('` + artifactID + `', '` + testOrg + `', '` + taskID + `', 'reports/base.md', 'published');
		INSERT INTO work.artifact_version (artifact_id, org_id, version_no, content_hash, bytes, media_type, state, provenance, published_at, version_id, location, local_ref, device_id, classification, content_ref)
		VALUES ('` + artifactID + `', '` + testOrg + `', 1, '` + baseHash + `', 512, 'text/markdown', 'published', '{}'::jsonb, now(), '` + baseID + `', 'local_only', 'local/base.md', '` + deviceID + `', 'local_only', NULL);
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
	return taskID, artifactID, baseID, baseHash
}

// userVersionProof renders a shape-valid 21-key UserVersionProof (0043
// user_version_proof_valid). The signature lives in the HTTP header, not the payload, so
// there is no signature key; real device-signature verification belongs to M3/M5.
func userVersionProof(deviceID, sessionID, taskID, artifactID, baseHash, versionID, requestID, nonce string) string {
	return fmt.Sprintf(`{
		"v":1,"org_id":%q,"subject_id":%q,"auth_plane":"bearer","auth_epoch":4,
		"device_id":%q,"session_id":%q,"task_id":%q,"artifact_id":%q,
		"base_version_no":1,"base_hash":%q,"version_id":%q,"format":"text/markdown",
		"content_hash":%q,"bytes":512,"classification":"local_only","clipboard_derived":false,
		"clipboard_source_version_ids":[],"client_request_id":%q,"nonce":%q,
		"expires_at":"2027-01-01T00:00:00Z"}`,
		testOrg, testSubject, deviceID, sessionID, taskID, artifactID,
		baseHash, versionID, strings.Repeat("c", 64), requestID, nonce)
}

func setupLocalSave(t *testing.T) (*httptest.Server, string, string, string, string, string, string) {
	t.Helper()
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)
	deviceID, ticket := pairConfirmMint(t, server.URL, "sv1")
	sessionID := activateDeviceSession(t, dbName, deviceID, ticket)
	taskID, artifactID, baseID, baseHash := seedLocalArtifactTask(t, dbName, deviceID, "open")
	return server, deviceID, sessionID, taskID, artifactID, baseID, baseHash
}

func TestLocalArtifactVersionCreateAndReplay(t *testing.T) {
	server, deviceID, sessionID, taskID, artifactID, _, baseHash := setupLocalSave(t)
	path := strings.ReplaceAll(api.LocalArtifactVersionsPath, "{artifactId}", artifactID)
	versionID := "77777777-7777-4777-8777-777777777777"
	proof := userVersionProof(deviceID, sessionID, taskID, artifactID, baseHash, versionID, "save-0001", "nonce-save-1")
	body := `{"kind":"local","client_request_id":"save-0001","device_id":"` + deviceID +
		`","session_id":"` + sessionID + `","local_ref":"local/new.md","user_version_proof":` + proof + `}`

	response := deviceRequest(t, http.MethodPost, server.URL+path, body)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("create status = %d body=%s", response.StatusCode, readBody(response))
	}
	created := decodeObject(t, response)
	if created["version_no"] != float64(2) || created["version_id"] != versionID ||
		created["location"] != "local_only" || created["replayed"] != false {
		t.Fatalf("created = %#v", created)
	}
	if ack, _ := created["publish_ack"].(string); !strings.HasPrefix(ack, "sha256:") {
		t.Fatalf("publish_ack = %#v", created["publish_ack"])
	}

	// The same request id replays the stored version without consuming the nonce again.
	replay := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+path, body))
	if replay["replayed"] != true || replay["version_id"] != versionID {
		t.Fatalf("replay = %#v", replay)
	}
}

func TestLocalArtifactVersionKindCloudIsUnsupported(t *testing.T) {
	server, deviceID, sessionID, taskID, artifactID, _, baseHash := setupLocalSave(t)
	path := strings.ReplaceAll(api.LocalArtifactVersionsPath, "{artifactId}", artifactID)
	proof := userVersionProof(deviceID, sessionID, taskID, artifactID, baseHash,
		"77777777-7777-4777-8777-777777777777", "save-cloud1", "nonce-cloud-1")
	body := `{"kind":"cloud","client_request_id":"save-cloud1","device_id":"` + deviceID +
		`","session_id":"` + sessionID + `","local_ref":"local/new.md","user_version_proof":` + proof + `}`
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path, body),
		http.StatusUnprocessableEntity, "output_unsupported")
}

func TestLocalArtifactVersionStaleBaseIsConflict(t *testing.T) {
	server, deviceID, sessionID, taskID, artifactID, _, _ := setupLocalSave(t)
	path := strings.ReplaceAll(api.LocalArtifactVersionsPath, "{artifactId}", artifactID)
	// base_hash disagrees with the published base version: content_on_original_device.
	proof := userVersionProof(deviceID, sessionID, taskID, artifactID, strings.Repeat("9", 64),
		"77777777-7777-4777-8777-777777777777", "save-stale1", "nonce-stale-1")
	body := `{"kind":"local","client_request_id":"save-stale1","device_id":"` + deviceID +
		`","session_id":"` + sessionID + `","local_ref":"local/new.md","user_version_proof":` + proof + `}`
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path, body),
		http.StatusConflict, "content_on_original_device")
}

func TestLocalArtifactVersionRequiresBearer(t *testing.T) {
	server, _, _, _, artifactID, _, _ := setupLocalSave(t)
	path := strings.ReplaceAll(api.LocalArtifactVersionsPath, "{artifactId}", artifactID)
	csrf := bootstrapCSRF(t, server.URL)
	response := taskRequest(t, http.MethodPost, server.URL+path, csrf, `{"kind":"local"}`)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("cookie-plane status = %d, want 401", response.StatusCode)
	}
}