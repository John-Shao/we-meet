package providerctx_test

import (
	"bytes"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/credentials"
	"github.com/we-meet/work/internal/providerctx"
)

// These tests cover the 0024 administration probe grant against a real PostgreSQL, so
// the one-shot claim, the window, the org scoping and the envelope refusal are asserted
// through work_worker and the domain functions rather than through a fake.

// seedProbeOrg creates an org plus the owner member that work.assert_org_owner demands:
// the harness's seedOrg builds only the org row, and minting a grant is an
// owner-only command, so without this every issue would fail as actor_mismatch for a
// reason unrelated to what these tests are about.
func seedProbeOrg(t *testing.T) (org, owner string) {
	t.Helper()
	org = seedOrg(t)
	owner = "sub_owner_" + org[:8]
	if _, err := testAdmin.Exec(testContext(t), `
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ($1, $2, 'active', 'owner', true)`, org, owner); err != nil {
		t.Fatalf("seed owner: %v", err)
	}
	return org, owner
}

// setProbeOrg pins the session's app.org_id on the admin connection, the same way the
// application contexts do, so RLS on the grant table is exercised rather than bypassed.
func setProbeOrg(t *testing.T, org, subject string) {
	t.Helper()
	var first, second string
	if err := testAdmin.QueryRow(testContext(t),
		`SELECT set_config('app.org_id', $1, false), set_config('app.subject_id', $2, false)`,
		org, subject).Scan(&first, &second); err != nil {
		t.Fatal(err)
	}
}

func issueGrant(t *testing.T, org, subject, provider, model, endpoint, credentialID, token string, ttl int) string {
	t.Helper()
	setProbeOrg(t, org, subject)
	var grantID string
	if err := testAdmin.QueryRow(testContext(t), `
		SELECT work.issue_provider_probe_grant($1, $2, $3, $4, $5, $6::uuid, $7, $8)`,
		org, subject, provider, model, endpoint, credentialID, token, ttl,
	).Scan(&grantID); err != nil {
		t.Fatalf("issue grant: %v", err)
	}
	return grantID
}

func grantConsumed(t *testing.T, grantID string) bool {
	t.Helper()
	var consumed bool
	if err := testAdmin.QueryRow(testContext(t), `
		SELECT consumed_at IS NOT NULL FROM work.provider_probe_grant WHERE grant_id = $1::uuid`,
		grantID).Scan(&consumed); err != nil {
		t.Fatal(err)
	}
	return consumed
}

func probeToken(seed string) string {
	sum := hex.EncodeToString(bytes.Repeat([]byte{byte(len(seed))}, 32))
	return sum
}

func TestProbeClaimIsSingleUse(t *testing.T) {
	requireDB(t)
	org, owner := seedProbeOrg(t)
	plaintext := []byte(secretMarker)
	credentialID := seedManagedKeyProvider(t, org, plaintext)
	token := probeToken("single-use")
	grantID := issueGrant(t, org, owner, "aliyun", "qwen-max",
		"https://dashscope.example.test/v1", credentialID, token, 60)

	probe := &providerctx.Probe{Pool: testPool, Master: testMaster}
	ctx := testContext(t)

	resolved, err := probe.Claim(ctx, org, grantID, token)
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	// The candidate - not the active configuration - is what a pre-save probe must dial.
	if resolved.Provider != "aliyun" || resolved.Model != "qwen-max" ||
		resolved.Endpoint != "https://dashscope.example.test/v1" || resolved.Mode != "managed_key" {
		t.Fatalf("candidate context = %+v", resolved)
	}
	if !bytes.Equal(resolved.Secret, plaintext) {
		t.Fatal("probe did not decrypt the candidate credential")
	}
	if resolved.ConfigRevision != 0 || resolved.Region != "" {
		t.Fatalf("probe fabricated config fields: %+v", resolved)
	}
	if !grantConsumed(t, grantID) {
		t.Fatal("grant still unconsumed after a successful claim")
	}

	if _, err := probe.Claim(ctx, org, grantID, token); err == nil {
		t.Fatal("replayed token claimed a second provider context")
	} else {
		requireCode(t, err, providerctx.CodeProbeGrantInvalid)
	}
}

