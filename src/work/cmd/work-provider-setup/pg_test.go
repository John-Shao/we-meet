package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/credentials"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/providerctx"
	"github.com/we-meet/work/internal/testpg"
)

var (
	pgAdmin      *pgx.Conn
	pgAppPool    *pgxpool.Pool
	pgWorkerPool *pgxpool.Pool
	pgDBName     string
	pgMaster     = bytes.Repeat([]byte{0x73}, 32)
)

func TestMain(m *testing.M) {
	if os.Getenv("WORK_TEST_PG_URL") == "" {
		os.Exit(m.Run())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	admin, err := pgx.Connect(ctx, testpg.AdminURL())
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect test PostgreSQL failed")
		os.Exit(1)
	}
	if err := testpg.EnsureFixtures(ctx, admin); err != nil {
		fmt.Fprintln(os.Stderr, "prepare test fixtures failed")
		_ = admin.Close(ctx)
		os.Exit(1)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_provider_setup_test")
	if err != nil {
		fmt.Fprintln(os.Stderr, "create baseline database failed")
		_ = admin.Close(ctx)
		os.Exit(1)
	}
	dbAdmin, err := pgx.Connect(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect baseline database failed")
		_ = testpg.DropDatabase(ctx, admin, dbName)
		_ = admin.Close(ctx)
		os.Exit(1)
	}
	appPool, err := pgxpool.New(ctx, testpg.AppURL(dbName))
	if err != nil {
		fmt.Fprintln(os.Stderr, "open work_api pool failed")
		_ = dbAdmin.Close(ctx)
		_ = testpg.DropDatabase(ctx, admin, dbName)
		_ = admin.Close(ctx)
		os.Exit(1)
	}
	workerPool, err := pgxpool.New(ctx, testpg.WorkerURL(dbName))
	if err != nil {
		fmt.Fprintln(os.Stderr, "open work_worker pool failed")
		appPool.Close()
		_ = dbAdmin.Close(ctx)
		_ = testpg.DropDatabase(ctx, admin, dbName)
		_ = admin.Close(ctx)
		os.Exit(1)
	}

	pgAdmin, pgAppPool, pgWorkerPool, pgDBName = dbAdmin, appPool, workerPool, dbName

	code := m.Run()

	workerPool.Close()
	appPool.Close()
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	_ = dbAdmin.Close(cleanupCtx)
	_ = testpg.DropDatabase(cleanupCtx, admin, dbName)
	_ = admin.Close(cleanupCtx)
	cleanupCancel()
	os.Exit(code)
}

func requirePG(t *testing.T) {
	t.Helper()
	if pgAdmin == nil || pgAppPool == nil || pgWorkerPool == nil {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
}

func pgContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func randomID(prefix string) string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return prefix + "_" + hex.EncodeToString(buf[:])
}

func seedOwner(t *testing.T, org, subject string) {
	t.Helper()
	ctx := pgContext(t)
	if _, err := pgAdmin.Exec(ctx,
		`INSERT INTO work.org (id, status, home_region) VALUES ($1, 'active', 'cn-north')`,
		org,
	); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	if _, err := pgAdmin.Exec(ctx,
		`INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		 VALUES ($1, $2, 'active', 'owner', true)`,
		org, subject,
	); err != nil {
		t.Fatalf("seed owner: %v", err)
	}
}

func pgApp(t *testing.T, databaseURL string, stdout, stderr *bytes.Buffer) *app {
	t.Helper()
	return &app{
		stdout:   stdout,
		stderr:   stderr,
		readFile: os.ReadFile,
		getenv: func(name string) string {
			switch name {
			case "WORK_DATABASE_URL":
				return databaseURL
			case "WORK_CONTENT_MASTER_KEY":
				return hex.EncodeToString(pgMaster)
			default:
				return ""
			}
		},
		newBackend: newPGScopedBackend,
	}
}

func TestPGProviderSetupRoundTrip(t *testing.T) {
	requirePG(t)
	ctx := pgContext(t)

	org := randomID("org_provider_setup")
	actor := randomID("subject_provider_setup")
	seedOwner(t, org, actor)

	marker := "MARKER-work-provider-setup-pg-4e21-never-echo"
	plaintext := []byte("sk-pilot-" + marker)
	secretPath := filepath.Join(t.TempDir(), "provider.key")
	if err := os.WriteFile(secretPath, append(append([]byte{}, plaintext...), '\n'), 0o600); err != nil {
		t.Fatalf("write secret file: %v", err)
	}

	var stdout, stderr bytes.Buffer
	writer := pgApp(t, testpg.AppURL(pgDBName), &stdout, &stderr)

	credArgs := []string{
		"credential",
		"-org", org,
		"-provider", "aliyun",
		"-actor", actor,
		"-secret-file", secretPath,
	}
	// A dry run must not create the credential; the real create below would
	// fail with provider_credential_exists if it had written.
	stdout.Reset()
	stderr.Reset()
	if err := writer.execute(ctx, append(append([]string{}, credArgs...), "-dry-run")); err != nil {
		t.Fatalf("credential dry run: %v", err)
	}
	if !strings.Contains(stdout.String(), "dry_run=true") {
		t.Fatalf("credential dry run output = %q", stdout.String())
	}
	assertNoMarker(t, marker, stdout.String(), stderr.String())

	stdout.Reset()
	stderr.Reset()
	if err := writer.execute(ctx, credArgs); err != nil {
		t.Fatalf("create credential: %v", err)
	}
	assertNoMarker(t, marker, stdout.String(), stderr.String())
	created := parseFields(t, stdout.String())
	credentialID := created["credential_id"]
	if credentialID == "" {
		t.Fatalf("credential output has no credential_id: %q", stdout.String())
	}
	if got, want := created["fingerprint"], credentials.Fingerprint(plaintext); got != want {
		t.Fatalf("fingerprint = %q, want %q", got, want)
	}

	// Before config, resolution must fail as not configured.
	resolver := &providerctx.Resolver{Pool: pgWorkerPool, Master: pgMaster}
	if _, err := resolver.Resolve(ctx, org); !errors.Is(err, &providerctx.Error{Code: providerctx.CodeProviderNotConfigured}) {
		t.Fatalf("resolve before config error = %v, want provider_not_configured", err)
	}

	cfgArgs := []string{
		"config",
		"-org", org,
		"-credential-id", credentialID,
		"-provider", "aliyun",
		"-model", "qwen3-coder-plus",
		"-region", "cn-beijing",
		"-endpoint", "https://dashscope.aliyuncs.com",
		"-actor", actor,
	}
	stdout.Reset()
	stderr.Reset()
	if err := writer.execute(ctx, append(append([]string{}, cfgArgs...), "-dry-run")); err != nil {
		t.Fatalf("config dry run: %v", err)
	}
	if !strings.Contains(stdout.String(), "credential_mode=managed_key") {
		t.Fatalf("config dry run output = %q", stdout.String())
	}
	// The read-only dry run must not have created the active configuration.
	if _, err := resolver.Resolve(ctx, org); !errors.Is(err, &providerctx.Error{Code: providerctx.CodeProviderNotConfigured}) {
		t.Fatalf("resolve after config dry run error = %v, want provider_not_configured", err)
	}

	stdout.Reset()
	stderr.Reset()
	if err := writer.execute(ctx, cfgArgs); err != nil {
		t.Fatalf("set config: %v", err)
	}
	assertNoMarker(t, marker, stdout.String(), stderr.String())
	if parseFields(t, stdout.String())["config_id"] == "" {
		t.Fatalf("config output has no config_id: %q", stdout.String())
	}

	resolved, err := resolver.Resolve(ctx, org)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !bytes.Equal(resolved.Secret, plaintext) {
		t.Fatalf("resolved secret does not round-trip (got %d bytes, want %d)", len(resolved.Secret), len(plaintext))
	}
	if resolved.Provider != "aliyun" || resolved.Model != "qwen3-coder-plus" ||
		resolved.Region != "cn-beijing" || resolved.Endpoint != "https://dashscope.aliyuncs.com" ||
		resolved.Mode != "managed_key" {
		t.Fatalf("resolved metadata = %+v", resolved)
	}

	var statusOut, statusErr bytes.Buffer
	statusApp := pgApp(t, testpg.WorkerURL(pgDBName), &statusOut, &statusErr)
	if err := statusApp.execute(ctx, []string{"status", "-org", org}); err != nil {
		t.Fatalf("status: %v", err)
	}
	status := parseFields(t, statusOut.String())
	for key, want := range map[string]string{
		"provider":        "aliyun",
		"model":           "qwen3-coder-plus",
		"mode":            "managed_key",
		"endpoint":        "https://dashscope.aliyuncs.com",
		"secret_decrypts": "true",
	} {
		if status[key] != want {
			t.Fatalf("status %s = %q, want %q (output %q)", key, status[key], want, statusOut.String())
		}
	}
	assertNoMarker(t, marker, statusOut.String(), statusErr.String())
}

func TestPGWrongOrgCiphertextFailsToResolve(t *testing.T) {
	requirePG(t)
	ctx := pgContext(t)

	org := randomID("org_provider_setup_wrong")
	otherOrg := randomID("org_provider_setup_other")
	actor := randomID("subject_provider_setup_wrong")
	seedOwner(t, org, actor)

	marker := "MARKER-work-provider-wrong-org-91ab-never-echo"
	plaintext := []byte("sk-wrong-" + marker)
	ciphertext, fingerprint, err := credentials.Seal(pgMaster, otherOrg, plaintext)
	if err != nil {
		t.Fatalf("seal for other org: %v", err)
	}

	// Use the same API-role adapter and work.create_provider_credential call as
	// the CLI, but persist ciphertext bound to another organization.
	pg := &pgBackend{pool: pgAppPool, master: pgMaster}
	created, err := pg.CreateCredential(ctx, workdb.Identity{OrgID: org, SubjectID: actor}, credentialPlan{
		Provider:    "aliyun",
		Mode:        "managed_key",
		KeyVersion:  1,
		Ciphertext:  ciphertext,
		Fingerprint: fingerprint,
	})
	if err != nil {
		t.Fatalf("create wrong-org credential: %v", err)
	}

	var stdout, stderr bytes.Buffer
	writer := pgApp(t, testpg.AppURL(pgDBName), &stdout, &stderr)
	if err := writer.execute(ctx, []string{
		"config",
		"-org", org,
		"-credential-id", created.CredentialID,
		"-provider", "aliyun",
		"-model", "qwen3-coder-plus",
		"-region", "cn-beijing",
		"-endpoint", "https://dashscope.aliyuncs.com",
		"-actor", actor,
	}); err != nil {
		t.Fatalf("set config: %v", err)
	}

	resolver := &providerctx.Resolver{Pool: pgWorkerPool, Master: pgMaster}
	resolved, err := resolver.Resolve(ctx, org)
	if err == nil {
		t.Fatal("wrong-org ciphertext resolved successfully")
	}
	if !errors.Is(err, &providerctx.Error{Code: providerctx.CodeProviderContextUnavailable}) {
		t.Fatalf("resolve error = %v, want provider_context_unavailable", err)
	}
	if len(resolved.Secret) != 0 {
		t.Fatalf("wrong-org resolve returned a %d-byte secret", len(resolved.Secret))
	}
	assertNoMarker(t, marker, err.Error(), stdout.String(), stderr.String())
}

func assertNoMarker(t *testing.T, marker string, values ...string) {
	t.Helper()
	for _, value := range values {
		if strings.Contains(value, marker) {
			t.Fatalf("secret marker leaked into output")
		}
	}
}
