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
		"tokenizer_id": "fixture", "context_tokens": 4096, "max_request_bytes": 262144,
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

func TestExecutionProfileResourceBounds(t *testing.T) {
	f := newExecutionProfileFixture(t, "org-resource-bounds")
	insert := func(contextTokens, requestBytes, outputTokens, turns int64) error {
		_, err := f.admin.Exec(testContext(t), `
			INSERT INTO work.execution_profile_revision
			  (org_id,profile_id,revision,content_hash,kind,provider,model,api_type,
			   residency,endpoint_policy,tokenizer_id,context_tokens,max_request_bytes,
			   max_output_tokens,usage_mode,runtime_digest,tool_manifest_hash,
			   compat_profile_version,max_turns,status)
			SELECT org_id,profile_id,revision+1,content_hash,kind,provider,model,api_type,
			       residency,endpoint_policy,tokenizer_id,$1,$2,$3,usage_mode,runtime_digest,
			       tool_manifest_hash,compat_profile_version,$4,status
			FROM work.execution_profile_revision
			WHERE org_id=$5 AND profile_id=$6 AND revision=1`,
			contextTokens, requestBytes, outputTokens, turns, f.org, f.profileID)
		return err
	}
	cases := []struct {
		name           string
		contextTokens  int64
		requestBytes   int64
		outputTokens   int64
		turns          int64
		constraintName string
	}{
		{"request bytes", 4096, 262145, 1024, 8, "execution_profile_revision_request_bytes_bound"},
		{"context tokens", 9007199254740992, 262144, 1024, 8, "execution_profile_revision_context_tokens_bound"},
		{"output tokens", 4096, 262144, 9007199254740992, 8, "execution_profile_revision_output_tokens_bound"},
		{"output within context", 1024, 262144, 1025, 8, "execution_profile_revision_output_within_context"},
		{"turns", 4096, 262144, 1024, 9007199254740992, "execution_profile_revision_turns_bound"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := insert(tc.contextTokens, tc.requestBytes, tc.outputTokens, tc.turns)
			if err == nil || !strings.Contains(err.Error(), tc.constraintName) {
				t.Fatalf("expected %s, got %v", tc.constraintName, err)
			}
		})
	}
}

