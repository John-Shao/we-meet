package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
)

const (
	ArtifactVersionPath     = "/work/v1/artifacts/{artifactId}/versions/{versionNo}"
	ArtifactContentPath     = ArtifactVersionPath + "/content"
	TaskArtifactPath        = "/work/v1/tasks/{taskId}/artifacts/{artifactId}"
	TaskArtifactVersionPath = TaskArtifactPath + "/versions/{versionNo}"
	TaskArtifactContentPath = TaskArtifactVersionPath + "/content"
)

type ArtifactVersion struct {
	ArtifactID  string     `json:"artifact_id"`
	VersionNo   int        `json:"version_no"`
	LogicalName string     `json:"logical_name"`
	MediaType   string     `json:"media_type"`
	Bytes       int64      `json:"bytes"`
	ContentHash string     `json:"content_hash"`
	State       string     `json:"state"`
	ContentURL  string     `json:"content_url"`
	CreatedAt   time.Time  `json:"created_at"`
	PublishedAt *time.Time `json:"published_at"`
}

type ArtifactWorkspaceVersion struct {
	VersionNo   int        `json:"version_no"`
	MediaType   string     `json:"media_type"`
	Bytes       int64      `json:"bytes"`
	ContentHash string     `json:"content_hash"`
	State       string     `json:"state"`
	ContentURL  string     `json:"content_url"`
	CreatedAt   time.Time  `json:"created_at"`
	PublishedAt *time.Time `json:"published_at"`
}

type ArtifactWorkspace struct {
	ArtifactID        string                     `json:"artifact_id"`
	LogicalName       string                     `json:"logical_name"`
	State             string                     `json:"state"`
	Revision          int64                      `json:"revision"`
	CreatedAt         time.Time                  `json:"created_at"`
	UpdatedAt         time.Time                  `json:"updated_at"`
	AcceptedVersionNo *int                       `json:"accepted_version_no"`
	Versions          []ArtifactWorkspaceVersion `json:"versions"`
}

type TaskArtifactWorkspace struct {
	Summary  TaskSummary       `json:"summary"`
	Artifact ArtifactWorkspace `json:"artifact"`
}

type artifactVersionRecord struct {
	ArtifactID  string
	LogicalName string
	VersionNo   int
	MediaType   string
	Bytes       int64
	ContentHash string
	ContentRef  string
	CreatedAt   time.Time
	PublishedAt pgtype.Timestamptz
	TaskTitle   string
}

func (s *Server) getArtifactVersion(w http.ResponseWriter, r *http.Request) {
	s.serveArtifactVersion(w, r, false)
}

func (s *Server) getTaskArtifactVersion(w http.ResponseWriter, r *http.Request) {
	s.serveArtifactVersion(w, r, true)
}

func (s *Server) serveArtifactVersion(w http.ResponseWriter, r *http.Request, taskScoped bool) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	taskID := ""
	if taskScoped {
		taskID = r.PathValue("taskId")
		if !validUUID(taskID) {
			writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
			return
		}
	}
	artifactID, versionNo, ok := artifactVersionParams(r)
	if !ok {
		writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
		return
	}
	if err := s.requireSeat(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	record, err := s.readArtifactVersion(r.Context(), claims, taskID, artifactID, versionNo)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
		return
	}
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	contentURL := artifactContentURL(r, record.ArtifactID, record.VersionNo)
	if taskScoped {
		contentURL = taskArtifactContentURL(r, taskID, record.ArtifactID, record.VersionNo)
	}
	version := ArtifactVersion{
		ArtifactID:  record.ArtifactID,
		VersionNo:   record.VersionNo,
		LogicalName: record.LogicalName,
		MediaType:   record.MediaType,
		Bytes:       record.Bytes,
		ContentHash: record.ContentHash,
		State:       "published",
		ContentURL:  contentURL,
		CreatedAt:   record.CreatedAt,
	}
	if record.PublishedAt.Valid {
		publishedAt := record.PublishedAt.Time
		version.PublishedAt = &publishedAt
	}
	writeJSON(w, http.StatusOK, version)
}

func (s *Server) getArtifactContent(w http.ResponseWriter, r *http.Request) {
	s.serveArtifactContent(w, r, false)
}

func (s *Server) getTaskArtifactContent(w http.ResponseWriter, r *http.Request) {
	s.serveArtifactContent(w, r, true)
}

