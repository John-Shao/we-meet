package providerctx_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/credentials"
	"github.com/we-meet/work/internal/providerctx"
	"github.com/we-meet/work/internal/testpg"
)

// These tests exercise internal/providerctx against a real PostgreSQL. Seed
// rows are written with the admin connection; Resolve runs through
// work_worker and work.resolve_provider_context, so grants, RLS, and the
// domain function's exception codes are part of the assertion.

const secretMarker = "MARKER-providerctx-4f8a-never-echo"

var testMaster = bytes.Repeat([]byte{0x6d}, 32)

var (
	testAdmin *pgx.Conn
	testPool  *pgxpool.Pool
)

func TestMain(m *testing.M) {
	if os.Getenv("WORK_TEST_PG_URL") == "" {
		os.Exit(m.Run())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	admin, err := pgx.Connect(ctx, testpg.AdminURL())
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect test PostgreSQL: %v\n", err)
		os.Exit(1)
	}
	if err := testpg.EnsureFixtures(ctx, admin); err != nil {
		fmt.Fprintf(os.Stderr, "prepare test fixtures: %v\n", err)
		os.Exit(1)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_providerctx_test")
	if err != nil {
		fmt.Fprintf(os.Stderr, "create baseline database: %v\n", err)
		os.Exit(1)
	}
	dbAdmin, err := pgx.Connect(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect baseline database: %v\n", err)
		os.Exit(1)
	}
	pool, err := pgxpool.New(ctx, testpg.WorkerURL(dbName))
	if err != nil {
		fmt.Fprintf(os.Stderr, "open worker pool: %v\n", err)
		os.Exit(1)
	}
	testAdmin, testPool = dbAdmin, pool

	code := m.Run()

	pool.Close()
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	_ = dbAdmin.Close(cleanupCtx)
	_ = testpg.DropDatabase(cleanupCtx, admin, dbName)
	_ = admin.Close(cleanupCtx)
	cleanupCancel()
	os.Exit(code)
}

func requireDB(t *testing.T) {
	t.Helper()
	if testAdmin == nil || testPool == nil {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func newOrgID(t *testing.T) string {
	t.Helper()
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		t.Fatal(err)
	}
	return "org_providerctx_" + hex.EncodeToString(buf[:])
}

// seedOrg inserts an org. Increment 0006 installs the AFTER INSERT trigger that
// provisions the default org policy and quota account, so the inserted org must
// also have exactly one policy row without any explicit org_policy write.
func seedOrg(t *testing.T) string {
	t.Helper()
	org := newOrgID(t)
	ctx := testContext(t)
	if _, err := testAdmin.Exec(ctx,
		`INSERT INTO work.org (id, status, home_region) VALUES ($1, 'active', 'cn-north')`,
		org,
	); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	var policies int
	if err := testAdmin.QueryRow(ctx,
		`SELECT count(*) FROM work.org_policy WHERE org_id = $1`, org,
	).Scan(&policies); err != nil {
		t.Fatalf("read auto-provisioned org policy: %v", err)
	}
	if policies != 1 {
		t.Fatalf("org policy rows = %d, want 1 from the auto policy trigger", policies)
	}
	return org
}

type credentialSeed struct {
	provider    string
	mode        string
	roleRef     *string
	ciphertext  []byte
	wrappedDEK  []byte
	kmsKeyRef   *string
	fingerprint string
}

func insertCredential(t *testing.T, org string, seed credentialSeed) string {
	t.Helper()
	var id string
	if err := testAdmin.QueryRow(testContext(t), `
		INSERT INTO work.provider_credential
		  (org_id, provider, mode, role_ref, secret_ciphertext, wrapped_dek,
		   kms_key_ref, secret_fingerprint, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'providerctx-test')
		RETURNING id::text`,
		org, seed.provider, seed.mode, seed.roleRef, seed.ciphertext,
		seed.wrappedDEK, seed.kmsKeyRef, seed.fingerprint,
	).Scan(&id); err != nil {
		t.Fatalf("seed provider credential: %v", err)
	}
	return id
}

func insertConfig(t *testing.T, org, provider, mode, credentialID string) {
	t.Helper()
	if _, err := testAdmin.Exec(testContext(t), `
		INSERT INTO work.provider_access_config
		  (org_id, revision, provider, model, region, endpoint,
		   credential_mode, credential_id, created_by)
		VALUES ($1, 1, $2, 'qwen3-coder-plus', 'cn-beijing',
		        'https://dashscope.aliyuncs.com', $3, $4, 'providerctx-test')`,
		org, provider, mode, credentialID,
	); err != nil {
		t.Fatalf("seed provider access config: %v", err)
	}
}

func seedManagedKeyProvider(t *testing.T, org string, plaintext []byte) string {
	t.Helper()
	ciphertext, fingerprint, err := credentials.Seal(testMaster, org, plaintext)
	if err != nil {
		t.Fatalf("seal provider credential: %v", err)
	}
	credentialID := insertCredential(t, org, credentialSeed{
		provider:    "aliyun",
		mode:        "managed_key",
		ciphertext:  ciphertext,
		fingerprint: fingerprint,
	})
	insertConfig(t, org, "aliyun", "managed_key", credentialID)
	return credentialID
}

// requireCode asserts the typed code, the enumeration-only text, and that no
// error carries the secret marker or database detail.
func requireCode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("Resolve error = nil, want %q", want)
	}
	var typed *providerctx.Error
	if !errors.As(err, &typed) {
		t.Fatalf("Resolve error type = %T, want *providerctx.Error", err)
	}
	if typed.Code != want {
		t.Fatalf("Resolve code = %q, want %q", typed.Code, want)
	}
	if !errors.Is(err, &providerctx.Error{Code: want}) {
		t.Fatalf("errors.Is did not match code %q", want)
	}
	if got, wantText := err.Error(), "providerctx: "+want; got != wantText {
		t.Fatalf("error text = %q, want enumeration only %q", got, wantText)
	}
	for _, forbidden := range []string{
		secretMarker, "SQLSTATE", "ERROR:", "resolve_provider_context", "work.provider",
	} {
		if strings.Contains(err.Error(), forbidden) {
			t.Fatalf("error %q contains forbidden detail %q", err.Error(), forbidden)
		}
	}
}

