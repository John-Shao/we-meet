package api

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

// The workspace-rebind face (control-design §1.4 row 65, §4.2; device §3.5). A Bearer-plane
// route: while a Run waits for re-authorization (waiting/input), the desktop picks a new
// directory grant for the same root identity and signs a GrantSuccessionProof. The SQL
// (0041, restated 0043 with nonce consumption) owns the proof-vs-scalar checks, the
// single-use nonce, the waiting(input) gate, the old-grant-in-binding check and the
// same-device/owner/root_identity_hash equality; a different directory answers
// workspace_identity_changed and the Run can only end. The handler enforces transport
// bounds only. The command returns the new binding_revision offer with 202.
const WorkspaceRebindsPath = "/work/v2/runs/{runId}/workspace-rebinds"

type workspaceRebindRequest struct {
	ClientRequestID      string          `json:"client_request_id"`
	OldGrantID           string          `json:"old_grant_id"`
	NewGrantID           string          `json:"new_grant_id"`
	GrantSuccessionProof json.RawMessage `json:"grant_succession_proof"`
}

func (s *Server) rebindRunWorkspace(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	if !validUUID(runID) {
		writeAPIError(w, correlationID, apierr.New("run_not_found"))
		return
	}
	var body workspaceRebindRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !validClientRequestID(body.ClientRequestID) ||
		!validUUID(body.OldGrantID) || !validUUID(body.NewGrantID) {
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
				`SELECT work.rebind_run_workspace($1, $2, 'bearer', $3, $4::uuid, $5, $6::uuid, $7::uuid, $8::jsonb)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision,
				runID, body.ClientRequestID, body.OldGrantID, body.NewGrantID,
				jwkArg(body.GrantSuccessionProof),
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
	writeJSON(w, http.StatusAccepted, view)
}