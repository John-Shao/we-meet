package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/host"
)

const (
	LocalTaskPreviewsPath = "/work/v2/local-task-previews"
	localPreviewTTL       = 120 * time.Second
)

var (
	localPreviewDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	localPreviewUintPattern   = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
)

type localPreviewGrant struct {
	GrantID       string `json:"grant_id"`
	GrantRevision string `json:"grant_revision"`
}

type localPreviewTarget struct {
	Kind             string              `json:"kind"`
	ProfileID        string              `json:"profile_id"`
	ProfileRevision  string              `json:"profile_revision"`
	ProfileHash      string              `json:"profile_hash"`
	DeviceID         string              `json:"device_id"`
	SessionID        string              `json:"session_id"`
	WorkspaceGrants  []localPreviewGrant `json:"workspace_grants"`
	RuntimeDigest    string              `json:"runtime_digest"`
	ToolManifestHash string              `json:"tool_manifest_hash"`
	ModelVersion     string              `json:"model_version"`
}

type localPreviewRequest struct {
	ClientRequestID string             `json:"client_request_id"`
	InputRef        string             `json:"input_ref"`
	InputHash       string             `json:"input_hash"`
	InputBytes      int64              `json:"input_bytes"`
	TargetSelection localPreviewTarget `json:"target_selection"`
	TemplateID      string             `json:"template_id"`
	TemplateVersion int                `json:"template_version"`
	PermissionMode  string             `json:"permission_mode"`
	OutputFormat    string             `json:"output_format"`
}

type localPreviewClaims struct {
	OrgID           string             `json:"org_id"`
	SubjectID       string             `json:"subject_id"`
	AuthEpoch       string             `json:"auth_epoch"`
	InputRef        string             `json:"input_ref"`
	InputHash       string             `json:"input_hash"`
	InputBytes      int64              `json:"input_bytes"`
	TargetSelection localPreviewTarget `json:"target_selection"`
	TargetHash      string             `json:"target_selection_hash"`
	TemplateID      string             `json:"template_id"`
	TemplateVersion int                `json:"template_version"`
	TemplateHash    string             `json:"template_hash"`
	PermissionMode  string             `json:"permission_mode"`
	OutputFormat    string             `json:"output_format"`
	TokenUpperBound int64              `json:"token_upper_bound"`
	ExpiresAtUnix   int64              `json:"exp"`
}

type localPreviewFacts struct {
	AuthEpoch         string `json:"auth_epoch"`
	RuntimeDigest     string `json:"runtime_digest"`
	ProfileID         string `json:"profile_id"`
	RunCapTokens      int64  `json:"run_cap_tokens"`
	ForceAskEach      bool   `json:"force_ask_each"`
	AllowAutoReadonly bool   `json:"allow_auto_readonly"`
}

type localPreviewResponse struct {
	PreviewHash         string    `json:"preview_hash"`
	ExpiresAt           time.Time `json:"expires_at"`
	TargetSelectionHash string    `json:"target_selection_hash"`
	InputRef            string    `json:"input_ref"`
	InputHash           string    `json:"input_hash"`
	InputBytes          int64     `json:"input_bytes"`
	Template            Template  `json:"template"`
	PermissionMode      string    `json:"permission_mode"`
	OutputFormat        string    `json:"output_format"`
	OutputLocation      string    `json:"output_location"`
	TokenUpperBound     int64     `json:"token_upper_bound"`
}

