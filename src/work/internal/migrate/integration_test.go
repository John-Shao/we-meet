package migrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	embedded "github.com/we-meet/work/migrations"
)

var testAdminURL string
var testAdmin *pgx.Conn

func TestMain(m *testing.M) {
	testAdminURL = os.Getenv("WORK_TEST_PG_URL")
	if testAdminURL != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		conn, err := pgx.Connect(ctx, testAdminURL)
		cancel()
		if err != nil {
			fmt.Fprintf(os.Stderr, "connect test PostgreSQL: %v\n", err)
			os.Exit(1)
		}
		testAdmin = conn
		if err := ensureTestFixtures(context.Background()); err != nil {
			fmt.Fprintf(os.Stderr, "prepare test fixtures: %v\n", err)
			os.Exit(1)
		}
	}
	code := m.Run()
	if testAdmin != nil {
		_ = testAdmin.Close(context.Background())
	}
	os.Exit(code)
}

func ensureTestFixtures(ctx context.Context) error {
	rolesSQL, err := fs.ReadFile(embedded.FS, "baseline/0001_roles_precondition.sql")
	if err != nil {
		return err
	}
	if err := execRaw(ctx, testAdmin, string(rolesSQL)); err != nil {
		return err
	}
	if err := ensureLogin(ctx, "work_migrator_login", "work_owner"); err != nil {
		return err
	}
	if err := ensureLogin(ctx, "work_app_test_login", "work_api"); err != nil {
		return err
	}
	return nil
}

