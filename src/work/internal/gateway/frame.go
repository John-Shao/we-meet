package gateway

import (
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

// newMessageID returns a fresh UUID for a server-originated frame's message_id.
func newMessageID() string { return uuid.NewString() }

// Envelope is the closed ten-field v2 frame envelope (device-design §3.1). The
// outer transport fields are not signed; the signature covers
// {schema_version, type, body} (internal/devicesig.SignedPayload). recovery_generation
// is a uint64 carried as a decimal string at the JSON boundary.
type Envelope struct {
	SchemaVersion      int             `json:"schema_version"`
	Type               string          `json:"type"`
	MessageID          string          `json:"message_id"`
	DeviceID           string          `json:"device_id"`
	SessionID          string          `json:"session_id"`
	AgentInstanceID    string          `json:"agent_instance_id"`
	BootID             string          `json:"boot_id"`
	RecoveryGeneration string          `json:"recovery_generation"`
	SentAt             string          `json:"sent_at"`
	Body               json.RawMessage `json:"body"`
}

// HelloBody is the hello frame body (device-design §3.1 hello row; Rust
// frame/hello.rs HelloBody). last_receipt_seq is a uint64 decimal string.
type HelloBody struct {
	ClientVersion     string   `json:"client_version"`
	ProtocolMajor     int      `json:"protocol_major"`
	ProtocolMinor     int      `json:"protocol_minor"`
	RequiredFeatures  []string `json:"required_features"`
	ToolManifestHash  string   `json:"tool_manifest_hash"`
	RuntimeDigest     string   `json:"runtime_digest"`
	ProfileID         string   `json:"profile_id"`
	JournalEpoch      string   `json:"journal_epoch"`
	LastReceiptSeq    string   `json:"last_receipt_seq"`
	Ticket            string   `json:"ticket"`
	ChallengeResponse string   `json:"challenge_response"`
	Signature         string   `json:"signature"`
}

// knownFeatures is the closed set of security features this gateway understands.
// An unknown security feature is refused, never ignored-then-executed
// (device-design §3.1 hello row; m1a §12.8 ⑤). The set grows as frames land.
var knownFeatures = map[string]bool{
	"journal": true,
}

// parseEnvelope decodes one raw frame and checks the schema version.
func parseEnvelope(raw []byte) (*Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("invalid_request: envelope: %w", err)
	}
	if env.SchemaVersion != 2 {
		return nil, fmt.Errorf("invalid_request: schema_version %d", env.SchemaVersion)
	}
	if env.Type == "" || env.MessageID == "" {
		return nil, fmt.Errorf("invalid_request: envelope type/message_id")
	}
	return &env, nil
}

// checkFeatures refuses any required security feature the gateway does not know.
func checkFeatures(features []string) error {
	for _, f := range features {
		if !knownFeatures[f] {
			return fmt.Errorf("unknown_required_feature:%s", f)
		}
	}
	return nil
}

// helloCommand builds the p_hello jsonb activate_device_session expects (m1a
// §12.8). boot_id and agent_instance_id live in the envelope, not the body, so the
// gateway merges them in; the device cannot override the server-mapped device/org
// (device-design §3.1). The body's own fields pass through unchanged.
func helloCommand(env *Envelope, body *HelloBody) (map[string]any, error) {
	if env.BootID == "" || env.AgentInstanceID == "" {
		return nil, fmt.Errorf("invalid_request: envelope boot_id/agent_instance_id")
	}
	return map[string]any{
		"client_version":     body.ClientVersion,
		"protocol_major":     body.ProtocolMajor,
		"protocol_minor":     body.ProtocolMinor,
		"required_features":  body.RequiredFeatures,
		"tool_manifest_hash": body.ToolManifestHash,
		"runtime_digest":     body.RuntimeDigest,
		"profile_id":         body.ProfileID,
		"journal_epoch":      body.JournalEpoch,
		"last_receipt_seq":   body.LastReceiptSeq,
		"boot_id":            env.BootID,
		"agent_instance_id":  env.AgentInstanceID,
		"challenge_response": body.ChallengeResponse,
	}, nil
}

// helloAckEnvelope wraps the activate_device_session result (session_id,
// server_time, generation, lease_ttl_ms, heartbeat_ms, resync_required) into a
// hello_ack frame addressed to the device with the freshly allocated session. It
// also carries server_public_jwk (GW7): the gateway's server signing public key,
// which the device provisions to verify server-signed downlink frames
// (operation_resolution/permit/lease/command/finish_ack).
func helloAckEnvelope(deviceID, sessionID string, ack, serverJWK json.RawMessage) ([]byte, error) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(ack, &body); err != nil {
		return nil, err
	}
	body["server_public_jwk"] = serverJWK
	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	env := Envelope{
		SchemaVersion: 2,
		Type:          "hello_ack",
		MessageID:     newMessageID(),
		DeviceID:      deviceID,
		SessionID:     sessionID,
		Body:          bodyJSON,
	}
	raw, err := json.Marshal(env)
	if err != nil {
		return nil, err
	}
	return raw, nil
}
