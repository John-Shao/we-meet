package testpg

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	embedded "github.com/we-meet/work/migrations"
)

const testPassword = "work"

func AdminURL() string {
	return os.Getenv("WORK_TEST_PG_URL")
}

func Open(ctx context.Context, databaseURL string) (*pgx.Conn, error) {
	return pgx.Connect(ctx, databaseURL)
}

func EnsureFixtures(ctx context.Context, admin *pgx.Conn) error {
	rolesSQL, err := fs.ReadFile(embedded.FS, "baseline/0001_roles_precondition.sql")
	if err != nil {
		return err
	}
	if err := ExecRaw(ctx, admin, string(rolesSQL)); err != nil {
		return fmt.Errorf("roles: %w", err)
	}
	if err := ensureLogin(ctx, admin, "work_migrator_login", "work_owner"); err != nil {
		return err
	}
	if err := ensureLogin(ctx, admin, "work_app_test_login", "work_api"); err != nil {
		return err
	}
	if err := ensureLogin(ctx, admin, "work_worker_test_login", "work_worker"); err != nil {
		return err
	}
	if err := ensureLogin(ctx, admin, "work_directory_test_login", "work_directory"); err != nil {
		return err
	}
	// baseline/0001_roles_precondition.sql is published and checksum-pinned, so it
	// cannot grow the seven-role list it creates; the R0b group roles and their logins
	// come from here instead, which mirrors deploy/ecs/provision-r0b-roles.sh.
	//
	// work_operator exists because 0023 grants the operator command EXECUTE to that role
	// and nothing else. There is no operator service yet - the transport is task #27 -
	// which is exactly why a dedicated role, rather than a shared one, is the boundary.
	for _, pair := range [][2]string{
		{"work_governance_events", "work_governance_test_login"},
		{"work_operator", "work_operator_test_login"},
		// Every workload role, work_ops included, is created NOLOGIN in 0001:6-8 and gets
		// its real login only through D-04 provisioning. A test still has to reach the duty
		// commands through the role itself rather than SET ROLE, or the grant boundary
		// that separates work_api from work_ops goes untested.
		{"work_ops", "work_ops_test_login"},
	} {
		if err := ensureGroupRole(ctx, admin, pair[0]); err != nil {
			return err
		}
		if err := ensureLogin(ctx, admin, pair[1], pair[0]); err != nil {
			return err
		}
	}
	return nil
}

func ensureGroupRole(ctx context.Context, admin *pgx.Conn, name string) error {
	var exists bool
	if err := admin.QueryRow(ctx,
		"SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", name).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	_, err := admin.Exec(ctx, "CREATE ROLE "+pgx.Identifier{name}.Sanitize()+
		" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS")
	return err
}