func TestProbeWrongTokenDoesNotBurnTheGrant(t *testing.T) {
	requireDB(t)
	org, owner := seedProbeOrg(t)
	credentialID := seedManagedKeyProvider(t, org, []byte(secretMarker))
	token := probeToken("wrong-token")
	grantID := issueGrant(t, org, owner, "aliyun", "qwen-max",
		"https://dashscope.example.test/v1", credentialID, token, 60)

	probe := &providerctx.Probe{Pool: testPool, Master: testMaster}
	ctx := testContext(t)

	if _, err := probe.Claim(ctx, org, grantID, probeToken("different")); err == nil {
		t.Fatal("a wrong token claimed the grant")
	} else {
		requireCode(t, err, providerctx.CodeProbeGrantInvalid)
	}
	// Security-relevant and not obvious from the happy path: a failed guess must not
	// consume the legitimate holder's single use.
	if grantConsumed(t, grantID) {
		t.Fatal("a wrong token consumed the grant")
	}

	resolved, err := probe.Claim(ctx, org, grantID, token)
	if err != nil {
		t.Fatalf("holder claim after a failed guess: %v", err)
	}
	if resolved.Mode != "managed_key" {
		t.Fatalf("resolved = %+v", resolved)
	}
}

func TestProbeExpiredGrantIsRejected(t *testing.T) {
	requireDB(t)
	org, owner := seedProbeOrg(t)
	credentialID := seedManagedKeyProvider(t, org, []byte(secretMarker))
	token := probeToken("expiry")
	grantID := issueGrant(t, org, owner, "aliyun", "qwen-max",
		"https://dashscope.example.test/v1", credentialID, token, 1)

	// Wait past the one second window; the grant must then be unclaimable while still
	// readable as never consumed, so expiry never looks like a spend.
	time.Sleep(2 * time.Second)

	probe := &providerctx.Probe{Pool: testPool, Master: testMaster}
	if _, err := probe.Claim(testContext(t), org, grantID, token); err == nil {
		t.Fatal("expired grant was claimable")
	} else {
		requireCode(t, err, providerctx.CodeProbeGrantInvalid)
	}
	if grantConsumed(t, grantID) {
		t.Fatal("an expired grant was marked consumed")
	}
}

func TestProbeClaimIsOrgScoped(t *testing.T) {
	requireDB(t)
	owner, ownerSubject := seedProbeOrg(t)
	credentialID := seedManagedKeyProvider(t, owner, []byte(secretMarker))
	token := probeToken("cross-org")
	grantID := issueGrant(t, owner, ownerSubject, "aliyun", "qwen-max",
		"https://dashscope.example.test/v1", credentialID, token, 60)

	other := newOrgID(t)
	setProbeOrg(t, other, "")
	var inserted string
	if err := testAdmin.QueryRow(testContext(t), `
		SELECT grant_id::text FROM work.provider_probe_grant
		WHERE org_id = $1`, owner).Scan(&inserted); err != nil {
		t.Fatal(err)
	}

	probe := &providerctx.Probe{Pool: testPool, Master: testMaster}
	if _, err := probe.Claim(testContext(t), other, grantID, token); err == nil {
		t.Fatal("another organization claimed someone else's grant")
	} else {
		requireCode(t, err, providerctx.CodeProbeGrantInvalid)
	}
	// And the real holder can still spend it.
	if _, err := probe.Claim(testContext(t), owner, grantID, token); err != nil {
		t.Fatalf("holder claim after a cross-org attempt: %v", err)
	}
}

