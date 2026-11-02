package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/egressclient"
	"github.com/we-meet/work/internal/providerctx"
)

// probeGrantTTL bounds how long a minted grant stays spendable. It covers one gateway
// round trip and nothing else: a grant that outlives the request that asked for it is a
// standing ability to make the gateway dial a provider.
const probeGrantTTL = 30

// ProviderProber spends one connectivity grant through the egress gateway.
// *egressclient.Client implements it. It is an interface so the control-plane tests can
// assert the save/don't-save decision without a gateway in the loop.
type ProviderProber interface {
	Probe(ctx context.Context, orgID, grantID, token string) (egressclient.Result, error)
}

// SetProviderProber wires the gateway probe. Without it the endpoint fails closed: the
// contract requires a pre-save probe ("失败不生效"), so an unprobed write must not be
// possible just because a deployment forgot to configure one dependency.
func (s *Server) SetProviderProber(prober ProviderProber) { s.prober = prober }

type providerConfigSetRequest struct {
	Provider         string `json:"provider"`
	Model            string `json:"model"`
	Region           string `json:"region"`
	Endpoint         string `json:"endpoint"`
	CredentialMode   string `json:"credential_mode"`
	CredentialID     string `json:"credential_id"`
	ExpectedRevision *int64 `json:"expected_revision"`
}

func (s *Server) adminSetProviderConfig(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	var body providerConfigSetRequest
	if err := decodeStrictJSONBody(r.Body, &body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	// Presence, not a value: ProviderConfigSetRequest lists expected_revision as
	// required and the optimistic-concurrency answer depends on the client having
	// observed a revision (0 for "nothing configured yet").
	if body.ExpectedRevision == nil || *body.ExpectedRevision < 0 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if strings.TrimSpace(body.Provider) == "" || strings.TrimSpace(body.Model) == "" ||
		strings.TrimSpace(body.Region) == "" || !validUUID(body.CredentialID) {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if s.providerMaster == nil {
		s.logInternal(correlationID, apierr.New("service_degraded"))
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}

	token, tokenHash, err := newProbeToken()
	if err != nil {
		s.logInternal(correlationID, apierr.New("service_degraded"))
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	// Never log the request body: it carries an endpoint and a credential reference the
	// organization may treat as sensitive, and the probe answer is what matters here.
	if s.prober == nil {
		s.logInternal(correlationID, apierr.New("service_degraded"))
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}

	var grantID string
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT work.issue_provider_probe_grant($1, $2, $3, $4, $5, $6::uuid, $7, $8)`,
				claims.OrgID, claims.SubjectID, body.Provider, body.Model, body.Endpoint,
				body.CredentialID, tokenHash, probeGrantTTL,
			).Scan(&grantID)
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}

	verdict, err := s.prober.Probe(r.Context(), claims.OrgID, grantID, token)
	switch {
	case errors.Is(err, egressclient.ErrGrantInvalid):
		// The grant is gone or was never ours. This says nothing about the provider, so
		// report it as inconclusive rather than inviting a retry of the whole write.
		s.logInternal(correlationID, apierr.New("service_degraded"))
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	case err != nil:
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	switch verdict.Verdict {
	case egressclient.VerdictOK:
		// fall through to the write below
	case egressclient.VerdictRejected:
		// The gateway reached the provider and was refused: the endpoint and credential
		// exist, but this provider/model pair does not work. That is a semantic refusal,
		// which is exactly what the contract's 422 is for, and nothing is saved.
		writeAPIError(w, correlationID, apierr.New("provider_not_configured"))
		return
	default:
		// unknown or refused: no conclusion about the configuration. Saving would
		// contradict "失败不生效", and reporting it as 422 would blame a provider that
		// may simply be rate limiting us, so it stays a retryable 503.
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}

	var view *providerConfigView
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var configID string
			var revision int64
			if err := tx.QueryRow(r.Context(), `
				SELECT config_id::text, revision
				FROM work.set_provider_config($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9)`,
				claims.OrgID, claims.SubjectID, body.Provider, body.Model, body.Region,
				body.Endpoint, body.CredentialMode, body.CredentialID, *body.ExpectedRevision,
			).Scan(&configID, &revision); err != nil {
				return err
			}
			var err error
			view, err = readProviderConfig(r, tx, claims.OrgID, claims.SubjectID)
			return err
		},
	)
	if err != nil {
		var domain *providerctx.Error
		if errors.As(err, &domain) {
			writeAPIError(w, correlationID, apierr.New(domain.Code))
			return
		}
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// newProbeToken returns the single-use bearer for the gateway and the sha256 hex digest
// stored by work.issue_provider_probe_grant. Only the digest is persisted, so a database
// read cannot replay a live grant.
func newProbeToken() (string, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token := hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(sum[:]), nil
}
