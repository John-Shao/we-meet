package api_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

func seedExecutionProfileRevision(t *testing.T, dbName, profileID, modelVersion string,
	revision int64, profileHash, runtimeDigest, toolManifestHash string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, `
		INSERT INTO work.execution_profile_revision
		  (org_id, profile_id, revision, content_hash, kind, provider, model, api_type,
		   residency, endpoint_policy, tokenizer_id, context_tokens, max_request_bytes,
		   max_output_tokens, usage_mode, runtime_digest, tool_manifest_hash,
		   compat_profile_version, max_turns, status)
		VALUES ($1, $2, $3, $4, 'device_local', 'device_local', $5, 'chat_completions',
		   'device', $6::jsonb, 'fixture', 4096, 262144, 1024, 'actual', $7, $8,
		   '1', 8, 'active')
		ON CONFLICT (org_id, profile_id, revision) DO NOTHING`,
		testOrg, profileID, revision, profileHash, modelVersion,
		`{"allowed_ports":[11434],"listener_requirement":{"allowed_signers":["fixture-signer"],"allow_pinned_hash":true,"allowed_service_sids":[]}}`,
		runtimeDigest, toolManifestHash)
	if err != nil {
		t.Fatal(err)
	}
}

func seedVerifiedExecutionProfile(t *testing.T, dbName, deviceID, sessionID, profileID string,
	revision int64, profileHash, runtimeDigest, toolManifestHash, modelVersion string) {
	t.Helper()
	seedExecutionProfileRevision(t, dbName, profileID, modelVersion, revision,
		profileHash, runtimeDigest, toolManifestHash)
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`UPDATE work.device_session SET profile_id = $1 WHERE org_id = $2 AND id = $3::uuid`,
		profileID, testOrg, sessionID); err != nil {
		t.Fatal(err)
	}
	bindingHash := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%s|%d|%s", testOrg, deviceID, sessionID, revision, profileHash)))
	listenerHash := sha256.Sum256([]byte("fixture-listener|" + deviceID))
	_, err = conn.Exec(ctx, `
		INSERT INTO work.device_model_binding
		  (org_id, device_id, session_id, profile_id, profile_revision, profile_hash,
		   binding_hash, status, local_ref, listener_identity_hash, revision)
		VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, 'verified', $8, $9, 1)`,
		testOrg, deviceID, sessionID, profileID, revision, profileHash,
		hex.EncodeToString(bindingHash[:]), "fixture://"+profileID,
		hex.EncodeToString(listenerHash[:]))
	if err != nil {
		t.Fatal(err)
	}
}

func TestExecutionProfileGETAndUnknownRevision(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	profileHash := strings.Repeat("e", 64)
	seedExecutionProfileRevision(t, dbName, "profile-api", "model-api", 1,
		profileHash, strings.Repeat("b", 64), strings.Repeat("a", 64))
	server := newDeviceServer(t, pool)
	path := strings.ReplaceAll(api.ExecutionProfilePath, "{profileId}", "profile-api")
	path = strings.ReplaceAll(path, "{revision}", "1")
	response := deviceRequest(t, http.MethodGet, server.URL+path, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("profile GET status = %d body=%s", response.StatusCode, readBody(response))
	}
	view := decodeObject(t, response)
	if view["profile_id"] != "profile-api" || view["revision"] != float64(1) ||
		view["content_hash"] != profileHash || view["model"] != "model-api" || view["status"] != "active" {
		t.Fatalf("profile GET = %#v", view)
	}
	missing := strings.ReplaceAll(api.ExecutionProfilePath, "{profileId}", "profile-api")
	missing = strings.ReplaceAll(missing, "{revision}", "2")
	response = deviceRequest(t, http.MethodGet, server.URL+missing, "")
	assertAPICode(t, response, http.StatusNotFound, "not_found")
}