func TestProbeGrantOverEnvelopeCredentialIsUnsupported(t *testing.T) {
	requireDB(t)
	org, owner := seedProbeOrg(t)
	kms := "cmk/reserved"
	credentialID := insertCredential(t, org, credentialSeed{
		provider:    "deepseek",
		mode:        "managed_key",
		ciphertext:  []byte("not-decryptable-envelope"),
		wrappedDEK:  []byte{0x01, 0x02},
		kmsKeyRef:   &kms,
		fingerprint: "fp-envelope-0001",
	})
	token := probeToken("envelope")
	grantID := issueGrant(t, org, owner, "deepseek", "deepseek-chat",
		"https://api.deepseek.example.test/v1", credentialID, token, 60)

	probe := &providerctx.Probe{Pool: testPool, Master: testMaster}
	if _, err := probe.Claim(testContext(t), org, grantID, token); err == nil {
		t.Fatal("an envelope row was probed as if it were the single-layer form")
	} else {
		requireCode(t, err, providerctx.CodeProviderContextUnsupported)
	}
}

func TestProbeGrantIssueValidatesBeforeStoring(t *testing.T) {
	requireDB(t)
	org, owner := seedProbeOrg(t)
	credentialID := seedManagedKeyProvider(t, org, []byte(secretMarker))
	ctx := testContext(t)
	setProbeOrg(t, org, owner)
	cases := []struct {
		name                             string
		provider, model, endpoint, token string
		ttl                              int
	}{
		{"unknown provider", "openai", "gpt", "https://x.example.test/v1", probeToken("a"), 60},
		{"empty model", "aliyun", " ", "https://x.example.test/v1", probeToken("b"), 60},
		{"plain endpoint", "aliyun", "m", "http://x.example.test/v1", probeToken("c"), 60},
		{"short token", "aliyun", "m", "https://x.example.test/v1", "abc123", 60},
		{"ttl too long", "aliyun", "m", "https://x.example.test/v1", probeToken("d"), 3600},
		{"ttl zero", "aliyun", "m", "https://x.example.test/v1", probeToken("e"), 0},
	}
	for _, item := range cases {
		_, err := testAdmin.Exec(ctx, `
			SELECT work.issue_provider_probe_grant($1, $2, $3, $4, $5, $6::uuid, $7, $8)`,
			org, owner, item.provider, item.model, item.endpoint, credentialID, item.token, item.ttl)
		if err == nil {
			t.Fatalf("%s: grant issued for an invalid request", item.name)
		}
		// 22023 is the constraint-violation class every one of these guards raises in.
		// Asserting the class is what keeps this test from passing on actor_mismatch,
		// which is a different failure and would hide a broken fixture.
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) {
			t.Fatalf("%s: err type %T (%v), want a PgError", item.name, err, err)
		}
		if pgErr.Code != "22023" {
			t.Fatalf("%s: SQLSTATE %s message %q, want 22023 (invalid_request)",
				item.name, pgErr.Code, pgErr.Message)
		}
	}

	// A non-owner cannot mint a probe at all, even holding a valid credential.
	member := "sub_member"
	if _, err := testAdmin.Exec(ctx, `
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ($1, $2, 'active', 'member', true)`, org, member); err != nil {
		t.Fatal(err)
	}
	setProbeOrg(t, org, member)
	if _, err := testAdmin.Exec(ctx, `
		SELECT work.issue_provider_probe_grant($1, $2, 'aliyun', 'qwen-max',
		       'https://x.example.test/v1', $3::uuid, $4, 60)`,
		org, member, credentialID, probeToken("f")); err == nil {
		t.Fatal("a non-owner minted a probe grant")
	} else {
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Message != "owner_access_denied" {
			t.Fatalf("non-owner issue = %v, want owner_access_denied", err)
		}
	}

	// The plaintext really is recoverable only through the single-layer form this
	// package understands, which is what makes the probe answer trustworthy.
	if _, err := credentials.Open(testMaster, org, []byte("short")); err == nil {
		t.Fatal("credentials.Open accepted a truncated ciphertext")
	}
	var bound string
	if err := testAdmin.QueryRow(ctx, `
		SELECT provider FROM work.provider_credential WHERE id = $1::uuid`, credentialID,
	).Scan(&bound); err != nil {
		t.Fatal(err)
	}
	if bound != "aliyun" {
		t.Fatalf("seeded credential provider = %q", bound)
	}
}