func (s *Server) serveArtifactContent(w http.ResponseWriter, r *http.Request, taskScoped bool) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	taskID := ""
	if taskScoped {
		taskID = r.PathValue("taskId")
		if !validUUID(taskID) {
			writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
			return
		}
	}
	artifactID, versionNo, ok := artifactVersionParams(r)
	if !ok {
		writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
		return
	}
	disposition := strings.TrimSpace(r.URL.Query().Get("disposition"))
	if disposition == "" {
		disposition = "inline"
	}
	if disposition != "inline" && disposition != "attachment" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if err := s.requireSeat(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	if s.content == nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	record, err := s.readArtifactVersion(r.Context(), claims, taskID, artifactID, versionNo)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
		return
	}
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	plaintext, err := s.content.Get(r.Context(), claims.OrgID, record.ContentRef)
	if err != nil || !contentHashMatches(plaintext, record.ContentHash) ||
		int64(len(plaintext)) != record.Bytes {
		s.logger.Printf("work api artifact content read failure correlation_id=%s", correlationID)
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	if disposition == "attachment" {
		if err := s.recordArtifactExport(r.Context(), claims, artifactID, versionNo); err != nil {
			s.writeAccessError(w, correlationID, err)
			return
		}
	}
	w.Header().Set("Content-Type", artifactContentType(record.MediaType))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(plaintext)))
	if disposition == "attachment" {
		w.Header().Set("Content-Disposition", artifactContentDisposition(
			record.TaskTitle, record.ArtifactID, record.VersionNo, record.MediaType))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(plaintext)
}

func (s *Server) getTaskArtifact(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	taskID := r.PathValue("taskId")
	artifactID := r.PathValue("artifactId")
	if !validUUID(taskID) || !validUUID(artifactID) {
		writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
		return
	}
	if err := s.requireSeat(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	workspace, err := s.readTaskArtifactWorkspace(r.Context(), claims, taskID, artifactID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
		return
	}
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	for i := range workspace.Artifact.Versions {
		version := &workspace.Artifact.Versions[i]
		version.ContentURL = taskArtifactContentURL(r, taskID, artifactID, version.VersionNo)
	}
	writeJSON(w, http.StatusOK, workspace)
}

func (s *Server) readTaskArtifactWorkspace(
	ctx context.Context,
	claims host.Claims,
	taskID string,
	artifactID string,
) (TaskArtifactWorkspace, error) {
	var workspace TaskArtifactWorkspace
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true, IsoLevel: pgx.RepeatableRead},
		func(tx pgx.Tx) error {
			summary, err := loadTaskSummary(ctx, tx, taskID, claims)
			if err != nil {
				return err
			}
			workspace.Summary = summary
			if err := tx.QueryRow(ctx, `
				SELECT a.id, a.logical_name, a.state, a.revision, a.created_at, a.updated_at
				FROM work.artifact a
				JOIN work.task t
				  ON t.id = a.task_id AND t.org_id = a.org_id
				WHERE a.id = $1 AND a.task_id = $2 AND a.org_id = $3
				  AND t.owner_subject_id = $4
				  AND a.deleted_at IS NULL AND t.deleted_at IS NULL
				  AND a.state = 'published'`,
				artifactID, taskID, claims.OrgID, claims.SubjectID,
			).Scan(&workspace.Artifact.ArtifactID, &workspace.Artifact.LogicalName,
				&workspace.Artifact.State, &workspace.Artifact.Revision,
				&workspace.Artifact.CreatedAt, &workspace.Artifact.UpdatedAt); err != nil {
				return err
			}
			rows, err := tx.Query(ctx, `
				SELECT version_no, media_type, bytes, content_hash, state, created_at, published_at
				FROM work.artifact_version
				WHERE artifact_id = $1 AND org_id = $2 AND state = 'published'
				ORDER BY version_no DESC`,
				artifactID, claims.OrgID,
			)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var version ArtifactWorkspaceVersion
				var publishedAt pgtype.Timestamptz
				if err := rows.Scan(&version.VersionNo, &version.MediaType, &version.Bytes,
					&version.ContentHash, &version.State, &version.CreatedAt, &publishedAt); err != nil {
					return err
				}
				if publishedAt.Valid {
					value := publishedAt.Time
					version.PublishedAt = &value
				}
				workspace.Artifact.Versions = append(workspace.Artifact.Versions, version)
			}
			if err := rows.Err(); err != nil {
				return err
			}
			if len(workspace.Artifact.Versions) == 0 {
				return pgx.ErrNoRows
			}
			var acceptedVersion int
			err = tx.QueryRow(ctx, `
				SELECT version_no FROM work.acceptance
				WHERE org_id = $1 AND task_id = $2 AND artifact_id = $3
				ORDER BY task_revision DESC LIMIT 1`,
				claims.OrgID, taskID, artifactID,
			).Scan(&acceptedVersion)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if err == nil {
				workspace.Artifact.AcceptedVersionNo = &acceptedVersion
			}
			return nil
		},
	)
	return workspace, err
}

