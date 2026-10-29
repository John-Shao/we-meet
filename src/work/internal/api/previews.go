package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
)

const (
	TaskPreviewsPath = "/work/v1/task-previews"
	previewTTL       = 15 * time.Minute
)

type previewClaims struct {
	OrgID           string `json:"org"`
	SubjectID       string `json:"sub"`
	InputID         string `json:"input"`
	InputHash       string `json:"input_hash"`
	InputBytes      int64  `json:"input_bytes"`
	TemplateID      string `json:"template"`
	TemplateVersion int    `json:"template_version"`
	TemplateHash    string `json:"template_hash"`
	PermissionMode  string `json:"mode"`
	TokenUpperBound int64  `json:"token_upper_bound"`
	ExpiresAtUnix   int64  `json:"exp"`
}

type previewRequest struct {
	InputRef       string `json:"input_ref"`
	TemplateID     string `json:"template_id"`
	PermissionMode string `json:"permission_mode"`
}

type previewResponse struct {
	PreviewHash     string    `json:"preview_hash"`
	ExpiresAt       time.Time `json:"expires_at"`
	TokenUpperBound int64     `json:"token_upper_bound"`
	Template        Template  `json:"template"`
	InputRef        string    `json:"input_ref"`
	InputHash       string    `json:"input_hash"`
	InputBytes      int64     `json:"input_bytes"`
}

type submitRequest struct {
	ClientRequestID string `json:"client_request_id"`
	InputRef        string `json:"input_ref"`
	TemplateID      string `json:"template_id"`
	PermissionMode  string `json:"permission_mode"`
	PreviewHash     string `json:"preview_hash"`
}

