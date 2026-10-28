package migrate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const advisoryLockKey = "work.schema_migration"

type Config struct {
	DatabaseURL            string
	Migrations             fs.FS
	Root                   string
	LegacyMigratorDisabled bool
	LockTimeout            time.Duration
}

type Runner struct {
	cfg         Config
	manifest    *Manifest
	conn        *pgx.Conn
	admission   *Admission
	sessionRole bool
}

type AppliedMigration struct {
	Version int64  `json:"version"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Adopted bool   `json:"adopted,omitempty"`
}

type Result struct {
	State         string             `json:"state"`
	Ledger        string             `json:"ledger"`
	Applied       []AppliedMigration `json:"applied,omitempty"`
	Pending       []int64            `json:"pending,omitempty"`
	CatalogSHA256 string             `json:"catalog_sha256,omitempty"`
}

func New(cfg Config) (*Runner, error) {
	if cfg.DatabaseURL == "" {
		return nil, newError("database_url_required", "database URL is required")
	}
	if cfg.Migrations == nil {
		return nil, newError("migrations_required", "migration filesystem is required")
	}
	if cfg.LockTimeout <= 0 {
		cfg.LockTimeout = 30 * time.Second
	}
	manifest, err := LoadManifest(cfg.Migrations, cfg.Root)
	if err != nil {
		return nil, err
	}
	if manifest.Catalog == "" || manifest.CatalogChecksum == "" {
		return nil, newError("catalog_missing", "baseline catalog is not pinned")
	}
	return &Runner{cfg: cfg, manifest: manifest}, nil
}

func (r *Runner) Close(ctx context.Context) {
	if r.conn == nil {
		return
	}
	if r.sessionRole {
		_, _ = r.conn.Exec(ctx, "RESET ROLE")
	}
	_ = r.conn.Close(ctx)
	r.conn = nil
}

func (r *Runner) connect(ctx context.Context) error {
	conn, err := pgx.Connect(ctx, r.cfg.DatabaseURL)
	if err != nil {
		return newError("database_connect_failed", "connect: %v", err)
	}
	r.conn = conn
	if _, err := conn.Exec(ctx, `SET application_name = 'work-migrate'`); err != nil {
		return newError("database_connect_failed", "set application_name: %v", err)
	}
	return nil
}

func (r *Runner) open(ctx context.Context) error {
	if err := r.connect(ctx); err != nil {
		return err
	}
	admission, err := Preflight(ctx, r.conn)
	if err != nil {
		return err
	}
	r.admission = admission
	if _, err := r.conn.Exec(ctx, `SET ROLE work_owner`); err != nil {
		return newError("role_membership_failed", "SET ROLE work_owner: %v", err)
	}
	r.sessionRole = true
	return nil
}

func (r *Runner) Status(ctx context.Context) (*Result, error) {
	if err := r.open(ctx); err != nil {
		return nil, err
	}
	defer r.Close(ctx)
	state, err := ReadState(ctx, r.conn)
	if err != nil {
		return nil, err
	}
	result := &Result{Ledger: r.manifest.LedgerTable}
	result.Pending = versions(pendingIncrements(state, r.manifest))
	if state.LedgerExists {
		if err := verifyLedgerSchema(ctx, r.conn); err != nil {
			return nil, err
		}
		if err := verifyLedgerAgainstManifest(state, r.manifest); err != nil {
			return nil, err
		}
		if err := r.verifyCatalogAtVersion(ctx, r.conn, state.MaxLedgerVersion()); err != nil {
			return nil, err
		}
		result.Applied = appliedFromState(state)
		if len(result.Pending) == 0 {
			result.State = "up_to_date"
		} else {
			result.State = "pending"
		}
		return result, nil
	}
	if state.Empty() {
		result.State = "empty"
	} else {
		result.State = "existing_unmanaged"
	}
	return result, nil
}

func (r *Runner) Plan(ctx context.Context) (*Result, error) {
	return r.Status(ctx)
}

func (r *Runner) Apply(ctx context.Context) (*Result, error) {
	if !r.cfg.LegacyMigratorDisabled {
		return nil, newError(
			"dual_writer_forbidden",
			"apply requires -legacy-migrator-disabled; the legacy Django migration runner must be off first",
		)
	}
	if err := r.open(ctx); err != nil {
		return nil, err
	}
	defer r.Close(ctx)
	if err := r.acquireLock(ctx); err != nil {
		return nil, err
	}
	defer r.releaseLock(ctx)

	state, err := ReadState(ctx, r.conn)
	if err != nil {
		return nil, err
	}

	result := &Result{Ledger: r.manifest.LedgerTable}
	if state.LedgerExists {
		if err := verifyLedgerSchema(ctx, r.conn); err != nil {
			return nil, err
		}
		if err := verifyLedgerAgainstManifest(state, r.manifest); err != nil {
			return nil, err
		}
		if err := r.verifyCatalogAtVersion(ctx, r.conn, state.MaxLedgerVersion()); err != nil {
			return nil, err
		}
		result.State = "up_to_date"
	} else if state.Empty() {
		if state.LegacyHasAnyWorkMigration() {
			return nil, newError(
				"legacy_ledger_without_objects",
				"django_migrations records Work but the work schema is empty; refusing to initialize over missing state",
			)
		}
		if state.WorkSchema && state.SchemaOwner != "work_owner" {
			return nil, withDiff(
				newError("schema_owner_mismatch", "work schema is owned by %s, expected work_owner", state.SchemaOwner),
				&Diff{SchemaOwner: &StringDiff{Expected: "work_owner", Actual: state.SchemaOwner}},
			)
		}
		applied, err := r.initializeBaseline(ctx)
		if err != nil {
			return nil, err
		}
		result.State = "empty_initialized"
		result.Applied = applied
		state, err = ReadState(ctx, r.conn)
		if err != nil {
			return nil, err
		}
	} else {
		if !state.LegacyLedgerExists || !state.LegacyHasBaseline() {
			return nil, newError(
				"legacy_ledger_missing",
				"work objects exist but django_migrations lacks the Work 0001/0002 baseline; refusing to stamp",
			)
		}
		applied, err := r.adoptBaseline(ctx)
		if err != nil {
			return nil, err
		}
		result.State = "adopted"
		result.Applied = applied
		state, err = ReadState(ctx, r.conn)
		if err != nil {
			return nil, err
		}
	}

	pending := pendingIncrements(state, r.manifest)
	if len(pending) > 0 {
		result.State = "applied"
		for _, migration := range pending {
			applied, err := r.applyIncrement(ctx, migration)
			if err != nil {
				return result, err
			}
			result.Applied = append(result.Applied, applied)
			result.Pending = nil
		}
	}
	return result, nil
}

func (r *Runner) initializeBaseline(ctx context.Context) ([]AppliedMigration, error) {
	baseline, err := r.executableBaseline()
	if err != nil {
		return nil, err
	}
	body, err := fs.ReadFile(r.cfg.Migrations, joinRoot(r.cfg.Root, baseline.File))
	if err != nil {
		return nil, newError("migration_file_unreadable", "read %s: %v", baseline.File, err)
	}

	tx, err := r.conn.Begin(ctx)
	if err != nil {
		return nil, newError("transaction_failed", "begin: %v", err)
	}
	defer tx.Rollback(ctx)

	start := time.Now()
	if err := execScript(ctx, tx, body); err != nil {
		return nil, newError("baseline_apply_failed", "apply %s: %v", baseline.Name, err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE work_owner`); err != nil {
		return nil, newError("role_membership_failed", "SET LOCAL ROLE work_owner: %v", err)
	}
	if err := r.verifyCatalogAtVersion(ctx, tx, baseline.Version); err != nil {
		return nil, err
	}
	if err := ensureLedger(ctx, tx); err != nil {
		return nil, err
	}
	applied := make([]AppliedMigration, 0, len(r.manifest.Baseline))
	for _, migration := range r.manifest.Baseline {
		adopted := false
		adoptedFrom := ""
		var duration *int32
		if migration.Version == baseline.Version {
			ms := int32(time.Since(start).Milliseconds())
			duration = &ms
		}
		if err := insertLedgerRow(ctx, tx, migration, adopted, adoptedFrom, r.admission.SessionUser, duration); err != nil {
			return nil, err
		}
		applied = append(applied, AppliedMigration{
			Version: migration.Version, Name: migration.Name, Kind: migration.Kind,
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, newError("transaction_failed", "commit baseline: %v", err)
	}
	return applied, nil
}

func (r *Runner) adoptBaseline(ctx context.Context) ([]AppliedMigration, error) {
	baseline, err := r.executableBaseline()
	if err != nil {
		return nil, err
	}
	tx, err := r.conn.Begin(ctx)
	if err != nil {
		return nil, newError("transaction_failed", "begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE work_owner`); err != nil {
		return nil, newError("role_membership_failed", "SET LOCAL ROLE work_owner: %v", err)
	}
	if err := r.verifyCatalogAtVersion(ctx, tx, baseline.Version); err != nil {
		return nil, err
	}
	if err := ensureLedger(ctx, tx); err != nil {
		return nil, err
	}
	applied := make([]AppliedMigration, 0, len(r.manifest.Baseline))
	for _, migration := range r.manifest.Baseline {
		if err := insertLedgerRow(
			ctx, tx, migration, true, "django_migrations", r.admission.SessionUser, nil,
		); err != nil {
			return nil, err
		}
		applied = append(applied, AppliedMigration{
			Version: migration.Version, Name: migration.Name, Kind: migration.Kind, Adopted: true,
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, newError("transaction_failed", "commit adoption: %v", err)
	}
	return applied, nil
}

func (r *Runner) applyIncrement(ctx context.Context, migration Migration) (AppliedMigration, error) {
	if !migration.Transactional {
		if migration.NamedRecoveryProtocol == "" {
			return AppliedMigration{}, newError(
				"non_transactional_needs_protocol",
				"increment %s is non-transactional and has no named recovery protocol",
				migration.Name,
			)
		}
		return AppliedMigration{}, newError(
			"non_transactional_protocol_unimplemented",
			"increment %s names recovery protocol %q, which this runner does not implement",
			migration.Name, migration.NamedRecoveryProtocol,
		)
	}
	body, err := fs.ReadFile(r.cfg.Migrations, joinRoot(r.cfg.Root, migration.File))
	if err != nil {
		return AppliedMigration{}, newError("migration_file_unreadable", "read %s: %v", migration.File, err)
	}
	tx, err := r.conn.Begin(ctx)
	if err != nil {
		return AppliedMigration{}, newError("transaction_failed", "begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE work_owner`); err != nil {
		return AppliedMigration{}, newError("role_membership_failed", "SET LOCAL ROLE work_owner: %v", err)
	}
	start := time.Now()
	if err := execScript(ctx, tx, body); err != nil {
		return AppliedMigration{}, newError("increment_apply_failed", "apply %s: %v", migration.Name, err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE work_owner`); err != nil {
		return AppliedMigration{}, newError("role_membership_failed", "SET LOCAL ROLE work_owner: %v", err)
	}
	if err := r.verifyCatalogAtVersion(ctx, tx, migration.Version); err != nil {
		return AppliedMigration{}, err
	}
	ms := int32(time.Since(start).Milliseconds())
	if err := insertLedgerRow(
		ctx, tx, migration, false, "", r.admission.SessionUser, &ms,
	); err != nil {
		return AppliedMigration{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AppliedMigration{}, newError("transaction_failed", "commit %s: %v", migration.Name, err)
	}
	return AppliedMigration{Version: migration.Version, Name: migration.Name, Kind: migration.Kind}, nil
}

func (r *Runner) executableBaseline() (Migration, error) {
	var found *Migration
	for i := range r.manifest.Baseline {
		migration := &r.manifest.Baseline[i]
		if migration.Kind != "baseline" {
			continue
		}
		if found != nil {
			return Migration{}, newError("manifest_invalid", "multiple executable baseline migrations")
		}
		found = migration
	}
	if found == nil {
		return Migration{}, newError("manifest_invalid", "no executable baseline migration")
	}
	return *found, nil
}

func (r *Runner) verifyCatalogAtVersion(ctx context.Context, q Querier, version int64) error {
	catalogPath, expectedChecksum, err := r.manifest.CatalogForVersion(version)
	if err != nil {
		return err
	}
	expected, body, err := LoadCatalog(r.cfg.Migrations, r.cfg.Root, catalogPath)
	if err != nil {
		return err
	}
	if checksumBytes(body) != expectedChecksum {
		return newError("published_migration_modified", "catalog %s does not match its pinned checksum", catalogPath)
	}
	actual, err := ReadCatalog(ctx, q)
	if err != nil {
		return err
	}
	diff, err := expected.Diff(actual)
	if err != nil {
		return newError("catalog_diff_failed", "compare catalog: %v", err)
	}
	if !diff.Empty() {
		return withDiff(newError("drift", "schema drift at version %d", version), diff)
	}
	if diff.ExpectedSHA256 != diff.ActualSHA256 {
		return withDiff(newError("drift", "catalog hash mismatch at version %d", version), diff)
	}
	return nil
}

func (r *Runner) acquireLock(ctx context.Context) error {
	if _, err := r.conn.Exec(ctx, `SELECT set_config('lock_timeout', $1, false)`, r.cfg.LockTimeout.String()); err != nil {
		return newError("lock_setup_failed", "set lock_timeout: %v", err)
	}
	if _, err := r.conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext($1))`, advisoryLockKey); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
			return newError("migration_lock_timeout", "another runner holds the schema migration lock")
		}
		return newError("lock_failed", "acquire advisory lock: %v", err)
	}
	return nil
}

func (r *Runner) releaseLock(ctx context.Context) {
	if r.conn == nil {
		return
	}
	_, _ = r.conn.Exec(ctx, `SELECT pg_advisory_unlock(hashtext($1))`, advisoryLockKey)
}

func execScript(ctx context.Context, tx pgx.Tx, body []byte) error {
	results, err := tx.Conn().PgConn().Exec(ctx, string(body)).ReadAll()
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

func joinRoot(root, file string) string {
	if root == "" || root == "." {
		return file
	}
	return fmt.Sprintf("%s/%s", root, file)
}

func versions(migrations []Migration) []int64 {
	out := make([]int64, 0, len(migrations))
	for _, migration := range migrations {
		out = append(out, migration.Version)
	}
	return out
}

func appliedFromState(state *State) []AppliedMigration {
	out := make([]AppliedMigration, 0, len(state.Ledger))
	for _, row := range state.Ledger {
		out = append(out, AppliedMigration{
			Version: row.Version, Name: row.Name, Kind: row.Kind, Adopted: row.Adopted,
		})
	}
	return out
}
