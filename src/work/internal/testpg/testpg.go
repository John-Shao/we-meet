package testpg

import (
	"context"
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
	return nil
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
	if err := ApplyBaseline(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyDirectoryAbsence(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyOutboxTaskEventKind(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyRunWorkflowID(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyOrgProvision(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyOrgProvisionBackfill(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyQuotaDirectoryUsageHardening(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyRuntimeExecutionDispatchGate(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyRuntimeCapability(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyContentReference(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyContentSlot(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyModelRequestDispatchConsume(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyAdvanceBindingReads(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplySnapshotRevision(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	if err := ApplyReconcileRejectedReceipt(ctx, dbAdmin); err != nil {
		_ = DropDatabase(ctx, admin, name)
		return "", err
	}
	return name, nil
}

func ApplyBaseline(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "baseline/0002_initial_r0a_schema.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyDirectoryAbsence(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0003_directory_absence.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyOutboxTaskEventKind(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0004_outbox_task_event_kind.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyRunWorkflowID(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0005_run_workflow_id.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyOrgProvision(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0006_org_policy_quota_provision.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyOrgProvisionBackfill(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0007_org_provision_backfill.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyQuotaDirectoryUsageHardening(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0008_quota_directory_usage_hardening.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyRuntimeExecutionDispatchGate(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0009_runtime_execution_dispatch_gate.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyRuntimeCapability(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0010_runtime_capability.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyContentReference(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0011_content_reference.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyContentSlot(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0012_content_slot.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyModelRequestDispatchConsume(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0013_model_request_dispatch_consume.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyAdvanceBindingReads(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0014_advance_binding_reads.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplySnapshotRevision(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0015_snapshot_revision.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
}

func ApplyReconcileRejectedReceipt(ctx context.Context, conn *pgx.Conn) error {
	body, err := fs.ReadFile(embedded.FS, "increments/0016_reconcile_rejected_receipt.sql")
	if err != nil {
		return err
	}
	return ExecRaw(ctx, conn, string(body))
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
