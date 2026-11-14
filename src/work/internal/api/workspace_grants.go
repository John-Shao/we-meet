package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

// The workspace-grant face (control-design §1.4 rows 64, device-design §2.4).
// Like the device-identity face these are Bearer-plane routes: the desktop main
// process registers a directory grant on behalf of an active device session. The
// session_id is supplied by the client (the device hello that creates it is the
// wire protocol of device-design §3, not a §1.4 REST endpoint); the SQL verifies
// the session is active, belongs to this owner and device, and matches the bearer
// epoch. Classification is decided by the organization's mapping in SQL, never by
// the device's claim, which is only cross-checked.
const (
	WorkspaceGrantsPath      = "/work/v2/workspace-grants"
	WorkspaceGrantRevokePath = "/work/v2/workspace-grants/{grantId}/revoke"
)

type workspaceGrantRegisterRequest struct {
	DeviceID        string          `json:"device_id"`
	SessionID       string          `json:"session_id"`
	ClientRequestID string          `json:"client_request_id"`
	Grant           json.RawMessage `json:"grant"`
}

type workspaceGrantRevokeRequest struct {
	ClientRequestID string `json:"client_request_id"`
	Reason          string `json:"reason"`
}

func (s *Server) listWorkspaceGrants(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	cursor := query.Get("cursor")
	limit := 50
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			writeAPIError(w, correlationID, apierr.New("invalid_pagination"))
			return
		}
		limit = parsed
	}
	var deviceArg any
	if deviceID := query.Get("device_id"); deviceID != "" {
		if !validUUID(deviceID) {
			writeAPIError(w, correlationID, apierr.New("invalid_request"))
			return
		}
		deviceArg = deviceID
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.list_workspace_grants($1, $2, $3::uuid, $4, $5)`,
				claims.OrgID, claims.SubjectID, deviceArg, cursor, limit,
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

func (s *Server) registerWorkspaceGrant(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	var body workspaceGrantRegisterRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !validUUID(body.DeviceID) || !validUUID(body.SessionID) {
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
				`SELECT work.register_workspace_grant($1, $2, 'bearer', $3, $4::uuid, $5::uuid, $6, $7::jsonb)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision,
				body.DeviceID, body.SessionID, body.ClientRequestID, jwkArg(body.Grant),
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

func (s *Server) revokeWorkspaceGrant(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	grantID := r.PathValue("grantId")
	if !validUUID(grantID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body workspaceGrantRevokeRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.revoke_workspace_grant($1, $2, $3::uuid, $4, $5)`,
				claims.OrgID, claims.SubjectID, grantID, body.ClientRequestID, body.Reason,
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