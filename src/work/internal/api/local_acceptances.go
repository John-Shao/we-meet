package api

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

// The local acceptance face (control-design §1.4 row 74, §7.1; device §7.3). A Bearer-plane
// route: the desktop confirms adoption of a specific published local version, binding a
// PossessionProof(purpose=accept) signed by the active device session. The SQL (0045
// accept_local_task) owns the closed 15-key proof set, the epoch/device/session checks, the
// single-use nonce, the Task-level quiescence gate and the version/hash binding; the 0021
// BEFORE INSERT trigger still raises acceptance_blocked_unresolvable. The handler enforces
// transport bounds only. This face is version-based: reason-only completion ("用户理由完成
// 不计成果采纳") stays on the R0a cookie-plane accept_task and cannot carry a PossessionProof.
const LocalTaskAcceptancesPath = "/work/v2/tasks/{taskId}/acceptances"

type localAcceptanceRequest struct {
	ClientRequestID  string          `json:"client_request_id"`
	ExpectedRevision *int64          `json:"revision"`
	DeviceID         string          `json:"device_id"`
	SessionID        string          `json:"session_id"`
	ArtifactID       string          `json:"artifact_id"`
	PossessionProof  json.RawMessage `json:"possession_proof"`
}

func (s *Server) createLocalAcceptance(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	taskID := r.PathValue("taskId")
	if !validUUID(taskID) {
		writeAPIError(w, correlationID, apierr.New("task_not_found"))
		return
	}
	var body localAcceptanceRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !validClientRequestID(body.ClientRequestID) || body.ExpectedRevision == nil ||
		*body.ExpectedRevision < 0 || !validUUID(body.DeviceID) ||
		!validUUID(body.SessionID) || !validUUID(body.ArtifactID) {
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
				`SELECT work.accept_local_task($1, $2, 'bearer', $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::uuid, $10::jsonb)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision,
				body.DeviceID, body.SessionID, taskID, body.ClientRequestID,
				*body.ExpectedRevision, body.ArtifactID, jwkArg(body.PossessionProof),
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