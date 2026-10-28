package db

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Identity struct {
	OrgID     string
	SubjectID string
}

type Role string

const (
	RoleAPI       Role = "work_api"
	RoleWorker    Role = "work_worker"
	RoleOps       Role = "work_ops"
	RoleDirectory Role = "work_directory"
)

type Options struct {
	ReadOnly bool
}

type Error struct {
	Code    string
	Message string
	Err     error
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.Err }

func Wrap(code, message string, err error) *Error {
	return &Error{Code: code, Message: message, Err: err}
}

func OpenPool(ctx context.Context, databaseURL, applicationName string) (*pgxpool.Pool, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, Wrap("database_url_required", "database URL is required", nil)
	}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, Wrap("database_url_invalid", "parse database URL", err)
	}
	if applicationName == "" {
		applicationName = "work-api"
	}
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = make(map[string]string)
	}
	config.ConnConfig.RuntimeParams["application_name"] = applicationName
	config.MaxConns = 8
	config.MinConns = 0

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, Wrap("pool_create_failed", "create connection pool", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, Wrap("pool_ping_failed", "ping database", err)
	}
	return pool, nil
}

func WithWorkContext(
	ctx context.Context,
	pool *pgxpool.Pool,
	identity Identity,
	role Role,
	options Options,
	fn func(pgx.Tx) error,
) error {
	if err := identity.validate(); err != nil {
		return err
	}
	if !role.valid() {
		return Wrap("invalid_role", fmt.Sprintf("role %q is not allowed for request-path work", role), nil)
	}
	return withContext(ctx, pool, identity, role, options, fn)
}

// WithDirectoryContext scopes a transaction to one tenant for the Host directory
// adapter. The adapter has no end-user subject: the sync commands audit with a
// NULL actor and never set app.subject_id.
func WithDirectoryContext(
	ctx context.Context,
	pool *pgxpool.Pool,
	orgID string,
	options Options,
	fn func(pgx.Tx) error,
) error {
	if err := validateID("org_id", orgID); err != nil {
		return err
	}
	return withContext(ctx, pool, Identity{OrgID: orgID}, RoleDirectory, options, fn)
}

func withContext(
	ctx context.Context,
	pool *pgxpool.Pool,
	identity Identity,
	role Role,
	options Options,
	fn func(pgx.Tx) error,
) error {
	if pool == nil {
		return Wrap("pool_required", "connection pool is required", nil)
	}
	if fn == nil {
		return Wrap("callback_required", "transaction callback is required", nil)
	}

	txOptions := pgx.TxOptions{IsoLevel: pgx.ReadCommitted}
	if options.ReadOnly {
		txOptions.AccessMode = pgx.ReadOnly
	}
	tx, err := pool.BeginTx(ctx, txOptions)
	if err != nil {
		return Wrap("begin_failed", "begin work transaction", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	if _, err := tx.Exec(ctx,
		`SELECT set_config('role', $1, true),
		        set_config('app.org_id', $2, true),
		        set_config('app.subject_id', $3, true)`,
		string(role), identity.OrgID, identity.SubjectID,
	); err != nil {
		return Wrap("context_setup_failed", "set work RLS context", err)
	}

	if err := fn(tx); err != nil {
		return err
	}

	// SET LOCAL survives inner savepoints; clear identity before the outer commit
	// so a recycled pooled connection cannot inherit another tenant's context.
	if _, err := tx.Exec(ctx, `RESET ROLE`); err != nil {
		return Wrap("context_reset_failed", "reset role", err)
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.org_id', '', true),
		        set_config('app.subject_id', '', true)`,
	); err != nil {
		return Wrap("context_reset_failed", "reset work context", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Wrap("commit_failed", "commit work transaction", err)
	}
	committed = true
	return nil
}

func (i Identity) validate() error {
	if err := validateID("org_id", i.OrgID); err != nil {
		return err
	}
	return validateID("subject_id", i.SubjectID)
}

func validateID(name, value string) error {
	if strings.TrimSpace(value) == "" {
		return Wrap("invalid_identity", name+" is required", nil)
	}
	if len(value) > 128 {
		return Wrap("invalid_identity", name+" must be at most 128 bytes", nil)
	}
	if strings.ContainsRune(value, '\x00') {
		return Wrap("invalid_identity", name+" must not contain NUL", nil)
	}
	return nil
}

func (r Role) valid() bool {
	switch r {
	case RoleAPI, RoleWorker, RoleOps, RoleDirectory:
		return true
	default:
		return false
	}
}
