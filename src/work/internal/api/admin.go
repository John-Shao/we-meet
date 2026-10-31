package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

const (
	AdminOverviewPath           = "/work/v1/admin/overview"
	AdminSeatsPath              = "/work/v1/admin/seats"
	AdminAuditExportsPath       = "/work/v1/admin/audit-exports"
	AdminAuditExportPath        = "/work/v1/admin/audit-exports/{exportId}"
	AdminAuditExportTicketPath  = "/work/v1/admin/audit-exports/{exportId}/download-ticket"
	AdminAuditExportContentPath = "/work/v1/admin/audit-exports/{exportId}/content"

	defaultAdminSeatLimit = 20
	maxAdminSeatLimit     = 100
)

type AdminSeat struct {
	SubjectID string `json:"subject_id"`
	Role      string `json:"role"`
	WorkSeat  bool   `json:"work_seat"`
	Status    string `json:"status"`
	Revision  int64  `json:"revision"`
}

type createAuditExportRequest struct {
	ClientRequestID string    `json:"client_request_id"`
	RangeFrom       time.Time `json:"range_from"`
	RangeTo         time.Time `json:"range_to"`
	Format          string    `json:"format"`
}

type auditExportContent struct {
	ExportID    string    `json:"export_id"`
	ContentRef  string    `json:"content_ref"`
	ContentHash string    `json:"content_hash"`
	Bytes       int64     `json:"bytes"`
	RowCount    int64     `json:"row_count"`
	Format      string    `json:"format"`
	ExpiresAt   time.Time `json:"expires_at"`
}

func (s *Server) adminOverview(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var payload []byte
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(),
				`SELECT work.admin_overview($1, $2)`,
				claims.OrgID, claims.SubjectID,
			).Scan(&payload)
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(payload))
}

func (s *Server) adminSeats(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	limit, err := parseAdminSeatLimit(r.URL.Query().Get("limit"))
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_pagination"))
		return
	}
	cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
	if cursor == "" {
		cursor = ""
	}
	var items []AdminSeat
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			rows, err := tx.Query(r.Context(), `
				SELECT subject_id, role, work_seat, status, revision
				FROM work.list_seats($1, $2, NULLIF($3, ''), $4)`,
				claims.OrgID, claims.SubjectID, cursor, limit,
			)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var item AdminSeat
				if err := rows.Scan(&item.SubjectID, &item.Role, &item.WorkSeat, &item.Status, &item.Revision); err != nil {
					return err
				}
				items = append(items, item)
			}
			return rows.Err()
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	var next *string
	if len(items) == limit {
		value := items[len(items)-1].SubjectID
		next = &value
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": next})
}

func (s *Server) createAdminAuditExport(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	var body createAuditExportRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	var payload []byte
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT work.create_audit_export($1, $2, $3, $4, $5, $6)`,
				claims.OrgID, claims.SubjectID, body.ClientRequestID,
				body.RangeFrom, body.RangeTo, body.Format,
			).Scan(&payload)
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusAccepted, json.RawMessage(payload))
}

func (s *Server) getAdminAuditExport(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	exportID := r.PathValue("exportId")
	if !validUUID(exportID) {
		writeAPIError(w, correlationID, apierr.New("audit_export_not_found"))
		return
	}
	var payload []byte
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT work.get_audit_export($1, $2, $3)`,
				claims.OrgID, claims.SubjectID, exportID,
			).Scan(&payload)
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(payload))
}

func (s *Server) issueAdminAuditExportTicket(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	exportID := r.PathValue("exportId")
	if !validUUID(exportID) {
		writeAPIError(w, correlationID, apierr.New("audit_export_not_found"))
		return
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	token := hex.EncodeToString(tokenBytes)
	hash := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hash[:])
	var payload []byte
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT work.issue_audit_export_download($1, $2, $3, $4, $5)`,
				claims.OrgID, claims.SubjectID, exportID, tokenHash, 300,
			).Scan(&payload)
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	var view map[string]any
	if err := json.Unmarshal(payload, &view); err != nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	view["token"] = token
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) downloadAdminAuditExport(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	exportID := r.PathValue("exportId")
	if !validUUID(exportID) {
		writeAPIError(w, correlationID, apierr.New("audit_export_not_found"))
		return
	}
	token := strings.TrimSpace(r.Header.Get("X-Download-Token"))
	if token == "" {
		writeAPIError(w, correlationID, apierr.New("download_token_invalid"))
		return
	}
	hash := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hash[:])
	var payload []byte
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT work.redeem_audit_export_download($1, $2, $3)`,
				claims.OrgID, claims.SubjectID, tokenHash,
			).Scan(&payload)
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	var content auditExportContent
	if err := json.Unmarshal(payload, &content); err != nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	if s.content == nil || content.ContentRef == "" {
		writeJSON(w, http.StatusOK, content)
		return
	}
	data, err := s.content.Get(r.Context(), claims.OrgID, content.ContentRef)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	mediaType := "text/csv; charset=utf-8"
	extension := "csv"
	if content.Format == "json" {
		mediaType = "application/json"
		extension = "json"
	}
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="audit-export-%s.%s"`, exportID, extension))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) writeAdminError(w http.ResponseWriter, correlationID string, err error) {
	var domain *domainError
	if errors.As(err, &domain) {
		writeAPIError(w, correlationID, apierr.New(domain.code))
		return
	}
	apiError := apierr.FromDB(err)
	s.logInternal(correlationID, apiError)
	writeAPIError(w, correlationID, apiError)
}

func parseAdminSeatLimit(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return defaultAdminSeatLimit, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > maxAdminSeatLimit {
		return 0, fmt.Errorf("invalid limit")
	}
	return value, nil
}
