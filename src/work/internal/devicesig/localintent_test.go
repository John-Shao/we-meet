package devicesig

import (
	"encoding/json"
	"strings"
	"testing"
)

const vectorLocalIntentBody = `{"v":1,"org_id":"org","subject_id":"subject","auth_plane":"bearer","auth_epoch":"3","device_id":"11111111-1111-4111-8111-111111111111","session_id":"22222222-2222-4222-8222-222222222222","request_id":"local-submit-1","input_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","preview_hash":"p1.preview.signature","target_selection_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","selected_grant_ids":["33333333-3333-4333-8333-333333333333"],"grant_revisions":["1"],"profile_id":"local-profile","profile_revision":"2","profile_hash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","nonce":"nonce-local-1","expires_at":"2027-01-01T00:00:00Z"}`

const vectorLocalIntentSig = "D3F3eF3QxH5vcT4PjrRsXHjY-b0FY1gSFHng6yQqBjA7HY29X4j5xd9VXuhb5N5C2iv_13RzdXf0Fo-fVIjX-A"

func TestLocalIntentCrossLanguageVector(t *testing.T) {
	proof := strings.TrimSuffix(vectorLocalIntentBody, "}") + `,"signature":"` + vectorLocalIntentSig + `"}`
	parsed, err := ParseLocalIntentProof([]byte(proof))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.RequestID != "local-submit-1" || parsed.ProfileRevision != "2" {
		t.Fatalf("parsed = %#v", parsed)
	}
	if !VerifyLocalIntent(mustParse(t), []byte(proof)) {
		t.Fatal("local intent signature did not verify")
	}
	if VerifyFrame(mustParse(t), ApprovalDecisionProofType, []byte(proof), vectorLocalIntentSig) {
		t.Fatal("local intent signature verified under another proof type")
	}
}

func TestLocalIntentSignatureBindsEveryField(t *testing.T) {
	pub := mustParse(t)
	for _, field := range []string{
		"v", "org_id", "subject_id", "auth_plane", "auth_epoch", "device_id", "session_id",
		"request_id", "input_hash", "preview_hash", "target_selection_hash", "selected_grant_ids",
		"grant_revisions", "profile_id", "profile_revision", "profile_hash", "nonce", "expires_at",
	} {
		t.Run(field, func(t *testing.T) {
			var proof map[string]any
			if err := json.Unmarshal([]byte(vectorLocalIntentBody), &proof); err != nil {
				t.Fatal(err)
			}
			proof[field] = "tampered"
			raw, err := json.Marshal(proof)
			if err != nil {
				t.Fatal(err)
			}
			if VerifyFrame(pub, LocalIntentProofType, raw, vectorLocalIntentSig) {
				t.Fatalf("tampered %s verified", field)
			}
		})
	}
}

func TestConfigurationProbeIntentAllowsOnlyExplicitEmptyGrants(t *testing.T) {
	body := strings.Replace(vectorLocalIntentBody,
		`"selected_grant_ids":["33333333-3333-4333-8333-333333333333"],"grant_revisions":["1"]`,
		`"selected_grant_ids":[],"grant_revisions":[]`, 1)
	proof := strings.TrimSuffix(body, "}") + `,"signature":"` + vectorLocalIntentSig + `"}`
	if _, err := ParseLocalIntentProof([]byte(proof)); err == nil {
		t.Fatal("ordinary local intent accepted empty grants")
	}
	parsed, err := ParseConfigurationProbeIntentProof([]byte(proof))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.SelectedGrantIDs == nil || parsed.GrantRevisions == nil ||
		len(parsed.SelectedGrantIDs) != 0 || len(parsed.GrantRevisions) != 0 {
		t.Fatalf("probe grants = %#v/%#v", parsed.SelectedGrantIDs, parsed.GrantRevisions)
	}
	if VerifyConfigurationProbeIntent(mustParse(t), []byte(proof)) {
		t.Fatal("empty-grant intent verified with a signature for different bytes")
	}
}

func TestLocalIntentRejectsOpenAndAmbiguousShapes(t *testing.T) {
	base := func() map[string]any {
		var proof map[string]any
		if err := json.Unmarshal([]byte(vectorLocalIntentBody), &proof); err != nil {
			t.Fatal(err)
		}
		proof["signature"] = vectorLocalIntentSig
		return proof
	}
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"extra key", func(p map[string]any) { p["target"] = "local" }},
		{"missing key", func(p map[string]any) { delete(p, "target_selection_hash") }},
		{"numeric epoch", func(p map[string]any) { p["auth_epoch"] = 3 }},
		{"numeric profile revision", func(p map[string]any) { p["profile_revision"] = 2 }},
		{"noncanonical revision", func(p map[string]any) { p["grant_revisions"] = []string{"01"} }},
		{"mismatched grants", func(p map[string]any) { p["grant_revisions"] = []string{} }},
		{"duplicate grants", func(p map[string]any) {
			p["selected_grant_ids"] = []string{"33333333-3333-4333-8333-333333333333", "33333333-3333-4333-8333-333333333333"}
			p["grant_revisions"] = []string{"1", "2"}
		}},
		{"too many grants", func(p map[string]any) {
			p["selected_grant_ids"] = []string{"33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"}
			p["grant_revisions"] = []string{"1", "1", "1", "1", "1"}
		}},
		{"cookie plane", func(p map[string]any) { p["auth_plane"] = "cookie" }},
		{"uppercase digest", func(p map[string]any) { p["input_hash"] = strings.Repeat("A", 64) }},
		{"empty preview", func(p map[string]any) { p["preview_hash"] = " " }},
		{"short request", func(p map[string]any) { p["request_id"] = "short" }},
		{"bad expiry", func(p map[string]any) { p["expires_at"] = "tomorrow" }},
		{"fractional expiry", func(p map[string]any) { p["expires_at"] = "2027-01-01T00:00:00.5Z" }},
		{"bad signature", func(p map[string]any) { p["signature"] = "not-a-signature" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proof := base()
			tc.mutate(proof)
			raw, err := json.Marshal(proof)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ParseLocalIntentProof(raw); err == nil {
				t.Fatal("invalid local intent shape accepted")
			}
		})
	}
}
