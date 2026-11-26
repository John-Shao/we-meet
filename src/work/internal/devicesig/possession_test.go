package devicesig

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPossessionProofClosedShapeAndSignature(t *testing.T) {
	privateKey, err := GenerateSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	publicJWK, err := PublicJWK(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := ParseJWK(publicJWK)
	if err != nil {
		t.Fatal(err)
	}
	proof := []byte(`{"v":1,"org_id":"org","subject_id":"subject","auth_plane":"bearer","auth_epoch":"4","device_id":"11111111-1111-4111-8111-111111111111","session_id":"22222222-2222-4222-8222-222222222222","task_id":"33333333-3333-4333-8333-333333333333","artifact_id":"44444444-4444-4444-8444-444444444444","version_id":"55555555-5555-4555-8555-555555555555","content_hash":"` + strings.Repeat("a", 64) + `","purpose":"accept","request_id":"accept-1","nonce":"nonce-accept-1","expires_at":"2027-01-01T00:00:00Z"}`)
	parsed, err := ParsePossessionProof(proof)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Purpose != "accept" || parsed.AuthEpoch != "4" {
		t.Fatalf("parsed = %#v", parsed)
	}
	signature, err := SignFrame(privateKey, PossessionProofType, proof)
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPossession(publicKey, proof, signature) {
		t.Fatal("valid possession signature rejected")
	}
	tampered := strings.Replace(string(proof), `"accept-1"`, `"accept-2"`, 1)
	if VerifyPossession(publicKey, []byte(tampered), signature) {
		t.Fatal("tampered possession proof accepted")
	}
	wrongDomain, err := SignFrame(privateKey, UserVersionProofType, proof)
	if err != nil {
		t.Fatal(err)
	}
	if VerifyPossession(publicKey, proof, wrongDomain) {
		t.Fatal("cross-domain signature accepted")
	}
}

func TestPossessionProofRejectsExtraKeyAndNumericEpoch(t *testing.T) {
	base := map[string]any{
		"v": 1, "org_id": "org", "subject_id": "subject", "auth_plane": "bearer",
		"auth_epoch": "4", "device_id": "11111111-1111-4111-8111-111111111111",
		"session_id":   "22222222-2222-4222-8222-222222222222",
		"task_id":      "33333333-3333-4333-8333-333333333333",
		"artifact_id":  "44444444-4444-4444-8444-444444444444",
		"version_id":   "55555555-5555-4555-8555-555555555555",
		"content_hash": strings.Repeat("a", 64), "purpose": "accept",
		"request_id": "accept-1", "nonce": "nonce-accept-1", "expires_at": "2027-01-01T00:00:00Z",
	}
	raw, _ := json.Marshal(base)
	if _, err := ParsePossessionProof(raw); err != nil {
		t.Fatalf("valid shape rejected: %v", err)
	}
	base["signature"] = strings.Repeat("A", 86)
	raw, _ = json.Marshal(base)
	if _, err := ParsePossessionProof(raw); err == nil {
		t.Fatal("extra signature key accepted")
	}
	delete(base, "signature")
	base["auth_epoch"] = 4
	raw, _ = json.Marshal(base)
	if _, err := ParsePossessionProof(raw); err == nil {
		t.Fatal("numeric epoch accepted")
	}
}
