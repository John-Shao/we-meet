package migrate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type executionProfileFixture struct {
	*deviceFixture
	api              *pgx.Conn
	deviceID         string
	sessionID        string
	grantID          string
	profileID        string
	profileRevision  int64
	profileHash      string
	runtimeDigest    string
	toolManifestHash string
	modelVersion     string
	listenerIdentity string
	probeResults     map[string][2]string
}

func newExecutionProfileFixture(t *testing.T, org string) *executionProfileFixture {
	t.Helper()
	f := newDeviceFixture(t, org)
	api := f.apiConn(t)
	worker := f.workerConn(t)
	runtimeDigest := hex64("runtime")
	deviceID, _ := f.pairAndConfirm(t, api, "req-ep-pair")
	thumb := f.scalar(t, "SELECT public_key_thumbprint FROM work.device WHERE id = "+quoteLiteral(deviceID))
	minted := callJSON(t, api,
		`SELECT work.mint_device_session_ticket($1,$2,'bearer',7,$3::uuid,$4,$5)`,
		f.org, f.subject, deviceID, "req-ep-ticket", thumb)
	ticket, _ := minted["ticket"].(string)
	ticketHash := f.scalar(t, "SELECT work.sha256_text("+quoteLiteral(ticket)+")")
	hello := `{"boot_id":"boot-ep","agent_instance_id":"` + newUUID(t) + `","journal_epoch":"` +
		newUUID(t) + `","runtime_digest":"` + runtimeDigest + `","protocol_major":2,"protocol_minor":0}`
	session := callJSON(t, worker, `SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`,
		f.org, deviceID, ticketHash, hello)
	sessionID, _ := session["session_id"].(string)
	if sessionID == "" {
		t.Fatalf("activate session = %#v", session)
	}
	grant := callJSON(t, api,
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		f.org, f.subject, deviceID, sessionID, "req-ep-grant",
		`{"root_identity_hash":"`+hex64("root")+`","allowed_tools":["workspace.read"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}`)
	grantID, _ := grant["grant_id"].(string)
	if grantID == "" {
		t.Fatalf("register grant = %#v", grant)
	}
	mustExec(t, f.admin, `INSERT INTO work.org_policy (org_id,run_cap_tokens,force_ask_each,allow_auto_readonly)
		VALUES (`+quoteLiteral(f.org)+`,100000,true,false) ON CONFLICT (org_id) DO NOTHING`)

	profileID := "profile-ep"
	profileRevision := int64(1)
	modelVersion := "model-ep"
	doc := map[string]any{
		"profile_id": profileID, "kind": "device_local", "provider": "device_local",
		"model": modelVersion, "api_type": "chat_completions", "residency": "device",
		"endpoint_policy": map[string]any{"listener_requirement": map[string]any{
			"allowed_signers": []string{"fixture-signer"}, "allow_pinned_hash": true,
			"allowed_service_sids": []string{},
		}},
		"tokenizer_id": "fixture", "context_tokens": 4096, "max_request_bytes": 1048576,
		"max_output_tokens": 1024, "usage_mode": "actual", "runtime_digest": runtimeDigest,
		"tool_manifest_hash": hex64("tools"), "compat_profile_version": "1", "max_turns": 8,
		"status": "active",
	}
	body, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var expectedHash string
	if err := f.admin.QueryRow(testContext(t),
		`SELECT work.sha256_text(($1::jsonb - 'status')::text)`, string(body)).Scan(&expectedHash); err != nil {
		t.Fatal(err)
	}
	published := callJSON(t, api, `SELECT work.publish_execution_profile($1,$2,$3,$4::jsonb)`,
		f.org, f.subject, "req-ep-publish", string(body))
	if published["revision"] != float64(profileRevision) || published["content_hash"] != expectedHash {
		t.Fatalf("publish profile = %#v", published)
	}
	profileHash, _ := published["content_hash"].(string)
	mustExec(t, f.admin, `UPDATE work.device_session SET profile_id = `+quoteLiteral(profileID)+
		` WHERE org_id = `+quoteLiteral(f.org)+` AND id = `+quoteLiteral(sessionID))
	return &executionProfileFixture{
		deviceFixture: f, api: api, deviceID: deviceID, sessionID: sessionID, grantID: grantID,
		profileID: profileID, profileRevision: profileRevision, profileHash: profileHash,
		runtimeDigest: runtimeDigest, toolManifestHash: hex64("tools"), modelVersion: modelVersion,
		listenerIdentity: hex64("listener"), probeResults: make(map[string][2]string),
	}
}

