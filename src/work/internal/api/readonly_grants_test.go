package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

// seedReadonlyGrant builds the chain a readonly_approval_grant FK requires: a Run
// with its task/snapshot/input graph, then the grant row referencing the device
// and workspace grant created over the Bearer face. The grant starts active at
// revision 0 so the revoke CAS has a known expectation.
func seedReadonlyGrant(t *testing.T, dbName, deviceID, workspaceGrantID string) (string, string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	const (
		runID      = "22222222-2222-4222-8222-222222222222"
		taskID     = "33333333-3333-4333-8333-333333333333"
		snapshotID = "44444444-4444-4444-8444-444444444444"
		inputID    = "55555555-5555-4555-8555-555555555555"
		grantID    = "66666666-6666-4666-8666-666666666666"
	)
	script := `
		SET app.org_id = '` + testOrg + `';
		SET app.subject_id = '` + testSubject + `';
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status)
		VALUES ('` + inputID + `', '` + testOrg + `', '` + testSubject + `', 'ref', '` + strings.Repeat("b", 64) + `', 1, 'text/plain', 'active');
		INSERT INTO work.capability_snapshot (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		VALUES ('` + snapshotID + `', '` + testOrg + `', '` + taskID + `', 'v1', '` + strings.Repeat("a", 64) + `', ARRAY['workspace.read'], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, input_id, title)
		VALUES ('` + taskID + `', '` + testOrg + `', '` + testSubject + `', 'open', '` + snapshotID + `', '` + inputID + `', 'readonly');
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, wait_reason, snapshot_id, workflow_id, runtime_version)
		VALUES ('` + runID + `', '` + testOrg + `', '` + taskID + `', 1, 'waiting', 'input', '` + snapshotID + `', 'wf-readonly', 'v1');
		INSERT INTO work.readonly_approval_grant
			(id, org_id, owner_subject_id, run_id, device_id, workspace_grant_id, grant_revision,
			 tool_set, resource_selector_hash, policy_epoch, access_epoch, expires_at, status, revision)
		VALUES ('` + grantID + `', '` + testOrg + `', '` + testSubject + `', '` + runID + `', '` + deviceID + `', '` + workspaceGrantID + `', 1,
			ARRAY['workspace.list','workspace.read'], '` + strings.Repeat("d", 64) + `', 0, 0, now() + interval '1 hour', 'active', 0);
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
	return grantID, runID
}

func TestReadonlyGrantListAndRevoke(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)

	deviceID, ticket := pairConfirmMint(t, server.URL, "ro1")
	sessionID := activateDeviceSession(t, dbName, deviceID, ticket)
	wsBody := `{"device_id":"` + deviceID + `","session_id":"` + sessionID +
		`","client_request_id":"ws-ro1","grant":{"root_identity_hash":"` + strings.Repeat("e", 64) +
		`","allowed_tools":["workspace.list","workspace.read"],"matched_rule_index":0}}`
	wsGrant := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+api.WorkspaceGrantsPath, wsBody))
	readonlyID, runID := seedReadonlyGrant(t, dbName, deviceID, wsGrant["grant_id"].(string))
	csrf := bootstrapCSRF(t, server.URL)

	// The owner reads their own Run's grants on the cookie plane.
	list := decodeObject(t, taskRequest(t, http.MethodGet, server.URL+api.ReadonlyGrantsPath+"?run_id="+runID, "", ""))
	grants, _ := list["grants"].([]any)
	if len(grants) != 1 {
		t.Fatalf("grants = %#v, want one", list["grants"])
	}
	grant, _ := grants[0].(map[string]any)
	if grant["id"] != readonlyID || grant["status"] != "active" {
		t.Fatalf("grant = %#v", grant)
	}

	revokePath := strings.ReplaceAll(api.ReadonlyGrantRevokePath, "{grantId}", readonlyID)
	// A stale expected revision is a CAS conflict, not a silent revoke.
	stale := taskRequest(t, http.MethodPost, server.URL+revokePath, csrf,
		`{"client_request_id":"ro-revoke-1","expected_revision":99}`)
	assertAPICode(t, stale, http.StatusConflict, "idempotency_key_conflict")

	// The matching revision revokes and bumps the revision.
	response := taskRequest(t, http.MethodPost, server.URL+revokePath, csrf,
		`{"client_request_id":"ro-revoke-2","expected_revision":0}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("revoke status = %d body=%s", response.StatusCode, readBody(response))
	}
	revoked := decodeObject(t, response)
	if revoked["status"] != "revoked" || revoked["revision"] != float64(1) || revoked["grant_id"] != readonlyID {
		t.Fatalf("revoke = %#v", revoked)
	}

	// The same request id replays the original receipt instead of revoking twice.
	replay := decodeObject(t, taskRequest(t, http.MethodPost, server.URL+revokePath, csrf,
		`{"client_request_id":"ro-revoke-2","expected_revision":0}`))
	if replay["replayed"] != true {
		t.Fatalf("replay = %#v", replay)
	}
}