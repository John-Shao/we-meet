package gateway

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/devicesig"
)

func validModelResultPayload() map[string]any {
	return map[string]any{
		"model_result_id":     uuid.NewString(),
		"run_id":              uuid.NewString(),
		"operation_id":        uuid.NewString(),
		"attempt_id":          uuid.NewString(),
		"request_hash":        strings.Repeat("a", 64),
		"state":               "completed",
		"outcome":             "succeeded",
		"result_hash":         strings.Repeat("b", 64),
		"provider_request_id": "req-1",
		"model":               "fixture-model",
		"usage": map[string]any{
			"input_tokens": "10", "output_tokens": "5",
			"cached_input_tokens": "2", "estimated": false,
		},
		"error_code": nil,
		"signature":  strings.Repeat("A", 86),
	}
}

func TestParseModelResultBodyAcceptsClosedTerminalShapes(t *testing.T) {
	for _, state := range []string{"succeeded", "failed", "unknown"} {
		payload := validModelResultPayload()
		payload["state"] = "completed"
		payload["outcome"] = state
		switch state {
		case "failed":
			payload["result_hash"] = nil
			payload["provider_request_id"] = nil
			payload["usage"] = nil
			payload["error_code"] = "identity_mismatch"
		case "unknown":
			payload["state"] = "unknown"
			payload["outcome"] = nil
			payload["result_hash"] = nil
			payload["provider_request_id"] = nil
			payload["usage"] = nil
			payload["error_code"] = "model_io_unknown"
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := parseModelResultBody(raw); err != nil {
			t.Fatalf("%s shape refused: %v", state, err)
		}
	}
}

func TestParseModelResultBodyRefusesContentExtraKeysAndBadUsage(t *testing.T) {
	cases := []func(map[string]any){
		func(p map[string]any) { p["content"] = "model output" },
		func(p map[string]any) { p["request_hash"] = "sha256:" + strings.Repeat("a", 64) },
		func(p map[string]any) { p["usage"].(map[string]any)["cached_input_tokens"] = "11" },
		func(p map[string]any) { p["usage"].(map[string]any)["input_tokens"] = "-1" },
		func(p map[string]any) { p["usage"].(map[string]any)["extra"] = true },
	}
	for i, mutate := range cases {
		payload := validModelResultPayload()
		mutate(payload)
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := parseModelResultBody(raw); err == nil {
			t.Fatalf("case %d was accepted", i)
		}
	}
}

func TestModelResultRejectionDistinguishesDomainFromTransientErrors(t *testing.T) {
	if code, ok := modelResultRejection(&pgconn.PgError{Code: "P0001", Message: "usage_receipt_conflict"}); !ok || code != "usage_receipt_conflict" {
		t.Fatalf("domain rejection = %q/%v", code, ok)
	}
	if _, ok := modelResultRejection(&pgconn.PgError{Code: "08006", Message: "connection failure"}); ok {
		t.Fatal("transient connection failure became a terminal rejection")
	}
	if _, ok := modelResultRejection(errors.New("service unavailable")); ok {
		t.Fatal("non-domain error became a terminal rejection")
	}
	if _, ok := modelResultRejection(workdb.Wrap("commit_failed", "ambiguous commit", errors.New("connection lost"))); ok {
		t.Fatal("ambiguous commit became a terminal rejection")
	}
	if _, ok := modelResultRejection(workdb.Wrap("commit_failed", "ambiguous domain failure", &pgconn.PgError{Code: "P0001", Message: "usage_receipt_conflict"})); ok {
		t.Fatal("wrapped domain error bypassed the transient-wrapper guard")
	}
}

func TestModelResultAckSignatureIsTypeBound(t *testing.T) {
	key, err := devicesig.GenerateSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	wire := json.RawMessage(`{"model_result_id":"10000000-0000-0000-0000-000000000001","operation_id":"20000000-0000-0000-0000-000000000001","state":"recorded","code":null}`)
	body, err := signAckBody(key, "model_result_ack", wire)
	if err != nil {
		t.Fatal(err)
	}
	var signed struct {
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(body, &signed); err != nil {
		t.Fatal(err)
	}
	jwk, err := devicesig.PublicJWK(key)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := devicesig.ParseJWK(jwk)
	if err != nil {
		t.Fatal(err)
	}
	if !devicesig.VerifyFrame(pub, "model_result_ack", body, signed.Signature) {
		t.Fatal("model_result_ack signature did not verify")
	}
	if devicesig.VerifyFrame(pub, "receipt_ack", body, signed.Signature) {
		t.Fatal("model_result_ack signature verified as receipt_ack")
	}
}