func TestResolveManagedKeyReturnsPlaintext(t *testing.T) {
	requireDB(t)
	org := seedOrg(t)
	plaintext := []byte(`{"api_key":"` + secretMarker + `","base_url":"https://example.test"}`)
	seedManagedKeyProvider(t, org, plaintext)

	resolver := &providerctx.Resolver{Pool: testPool, Master: testMaster}
	got, err := resolver.Resolve(testContext(t), org)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got.Provider != "aliyun" || got.Model != "qwen3-coder-plus" ||
		got.Region != "cn-beijing" || got.Endpoint != "https://dashscope.aliyuncs.com" {
		t.Fatalf("resolved metadata = %q/%q/%q/%q", got.Provider, got.Model, got.Region, got.Endpoint)
	}
	if got.Mode != "managed_key" {
		t.Fatalf("resolved mode = %q, want managed_key", got.Mode)
	}
	if got.RoleRef != "" {
		t.Fatalf("resolved role ref = %q, want empty for managed_key", got.RoleRef)
	}
	if !bytes.Equal(got.Secret, plaintext) {
		t.Fatalf("resolved secret differs from sealed plaintext (got %d bytes, want %d)",
			len(got.Secret), len(plaintext))
	}
}

func TestResolveRevokedCredential(t *testing.T) {
	requireDB(t)
	org := seedOrg(t)
	plaintext := []byte("token=" + secretMarker)
	credentialID := seedManagedKeyProvider(t, org, plaintext)
	if _, err := testAdmin.Exec(testContext(t), `
		UPDATE work.provider_credential
		SET state = 'revoked', revoked_at = now(), revoked_by = 'providerctx-test'
		WHERE id = $1`, credentialID,
	); err != nil {
		t.Fatalf("revoke credential: %v", err)
	}

	resolver := &providerctx.Resolver{Pool: testPool, Master: testMaster}
	got, err := resolver.Resolve(testContext(t), org)
	requireCode(t, err, providerctx.CodeProviderCredentialRevoked)
	if len(got.Secret) != 0 {
		t.Fatalf("revoked resolve returned a %d-byte secret", len(got.Secret))
	}
}

func TestResolveMissingConfig(t *testing.T) {
	requireDB(t)
	org := seedOrg(t)

	resolver := &providerctx.Resolver{Pool: testPool, Master: testMaster}
	got, err := resolver.Resolve(testContext(t), org)
	requireCode(t, err, providerctx.CodeProviderNotConfigured)
	if len(got.Secret) != 0 {
		t.Fatalf("missing-config resolve returned a %d-byte secret", len(got.Secret))
	}
}

func TestResolveCredentialEncryptedForAnotherOrgFails(t *testing.T) {
	requireDB(t)
	org := seedOrg(t)
	otherOrg := seedOrg(t)
	plaintext := []byte("token=" + secretMarker)
	ciphertext, fingerprint, err := credentials.Seal(testMaster, otherOrg, plaintext)
	if err != nil {
		t.Fatalf("seal for other org: %v", err)
	}
	credentialID := insertCredential(t, org, credentialSeed{
		provider:    "aliyun",
		mode:        "managed_key",
		ciphertext:  ciphertext,
		fingerprint: fingerprint,
	})
	insertConfig(t, org, "aliyun", "managed_key", credentialID)

	resolver := &providerctx.Resolver{Pool: testPool, Master: testMaster}
	got, err := resolver.Resolve(testContext(t), org)
	requireCode(t, err, providerctx.CodeProviderContextUnavailable)
	if len(got.Secret) != 0 {
		t.Fatalf("wrong-org resolve returned a %d-byte secret", len(got.Secret))
	}
}

