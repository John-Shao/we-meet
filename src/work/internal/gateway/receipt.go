package gateway

import (
	"crypto/ecdsa"
	"encoding/json"
	"fmt"

	"github.com/we-meet/work/internal/devicesig"
)

// receiptExecNames maps the device-design §3.1 wire original_execution short names
// to the _id-suffixed names record_device_receipt consumes (0042 element validator).
// The wire keeps the short names (Rust frame/receipt.rs OriginalExecution); the
// gateway is the translation boundary, so the signed device frame is unchanged.
var receiptExecNames = map[string]string{
	"org":            "org_id",
	"subject":        "subject_id",
	"device":         "device_id",
	"session":        "session_id",
	"agent_instance": "agent_instance_id",
	"boot":           "boot_id",
	"generation":     "generation",
	"run":            "run_id",
	"operation":      "operation_id",
	"attempt":        "attempt_id",
	"fence":          "fence",
}

// receiptSignature extracts the signature field from a wire receipt body so the
// gateway can verify ES256 over the original (untranslated) body before any domain
// command (0047 getter; 0040:1135, 0021 precedent).
func receiptSignature(bodyJSON []byte) (string, error) {
	var body struct {
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(bodyJSON, &body); err != nil {
		return "", fmt.Errorf("invalid_request: receipt body")
	}
	if body.Signature == "" {
		return "", fmt.Errorf("invalid_request: receipt signature")
	}
	return body.Signature, nil
}

// receiptElement translates one wire receipt body into the closed 11-key element
// record_device_receipt consumes (0042 device_receipt_element_valid). journal_epoch
// is lifted out to the command parameter; the org_remote-only fields
// (gateway_receipt_hash, model_delivery) are dropped; outcome/usage/usage_source
// default to JSON null when the device omitted them, so the element always has
// exactly eleven keys. The signature is carried through unchanged: the gateway
// verified it over the wire body and SQL hashes it for idempotency (0048).
func receiptElement(bodyJSON []byte) (string, map[string]any, error) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(bodyJSON, &body); err != nil {
		return "", nil, fmt.Errorf("invalid_request: receipt body")
	}
	var journalEpoch string
	if err := json.Unmarshal(body["journal_epoch"], &journalEpoch); err != nil || journalEpoch == "" {
		return "", nil, fmt.Errorf("invalid_request: receipt journal_epoch")
	}
	var exec map[string]json.RawMessage
	if err := json.Unmarshal(body["original_execution"], &exec); err != nil {
		return "", nil, fmt.Errorf("invalid_request: receipt original_execution")
	}
	translated := make(map[string]any, len(receiptExecNames))
	for short, long := range receiptExecNames {
		v, ok := exec[short]
		if !ok {
			return "", nil, fmt.Errorf("invalid_request: receipt original_execution.%s", short)
		}
		translated[long] = v
	}
	element := map[string]any{
		"receipt_seq":        rawField(body, "receipt_seq"),
		"original_execution": translated,
		"request_hash":       rawField(body, "request_hash"),
		"state":              rawField(body, "state"),
		"outcome":            rawField(body, "outcome"),
		"result_hash":        rawField(body, "result_hash"),
		"local_result_ref":   rawField(body, "local_result_ref"),
		"error_code":         rawField(body, "error_code"),
		"usage":              rawField(body, "usage"),
		"usage_source":       rawField(body, "usage_source"),
		"signature":          rawField(body, "signature"),
	}
	return journalEpoch, element, nil
}

// rawField returns the raw JSON value for a key, or JSON null when absent. Keeping
// the value as json.RawMessage preserves the device's exact encoding (decimal-string
// uint64s, null versus empty string) through the translation.
func rawField(body map[string]json.RawMessage, key string) json.RawMessage {
	if v, ok := body[key]; ok {
		return v
	}
	return json.RawMessage("null")
}

// signAckBody signs a downlink ack body (the record_device_receipt result) with the
// gateway server key and returns the body carrying a "signature" member. The signature
// is the server's ES256 over {schema_version, type, body} with the signature stripped
// (devicesig.SignedPayload); the device verifies it against the hello_ack
// server_public_jwk. This closes the deferred ack signing GW5/GW6 left unsigned: the
// device consume path now verifies fail-closed (no optional-signature shim).
func signAckBody(key *ecdsa.PrivateKey, frameType string, result json.RawMessage) (json.RawMessage, error) {
	sig, err := devicesig.SignFrame(key, frameType, result)
	if err != nil {
		return nil, err
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(result, &body); err != nil {
		return nil, err
	}
	sigJSON, err := json.Marshal(sig)
	if err != nil {
		return nil, err
	}
	body["signature"] = sigJSON
	return json.Marshal(body)
}

// receiptAckEnvelope wraps the record_device_receipt result (recorded, conflicts,
// receipt_through_seq) into a server-signed receipt_ack frame addressed to the device
// on the current transport session. The device verifies receipt_through_seq's ack
// against the server key, then advances its outbox watermark and resolves conflicts.
func receiptAckEnvelope(deviceID, sessionID string, result json.RawMessage, key *ecdsa.PrivateKey) ([]byte, error) {
	body, err := signAckBody(key, "receipt_ack", result)
	if err != nil {
		return nil, err
	}
	env := Envelope{
		SchemaVersion:      2,
		Type:               "receipt_ack",
		MessageID:          newMessageID(),
		DeviceID:           deviceID,
		SessionID:          sessionID,
		RecoveryGeneration: "0",
		Body:               body,
	}
	return json.Marshal(env)
}
