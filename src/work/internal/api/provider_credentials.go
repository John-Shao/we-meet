package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	"github.com/we-meet/work/internal/credentials"
	workdb "github.com/we-meet/work/internal/db"
)

const (
	AdminProviderCredentialsPath      = "/work/v1/admin/provider-credentials"
	AdminProviderCredentialRotatePath = AdminProviderCredentialsPath + "/{credentialId}/rotate"
	AdminProviderCredentialRevokePath = AdminProviderCredentialsPath + "/{credentialId}/revoke"
)

// minProviderAPIKeyBytes mirrors ProviderCredentialCreateRequest's api_key
// minLength, which the domain function does not re-check because it only ever
// sees ciphertext.
const minProviderAPIKeyBytes = 8

type providerCredentialCreateRequest struct {
	Provider string  `json:"provider"`
	Mode     string  `json:"mode"`
	RoleRef  *string `json:"role_ref"`
	APIKey   *string `json:"api_key"`
}

type providerCredentialRotateRequest struct {
	APIKey *string `json:"api_key"`
}

// readProviderCredentialView re-reads the row the domain function just wrote so the
// response is the stored state rather than an echo of the request. get_provider_credential_view
// re-asserts org ownership, and it is the only place the fingerprint comes from: the
// plaintext never leaves the seal call.
func readProviderCredentialView(
	ctx context.Context,
	tx pgx.Tx,
	orgID, subjectID, credentialID string,
) (providerCredentialView, error) {
	var (
		view      providerCredentialView
		createdAt time.Time
	)
	err := tx.QueryRow(ctx, `
		SELECT credential_id::text, provider, mode, COALESCE(fingerprint, ''),
		       key_version, state, created_at
		FROM work.get_provider_credential_view($1, $2, $3::uuid)`,
		orgID, subjectID, credentialID,
	).Scan(&view.CredentialID, &view.Provider, &view.Mode, &view.Fingerprint,
		&view.KeyVersion, &view.State, &createdAt)
	if err != nil {
		return providerCredentialView{}, err
	}
	view.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	return view, nil
}

// sealProviderAPIKey turns a submitted key into the single-layer sealed form the
// resolver accepts. work.create_provider_credential also carries reserved
// wrapped_dek/kms_key_ref columns; they stay NULL because providerctx refuses an
// envelope row as provider_context_unsupported rather than treating it as this form.
func (s *Server) sealProviderAPIKey(orgID, plaintext string) ([]byte, string, error) {
	if s.providerMaster == nil {
		return nil, "", errors.New("provider credential master key is not configured")
	}
	return credentials.Seal(s.providerMaster, orgID, []byte(plaintext))
}

func (s *Server) createProviderCredential(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	var body providerCredentialCreateRequest
	if err := decodeStrictJSONBody(r.Body, &body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	provider := strings.TrimSpace(body.Provider)
	mode := strings.TrimSpace(body.Mode)
	if provider == "" || mode == "" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	// ProviderCredentialCreateRequest lists sts_role, but work.create_provider_credential
	// requires an 8..64 character secret fingerprint for every mode and an assumed-role
	// credential has no secret to fingerprint. This is the same refusal
	// work-provider-setup documents, so it surfaces as invalid_request rather than
	// storing a fingerprint that stands for no key.
	if mode != "managed_key" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if body.APIKey == nil || body.RoleRef != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	plaintext := strings.TrimSpace(*body.APIKey)
	if len(plaintext) < minProviderAPIKeyBytes {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	ciphertext, fingerprint, err := s.sealProviderAPIKey(claims.OrgID, plaintext)
	if err != nil {
		s.logInternal(correlationID, apierr.New("service_degraded"))
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}

	var view providerCredentialView
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var credentialID string
			var keyVersion int
			if err := tx.QueryRow(r.Context(), `
				SELECT credential_id::text, key_version
				FROM work.create_provider_credential($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				claims.OrgID, claims.SubjectID, provider, mode,
				(*string)(nil), // p_role_ref: managed_key carries no role
				ciphertext,
				[]byte(nil),    // p_wrapped_dek: NULL = static single layer
				(*string)(nil), // p_kms_key_ref: NULL = static single layer
				fingerprint,
			).Scan(&credentialID, &keyVersion); err != nil {
				return err
			}
			var err error
			view, err = readProviderCredentialView(r.Context(), tx, claims.OrgID, claims.SubjectID, credentialID)
			return err
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) rotateProviderCredential(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	var body providerCredentialRotateRequest
	if err := decodeStrictJSONBody(r.Body, &body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if body.APIKey == nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	plaintext := strings.TrimSpace(*body.APIKey)
	if len(plaintext) < minProviderAPIKeyBytes {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	credentialID := strings.TrimSpace(r.PathValue("credentialId"))
	if credentialID == "" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	ciphertext, fingerprint, err := s.sealProviderAPIKey(claims.OrgID, plaintext)
	if err != nil {
		s.logInternal(correlationID, apierr.New("service_degraded"))
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}

	var view providerCredentialView
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var keyVersion int
			if err := tx.QueryRow(r.Context(),
				`SELECT work.rotate_provider_credential($1, $2, $3::uuid, $4, $5, $6, $7)`,
				claims.OrgID, claims.SubjectID, credentialID,
				ciphertext,
				[]byte(nil),    // p_wrapped_dek: NULL = static single layer
				(*string)(nil), // p_kms_key_ref: NULL = static single layer
				fingerprint,
			).Scan(&keyVersion); err != nil {
				return err
			}
			var err error
			view, err = readProviderCredentialView(r.Context(), tx, claims.OrgID, claims.SubjectID, credentialID)
			return err
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// revokeProviderCredential is the credential-level half of D-08b's "revoke at any
// time": unlike rotate it needs no secret, only the audit reason.
func (s *Server) revokeProviderCredential(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	var body providerRevokeRequest
	if err := decodeStrictJSONBody(r.Body, &body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	reason := ""
	if body.Reason != nil {
		reason = strings.TrimSpace(*body.Reason)
	}
	if reason == "" || utf8.RuneCountInString(reason) > 200 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	credentialID := strings.TrimSpace(r.PathValue("credentialId"))
	if credentialID == "" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(),
				`SELECT work.revoke_provider_credential($1, $2, $3::uuid, $4)`,
				claims.OrgID, claims.SubjectID, credentialID, reason)
			return err
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	// ProviderCredentialRevoked allows exactly credential_id and state.
	writeJSON(w, http.StatusOK, map[string]string{
		"credential_id": credentialID,
		"state":         "revoked",
	})
}
