package capability_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/capability"
	"github.com/we-meet/work/internal/migrate"
	"github.com/we-meet/work/internal/testpg"
	embedded "github.com/we-meet/work/migrations"
)

// These tests exercise increment 0010 and the capability package against a
// real PostgreSQL instance. Every domain call runs as work_worker with an
// explicit tenant context; the base rows are written with the admin connection
// so the tests observe exactly what the commands enforce.

var (
	testAdmin *pgx.Conn
	testDB    string
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
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_capability_test")
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
	testAdmin, testDB, testPool = dbAdmin, dbName, pool

	code := m.Run()

	pool.Close()
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cleanupCancel()
	_ = dbAdmin.Close(cleanupCtx)
	_ = testpg.DropDatabase(cleanupCtx, admin, dbName)
	_ = admin.Close(cleanupCtx)
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

type fragment struct {
	org        string
	taskID     string
	runID      string
	opID       string
	planExec   string
	planHolder string
	execExec   string
	execHolder string
	headRef    string
	headHash   string
}

func newUUID(t *testing.T) string {
	t.Helper()
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		t.Fatal(err)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

func randomToken(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func hashOf(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func workerConn(t *testing.T, org string) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(testContext(t), testpg.WorkerURL(testDB))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	if org != "" {
		if _, err := conn.Exec(testContext(t), "SELECT set_config('app.org_id', $1, false)", org); err != nil {
			t.Fatal(err)
		}
	}
	return conn
}

func execAdmin(t *testing.T, sql string) {
	t.Helper()
	if _, err := testAdmin.Exec(testContext(t), sql); err != nil {
		t.Fatalf("exec admin: %v", err)
	}
}

// seedFragment builds one Run plus a plan fragment claimed by its holder. The
// plan fragment stays active (and therefore issuable) until activateExecute
// commits the first checkpoint head.
func seedFragment(t *testing.T, org string) *fragment {
	t.Helper()
	ctx := testContext(t)
	fr := &fragment{
		org:        org,
		taskID:     newUUID(t),
		runID:      newUUID(t),
		opID:       newUUID(t),
		planExec:   newUUID(t),
		planHolder: "holder-plan-" + newUUID(t),
		execExec:   newUUID(t),
		execHolder: "holder-exec-" + newUUID(t),
		headRef:    "cp/0/" + org,
		headHash:   "sha256:" + strings.Repeat("1", 64),
	}
	inputID := newUUID(t)
	snapshotID := newUUID(t)
	subject := "sub_" + org
	seed := fmt.Sprintf(`
		SET app.org_id = %[1]s;
		INSERT INTO work.org (id, status, home_region) VALUES (%[1]s, 'active', 'cn-north')
		ON CONFLICT (id) DO NOTHING;
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES (%[1]s, %[2]s, 'active', 'owner', true)
		ON CONFLICT (org_id, subject_id) DO NOTHING;
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%[3]s', %[1]s, %[2]s, 'input/%[3]s', repeat('a', 64), 12);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, input_id, title)
		VALUES ('%[4]s', %[1]s, %[2]s, 'open', '%[3]s', 'capability task');
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		VALUES ('%[5]s', %[1]s, '%[4]s', 'v1', repeat('b', 64),
		        ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		UPDATE work.task SET snapshot_id = '%[5]s' WHERE id = '%[4]s';
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('%[6]s', %[1]s, '%[4]s', 1, 'active', '%[5]s', 'run:%[6]s', 'pi-1');
		UPDATE work.task SET active_run_id = '%[6]s', latest_run_id = '%[6]s' WHERE id = '%[4]s';
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state)
		VALUES ('%[7]s', %[1]s, '%[6]s', 'model:1', 'model', repeat('c', 64), 'authorized');
	`, quote(org), quote(subject), inputID, fr.taskID, snapshotID, fr.runID, fr.opID)
	if _, err := testAdmin.Exec(ctx, seed); err != nil {
		t.Fatalf("seed fragment: %v", err)
	}

	worker := workerConn(t, org)
	var state string
	if err := worker.QueryRow(ctx,
		`SELECT work.register_runtime_execution($1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes')`,
		org, fr.planExec, fr.runID,
	).Scan(&state); err != nil {
		t.Fatalf("register plan: %v", err)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		org, fr.planExec, fr.planHolder,
	).Scan(&state); err != nil {
		t.Fatalf("claim plan: %v", err)
	}
	return fr
}

// activateExecute commits the first checkpoint head through the plan fragment
// (which completes it) and then registers and claims the execute fragment. Only
// after this may the work-egress audience be issued for fr.execExec.
func activateExecute(t *testing.T, fr *fragment) {
	t.Helper()
	ctx := testContext(t)
	worker := workerConn(t, fr.org)
	var revision int64
	if err := worker.QueryRow(ctx,
		`SELECT work.commit_runtime_checkpoint($1, $2, $3, NULL, NULL, NULL, $4, $5, 'pi-1')`,
		fr.org, fr.runID, fr.planExec, fr.headRef, fr.headHash,
	).Scan(&revision); err != nil {
		t.Fatalf("commit head: %v", err)
	}

	var reservation string
	if err := worker.QueryRow(ctx,
		`SELECT work.reserve_quota($1, 'default', to_char(now(), 'YYYY-MM'), $2, 1000)::text`,
		fr.org, fr.opID,
	).Scan(&reservation); err != nil {
		t.Fatalf("reserve quota: %v", err)
	}
	var attempt string
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_dispatch($1, $2, 'consumer-1', 1)::text`,
		fr.opID, fr.org,
	).Scan(&attempt); err != nil {
		t.Fatalf("claim dispatch: %v", err)
	}
	var state string
	if err := worker.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'execute', 1, 'pi-1', now() + interval '10 minutes',
			$4, $5, $6, $7, repeat('c', 64), $8, $9)`,
		fr.org, fr.execExec, fr.runID, fr.headRef, fr.headHash,
		"intent/"+fr.opID, "sha256:"+strings.Repeat("2", 64), fr.opID, attempt,
	).Scan(&state); err != nil {
		t.Fatalf("register execute: %v", err)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		fr.org, fr.execExec, fr.execHolder,
	).Scan(&state); err != nil {
		t.Fatalf("claim execute: %v", err)
	}
}

func quote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func scalarInt(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var value int
	if err := testAdmin.QueryRow(testContext(t), sql, args...).Scan(&value); err != nil {
		t.Fatalf("scalar: %v", err)
	}
	return value
}

func errorCode(t *testing.T, err error) string {
	t.Helper()
	var capabilityErr *capability.Error
	if !errors.As(err, &capabilityErr) {
		t.Fatalf("error = %v, want a capability enumeration error", err)
	}
	return capabilityErr.Code
}

// TestIssueStoresOnlyTheTokenHash proves the plaintext bearer never reaches
// the database: the row holds the SHA-256 digest only, and the digest itself is
// not a usable bearer.
func TestIssueStoresOnlyTheTokenHash(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	fr := seedFragment(t, "org_cap_hash")
	issuer := capability.NewIssuer(testPool)

	token, generation, err := issuer.Issue(ctx, fr.org, fr.planExec, fr.planHolder,
		capability.AudienceContent, 20*time.Second)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if generation != 1 {
		t.Fatalf("generation = %d, want 1", generation)
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 32 {
		t.Fatalf("token is not 32 random bytes in unpadded base64url: %q", token)
	}

	var stored string
	if err := testAdmin.QueryRow(ctx, `
		SELECT token_hash FROM work.runtime_capability
		WHERE org_id = $1 AND execution_id = $2 AND audience = $3 AND generation = $4`,
		fr.org, fr.planExec, capability.AudienceContent, generation,
	).Scan(&stored); err != nil {
		t.Fatalf("read stored capability: %v", err)
	}
	if stored != hashOf(token) {
		t.Fatalf("stored digest = %s, want sha256(token)", stored)
	}
	if stored == token || len(stored) != 64 {
		t.Fatalf("stored value is not a 64-char sha256 digest")
	}
	if got := scalarInt(t, `
		SELECT count(*) FROM work.runtime_capability c
		WHERE to_jsonb(c)::text LIKE '%' || $1 || '%'`, token); got != 0 {
		t.Fatalf("plaintext token appears in %d rows", got)
	}

	// The stored digest is a lookup key, never a second bearer.
	allowed, err := issuer.Authorize(ctx, fr.org, fr.planExec, capability.AudienceContent,
		generation, stored)
	if err != nil {
		t.Fatalf("authorize with digest: %v", err)
	}
	if allowed {
		t.Fatal("the stored digest authorized as a bearer")
	}
	allowed, err = issuer.Authorize(ctx, fr.org, fr.planExec, capability.AudienceContent,
		generation, token)
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if !allowed {
		t.Fatal("fresh capability did not authorize")
	}
}

// TestIssueBumpsGenerationAndSupersedesOld proves a refresh advances the
// generation, keeps the old row for audit, and makes the old generation
// authorize false without a sweeper.
func TestIssueBumpsGenerationAndSupersedesOld(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	fr := seedFragment(t, "org_cap_gen")
	issuer := capability.NewIssuer(testPool)

	token1, gen1, err := issuer.Issue(ctx, fr.org, fr.planExec, fr.planHolder,
		capability.AudienceContent, 20*time.Second)
	if err != nil {
		t.Fatalf("first issue: %v", err)
	}
	token2, gen2, err := issuer.Issue(ctx, fr.org, fr.planExec, fr.planHolder,
		capability.AudienceContent, 20*time.Second)
	if err != nil {
		t.Fatalf("second issue: %v", err)
	}
	if gen2 != gen1+1 {
		t.Fatalf("generations = %d then %d, want a bump", gen1, gen2)
	}
	if got := scalarInt(t, `
		SELECT count(*) FROM work.runtime_capability
		WHERE org_id = $1 AND execution_id = $2 AND audience = $3`,
		fr.org, fr.planExec, capability.AudienceContent); got != 2 {
		t.Fatalf("retained rows = %d, want 2 (old generation kept for audit)", got)
	}
	if got := scalarInt(t, `
		SELECT count(*) FROM work.runtime_capability
		WHERE org_id = $1 AND execution_id = $2 AND revoked_at IS NULL`,
		fr.org, fr.planExec); got != 2 {
		t.Fatalf("unrevoked rows = %d, want 2", got)
	}

	oldAllowed, err := issuer.Authorize(ctx, fr.org, fr.planExec, capability.AudienceContent, gen1, token1)
	if err != nil {
		t.Fatalf("authorize old: %v", err)
	}
	if oldAllowed {
		t.Fatal("superseded generation still authorized")
	}
	newAllowed, err := issuer.Authorize(ctx, fr.org, fr.planExec, capability.AudienceContent, gen2, token2)
	if err != nil {
		t.Fatalf("authorize new: %v", err)
	}
	if !newAllowed {
		t.Fatal("current generation did not authorize")
	}

	// The same digest replayed for the current generation is idempotent.
	replayed, replayedGen, err := issuer.Issue(ctx, fr.org, fr.planExec, fr.planHolder,
		capability.AudienceContent, 20*time.Second)
	if err != nil {
		t.Fatalf("third issue: %v", err)
	}
	if replayed == token2 || replayedGen != gen2+1 {
		t.Fatalf("a new request reused generation %d or digest", replayedGen)
	}
}

// TestAuthorizeRejectsWrongBindings covers wrong audience, generation, digest
// and holder. Each mismatch is a plain false, never a distinct error.
func TestAuthorizeRejectsWrongBindings(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	fr := seedFragment(t, "org_cap_bind")
	issuer := capability.NewIssuer(testPool)

	token, generation, err := issuer.Issue(ctx, fr.org, fr.planExec, fr.planHolder,
		capability.AudienceContent, 20*time.Second)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	check := func(name string, execution, audience string, gen int, presented string) {
		t.Helper()
		allowed, err := issuer.Authorize(ctx, fr.org, execution, audience, gen, presented)
		if err != nil {
			t.Fatalf("%s: unexpected error %v", name, err)
		}
		if allowed {
			t.Fatalf("%s: authorized", name)
		}
	}
	check("wrong audience", fr.planExec, capability.AudienceEgress, generation, token)
	check("wrong generation", fr.planExec, capability.AudienceContent, generation+1, token)
	check("wrong token", fr.planExec, capability.AudienceContent, generation, randomToken(t))
	// Same organization, different Run: a capability never crosses executions.
	other := seedFragment(t, "org_cap_bind_other")
	check("wrong execution", other.planExec, capability.AudienceContent, generation, token)

	// A capability row bound to a different holder than the live fragment must
	// not authorize, even with the right digest and generation.
	rogue := seedFragment(t, "org_cap_holder")
	rogueToken := randomToken(t)
	if _, err := testAdmin.Exec(ctx, `
		INSERT INTO work.runtime_capability
		  (org_id, execution_id, holder_id, audience, generation, token_hash, expires_at)
		VALUES ($1, $2, 'rogue-holder', 'work-content', 1, $3, now() + interval '1 minute')`,
		rogue.org, rogue.planExec, hashOf(rogueToken)); err != nil {
		t.Fatalf("seed rogue holder: %v", err)
	}
	allowed, err := issuer.Authorize(ctx, rogue.org, rogue.planExec,
		capability.AudienceContent, 1, rogueToken)
	if err != nil {
		t.Fatalf("authorize rogue holder: %v", err)
	}
	if allowed {
		t.Fatal("capability with a foreign holder authorized")
	}

	// Issuing the wrong audience for the fragment mode is refused outright.
	_, _, err = issuer.Issue(ctx, fr.org, fr.planExec, fr.planHolder,
		capability.AudienceEgress, 20*time.Second)
	if err == nil || errorCode(t, err) != "runtime_capability_audience_not_allowed" {
		t.Fatalf("plan/work-egress issue error = %v", err)
	}
}

// TestExecuteFragmentOnlyHoldsEgressAudience proves mode narrowing in both
// directions: an execute fragment issues work-egress and refuses work-content.
func TestExecuteFragmentOnlyHoldsEgressAudience(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	fr := seedFragment(t, "org_cap_exec")
	activateExecute(t, fr)
	issuer := capability.NewIssuer(testPool)

	_, _, err := issuer.Issue(ctx, fr.org, fr.execExec, fr.execHolder,
		capability.AudienceContent, 20*time.Second)
	if err == nil || errorCode(t, err) != "runtime_capability_audience_not_allowed" {
		t.Fatalf("execute/work-content issue error = %v", err)
	}
	token, generation, err := issuer.Issue(ctx, fr.org, fr.execExec, fr.execHolder,
		capability.AudienceEgress, 20*time.Second)
	if err != nil {
		t.Fatalf("issue egress: %v", err)
	}
	allowed, err := issuer.Authorize(ctx, fr.org, fr.execExec, capability.AudienceEgress, generation, token)
	if err != nil || !allowed {
		t.Fatalf("egress capability allowed=%t err=%v", allowed, err)
	}
	// Issuing a capability for the execute fragment with the plan holder is
	// refused: the holder must be the live claimer.
	_, _, err = issuer.Issue(ctx, fr.org, fr.execExec, fr.planHolder,
		capability.AudienceEgress, 20*time.Second)
	if err == nil || errorCode(t, err) != "runtime_execution_holder_mismatch" {
		t.Fatalf("foreign holder issue error = %v", err)
	}
}

// TestAuthorizeRejectsExpiredCapability proves expiry is evaluated at call
// time, not cached.
func TestAuthorizeRejectsExpiredCapability(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	fr := seedFragment(t, "org_cap_expiry")
	issuer := capability.NewIssuer(testPool)

	token, generation, err := issuer.Issue(ctx, fr.org, fr.planExec, fr.planHolder,
		capability.AudienceContent, 150*time.Millisecond)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	allowed, err := issuer.Authorize(ctx, fr.org, fr.planExec, capability.AudienceContent, generation, token)
	if err != nil || !allowed {
		t.Fatalf("fresh capability allowed=%t err=%v", allowed, err)
	}
	time.Sleep(500 * time.Millisecond)
	allowed, err = issuer.Authorize(ctx, fr.org, fr.planExec, capability.AudienceContent, generation, token)
	if err != nil {
		t.Fatalf("authorize after expiry: %v", err)
	}
	if allowed {
		t.Fatal("expired capability authorized")
	}
}

// TestRevokeIsIdempotentAndImmediate proves revocation blocks the very next
// authorization, revokes all live generations, and is safe to repeat.
func TestRevokeIsIdempotentAndImmediate(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	fr := seedFragment(t, "org_cap_revoke")
	issuer := capability.NewIssuer(testPool)

	if _, _, err := issuer.Issue(ctx, fr.org, fr.planExec, fr.planHolder,
		capability.AudienceContent, 20*time.Second); err != nil {
		t.Fatalf("issue gen1: %v", err)
	}
	token2, gen2, err := issuer.Issue(ctx, fr.org, fr.planExec, fr.planHolder,
		capability.AudienceContent, 20*time.Second)
	if err != nil {
		t.Fatalf("issue gen2: %v", err)
	}
	revoked, err := issuer.Revoke(ctx, fr.org, fr.planExec, "execution_terminal")
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if revoked != 2 {
		t.Fatalf("revoked = %d, want 2 live generations", revoked)
	}
	allowed, err := issuer.Authorize(ctx, fr.org, fr.planExec, capability.AudienceContent, gen2, token2)
	if err != nil {
		t.Fatalf("authorize after revoke: %v", err)
	}
	if allowed {
		t.Fatal("revoked capability authorized")
	}
	again, err := issuer.Revoke(ctx, fr.org, fr.planExec, "execution_terminal")
	if err != nil {
		t.Fatalf("second revoke: %v", err)
	}
	if again != 0 {
		t.Fatalf("second revoke = %d, want 0", again)
	}
	if got := scalarInt(t, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND action = 'runtime.capability_revoked' AND target_id = $2`,
		fr.org, fr.planExec); got != 2 {
		t.Fatalf("revocation audit rows = %d, want 2 (both calls audited)", got)
	}
	if got := scalarInt(t, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND target_id = $2 AND to_jsonb(metadata)::text LIKE '%' || $3 || '%'`,
		fr.org, fr.planExec, token2); got != 0 {
		t.Fatalf("token leaked into %d audit rows", got)
	}
}

// TestTenantContextRequired proves a missing or foreign organization context is
// rejected, and that a cross-tenant read is a denial rather than a leak.
func TestTenantContextRequired(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	fr := seedFragment(t, "org_cap_tenant_a")
	seedFragment(t, "org_cap_tenant_b")
	issuer := capability.NewIssuer(testPool)

	token, generation, err := issuer.Issue(ctx, fr.org, fr.planExec, fr.planHolder,
		capability.AudienceContent, 20*time.Second)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	// Missing organization context is refused before any work happens.
	if _, _, err := issuer.Issue(ctx, "", fr.planExec, fr.planHolder,
		capability.AudienceContent, 20*time.Second); err == nil {
		t.Fatal("issue without org_id succeeded")
	} else if code := errorCode(t, err); code != "invalid_request" {
		t.Fatalf("issue without org_id code = %q", code)
	}
	if _, err := issuer.Authorize(ctx, "", fr.planExec, capability.AudienceContent, generation, token); err == nil {
		t.Fatal("authorize without org_id succeeded")
	}

	// A foreign tenant context cannot see or issue for another tenant.
	allowed, err := issuer.Authorize(ctx, "org_cap_tenant_b", fr.planExec,
		capability.AudienceContent, generation, token)
	if err != nil {
		t.Fatalf("cross-tenant authorize: %v", err)
	}
	if allowed {
		t.Fatal("cross-tenant authorize allowed")
	}
	_, _, err = issuer.Issue(ctx, "org_cap_tenant_b", fr.planExec, fr.planHolder,
		capability.AudienceContent, 20*time.Second)
	if err == nil || errorCode(t, err) != "runtime_execution_not_found" {
		t.Fatalf("cross-tenant issue error = %v", err)
	}

	// The command itself rejects a mismatched declared org, even when the
	// session context is valid for a different tenant.
	conn := workerConn(t, "org_cap_tenant_b")
	var mismatchAllowed bool
	err = conn.QueryRow(ctx, `
		SELECT work.authorize_runtime_capability($1, $2, $3, $4, $5)`,
		fr.org, fr.planExec, capability.AudienceContent, generation, hashOf(token),
	).Scan(&mismatchAllowed)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Message != "runtime_org_context_mismatch" {
		t.Fatalf("declared-org mismatch error = %v", err)
	}
}

// TestWorkAPICannotExecute proves the runtime and application roles hold no
// EXECUTE on the capability commands and no DML on the credential table.
func TestWorkAPICannotExecute(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	fr := seedFragment(t, "org_cap_roles")

	for _, role := range []string{"work_api", "work_directory"} {
		for _, signature := range []string{
			"work.issue_runtime_capability(text, uuid, text, text, text, timestamptz)",
			"work.authorize_runtime_capability(text, uuid, text, int, text)",
			"work.revoke_runtime_capability(text, uuid, text)",
		} {
			var has bool
			if err := testAdmin.QueryRow(ctx,
				`SELECT has_function_privilege($1, $2, 'EXECUTE')`, role, signature,
			).Scan(&has); err != nil {
				t.Fatalf("privilege probe %s %s: %v", role, signature, err)
			}
			if has {
				t.Fatalf("%s has EXECUTE on %s", role, signature)
			}
		}
	}
	var workerHas bool
	if err := testAdmin.QueryRow(ctx,
		`SELECT has_function_privilege('work_worker', 'work.authorize_runtime_capability(text, uuid, text, int, text)', 'EXECUTE')`,
	).Scan(&workerHas); err != nil {
		t.Fatal(err)
	}
	if !workerHas {
		t.Fatal("work_worker lost EXECUTE on authorize_runtime_capability")
	}

	// No table-level DML: even SELECT is refused for the worker role.
	worker := workerConn(t, fr.org)
	var count int
	err := worker.QueryRow(ctx, `SELECT count(*) FROM work.runtime_capability`).Scan(&count)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("worker table select error = %v", err)
	}

	// And the application login is refused by the function itself.
	app, err := pgx.Connect(ctx, testpg.AppURL(testDB))
	if err != nil {
		t.Fatalf("connect application role: %v", err)
	}
	defer app.Close(context.Background())
	if _, err := app.Exec(ctx, "SELECT set_config('app.org_id', $1, false)", fr.org); err != nil {
		t.Fatal(err)
	}
	var allowed bool
	err = app.QueryRow(ctx, `SELECT work.authorize_runtime_capability($1, $2, 'work-content', 1, $3)`,
		fr.org, fr.planExec, strings.Repeat("a", 64)).Scan(&allowed)
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("application role authorize error = %v", err)
	}
}

// TestIssueReplayWithSameDigestIsIdempotent proves the command-level retry
// contract: the same digest for the current generation returns that
// generation, while a revoked generation is never revived by a replay.
func TestIssueReplayWithSameDigestIsIdempotent(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	fr := seedFragment(t, "org_cap_replay")
	issuer := capability.NewIssuer(testPool)
	worker := workerConn(t, fr.org)

	digest := hashOf(randomToken(t))
	var first, second int
	if err := worker.QueryRow(ctx, `
		SELECT work.issue_runtime_capability($1, $2, $3, $4, $5, now() + interval '20 seconds')`,
		fr.org, fr.planExec, fr.planHolder, capability.AudienceContent, digest,
	).Scan(&first); err != nil {
		t.Fatalf("first issue: %v", err)
	}
	if err := worker.QueryRow(ctx, `
		SELECT work.issue_runtime_capability($1, $2, $3, $4, $5, now() + interval '20 seconds')`,
		fr.org, fr.planExec, fr.planHolder, capability.AudienceContent, digest,
	).Scan(&second); err != nil {
		t.Fatalf("replay: %v", err)
	}
	if first != 1 || second != 1 {
		t.Fatalf("generations = %d/%d, want an idempotent 1/1", first, second)
	}
	if got := scalarInt(t, `
		SELECT count(*) FROM work.runtime_capability
		WHERE org_id = $1 AND execution_id = $2`, fr.org, fr.planExec); got != 1 {
		t.Fatalf("rows after replay = %d, want 1", got)
	}

	if _, err := issuer.Revoke(ctx, fr.org, fr.planExec, "session_ended"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	var generation int
	err := worker.QueryRow(ctx, `
		SELECT work.issue_runtime_capability($1, $2, $3, $4, $5, now() + interval '20 seconds')`,
		fr.org, fr.planExec, fr.planHolder, capability.AudienceContent, digest,
	).Scan(&generation)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Message != "runtime_capability_conflict" {
		t.Fatalf("revoked replay error = %v", err)
	}
}

func readEmbedded(path string) ([]byte, error) {
	return fs.ReadFile(embedded.FS, path)
}

func ledgerVersions(t *testing.T, dbName string) []int64 {
	t.Helper()
	conn, err := pgx.Connect(testContext(t), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(testContext(t), `SELECT version FROM work.schema_migration ORDER BY version`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var version int64
		if err := rows.Scan(&version); err != nil {
			t.Fatal(err)
		}
		out = append(out, version)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestManifestPinsLatestAndApplyIsIdempotent proves the published manifest
// pins the exact 0013 bytes and catalog, and that a fresh database applies the
// whole ledger through version 13 exactly once.
func TestManifestPinsLatestAndApplyIsIdempotent(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	manifest, err := migrate.LoadManifest(embedded.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	last := manifest.Increments[len(manifest.Increments)-1]
	if last.Version != 14 || last.Name != "0014_advance_binding_reads" {
		t.Fatalf("last increment = %d/%s", last.Version, last.Name)
	}
	body, err := readEmbedded(last.File)
	if err != nil {
		t.Fatal(err)
	}
	if sum := "sha256:" + fmt.Sprintf("%x", sha256.Sum256(body)); sum != last.Checksum {
		t.Fatalf("latest checksum = %s, manifest pins %s", sum, last.Checksum)
	}
	catalogBody, err := readEmbedded(last.Catalog)
	if err != nil {
		t.Fatal(err)
	}
	if sum := "sha256:" + fmt.Sprintf("%x", sha256.Sum256(catalogBody)); sum != last.CatalogChecksum {
		t.Fatalf("latest catalog checksum = %s, manifest pins %s", sum, last.CatalogChecksum)
	}

	name := fmt.Sprintf("work_cap_migrate_%d", time.Now().UnixNano())
	if _, err := testAdmin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" OWNER work_owner"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = testpg.DropDatabase(cleanupCtx, testAdmin, name)
	})
	runner, err := migrate.New(migrate.Config{
		DatabaseURL:            testpg.MigratorURL(name),
		Migrations:             embedded.FS,
		Root:                   ".",
		LegacyMigratorDisabled: true,
		LockTimeout:            10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := runner.Apply(ctx)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if result.State != "applied" {
		t.Fatalf("apply state = %q", result.State)
	}
	versions := ledgerVersions(t, name)
	want := []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14}
	if len(versions) != len(want) {
		t.Fatalf("ledger versions = %v", versions)
	}
	for index := range want {
		if versions[index] != want[index] {
			t.Fatalf("ledger versions = %v", versions)
		}
	}
	again, err := runner.Apply(ctx)
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if again.State != "up_to_date" {
		t.Fatalf("second apply state = %q", again.State)
	}
}
