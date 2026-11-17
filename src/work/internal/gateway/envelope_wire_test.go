package gateway

import (
	"encoding/json"
	"strconv"
	"testing"

	"github.com/we-meet/work/internal/devicesig"
)

// deviceEnvelope mirrors the Rust device's closed ten-field envelope
// (src/device/src/frame/envelope.rs). recovery_generation is a STRING there and its u64string
// adapter does `text.parse::<u64>()`, so an empty string — the zero value of the Go field — is
// refused and the device cannot parse the frame at all. Every server downlink builder must
// state the generation explicitly (device-design §3.1 uint64 decimal-string boundary).
type deviceEnvelope struct {
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

// assertDeviceParseable checks the frame against the device's strict boundary: all ten closed
// fields present, and recovery_generation a decimal string a u64 parser accepts.
func assertDeviceParseable(t *testing.T, raw []byte, wantType string) {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("%s: not a JSON object: %v", wantType, err)
	}
	for _, key := range []string{
		"schema_version", "type", "message_id", "device_id", "session_id",
		"agent_instance_id", "boot_id", "recovery_generation", "sent_at", "body",
	} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("%s: envelope missing closed field %q: %s", wantType, key, raw)
		}
	}
	if len(fields) != 10 {
		t.Fatalf("%s: envelope has %d fields, want the closed 10: %s", wantType, len(fields), raw)
	}
	var env deviceEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("%s: %v", wantType, err)
	}
	if env.SchemaVersion != 2 || env.Type != wantType {
		t.Fatalf("%s: schema/type = %d/%q", wantType, env.SchemaVersion, env.Type)
	}
	if env.DeviceID != "dev-1" || env.SessionID != "sess-1" || env.MessageID == "" {
		t.Fatalf("%s: addressing = %#v", wantType, env)
	}
	// The exact judgment the device makes: a decimal string, never "" and never a JSON number.
	if _, err := strconv.ParseUint(env.RecoveryGeneration, 10, 64); err != nil {
		t.Fatalf("%s: recovery_generation %q is not a uint64 decimal string: %v",
			wantType, env.RecoveryGeneration, err)
	}
	var number any
	if err := json.Unmarshal(fields["recovery_generation"], &number); err != nil {
		t.Fatal(err)
	}
	if _, isString := number.(string); !isString {
		t.Fatalf("%s: recovery_generation crossed as %T, want a decimal string", wantType, number)
	}
}

// TestDownlinkEnvelopesCrossTheDeviceUint64Boundary covers EVERY server downlink builder. Before
// GW17 all eight left RecoveryGeneration at its Go zero value "", which the device's strict
// u64string adapter refuses — so no downlink frame was parseable device-side. The break was
// invisible until the device grew a live transport, because every earlier device consumer took
// the frame BODY and never parsed the envelope.
func TestDownlinkEnvelopesCrossTheDeviceUint64Boundary(t *testing.T) {
	key, err := devicesig.GenerateSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	serverJWK, err := devicesig.PublicJWK(key)
	if err != nil {
		t.Fatal(err)
	}
	permitKey, err := devicesig.GenerateSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	permitJWK, err := devicesig.PublicJWK(permitKey)
	if err != nil {
		t.Fatal(err)
	}

	ackResult := json.RawMessage(`{"recorded":[],"conflicts":[],"receipt_through_seq":1}`)
	cases := []struct {
		name  string
		build func() ([]byte, error)
	}{
		{"hello_ack", func() ([]byte, error) {
			return helloAckEnvelope("dev-1", "sess-1",
				json.RawMessage(`{"session_id":"sess-1","server_time":"2026-11-17T05:30:52.123456+00:00","generation":7,"lease_ttl_ms":30000,"heartbeat_ms":10000,"resync_required":true}`),
				serverJWK, permitJWK)
		}},
		{"receipt_ack", func() ([]byte, error) {
			return receiptAckEnvelope("dev-1", "sess-1", ackResult, key)
		}},
		{"reconcile_ack", func() ([]byte, error) {
			return reconcileAckEnvelope("dev-1", "sess-1", ackResult, key)
		}},
		{"checkpoint_ack", func() ([]byte, error) {
			return checkpointAckEnvelope("dev-1", "sess-1",
				json.RawMessage(`{"run_id":"run-1","checkpoint_seq":1,"state":"recorded","receipt_through_seq":0}`), key)
		}},
		{"run_finish_ack", func() ([]byte, error) {
			return finishAckEnvelope("dev-1", "sess-1",
				json.RawMessage(`{"finish_id":"f1","state":"accepted","code":null,"terminal_run_revision":1,"expected_operation_set_hash":"","unresolved_operations":[]}`), key)
		}},
		{"action_prepared", func() ([]byte, error) {
			return actionPreparedEnvelope("dev-1", "sess-1",
				json.RawMessage(`{"operation_id":"op1","logical_key":"step#0","step_key":"step","supersede_no":0,"state":"prepared","revision":1,"approval_id":null,"auto_approved":true,"request_hash":"h","attempt_id":"a1","checkpoint_seq":0,"classification":"local_only","destination_id":null}`), key)
		}},
		{"lease", func() ([]byte, error) {
			return leaseEnvelope("dev-1", "sess-1",
				json.RawMessage(`{"lease_id":"l1","run_id":"run-1","fence":2,"expires_at":"2026-11-17T00:00:30Z","ttl_ms":30000}`))
		}},
		{"operation_resolution", func() ([]byte, error) {
			return resolutionEnvelope("dev-1", "sess-1", []byte(`{"resolve_id":"r1","state":"succeeded"}`))
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := tc.build()
			if err != nil {
				t.Fatal(err)
			}
			assertDeviceParseable(t, raw, tc.name)
		})
	}

	// signedDownlink is the shared builder behind run_offer, run_start, command and cancel.
	for _, frameType := range []string{"run_offer", "run_start", "command", "cancel"} {
		t.Run(frameType, func(t *testing.T) {
			raw, err := signedDownlink(key, frameType, "dev-1", "sess-1", map[string]any{"k": "v"})
			if err != nil {
				t.Fatal(err)
			}
			assertDeviceParseable(t, raw, frameType)
		})
	}
}

