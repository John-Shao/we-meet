package api

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

// The local user-save face (control-design §1.4 row 73, §7.1). A Bearer-plane route:
// the desktop main process appends a user-saved local version to an artifact, binding a
// UserVersionProof signed by the active device session. The SQL (0043
// create_local_user_artifact_version) owns the closed 21-key proof set, the epoch/CAS and
// nonce checks, the base-version reconciliation and classification floor; the handler
// enforces transport bounds and the kind gate only. R0b opens kind=local alone — kind=cloud
// stays on the R0a create_user_artifact_version path and is refused here with 422.
const LocalArtifactVersionsPath = "/work/v2/artifacts/{artifactId}/versions"

type localArtifactVersionRequest struct {
	Kind             string          `json:"kind"`
	ClientRequestID  string          `json:"client_request_id"`
	DeviceID         string          `json:"device_id"`
	SessionID        string          `json:"session_id"`
	LocalRef         string          `json:"local_ref"`
	UserVersionProof json.RawMessage `json:"user_version_proof"`
}

func (s *Server) createLocalArtifactVersion(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	artifactID := r.PathValue("artifactId")
	if !validUUID(artifactID) {
		writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
		return
	}
	var body localArtifactVersionRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if body.Kind == "cloud" {
		writeAPIError(w, correlationID, apierr.New("output_unsupported"))
		return
	}
	if body.Kind != "local" || !validClientRequestID(body.ClientRequestID) ||
		!validUUID(body.DeviceID) || !validUUID(body.SessionID) {
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
				`SELECT work.create_local_user_artifact_version($1, $2, 'bearer', $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::jsonb)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision,
				body.DeviceID, body.SessionID, artifactID, body.ClientRequestID,
				body.LocalRef, jwkArg(body.UserVersionProof),
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
	writeJSON(w, http.StatusCreated, view)
}