func (s *Server) readArtifactVersion(
	ctx context.Context,
	claims host.Claims,
	taskID string,
	artifactID string,
	versionNo int,
) (artifactVersionRecord, error) {
	var record artifactVersionRecord
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT a.id, a.logical_name, v.version_no, v.media_type, v.bytes,
				       v.content_hash, v.content_ref, v.created_at, v.published_at, t.title
				FROM work.artifact a
				JOIN work.artifact_version v
				  ON v.artifact_id = a.id AND v.org_id = a.org_id
				JOIN work.task t
				  ON t.id = a.task_id AND t.org_id = a.org_id
				WHERE a.id = $1 AND v.version_no = $2 AND a.org_id = $3
				  AND t.owner_subject_id = $4
				  AND a.task_id = COALESCE(NULLIF($5::text, '')::uuid, a.task_id)
				  AND a.deleted_at IS NULL AND t.deleted_at IS NULL
				  AND a.state = 'published' AND v.state = 'published'`,
				artifactID, versionNo, claims.OrgID, claims.SubjectID, taskID,
			).Scan(&record.ArtifactID, &record.LogicalName, &record.VersionNo,
				&record.MediaType, &record.Bytes, &record.ContentHash,
				&record.ContentRef, &record.CreatedAt, &record.PublishedAt,
				&record.TaskTitle)
		},
	)
	return record, err
}

func (s *Server) recordArtifactExport(
	ctx context.Context,
	claims host.Claims,
	artifactID string,
	versionNo int,
) error {
	return workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{},
		func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx,
				`SELECT work.record_artifact_export($1, $2, $3, $4)`,
				claims.OrgID, artifactID, versionNo, claims.SubjectID)
			return err
		},
	)
}

func artifactVersionParams(r *http.Request) (string, int, bool) {
	artifactID := r.PathValue("artifactId")
	versionNo, err := strconv.Atoi(r.PathValue("versionNo"))
	if !validUUID(artifactID) || err != nil || versionNo < 1 {
		return "", 0, false
	}
	return artifactID, versionNo, true
}

func artifactContentURL(r *http.Request, artifactID string, versionNo int) string {
	return fmt.Sprintf("%s://%s/work/v1/artifacts/%s/versions/%d/content",
		requestScheme(r), r.Host, url.PathEscape(artifactID), versionNo)
}

func taskArtifactContentURL(r *http.Request, taskID, artifactID string, versionNo int) string {
	return fmt.Sprintf("%s://%s/work/v1/tasks/%s/artifacts/%s/versions/%d/content",
		requestScheme(r), r.Host, url.PathEscape(taskID), url.PathEscape(artifactID), versionNo)
}

func requestScheme(r *http.Request) string {
	scheme := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	if scheme == "https" || scheme == "http" {
		return scheme
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

func artifactContentType(mediaType string) string {
	if mediaType == "text/plain" {
		return "text/plain; charset=utf-8"
	}
	return "text/markdown; charset=utf-8"
}

func artifactContentDisposition(title, artifactID string, versionNo int, mediaType string) string {
	extension := "md"
	if mediaType == "text/plain" {
		extension = "txt"
	}
	asciiName := fmt.Sprintf("work-%s-v%d.%s", artifactID[:8], versionNo, extension)
	label := artifactDownloadLabel(title)
	utf8Name := fmt.Sprintf("%s-v%d.%s", label, versionNo, extension)
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`,
		asciiName, url.PathEscape(utf8Name))
}

func artifactDownloadLabel(title string) string {
	var builder strings.Builder
	count := 0
	for _, value := range strings.TrimSpace(title) {
		if count >= 60 {
			break
		}
		if value < 0x20 || value == 0x7f || strings.ContainsRune(`\/:*?"<>|`, value) {
			value = '_'
		}
		builder.WriteRune(value)
		count++
	}
	label := strings.TrimSpace(builder.String())
	if label == "" {
		return "work"
	}
	return label
}