func TestDeviceModelProbePreviewRefreshAPI(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	deviceID := "11111111-1111-4111-8111-111111111111"
	sessionID := "22222222-2222-4222-8222-222222222222"
	if _, err := admin.Exec(ctx, `
		INSERT INTO work.device
		  (org_id,id,owner_subject_id,device_name,platform,public_key_jwk,
		   public_key_thumbprint,auth_plane,auth_epoch,status)
		VALUES ($1,$2::uuid,$3,'desk','windows-x64',$4::jsonb,$5,'bearer',4,'active')`,
		testOrg, deviceID, testSubject, deviceTestJWK, strings.Repeat("1", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO work.device_session
		  (org_id,id,device_id,owner_subject_id,boot_id,agent_instance_id,auth_plane,
		   auth_epoch,protocol_major,protocol_minor,runtime_digest,journal_epoch,generation,
		   state,expires_at)
		VALUES ($1,$2::uuid,$3::uuid,$4,'boot-api','33333333-3333-4333-8333-333333333333','bearer',
		   4,2,0,$5,'44444444-4444-4444-8444-444444444444',0,'active',now()+interval '1 hour')`,
		testOrg, sessionID, deviceID, testSubject, strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	profileID := "profile-api"
	profileHash := strings.Repeat("e", 64)
	seedExecutionProfileRevision(t, dbName, profileID, "model-api", 1,
		profileHash, strings.Repeat("b", 64), strings.Repeat("a", 64))
	if _, err := admin.Exec(ctx, `
		UPDATE work.device_session SET profile_id=$1 WHERE org_id=$2 AND id=$3::uuid`,
		profileID, testOrg, sessionID); err != nil {
		t.Fatal(err)
	}
	bindingID := "66666666-6666-4666-8666-666666666666"
	bindingHash := strings.Repeat("7", 64)
	if _, err := admin.Exec(ctx, `
		INSERT INTO work.device_model_binding
		  (org_id,id,device_id,session_id,profile_id,profile_revision,profile_hash,
		   binding_hash,status,local_ref,listener_identity_hash,revision)
		VALUES ($1,$8::uuid,$2::uuid,$3::uuid,$4,1,$5,$6,'pending_probe','fixture://model',$7,1)`,
		testOrg, deviceID, sessionID, profileID, profileHash, bindingHash, strings.Repeat("c", 64), bindingID); err != nil {
		t.Fatal(err)
	}
	oldProbeID := "55555555-5555-4555-8555-555555555555"
	oldPreviewHash := strings.Repeat("d", 64)
	if _, err := admin.Exec(ctx, `
		INSERT INTO work.model_profile_probe
		  (org_id,probe_id,binding_id,profile_id,profile_revision,profile_hash,
		   candidate_hash,preview_hash,expires_at,state,created_at,updated_at)
		VALUES ($1,$2::uuid,$3::uuid,$4,1,$5,$6,$7,now()-interval '1 second','queued',
		        now()-interval '2 minutes',now()-interval '2 minutes')`,
		testOrg, oldProbeID, bindingID, profileID, profileHash, strings.Repeat("f", 64), oldPreviewHash); err != nil {
		t.Fatal(err)
	}
	server := newDeviceServer(t, pool)
	path := strings.ReplaceAll(api.DeviceModelProbePreviewsPath, "{deviceId}", deviceID)
	path = strings.ReplaceAll(path, "{bindingId}", bindingID)
	body := fmt.Sprintf(`{"client_request_id":"refresh-api-1","session_id":%q,"revision":"1"}`, sessionID)
	response := deviceRequest(t, http.MethodPost, server.URL+path, body)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("preview refresh status = %d body=%s", response.StatusCode, readBody(response))
	}
	view := decodeObject(t, response)
	preview, _ := view["probe_preview"].(map[string]any)
	if view["binding_id"] != bindingID || view["binding_revision"] != float64(1) ||
		preview["preview_hash"] == oldPreviewHash || preview["max_output_tokens"] != float64(16) {
		t.Fatalf("preview refresh = %#v", view)
	}
	newProbeID, _ := preview["probe_id"].(string)
	if newProbeID == "" || newProbeID == oldProbeID {
		t.Fatalf("new probe id = %q", newProbeID)
	}
	response = deviceRequest(t, http.MethodPost, server.URL+path, body)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("preview replay status = %d body=%s", response.StatusCode, readBody(response))
	}
	replay := decodeObject(t, response)
	replayPreview, _ := replay["probe_preview"].(map[string]any)
	if replayPreview["probe_id"] != newProbeID {
		t.Fatalf("preview replay = %#v first=%#v", replay, view)
	}
	statusPath := strings.ReplaceAll(api.DeviceModelProbePath, "{deviceId}", deviceID)
	statusPath = strings.ReplaceAll(statusPath, "{probeId}", newProbeID)
	response = deviceRequest(t, http.MethodGet, server.URL+statusPath, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("probe GET status = %d body=%s", response.StatusCode, readBody(response))
	}
	status := decodeObject(t, response)
	if status["probe_id"] != newProbeID || status["binding_id"] != bindingID ||
		status["state"] != "queued" || status["usage"] != nil || status["safe_error"] != nil {
		t.Fatalf("probe GET = %#v", status)
	}
	missingPath := strings.ReplaceAll(api.DeviceModelProbePath, "{deviceId}", deviceID)
	missingPath = strings.ReplaceAll(missingPath, "{probeId}", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	response = deviceRequest(t, http.MethodGet, server.URL+missingPath, "")
	assertAPICode(t, response, http.StatusNotFound, "not_found")
	var probes, bindingRevision int64
	var oldState string
	if err := admin.QueryRow(ctx, `
		SELECT count(*), (SELECT revision FROM work.device_model_binding
		  WHERE org_id=$1 AND id=$2::uuid),
		  (SELECT state FROM work.model_profile_probe WHERE org_id=$1 AND probe_id=$3::uuid)
		FROM work.model_profile_probe WHERE org_id=$1 AND binding_id=$2::uuid`, testOrg, bindingID, oldProbeID).
		Scan(&probes, &bindingRevision, &oldState); err != nil {
		t.Fatal(err)
	}
	if probes != 2 || bindingRevision != 1 || oldState != "queued" {
		t.Fatalf("refresh rows probes=%d binding_revision=%d old_state=%s", probes, bindingRevision, oldState)
	}
}

func TestAdminExecutionProfileActivation(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	profileID := "profile-activate"
	profileHash := strings.Repeat("e", 64)
	seedExecutionProfileRevision(t, dbName, profileID, "model-activate", 1,
		profileHash, strings.Repeat("b", 64), strings.Repeat("a", 64))
	if _, err := admin.Exec(ctx, `
		INSERT INTO work.execution_profile_revision
		  (org_id,profile_id,revision,content_hash,kind,provider,model,api_type,
		   residency,endpoint_policy,tokenizer_id,context_tokens,max_request_bytes,
		   max_output_tokens,usage_mode,runtime_digest,tool_manifest_hash,
		   compat_profile_version,max_turns,status)
		SELECT org_id,profile_id,revision+1,content_hash,kind,provider,model,api_type,
		       residency,endpoint_policy,tokenizer_id,context_tokens,max_request_bytes,
		       max_output_tokens,usage_mode,runtime_digest,tool_manifest_hash,
		       compat_profile_version,max_turns,'draft'
		FROM work.execution_profile_revision
		WHERE org_id=$1 AND profile_id=$2 AND revision=1`, testOrg, profileID); err != nil {
		t.Fatal(err)
	}
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	bootstrap := doBootstrap(t, server.URL, "session-value", "corr-profile-activate")
	if bootstrap.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap status = %d", bootstrap.StatusCode)
	}
	var boot map[string]any
	if err := json.NewDecoder(bootstrap.Body).Decode(&boot); err != nil {
		t.Fatal(err)
	}
	bootstrap.Body.Close()
	csrf, _ := boot["csrf_token"].(string)
	csrfCookie := findCookie(t, bootstrap, api.CSRFCookieName)
	path := strings.ReplaceAll(api.AdminExecutionProfileActivatePath, "{profileId}", profileID)
	body := `{"client_request_id":"activate-api-1","revision":"2","expected_active_revision":"1"}`
	request := func(body string) *http.Response {
		req, err := http.NewRequest(http.MethodPost, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
		req.AddCookie(csrfCookie)
		req.Header.Set(api.CSRFHeaderName, csrf)
		req.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	response := request(body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("activation status = %d body=%s", response.StatusCode, readBody(response))
	}
	view := decodeObject(t, response)
	if view["profile_id"] != profileID || view["revision"] != float64(2) ||
		view["status"] != "active" || view["previous_active_revision"] != float64(1) {
		t.Fatalf("activation = %#v", view)
	}
	response = request(body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("activation replay status = %d body=%s", response.StatusCode, readBody(response))
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO work.execution_profile_revision
		  (org_id,profile_id,revision,content_hash,kind,provider,model,api_type,
		   residency,endpoint_policy,tokenizer_id,context_tokens,max_request_bytes,
		   max_output_tokens,usage_mode,runtime_digest,tool_manifest_hash,
		   compat_profile_version,max_turns,status)
		SELECT org_id,profile_id,revision+1,content_hash,kind,provider,model,api_type,
		       residency,endpoint_policy,tokenizer_id,context_tokens,max_request_bytes,
		       max_output_tokens,usage_mode,runtime_digest,tool_manifest_hash,
		       compat_profile_version,max_turns,'draft'
		FROM work.execution_profile_revision
		WHERE org_id=$1 AND profile_id=$2 AND revision=2`, testOrg, profileID); err != nil {
		t.Fatal(err)
	}
	response = request(`{"client_request_id":"activate-api-conflict","revision":"3","expected_active_revision":"0"}`)
	assertAPICode(t, response, http.StatusConflict, "version_conflict")
	var oldStatus, newStatus string
	if err := admin.QueryRow(ctx, `
		SELECT
		  (SELECT status FROM work.execution_profile_revision WHERE org_id=$1 AND profile_id=$2 AND revision=1),
		  (SELECT status FROM work.execution_profile_revision WHERE org_id=$1 AND profile_id=$2 AND revision=2)`,
		testOrg, profileID).Scan(&oldStatus, &newStatus); err != nil {
		t.Fatal(err)
	}
	if oldStatus != "revoked" || newStatus != "active" {
		t.Fatalf("activation statuses old=%s new=%s", oldStatus, newStatus)
	}
}

func TestDeviceModelBindingAndProbeRejectBadSignaturesBeforeSQL(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	deviceID := "11111111-1111-4111-8111-111111111111"
	if _, err := admin.Exec(ctx, `
		INSERT INTO work.device
		  (org_id,id,owner_subject_id,device_name,platform,public_key_jwk,
		   public_key_thumbprint,auth_plane,auth_epoch,status)
		VALUES ($1,$2::uuid,$3,'desk','windows-x64',$4::jsonb,$5,'bearer',4,'active')`,
		testOrg, deviceID, testSubject, deviceTestJWK, strings.Repeat("1", 64)); err != nil {
		t.Fatal(err)
	}
	server := newDeviceServer(t, pool)
	profileHash := strings.Repeat("e", 64)
	bindingBody := fmt.Sprintf(`{"client_request_id":"bad-binding-sig","session_id":"22222222-2222-4222-8222-222222222222","profile_id":"profile-api","profile_revision":"1","profile_hash":%q,"binding_hash":%q,"local_ref":"fixture://model","listener_identity_hash":%q,"native_confirmation_proof":{"v":"1"}}`,
		profileHash, strings.Repeat("f", 64), strings.Repeat("c", 64))
	bindingPath := strings.ReplaceAll(api.DeviceModelBindingsPath, "{deviceId}", deviceID)
	response := deviceRequest(t, http.MethodPost, server.URL+bindingPath, bindingBody, "not-a-signature")
	assertAPICode(t, response, http.StatusUnauthorized, "unauthorized")

	probeBody := fmt.Sprintf(`{"client_request_id":"bad-probe-sig","session_id":"22222222-2222-4222-8222-222222222222","probe_id":"33333333-3333-4333-8333-333333333333","preview_hash":%q,"receipt_hash":%q,"receipt_ref":"receipt/1","state":"verified","receipt":{"v":"1"}}`,
		strings.Repeat("d", 64), strings.Repeat("f", 64))
	probePath := strings.ReplaceAll(api.DeviceModelBindingProbesPath, "{deviceId}", deviceID)
	probePath = strings.ReplaceAll(probePath, "{bindingId}", "44444444-4444-4444-8444-444444444444")
	response = deviceRequest(t, http.MethodPost, server.URL+probePath, probeBody, "not-a-signature")
	assertAPICode(t, response, http.StatusUnauthorized, "unauthorized")

	templateSum := sha256.Sum256([]byte("device-model-probe-v1"))
	probeRunBody := fmt.Sprintf(`{"client_request_id":"bad-probe-run-sig","session_id":"22222222-2222-4222-8222-222222222222","probe_id":"33333333-3333-4333-8333-333333333333","preview_hash":%q,"target_selection_hash":%q,"local_intent":{"v":1,"org_id":%q,"subject_id":%q,"auth_plane":"bearer","auth_epoch":"4","device_id":%q,"session_id":"22222222-2222-4222-8222-222222222222","request_id":"bad-probe-run-sig","input_hash":%q,"preview_hash":%q,"target_selection_hash":%q,"selected_grant_ids":[],"grant_revisions":[],"profile_id":"profile-api","profile_revision":"1","profile_hash":%q,"nonce":"nonce-probe-run","expires_at":"2027-01-01T00:00:00Z","signature":%q}}`,
		strings.Repeat("d", 64), strings.Repeat("e", 64), testOrg, testSubject, deviceID,
		hex.EncodeToString(templateSum[:]), strings.Repeat("d", 64), strings.Repeat("e", 64),
		profileHash, strings.Repeat("s", 86))
	probeRunPath := strings.ReplaceAll(api.DeviceModelBindingProbeRunsPath, "{deviceId}", deviceID)
	probeRunPath = strings.ReplaceAll(probeRunPath, "{bindingId}", "44444444-4444-4444-8444-444444444444")
	response = deviceRequest(t, http.MethodPost, server.URL+probeRunPath, probeRunBody)
	assertAPICode(t, response, http.StatusUnauthorized, "unauthorized")

	var bindings, probes, tasks, runs, inputs int
	if err := admin.QueryRow(ctx,
		`SELECT (SELECT count(*) FROM work.device_model_binding WHERE org_id=$1),
		        (SELECT count(*) FROM work.model_profile_probe WHERE org_id=$1),
		        (SELECT count(*) FROM work.task WHERE org_id=$1),
		        (SELECT count(*) FROM work.run WHERE org_id=$1),
		        (SELECT count(*) FROM work.input_object WHERE org_id=$1)`, testOrg).
		Scan(&bindings, &probes, &tasks, &runs, &inputs); err != nil {
		t.Fatal(err)
	}
	if bindings != 0 || probes != 0 || tasks != 0 || runs != 0 || inputs != 0 {
		t.Fatalf("signature refusal wrote rows: bindings=%d probes=%d tasks=%d runs=%d inputs=%d",
			bindings, probes, tasks, runs, inputs)
	}
}
