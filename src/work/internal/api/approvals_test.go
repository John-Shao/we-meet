package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

// seedLocalApproval builds the chain a local approval needs: a Run waiting on
// approval, its operation, the pending approval row, the approval_operation link,
// and the local_action that makes it a LOCAL approval (the read face inner-joins
// local_action, so an R0a cloud approval never appears). The action references the
// workspace grant created over the Bearer face. params_hash and revision are fixed
// so the decision proof has known expectations.
func seedLocalApproval(t *testing.T, dbName, deviceID, wsGrantID string) (string, string, string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	const (
		runID       = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		taskID      = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
		snapshotID  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
		inputID     = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
		operationID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
		approvalID  = "ffffffff-ffff-4fff-8fff-ffffffffffff"
		attemptID   = "11111111-1111-4111-8111-111111111111"
	)
	paramsHash := strings.Repeat("c", 64)
	script := `
		SET app.org_id = '` + testOrg + `';
		SET app.subject_id = '` + testSubject + `';
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status)
		VALUES ('` + inputID + `', '` + testOrg + `', '` + testSubject + `', 'ref', '` + strings.Repeat("b", 64) + `', 1, 'text/plain', 'active');
		INSERT INTO work.capability_snapshot (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		VALUES ('` + snapshotID + `', '` + testOrg + `', '` + taskID + `', 'v1', '` + strings.Repeat("a", 64) + `', ARRAY['workspace.read'], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, input_id, title)
		VALUES ('` + taskID + `', '` + testOrg + `', '` + testSubject + `', 'open', '` + snapshotID + `', '` + inputID + `', 'approval');
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, wait_reason, snapshot_id, workflow_id, runtime_version, admission_access_epoch)
		VALUES ('` + runID + `', '` + testOrg + `', '` + taskID + `', 1, 'waiting', 'approval', '` + snapshotID + `', 'wf-approval', 'v1', 0);
		UPDATE work.task SET active_run_id = '` + runID + `' WHERE id = '` + taskID + `';
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state)
		VALUES ('` + operationID + `', '` + testOrg + `', '` + runID + `', 'step#0', 'tool', '` + strings.Repeat("d", 64) + `', 'waiting_approval');
		INSERT INTO work.approval (id, org_id, target_type, params_hash, scope, risk, expires_at, policy_epoch, status, revision)
		VALUES ('` + approvalID + `', '` + testOrg + `', 'operation', '` + paramsHash + `', '{"summary":"read docs"}'::jsonb, 'low', now() + interval '1 hour', 0, 'pending', 0);
		INSERT INTO work.approval_operation (approval_id, operation_id, org_id)
		VALUES ('` + approvalID + `', '` + operationID + `', '` + testOrg + `');
		INSERT INTO work.local_action
			(org_id, operation_id, attempt_id, action_kind, grant_id, grant_revision,
			 resource_selector_hash, classification, local_payload_ref, request_hash,
			 tool_schema, byte_upper_bound, token_upper_bound)
		VALUES ('` + testOrg + `', '` + operationID + `', '` + attemptID + `', 'workspace.read', '` + wsGrantID + `', 1,
			'` + strings.Repeat("e", 64) + `', 'local_only', 'local-ref', '` + strings.Repeat("f", 64) + `',
			'{}', 1024, 1024);
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
	return approvalID, operationID, runID
}

// approvalProof signs the closed 20-key ApprovalDecisionProof with the paired device key.
func approvalProof(t *testing.T, deviceID, sessionID, approvalID, operationID, decision, nonce string) string {
	t.Helper()
	return approvalProofWithScope(t, deviceID, sessionID, approvalID, operationID, decision, nonce, nil)
}

func approvalProofWithScope(t *testing.T, deviceID, sessionID, approvalID, operationID, decision, nonce string, readonlyScope map[string]any) string {
	t.Helper()
	var readonlyExpiresAt any
	if readonlyScope != nil {
		readonlyExpiresAt = time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	}
	proof := map[string]any{
		"v": 1, "org_id": testOrg, "subject_id": testSubject, "auth_plane": "bearer",
		"auth_epoch": "4", "device_id": deviceID, "session_id": sessionID,
		"approval_id": approvalID, "operation_id": operationID,
		"params_hash": strings.Repeat("c", 64), "expected_revision": "0",
		"decision": decision, "remember_readonly": readonlyScope != nil,
		"readonly_scope": readonlyScope, "readonly_expires_at": readonlyExpiresAt,
		"policy_epoch": "0", "access_epoch": "0", "nonce": nonce,
		"expires_at": time.Now().Add(4 * time.Minute).UTC().Format(time.RFC3339),
	}
	raw, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	preimage, err := devicesig.SignedPayload(devicesig.ApprovalDecisionProofType, raw)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := devicesig.SignES256(deviceTestPrivateKey(), preimage)
	if err != nil {
		t.Fatal(err)
	}
	proof["signature"] = signature
	signed, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	return string(signed)
}

func setupApproval(t *testing.T) (*httptest.Server, string, string, string, string, string) {
	t.Helper()
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)
	deviceID, ticket := pairConfirmMint(t, server.URL, "ap1")
	sessionID := activateDeviceSession(t, dbName, deviceID, ticket)
	wsBody := `{"device_id":"` + deviceID + `","session_id":"` + sessionID +
		`","client_request_id":"ws-ap1","grant":{"root_identity_hash":"` + strings.Repeat("e", 64) +
		`","allowed_tools":["workspace.list","workspace.read"],"matched_rule_index":0}}`
	wsGrant := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+api.WorkspaceGrantsPath, wsBody))
	approvalID, operationID, _ := seedLocalApproval(t, dbName, deviceID, wsGrant["grant_id"].(string))
	return server, dbName, deviceID, sessionID, approvalID, operationID
}

