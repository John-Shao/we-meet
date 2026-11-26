package api

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/modelparams"
)

const LocalTasksPath = "/work/v2/tasks"

type localTaskSubmitRequest struct {
	ClientRequestID     string             `json:"client_request_id"`
	InputRef            string             `json:"input_ref"`
	InputHash           string             `json:"input_hash"`
	InputBytes          int64              `json:"input_bytes"`
	PreviewHash         string             `json:"preview_hash"`
	TargetSelectionHash string             `json:"target_selection_hash"`
	Title               string             `json:"title"`
	TargetSelection     localPreviewTarget `json:"target_selection"`
	LocalIntent         json.RawMessage    `json:"local_intent"`
}

func (s *Server) submitLocalTask(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticateBearer(w, r)
	if !ok {
		return
	}
	if err := s.requireWriter(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	var body localTaskSubmitRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, decodeError(err))
		return
	}
	if !validClientRequestID(body.ClientRequestID) || !validUUID(body.InputRef) ||
		!localPreviewDigestPattern.MatchString(body.InputHash) || body.InputBytes < 1 || body.InputBytes > 64*1024 ||
		!localPreviewDigestPattern.MatchString(body.TargetSelectionHash) ||
		strings.TrimSpace(body.Title) != body.Title || len([]rune(body.Title)) < 1 || len([]rune(body.Title)) > 80 ||
		!json.Valid(body.LocalIntent) {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	preview, err := s.verifyLocalPreview(body.PreviewHash, claims)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("preview_stale"))
		return
	}
	if preview.InputRef != body.InputRef || preview.InputHash != body.InputHash || preview.InputBytes != body.InputBytes ||
		preview.TargetHash != body.TargetSelectionHash || !reflect.DeepEqual(preview.TargetSelection, body.TargetSelection) {
		writeAPIError(w, correlationID, apierr.New("preview_stale"))
		return
	}
	proof, err := devicesig.ParseLocalIntentProof(body.LocalIntent)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if proof.OrgID != claims.OrgID || proof.SubjectID != claims.SubjectID ||
		proof.AuthEpoch != strconv.FormatInt(claims.SessionRevision, 10) ||
		proof.RequestID != body.ClientRequestID || proof.InputHash != body.InputHash ||
		proof.PreviewHash != body.PreviewHash || proof.TargetSelectionHash != body.TargetSelectionHash ||
		proof.DeviceID != body.TargetSelection.DeviceID || proof.SessionID != body.TargetSelection.SessionID ||
		proof.ProfileID != body.TargetSelection.ProfileID || proof.ProfileRevision != body.TargetSelection.ProfileRevision ||
		proof.ProfileHash != body.TargetSelection.ProfileHash ||
		!reflect.DeepEqual(proof.SelectedGrantIDs, grantIDs(body.TargetSelection.WorkspaceGrants)) ||
		!reflect.DeepEqual(proof.GrantRevisions, grantRevisions(body.TargetSelection.WorkspaceGrants)) {
		writeAPIError(w, correlationID, apierr.New("unauthorized"))
		return
	}
	var pubJWK []byte
	if err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `SELECT work.device_signing_key($1, $2::uuid)`,
				claims.OrgID, proof.DeviceID).Scan(&pubJWK)
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
	if !devicesig.VerifyLocalIntent(pub, body.LocalIntent) {
		writeAPIError(w, correlationID, apierr.New("unauthorized"))
		return
	}
	template, ok := templateByID(preview.TemplateID)
	if !ok || template.Version != preview.TemplateVersion || template.ContentHash != preview.TemplateHash {
		writeAPIError(w, correlationID, apierr.New("preview_stale"))
		return
	}
	manifest, err := json.Marshal(map[string]any{
		"template": map[string]any{
			"id": template.ID, "version": template.Version, "content_hash": template.ContentHash,
		},
		"input": map[string]any{
			"ref": body.InputRef, "content_hash": body.InputHash, "bytes": body.InputBytes,
		},
		"target_selection":  body.TargetSelection,
		"permission_mode":   preview.PermissionMode,
		"output_format":     preview.OutputFormat,
		"token_upper_bound": preview.TokenUpperBound,
		"parameters":        modelparams.Manifest(),
	})
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	modelRoute := `{"provider":"device_local","model":` + strconv.Quote(body.TargetSelection.ModelVersion) + `}`
	targetJSON, err := json.Marshal(body.TargetSelection)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	var view json.RawMessage
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(), `
				SELECT jsonb_build_object(
				  'task_id', task_id, 'run_id', run_id, 'revision', revision,
				  'binding_revision', binding_revision, 'task_state', 'open',
				  'display_state', 'queued', 'input_ref', $5)
				FROM work.submit_local_task($1, $2, $3, $4, $5::uuid, $6, $7, $8, $9::timestamptz,
				  $10, $11, $12, $13::jsonb, $14::text[], $15::jsonb, $16::jsonb, $17::jsonb)`,
				claims.OrgID, claims.SubjectID, claims.SessionRevision, body.ClientRequestID,
				body.InputRef, body.InputHash, body.InputBytes, body.PreviewHash, time.Unix(preview.ExpiresAtUnix, 0),
				body.TargetSelectionHash, body.Title, preview.PermissionMode, string(manifest), []string{"model_call"}, modelRoute,
				string(targetJSON), string(body.LocalIntent)).Scan(&raw); err != nil {
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
