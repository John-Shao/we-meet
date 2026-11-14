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

const (
	rebindRunID  = "88888888-8888-4888-8888-888888888888"
	rebindTaskID = "99999999-9999-4999-8999-999999999999"
	rebindRoot   = "8888888888888888888888888888888888888888888888888888888888888888"
)

// registerRebindGrant registers a workspace grant over the Bearer face on the given root.
// Two grants on the same root/device/owner are the precondition a rebind succession needs.
func registerRebindGrant(t *testing.T, serverURL, deviceID, sessionID, requestID, root string) string {
	t.Helper()
	body := `{"device_id":"` + deviceID + `","session_id":"` + sessionID +
		`","client_request_id":"` + requestID + `","grant":{"root_identity_hash":"` + root +
		`","allowed_tools":["workspace.read"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}}`
	grant := decodeObject(t, deviceRequest(t, http.MethodPost, serverURL+api.WorkspaceGrantsPath, body))
	id, _ := grant["grant_id"].(string)
	if id == "" {
		t.Fatalf("grant %s not registered: %#v", requestID, grant)
	}
	return id
}

// seedRebindGraph puts a Run in waiting(input) with a device_run_binding whose grant_set
// references the old grant — the state §1.4 row 65 requires before a rebind. The binding is
// inserted directly (it has no BEFORE INSERT guard); the grants come from the HTTP face.
func seedRebindGraph(t *testing.T, dbName, deviceID, sessionID, oldGrantID string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	const (
		snapshotID = "aaaaaaaa-1111-4111-8111-111111111111"
		inputID    = "bbbbbbbb-1111-4111-8111-111111111111"
	)
	script := `
		SET app.org_id = '` + testOrg + `';
		SET app.subject_id = '` + testSubject + `';
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status)
		VALUES ('` + inputID + `', '` + testOrg + `', '` + testSubject + `', 'ref', '` + strings.Repeat("a", 64) + `', 1, 'text/plain', 'active');
		INSERT INTO work.capability_snapshot (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		VALUES ('` + snapshotID + `', '` + testOrg + `', '` + rebindTaskID + `', 'v1', '` + strings.Repeat("d", 64) + `', ARRAY['workspace.read'], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, input_id, title)
		VALUES ('` + rebindTaskID + `', '` + testOrg + `', '` + testSubject + `', 'open', '` + snapshotID + `', '` + inputID + `', 'rebind');
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, wait_reason, snapshot_id, workflow_id, runtime_version)
		VALUES ('` + rebindRunID + `', '` + testOrg + `', '` + rebindTaskID + `', 1, 'waiting', 'input', '` + snapshotID + `', 'wf-rebind', 'v1');
		UPDATE work.task SET active_run_id = '` + rebindRunID + `', latest_run_id = '` + rebindRunID + `' WHERE id = '` + rebindTaskID + `';
		INSERT INTO work.device_run_binding
			(org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref, input_hash,
			 snapshot_hash, profile_id, profile_revision, runtime_digest, tool_manifest_hash, model_version,
			 grant_set, start_nonce, offer_expiry, state)
		VALUES ('` + testOrg + `', '` + rebindRunID + `', 1, '` + rebindTaskID + `', '` + deviceID + `', '` + sessionID + `',
			'ref', '` + strings.Repeat("a", 64) + `', '` + strings.Repeat("d", 64) + `', 'p1', 1,
			'` + strings.Repeat("e", 64) + `', '` + strings.Repeat("f", 64) + `', 'm1',
			'[{"grant_id":"` + oldGrantID + `","grant_revision":1}]'::jsonb, gen_random_uuid(), now() + interval '1 hour', 'offered');
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

// grantSuccessionProof renders the GrantSuccessionProof (device §3.5, M1a §12.12). The SQL
// validates the fields inline (0043:1043-1060); the signature is format-only at this layer.
func grantSuccessionProof(sessionID, oldGrant, newGrant, root, nonce string) string {
	return fmt.Sprintf(`{
		"old_grant_id":%q,"new_grant_id":%q,"run_id":%q,"root_identity_hash":%q,
		"session_id":%q,"auth_plane":"bearer","auth_epoch":4,"nonce":%q,
		"expires_at":"2027-01-01T00:00:00Z","signature":"sha256:%s"}`,
		oldGrant, newGrant, rebindRunID, root, sessionID, nonce, strings.Repeat("e", 64))
}

func setupRebind(t *testing.T) (*httptest.Server, string, string, string, string) {
	t.Helper()
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)
	deviceID, ticket := pairConfirmMint(t, server.URL, "rb1")
	sessionID := activateDeviceSession(t, dbName, deviceID, ticket)
	oldGrant := registerRebindGrant(t, server.URL, deviceID, sessionID, "rb-grant-old", rebindRoot)
	newGrant := registerRebindGrant(t, server.URL, deviceID, sessionID, "rb-grant-new", rebindRoot)
	seedRebindGraph(t, dbName, deviceID, sessionID, oldGrant)
	return server, deviceID, sessionID, oldGrant, newGrant
}

func rebindBody(oldGrant, newGrant, proof, requestID string) string {
	return fmt.Sprintf(`{"client_request_id":%q,"old_grant_id":%q,"new_grant_id":%q,"grant_succession_proof":%s}`,
		requestID, oldGrant, newGrant, proof)
}

func TestWorkspaceRebindCreateAndReplay(t *testing.T) {
	server, _, sessionID, oldGrant, newGrant := setupRebind(t)
	path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
	proof := grantSuccessionProof(sessionID, oldGrant, newGrant, rebindRoot, "nonce-rebind-1")

	response := deviceRequest(t, http.MethodPost, server.URL+path, rebindBody(oldGrant, newGrant, proof, "rebind-0001"))
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("rebind status = %d body=%s", response.StatusCode, readBody(response))
	}
	rebound := decodeObject(t, response)
	if rebound["binding_revision"] != float64(2) || rebound["state"] != "offered" ||
		rebound["old_grant_id"] != oldGrant || rebound["new_grant_id"] != newGrant || rebound["replayed"] != false {
		t.Fatalf("rebound = %#v", rebound)
	}

	replay := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+path, rebindBody(oldGrant, newGrant, proof, "rebind-0001")))
	if replay["replayed"] != true || replay["binding_revision"] != float64(2) {
		t.Fatalf("replay = %#v", replay)
	}
}

func TestWorkspaceRebindIdentityChanged(t *testing.T) {
	server, _, sessionID, oldGrant, newGrant := setupRebind(t)
	path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
	// The proof names a root the new grant does not have: a different directory, so the
	// rebind is refused with the public 409 and the Run can only end.
	proof := grantSuccessionProof(sessionID, oldGrant, newGrant, strings.Repeat("1", 64), "nonce-rebind-2")
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path, rebindBody(oldGrant, newGrant, proof, "rebind-0002")),
		http.StatusConflict, "workspace_identity_changed")
}

func TestWorkspaceRebindRequiresBearer(t *testing.T) {
	server, _, _, _, _ := setupRebind(t)
	path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
	csrf := bootstrapCSRF(t, server.URL)
	response := taskRequest(t, http.MethodPost, server.URL+path, csrf, `{"client_request_id":"rebind-0003"}`)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("cookie-plane status = %d, want 401", response.StatusCode)
	}
}