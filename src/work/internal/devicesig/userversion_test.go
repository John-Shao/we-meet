package devicesig

import (
	"encoding/json"
	"testing"
)

const (
	vectorUserVersionProof = `{"v":1,"org_id":"org","subject_id":"subject","auth_plane":"bearer","auth_epoch":"4","device_id":"11111111-1111-4111-8111-111111111111","session_id":"22222222-2222-4222-8222-222222222222","task_id":"33333333-3333-4333-8333-333333333333","artifact_id":"44444444-4444-4444-8444-444444444444","base_version_no":1,"base_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version_id":"55555555-5555-4555-8555-555555555555","format":"text/markdown","content_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","bytes":512,"classification":"local_only","clipboard_derived":false,"clipboard_source_version_ids":[],"client_request_id":"save-0001","nonce":"nonce-user-version-1","expires_at":"2027-01-01T00:00:00Z"}`
	vectorUserVersionSig   = "Aq4fF2MQHQ4b2PKBL1SAZuFm6WqXiozVU8eSlFpulHdvUOGGvCN8_eU8nnp5lQvakw8GryVIhTW5U8oLg9U8iQ"
)

func TestVerifyUserVersionCrossLanguage(t *testing.T) {
	pub := mustParse(t)
	if !VerifyUserVersion(pub, []byte(vectorUserVersionProof), vectorUserVersionSig) {
		t.Fatal("Rust user-version signature did not verify")
	}
}

func TestVerifyUserVersionBindsEveryFieldAndType(t *testing.T) {
	pub := mustParse(t)
	for _, field := range []string{
		"v", "org_id", "subject_id", "auth_plane", "auth_epoch", "device_id",
		"session_id", "task_id", "artifact_id", "base_version_no", "base_hash",
		"version_id", "format", "content_hash", "bytes", "classification",
		"clipboard_derived", "clipboard_source_version_ids", "client_request_id",
		"nonce", "expires_at",
	} {
		t.Run(field, func(t *testing.T) {
			var proof map[string]any
			if err := json.Unmarshal([]byte(vectorUserVersionProof), &proof); err != nil {
				t.Fatal(err)
			}
			proof[field] = "tampered"
			raw, err := json.Marshal(proof)
			if err != nil {
				t.Fatal(err)
			}
			if VerifyUserVersion(pub, raw, vectorUserVersionSig) {
				t.Fatalf("tampered %s verified", field)
			}
		})
	}
	if VerifyFrame(pub, "workspace_grant_succession", []byte(vectorUserVersionProof), vectorUserVersionSig) {
		t.Fatal("user-version signature verified under another frame type")
	}
}