func (s *Server) createPreview(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	if err := s.requireWriter(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	var body previewRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if !validUUID(body.InputRef) {
		writeAPIError(w, correlationID, apierr.New("input_not_found"))
		return
	}
	template, ok := templateByID(body.TemplateID)
	if !ok {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if body.PermissionMode != "ask_each" && body.PermissionMode != "auto_readonly" {
		writeAPIError(w, correlationID, apierr.New("permission_mode_unavailable"))
		return
	}
	record, policy, err := s.readPreviewInput(r.Context(), claims, body.InputRef, body.PermissionMode, false)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	now := s.csrf.now()
	claimsPayload := previewClaims{
		OrgID: claims.OrgID, SubjectID: claims.SubjectID,
		InputID: body.InputRef, InputHash: record.ContentHash, InputBytes: record.Bytes,
		TemplateID: template.ID, TemplateVersion: template.Version, TemplateHash: template.ContentHash,
		PermissionMode: body.PermissionMode, TokenUpperBound: policy.RunCapTokens,
		ExpiresAtUnix: now.Add(previewTTL).Unix(),
	}
	token, err := s.signPreview(claimsPayload)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	writeJSON(w, http.StatusOK, previewResponse{
		PreviewHash: token, ExpiresAt: now.Add(previewTTL),
		TokenUpperBound: policy.RunCapTokens, Template: template,
		InputRef: body.InputRef, InputHash: record.ContentHash, InputBytes: record.Bytes,
	})
}

func (s *Server) createTask(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	if err := s.requireWriter(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	var body submitRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if len(body.ClientRequestID) < 8 || len(body.ClientRequestID) > 128 ||
		strings.TrimSpace(body.ClientRequestID) != body.ClientRequestID ||
		!validUUID(body.InputRef) {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	preview, err := s.verifyPreview(body.PreviewHash, claims)
	if err != nil || preview.InputID != body.InputRef ||
		preview.TemplateID != body.TemplateID || preview.PermissionMode != body.PermissionMode {
		writeAPIError(w, correlationID, apierr.New("preview_stale"))
		return
	}
	record, _, err := s.readPreviewInput(r.Context(), claims, body.InputRef, body.PermissionMode, true)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	if record.ContentHash != preview.InputHash || record.Bytes != preview.InputBytes {
		writeAPIError(w, correlationID, apierr.New("preview_stale"))
		return
	}
	if s.content == nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	plaintext, err := s.content.Get(r.Context(), claims.OrgID, record.ContentRef)
	if err != nil {
		s.logger.Printf("work api content read failure correlation_id=%s", correlationID)
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	var input struct {
		Goal       string `json:"goal"`
		Background string `json:"background"`
	}
	if err := json.Unmarshal(plaintext, &input); err != nil || strings.TrimSpace(input.Goal) == "" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	title := truncateRunes(strings.TrimSpace(input.Goal), 20)
	template, _ := templateByID(preview.TemplateID)
	manifest, err := json.Marshal(map[string]any{
		"template": map[string]any{
			"id": template.ID, "version": template.Version, "content_hash": template.ContentHash,
		},
		"input": map[string]any{
			"ref": body.InputRef, "content_hash": record.ContentHash, "bytes": record.Bytes,
		},
		"permission_mode":   preview.PermissionMode,
		"token_upper_bound": preview.TokenUpperBound,
	})
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	manifestDigest := sha256.Sum256(manifest)
	snapshotHash := "sha256:" + hex.EncodeToString(manifestDigest[:])
	modelRoute := `{"provider":"deferred","model":"deferred"}`

	var taskID, runID string
	var revision int64
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT task_id, run_id, revision
				FROM work.submit_task(
					$1::text, $2::text, $3::text, $4::uuid, $5::text, $6::text,
					$7::text, $8::jsonb, $9::text[], $10::jsonb, $11::text, $12::text
				)`,
				claims.OrgID, claims.SubjectID, body.ClientRequestID, body.InputRef,
				title, preview.PermissionMode, snapshotHash, string(manifest),
				[]string{"model_call"}, modelRoute, "", "r0a",
			).Scan(&taskID, &runID, &revision)
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"task_id": taskID, "run_id": runID, "revision": revision,
		"task_state": "open", "display_state": "queued", "input_ref": body.InputRef,
	})
}

type inputRecord struct {
	ContentRef  string
	ContentHash string
	Bytes       int64
}

type policyRecord struct {
	RunCapTokens      int64
	ForceAskEach      bool
	AllowAutoReadonly bool
}

func (s *Server) readPreviewInput(
	ctx context.Context,
	claims host.Claims,
	inputID, permissionMode string,
	allowBound bool,
) (inputRecord, policyRecord, error) {
	var record inputRecord
	var policy policyRecord
	var taskID *string
	var expiresAt *time.Time
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT i.content_ref, i.content_hash, i.bytes, i.task_id, i.expires_at,
				       p.run_cap_tokens, p.force_ask_each, p.allow_auto_readonly
				FROM work.input_object i
				JOIN work.org_policy p ON p.org_id = i.org_id
				WHERE i.id = $1 AND i.org_id = $2 AND i.subject_id = $3 AND i.status = 'active'`,
				inputID, claims.OrgID, claims.SubjectID,
			).Scan(&record.ContentRef, &record.ContentHash, &record.Bytes, &taskID,
				&expiresAt, &policy.RunCapTokens, &policy.ForceAskEach, &policy.AllowAutoReadonly)
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return inputRecord{}, policyRecord{}, &domainError{code: "input_not_found"}
	}
	if err != nil {
		return inputRecord{}, policyRecord{}, err
	}
	if (!allowBound && taskID != nil) || expiresAt == nil || !expiresAt.After(s.csrf.now()) {
		return inputRecord{}, policyRecord{}, &domainError{code: "input_not_found"}
	}
	if policy.ForceAskEach && permissionMode != "ask_each" ||
		permissionMode == "auto_readonly" && !policy.AllowAutoReadonly {
		return inputRecord{}, policyRecord{}, &domainError{code: "permission_mode_unavailable"}
	}
	return record, policy, nil
}

func (s *Server) signPreview(claims previewClaims) (string, error) {
	body, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	payload := "p1." + base64.RawURLEncoding.EncodeToString(body)
	return payload + "." + s.csrf.sign(payload), nil
}

func (s *Server) verifyPreview(token string, claims host.Claims) (previewClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "p1" {
		return previewClaims{}, errors.New("invalid preview")
	}
	payload := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(parts[2]), []byte(s.csrf.sign(payload))) {
		return previewClaims{}, errors.New("invalid preview signature")
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return previewClaims{}, err
	}
	var preview previewClaims
	if err := json.Unmarshal(body, &preview); err != nil {
		return previewClaims{}, err
	}
	if preview.ExpiresAtUnix <= s.csrf.now().Unix() ||
		preview.OrgID != claims.OrgID || preview.SubjectID != claims.SubjectID {
		return previewClaims{}, errors.New("stale preview")
	}
	return preview, nil
}

func (s *Server) writeAccessError(w http.ResponseWriter, correlationID string, err error) {
	var domain *domainError
	if errors.As(err, &domain) {
		writeAPIError(w, correlationID, apierr.New(domain.code))
		return
	}
	apiError := apierr.FromDB(err)
	s.logInternal(correlationID, apiError)
	writeAPIError(w, correlationID, apiError)
}

func decodeStrictJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}
