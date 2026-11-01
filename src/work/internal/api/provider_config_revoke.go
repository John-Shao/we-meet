package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

const AdminProviderConfigRevokePath = AdminProviderConfigPath + "/revoke"

type providerRevokeRequest struct {
	Reason *string `json:"reason"`
}

// adminRevokeProviderConfig stops the organization from starting new model calls
// under its current access config. work.revoke_provider_config is idempotent and
// takes the org lock itself, so a repeated revoke is a 200 rather than an error.
func (s *Server) adminRevokeProviderConfig(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	var body providerRevokeRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
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
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(),
				`SELECT work.revoke_provider_config($1, $2, $3)`,
				claims.OrgID, claims.SubjectID, reason)
			return err
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"org_id": claims.OrgID,
		"state":  "revoked",
	})
}