func TestApprovalListGetDecide(t *testing.T) {
	server, _, deviceID, sessionID, approvalID, operationID := setupApproval(t)

	// The owner reads the pending approval on the Bearer plane.
	list := decodeObject(t, deviceRequest(t, http.MethodGet, server.URL+api.ApprovalsPath+"?status=pending", ""))
	approvals, _ := list["approvals"].([]any)
	if len(approvals) != 1 {
		t.Fatalf("approvals = %#v, want one", list["approvals"])
	}
	item, _ := approvals[0].(map[string]any)
	if item["id"] != approvalID || item["status"] != "pending" || item["action_kind"] != "workspace.read" {
		t.Fatalf("approval item = %#v", item)
	}
	if item["device_id"] != deviceID || item["operation_id"] != operationID {
		t.Fatalf("approval binding = %#v", item)
	}
	allowed, _ := item["allowed_decisions"].([]any)
	if len(allowed) != 2 {
		t.Fatalf("allowed_decisions = %#v", item["allowed_decisions"])
	}

	detailPath := strings.ReplaceAll(api.ApprovalDetailPath, "{approvalId}", approvalID)
	detail := decodeObject(t, deviceRequest(t, http.MethodGet, server.URL+detailPath, ""))
	if detail["id"] != approvalID || detail["params_hash"] != strings.Repeat("c", 64) {
		t.Fatalf("detail = %#v", detail)
	}
	scope, _ := detail["readonly_scope"].(map[string]any)
	if tools, _ := scope["tool_set"].([]any); len(tools) != 1 || tools[0] != "workspace.read" ||
		scope["resource_selector_hash"] != strings.Repeat("e", 64) || scope["grant_revision"] != "1" ||
		scope["grant_id"] == nil {
		t.Fatalf("readonly scope = %#v", detail["readonly_scope"])
	}

	// A proof changed after signing is refused before the domain transaction.
	decisionPath := strings.ReplaceAll(api.ApprovalDecisionPath, "{approvalId}", approvalID)
	badProof := strings.ReplaceAll(approvalProof(t, deviceID, sessionID, approvalID, operationID, "approved", "nonce-bad-1"),
		strings.Repeat("c", 64), strings.Repeat("9", 64))
	stale := deviceRequest(t, http.MethodPost, server.URL+decisionPath,
		`{"client_request_id":"dec-bad-0001","decision":`+badProof+`}`)
	assertAPICode(t, stale, http.StatusUnauthorized, "unauthorized")

	// The matching proof approves; the operation becomes authorized.
	proof := approvalProof(t, deviceID, sessionID, approvalID, operationID, "approved", "nonce-ok-1")
	response := deviceRequest(t, http.MethodPost, server.URL+decisionPath,
		`{"client_request_id":"dec-ok-0001","decision":`+proof+`}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("decide status = %d body=%s", response.StatusCode, readBody(response))
	}
	decided := decodeObject(t, response)
	if decided["decision"] != "approved" || decided["replayed"] != false {
		t.Fatalf("decided = %#v", decided)
	}

	// The same request id replays the receipt instead of deciding twice.
	replay := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+decisionPath,
		`{"client_request_id":"dec-ok-0001","decision":`+proof+`}`))
	if replay["replayed"] != true {
		t.Fatalf("replay = %#v", replay)
	}

	// The approval now reads approved with no allowed decisions.
	after := decodeObject(t, deviceRequest(t, http.MethodGet, server.URL+detailPath, ""))
	if after["status"] != "approved" {
		t.Fatalf("after = %#v", after)
	}
	if allowed, _ := after["allowed_decisions"].([]any); len(allowed) != 0 {
		t.Fatalf("allowed_decisions after = %#v", after["allowed_decisions"])
	}
}

func TestApprovalDecisionCanRememberExactReadonlyScope(t *testing.T) {
	server, _, deviceID, sessionID, approvalID, operationID := setupApproval(t)
	detailPath := strings.ReplaceAll(api.ApprovalDetailPath, "{approvalId}", approvalID)
	detail := decodeObject(t, deviceRequest(t, http.MethodGet, server.URL+detailPath, ""))
	scope, _ := detail["readonly_scope"].(map[string]any)
	if scope == nil {
		t.Fatalf("approval detail has no readonly scope: %#v", detail)
	}
	proof := approvalProofWithScope(t, deviceID, sessionID, approvalID, operationID, "approved", "nonce-remember-api", scope)
	decisionPath := strings.ReplaceAll(api.ApprovalDecisionPath, "{approvalId}", approvalID)
	response := deviceRequest(t, http.MethodPost, server.URL+decisionPath,
		`{"client_request_id":"dec-remember-api","decision":`+proof+`}`)
	decided := decodeObject(t, response)
	if decided["decision"] != "approved" || decided["readonly_grant_id"] == nil {
		t.Fatalf("remembered decision = %#v", decided)
	}
	runID, _ := detail["run_id"].(string)
	csrf := bootstrapCSRF(t, server.URL)
	grants := decodeObject(t, taskRequest(t, http.MethodGet,
		server.URL+api.ReadonlyGrantsPath+"?run_id="+runID, csrf, ""))
	items, _ := grants["grants"].([]any)
	if len(items) != 1 {
		t.Fatalf("remembered grants = %#v", grants)
	}
}

func TestApprovalDecisionRejectsInvalidSignature(t *testing.T) {
	server, _, deviceID, sessionID, approvalID, operationID := setupApproval(t)
	path := strings.ReplaceAll(api.ApprovalDecisionPath, "{approvalId}", approvalID)
	proof := approvalProof(t, deviceID, sessionID, approvalID, operationID, "approved", "nonce-forged-1")
	var object map[string]any
	if err := json.Unmarshal([]byte(proof), &object); err != nil {
		t.Fatal(err)
	}
	object["signature"] = strings.Repeat("A", 86)
	forged, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	response := deviceRequest(t, http.MethodPost, server.URL+path,
		`{"client_request_id":"dec-forged-01","decision":`+string(forged)+`}`)
	assertAPICode(t, response, http.StatusUnauthorized, "unauthorized")
	detail := decodeObject(t, deviceRequest(t, http.MethodGet,
		server.URL+strings.ReplaceAll(api.ApprovalDetailPath, "{approvalId}", approvalID), ""))
	if detail["status"] != "pending" {
		t.Fatalf("forged decision changed approval status: %#v", detail)
	}
}

func TestApprovalGetNotFound(t *testing.T) {
	server, _, _, _, _, _ := setupApproval(t)
	missing := strings.ReplaceAll(api.ApprovalDetailPath, "{approvalId}", "00000000-0000-4000-8000-000000000000")
	assertAPICode(t, deviceRequest(t, http.MethodGet, server.URL+missing, ""), http.StatusNotFound, "not_found")
}

func TestApprovalFaceRequiresBearer(t *testing.T) {
	server, _, _, _, _, _ := setupApproval(t)
	// A cookie session must not reach the Bearer-only approval face.
	csrf := bootstrapCSRF(t, server.URL)
	response := taskRequest(t, http.MethodGet, server.URL+api.ApprovalsPath, csrf, "")
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("cookie-plane status = %d, want 401", response.StatusCode)
	}
}