func (f *executionProfileFixture) bindingProof(t *testing.T, bindingHash string) string {
	t.Helper()
	proof := map[string]any{
		"v": "1", "org_id": f.org, "subject_id": f.subject, "auth_epoch": "7",
		"device_id": f.deviceID, "session_id": f.sessionID, "profile_id": f.profileID,
		"profile_revision": strconv.FormatInt(f.profileRevision, 10), "profile_hash": f.profileHash,
		"binding_hash": bindingHash, "local_ref": "fixture://model",
		"listener_identity_hash": f.listenerIdentity, "nonce": "nonce-ep-1234",
		"expires_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
	}
	body, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func (f *executionProfileFixture) createBinding(t *testing.T, requestID string) map[string]any {
	t.Helper()
	field := func(value string) string { return strconv.Itoa(len(value)) + ":" + value }
	preimage := "device-model-binding-v1|" + field(f.org) + "|" + field(f.deviceID) + "|" +
		field(f.sessionID) + "|" + field(f.profileID) + "|" +
		field(strconv.FormatInt(f.profileRevision, 10)) + "|" + field(f.profileHash) + "|" +
		field("fixture://model") + "|" + field(f.listenerIdentity)
	sum := sha256.Sum256([]byte(preimage))
	bindingHash := hex.EncodeToString(sum[:])
	proof := f.bindingProof(t, bindingHash)
	return callJSON(t, f.api, `SELECT work.create_device_model_binding(
		$1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8::bigint,$9,$10,$11,$12,$13::jsonb)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, requestID, f.profileID,
		f.profileRevision, f.profileHash, bindingHash, "fixture://model",
		f.listenerIdentity, proof)
}

func (f *executionProfileFixture) seedProbeResult(t *testing.T, binding map[string]any) (string, string) {
	t.Helper()
	bindingID, _ := binding["binding_id"].(string)
	if result, ok := f.probeResults[bindingID]; ok {
		return result[0], result[1]
	}
	preview, _ := binding["probe_preview"].(map[string]any)
	previewHash, _ := preview["preview_hash"].(string)
	inputRef := newUUID(t)
	inputHash := hex64("probe-input")
	mustExec(t, f.admin, `INSERT INTO work.input_object
		(id,org_id,subject_id,content_ref,content_hash,bytes,media_type,status)
		VALUES (`+quoteLiteral(inputRef)+`,`+quoteLiteral(f.org)+`,`+quoteLiteral(f.subject)+`,`+
		quoteLiteral("local:"+inputRef)+`,`+quoteLiteral(inputHash)+`,2,'application/json','active')`)
	submitted := callJSON(t, f.api, `SELECT to_jsonb(s) FROM (SELECT * FROM work.submit_task(
		$1,$2,$3,$4::uuid,$5,$6,$7,$8::jsonb,$9::text[],$10::jsonb,$11,$12)) s`,
		f.org, f.subject, "req-probe-task-"+bindingID, inputRef, "configuration probe", "ask_each",
		hex64("probe-snapshot"), `{"template":"fixture"}`, []string{"model_call"},
		`{"provider":"device_local","model":"`+f.modelVersion+`"}`, "probe-"+bindingID, f.runtimeDigest)
	runID, _ := submitted["run_id"].(string)
	taskID, _ := submitted["task_id"].(string)
	mustExec(t, f.admin, `UPDATE work.run SET state='active' WHERE org_id=`+quoteLiteral(f.org)+` AND id=`+quoteLiteral(runID))
	mustExec(t, f.admin, `INSERT INTO work.device_run_binding
		(org_id,run_id,binding_revision,task_id,device_id,session_id,input_ref,input_hash,
		 snapshot_descriptor_ref,snapshot_hash,profile_id,profile_revision,runtime_digest,
		 tool_manifest_hash,model_version,grant_set,start_nonce,offer_expiry,state,purpose)
		VALUES (`+quoteLiteral(f.org)+`,`+quoteLiteral(runID)+`,1,`+quoteLiteral(taskID)+`,`+
		quoteLiteral(f.deviceID)+`,`+quoteLiteral(f.sessionID)+`,`+quoteLiteral(inputRef)+`,`+
		quoteLiteral(inputHash)+`,`+quoteLiteral("local:"+inputRef)+`,`+quoteLiteral(hex64("probe-snapshot"))+`,`+
		quoteLiteral(f.profileID)+`,`+strconv.FormatInt(f.profileRevision, 10)+`,`+quoteLiteral(f.runtimeDigest)+`,`+
		quoteLiteral(f.toolManifestHash)+`,`+quoteLiteral(f.modelVersion)+`,`+
		quoteLiteral(`[{"grant_id":"`+f.grantID+`","grant_revision":"1"}]`)+`::jsonb,`+
		quoteLiteral(newUUID(t))+`,now()+interval '5 minutes','active','configuration_probe')`)
	operationID := newUUID(t)
	resultID := newUUID(t)
	resultHash := hex64("probe-result|" + bindingID)
	mustExec(t, f.admin, `INSERT INTO work.operation
		(id,org_id,run_id,logical_key,kind,request_hash,state)
		VALUES (`+quoteLiteral(operationID)+`,`+quoteLiteral(f.org)+`,`+quoteLiteral(runID)+`,`+
		quoteLiteral("model")+`,'model',`+quoteLiteral(previewHash)+`,'succeeded')`)
	mustExec(t, f.admin, `INSERT INTO work.device_model_result
		(org_id,model_result_id,run_id,operation_id,attempt_id,device_id,session_id,execution_id,
		 request_hash,state,outcome,result_hash,model,usage_date,input_tokens,output_tokens,
		 cached_input_tokens,usage_estimated,payload_hash,payload)
		VALUES (`+quoteLiteral(f.org)+`,`+quoteLiteral(resultID)+`,`+quoteLiteral(runID)+`,`+
		quoteLiteral(operationID)+`,`+quoteLiteral(newUUID(t))+`,`+quoteLiteral(f.deviceID)+`,`+quoteLiteral(f.sessionID)+`,`+
		quoteLiteral(newUUID(t))+`,`+quoteLiteral(previewHash)+`,'completed','succeeded',`+quoteLiteral(resultHash)+`,`+
		quoteLiteral(f.modelVersion)+`,CURRENT_DATE,1,1,0,false,`+quoteLiteral(hex64("probe-payload"))+`,`+
		quoteLiteral(`{"probe":true}`)+`::jsonb)`)
	ref := "model_result:" + resultID
	f.probeResults[bindingID] = [2]string{ref, resultHash}
	return ref, resultHash
}

func (f *executionProfileFixture) verifyBinding(t *testing.T, binding map[string]any, requestID string) map[string]any {
	t.Helper()
	preview, _ := binding["probe_preview"].(map[string]any)
	probeID, _ := preview["probe_id"].(string)
	previewHash, _ := preview["preview_hash"].(string)
	bindingHash, _ := binding["binding_hash"].(string)
	if probeID == "" || previewHash == "" || bindingHash == "" {
		t.Fatalf("binding preview = %#v", binding)
	}
	receiptRef, receiptHash := f.seedProbeResult(t, binding)
	return callJSON(t, f.api, `SELECT work.record_execution_profile_probe(
		$1,$2,$3,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9,$10,$11)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, requestID, probeID,
		previewHash, receiptHash, receiptRef, "verified")
}

func (f *executionProfileFixture) preview(t *testing.T, toolHash, modelVersion string) (map[string]any, error) {
	t.Helper()
	var raw []byte
	err := f.api.QueryRow(testContext(t), `
		SELECT work.local_preview_facts($1,$2,$3,$4::uuid,$5::uuid,$6::uuid[],$7::text[],
		  $8,$9,$10::bigint,$11,$12,$13)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID,
		[]string{f.grantID}, []string{"1"}, f.runtimeDigest, f.profileID,
		f.profileRevision, f.profileHash, toolHash, modelVersion).Scan(&raw)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out, nil
}

func (f *executionProfileFixture) submitArgs(requestID string, inputRef string) []any {
	inputHash := hex64("input|" + requestID)
	previewHash := hex64("preview|" + requestID)
	targetHash := hex64("target|" + requestID)
	expiresAt := time.Now().Add(time.Minute).UTC().Format(time.RFC3339)
	target := map[string]any{
		"kind": "local", "profile_id": f.profileID,
		"profile_revision": strconv.FormatInt(f.profileRevision, 10), "profile_hash": f.profileHash,
		"device_id": f.deviceID, "session_id": f.sessionID,
		"workspace_grants": []map[string]any{{"grant_id": f.grantID, "grant_revision": "1"}},
		"runtime_digest":   f.runtimeDigest, "tool_manifest_hash": f.toolManifestHash,
		"model_version": f.modelVersion,
	}
	targetJSON, _ := json.Marshal(target)
	intent := map[string]any{
		"v": 1, "org_id": f.org, "subject_id": f.subject, "auth_plane": "bearer",
		"auth_epoch": "7", "device_id": f.deviceID, "session_id": f.sessionID,
		"request_id": requestID, "input_hash": inputHash, "preview_hash": previewHash,
		"target_selection_hash": targetHash, "selected_grant_ids": []string{f.grantID},
		"grant_revisions": []string{"1"}, "profile_id": f.profileID,
		"profile_revision": strconv.FormatInt(f.profileRevision, 10), "profile_hash": f.profileHash,
		"nonce": "nonce-" + requestID, "expires_at": expiresAt, "signature": strings.Repeat("s", 86),
	}
	intentJSON, _ := json.Marshal(intent)
	return []any{
		f.org, f.subject, 7, requestID, inputRef, inputHash, int64(1), previewHash,
		time.Now().Add(2 * time.Minute), targetHash, "profile submission", "ask_each",
		`{"template":"fixture"}`, []string{"model_call"},
		`{"provider":"device_local","model":"` + f.modelVersion + `"}`, string(targetJSON), string(intentJSON),
	}
}

func TestExecutionProfilePublishGetImmutabilityAndActiveOnly(t *testing.T) {
	f := newExecutionProfileFixture(t, "org_ep_publish")
	got := callJSON(t, f.api, `SELECT work.get_execution_profile($1,$2,$3)`,
		f.org, f.profileID, f.profileRevision)
	if got["content_hash"] != f.profileHash || got["status"] != "active" {
		t.Fatalf("get profile = %#v", got)
	}
	replay := callJSON(t, f.api, `SELECT work.publish_execution_profile($1,$2,$3,$4::jsonb)`,
		f.org, f.subject, "req-ep-publish", f.profileDocument(t))
	if replay["revision"] != float64(f.profileRevision) {
		t.Fatalf("publish replay = %#v", replay)
	}
	expectCode(t, f.api, "idempotency_key_conflict",
		`SELECT work.publish_execution_profile($1,$2,$3,$4::jsonb)`,
		f.org, f.subject, "req-ep-publish",
		strings.Replace(f.profileDocument(t), `"status":"active"`, `"status":"draft"`, 1))
	remote := strings.Replace(f.profileDocument(t), `"kind":"device_local"`, `"kind":"org_remote"`, 1)
	expectCode(t, f.api, "invalid_request",
		`SELECT work.publish_execution_profile($1,$2,$3,$4::jsonb)`,
		f.org, f.subject, "req-ep-remote-active", remote)
	mustExec(t, f.admin, `UPDATE work.execution_profile_revision SET status='revoked'
		WHERE org_id=`+quoteLiteral(f.org)+` AND profile_id=`+quoteLiteral(f.profileID))
	expectCode(t, f.api, "not_found", `SELECT work.get_execution_profile($1,$2,$3)`,
		f.org, f.profileID, f.profileRevision)
	expectCode(t, f.admin, "execution_profile_revision_content_immutable",
		`UPDATE work.execution_profile_revision SET model='changed' WHERE org_id=`+quoteLiteral(f.org))
}

func (f *executionProfileFixture) profileDocument(t *testing.T, model ...string) string {
	t.Helper()
	modelVersion := f.modelVersion
	if len(model) > 0 {
		modelVersion = model[0]
	}
	doc := map[string]any{
		"profile_id": f.profileID, "kind": "device_local",
		"provider": "device_local", "model": modelVersion, "api_type": "chat_completions",
		"residency": "device", "endpoint_policy": map[string]any{"listener_requirement": map[string]any{
			"allowed_signers": []string{"fixture-signer"}, "allow_pinned_hash": true, "allowed_service_sids": []string{},
		}},
		"tokenizer_id": "fixture", "context_tokens": 4096, "max_request_bytes": 1048576,
		"max_output_tokens": 1024, "usage_mode": "actual", "runtime_digest": f.runtimeDigest,
		"tool_manifest_hash": f.toolManifestHash, "compat_profile_version": "1", "max_turns": 8,
		"status": "active",
	}
	body, _ := json.Marshal(doc)
	return string(body)
}

func TestDeviceModelBindingPendingVerifiedAndNegativeBindings(t *testing.T) {
	f := newExecutionProfileFixture(t, "org_ep_binding")
	expectCode(t, f.api, "unauthorized", `SELECT work.create_device_model_binding(
		$1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8::bigint,$9,$10,$11,$12,$13::jsonb)`,
		f.org, f.subject, 7, newUUID(t), f.sessionID, "req-wrong-device", f.profileID,
		f.profileRevision, f.profileHash, hex64("binding"), "fixture://model", f.listenerIdentity,
		f.bindingProof(t, hex64("binding")))
	expectCode(t, f.api, "unauthorized", `SELECT work.create_device_model_binding(
		$1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8::bigint,$9,$10,$11,$12,$13::jsonb)`,
		f.org, f.subject, 7, f.deviceID, newUUID(t), "req-wrong-session", f.profileID,
		f.profileRevision, f.profileHash, hex64("binding"), "fixture://model", f.listenerIdentity,
		f.bindingProof(t, hex64("binding")))
	expectCode(t, f.api, "unauthorized", `SELECT work.create_device_model_binding(
		$1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8::bigint,$9,$10,$11,$12,$13::jsonb)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, "req-wrong-profile", "missing",
		f.profileRevision, f.profileHash, hex64("binding"), "fixture://model", f.listenerIdentity,
		f.bindingProof(t, hex64("binding")))
	expectCode(t, f.api, "not_found", `SELECT work.create_device_model_binding(
		$1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8::bigint,$9,$10,$11,$12,$13::jsonb)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, "req-wrong-hash", f.profileID,
		f.profileRevision, strings.Repeat("0", 64), hex64("binding"), "fixture://model", f.listenerIdentity,
		f.bindingProof(t, hex64("binding")))

	binding := f.createBinding(t, "req-ep-binding")
	if binding["status"] != "pending_probe" {
		t.Fatalf("new binding = %#v", binding)
	}
	preview, _ := binding["probe_preview"].(map[string]any)
	if preview["max_output_tokens"] != float64(16) || preview["preview_hash"] == nil || preview["template_hash"] == nil {
		t.Fatalf("probe preview = %#v", preview)
	}
	probeID, _ := preview["probe_id"].(string)
	previewHash, _ := preview["preview_hash"].(string)
	expectCode(t, f.api, "invalid_request", `SELECT work.record_execution_profile_probe(
		$1,$2,$3,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9,$10,$11)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, "req-ep-self-attestation", probeID,
		previewHash, binding["binding_hash"], "receipt/self-attestation", "verified")
	verified := f.verifyBinding(t, binding, "req-ep-probe")
	if verified["state"] != "verified" || verified["binding_status"] != "verified" {
		t.Fatalf("verified probe = %#v", verified)
	}
	replay := f.verifyBinding(t, binding, "req-ep-probe")
	if replay["state"] != "verified" || replay["binding_revision"] != float64(2) {
		t.Fatalf("probe replay = %#v", replay)
	}
}

func TestDeviceModelBindingRejectsRevokedProfileAndProbeMismatch(t *testing.T) {
	f := newExecutionProfileFixture(t, "org_ep_revoked")
	binding := f.createBinding(t, "req-ep-binding")
	preview, _ := binding["probe_preview"].(map[string]any)
	probeID, _ := preview["probe_id"].(string)
	previewHash, _ := preview["preview_hash"].(string)
	wrongHash := strings.Repeat("0", 64)
	expectCode(t, f.api, "invalid_request", `SELECT work.record_execution_profile_probe(
		$1,$2,$3,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9,$10,$11)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, "req-ep-mismatch", probeID,
		previewHash, wrongHash, "receipt/mismatch", "verified")
	if got := f.scalar(t, "SELECT status FROM work.device_model_binding WHERE org_id="+quoteLiteral(f.org)); got != "pending_probe" {
		t.Fatalf("mismatched probe changed binding status to %s", got)
	}
	failed := callJSON(t, f.api, `SELECT work.record_execution_profile_probe(
		$1,$2,$3,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9,$10,$11)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, "req-ep-failed", probeID,
		previewHash, "", "receipt/failed", "failed")
	if failed["state"] != "failed" || failed["binding_status"] != "revoked" {
		t.Fatalf("failed probe = %#v, want failed/revoked", failed)
	}
	mustExec(t, f.admin, `UPDATE work.execution_profile_revision SET status='revoked'
		WHERE org_id=`+quoteLiteral(f.org)+` AND profile_id=`+quoteLiteral(f.profileID))
	expectCode(t, f.api, "not_found", `SELECT work.create_device_model_binding(
		$1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8::bigint,$9,$10,$11,$12,$13::jsonb)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, "req-revoked-profile", f.profileID,
		f.profileRevision, f.profileHash, hex64("binding"), "fixture://model", f.listenerIdentity,
		f.bindingProof(t, hex64("binding")))
}

func TestDeviceModelBindingProbePreviewExpiryIsEnforced(t *testing.T) {
	f := newExecutionProfileFixture(t, "org_ep_probe_expiry")
	binding := f.createBinding(t, "req-ep-expiry-binding")
	probeID := newUUID(t)
	previewHash := strings.Repeat("a", 64)
	candidateHash, _ := binding["binding_hash"].(string)
	mustExec(t, f.admin, `INSERT INTO work.model_profile_probe
	  (org_id, probe_id, binding_id, profile_id, profile_revision, profile_hash,
	   candidate_hash, preview_hash, expires_at, state, created_at, updated_at)
	  VALUES (`+quoteLiteral(f.org)+`,`+quoteLiteral(probeID)+`,`+
		quoteLiteral(binding["binding_id"].(string))+`,`+quoteLiteral(f.profileID)+`,`+
		strconv.FormatInt(f.profileRevision, 10)+`,`+quoteLiteral(f.profileHash)+`,`+
		quoteLiteral(candidateHash)+`,`+quoteLiteral(previewHash)+`,
	   now() - interval '1 second', 'queued', now() - interval '2 seconds', now() - interval '2 seconds')`)
	expectCode(t, f.api, "preview_stale", `SELECT work.record_execution_profile_probe(
		$1,$2,$3,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9,$10,$11)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, "req-ep-expired-probe", probeID,
		previewHash, candidateHash, "receipt/expired", "verified")
}

func TestLocalPreviewAndSubmissionFailClosedThenUseCanonicalProfile(t *testing.T) {
	f := newExecutionProfileFixture(t, "org_ep_preview_submit")
	if _, err := f.preview(t, f.toolManifestHash, f.modelVersion); err == nil || !strings.Contains(err.Error(), "not_found") {
		t.Fatalf("preview without verified binding error = %v, want not_found", err)
	}
	beforeTasks := countRows(t, f.admin, "SELECT count(*) FROM work.task WHERE org_id="+quoteLiteral(f.org))
	failArgs := f.submitArgs("req-ep-submit-fail", newUUID(t))
	expectCode(t, f.api, "not_found", `SELECT task_id,run_id,revision,binding_revision
		FROM work.submit_local_task($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13::jsonb,$14::text[],$15::jsonb,$16::jsonb,$17::jsonb)`, failArgs...)
	if got := countRows(t, f.admin, "SELECT count(*) FROM work.task WHERE org_id="+quoteLiteral(f.org)); got != beforeTasks {
		t.Fatalf("failed submission created tasks: before=%d after=%d", beforeTasks, got)
	}

	binding := f.createBinding(t, "req-ep-binding")
	f.verifyBinding(t, binding, "req-ep-probe")
	facts, err := f.preview(t, f.toolManifestHash, f.modelVersion)
	if err != nil {
		t.Fatalf("verified preview: %v", err)
	}
	if facts["model"] != f.modelVersion || facts["runtime_digest"] != f.runtimeDigest ||
		facts["tool_manifest_hash"] != f.toolManifestHash || facts["content_hash"] != f.profileHash {
		t.Fatalf("canonical preview facts = %#v", facts)
	}
	if _, err := f.preview(t, strings.Repeat("0", 64), f.modelVersion); err == nil || !strings.Contains(err.Error(), "preview_stale") {
		t.Fatalf("wrong tool hash preview error = %v, want preview_stale", err)
	}

	inputRef := newUUID(t)
	args := f.submitArgs("req-ep-submit-ok", inputRef)
	var taskID, runID string
	var revision, bindingRevision int64
	if err := f.api.QueryRow(testContext(t), `SELECT task_id,run_id,revision,binding_revision
		FROM work.submit_local_task($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13::jsonb,$14::text[],$15::jsonb,$16::jsonb,$17::jsonb)`, args...).
		Scan(&taskID, &runID, &revision, &bindingRevision); err != nil {
		t.Fatalf("canonical submission: %v", err)
	}
	if taskID == "" || runID == "" || bindingRevision != 1 {
		t.Fatalf("submission result = %s/%s rev=%d binding=%d", taskID, runID, revision, bindingRevision)
	}
	var profileID, runtimeDigest, toolHash, modelVersion string
	var profileRevision int64
	if err := f.admin.QueryRow(testContext(t), `SELECT profile_id,profile_revision,runtime_digest,tool_manifest_hash,model_version
		FROM work.device_run_binding WHERE org_id=$1 AND run_id=$2::uuid`, f.org, runID).
		Scan(&profileID, &profileRevision, &runtimeDigest, &toolHash, &modelVersion); err != nil {
		t.Fatal(err)
	}
	if profileID != f.profileID || profileRevision != f.profileRevision || runtimeDigest != f.runtimeDigest ||
		toolHash != f.toolManifestHash || modelVersion != f.modelVersion {
		t.Fatalf("device_run_binding did not use canonical profile: %s/%d/%s/%s/%s",
			profileID, profileRevision, runtimeDigest, toolHash, modelVersion)
	}
}
