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
	ArtifactVersionPath = "/work/v1/artifacts/{artifactId}/versions/{versionNo}"
	ArtifactContentPath = ArtifactVersionPath + "/content"
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
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
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
	record, err := s.readArtifactVersion(r.Context(), claims, artifactID, versionNo)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
		return
	}
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	version := ArtifactVersion{
		ArtifactID:  record.ArtifactID,
		VersionNo:   record.VersionNo,
		LogicalName: record.LogicalName,
		MediaType:   record.MediaType,
		Bytes:       record.Bytes,
		ContentHash: record.ContentHash,
		State:       "published",
		ContentURL:  artifactContentURL(r, record.ArtifactID, record.VersionNo),
		CreatedAt:   record.CreatedAt,
	}
	if record.PublishedAt.Valid {
		publishedAt := record.PublishedAt.Time
		version.PublishedAt = &publishedAt
	}
	writeJSON(w, http.StatusOK, version)
}

func (s *Server) getArtifactContent(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
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
	record, err := s.readArtifactVersion(r.Context(), claims, artifactID, versionNo)
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

func (s *Server) readArtifactVersion(
	ctx context.Context,
	claims host.Claims,
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
				  AND a.deleted_at IS NULL AND t.deleted_at IS NULL
				  AND a.state = 'published' AND v.state = 'published'`,
				artifactID, versionNo, claims.OrgID, claims.SubjectID,
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
	scheme := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	if scheme != "https" && scheme != "http" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	return fmt.Sprintf("%s://%s/work/v1/artifacts/%s/versions/%d/content",
		scheme, r.Host, url.PathEscape(artifactID), versionNo)
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
