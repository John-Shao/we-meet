package devicesig

import (
	"encoding/json"
)

// SchemaVersion is the device wire-frame schema version bound into every frame
// signature (device-design §3.1). It is part of the signing domain.
const SchemaVersion = 2

// SignedPayload builds the canonical signing preimage for a frame: the JCS bytes
// of {schema_version, type, body} with the body's own "signature" field stripped
// (the signature is the output, never an input). The outer envelope transport
// fields are not signed; type + schema_version give domain separation so a
// signature never verifies under a different frame type.
func SignedPayload(frameType string, bodyJSON []byte) ([]byte, error) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(bodyJSON, &body); err != nil {
		return nil, err
	}
	delete(body, "signature")
	payload := map[string]any{
		"schema_version": SchemaVersion,
		"type":           frameType,
		"body":           body,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return Canonicalize(raw)
}

// VerifyFrame verifies a device frame signature over {schema_version, type, body}.
// bodyJSON may carry the signature field; it is stripped before reconstructing
// the preimage. A signature made under a different frame type fails.
func VerifyFrame(pub *PublicKey, frameType string, bodyJSON []byte, signatureB64 string) bool {
	preimage, err := SignedPayload(frameType, bodyJSON)
	if err != nil {
		return false
	}
	return VerifyES256(pub.Key, preimage, signatureB64)
}
