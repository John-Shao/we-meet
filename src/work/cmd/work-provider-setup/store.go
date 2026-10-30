package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/providerctx"
)

// credentialPlan is the sealed credential handed to
// work.create_provider_credential. KeyVersion is validated by the caller; the
// domain function has no key_version parameter and always stores 1.
type credentialPlan struct {
	Provider    string
	Mode        string
	KeyVersion  int
	Ciphertext  []byte
	Fingerprint string
}

type credentialResult struct {
	CredentialID string
	KeyVersion   int
	Fingerprint  string
}

// configPlan is the active provider configuration for one organization. The
// credential mode is read from work.get_provider_credential_view because
// work.set_provider_config requires it and the CLI has no -mode flag.
type configPlan struct {
	Provider     string
	Model        string
	Region       string
	Endpoint     string
	CredentialID string
}

type configResult struct {
	ConfigID       string
	Revision       int64
	CredentialMode string
}

// backend isolates the signed domain-function calls so argument validation and
// redaction can be tested without PostgreSQL.
type backend interface {
	CreateCredential(ctx context.Context, identity workdb.Identity, plan credentialPlan) (credentialResult, error)
	RotateCredential(ctx context.Context, identity workdb.Identity, credentialID string, plan credentialPlan) (credentialResult, error)
	RevokeCredential(ctx context.Context, identity workdb.Identity, credentialID, reason string) error
	SetConfig(ctx context.Context, identity workdb.Identity, plan configPlan, dryRun bool) (configResult, error)
	ResolveProvider(ctx context.Context, orgID string) (providerctx.Context, error)
	Close()
}

type pgBackend struct {
	pool   *pgxpool.Pool
	master []byte
}

func newPGScopedBackend(ctx context.Context, databaseURL string, master []byte) (backend, error) {
	pool, err := workdb.OpenPool(ctx, databaseURL, "work-provider-setup")
	if err != nil {
		return nil, mapPoolError(err)
	}
	return &pgBackend{pool: pool, master: master}, nil
}

func (b *pgBackend) Close() {
	if b != nil && b.pool != nil {
		b.pool.Close()
	}
}

// CreateCredential invokes work.create_provider_credential as work_api. The
// function signature is (text, text, text, text, text, bytea, bytea, text,
// text): org, actor, provider, mode, role_ref, ciphertext, wrapped_dek,
// kms_key_ref, fingerprint. It returns (credential_id uuid, key_version int)
// and always inserts key version 1.
func (b *pgBackend) CreateCredential(ctx context.Context, identity workdb.Identity, plan credentialPlan) (credentialResult, error) {
	var result credentialResult
	err := workdb.WithWorkContext(ctx, b.pool, identity, workdb.RoleAPI, workdb.Options{}, func(tx pgx.Tx) error {
		var credentialID string
		var keyVersion int
		if err := tx.QueryRow(ctx, `
			SELECT credential_id::text, key_version
			FROM work.create_provider_credential($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			identity.OrgID,
			identity.SubjectID,
			plan.Provider,
			plan.Mode,
			(*string)(nil), // p_role_ref: NULL for managed_key
			plan.Ciphertext,
			[]byte(nil),    // p_wrapped_dek: NULL = static single layer
			(*string)(nil), // p_kms_key_ref: NULL = static single layer
			plan.Fingerprint,
		).Scan(&credentialID, &keyVersion); err != nil {
			return err
		}
		result = credentialResult{
			CredentialID: credentialID,
			KeyVersion:   keyVersion,
			Fingerprint:  plan.Fingerprint,
		}
		return nil
	})
	if err != nil {
		return credentialResult{}, mapDomainError(err)
	}
	return result, nil
}

// RotateCredential replaces the sealed secret of an active managed_key
// credential. work.rotate_provider_credential owns the new key version; the
// caller never supplies one. wrapped_dek/kms_key_ref stay NULL for the static
// single-layer derivation used by R0a.
func (b *pgBackend) RotateCredential(ctx context.Context, identity workdb.Identity, credentialID string, plan credentialPlan) (credentialResult, error) {
	var keyVersion int
	err := workdb.WithWorkContext(ctx, b.pool, identity, workdb.RoleAPI, workdb.Options{}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT work.rotate_provider_credential($1, $2, $3::uuid, $4, $5, $6, $7)`,
			identity.OrgID,
			identity.SubjectID,
			credentialID,
			plan.Ciphertext,
			[]byte(nil),    // p_wrapped_dek: NULL = static single layer
			(*string)(nil), // p_kms_key_ref: NULL = static single layer
			plan.Fingerprint,
		).Scan(&keyVersion)
	})
	if err != nil {
		return credentialResult{}, mapDomainError(err)
	}
	return credentialResult{
		CredentialID: credentialID,
		KeyVersion:   keyVersion,
		Fingerprint:  plan.Fingerprint,
	}, nil
}

