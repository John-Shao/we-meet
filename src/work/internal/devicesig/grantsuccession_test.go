package devicesig

import (
	"encoding/json"
	"testing"
)

const (
	vectorSuccessionProof = `{"old_grant_id":"11111111-1111-1111-1111-111111111111","new_grant_id":"22222222-2222-2222-2222-222222222222","root_identity_hash":"3333333333333333333333333333333333333333333333333333333333333333","run_id":"44444444-4444-4444-4444-444444444444","session_id":"55555555-5555-5555-5555-555555555555","auth_plane":"bearer","auth_epoch":"4","nonce":"nonce-grant-succession-1","expires_at":"2027-01-01T00:00:00Z"}`
	vectorSuccessionSig   = "b9vTZKjSJSOZCPzj-5n-L0yLAtCyqGguvuQYpbJbvyrfvkHwHxuDF4YOWHNieIRTMcRkNHhN6pAnw2M01Ptj_g"
)

func TestVerifyGrantSuccessionCrossLanguage(t *testing.T) {
	pub := mustParse(t)
	if !VerifyGrantSuccession(pub, []byte(vectorSuccessionProof), vectorSuccessionSig) {
		t.Fatal("Rust grant-succession signature did not verify")
	}
}

func TestVerifyGrantSuccessionBindsEveryFieldAndType(t *testing.T) {
	pub := mustParse(t)
	for _, field := range []string{
		"old_grant_id", "new_grant_id", "root_identity_hash", "run_id", "session_id",
		"auth_plane", "auth_epoch", "nonce", "expires_at",
	} {
		t.Run(field, func(t *testing.T) {
			var proof map[string]any
			if err := json.Unmarshal([]byte(vectorSuccessionProof), &proof); err != nil {
				t.Fatal(err)
			}
			proof[field] = "tampered"
			raw, err := json.Marshal(proof)
			if err != nil {
				t.Fatal(err)
			}
			if VerifyGrantSuccession(pub, raw, vectorSuccessionSig) {
				t.Fatalf("tampered %s verified", field)
			}
		})
	}
	if VerifyFrame(pub, "action_prepare", []byte(vectorSuccessionProof), vectorSuccessionSig) {
		t.Fatal("grant-succession signature verified under another frame type")
	}
}