func TestResolveTamperedCiphertextFails(t *testing.T) {
	requireDB(t)
	org := seedOrg(t)
	plaintext := []byte("token=" + secretMarker)
	sealed, fingerprint, err := credentials.Seal(testMaster, org, plaintext)
	if err != nil {
		t.Fatalf("seal provider credential: %v", err)
	}
	tampered := append([]byte(nil), sealed...)
	tampered[len(tampered)-1] ^= 0xff
	credentialID := insertCredential(t, org, credentialSeed{
		provider:    "aliyun",
		mode:        "managed_key",
		ciphertext:  tampered,
		fingerprint: fingerprint,
	})
	insertConfig(t, org, "aliyun", "managed_key", credentialID)

	resolver := &providerctx.Resolver{Pool: testPool, Master: testMaster}
	got, err := resolver.Resolve(testContext(t), org)
	requireCode(t, err, providerctx.CodeProviderContextUnavailable)
	if len(got.Secret) != 0 {
		t.Fatalf("tampered resolve returned a %d-byte secret", len(got.Secret))
	}
}

func TestResolveSTSReturnsModeWithoutSecret(t *testing.T) {
	requireDB(t)
	org := seedOrg(t)
	roleRef := "acs:ram::1234567890123456:role/work-model"
	credentialID := insertCredential(t, org, credentialSeed{
		provider:    "aliyun",
		mode:        "sts_role",
		roleRef:     &roleRef,
		fingerprint: credentials.Fingerprint([]byte("sts-role:" + roleRef)),
	})
	insertConfig(t, org, "aliyun", "sts_role", credentialID)

	// A nil master proves the sts_role path does not attempt decryption.
	resolver := &providerctx.Resolver{Pool: testPool}
	got, err := resolver.Resolve(testContext(t), org)
	if err != nil {
		t.Fatalf("Resolve sts_role: %v", err)
	}
	if got.Mode != "sts_role" {
		t.Fatalf("resolved mode = %q, want sts_role", got.Mode)
	}
	if got.RoleRef != roleRef {
		t.Fatalf("resolved role ref = %q, want %q", got.RoleRef, roleRef)
	}
	if got.Secret != nil {
		t.Fatalf("sts_role resolve returned a %d-byte secret, want nil", len(got.Secret))
	}
	if got.Provider != "aliyun" || got.Model != "qwen3-coder-plus" {
		t.Fatalf("resolved metadata = %q/%q", got.Provider, got.Model)
	}
}

func TestResolveWrappedDEKIsUnsupported(t *testing.T) {
	requireDB(t)
	org := seedOrg(t)
	plaintext := []byte("token=" + secretMarker)
	sealed, fingerprint, err := credentials.Seal(testMaster, org, plaintext)
	if err != nil {
		t.Fatalf("seal provider credential: %v", err)
	}
	kmsKeyRef := "kms://work-test/provider-envelope"
	credentialID := insertCredential(t, org, credentialSeed{
		provider:    "aliyun",
		mode:        "managed_key",
		ciphertext:  sealed,
		wrappedDEK:  []byte{0xde, 0xad, 0xbe, 0xef},
		kmsKeyRef:   &kmsKeyRef,
		fingerprint: fingerprint,
	})
	insertConfig(t, org, "aliyun", "managed_key", credentialID)

	resolver := &providerctx.Resolver{Pool: testPool, Master: testMaster}
	got, err := resolver.Resolve(testContext(t), org)
	requireCode(t, err, providerctx.CodeProviderContextUnsupported)
	if len(got.Secret) != 0 {
		t.Fatalf("KMS envelope resolve returned a %d-byte secret", len(got.Secret))
	}
}

func TestContextFormattingRedactsSecret(t *testing.T) {
	ctxValue := providerctx.Context{
		Provider: "aliyun",
		Model:    "qwen3-coder-plus",
		Region:   "cn-beijing",
		Endpoint: "https://dashscope.aliyuncs.com",
		Mode:     "managed_key",
		Secret:   []byte("token=" + secretMarker),
	}
	for _, formatted := range []string{
		ctxValue.String(),
		fmt.Sprintf("%v", ctxValue),
		fmt.Sprintf("%+v", ctxValue),
		fmt.Sprintf("%s", ctxValue),
		fmt.Sprintf("%#v", ctxValue),
	} {
		if strings.Contains(formatted, secretMarker) {
			t.Fatalf("formatted context leaked the secret: %s", formatted)
		}
		if !strings.Contains(formatted, "<redacted>") {
			t.Fatalf("formatted context did not mark the secret redacted: %s", formatted)
		}
	}

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))
	logger.Info("resolved provider context", "context", ctxValue)
	if strings.Contains(logBuf.String(), secretMarker) {
		t.Fatalf("slog output leaked the secret: %s", logBuf.String())
	}
	if !strings.Contains(logBuf.String(), "<redacted>") {
		t.Fatalf("slog output did not mark the secret redacted: %s", logBuf.String())
	}
}