// RevokeCredential makes an active credential unusable. It touches only state
// and the audit trail, so it does not need the credential master key.
func (b *pgBackend) RevokeCredential(ctx context.Context, identity workdb.Identity, credentialID, reason string) error {
	err := workdb.WithWorkContext(ctx, b.pool, identity, workdb.RoleAPI, workdb.Options{}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			SELECT work.revoke_provider_credential($1, $2, $3::uuid, $4)`,
			identity.OrgID,
			identity.SubjectID,
			credentialID,
			reason,
		)
		return err
	})
	return mapDomainError(err)
}

// SetConfig invokes work.get_provider_credential_view to obtain the credential
// mode, then work.set_provider_config as work_api in the same transaction. With
// dryRun the transaction is read-only and no configuration row is written.
func (b *pgBackend) SetConfig(ctx context.Context, identity workdb.Identity, plan configPlan, dryRun bool) (configResult, error) {
	var result configResult
	err := workdb.WithWorkContext(ctx, b.pool, identity, workdb.RoleAPI, workdb.Options{ReadOnly: dryRun}, func(tx pgx.Tx) error {
		var mode string
		if err := tx.QueryRow(ctx, `
			SELECT mode
			FROM work.get_provider_credential_view($1, $2, $3::uuid)`,
			identity.OrgID, identity.SubjectID, plan.CredentialID,
		).Scan(&mode); err != nil {
			return err
		}
		result.CredentialMode = mode
		if dryRun {
			return nil
		}

		var configID string
		var revision int64
		var expectedRevision *int64 // NULL: no optimistic revision check
		if err := tx.QueryRow(ctx, `
			SELECT config_id::text, revision
			FROM work.set_provider_config($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9)`,
			identity.OrgID,
			identity.SubjectID,
			plan.Provider,
			plan.Model,
			plan.Region,
			plan.Endpoint,
			mode,
			plan.CredentialID,
			expectedRevision,
		).Scan(&configID, &revision); err != nil {
			return err
		}
		result.ConfigID = configID
		result.Revision = revision
		return nil
	})
	if err != nil {
		return configResult{}, mapDomainError(err)
	}
	return result, nil
}

// ResolveProvider reads through internal/providerctx, whose only path is
// work.resolve_provider_context (granted to work_worker) plus
// credentials.Open for managed_key.
func (b *pgBackend) ResolveProvider(ctx context.Context, orgID string) (providerctx.Context, error) {
	resolver := &providerctx.Resolver{Pool: b.pool, Master: b.master}
	return resolver.Resolve(ctx, orgID)
}

type commandError struct {
	Code string
}

func (e *commandError) Error() string { return e.Code }

func codeError(code string) error { return &commandError{Code: code} }

func mapPoolError(err error) error {
	var dbErr *workdb.Error
	if errors.As(err, &dbErr) && dbErr != nil {
		switch dbErr.Code {
		case "database_url_required", "database_url_invalid":
			return codeError("database_url_invalid")
		}
	}
	// Do not expose the DSN or the driver error, either of which may contain
	// connection details.
	return codeError("database_connection_failed")
}

// safeDomainCodes are the only function-produced texts this command will print.
// PostgreSQL exception detail, constraints, and cursor text are never included.
var safeDomainCodes = map[string]struct{}{
	"actor_mismatch":                  {},
	"owner_access_denied":             {},
	"provider_credential_exists":      {},
	"provider_credential_revoked":     {},
	"provider_credential_mismatch":    {},
	"not_found":                       {},
	"revision_conflict":               {},
	"invalid_request:provider":        {},
	"invalid_request:credential":      {},
	"invalid_request:credential_mode": {},
	"invalid_request:fingerprint":     {},
	"invalid_request:provider_config": {},
	"invalid_request:reason":          {},
}

func mapDomainError(err error) error {
	if err == nil {
		return nil
	}
	var coded *commandError
	if errors.As(err, &coded) && coded != nil {
		return coded
	}

	var dbErr *workdb.Error
	if errors.As(err, &dbErr) && dbErr != nil {
		switch dbErr.Code {
		case "invalid_identity", "invalid_role", "pool_required", "callback_required",
			"begin_failed", "context_setup_failed", "context_reset_failed", "commit_failed":
			return codeError(dbErr.Code)
		}
		return codeError("provider_write_failed")
	}

	if errors.Is(err, pgx.ErrNoRows) {
		return codeError("not_found")
	}

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr != nil {
		if _, ok := safeDomainCodes[pgErr.Message]; ok {
			return codeError(pgErr.Message)
		}
		switch pgErr.Code {
		case "23503":
			return codeError("org_not_found")
		case "42501":
			return codeError("access_denied")
		case "40001":
			return codeError("revision_conflict")
		case "P0002":
			return codeError("not_found")
		}
	}
	return codeError("provider_write_failed")
}
