package api

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/devicesig"
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

type grantSuccessionProof struct {
	OldGrantID       string `json:"old_grant_id"`
	NewGrantID       string `json:"new_grant_id"`
	RootIdentityHash string `json:"root_identity_hash"`
	RunID            string `json:"run_id"`
	SessionID        string `json:"session_id"`
	AuthPlane        string `json:"auth_plane"`
	AuthEpoch        string `json:"auth_epoch"`
	Nonce            string `json:"nonce"`
	ExpiresAt        string `json:"expires_at"`
	Signature        string `json:"signature"`
}

func parseGrantSuccessionProof(raw json.RawMessage) (grantSuccessionProof, error) {
	var proof grantSuccessionProof
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&proof); err != nil {
		return proof, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return proof, fmt.Errorf("trailing proof data")
	}
	root, err := hex.DecodeString(proof.RootIdentityHash)
	if err != nil || len(root) != 32 || !validUUID(proof.OldGrantID) ||
		!validUUID(proof.NewGrantID) || !validUUID(proof.RunID) || !validUUID(proof.SessionID) ||
		proof.AuthPlane != "bearer" || proof.Nonce == "" || proof.ExpiresAt == "" {
		return proof, fmt.Errorf("invalid proof shape")
	}
	if _, err := strconv.ParseUint(proof.AuthEpoch, 10, 63); err != nil {
		return proof, err
	}
	if _, err := time.Parse(time.RFC3339, proof.ExpiresAt); err != nil {
		return proof, err
	}
	return proof, nil
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
	proof, err := parseGrantSuccessionProof(body.GrantSuccessionProof)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	var pubJWK []byte
	if err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(),
				`SELECT work.workspace_rebind_signing_key($1, $2, $3::uuid, $4::uuid)`,
				claims.OrgID, claims.SubjectID, runID, body.NewGrantID,
			).Scan(&pubJWK)
		},
	); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	pub, err := devicesig.ParseJWK(pubJWK)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if !devicesig.VerifyGrantSuccession(pub, body.GrantSuccessionProof, proof.Signature) {
		writeAPIError(w, correlationID, apierr.New("unauthorized"))
		return
	}
	var view json.RawMessage
	err = workdb.WithWorkContext(r.Context(), s.pool,
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
