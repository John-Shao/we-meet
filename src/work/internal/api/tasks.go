package api

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
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
	TasksPath     = "/work/v1/tasks"
	RunPath       = "/work/v1/runs/{runId}"
	RunCancelPath = "/work/v1/runs/{runId}/cancel"

	defaultTaskLimit = 50
	maxTaskLimit     = 100
)

type RunSummary struct {
	RunID          string  `json:"run_id"`
	State          string  `json:"state"`
	WaitReason     *string `json:"wait_reason"`
	TerminalReason *string `json:"terminal_reason"`
}

type ArtifactSummary struct {
	ArtifactID string `json:"artifact_id"`
	VersionNo  int    `json:"version_no"`
}

type TaskQuota struct {
	ReservedTokens int64 `json:"reserved_tokens"`
	SettledTokens  int64 `json:"settled_tokens"`
}

type TaskSummary struct {
	TaskID             string           `json:"task_id"`
	DisplayState       string           `json:"display_state"`
	TaskState          string           `json:"task_state"`
	Revision           int64            `json:"revision"`
	Title              string           `json:"title"`
	LatestRun          *RunSummary      `json:"latest_run"`
	LatestArtifact     *ArtifactSummary `json:"latest_artifact"`
	Quota              TaskQuota        `json:"quota"`
	BlockingOperations int64            `json:"blocking_operations"`
	PendingAcceptance  bool             `json:"pending_acceptance"`
	CreatedAt          time.Time        `json:"created_at"`
	UpdatedAt          time.Time        `json:"updated_at"`
}