func ensureLogin(ctx context.Context, name, member string) error {
	var exists bool
	if err := testAdmin.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`, name).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		_, err := testAdmin.Exec(ctx, fmt.Sprintf(
			`CREATE ROLE %s LOGIN PASSWORD 'work' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT`,
			pgx.Identifier{name}.Sanitize(),
		))
		if err != nil {
			return err
		}
	} else {
		_, err := testAdmin.Exec(ctx, fmt.Sprintf(
			`ALTER ROLE %s LOGIN PASSWORD 'work' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT`,
			pgx.Identifier{name}.Sanitize(),
		))
		if err != nil {
			return err
		}
	}
	_, err := testAdmin.Exec(ctx, fmt.Sprintf(
		`GRANT %s TO %s`,
		pgx.Identifier{member}.Sanitize(),
		pgx.Identifier{name}.Sanitize(),
	))
	return err
}

func TestReadCatalogDetectsColumnGrants(t *testing.T) {
	dbName, migratorURL := newTestDB(t)
	runner := newRunner(t, migratorURL, true)
	if _, err := runner.Apply(testContext(t)); err != nil {
		t.Fatal(err)
	}
	conn := connect(t, adminURL(dbName))
	defer conn.Close(context.Background())
	if _, err := conn.Exec(testContext(t), `GRANT UPDATE(state) ON work.run TO work_worker`); err != nil {
		t.Fatal(err)
	}
	catalog, err := ReadCatalog(testContext(t), conn)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, grant := range catalog.Grants {
		if grant.ObjectType == "column" && grant.Object == "run.state" &&
			grant.Grantee == "work_worker" && grant.Privilege == "UPDATE" {
			found = true
		}
	}
	if !found {
		t.Fatal("column-level grant was not present in the catalog")
	}
	before := ledgerVersions(t, dbName)
	_, err = runner.Apply(testContext(t))
	assertCode(t, err, "drift")
	if after := ledgerVersions(t, dbName); !equalInt64(before, after) {
		t.Fatalf("drift changed ledger: before=%v after=%v", before, after)
	}
}

func TestApplyEmptyDatabase(t *testing.T) {
	dbName, migratorURL := newTestDB(t)
	runner := newRunner(t, migratorURL, true)

	result, err := runner.Apply(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "applied" {
		t.Fatalf("state = %q", result.State)
	}
	if got := ledgerVersions(t, dbName); !equalInt64(got, []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}) {
		t.Fatalf("ledger versions = %v", got)
	}

	again, err := runner.Apply(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	if again.State != "up_to_date" {
		t.Fatalf("second apply state = %q", again.State)
	}
	if got := ledgerVersions(t, dbName); !equalInt64(got, []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}) {
		t.Fatalf("ledger versions after repeat = %v", got)
	}
}

func TestAdoptExistingDatabase(t *testing.T) {
	dbName, migratorURL := newTestDB(t)
	applyBaselineAsAdmin(t, dbName)
	createLegacyLedger(t, dbName)
	seedRepresentativeData(t, dbName)

	runner := newRunner(t, migratorURL, true)
	status, err := runner.Status(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	if status.State != "existing_unmanaged" {
		t.Fatalf("status = %q", status.State)
	}

	result, err := runner.Apply(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "applied" {
		t.Fatalf("state = %q", result.State)
	}
	if got := ledgerVersions(t, dbName); !equalInt64(got, []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}) {
		t.Fatalf("ledger versions = %v", got)
	}
	if got := scalarInt(t, dbName, `SELECT count(*) FROM work.schema_migration WHERE adopted`); got != 2 {
		t.Fatalf("adopted rows = %d", got)
	}
	if got := scalarInt(t, dbName, `SELECT count(*) FROM public.django_migrations WHERE app = 'work'`); got != 2 {
		t.Fatalf("legacy rows = %d", got)
	}
	assertRepresentativeData(t, dbName)
}

func seedRepresentativeData(t *testing.T, dbName string) {
	t.Helper()
	execAdmin(t, dbName, `
		INSERT INTO work.org (id, status, home_region) VALUES ('org_adopt', 'active', 'cn-north');
		SET app.org_id = 'org_adopt';
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('22222222-2222-2222-2222-222222222222', 'org_adopt', 'user_adopt', 'input/ref', repeat('a', 64), 12);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, input_id, title)
		VALUES ('11111111-1111-1111-1111-111111111111', 'org_adopt', 'user_adopt', 'open',
		        '22222222-2222-2222-2222-222222222222', 'adoption task');
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		VALUES ('33333333-3333-3333-3333-333333333333', 'org_adopt',
		        '11111111-1111-1111-1111-111111111111', 'test', repeat('b', 64),
		        ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		UPDATE work.task SET snapshot_id = '33333333-3333-3333-3333-333333333333'
		WHERE id = '11111111-1111-1111-1111-111111111111';
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('44444444-4444-4444-4444-444444444444', 'org_adopt',
		        '11111111-1111-1111-1111-111111111111', 1, 'active',
		        '33333333-3333-3333-3333-333333333333', 'run:adoption', 'test-runtime');
		UPDATE work.task
		SET active_run_id = '44444444-4444-4444-4444-444444444444',
		    latest_run_id = '44444444-4444-4444-4444-444444444444'
		WHERE id = '11111111-1111-1111-1111-111111111111';
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, kind, request_hash, state)
		VALUES ('55555555-5555-5555-5555-555555555555', 'org_adopt',
		        '44444444-4444-4444-4444-444444444444', 'op-1', 'model', repeat('c', 64), 'succeeded');
		INSERT INTO work.usage_daily
		  (org_id, subject_id, provider, model, usage_date, input_tokens, output_tokens, cached_input_tokens, run_count)
		VALUES ('org_adopt', 'user_adopt', 'aliyun', 'qwen3.8-flash', current_date, 100, 50, 0, 1);
		INSERT INTO work.quota_account
		  (org_id, account_key, period_id, limit_tokens, enforcement)
		VALUES ('org_adopt', 'run_cap', 'default', 100000, 'soft');
	`)
}

func assertRepresentativeData(t *testing.T, dbName string) {
	t.Helper()
	for _, query := range []string{
		`SELECT count(*) FROM work.org WHERE id = 'org_adopt'`,
		`SELECT count(*) FROM work.task WHERE id = '11111111-1111-1111-1111-111111111111'`,
		`SELECT count(*) FROM work.run WHERE id = '44444444-4444-4444-4444-444444444444'`,
		`SELECT count(*) FROM work.operation WHERE id = '55555555-5555-5555-5555-555555555555'`,
		`SELECT count(*) FROM work.usage_daily WHERE org_id = 'org_adopt'`,
		`SELECT count(*) FROM work.quota_account WHERE org_id = 'org_adopt' AND account_key = 'run_cap' AND period_id = 'default'`,
	} {
		if got := scalarInt(t, dbName, query); got != 1 {
			t.Fatalf("query %q = %d, want 1", query, got)
		}
	}
	if got := scalarInt(t, dbName, `
		SELECT count(*) FROM work.task
		WHERE id = '11111111-1111-1111-1111-111111111111'
		  AND state = 'open'
		  AND active_run_id = '44444444-4444-4444-4444-444444444444'`); got != 1 {
		t.Fatal("adoption changed the active task/run mapping")
	}
}

func TestDriftRejectedWithoutStamp(t *testing.T) {
	dbName, migratorURL := newTestDB(t)
	applyBaselineAsAdmin(t, dbName)
	createLegacyLedger(t, dbName)
	execAdmin(t, dbName, `ALTER TABLE work.task ADD COLUMN drift_marker text`)
	execAdmin(t, dbName, `REVOKE EXECUTE ON FUNCTION work.acquire_run(uuid, text) FROM work_worker`)

	runner := newRunner(t, migratorURL, true)
	_, err := runner.Apply(testContext(t))
	assertCode(t, err, "drift")
	var migrationError *Error
	if !errors.As(err, &migrationError) || migrationError.Diff == nil {
		t.Fatalf("drift error has no diff: %#v", err)
	}
	if got := relationExists(t, dbName, "work.schema_migration"); got {
		t.Fatal("drift created a ledger row")
	}
}

func TestDualWriterRejected(t *testing.T) {
	dbName, migratorURL := newTestDB(t)
	applyBaselineAsAdmin(t, dbName)
	createLegacyLedger(t, dbName)

	runner := newRunner(t, migratorURL, false)
	_, err := runner.Apply(testContext(t))
	assertCode(t, err, "dual_writer_forbidden")
	if got := relationExists(t, dbName, "work.schema_migration"); got {
		t.Fatal("dual writer check wrote a ledger")
	}
}

func TestLegacyLedgerMissing(t *testing.T) {
	dbName, migratorURL := newTestDB(t)
	applyBaselineAsAdmin(t, dbName)

	runner := newRunner(t, migratorURL, true)
	_, err := runner.Apply(testContext(t))
	assertCode(t, err, "legacy_ledger_missing")
	if got := relationExists(t, dbName, "work.schema_migration"); got {
		t.Fatal("unmanaged database was stamped")
	}
}

func TestLegacyLedgerIncomplete(t *testing.T) {
	dbName, migratorURL := newTestDB(t)
	applyBaselineAsAdmin(t, dbName)
	createLegacyLedgerRows(t, dbName, "0001_create_work_roles")

	runner := newRunner(t, migratorURL, true)
	_, err := runner.Apply(testContext(t))
	assertCode(t, err, "legacy_ledger_missing")
	if got := relationExists(t, dbName, "work.schema_migration"); got {
		t.Fatal("incomplete legacy ledger was stamped")
	}
}

func TestLegacyLedgerWithoutObjects(t *testing.T) {
	dbName, migratorURL := newTestDB(t)
	createLegacyLedgerRows(t, dbName,
		"0001_create_work_roles", "0002_initial_r0a_schema")

	runner := newRunner(t, migratorURL, true)
	_, err := runner.Apply(testContext(t))
	assertCode(t, err, "legacy_ledger_without_objects")
	if got := relationExists(t, dbName, "work.schema_migration"); got {
		t.Fatal("empty schema was initialized over legacy Work records")
	}
}

func TestConcurrentRunnersSerialize(t *testing.T) {
	dbName, migratorURL := newTestDB(t)
	runners := []*Runner{
		newRunner(t, migratorURL, true),
		newRunner(t, migratorURL, true),
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]*Result, 2)
	errs := make([]error, 2)
	ctx := testContext(t)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			results[index], errs[index] = runners[index].Apply(ctx)
		}(i)
	}
	close(start)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("runner %d: %v", i, err)
		}
	}
	if got := ledgerVersions(t, dbName); !equalInt64(got, []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}) {
		t.Fatalf("ledger versions = %v", got)
	}
	initialized := 0
	for _, result := range results {
		if result.State == "applied" {
			initialized++
		}
	}
	if initialized != 1 {
		t.Fatalf("initialized runners = %d, results = %#v", initialized, results)
	}
}

func TestApplyIncrementAndRepeat(t *testing.T) {
	dir := copyEmbeddedMigrations(t)
	appendIncrement(t, dir, Migration{
		Version: 16, Name: "0016_noop", Kind: "increment", File: "increments/0016_noop.sql",
		Transactional: true, Executable: true,
	}, "SELECT 1;", true)
	dbName, migratorURL := newTestDB(t)
	runner, err := New(Config{
		DatabaseURL: migratorURL, Migrations: os.DirFS(dir), Root: ".",
		LegacyMigratorDisabled: true, LockTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := runner.Apply(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "applied" {
		t.Fatalf("state = %q", result.State)
	}
	if got := ledgerVersions(t, dbName); !equalInt64(got, []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}) {
		t.Fatalf("ledger versions = %v", got)
	}
	again, err := runner.Apply(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	if again.State != "up_to_date" {
		t.Fatalf("repeat state = %q", again.State)
	}
}

func TestNonTransactionalIncrementRejected(t *testing.T) {
	dir := copyEmbeddedMigrations(t)
	appendIncrement(t, dir, Migration{
		Version: 16, Name: "0016_non_tx", Kind: "increment", File: "increments/0016_non_tx.sql",
		Transactional: false, Executable: true, NamedRecoveryProtocol: "test-noop",
	}, "SELECT 1;", true)
	dbName, migratorURL := newTestDB(t)
	runner, err := New(Config{
		DatabaseURL: migratorURL, Migrations: os.DirFS(dir), Root: ".",
		LegacyMigratorDisabled: true, LockTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = runner.Apply(testContext(t))
	assertCode(t, err, "non_transactional_protocol_unimplemented")
	if got := ledgerVersions(t, dbName); !equalInt64(got, []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}) {
		t.Fatalf("ledger versions = %v", got)
	}
}

func TestFailedIncrementRollsBack(t *testing.T) {
	dir := copyEmbeddedMigrations(t)
	appendIncrement(t, dir, Migration{
		Version: 16, Name: "0016_fails", Kind: "increment", File: "increments/0016_fails.sql",
		Transactional: true, Executable: true,
	}, "CREATE TABLE work.should_not_exist (id int); SELECT 1/0;", true)
	dbName, migratorURL := newTestDB(t)
	runner, err := New(Config{
		DatabaseURL: migratorURL, Migrations: os.DirFS(dir), Root: ".",
		LegacyMigratorDisabled: true, LockTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = runner.Apply(testContext(t))
	assertCode(t, err, "increment_apply_failed")
	if got := ledgerVersions(t, dbName); !equalInt64(got, []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}) {
		t.Fatalf("ledger versions = %v", got)
	}
	if got := relationExists(t, dbName, "work.should_not_exist"); got {
		t.Fatal("failed increment left a table behind")
	}
}

func TestInterruptedIncrementRollsBack(t *testing.T) {
	dir := copyEmbeddedMigrations(t)
	appendIncrement(t, dir, Migration{
		Version: 16, Name: "0016_interrupted", Kind: "increment", File: "increments/0016_interrupted.sql",
		Transactional: true, Executable: true,
	}, "CREATE TABLE work.interrupted_marker (id int); SELECT pg_sleep(30);", true)
	dbName, migratorURL := newTestDB(t)
	runner, err := New(Config{
		DatabaseURL: migratorURL, Migrations: os.DirFS(dir), Root: ".",
		LegacyMigratorDisabled: true, LockTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		_, err := runner.Apply(ctx)
		errCh <- err
	}()

	pid := waitForMigrationQuery(t, dbName, "pg_sleep")
	conn := connect(t, adminURL(dbName))
	defer conn.Close(testContext(t))
	if _, err := conn.Exec(testContext(t), `SELECT pg_terminate_backend($1)`, pid); err != nil {
		t.Fatal(err)
	}
	err = <-errCh
	if err == nil {
		t.Fatal("interrupted increment returned success")
	}
	assertCode(t, err, "increment_apply_failed")
	if got := ledgerVersions(t, dbName); !equalInt64(got, []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}) {
		t.Fatalf("ledger versions = %v", got)
	}
	if got := relationExists(t, dbName, "work.interrupted_marker"); got {
		t.Fatal("interrupted increment left a table behind")
	}
}

func TestApplicationRoleCannotMigrate(t *testing.T) {
	dbName, _ := newTestDB(t)
	config, err := pgx.ParseConfig(appURL(dbName))
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["options"] = "-c role=work_api"
	conn, err := pgx.ConnectConfig(testContext(t), config)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(testContext(t))
	_, err = Preflight(testContext(t), conn)
	assertCode(t, err, "application_role_cannot_migrate")
}

func waitForMigrationQuery(t *testing.T, dbName, marker string) int32 {
	t.Helper()
	conn := connect(t, adminURL(dbName))
	defer conn.Close(testContext(t))
	ctx := testContext(t)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var pid int32
		err := conn.QueryRow(ctx, `
			SELECT pid
			FROM pg_stat_activity
			WHERE datname = current_database()
			  AND application_name = 'work-migrate'
			  AND state = 'active'
			  AND query LIKE '%' || $1 || '%'
			LIMIT 1`, marker).Scan(&pid)
		if err == nil {
			return pid
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("query migration backend: %v", err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("migration backend did not reach %q", marker)
	return 0
}

func newTestDB(t *testing.T) (string, string) {
	t.Helper()
	if testAdmin == nil {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	name := fmt.Sprintf("work_phase1_test_%d_%d", os.Getpid(), time.Now().UnixNano())
	if len(name) > 63 {
		name = name[:63]
	}
	if _, err := testAdmin.Exec(testContext(t), "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" OWNER work_owner"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = testAdmin.Exec(context.Background(), "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
	})
	return name, migratorURL(name)
}

func newRunner(t *testing.T, databaseURL string, legacyDisabled bool) *Runner {
	t.Helper()
	runner, err := New(Config{
		DatabaseURL:            databaseURL,
		Migrations:             embedded.FS,
		Root:                   ".",
		LegacyMigratorDisabled: legacyDisabled,
		LockTimeout:            10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func applyBaselineAsAdmin(t *testing.T, dbName string) {
	t.Helper()
	body, err := fs.ReadFile(embedded.FS, "baseline/0002_initial_r0a_schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	conn := connect(t, adminURL(dbName))
	defer conn.Close(testContext(t))
	if err := execRaw(testContext(t), conn, string(body)); err != nil {
		t.Fatal(err)
	}
}

func createLegacyLedger(t *testing.T, dbName string) {
	t.Helper()
	createLegacyLedgerRows(t, dbName, "0001_create_work_roles", "0002_initial_r0a_schema")
}

func createLegacyLedgerRows(t *testing.T, dbName string, names ...string) {
	t.Helper()
	conn := connect(t, adminURL(dbName))
	defer conn.Close(testContext(t))
	if err := execRaw(testContext(t), conn, `
		CREATE TABLE public.django_migrations (
		  id bigserial PRIMARY KEY,
		  app varchar(255) NOT NULL,
		  name varchar(255) NOT NULL,
		  applied timestamptz NOT NULL
		);
		GRANT SELECT ON public.django_migrations TO work_owner;
	`); err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if _, err := conn.Exec(testContext(t),
			`INSERT INTO public.django_migrations (app, name, applied) VALUES ('work', $1, now())`,
			name,
		); err != nil {
			t.Fatal(err)
		}
	}
}

func connect(t *testing.T, databaseURL string) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(testContext(t), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func execRaw(ctx context.Context, conn *pgx.Conn, sql string) error {
	results, err := conn.PgConn().Exec(ctx, sql).ReadAll()
	if err != nil {
		return err
	}
	for _, result := range results {
		if result.Err != nil {
			return result.Err
		}
	}
	return nil
}

func execAdmin(t *testing.T, dbName, sql string) {
	t.Helper()
	conn := connect(t, adminURL(dbName))
	defer conn.Close(testContext(t))
	if err := execRaw(testContext(t), conn, sql); err != nil {
		t.Fatal(err)
	}
}

func ledgerVersions(t *testing.T, dbName string) []int64 {
	t.Helper()
	conn := connect(t, adminURL(dbName))
	defer conn.Close(testContext(t))
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

func scalarInt(t *testing.T, dbName, sql string) int {
	t.Helper()
	conn := connect(t, adminURL(dbName))
	defer conn.Close(testContext(t))
	var value int
	if err := conn.QueryRow(testContext(t), sql).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func relationExists(t *testing.T, dbName, name string) bool {
	t.Helper()
	conn := connect(t, adminURL(dbName))
	defer conn.Close(testContext(t))
	var value *string
	if err := conn.QueryRow(testContext(t), `SELECT to_regclass($1)::text`, name).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value != nil
}

func adminURL(dbName string) string {
	return replaceDatabase(testAdminURL, "postgres", "postgres", dbName)
}

func migratorURL(dbName string) string {
	return replaceDatabase(testAdminURL, "work_migrator_login", "work", dbName)
}

func appURL(dbName string) string {
	return replaceDatabase(testAdminURL, "work_app_test_login", "work", dbName)
}

func replaceDatabase(base, user, password, dbName string) string {
	parsed, err := url.Parse(base)
	if err != nil {
		panic(err)
	}
	parsed.User = url.UserPassword(user, password)
	parsed.Path = "/" + dbName
	return parsed.String()
}

func equalInt64(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func copyEmbeddedMigrations(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	err := fs.WalkDir(embedded.FS, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(dir, filepath.FromSlash(path))
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		body, err := fs.ReadFile(embedded.FS, path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, body, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func appendIncrement(t *testing.T, dir string, migration Migration, sql string, catalogIsBaseline bool) {
	t.Helper()
	body := []byte(sql)
	path := filepath.Join(dir, filepath.FromSlash(migration.File))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(dir, "manifest.json")
	manifestBody, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest Manifest
	if err := json.Unmarshal(manifestBody, &manifest); err != nil {
		t.Fatal(err)
	}
	migration.Checksum = checksumBytes(body)
	if catalogIsBaseline {
		if count := len(manifest.Increments); count > 0 {
			migration.Catalog = manifest.Increments[count-1].Catalog
			migration.CatalogChecksum = manifest.Increments[count-1].CatalogChecksum
		} else {
			migration.Catalog = manifest.Catalog
			migration.CatalogChecksum = manifest.CatalogChecksum
		}
	}
	manifest.Increments = append(manifest.Increments, migration)
	updated, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, append(updated, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