// TestHelloAckCarriesTwoIndependentKeys pins the bootstrap the device's parse_hello_ack
// validates: the frame key and the permit key are both present and are NOT the same key
// (device-design §3.3; GW14 asserts on both sides that they are not interchangeable).
func TestHelloAckCarriesTwoIndependentKeys(t *testing.T) {
	key, err := devicesig.GenerateSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	serverJWK, err := devicesig.PublicJWK(key)
	if err != nil {
		t.Fatal(err)
	}
	permitKey, err := devicesig.GenerateSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	permitJWK, err := devicesig.PublicJWK(permitKey)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := helloAckEnvelope("dev-1", "sess-1",
		json.RawMessage(`{"session_id":"sess-1","server_time":"2026-11-17T05:30:52.123456+00:00","generation":7,"lease_ttl_ms":30000,"heartbeat_ms":10000,"resync_required":true}`),
		serverJWK, permitJWK)
	if err != nil {
		t.Fatal(err)
	}
	var env deviceEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(env.Body, &body); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{
		"session_id", "server_time", "generation", "lease_ttl_ms", "heartbeat_ms",
		"resync_required", "server_public_jwk", "permit_public_jwk",
	} {
		if _, ok := body[k]; !ok {
			t.Fatalf("hello_ack body missing %q: %s", k, env.Body)
		}
	}
	if string(body["server_public_jwk"]) == string(body["permit_public_jwk"]) {
		t.Fatal("hello_ack provisioned one key for both roles; §3.3 requires an independent permit key")
	}
	// generation is a JSON NUMBER (jsonb_build_object with an int, 0040:1666), unlike the
	// envelope's recovery_generation which is a decimal string. The device parses it as u64.
	var generation any
	if err := json.Unmarshal(body["generation"], &generation); err != nil {
		t.Fatal(err)
	}
	if _, isNumber := generation.(float64); !isNumber {
		t.Fatalf("generation crossed as %T, want the JSON number activate_device_session emits", generation)
	}
	// server_time is Postgres now(): fractional seconds and a +00:00 offset, NOT the
	// whole-second ...Z form the device's strict RFC3339 parser accepts. The device carries it
	// opaquely and never does arithmetic on it (§3.3's local deadline is monotonic).
	var serverTime string
	if err := json.Unmarshal(body["server_time"], &serverTime); err != nil {
		t.Fatal(err)
	}
	if len(serverTime) == 20 && serverTime[19] == 'Z' {
		t.Fatalf("server_time %q is the whole-second form; the landed SQL emits now() with fraction+offset", serverTime)
	}
}
