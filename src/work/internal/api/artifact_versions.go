package api

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
)

const (
	ArtifactVersionsPath = "/work/v1/artifacts/{artifactId}/versions"

	// maxArtifactVersionContent is the same 256 KiB the contract states twice:
	// Limits.max_artifact_bytes and ArtifactVersionCreateRequest.content's
	// maxLength. Both count characters, so the handler checks runes and the
	// stored bytes may be larger for a non-ASCII text.
	maxArtifactVersionContent = 262144
	maxArtifactVersionName    = 200
	// maxArtifactVersionBody is the transport ceiling, and it has to be its own
	// number: one JSON escape turns a character into six bytes, so a body can
	// exceed the character ceiling while still being a legal request.
	// MaxBytesReader bounds the read before any decoding happens.
	maxArtifactVersionBody = 2 << 20

	artifactVersionMediaTypeMarkdown = "text/markdown"
	artifactVersionMediaTypePlain    = "text/plain"
)

// artifactVersionCreateRequest mirrors ArtifactVersionCreateRequest. media_type
// carries a schema default, so an absent value means text/markdown rather than
// an error; logical_name is optional and is a name check, not a rename (see
// createArtifactVersion).
type artifactVersionCreateRequest struct {
	ClientRequestID string  `json:"client_request_id"`
	BaseVersionNo   int     `json:"base_version_no"`
	LogicalName     *string `json:"logical_name"`
	MediaType       *string `json:"media_type"`
	Content         string  `json:"content"`
}

// createArtifactVersion publishes a user-edited text version of an artifact
// without touching the previous one. work.create_user_artifact_version owns the
// task-state gate, the base-version check and the client_request_id dedup, so a
// network retry republishes nothing; the handler's own job is to put the body in
// the Content Store first, because the command stores a reference, not a text.
//
// logical_name cannot be honoured by this endpoint. artifact_version has no such
// column and every read path returns work.artifact.logical_name, so a value that
// differs from the artifact's is asking for a rename or a "save as" - and the
// path is anchored to one existing artifact. It is refused before anything is
// stored, so a refusal never leaves an orphan object behind.
func (s *Server) createArtifactVersion(w http.ResponseWriter, r *http.Request) {
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
	artifactID := r.PathValue("artifactId")
	if !validUUID(artifactID) {
		writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
		return
	}
	if s.content == nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	body, mediaType, ok := readArtifactVersionBody(w, r)
	if !ok {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}

	if body.LogicalName != nil {
		name, err := s.readArtifactLogicalName(r.Context(), claims, artifactID)
		if errors.Is(err, pgx.ErrNoRows) {
			writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
			return
		}
		if err != nil {
			s.writeAccessError(w, correlationID, err)
			return
		}
		if name != *body.LogicalName {
			writeAPIError(w, correlationID, apierr.New("invalid_request"))
			return
		}
	}

	ref, err := s.content.Put(r.Context(), claims.OrgID, []byte(body.Content))
	if err != nil {
		s.logger.Printf("work api content put failure correlation_id=%s", correlationID)
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	versionNo, err := s.persistArtifactVersion(r.Context(), claims, artifactID,
		body, ref, mediaType)
	if err != nil {
		// The object is already on the store and the command aborted, so nothing
		// references it. It is not deleted: a lost commit ACK would mean a
		// published version does reference it, and a leaked object is the
		// cheaper failure. inputs.go logs the mirror case (a row that points at a
		// different object) for the same reason.
		s.logger.Printf("work api artifact version write failure correlation_id=%s", correlationID)
		s.writeAccessError(w, correlationID, err)
		return
	}
	// Read the row back through the GET path so the 201 body and what a later
	// GET returns cannot disagree - including which versions are readable at all.
	record, err := s.readArtifactVersion(r.Context(), claims, "", artifactID, versionNo)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAPIError(w, correlationID, apierr.New("artifact_not_found"))
		return
	}
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	if record.ContentRef != ref.ContentRef {
		s.logger.Printf("work api artifact version replay left an unreferenced object correlation_id=%s",
			correlationID)
	}
	writeJSON(w, http.StatusCreated,
		artifactVersionPayload(record, artifactContentURL(r, record.ArtifactID, record.VersionNo)))
}

// readArtifactVersionBody decodes and validates the request, and resolves the
// media type so the caller cannot act on a value the enum rejected. Every
// refusal is an invalid_request: these are shape rules, and the state rules -
// task open, run quiescent, base version current - belong to the command.
func readArtifactVersionBody(w http.ResponseWriter, r *http.Request) (artifactVersionCreateRequest, string, bool) {
	refuse := func() (artifactVersionCreateRequest, string, bool) {
		return artifactVersionCreateRequest{}, "", false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxArtifactVersionBody)
	var body artifactVersionCreateRequest
	if err := decodeStrictJSONBody(r.Body, &body); err != nil {
		return refuse()
	}
	// p_base_version_no is a PostgreSQL int, so a value that fits in Go's 64-bit
	// int but not in int4 must be refused here rather than surfacing as a
	// transport error after the body is already stored.
	if !validClientRequestID(body.ClientRequestID) || body.BaseVersionNo < 1 ||
		body.BaseVersionNo > math.MaxInt32 {
		return refuse()
	}
	if body.Content == "" || strings.ContainsRune(body.Content, '\x00') ||
		utf8.RuneCountInString(body.Content) > maxArtifactVersionContent {
		return refuse()
	}
	mediaType, ok := artifactVersionMediaType(body.MediaType)
	if !ok {
		return refuse()
	}
	if body.LogicalName != nil {
		name := *body.LogicalName
		if strings.TrimSpace(name) != name || name == "" ||
			utf8.RuneCountInString(name) > maxArtifactVersionName ||
			strings.IndexFunc(name, unicode.IsControl) >= 0 {
			return refuse()
		}
	}
	return body, mediaType, true
}

func artifactVersionMediaType(value *string) (string, bool) {
	if value == nil {
		return artifactVersionMediaTypeMarkdown, true
	}
	switch *value {
	case artifactVersionMediaTypeMarkdown, artifactVersionMediaTypePlain:
		return *value, true
	default:
		return "", false
	}
}

func (s *Server) readArtifactLogicalName(
	ctx context.Context,
	claims host.Claims,
	artifactID string,
) (string, error) {
	var name string
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT a.logical_name
				FROM work.artifact a
				JOIN work.task t ON t.id = a.task_id AND t.org_id = a.org_id
				WHERE a.id = $1 AND a.org_id = $2 AND t.owner_subject_id = $3
				  AND a.deleted_at IS NULL AND t.deleted_at IS NULL`,
				artifactID, claims.OrgID, claims.SubjectID,
			).Scan(&name)
		},
	)
	return name, err
}

func (s *Server) persistArtifactVersion(
	ctx context.Context,
	claims host.Claims,
	artifactID string,
	body artifactVersionCreateRequest,
	ref content.Ref,
	mediaType string,
) (int, error) {
	var versionNo int
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{},
		func(tx pgx.Tx) error {
			var taskRevision int64
			return tx.QueryRow(ctx, `
				SELECT version_no, task_revision
				FROM work.create_user_artifact_version(
				  $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`,
				claims.OrgID, artifactID, claims.SubjectID, body.ClientRequestID,
				body.BaseVersionNo, ref.ContentRef, ref.Hash, ref.Bytes, mediaType,
			).Scan(&versionNo, &taskRevision)
		},
	)
	return versionNo, err
}
