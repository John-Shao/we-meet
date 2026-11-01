package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

const AdminProviderConfigPath = "/work/v1/admin/provider-config"

var errProviderConfigMissing = errors.New("provider_config_missing")

type providerCredentialView struct {
	CredentialID string `json:"credential_id"`
	Provider     string `json:"provider"`
	Mode         string `json:"mode"`
	Fingerprint  string `json:"fingerprint"`
	KeyVersion   int    `json:"key_version"`
	State        string `json:"state"`
	CreatedAt    string `json:"created_at"`
}

type providerConfigView struct {
	ConfigID       string                  `json:"config_id"`
	Revision       int64                   `json:"revision"`
	Provider       string                  `json:"provider"`
	Model          string                  `json:"model"`
	Region         string                  `json:"region"`
	Endpoint       string                  `json:"endpoint"`
	CredentialMode string                  `json:"credential_mode"`
	Credential     *providerCredentialView `json:"credential"`
	State          string                  `json:"state"`
	CreatedAt      string                  `json:"created_at"`
}

// readProviderConfig runs inside the work_api session context. Both functions
// re-assert org ownership in SQL, so the handler never trusts the token role.
func readProviderConfig(r *http.Request, tx pgx.Tx, orgID, subjectID string) (*providerConfigView, error) {
	var (
		view        providerConfigView
		credential  providerCredentialView
		createdAt   time.Time
		credCreated time.Time
	)
	err := tx.QueryRow(r.Context(), `
		SELECT config_id::text, revision, provider, model,
		       COALESCE(region, ''), COALESCE(endpoint, ''),
		       credential_mode, credential_id::text, state, created_at
		FROM work.get_provider_config($1, $2)`,
		orgID, subjectID,
	).Scan(&view.ConfigID, &view.Revision, &view.Provider, &view.Model,
		&view.Region, &view.Endpoint, &view.CredentialMode,
		&credential.CredentialID, &view.State, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errProviderConfigMissing
	}
	if err != nil {
		return nil, err
	}
	view.CreatedAt = createdAt.UTC().Format(time.RFC3339)

	err = tx.QueryRow(r.Context(), `
		SELECT provider, mode, COALESCE(fingerprint, ''), key_version, state, created_at
		FROM work.get_provider_credential_view($1, $2, $3::uuid)`,
		orgID, subjectID, credential.CredentialID,
	).Scan(&credential.Provider, &credential.Mode, &credential.Fingerprint,
		&credential.KeyVersion, &credential.State, &credCreated)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err == nil {
		credential.CreatedAt = credCreated.UTC().Format(time.RFC3339)
		view.Credential = &credential
		return &view, nil
	}
	// A config row without a readable credential is refused rather than shown
	// with a half-filled nested object: the contract requires the credential.
	return nil, errProviderConfigMissing
}

func (s *Server) adminProviderConfig(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var view *providerConfigView
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var err error
			view, err = readProviderConfig(r, tx, claims.OrgID, claims.SubjectID)
			return err
		},
	)
	if err != nil {
		if errors.Is(err, errProviderConfigMissing) {
			writeAPIError(w, correlationID, apierr.New("not_found"))
			return
		}
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
