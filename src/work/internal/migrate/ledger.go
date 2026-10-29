package migrate

import (
	"context"
	"sort"

	"github.com/jackc/pgx/v5"
)

const ledgerDDL = `
CREATE TABLE IF NOT EXISTS work.schema_migration (
  version bigint PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('precondition', 'baseline', 'increment')),
  checksum text NOT NULL,
  transactional boolean NOT NULL,
  adopted boolean NOT NULL DEFAULT false,
  adopted_from text,
  applied_by text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer
)`

type ledgerColumn struct {
	name     string
	dataType string
	nullable string
}

var expectedLedgerColumns = []ledgerColumn{
	{"version", "bigint", "NO"},
	{"name", "text", "NO"},
	{"kind", "text", "NO"},
	{"checksum", "text", "NO"},
	{"transactional", "boolean", "NO"},
	{"adopted", "boolean", "NO"},
	{"adopted_from", "text", "YES"},
	{"applied_by", "text", "NO"},
	{"applied_at", "timestamp with time zone", "NO"},
	{"duration_ms", "integer", "YES"},
}

func ensureLedger(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, ledgerDDL); err != nil {
		return newError("ledger_create_failed", "create work.schema_migration: %v", err)
	}
	return verifyLedgerSchema(ctx, tx)
}

func verifyLedgerSchema(ctx context.Context, q Querier) error {
	rows, err := q.Query(ctx, `
		SELECT column_name, data_type, is_nullable
		FROM information_schema.columns
		WHERE table_schema = 'work' AND table_name = 'schema_migration'
		ORDER BY ordinal_position`)
	if err != nil {
		return newError("ledger_invalid", "read ledger columns: %v", err)
	}
	defer rows.Close()

	var actual []ledgerColumn
	for rows.Next() {
		var column ledgerColumn
		if err := rows.Scan(&column.name, &column.dataType, &column.nullable); err != nil {
			return newError("ledger_invalid", "scan ledger column: %v", err)
		}
		actual = append(actual, column)
	}
	if err := rows.Err(); err != nil {
		return newError("ledger_invalid", "read ledger columns: %v", err)
	}

	expected := make(map[string]ledgerColumn, len(expectedLedgerColumns))
	for _, column := range expectedLedgerColumns {
		expected[column.name] = column
	}
	seen := make(map[string]bool, len(actual))
	for _, column := range actual {
		seen[column.name] = true
		want, ok := expected[column.name]
		if !ok {
			return newError("ledger_schema_mismatch", "ledger has unexpected column %q", column.name)
		}
		if column.dataType != want.dataType || column.nullable != want.nullable {
			return newError(
				"ledger_schema_mismatch",
				"ledger column %q is %s/%s, expected %s/%s",
				column.name, column.dataType, column.nullable, want.dataType, want.nullable,
			)
		}
	}
	for _, column := range expectedLedgerColumns {
		if !seen[column.name] {
			return newError("ledger_schema_mismatch", "ledger is missing column %q", column.name)
		}
	}
	return nil
}

func insertLedgerRow(
	ctx context.Context,
	tx pgx.Tx,
	migration Migration,
	adopted bool,
	adoptedFrom string,
	appliedBy string,
	durationMS *int32,
) error {
	var from any
	if adoptedFrom != "" {
		from = adoptedFrom
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO work.schema_migration
		  (version, name, kind, checksum, transactional, adopted, adopted_from, applied_by, duration_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		migration.Version, migration.Name, migration.Kind, migration.Checksum,
		migration.Transactional, adopted, from, appliedBy, durationMS,
	)
	if err != nil {
		return newError("ledger_write_failed", "insert migration %s: %v", migration.Name, err)
	}
	return nil
}

func verifyLedgerAgainstManifest(state *State, manifest *Manifest) error {
	byVersion := make(map[int64]Migration)
	for _, migration := range manifest.All() {
		byVersion[migration.Version] = migration
	}
	applied := state.LedgerByVersion()
	for version, row := range applied {
		migration, ok := byVersion[version]
		if !ok {
			return newError("ledger_version_unknown", "ledger contains version %d (%s) not present in the manifest", version, row.Name)
		}
		if row.Name != migration.Name || row.Kind != migration.Kind {
			return newError(
				"ledger_migration_mismatch",
				"ledger version %d is %s/%s, manifest is %s/%s",
				version, row.Kind, row.Name, migration.Kind, migration.Name,
			)
		}
		if !checksumMatches(row.Checksum, migration) {
			return newError(
				"published_migration_modified",
				"ledger version %d pins %s, manifest pins %s",
				version, row.Checksum, migration.Checksum,
			)
		}
	}
	for _, migration := range manifest.All() {
		if _, ok := applied[migration.Version]; !ok {
			if migration.Kind == "increment" {
				continue
			}
			return newError("ledger_baseline_missing", "ledger is missing baseline version %d (%s)", migration.Version, migration.Name)
		}
	}
	return verifyAppliedPrefix(manifest, applied)
}

func checksumMatches(checksum string, migration Migration) bool {
	if checksum == migration.Checksum {
		return true
	}
	for _, legacy := range migration.LegacyChecksums {
		if checksum == legacy {
			return true
		}
	}
	return false
}

func verifyAppliedPrefix(manifest *Manifest, applied map[int64]LedgerRow) error {
	all := manifest.All()
	var maxApplied int64
	for version := range applied {
		if version > maxApplied {
			maxApplied = version
		}
	}
	for _, migration := range all {
		if migration.Version > maxApplied {
			break
		}
		if _, ok := applied[migration.Version]; !ok {
			return newError(
				"ledger_version_gap",
				"version %d (%s) is not applied while a later version is",
				migration.Version, migration.Name,
			)
		}
	}
	return nil
}

func pendingIncrements(state *State, manifest *Manifest) []Migration {
	applied := state.LedgerByVersion()
	var pending []Migration
	for _, migration := range manifest.Increments {
		if _, ok := applied[migration.Version]; !ok {
			pending = append(pending, migration)
		}
	}
	sort.Slice(pending, func(i, j int) bool { return pending[i].Version < pending[j].Version })
	return pending
}