func ensureLogin(ctx context.Context, admin *pgx.Conn, name, member string) error {
	var exists bool
	if err := admin.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`, name).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		_, err := admin.Exec(ctx, fmt.Sprintf(
			`CREATE ROLE %s LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT`,
			pgx.Identifier{name}.Sanitize(), testPassword,
		))
		if err != nil {
			return err
		}
	} else {
		_, err := admin.Exec(ctx, fmt.Sprintf(
			`ALTER ROLE %s LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT`,
			pgx.Identifier{name}.Sanitize(), testPassword,
		))
		if err != nil {
			return err
		}
	}
	_, err := admin.Exec(ctx, fmt.Sprintf(
		`GRANT %s TO %s`,
		pgx.Identifier{member}.Sanitize(),
		pgx.Identifier{name}.Sanitize(),
	))
	return err
}

func CreateBaselineDB(ctx context.Context, admin *pgx.Conn, prefix string) (string, error) {
	name := databaseName(prefix)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" OWNER work_owner"); err != nil {
		return "", err
	}
	dbAdmin, err := Open(ctx, AdminURLFor(name))
	if err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	defer dbAdmin.Close(ctx)
	if err := ApplyChain(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	return name, nil
}

// ApplyChain applies every published migration in manifest order.
//
// The chain comes from manifest.json rather than a hand-kept list of helpers: an
// increment missing from a test-only list leaves every test running against the
// previous schema and still reports green, which is the worst possible failure
// for a schema test harness.
//
// What this path guarantees is order and file set, not integrity: it reads the SQL
// straight from disk, so a tampered body is caught by the runner's checksum and
// catalog verification (internal/migrate Apply/verifyCatalogAtVersion), which these
// fixtures deliberately do not reimplement. TestEmbeddedManifestLoads is what ties the
// manifest's file list to the published chain.
func ApplyChain(ctx context.Context, conn *pgx.Conn) error {
	files, err := migrationFiles("", "")
	if err != nil {
		return err
	}
	return applyFiles(ctx, conn, files)
}

// ApplyChainThrough applies the baseline and every increment up to and including
// the named one. Tests that need a pre-migration database use this instead of a
// private list of versions.
func ApplyChainThrough(ctx context.Context, conn *pgx.Conn, throughName string) error {
	files, err := migrationFiles(throughName, "")
	if err != nil {
		return err
	}
	return applyFiles(ctx, conn, files)
}

// ApplyIncrement applies exactly one named increment on top of whatever the
// database already holds.
func ApplyIncrement(ctx context.Context, conn *pgx.Conn, name string) error {
	files, err := migrationFiles("", name)
	if err != nil {
		return err
	}
	return applyFiles(ctx, conn, files)
}

// publishedFile mirrors the manifest fields that decide what runs and in which
// order. The runner's own manifest loader is not reused here: internal/testpg is
// imported by internal/migrate's tests, so importing it back would close a cycle.
// What is deliberately kept is the single source of ordering - manifest.json -
// because a hand-copied list drifts into a harness that tests an older schema.
type publishedFile struct {
	Name       string `json:"name"`
	File       string `json:"file"`
	Executable bool   `json:"executable"`
}

type publishedManifest struct {
	Baseline   []publishedFile `json:"baseline"`
	Increments []publishedFile `json:"increments"`
}

func migrationFiles(throughName, onlyName string) ([]string, error) {
	body, err := fs.ReadFile(embedded.FS, "manifest.json")
	if err != nil {
		return nil, err
	}
	var manifest publishedManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return nil, err
	}
	var out []string
	for _, migration := range manifest.Baseline {
		if migration.Executable {
			out = append(out, migration.File)
		}
	}
	if onlyName != "" {
		for _, migration := range manifest.Increments {
			if migration.Name == onlyName {
				return []string{migration.File}, nil
			}
		}
		return nil, fmt.Errorf("unknown increment %q", onlyName)
	}
	if throughName == "" {
		for _, migration := range manifest.Increments {
			out = append(out, migration.File)
		}
		return out, nil
	}
	for _, migration := range manifest.Increments {
		out = append(out, migration.File)
		if migration.Name == throughName {
			return out, nil
		}
	}
	return nil, fmt.Errorf("unknown increment %q", throughName)
}

func applyFiles(ctx context.Context, conn *pgx.Conn, files []string) error {
	if len(files) == 0 {
		return fmt.Errorf("no published migration files selected")
	}
	for _, file := range files {
		body, err := fs.ReadFile(embedded.FS, file)
		if err != nil {
			return err
		}
		if err := ExecRaw(ctx, conn, string(body)); err != nil {
			return fmt.Errorf("apply %s: %w", file, err)
		}
	}
	return nil
}

func DropDatabase(ctx context.Context, admin *pgx.Conn, name string) error {
	_, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
	return err
}

func AdminURLFor(dbName string) string {
	return urlFor(AdminURL(), "", "", dbName)
}

func AppURL(dbName string) string {
	return urlFor(AdminURL(), "work_app_test_login", testPassword, dbName)
}

func WorkerURL(dbName string) string {
	return urlFor(AdminURL(), "work_worker_test_login", testPassword, dbName)
}

func MigratorURL(dbName string) string {
	return urlFor(AdminURL(), "work_migrator_login", testPassword, dbName)
}

func DirectoryURL(dbName string) string {
	return urlFor(AdminURL(), "work_directory_test_login", testPassword, dbName)
}

func GovernanceURL(dbName string) string {
	return urlFor(AdminURL(), "work_governance_test_login", testPassword, dbName)
}

// OperatorURL connects as the operator workload. 0023 grants the entitlement command
// EXECUTE to work_operator only, so tests that exercise the operator face must connect
// here rather than through the app role - and a test that expects a refusal has to use
// AppURL to prove it.
func OperatorURL(dbName string) string {
	return urlFor(AdminURL(), "work_operator_test_login", testPassword, dbName)
}

// OpsURL connects through the work_ops workload role itself. The duty commands
// (work.ops_cancel_run, work.ops_delete_task) are EXECUTE-granted to work_ops only
// (baseline/0002:5228-5229), so reaching them needs that role; AppURL is the one that
// proves the boundary refuses.
func OpsURL(dbName string) string {
	return urlFor(AdminURL(), "work_ops_test_login", testPassword, dbName)
}

func urlFor(base, user, password, dbName string) string {
	parsed, err := url.Parse(base)
	if err != nil {
		panic(err)
	}
	if user != "" {
		parsed.User = url.UserPassword(user, password)
	}
	parsed.Path = "/" + dbName
	return parsed.String()
}

func ExecRaw(ctx context.Context, conn *pgx.Conn, sql string) error {
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

func databaseName(prefix string) string {
	name := fmt.Sprintf("%s_%d_%d", prefix, os.Getpid(), time.Now().UnixNano())
	if len(name) > 63 {
		name = name[:63]
	}
	return name
}