func TestExecutionProfileActivationAtomicAndReplays(t *testing.T) {
	f := newExecutionProfileFixture(t, "org-profile-activation")
	_, err := f.admin.Exec(testContext(t), `
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
		WHERE org_id=$1 AND profile_id=$2 AND revision=1`, f.org, f.profileID)
	if err != nil {
		t.Fatal(err)
	}
	activated := callJSON(t, f.api, `
		SELECT work.activate_execution_profile($1,$2,$3,$4,$5::bigint,$6::bigint)`,
		f.org, f.subject, "req-profile-activate", f.profileID, 2, 1)
	if activated["profile_id"] != f.profileID || activated["revision"] != float64(2) ||
		activated["status"] != "active" || activated["previous_active_revision"] != float64(1) {
		t.Fatalf("activated profile = %#v", activated)
	}
	replayed := callJSON(t, f.api, `
		SELECT work.activate_execution_profile($1,$2,$3,$4,$5::bigint,$6::bigint)`,
		f.org, f.subject, "req-profile-activate", f.profileID, 2, 1)
	if replayed["revision"] != float64(2) || replayed["previous_active_revision"] != float64(1) {
		t.Fatalf("activation replay = %#v", replayed)
	}
	var oldStatus, newStatus string
	if err := f.admin.QueryRow(testContext(t), `
		SELECT
		  (SELECT status FROM work.execution_profile_revision WHERE org_id=$1 AND profile_id=$2 AND revision=1),
		  (SELECT status FROM work.execution_profile_revision WHERE org_id=$1 AND profile_id=$2 AND revision=2)`,
		f.org, f.profileID).Scan(&oldStatus, &newStatus); err != nil {
		t.Fatal(err)
	}
	if oldStatus != "revoked" || newStatus != "active" {
		t.Fatalf("activation statuses old=%s new=%s", oldStatus, newStatus)
	}
	if _, err := f.admin.Exec(testContext(t), `
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
		WHERE org_id=$1 AND profile_id=$2 AND revision=2`, f.org, f.profileID); err != nil {
		t.Fatal(err)
	}
	expectCode(t, f.api, "revision_conflict", `
		SELECT work.activate_execution_profile($1,$2,$3,$4,$5::bigint,$6::bigint)`,
		f.org, f.subject, "req-profile-conflict", f.profileID, 3, 0)
	expectCode(t, f.api, "revision_conflict", `
		SELECT work.activate_execution_profile($1,$2,$3,$4,$5::bigint,$6::bigint)`,
		f.org, f.subject, "req-profile-stale", f.profileID, 3, 1)
	expectCode(t, f.api, "invalid_request", `
		SELECT work.activate_execution_profile($1,$2,$3,$4,$5::bigint,$6::bigint)`,
		f.org, f.subject, "req-profile-null", f.profileID, 3, nil)
	if _, err := f.admin.Exec(testContext(t), `
		UPDATE work.execution_profile_revision SET status='revoked'
		WHERE org_id=$1 AND profile_id=$2 AND revision=2`, f.org, f.profileID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.admin.Exec(testContext(t), `
		INSERT INTO work.execution_profile_revision
		  (org_id,profile_id,revision,content_hash,kind,provider,model,api_type,
		   residency,endpoint_policy,tokenizer_id,context_tokens,max_request_bytes,
		   max_output_tokens,usage_mode,runtime_digest,tool_manifest_hash,
		   compat_profile_version,max_turns,status)
		SELECT org_id,profile_id,4,content_hash,kind,provider,model,api_type,
		       residency,endpoint_policy,tokenizer_id,context_tokens,max_request_bytes,
		       max_output_tokens,usage_mode,runtime_digest,tool_manifest_hash,
		       compat_profile_version,max_turns,'draft'
		FROM work.execution_profile_revision
		WHERE org_id=$1 AND profile_id=$2 AND revision=2`, f.org, f.profileID); err != nil {
		t.Fatal(err)
	}
	firstActive := callJSON(t, f.api, `
		SELECT work.activate_execution_profile($1,$2,$3,$4,$5::bigint,$6::bigint)`,
		f.org, f.subject, "req-profile-first-active", f.profileID, 4, 0)
	if firstActive["revision"] != float64(4) || firstActive["previous_active_revision"] != nil {
		t.Fatalf("first active profile = %#v", firstActive)
	}
	expectCode(t, f.api, "admin_access_denied", `
		SELECT work.activate_execution_profile($1,$2,$3,$4,$5::bigint,$6::bigint)`,
		f.org, "not-an-owner", "req-profile-denied", f.profileID, 2, 2)
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
	probeID, _ := preview["probe_id"].(string)
	mustExec(t, f.admin, `UPDATE work.model_profile_probe SET task_id=`+quoteLiteral(taskID)+
		`,run_id=`+quoteLiteral(runID)+`,state='running',updated_at=now() WHERE org_id=`+
		quoteLiteral(f.org)+` AND probe_id=`+quoteLiteral(probeID))
	mustExec(t, f.admin, `UPDATE work.run SET state='active' WHERE org_id=`+quoteLiteral(f.org)+` AND id=`+quoteLiteral(runID))
	mustExec(t, f.admin, `INSERT INTO work.device_run_binding
		(org_id,run_id,binding_revision,task_id,device_id,session_id,input_ref,input_hash,
		 snapshot_descriptor_ref,snapshot_hash,profile_id,profile_revision,runtime_digest,
		 tool_manifest_hash,model_version,grant_set,start_nonce,offer_expiry,state,purpose)
		VALUES (`+quoteLiteral(f.org)+`,`+quoteLiteral(runID)+`,1,`+quoteLiteral(taskID)+`,`+
		quoteLiteral(f.deviceID)+`,`+quoteLiteral(f.sessionID)+`,`+quoteLiteral(inputRef)+`,`+
		quoteLiteral(inputHash)+`,`+quoteLiteral("probe:"+probeID)+`,`+quoteLiteral(hex64("probe-snapshot"))+`,`+
		quoteLiteral(f.profileID)+`,`+strconv.FormatInt(f.profileRevision, 10)+`,`+quoteLiteral(f.runtimeDigest)+`,`+
		quoteLiteral(f.toolManifestHash)+`,`+quoteLiteral(f.modelVersion)+`,`+
		quoteLiteral(`[]`)+`::jsonb,`+
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
	expectCode(t, f.admin, "invalid_request", `INSERT INTO work.device_model_result
		(org_id,model_result_id,run_id,operation_id,attempt_id,device_id,session_id,execution_id,
		 request_hash,state,outcome,result_hash,model,usage_date,input_tokens,output_tokens,
		 cached_input_tokens,usage_estimated,payload_hash,payload)
		SELECT org_id,$2::uuid,run_id,operation_id,attempt_id,device_id,session_id,execution_id,
		 request_hash,state,outcome,result_hash,model,usage_date,input_tokens,output_tokens,
		 cached_input_tokens,usage_estimated,payload_hash,payload
		FROM work.device_model_result WHERE org_id=$1 AND model_result_id=$3::uuid`,
		f.org, newUUID(t), resultID)
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

func (f *executionProfileFixture) configurationProbeArgs(t *testing.T, binding map[string]any, requestID string) []any {
	t.Helper()
	preview, _ := binding["probe_preview"].(map[string]any)
	probeID, _ := preview["probe_id"].(string)
	previewHash, _ := preview["preview_hash"].(string)
	if probeID == "" || previewHash == "" {
		t.Fatalf("binding preview = %#v", binding)
	}
	templateHash := f.scalar(t, "SELECT work.sha256_text('device-model-probe-v1')")
	targetHash := hex64("probe-target|" + requestID)
	intent := map[string]any{
		"v": 1, "org_id": f.org, "subject_id": f.subject, "auth_plane": "bearer",
		"auth_epoch": "7", "device_id": f.deviceID, "session_id": f.sessionID,
		"request_id": requestID, "input_hash": templateHash, "preview_hash": previewHash,
		"target_selection_hash": targetHash, "selected_grant_ids": []string{},
		"grant_revisions": []string{}, "profile_id": f.profileID,
		"profile_revision": strconv.FormatInt(f.profileRevision, 10), "profile_hash": f.profileHash,
		"nonce": "nonce-" + requestID, "expires_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
		"signature": strings.Repeat("s", 86),
	}
	intentJSON, err := json.Marshal(intent)
	if err != nil {
		t.Fatal(err)
	}
	return []any{
		f.org, f.subject, 7, requestID, f.deviceID, f.sessionID,
		binding["binding_id"], probeID, previewHash, targetHash, string(intentJSON),
	}
}

const submitConfigurationProbeSQL = `SELECT task_id,run_id,revision,binding_revision
	FROM work.submit_configuration_probe($1,$2,$3,$4,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9,$10,$11::jsonb)`

func TestConfigurationProbeSubmissionCreatesCanonicalHiddenRunAndReplays(t *testing.T) {
	f := newExecutionProfileFixture(t, "org_probe_submit")
	binding := f.createBinding(t, "req-probe-binding")
	args := f.configurationProbeArgs(t, binding, "req-probe-submit")
	preview, _ := binding["probe_preview"].(map[string]any)
	probeID, _ := preview["probe_id"].(string)
	var taskID, runID string
	var revision, bindingRevision int64
	if err := f.api.QueryRow(testContext(t), submitConfigurationProbeSQL, args...).
		Scan(&taskID, &runID, &revision, &bindingRevision); err != nil {
		t.Fatalf("configuration probe submission: %v", err)
	}
	if taskID == "" || runID == "" || revision != 1 || bindingRevision != 1 {
		t.Fatalf("submission = %s/%s rev=%d binding=%d", taskID, runID, revision, bindingRevision)
	}
	previewHash, _ := preview["preview_hash"].(string)
	templateHash := f.scalar(t, "SELECT work.sha256_text('device-model-probe-v1')")
	var taskKind, title, permissionMode, runState, purpose, grantSet, inputRef, inputHash, contentRef string
	var profileID, runtimeDigest, toolHash, modelVersion, probeState string
	var profileRevision, inputBytes int64
	var manifest []byte
	if err := f.admin.QueryRow(testContext(t), `
		SELECT t.task_kind,t.title,t.permission_mode,r.state,b.purpose,b.grant_set::text,
		       i.id::text,i.content_hash,i.content_ref,i.bytes,b.profile_id,b.profile_revision,
		       b.runtime_digest,b.tool_manifest_hash,b.model_version,p.state,s.manifest
		FROM work.task t
		JOIN work.run r ON r.task_id=t.id AND r.org_id=t.org_id
		JOIN work.device_run_binding b ON b.run_id=r.id AND b.org_id=r.org_id AND b.binding_revision=1
		JOIN work.input_object i ON i.id=t.input_id AND i.org_id=t.org_id
		JOIN work.model_profile_probe p ON p.run_id=r.id AND p.org_id=r.org_id
		JOIN work.capability_snapshot s ON s.id=r.snapshot_id AND s.org_id=r.org_id
		WHERE t.org_id=$1 AND t.id=$2::uuid`, f.org, taskID).
		Scan(&taskKind, &title, &permissionMode, &runState, &purpose, &grantSet,
			&inputRef, &inputHash, &contentRef, &inputBytes, &profileID, &profileRevision,
			&runtimeDigest, &toolHash, &modelVersion, &probeState, &manifest); err != nil {
		t.Fatal(err)
	}
	if taskKind != "configuration_probe" || title != "configuration probe" || permissionMode != "ask_each" ||
		runState != "active" || purpose != "configuration_probe" || grantSet == "[]" ||
		inputHash != templateHash || contentRef != "probe:"+probeID || inputBytes <= 0 ||
		profileID != f.profileID || profileRevision != f.profileRevision || runtimeDigest != f.runtimeDigest ||
		toolHash != f.toolManifestHash || modelVersion != f.modelVersion || probeState != "running" {
		t.Fatalf("probe facts = kind=%s title=%s mode=%s run=%s purpose=%s grants=%s input=%s/%s/%d profile=%s/%d/%s/%s/%s probe=%s",
			taskKind, title, permissionMode, runState, purpose, grantSet, inputHash, contentRef, inputBytes,
			profileID, profileRevision, runtimeDigest, toolHash, modelVersion, probeState)
	}
	var manifestDoc map[string]any
	if err := json.Unmarshal(manifest, &manifestDoc); err != nil {
		t.Fatal(err)
	}
	if manifestDoc["kind"] != "configuration_probe" || manifestDoc["probe_id"] != probeID ||
		manifestDoc["binding_id"] != binding["binding_id"] || manifestDoc["template_hash"] != templateHash ||
		manifestDoc["preview_hash"] != previewHash || len(manifestDoc) != 5 {
		t.Fatalf("probe manifest = %s", manifest)
	}
	var offerJSON []byte
	if err := f.workerConn(t).QueryRow(testContext(t),
		`SELECT work.list_pending_device_offers($1,$2::uuid,$3::uuid)`, f.org, f.deviceID, f.sessionID).Scan(&offerJSON); err != nil {
		t.Fatal(err)
	}
	var offers []map[string]any
	if err := json.Unmarshal(offerJSON, &offers); err != nil {
		t.Fatal(err)
	}
	if len(offers) != 1 || offers[0]["run_id"] != runID {
		t.Fatalf("probe offers = %s", offerJSON)
	}
	probeOffer, _ := offers[0]["probe"].(map[string]any)
	if probeOffer["binding_id"] != binding["binding_id"] || probeOffer["probe_id"] != probeID ||
		probeOffer["preview_hash"] != previewHash || probeOffer["template_hash"] != templateHash {
		t.Fatalf("signed offer probe metadata = %#v", probeOffer)
	}
	if offers[0]["max_turns"] != float64(8) || offers[0]["max_output_tokens"] != float64(1024) ||
		offers[0]["max_request_bytes"] != float64(262144) {
		t.Fatalf("signed offer resource limits = %#v", offers[0])
	}
	if got := countRows(t, f.admin, "SELECT count(*) FROM work.workspace_grant WHERE org_id="+
		quoteLiteral(f.org)+" AND purpose='configuration_probe'"); got != 1 {
		t.Fatalf("internal probe grants = %d, want 1", got)
	}
	internalGrantID := f.scalar(t, "SELECT id::text FROM work.workspace_grant WHERE org_id="+
		quoteLiteral(f.org)+" AND purpose='configuration_probe'")
	visibleGrants := callJSON(t, f.api, `SELECT work.list_workspace_grants($1,$2,$3::uuid,NULL,50)`,
		f.org, f.subject, f.deviceID)
	items, _ := visibleGrants["items"].([]any)
	for _, item := range items {
		grant, _ := item.(map[string]any)
		if grant["grant_id"] == internalGrantID {
			t.Fatalf("internal probe grant leaked into workspace grants: %#v", item)
		}
	}
	if got := countRows(t, f.admin, "SELECT count(*) FROM work.outbox WHERE org_id="+quoteLiteral(f.org)+
		" AND aggregate_id="+quoteLiteral(runID)+" AND payload->>'kind'='start_workflow'"); got != 0 {
		t.Fatalf("probe start_workflow outbox rows = %d", got)
	}
	if got := countRows(t, f.admin, "SELECT count(*) FROM work.local_submission_intent WHERE org_id="+
		quoteLiteral(f.org)+" AND task_id="+quoteLiteral(taskID)+" AND run_id="+quoteLiteral(runID)); got != 1 {
		t.Fatalf("probe local intent rows = %d", got)
	}
	if got := countRows(t, f.admin, "SELECT count(*) FROM work.task_summary WHERE org_id="+
		quoteLiteral(f.org)+" AND task_id="+quoteLiteral(taskID)); got != 0 {
		t.Fatalf("configuration probe leaked into task_summary: %d", got)
	}
	expectCode(t, f.api, "invalid_request", submitConfigurationProbeSQL,
		f.configurationProbeArgs(t, binding, "req-probe-second-run")...)
	expectCode(t, f.admin, "invalid_request",
		`UPDATE work.model_profile_probe SET run_id=$2::uuid WHERE org_id=$1 AND probe_id=$3::uuid`,
		f.org, newUUID(t), probeID)
	operationID := newUUID(t)
	mustExec(t, f.admin, `INSERT INTO work.operation
		(id,org_id,run_id,logical_key,kind,request_hash,state)
		VALUES (`+quoteLiteral(operationID)+`,`+quoteLiteral(f.org)+`,`+quoteLiteral(runID)+`,`+
		quoteLiteral("model")+`,'model',`+quoteLiteral(previewHash)+`,'prepared')`)
	expectCode(t, f.admin, "invalid_request", `INSERT INTO work.operation
		(id,org_id,run_id,logical_key,kind,request_hash,state)
		VALUES ($1,$2,$3::uuid,'second','model',$4,'prepared')`,
		newUUID(t), f.org, runID, previewHash)
	if got := countRows(t, f.admin, "SELECT count(*) FROM work.task WHERE org_id="+
		quoteLiteral(f.org)+" AND task_kind='configuration_probe'"); got != 1 {
		t.Fatalf("configuration probe task count = %d, want 1", got)
	}

	// Expire the preview behind the guard, then prove replay is resolved before expiry checks.
	mustExec(t, f.admin, `ALTER TABLE work.model_profile_probe DISABLE TRIGGER model_profile_probe_guard`)
	mustExec(t, f.admin, `UPDATE work.model_profile_probe
		SET created_at=now()-interval '1 day',expires_at=now()-interval '1 second'
		WHERE org_id=`+quoteLiteral(f.org)+` AND probe_id=`+quoteLiteral(probeID))
	mustExec(t, f.admin, `ALTER TABLE work.model_profile_probe ENABLE TRIGGER model_profile_probe_guard`)
	var replayTask, replayRun string
	if err := f.api.QueryRow(testContext(t), submitConfigurationProbeSQL, args...).
		Scan(&replayTask, &replayRun, new(int64), new(int64)); err != nil {
		t.Fatalf("configuration probe replay: %v", err)
	}
	if replayTask != taskID || replayRun != runID {
		t.Fatalf("replay = %s/%s, want %s/%s", replayTask, replayRun, taskID, runID)
	}
	conflict := append([]any(nil), args...)
	conflict[9] = hex64("conflicting-target")
	expectCode(t, f.api, "idempotency_key_conflict", submitConfigurationProbeSQL, conflict...)
	expectCode(t, f.admin, "device_run_binding_purpose_shape",
		`UPDATE work.device_run_binding SET purpose='task' WHERE org_id=$1 AND run_id=$2::uuid`, f.org, runID)
}

func TestConfigurationProbeSubmissionRejectsExpiredAndMismatchedFacts(t *testing.T) {
	f := newExecutionProfileFixture(t, "org_probe_reject")
	binding := f.createBinding(t, "req-probe-binding")
	tasksBefore := countRows(t, f.admin, "SELECT count(*) FROM work.task WHERE org_id="+quoteLiteral(f.org))
	preview, _ := binding["probe_preview"].(map[string]any)
	probeID, _ := preview["probe_id"].(string)
	// Replace only the probe UUID in an otherwise valid request.
	wrongProbe := f.configurationProbeArgs(t, binding, "req-probe-wrong-probe")
	wrongProbe[7] = newUUID(t)
	expectCode(t, f.api, "not_found", submitConfigurationProbeSQL, wrongProbe...)
	wrongBinding := f.configurationProbeArgs(t, binding, "req-probe-wrong-binding")
	wrongBinding[6] = newUUID(t)
	expectCode(t, f.api, "not_found", submitConfigurationProbeSQL, wrongBinding...)
	wrongDevice := f.configurationProbeArgs(t, binding, "req-probe-wrong-device")
	wrongDevice[4] = newUUID(t)
	expectCode(t, f.api, "unauthorized", submitConfigurationProbeSQL, wrongDevice...)
	wrongSession := f.configurationProbeArgs(t, binding, "req-probe-wrong-session")
	wrongSession[5] = newUUID(t)
	expectCode(t, f.api, "unauthorized", submitConfigurationProbeSQL, wrongSession...)
	wrongPreview := f.configurationProbeArgs(t, binding, "req-probe-wrong-preview")
	wrongPreview[8] = strings.Repeat("0", 64)
	var wrongPreviewIntent map[string]any
	if err := json.Unmarshal([]byte(wrongPreview[10].(string)), &wrongPreviewIntent); err != nil {
		t.Fatal(err)
	}
	wrongPreviewIntent["preview_hash"] = wrongPreview[8]
	wrongPreviewJSON, err := json.Marshal(wrongPreviewIntent)
	if err != nil {
		t.Fatal(err)
	}
	wrongPreview[10] = string(wrongPreviewJSON)
	expectCode(t, f.api, "preview_stale", submitConfigurationProbeSQL, wrongPreview...)

	mustExec(t, f.admin, `ALTER TABLE work.model_profile_probe DISABLE TRIGGER model_profile_probe_guard`)
	mustExec(t, f.admin, `UPDATE work.model_profile_probe
		SET created_at=now()-interval '1 day',expires_at=now()-interval '1 second'
		WHERE org_id=`+quoteLiteral(f.org)+` AND probe_id=`+quoteLiteral(probeID))
	mustExec(t, f.admin, `ALTER TABLE work.model_profile_probe ENABLE TRIGGER model_profile_probe_guard`)
	expectCode(t, f.api, "preview_stale", submitConfigurationProbeSQL,
		f.configurationProbeArgs(t, binding, "req-probe-expired")...)
	if got := countRows(t, f.admin, "SELECT count(*) FROM work.task WHERE org_id="+quoteLiteral(f.org)); got != tasksBefore {
		t.Fatalf("rejected probe submissions created %d tasks", got-tasksBefore)
	}
}

func TestConfigurationProbeTaskCannotBeRetried(t *testing.T) {
	f := newExecutionProfileFixture(t, "org_probe_no_retry")
	binding := f.createBinding(t, "req-probe-binding")
	args := f.configurationProbeArgs(t, binding, "req-probe-submit")
	var taskID, runID string
	if err := f.api.QueryRow(testContext(t), submitConfigurationProbeSQL, args...).
		Scan(&taskID, &runID, new(int64), new(int64)); err != nil {
		t.Fatal(err)
	}
	mustExec(t, f.admin, `UPDATE work.run SET state='failed',terminal_reason='probe test'
		WHERE org_id=`+quoteLiteral(f.org)+` AND id=`+quoteLiteral(runID))
	mustExec(t, f.admin, `UPDATE work.task SET state='open',active_run_id=NULL
		WHERE org_id=`+quoteLiteral(f.org)+` AND id=`+quoteLiteral(taskID))
	expectCode(t, f.api, "invalid_request", `SELECT run_id,revision FROM work.retry_task(
		$1,$2::uuid,$3,$4,$5,$6,$7)`,
		f.org, taskID, f.subject, "req-probe-retry", int64(1), "retry-probe", f.runtimeDigest)
	if got := countRows(t, f.admin, "SELECT count(*) FROM work.run WHERE org_id="+
		quoteLiteral(f.org)+" AND task_id="+quoteLiteral(taskID)); got != 1 {
		t.Fatalf("configuration probe retry created another run: %d", got)
	}
}

func TestConfigurationProbeSubmissionRefusesVerifiedBinding(t *testing.T) {
	f := newExecutionProfileFixture(t, "org_probe_verified_refusal")
	binding := f.createBinding(t, "req-probe-binding")
	tasksBefore := countRows(t, f.admin, "SELECT count(*) FROM work.task WHERE org_id="+quoteLiteral(f.org))
	mustExec(t, f.admin, `UPDATE work.device_model_binding
		SET status='verified',revision=revision+1,updated_at=now()
		WHERE org_id=`+quoteLiteral(f.org)+` AND id=`+quoteLiteral(binding["binding_id"].(string)))
	expectCode(t, f.api, "invalid_request", submitConfigurationProbeSQL,
		f.configurationProbeArgs(t, binding, "req-probe-verified")...)
	if got := countRows(t, f.admin, "SELECT count(*) FROM work.task WHERE org_id="+quoteLiteral(f.org)); got != tasksBefore {
		t.Fatalf("verified binding refusal created %d tasks", got-tasksBefore)
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
		"tokenizer_id": "fixture", "context_tokens": 4096, "max_request_bytes": 262144,
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

func TestDeviceModelProbePreviewRefreshPreservesBindingAndReplays(t *testing.T) {
	f := newExecutionProfileFixture(t, "org_ep_refresh")
	binding := f.createBinding(t, "req-ep-refresh-binding")
	oldPreview, _ := binding["probe_preview"].(map[string]any)
	oldProbeID, _ := oldPreview["probe_id"].(string)
	mustExec(t, f.admin, `ALTER TABLE work.model_profile_probe DISABLE TRIGGER model_profile_probe_guard`)
	mustExec(t, f.admin, `UPDATE work.model_profile_probe
		SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 second'
		WHERE org_id=`+quoteLiteral(f.org)+` AND probe_id=`+quoteLiteral(oldProbeID))
	mustExec(t, f.admin, `ALTER TABLE work.model_profile_probe ENABLE TRIGGER model_profile_probe_guard`)
	refreshed := callJSON(t, f.api, `SELECT work.refresh_device_model_probe_preview(
		$1,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8::bigint)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, binding["binding_id"], "req-ep-refresh", 1)
	if refreshed["binding_id"] != binding["binding_id"] || refreshed["binding_revision"] != float64(1) {
		t.Fatalf("refresh replaced binding = %#v", refreshed)
	}
	preview, _ := refreshed["probe_preview"].(map[string]any)
	if preview["probe_id"] == oldProbeID || preview["preview_hash"] == oldPreview["preview_hash"] ||
		preview["template_hash"] != oldPreview["template_hash"] || preview["max_output_tokens"] != float64(16) {
		t.Fatalf("refreshed preview = %#v", preview)
	}
	if got := countRows(t, f.admin, "SELECT count(*) FROM work.model_profile_probe WHERE org_id="+
		quoteLiteral(f.org)+" AND binding_id="+quoteLiteral(binding["binding_id"].(string))); got != 2 {
		t.Fatalf("probe count after refresh = %d, want 2", got)
	}
	if got := f.scalar(t, "SELECT state FROM work.model_profile_probe WHERE org_id="+quoteLiteral(f.org)+
		" AND probe_id="+quoteLiteral(oldProbeID)); got != "queued" {
		t.Fatalf("old probe mutated to %s", got)
	}
	replay := callJSON(t, f.api, `SELECT work.refresh_device_model_probe_preview(
		$1,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8::bigint)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, binding["binding_id"], "req-ep-refresh", 1)
	if replay["probe_preview"].(map[string]any)["probe_id"] != preview["probe_id"] {
		t.Fatalf("refresh replay changed probe = %#v", replay)
	}
	expectCode(t, f.api, "idempotency_key_conflict", `SELECT work.refresh_device_model_probe_preview(
		$1,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8::bigint)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, binding["binding_id"], "req-ep-refresh", 2)
	expectCode(t, f.api, "invalid_request", `SELECT work.refresh_device_model_probe_preview(
		$1,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8::bigint)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, binding["binding_id"], "req-ep-refresh-unexpired", 1)
	mustExec(t, f.admin, `UPDATE work.model_profile_probe SET state='running'
		WHERE org_id=`+quoteLiteral(f.org)+` AND probe_id=`+quoteLiteral(preview["probe_id"].(string)))
	expectCode(t, f.api, "invalid_request", `SELECT work.refresh_device_model_probe_preview(
		$1,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8::bigint)`,
		f.org, f.subject, 7, f.deviceID, f.sessionID, binding["binding_id"], "req-ep-refresh-running", 1)
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
