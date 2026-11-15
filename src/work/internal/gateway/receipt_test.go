package gateway

import (
	"encoding/json"
	"strings"
	"testing"
)

// wireReceiptBody is a device-design §3.1 receipt body with the short
// original_execution names the Rust agent signs (frame/receipt.rs). Optional
// org_remote fields are present here to prove the translation drops them.
func wireReceiptBody() map[string]any {
	return map[string]any{
		"journal_epoch": "11111111-1111-4111-8111-111111111111",
		"receipt_seq":   "1",
		"original_execution": map[string]any{
			"org":            "org_gw",
			"subject":        "sub_gw",
			"device":         "22222222-2222-4222-8222-222222222222",
			"session":        "33333333-3333-4333-8333-333333333333",
			"agent_instance": "44444444-4444-4444-8444-444444444444",
			"boot":           "boot-1",
			"generation":     "7",
			"run":            "55555555-5555-4555-8555-555555555555",
			"operation":      "66666666-6666-4666-8666-666666666666",
			"attempt":        "77777777-7777-4777-8777-777777777777",
			"fence":          "3",
		},
		"request_hash":         strings.Repeat("a", 64),
		"state":                "completed",
		"outcome":              "succeeded",
		"result_hash":          strings.Repeat("b", 64),
		"local_result_ref":     "local/out",
		"gateway_receipt_hash": strings.Repeat("c", 64),
		"model_delivery":       "received",
		"usage":                map[string]any{"input_tokens": 10},
		"usage_source":         "provider",
		"error_code":           "",
		"signature":            strings.Repeat("A", 86),
	}
}

func marshalBody(t *testing.T, body map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestReceiptElementIsClosedElevenKeys(t *testing.T) {
	body := wireReceiptBody()
	journal, element, err := receiptElement(marshalBody(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if journal != body["journal_epoch"] {
		t.Fatalf("journal_epoch = %q, want %q", journal, body["journal_epoch"])
	}
	if len(element) != 11 {
		t.Fatalf("element has %d keys, want 11: %#v", len(element), element)
	}
	// The org_remote-only fields and journal_epoch must not leak into the element.
	for _, dropped := range []string{"journal_epoch", "gateway_receipt_hash", "model_delivery"} {
		if _, ok := element[dropped]; ok {
			t.Fatalf("element carries dropped field %q", dropped)
		}
	}
	raw, err := json.Marshal(element)
	if err != nil {
		t.Fatal(err)
	}
	var round map[string]json.RawMessage
	if err := json.Unmarshal(raw, &round); err != nil {
		t.Fatal(err)
	}
	// original_execution is translated to the _id names, exactly eleven keys.
	var exec map[string]json.RawMessage
	if err := json.Unmarshal(round["original_execution"], &exec); err != nil {
		t.Fatal(err)
	}
	if len(exec) != 11 {
		t.Fatalf("original_execution has %d keys, want 11", len(exec))
	}
	for _, name := range []string{"org_id", "subject_id", "device_id", "session_id",
		"agent_instance_id", "boot_id", "generation", "run_id", "operation_id", "attempt_id", "fence"} {
		if _, ok := exec[name]; !ok {
			t.Fatalf("original_execution missing %q", name)
		}
	}
	// uint64s stay decimal strings; the signature passes through unchanged.
	if string(exec["fence"]) != `"3"` || string(exec["generation"]) != `"7"` {
		t.Fatalf("uint64 encoding lost: fence=%s generation=%s", exec["fence"], exec["generation"])
	}
	if string(round["receipt_seq"]) != `"1"` {
		t.Fatalf("receipt_seq = %s, want decimal string", round["receipt_seq"])
	}
	if string(round["signature"]) != `"`+strings.Repeat("A", 86)+`"` {
		t.Fatalf("signature not preserved: %s", round["signature"])
	}
}

func TestReceiptElementNullFillsOptionalFields(t *testing.T) {
	body := wireReceiptBody()
	// A started receipt omits outcome/usage/usage_source on the wire.
	delete(body, "outcome")
	delete(body, "usage")
	delete(body, "usage_source")
	body["state"] = "started"
	_, element, err := receiptElement(marshalBody(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if len(element) != 11 {
		t.Fatalf("element has %d keys, want 11 even with optionals omitted", len(element))
	}
	raw, _ := json.Marshal(element)
	var round map[string]json.RawMessage
	_ = json.Unmarshal(raw, &round)
	for _, key := range []string{"outcome", "usage", "usage_source"} {
		if string(round[key]) != "null" {
			t.Fatalf("%s = %s, want null", key, round[key])
		}
	}
}

func TestReceiptElementRejectsMissingIdentity(t *testing.T) {
	body := wireReceiptBody()
	exec := body["original_execution"].(map[string]any)
	delete(exec, "fence")
	if _, _, err := receiptElement(marshalBody(t, body)); err == nil {
		t.Fatal("expected refusal for missing original_execution.fence")
	}
	body = wireReceiptBody()
	delete(body, "journal_epoch")
	if _, _, err := receiptElement(marshalBody(t, body)); err == nil {
		t.Fatal("expected refusal for missing journal_epoch")
	}
}

func TestReceiptSignatureExtract(t *testing.T) {
	sig, err := receiptSignature(marshalBody(t, wireReceiptBody()))
	if err != nil || sig != strings.Repeat("A", 86) {
		t.Fatalf("signature = %q err=%v", sig, err)
	}
	body := wireReceiptBody()
	delete(body, "signature")
	if _, err := receiptSignature(marshalBody(t, body)); err == nil {
		t.Fatal("expected refusal for missing signature")
	}
}

func TestReceiptAckEnvelopeShape(t *testing.T) {
	result := json.RawMessage(`{"recorded":[],"conflicts":[],"receipt_through_seq":1}`)
	raw, err := receiptAckEnvelope("dev-1", "sess-1", result)
	if err != nil {
		t.Fatal(err)
	}
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.SchemaVersion != 2 || env.Type != "receipt_ack" {
		t.Fatalf("envelope = %#v", env)
	}
	if env.DeviceID != "dev-1" || env.SessionID != "sess-1" || env.MessageID == "" {
		t.Fatalf("envelope addressing = %#v", env)
	}
	if string(env.Body) != string(result) {
		t.Fatalf("ack body = %s, want the record result", env.Body)
	}
}
