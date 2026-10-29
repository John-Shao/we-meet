package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

type TaskSnapshot struct {
	SnapshotID    string          `json:"snapshot_id"`
	SnapshotHash  string          `json:"snapshot_hash"`
	ToolAllowlist []string        `json:"tool_allowlist"`
	ModelRoute    json.RawMessage `json:"model_route"`
}

type TaskDetail struct {
	Summary    TaskSummary   `json:"summary"`
	InputRef   string        `json:"input_ref"`
	Goal       string        `json:"goal"`
	Background *string       `json:"background"`
	Template   *Template     `json:"template"`
	Snapshot   *TaskSnapshot `json:"snapshot"`
}

type taskDetailRecord struct {
	inputRef     string
	contentRef   string
	contentHash  string
	inputStatus  string
	snapshot     TaskSnapshot
	manifestJSON []byte
}

type taskTitleRequest struct {
	ClientRequestID  string `json:"client_request_id"`
	ExpectedRevision *int64 `json:"expected_revision"`
	Title            string `json:"title"`
}

type acceptanceRequest struct {
	ClientRequestID  string  `json:"client_request_id"`
	ExpectedRevision *int64  `json:"expected_revision"`
	ArtifactID       *string `json:"artifact_id"`
	VersionNo        *int    `json:"version_no"`
	CompletionReason *string `json:"completion_reason"`
}

type Acceptance struct {
	ID               string    `json:"id"`
	TaskID           string    `json:"task_id"`
	ArtifactID       *string   `json:"artifact_id"`
	VersionNo        *int      `json:"version_no"`
	CompletionReason *string   `json:"completion_reason"`
	ActorSubjectID   string    `json:"actor_subject_id"`
	TaskRevision     int64     `json:"task_revision"`
	CreatedAt        time.Time `json:"created_at"`
}

type acceptanceResult struct {
	Acceptance Acceptance  `json:"acceptance"`
	Task       TaskSummary `json:"task"`
}

