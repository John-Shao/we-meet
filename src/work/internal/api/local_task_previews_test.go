package api

import (
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/host"
)

func TestLocalPreviewTokenBindsCallerEpochAndExpiry(t *testing.T) {
	now := time.Date(2026, 11, 26, 0, 0, 0, 0, time.UTC)
	csrf, err := NewCSRF([]byte("01234567890123456789012345678901"), localPreviewTTL, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{csrf: csrf}
	caller := host.Claims{OrgID: "org", SubjectID: "subject", SessionRevision: 4, AuthPlane: "bearer"}
	template, ok := templateByID("summary")
	if !ok {
		t.Fatal("summary template missing")
	}
	target := localPreviewTarget{
		Kind: "local", ProfileID: "profile", ProfileRevision: "1", ProfileHash: strings.Repeat("a", 64),
		DeviceID: "11111111-1111-4111-8111-111111111111", SessionID: "22222222-2222-4222-8222-222222222222",
		WorkspaceGrants: []localPreviewGrant{{GrantID: "33333333-3333-4333-8333-333333333333", GrantRevision: "1"}},
		RuntimeDigest:   strings.Repeat("b", 64), ToolManifestHash: strings.Repeat("c", 64), ModelVersion: "model",
	}
	targetHash, err := localTargetHash(target)
	if err != nil {
		t.Fatal(err)
	}
	claims := localPreviewClaims{
		OrgID: "org", SubjectID: "subject", AuthEpoch: "4", InputRef: "11111111-1111-4111-8111-111111111111",
		InputHash: strings.Repeat("a", 64), InputBytes: 22, TargetSelection: target, TargetHash: targetHash,
		TemplateID: template.ID, TemplateVersion: template.Version, TemplateHash: template.ContentHash,
		PermissionMode: "ask_each", OutputFormat: "text/markdown", TokenUpperBound: 100,
		ExpiresAtUnix: now.Add(localPreviewTTL).Unix(),
	}
	token, err := server.signLocalPreview(claims)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := server.verifyLocalPreview(token, caller)
	if err != nil || verified.TargetHash != claims.TargetHash {
		t.Fatalf("verified = %#v, err = %v", verified, err)
	}
	if _, err := server.verifyLocalPreview(token, host.Claims{OrgID: "org", SubjectID: "subject", SessionRevision: 5}); err == nil {
		t.Fatal("a different auth epoch verified")
	}
	if _, err := server.verifyLocalPreview(token, host.Claims{OrgID: "other", SubjectID: "subject", SessionRevision: 4}); err == nil {
		t.Fatal("a different organization verified")
	}
	if _, err := server.verifyLocalPreview(token+"x", caller); err == nil {
		t.Fatal("a tampered signature verified")
	}
	badClaims := claims
	badClaims.TargetHash = strings.Repeat("d", 64)
	badToken, err := server.signLocalPreview(badClaims)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.verifyLocalPreview(badToken, caller); err == nil {
		t.Fatal("a signed token with the wrong target hash verified")
	}
	now = now.Add(localPreviewTTL)
	expiredClaims, err := server.verifyLocalPreview(token, caller)
	if err != nil || expiredClaims.ExpiresAtUnix != now.Unix() {
		t.Fatalf("expired preview claims = %#v, %v; expiry is enforced after dedup in submit_local_task", expiredClaims, err)
	}
}

func TestLocalTargetHashBindsGrantRevisionAndProfile(t *testing.T) {
	target := localPreviewTarget{
		Kind: "local", ProfileID: "profile", ProfileRevision: "1", ProfileHash: strings.Repeat("a", 64),
		DeviceID: "11111111-1111-4111-8111-111111111111", SessionID: "22222222-2222-4222-8222-222222222222",
		WorkspaceGrants: []localPreviewGrant{{GrantID: "33333333-3333-4333-8333-333333333333", GrantRevision: "1"}},
		RuntimeDigest:   strings.Repeat("b", 64), ToolManifestHash: strings.Repeat("c", 64), ModelVersion: "model",
	}
	first, err := localTargetHash(target)
	if err != nil {
		t.Fatal(err)
	}
	target.WorkspaceGrants[0].GrantRevision = "2"
	second, err := localTargetHash(target)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("grant revision did not change the target selection hash")
	}
	target.WorkspaceGrants[0].GrantRevision = "1"
	target.ProfileHash = strings.Repeat("d", 64)
	third, err := localTargetHash(target)
	if err != nil {
		t.Fatal(err)
	}
	if first == third {
		t.Fatal("profile hash did not change the target selection hash")
	}
}
