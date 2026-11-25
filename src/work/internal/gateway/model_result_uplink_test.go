package gateway_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"

	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

func TestModelResultUplinkRecordsAndReturnsSignedAck(t *testing.T) {
	r, grantID := startRunForAction(t)
	requestHash := strings.Repeat("d", 64)
	action := r.actionBody(grantID, "model:0", 0)
	action["request_hash"] = requestHash
	action["resource_selector_hash"] = requestHash
	action["action_kind"] = "model.send_device_local"
	action["tool_schema"] = "model-v1"
	action["destination_id"] = "device_local"
	r.sendAction(t, action)
	_, prepared, _ := recvTypedFrame(t, r.stream, "action_prepared")
	operationID, _ := prepared["operation_id"].(string)
	attemptID, _ := prepared["attempt_id"].(string)
	if operationID == "" || attemptID == "" {
		t.Fatalf("action_prepared omitted operation identity: %#v", prepared)
	}

	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(r.f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	if err := testpg.ExecRaw(ctx, admin, fmt.Sprintf(`
		SET app.org_id = '%s';
		UPDATE work.operation SET state='authorized' WHERE org_id='%s' AND id='%s'::uuid;
		UPDATE work.approval SET status='approved', revision=revision+1
		WHERE id IN (SELECT approval_id FROM work.approval_operation
		             WHERE org_id='%s' AND operation_id='%s'::uuid);`,
		gwOrg, gwOrg, operationID, gwOrg, operationID)); err != nil {
		t.Fatal(err)
	}
	worker, err := testpg.Open(ctx, testpg.WorkerURL(r.f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close(ctx)
	if err := testpg.ExecRaw(ctx, worker, "SET app.org_id='"+gwOrg+"'; SET app.subject_id='"+gwSubject+"'"); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.Exec(ctx, `SELECT work.resume_run($1,$2::uuid)`, gwOrg, r.runID); err != nil {
		t.Fatalf("resume_run: %v", err)
	}
	if _, err := worker.Exec(ctx,
		`SELECT work.consume_device_permit($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9)`,
		gwOrg, operationID, attemptID, r.f.deviceID, r.sessionID, r.leaseID, r.fence,
		requestHash, "model-result-fixture"); err != nil {
		t.Fatalf("consume_device_permit: %v", err)
	}

	resultID := uuid.NewString()
	body := map[string]any{
		"model_result_id":     resultID,
		"run_id":              r.runID,
		"operation_id":        operationID,
		"attempt_id":          attemptID,
		"request_hash":        requestHash,
		"state":               "completed",
		"outcome":             "succeeded",
		"result_hash":         strings.Repeat("a", 64),
		"provider_request_id": "req-model-1",
		"model":               "fixture-model",
		"usage": map[string]any{
			"input_tokens": "10", "output_tokens": "5",
			"cached_input_tokens": "2", "estimated": false,
		},
		"error_code": nil,
	}
	if err := r.stream.SendMsg(r.f.signFrame(t, "model_result", r.sessionID, r.bootID, r.agentID, body)); err != nil {
		t.Fatal(err)
	}
	bodyJSON, ack, ackSession := recvTypedFrame(t, r.stream, "model_result_ack")
	if ackSession != r.sessionID {
		t.Fatalf("model_result_ack session = %v, want %s", ackSession, r.sessionID)
	}
	if ack["state"] != "recorded" || ack["model_result_id"] != resultID || ack["operation_id"] != operationID {
		t.Fatalf("model_result_ack = %#v", ack)
	}
	if code, ok := ack["code"]; ok && code != nil {
		t.Fatalf("recorded ack carried code: %#v", ack)
	}
	sig, _ := ack["signature"].(string)
	if sig == "" || !devicesig.VerifyFrame(r.serverPub, "model_result_ack", bodyJSON, sig) {
		t.Fatalf("model_result_ack signature did not verify: %#v", ack)
	}
	if devicesig.VerifyFrame(r.serverPub, "receipt_ack", bodyJSON, sig) {
		t.Fatal("model_result_ack signature verified as receipt_ack")
	}

	var operationState, usage string
	if err := admin.QueryRow(ctx, `SELECT state FROM work.operation WHERE org_id=$1 AND id=$2::uuid`,
		gwOrg, operationID).Scan(&operationState); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT input_tokens || '/' || output_tokens || '/' || cached_input_tokens
		FROM work.operation_usage_fact WHERE org_id=$1 AND operation_id=$2::uuid`,
		gwOrg, operationID).Scan(&usage); err != nil {
		t.Fatal(err)
	}
	if operationState != "succeeded" || usage != "10/5/2" {
		t.Fatalf("recorded model result = operation %q usage %q", operationState, usage)
	}
	var count int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM work.device_model_result
		WHERE org_id=$1 AND model_result_id=$2::uuid`, gwOrg, resultID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("device_model_result rows = %d, want 1", count)
	}
}

func TestModelResultUplinkRejectsBadSignature(t *testing.T) {
	r, _ := startRunForAction(t)
	body := map[string]any{
		"model_result_id": uuid.NewString(), "run_id": r.runID,
		"operation_id": uuid.NewString(), "attempt_id": uuid.NewString(),
		"request_hash": strings.Repeat("a", 64), "state": "unknown",
		"outcome": nil, "result_hash": nil, "provider_request_id": nil,
		"model": "fixture-model", "usage": nil, "error_code": "model_io_unknown",
	}
	raw := r.f.signFrame(t, "model_result", r.sessionID, r.bootID, r.agentID, body)
	var env map[string]json.RawMessage
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	var signedBody map[string]any
	if err := json.Unmarshal(env["body"], &signedBody); err != nil {
		t.Fatal(err)
	}
	signedBody["signature"] = strings.Repeat("A", 86)
	env["body"], _ = json.Marshal(signedBody)
	tampered, _ := json.Marshal(env)
	if err := r.stream.SendMsg(tampered); err != nil {
		t.Fatal(err)
	}
	var out []byte
	wantCode(t, r.stream.RecvMsg(&out), codes.Unauthenticated)
}