func (s *Server) createLocalTaskPreview(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	if err := s.requireWriter(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	var body localPreviewRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	template, ok := templateByID(body.TemplateID)
	if !ok || template.Version != body.TemplateVersion {
		writeAPIError(w, correlationID, apierr.New("preview_stale"))
		return
	}
	if body.PermissionMode != "ask_each" && body.PermissionMode != "auto_readonly" {
		writeAPIError(w, correlationID, apierr.New("permission_mode_unavailable"))
		return
	}
	if body.OutputFormat != "text/plain" && body.OutputFormat != "text/markdown" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if err := validateLocalPreviewRequest(body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}

	var facts localPreviewFacts
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(), `
				SELECT work.local_preview_facts($1, $2, $3, $4::uuid, $5::uuid,
				  $6::uuid[], $7::text[], $8, $9)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision,
				body.TargetSelection.DeviceID, body.TargetSelection.SessionID,
				grantIDs(body.TargetSelection.WorkspaceGrants), grantRevisions(body.TargetSelection.WorkspaceGrants),
				body.TargetSelection.RuntimeDigest, body.TargetSelection.ProfileID).Scan(&raw); err != nil {
				return err
			}
			return json.Unmarshal(raw, &facts)
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	if facts.ForceAskEach && body.PermissionMode != "ask_each" ||
		body.PermissionMode == "auto_readonly" && !facts.AllowAutoReadonly {
		writeAPIError(w, correlationID, apierr.New("permission_mode_unavailable"))
		return
	}
	targetHash, err := localTargetHash(body.TargetSelection)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	now := s.csrf.now()
	previewClaims := localPreviewClaims{
		OrgID: claims.OrgID, SubjectID: claims.SubjectID, AuthEpoch: facts.AuthEpoch,
		InputRef: body.InputRef, InputHash: body.InputHash, InputBytes: body.InputBytes, TargetSelection: body.TargetSelection,
		TargetHash: targetHash, TemplateID: template.ID, TemplateVersion: template.Version,
		TemplateHash: template.ContentHash, PermissionMode: body.PermissionMode,
		OutputFormat: body.OutputFormat, TokenUpperBound: facts.RunCapTokens, ExpiresAtUnix: now.Add(localPreviewTTL).Unix(),
	}
	token, err := s.signLocalPreview(previewClaims)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	writeJSON(w, http.StatusOK, localPreviewResponse{
		PreviewHash: token, ExpiresAt: now.Add(localPreviewTTL), TargetSelectionHash: targetHash,
		InputRef: body.InputRef, InputHash: body.InputHash, InputBytes: body.InputBytes, Template: template,
		PermissionMode: body.PermissionMode, OutputFormat: body.OutputFormat,
		OutputLocation: "device_local", TokenUpperBound: facts.RunCapTokens,
	})
}

func validateLocalPreviewRequest(body localPreviewRequest) error {
	if !validClientRequestID(body.ClientRequestID) || !validUUID(body.InputRef) ||
		!localPreviewDigestPattern.MatchString(body.InputHash) || body.InputBytes < 1 || body.InputBytes > 64*1024 ||
		body.TargetSelection.Kind != "local" ||
		!validUUID(body.TargetSelection.DeviceID) || !validUUID(body.TargetSelection.SessionID) ||
		body.TargetSelection.ProfileID == "" || len(body.TargetSelection.ProfileID) > 128 ||
		strings.TrimSpace(body.TargetSelection.ProfileID) != body.TargetSelection.ProfileID ||
		!localPreviewUintPattern.MatchString(body.TargetSelection.ProfileRevision) ||
		!localPreviewDigestPattern.MatchString(body.TargetSelection.ProfileHash) ||
		!localPreviewDigestPattern.MatchString(body.TargetSelection.RuntimeDigest) ||
		!localPreviewDigestPattern.MatchString(body.TargetSelection.ToolManifestHash) ||
		body.TargetSelection.ModelVersion == "" || len(body.TargetSelection.ModelVersion) > 128 ||
		len(body.TargetSelection.WorkspaceGrants) < 1 || len(body.TargetSelection.WorkspaceGrants) > 4 {
		return errors.New("invalid local preview request")
	}
	seen := make(map[string]struct{}, len(body.TargetSelection.WorkspaceGrants))
	for _, grant := range body.TargetSelection.WorkspaceGrants {
		if !validUUID(grant.GrantID) || !localPreviewUintPattern.MatchString(grant.GrantRevision) {
			return errors.New("invalid local preview grant")
		}
		if _, duplicate := seen[grant.GrantID]; duplicate {
			return errors.New("duplicate local preview grant")
		}
		seen[grant.GrantID] = struct{}{}
	}
	return nil
}

func grantIDs(grants []localPreviewGrant) []string {
	ids := make([]string, len(grants))
	for i, grant := range grants {
		ids[i] = grant.GrantID
	}
	return ids
}

func grantRevisions(grants []localPreviewGrant) []string {
	revisions := make([]string, len(grants))
	for i, grant := range grants {
		revisions[i] = grant.GrantRevision
	}
	return revisions
}

func localTargetHash(target localPreviewTarget) (string, error) {
	raw, err := json.Marshal(target)
	if err != nil {
		return "", err
	}
	canonical, err := devicesig.Canonicalize(raw)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func (s *Server) signLocalPreview(claims localPreviewClaims) (string, error) {
	body, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	payload := "lp1." + base64.RawURLEncoding.EncodeToString(body)
	return payload + "." + s.csrf.sign(payload), nil
}

func (s *Server) verifyLocalPreview(token string, caller host.Claims) (localPreviewClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "lp1" {
		return localPreviewClaims{}, errors.New("invalid local preview")
	}
	payload := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(parts[2]), []byte(s.csrf.sign(payload))) {
		return localPreviewClaims{}, errors.New("invalid local preview signature")
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return localPreviewClaims{}, err
	}
	var claims localPreviewClaims
	if err := json.Unmarshal(body, &claims); err != nil {
		return localPreviewClaims{}, err
	}
	if claims.OrgID != caller.OrgID ||
		claims.SubjectID != caller.SubjectID || claims.AuthEpoch != strconv.FormatInt(caller.SessionRevision, 10) {
		return localPreviewClaims{}, errors.New("stale local preview")
	}
	request := localPreviewRequest{
		ClientRequestID: "preview-token", InputRef: claims.InputRef, InputHash: claims.InputHash, InputBytes: claims.InputBytes,
		TargetSelection: claims.TargetSelection, TemplateID: claims.TemplateID,
		TemplateVersion: claims.TemplateVersion, PermissionMode: claims.PermissionMode,
		OutputFormat: claims.OutputFormat,
	}
	if err := validateLocalPreviewRequest(request); err != nil {
		return localPreviewClaims{}, errors.New("invalid local preview claims")
	}
	targetHash, err := localTargetHash(claims.TargetSelection)
	if err != nil || targetHash != claims.TargetHash {
		return localPreviewClaims{}, errors.New("invalid local preview target hash")
	}
	template, ok := templateByID(claims.TemplateID)
	if !ok || template.Version != claims.TemplateVersion || template.ContentHash != claims.TemplateHash {
		return localPreviewClaims{}, errors.New("stale local preview template")
	}
	return claims, nil
}
