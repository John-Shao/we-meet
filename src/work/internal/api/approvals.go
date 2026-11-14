package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

// The local-approval face (control-design §1.4 rows 66-67, §1.2 ApprovalV2).
// Local approvals are device-plane objects: the decision binds an ApprovalDecisionProof
// signed by the device session that carries the current auth_plane/auth_epoch, so the
// whole face authenticates the desktop Bearer plane, never the cookie plane. The reads
// (0044) are owner-scoped definer functions returning the ApprovalV2 summary — no full
// local path or params; the decision (0042) owns the closed proof set, idempotency,
// epoch/CAS checks and the readonly-grant remember path. Handlers enforce transport
// bounds and the key set only.
const (
	ApprovalsPath        = "/work/v2/approvals"
	ApprovalDetailPath   = "/work/v2/approvals/{approvalId}"
	ApprovalDecisionPath = "/work/v2/approvals/{approvalId}/decisions"
)

type approvalDecisionRequest struct {
	ClientRequestID string          `json:"client_request_id"`
	Decision        json.RawMessage `json:"decision"`
}

func (s *Server) listApprovals(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	var statusArg any
	if status := query.Get("status"); status != "" {
		statusArg = status
	}
	var cursorArg any
	if cursor := query.Get("cursor"); cursor != "" {
		cursorArg = cursor
	}
	limitArg := 50
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			writeAPIError(w, correlationID, apierr.New("invalid_request"))
			return
		}
		limitArg = parsed
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.list_local_approvals($1, $2, $3, $4, $5)`,
				claims.OrgID, claims.SubjectID, statusArg, cursorArg, limitArg,
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

func (s *Server) getApproval(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	approvalID := r.PathValue("approvalId")
	if !validUUID(approvalID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.get_local_approval($1, $2, $3::uuid)`,
				claims.OrgID, claims.SubjectID, approvalID,
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

func (s *Server) decideApproval(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	approvalID := r.PathValue("approvalId")
	if !validUUID(approvalID) {
		writeAPIError(w, correlationID, apierr.New("not_found"))
		return
	}
	var body approvalDecisionRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	decisionArg := "null"
	if len(body.Decision) > 0 {
		decisionArg = string(body.Decision)
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.decide_local_approval($1, $2, $3, $4, $5::uuid, $6, $7::jsonb)`,
				claims.OrgID, claims.SubjectID, claims.AuthPlane, claims.SessionRevision,
				approvalID, body.ClientRequestID, decisionArg,
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