type RunView struct {
	RunID          string    `json:"run_id"`
	TaskID         string    `json:"task_id"`
	State          string    `json:"state"`
	WaitReason     *string   `json:"wait_reason"`
	TerminalReason *string   `json:"terminal_reason"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type taskCursor struct {
	updatedAt time.Time
	taskID    string
}

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	view := r.URL.Query().Get("view")
	if view == "" {
		view = "all"
	}
	predicate, valid := taskViewPredicate(view)
	if !valid {
		writeAPIError(w, correlationID, apierr.New("invalid_view"))
		return
	}
	limit, err := parseTaskLimit(r.URL.Query().Get("limit"))
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_pagination"))
		return
	}
	var cursor *taskCursor
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		parsed, err := parseTaskCursor(raw)
		if err != nil {
			writeAPIError(w, correlationID, apierr.New("invalid_pagination"))
			return
		}
		cursor = &parsed
	}
	if err := s.requireSeat(r.Context(), claims); err != nil {
		var domain *domainError
		if errors.As(err, &domain) {
			writeAPIError(w, correlationID, apierr.New(domain.code))
			return
		}
		apiError := apierr.FromDB(err)
		s.logInternal(correlationID, apiError)
		writeAPIError(w, correlationID, apiError)
		return
	}

	items, next, err := s.readTasks(r.Context(), claims, predicate, limit, cursor)
	if err != nil {
		apiError := apierr.FromDB(err)
		s.logInternal(correlationID, apiError)
		writeAPIError(w, correlationID, apiError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": next})
}

func (s *Server) readTasks(ctx context.Context, claims host.Claims, predicate string, limit int, cursor *taskCursor) ([]TaskSummary, *string, error) {
	items := []TaskSummary{}
	var next *string
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			query := `
				SELECT task_id, display_state, task_state, revision, title,
				       latest_run_id, run_state, wait_reason, terminal_reason,
				       latest_artifact_id, latest_artifact_version,
				       reserved_tokens::bigint, settled_tokens::bigint,
				       blocking_operations, pending_acceptance, created_at, updated_at
				FROM work.task_summary
				WHERE owner_subject_id = $1`
			args := []any{claims.SubjectID}
			if predicate != "" {
				query += " AND " + predicate
			}
			if cursor != nil {
				query += " AND (updated_at, task_id) < ($2, $3)"
				args = append(args, cursor.updatedAt, cursor.taskID)
				query += " ORDER BY updated_at DESC, task_id DESC LIMIT $4"
			} else {
				query += " ORDER BY updated_at DESC, task_id DESC LIMIT $2"
			}
			args = append(args, limit+1)
			rows, err := tx.Query(ctx, query, args...)
			if err != nil {
				return err
			}
			defer rows.Close()
			seen := 0
			hasMore := false
			for rows.Next() {
				var item TaskSummary
				var runID, runState, waitReason, terminalReason, artifactID *string
				var artifactVersion *int
				if err := rows.Scan(
					&item.TaskID, &item.DisplayState, &item.TaskState, &item.Revision,
					&item.Title, &runID, &runState, &waitReason, &terminalReason,
					&artifactID, &artifactVersion,
					&item.Quota.ReservedTokens, &item.Quota.SettledTokens,
					&item.BlockingOperations, &item.PendingAcceptance,
					&item.CreatedAt, &item.UpdatedAt,
				); err != nil {
					return err
				}
				seen++
				if seen > limit {
					hasMore = true
					continue
				}
				if runID != nil && runState != nil {
					item.LatestRun = &RunSummary{
						RunID:          *runID,
						State:          *runState,
						WaitReason:     waitReason,
						TerminalReason: terminalReason,
					}
				}
				if artifactID != nil && artifactVersion != nil {
					item.LatestArtifact = &ArtifactSummary{ArtifactID: *artifactID, VersionNo: *artifactVersion}
				}
				items = append(items, item)
			}
			if err := rows.Err(); err != nil {
				return err
			}
			if hasMore && len(items) > 0 {
				last := items[len(items)-1]
				encoded := encodeTaskCursor(last.UpdatedAt, last.TaskID)
				next = &encoded
			}
			return nil
		},
	)
	return items, next, err
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	if !validUUID(runID) {
		writeAPIError(w, correlationID, apierr.New("run_not_found"))
		return
	}
	if err := s.requireSeat(r.Context(), claims); err != nil {
		var domain *domainError
		if errors.As(err, &domain) {
			writeAPIError(w, correlationID, apierr.New(domain.code))
			return
		}
		apiError := apierr.FromDB(err)
		s.logInternal(correlationID, apiError)
		writeAPIError(w, correlationID, apiError)
		return
	}
	var view RunView
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var waitReason, terminalReason *string
			err := tx.QueryRow(r.Context(), `
				SELECT r.id, r.task_id, r.state, r.wait_reason, r.terminal_reason,
				       r.created_at, r.updated_at
				FROM work.run r
				JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
				WHERE r.id = $1 AND r.org_id = $2
				  AND t.owner_subject_id = $3 AND t.deleted_at IS NULL`,
				runID, claims.OrgID, claims.SubjectID,
			).Scan(&view.RunID, &view.TaskID, &view.State, &waitReason,
				&terminalReason, &view.CreatedAt, &view.UpdatedAt)
			view.WaitReason = waitReason
			view.TerminalReason = terminalReason
			return err
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAPIError(w, correlationID, apierr.New("run_not_found"))
		return
	}
	if err != nil {
		apiError := apierr.FromDB(err)
		s.logInternal(correlationID, apiError)
		writeAPIError(w, correlationID, apiError)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) cancelRun(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	runID := r.PathValue("runId")
	if !validUUID(runID) {
		writeAPIError(w, correlationID, apierr.New("run_not_found"))
		return
	}
	var view RunView
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{},
		func(tx pgx.Tx) error {
			if err := memberAccess(r.Context(), tx, claims, true); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `SELECT work.request_cancel($1, $2, $3, NULL)`,
				claims.OrgID, runID, claims.SubjectID); err != nil {
				return err
			}
			var waitReason, terminalReason *string
			err := tx.QueryRow(r.Context(), `
				SELECT r.id, r.task_id, r.state, r.wait_reason, r.terminal_reason,
				       r.created_at, r.updated_at
				FROM work.run r
				JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
				WHERE r.id = $1 AND r.org_id = $2
				  AND t.owner_subject_id = $3 AND t.deleted_at IS NULL`,
				runID, claims.OrgID, claims.SubjectID,
			).Scan(&view.RunID, &view.TaskID, &view.State, &waitReason,
				&terminalReason, &view.CreatedAt, &view.UpdatedAt)
			view.WaitReason = waitReason
			view.TerminalReason = terminalReason
			return err
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAPIError(w, correlationID, apierr.New("run_not_found"))
		return
	}
	if err != nil {
		var domain *domainError
		if errors.As(err, &domain) {
			writeAPIError(w, correlationID, apierr.New(domain.code))
			return
		}
		apiError := apierr.FromDB(err)
		s.logInternal(correlationID, apiError)
		writeAPIError(w, correlationID, apiError)
		return
	}
	writeJSON(w, http.StatusAccepted, view)
}

func (s *Server) requireSeat(ctx context.Context, claims host.Claims) error {
	return s.requireMember(ctx, claims, false)
}

func (s *Server) requireWriter(ctx context.Context, claims host.Claims) error {
	return s.requireMember(ctx, claims, true)
}

func (s *Server) requireMember(ctx context.Context, claims host.Claims, writer bool) error {
	return workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			return memberAccess(ctx, tx, claims, writer)
		},
	)
}

func memberAccess(ctx context.Context, tx pgx.Tx, claims host.Claims, writer bool) error {
	var status, role string
	var seat bool
	err := tx.QueryRow(ctx, `SELECT status, role, work_seat FROM work.member WHERE org_id = $1 AND subject_id = $2`,
		claims.OrgID, claims.SubjectID).Scan(&status, &role, &seat)
	if errors.Is(err, pgx.ErrNoRows) {
		return &domainError{code: "work_seat_required"}
	}
	if err != nil {
		return err
	}
	if status != "active" || !seat {
		return &domainError{code: "work_seat_required"}
	}
	if writer && role == "viewer" {
		return &domainError{code: "forbidden"}
	}
	return nil
}

func taskViewPredicate(view string) (string, bool) {
	switch view {
	case "all":
		return "", true
	case "pending":
		return "display_state IN ('open', 'queued')", true
	case "running":
		return "display_state IN ('running', 'canceling', 'reconciling', 'quota_exhausted')", true
	case "awaiting_acceptance":
		return "display_state = 'awaiting_acceptance'", true
	case "completed":
		return "display_state = 'completed'", true
	default:
		return "", false
	}
}

func parseTaskLimit(raw string) (int, error) {
	if raw == "" {
		return defaultTaskLimit, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > maxTaskLimit {
		return 0, fmt.Errorf("invalid limit")
	}
	return value, nil
}

func parseTaskCursor(raw string) (taskCursor, error) {
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return taskCursor{}, err
	}
	parts := strings.SplitN(string(body), "|", 2)
	if len(parts) != 2 || !validUUID(parts[1]) {
		return taskCursor{}, fmt.Errorf("invalid task cursor")
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return taskCursor{}, err
	}
	return taskCursor{updatedAt: updatedAt, taskID: parts[1]}, nil
}

func encodeTaskCursor(updatedAt time.Time, taskID string) string {
	return base64.RawURLEncoding.EncodeToString(
		[]byte(updatedAt.UTC().Format(time.RFC3339Nano) + "|" + taskID),
	)
}

func validUUID(value string) bool {
	var id pgtype.UUID
	return id.Scan(value) == nil
}
