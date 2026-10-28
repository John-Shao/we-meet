package migrate

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

type State struct {
	WorkSchema           bool
	SchemaOwner          string
	RelationCount        int
	FunctionCount        int
	LedgerExists         bool
	LegacyLedgerExists   bool
	LegacyWorkMigrations []string
	Ledger               []LedgerRow
}

type LedgerRow struct {
	Version       int64
	Name          string
	Kind          string
	Checksum      string
	Transactional bool
	Adopted       bool
	AdoptedFrom   *string
	AppliedBy     string
	AppliedAt     time.Time
	DurationMS    *int32
}

func (s *State) Empty() bool {
	return !s.LedgerExists && s.RelationCount == 0 && s.FunctionCount == 0
}

func (s *State) HasWorkObjects() bool {
	return s.RelationCount > 0 || s.FunctionCount > 0
}

func (s *State) LegacyHasAnyWorkMigration() bool {
	for _, name := range s.LegacyWorkMigrations {
		if name == "0001_create_work_roles" || name == "0002_initial_r0a_schema" {
			return true
		}
	}
	return false
}

func (s *State) LegacyHasBaseline() bool {
	var hasRoles, hasSchema bool
	for _, name := range s.LegacyWorkMigrations {
		switch name {
		case "0001_create_work_roles":
			hasRoles = true
		case "0002_initial_r0a_schema":
			hasSchema = true
		}
	}
	return hasRoles && hasSchema
}

func ReadState(ctx context.Context, q Querier) (*State, error) {
	state := &State{}

	err := q.QueryRow(ctx, `SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'work'`).Scan(&state.SchemaOwner)
	switch err {
	case nil:
		state.WorkSchema = true
	case pgx.ErrNoRows:
		state.WorkSchema = false
	default:
		return nil, newError("state_read_failed", "read work schema: %v", err)
	}

	if err := q.QueryRow(ctx, `
		SELECT count(*)
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'work'
		  AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
		  AND c.relname <> 'schema_migration'`).Scan(&state.RelationCount); err != nil {
		return nil, newError("state_read_failed", "count relations: %v", err)
	}
	if err := q.QueryRow(ctx, `
		SELECT count(*)
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'work'`).Scan(&state.FunctionCount); err != nil {
		return nil, newError("state_read_failed", "count functions: %v", err)
	}

	if err := q.QueryRow(ctx, `SELECT to_regclass('work.schema_migration') IS NOT NULL`).Scan(&state.LedgerExists); err != nil {
		return nil, newError("state_read_failed", "detect ledger: %v", err)
	}
	if err := q.QueryRow(ctx, `SELECT to_regclass('public.django_migrations') IS NOT NULL`).Scan(&state.LegacyLedgerExists); err != nil {
		return nil, newError("state_read_failed", "detect legacy ledger: %v", err)
	}

	if state.LegacyLedgerExists {
		rows, err := q.Query(ctx, `SELECT name FROM public.django_migrations WHERE app = 'work' ORDER BY id`)
		if err != nil {
			return nil, newError("legacy_ledger_invalid", "read django_migrations: %v", err)
		}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				rows.Close()
				return nil, newError("legacy_ledger_invalid", "scan django_migrations: %v", err)
			}
			state.LegacyWorkMigrations = append(state.LegacyWorkMigrations, name)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, newError("legacy_ledger_invalid", "read django_migrations: %v", err)
		}
		rows.Close()
	}

	if state.LedgerExists {
		rows, err := q.Query(ctx, `
			SELECT version, name, kind, checksum, transactional, adopted, adopted_from,
			       applied_by, applied_at, duration_ms
			FROM work.schema_migration
			ORDER BY version`)
		if err != nil {
			return nil, newError("ledger_invalid", "read ledger: %v", err)
		}
		for rows.Next() {
			var row LedgerRow
			if err := rows.Scan(
				&row.Version, &row.Name, &row.Kind, &row.Checksum, &row.Transactional,
				&row.Adopted, &row.AdoptedFrom, &row.AppliedBy, &row.AppliedAt, &row.DurationMS,
			); err != nil {
				rows.Close()
				return nil, newError("ledger_invalid", "scan ledger: %v", err)
			}
			state.Ledger = append(state.Ledger, row)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, newError("ledger_invalid", "read ledger: %v", err)
		}
		rows.Close()
	}

	return state, nil
}

func (s *State) LedgerByVersion() map[int64]LedgerRow {
	out := make(map[int64]LedgerRow, len(s.Ledger))
	for _, row := range s.Ledger {
		out[row.Version] = row
	}
	return out
}

func (s *State) MaxLedgerVersion() int64 {
	var max int64
	for _, row := range s.Ledger {
		if row.Version > max {
			max = row.Version
		}
	}
	return max
}
