package api

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

// The readonly-grant management face (control-design §1.4 row 70, §4.1
// readonly_approval_grant). These are owner-management reads/writes on the cookie
// plane: unlike decide_local_approval the commands take no auth_plane and require
// no device proof, so the owner revokes or reviews a "same-kind readonly" grant
// from the task page like any other R0a owner surface. The SQL enforces ownership
// (only the owner's own Run grants are visible; an administrator may not read on
// their behalf) and the revision CAS.
const (
	ReadonlyGrantsPath      = "/work/v2/readonly-grants"
	ReadonlyGrantRevokePath = "/work/v2/readonly-grants/{grantId}/revoke"
)

type readonlyGrantRevokeRequest struct {
	ClientRequestID  string `json:"client_request_id"`
	ExpectedRevision *int64 `json:"expected_revision"`
}

func (s *Server) listReadonlyGrants(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var runArg any
	if runID := r.URL.Query().Get("run_id"); runID != "" {
		if !validUUID(runID) {
			writeAPIError(w, correlationID, apierr.New("invalid_request"))
			return
		}
		runArg = runID
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.list_readonly_grants($1, $2, $3::uuid)`,
				claims.OrgID, claims.SubjectID, runArg,
			).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) revokeReadonlyGrant(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	grantID := r.PathValue("grantId")
	if !validUUID(grantID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body readonlyGrantRevokeRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if body.ExpectedRevision == nil || *body.ExpectedRevision < 0 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.revoke_readonly_grant($1, $2, $3::uuid, $4, $5)`,
				claims.OrgID, claims.SubjectID, grantID, body.ClientRequestID, *body.ExpectedRevision,
			).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}