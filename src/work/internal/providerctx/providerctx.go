// Package providerctx resolves an organization's active provider access
// configuration and credential for worker callers.
//
// The only read path is work.resolve_provider_context (baseline 0002), which is
// executable by work_worker and by no request-path role. The domain function
// raises provider_not_configured for a missing active configuration or
// credential and provider_credential_revoked for a revoked credential. This
// package reduces every failure to an enumeration code, so database text,
// ciphertext, and plaintext never reach an error value.
//
// managed_key credentials are decrypted with credentials.Open, keyed by the
// organization and the process-supplied master key. sts_role credentials carry
// only RoleRef; this package returns that mode with a nil Secret and the caller
// decides whether STS is supported. Reserved KMS envelope rows (wrapped_dek and
// kms_key_ref both non-NULL) are refused as unsupported instead of being
// silently treated as static single-layer encryption.
package providerctx

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/credentials"
	workdb "github.com/we-meet/work/internal/db"
)

// CompatProfileVersion is the signed compat profile frozen by the R0a
// advance-workflow binding decision D-2 (2026-10-30). A new compat profile is a
// new decision, never a runtime default.
const CompatProfileVersion = "r0a-compat-1"

// Context is a resolved provider target. Secret holds the decrypted managed_key
// plaintext and is always nil for sts_role. String, GoString, and LogValue
// redact Secret; no formatting verb that consults them can print the plaintext.
type Context struct {
	Provider string
	Model    string
	Region   string
	Endpoint string
	Mode     string
	RoleRef  string
	// ConfigRevision is work.provider_access_config.revision for the active
	// configuration: a positive, per-organization monotonic bigint.
	ConfigRevision int64
	Secret         []byte
}

// Route is the frozen model route of one intent. ConfigRevision is rendered as
// the decimal string canonical.Route requires.
type Route struct {
	Provider             string
	Model                string
	ConfigRevision       string
	CompatProfileVersion string
}

// String formats the context with Secret redacted so logs and fmt verbs cannot
// leak plaintext.
func (c Context) String() string {
	return fmt.Sprintf(
		"providerctx.Context{provider=%q, model=%q, region=%q, endpoint=%q, mode=%q, role_ref=%q, config_revision=%d, secret=<redacted>}",
		c.Provider, c.Model, c.Region, c.Endpoint, c.Mode, c.RoleRef, c.ConfigRevision,
	)
}

// GoString formats %#v with Secret redacted.
func (c Context) GoString() string { return c.String() }

// LogValue emits a slog group with Secret redacted.
func (c Context) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("provider", c.Provider),
		slog.String("model", c.Model),
		slog.String("region", c.Region),
		slog.String("endpoint", c.Endpoint),
		slog.String("mode", c.Mode),
		slog.String("role_ref", c.RoleRef),
		slog.Int64("config_revision", c.ConfigRevision),
		slog.String("secret", "<redacted>"),
	)
}

// Error is an enumerated provider-context failure. Code is the only detail
// this package exposes.
type Error struct {
	Code string
}

func (e *Error) Error() string { return "providerctx: " + e.Code }

// Is matches another enumerated error by code.
func (e *Error) Is(target error) bool {
	other, ok := target.(*Error)
	return ok && other != nil && e != nil && other.Code == e.Code
}

// Enumeration codes. They are the only failure detail Resolve exposes.
const (
	CodeProviderNotConfigured      = "provider_not_configured"
	CodeProviderCredentialRevoked  = "provider_credential_revoked"
	CodeProviderContextUnavailable = "provider_context_unavailable"
	CodeProviderContextUnsupported = "provider_context_unsupported"
)

func codeError(code string) *Error { return &Error{Code: code} }

// Resolver resolves provider context through the worker-only domain function.
// Pool must be a work_worker pool. Master is the 32-byte provider credential
// master key from the process environment; it is only used for managed_key.
type Resolver struct {
	Pool   *pgxpool.Pool
	Master []byte
}