func (s *Server) getTask(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	taskID := r.PathValue("taskId")
	if !validUUID(taskID) {
		writeAPIError(w, correlationID, apierr.New("task_not_found"))
		return
	}
	if err := s.requireSeat(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}

	var summary TaskSummary
	var record taskDetailRecord
	summaryFound := false
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var err error
			summary, err = loadTaskSummary(r.Context(), tx, taskID, claims)
			if err != nil {
				return err
			}
			summaryFound = true
			var inputID, snapshotID string
			if err := tx.QueryRow(r.Context(), `
				SELECT input_id, snapshot_id
				FROM work.task
				WHERE id = $1 AND org_id = $2 AND owner_subject_id = $3 AND deleted_at IS NULL`,
				taskID, claims.OrgID, claims.SubjectID,
			).Scan(&inputID, &snapshotID); err != nil {
				return err
			}
			record.inputRef = inputID
			if err := tx.QueryRow(r.Context(), `
				SELECT content_ref, content_hash, status
				FROM work.input_object
				WHERE id = $1 AND org_id = $2 AND task_id = $3`,
				inputID, claims.OrgID, taskID,
			).Scan(&record.contentRef, &record.contentHash, &record.inputStatus); err != nil {
				return err
			}
			var modelRoute []byte
			if err := tx.QueryRow(r.Context(), `
				SELECT id, snapshot_hash, tool_allowlist, model_route, manifest
				FROM work.capability_snapshot
				WHERE id = $1 AND org_id = $2 AND task_id = $3`,
				snapshotID, claims.OrgID, taskID,
			).Scan(&record.snapshot.SnapshotID, &record.snapshot.SnapshotHash,
				&record.snapshot.ToolAllowlist, &modelRoute, &record.manifestJSON); err != nil {
				return err
			}
			record.snapshot.ModelRoute = json.RawMessage(modelRoute)
			return nil
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		if !summaryFound {
			writeAPIError(w, correlationID, apierr.New("task_not_found"))
			return
		}
		s.logger.Printf("work api task detail is incomplete correlation_id=%s", correlationID)
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	if record.inputStatus != "active" {
		s.logger.Printf("work api task input is not active correlation_id=%s", correlationID)
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	if s.content == nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	plaintext, err := s.content.Get(r.Context(), claims.OrgID, record.contentRef)
	if err != nil || !contentHashMatches(plaintext, record.contentHash) {
		s.logger.Printf("work api task content read failure correlation_id=%s", correlationID)
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	var input struct {
		Goal       string `json:"goal"`
		Background string `json:"background"`
	}
	if err := json.Unmarshal(plaintext, &input); err != nil || strings.TrimSpace(input.Goal) == "" {
		s.logger.Printf("work api task content is invalid correlation_id=%s", correlationID)
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	var background *string
	if input.Background != "" {
		background = &input.Background
	}
	if len(record.snapshot.ModelRoute) == 0 {
		record.snapshot.ModelRoute = json.RawMessage(`{}`)
	}
	writeJSON(w, http.StatusOK, TaskDetail{
		Summary:    summary,
		InputRef:   record.inputRef,
		Goal:       input.Goal,
		Background: background,
		Template:   templateFromSnapshot(record.manifestJSON),
		Snapshot:   &record.snapshot,
	})
}

func (s *Server) updateTask(w http.ResponseWriter, r *http.Request) {
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
	taskID := r.PathValue("taskId")
	if !validUUID(taskID) {
		writeAPIError(w, correlationID, apierr.New("task_not_found"))
		return
	}
	var body taskTitleRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if !validClientRequestID(body.ClientRequestID) || body.ExpectedRevision == nil || *body.ExpectedRevision < 0 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	title := strings.TrimSpace(body.Title)
	if title == "" || utf8.RuneCountInString(title) > 80 || strings.IndexFunc(title, unicode.IsControl) >= 0 {
		writeAPIError(w, correlationID, apierr.New("title_invalid"))
		return
	}
	var summary TaskSummary
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{},
		func(tx pgx.Tx) error {
			if _, err := tx.Exec(r.Context(), `
				SELECT work.update_task_title($1, $2, $3, $4, $5, $6)`,
				claims.OrgID, taskID, claims.SubjectID, body.ClientRequestID,
				*body.ExpectedRevision, title,
			); err != nil {
				return err
			}
			var err error
			summary, err = loadTaskSummary(r.Context(), tx, taskID, claims)
			return err
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAPIError(w, correlationID, apierr.New("task_not_found"))
		return
	}
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) createAcceptance(w http.ResponseWriter, r *http.Request) {
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
	taskID := r.PathValue("taskId")
	if !validUUID(taskID) {
		writeAPIError(w, correlationID, apierr.New("task_not_found"))
		return
	}
	var body acceptanceRequest
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if !validClientRequestID(body.ClientRequestID) || body.ExpectedRevision == nil || *body.ExpectedRevision < 0 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	artifactID, versionNo, reason, ok := normalizeAcceptance(body)
	if !ok {
		writeAPIError(w, correlationID, apierr.New("acceptance_requires_artifact_or_reason"))
		return
	}
	var acceptance Acceptance
	var summary TaskSummary
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{},
		func(tx pgx.Tx) error {
			var acceptanceID string
			var revision int64
			if err := tx.QueryRow(r.Context(), `
				SELECT acceptance_id, revision
				FROM work.accept_task($1, $2, $3, $4, $5, $6::uuid, $7::int, $8::text)`,
				claims.OrgID, taskID, claims.SubjectID, body.ClientRequestID,
				*body.ExpectedRevision, artifactID, versionNo, reason,
			).Scan(&acceptanceID, &revision); err != nil {
				return err
			}
			if err := tx.QueryRow(r.Context(), `
				SELECT id, task_id, artifact_id, version_no, completion_reason,
				       actor_subject_id, task_revision, created_at
				FROM work.acceptance
				WHERE id = $1 AND org_id = $2`,
				acceptanceID, claims.OrgID,
			).Scan(&acceptance.ID, &acceptance.TaskID, &acceptance.ArtifactID,
				&acceptance.VersionNo, &acceptance.CompletionReason,
				&acceptance.ActorSubjectID, &acceptance.TaskRevision,
				&acceptance.CreatedAt); err != nil {
				return err
			}
			var err error
			summary, err = loadTaskSummary(r.Context(), tx, taskID, claims)
			return err
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAPIError(w, correlationID, apierr.New("task_not_found"))
		return
	}
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, acceptanceResult{Acceptance: acceptance, Task: summary})
}

func normalizeAcceptance(body acceptanceRequest) (any, any, any, bool) {
	hasArtifact := body.ArtifactID != nil
	hasVersion := body.VersionNo != nil
	hasReason := body.CompletionReason != nil
	switch {
	case hasArtifact && hasVersion && !hasReason:
		if !validUUID(*body.ArtifactID) || *body.VersionNo < 1 {
			return nil, nil, nil, false
		}
		return *body.ArtifactID, *body.VersionNo, nil, true
	case !hasArtifact && !hasVersion && hasReason:
		reason := strings.TrimSpace(*body.CompletionReason)
		if reason == "" || utf8.RuneCountInString(reason) > 500 {
			return nil, nil, nil, false
		}
		return nil, nil, reason, true
	default:
		return nil, nil, nil, false
	}
}

func validClientRequestID(value string) bool {
	return len(value) >= 8 && len(value) <= 128 && strings.TrimSpace(value) == value
}

func contentHashMatches(plaintext []byte, expected string) bool {
	digest := sha256.Sum256(plaintext)
	actual := "sha256:" + hex.EncodeToString(digest[:])
	return subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1
}

func templateFromSnapshot(manifest []byte) *Template {
	var parsed struct {
		Template struct {
			ID          string `json:"id"`
			Version     int    `json:"version"`
			ContentHash string `json:"content_hash"`
		} `json:"template"`
	}
	if err := json.Unmarshal(manifest, &parsed); err != nil || parsed.Template.ID == "" {
		return nil
	}
	template, ok := templateByID(parsed.Template.ID)
	if !ok || template.Version != parsed.Template.Version ||
		template.ContentHash != parsed.Template.ContentHash {
		return nil
	}
	return &template
}
