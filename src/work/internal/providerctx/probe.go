package providerctx

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/credentials"
	workdb "github.com/we-meet/work/internal/db"
)

// CodeProbeGrantInvalid is the one-shot claim's only failure code: expired, already
// consumed, unknown grant and wrong token all collapse into it so this path cannot be
// used to test whether a grant id exists.
const CodeProbeGrantInvalid = "probe_grant_invalid"

// Probe claims an administration connectivity grant minted by
// work.issue_provider_probe_grant and returns the candidate provider context for it.
//
// It exists because the probe has no configuration row yet: Resolver reads the
// organization's ACTIVE config, and setProviderConfig must not persist anything before
// the gateway has dialled the candidate. Claim and read are one SQL statement, so
// ciphertext leaves the database only for the call that consumed the grant - there is
// deliberately no "resolve a credential by id" entry point in this package.
type Probe struct {
	// Pool must be a work_worker pool: consume_provider_probe_grant is granted to
	// work_worker and nothing else.
	Pool   *pgxpool.Pool
	Master []byte
}

// Claim returns the candidate context. Region and ConfigRevision stay zero: the probe
// produces no dispatch gate, no receipt and therefore no canonical model_request
// document, so there is no revision to render.
func (p *Probe) Claim(ctx context.Context, orgID, grantID, tokenHash string) (Context, error) {
	if p == nil || p.Pool == nil {
		return Context{}, codeError(CodeProviderContextUnavailable)
	}
	var (
		provider, model, endpoint, mode string
		secretCiphertext, wrappedDEK    []byte
		kmsKeyRef                       *string
		fingerprint                     string
	)
	err := workdb.WithWorkerOrgContext(ctx, p.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT provider, model, endpoint, credential_mode, secret_ciphertext,
			       wrapped_dek, kms_key_ref, secret_fingerprint
			FROM work.consume_provider_probe_grant($1, $2::uuid, $3)`,
			orgID, grantID, tokenHash,
		).Scan(&provider, &model, &endpoint, &mode,
			&secretCiphertext, &wrappedDEK, &kmsKeyRef, &fingerprint)
	})
	if err != nil {
		return Context{}, probeError(err)
	}
	// The same rule the active-config resolver applies: a KMS envelope row is refused
	// rather than silently treated as the single-layer form this package can decrypt.
	if len(wrappedDEK) > 0 || (kmsKeyRef != nil && *kmsKeyRef != "") {
		return Context{}, codeError(CodeProviderContextUnsupported)
	}
	plaintext, err := credentials.Open(p.Master, orgID, secretCiphertext)
	if err != nil {
		// credentials.Open deliberately cannot distinguish short input, a foreign
		// organization and tampered bytes, and neither can this error.
		return Context{}, codeError(CodeProviderContextUnavailable)
	}
	return Context{
		Provider: provider,
		Model:    model,
		Endpoint: endpoint,
		Mode:     mode,
		Secret:   plaintext,
	}, nil
}

func probeError(err error) error {
	var typed *Error
	if errors.As(err, &typed) {
		return typed
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Message == CodeProbeGrantInvalid {
		return codeError(CodeProbeGrantInvalid)
	}
	// A missing row is the claim losing the race, not a different answer.
	if errors.Is(err, pgx.ErrNoRows) {
		return codeError(CodeProbeGrantInvalid)
	}
	return codeError(CodeProviderContextUnavailable)
}