// Resolve returns the organization's active provider context. managed_key
// secrets are decrypted and returned as Secret; sts_role returns Mode and
// RoleRef with a nil Secret. All failures are enumeration codes.
func (r *Resolver) Resolve(ctx context.Context, orgID string) (Context, error) {
	if r == nil || r.Pool == nil {
		return Context{}, codeError(CodeProviderContextUnavailable)
	}

	var (
		configID                                string
		provider, model, region, endpoint, mode string
		roleRef                                 *string
		secretCiphertext, wrappedDEK            []byte
		kmsKeyRef                               *string
		revision                                int64
	)
	err := workdb.WithWorkerOrgContext(ctx, r.Pool, orgID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT config_id, provider, model, region, endpoint, credential_mode,
			       role_ref, secret_ciphertext, wrapped_dek, kms_key_ref
			FROM work.resolve_provider_context($1)`,
			orgID,
		).Scan(&configID, &provider, &model, &region, &endpoint, &mode,
			&roleRef, &secretCiphertext, &wrappedDEK, &kmsKeyRef); err != nil {
			return err
		}
		var activeID string
		if err := tx.QueryRow(ctx, `
			SELECT config_id, revision FROM work.read_provider_config_revision($1)`,
			orgID,
		).Scan(&activeID, &revision); err != nil {
			return err
		}
		if activeID != configID {
			return codeError(CodeProviderContextUnavailable)
		}
		return nil
	})
	if err != nil {
		return Context{}, resolveError(err)
	}

	resolved := Context{
		Provider:       provider,
		Model:          model,
		Region:         region,
		Endpoint:       endpoint,
		Mode:           mode,
		ConfigRevision: revision,
	}
	if roleRef != nil {
		resolved.RoleRef = *roleRef
	}

	// The signed profile stores one static layer. A non-NULL KMS envelope is a
	// reserved shape this package must refuse rather than ignore.
	if wrappedDEK != nil || kmsKeyRef != nil {
		return Context{}, codeError(CodeProviderContextUnsupported)
	}

	switch mode {
	case "managed_key":
		if secretCiphertext == nil {
			return Context{}, codeError(CodeProviderContextUnavailable)
		}
		plaintext, err := credentials.Open(r.Master, orgID, secretCiphertext)
		if err != nil {
			return Context{}, codeError(CodeProviderContextUnavailable)
		}
		resolved.Secret = plaintext
		return resolved, nil
	case "sts_role":
		// The caller decides whether STS is supported; no secret is returned.
		return resolved, nil
	default:
		return Context{}, codeError(CodeProviderContextUnsupported)
	}
}

// ResolveRoute returns the frozen route fields an intent names without
// decrypting a credential. Provider and model come from the same active
// configuration as Resolve; the revision is the stored monotonic revision and
// the compat profile is the signed constant.
func (r *Resolver) ResolveRoute(ctx context.Context, orgID string) (Route, error) {
	if r == nil || r.Pool == nil {
		return Route{}, codeError(CodeProviderContextUnavailable)
	}
	var (
		configID        string
		provider, model string
		activeID        string
		configRevision  int64
	)
	err := workdb.WithWorkerOrgContext(ctx, r.Pool, orgID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT config_id, provider, model FROM work.resolve_provider_context($1)`,
			orgID,
		).Scan(&configID, &provider, &model); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			SELECT config_id, revision FROM work.read_provider_config_revision($1)`,
			orgID,
		).Scan(&activeID, &configRevision); err != nil {
			return err
		}
		if activeID != configID {
			return codeError(CodeProviderContextUnavailable)
		}
		return nil
	})
	if err != nil {
		return Route{}, resolveError(err)
	}
	return Route{
		Provider:             provider,
		Model:                model,
		ConfigRevision:       strconv.FormatInt(configRevision, 10),
		CompatProfileVersion: CompatProfileVersion,
	}, nil
}

// resolveError maps a domain-function or transaction failure to an enumeration
// code. It never wraps the original error, so SQLSTATE, exception detail, and
// constraint text cannot reach callers.
func resolveError(err error) error {
	var typed *Error
	if errors.As(err, &typed) {
		return typed
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return codeError(CodeProviderNotConfigured)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Message {
		case CodeProviderNotConfigured:
			return codeError(CodeProviderNotConfigured)
		case CodeProviderCredentialRevoked:
			return codeError(CodeProviderCredentialRevoked)
		}
	}
	return codeError(CodeProviderContextUnavailable)
}
