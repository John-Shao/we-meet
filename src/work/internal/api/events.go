package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
)

const (
	TaskEventsPath = "/work/v1/tasks/{taskId}/events"

	taskEventSchemaVersion = "work-event-v1"
	ssePollInterval        = time.Second
	sseHeartbeatInterval   = 15 * time.Second
	sseBatchLimit          = 100
	currentCursorHeader    = "X-Work-Event-Cursor"
)

var eventTypePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

type TaskEvent struct {
	EventID       string          `json:"event_id"`
	TaskID        string          `json:"task_id"`
	RunID         *string         `json:"run_id,omitempty"`
	Seq           int64           `json:"seq"`
	SchemaVersion string          `json:"schema_version"`
	OccurredAt    time.Time       `json:"occurred_at"`
	Type          string          `json:"type"`
	Payload       json.RawMessage `json:"payload"`
}

type eventResync struct {
	currentEventID string
}

func (e *eventResync) Error() string { return "resync_required" }

func (s *Server) streamTaskEvents(w http.ResponseWriter, r *http.Request) {
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

	cursor, err := s.resolveEventCursor(r.Context(), claims, taskID, r.Header.Get("Last-Event-ID"))
	if err != nil {
		var resync *eventResync
		if errors.As(err, &resync) {
			if resync.currentEventID != "" {
				w.Header().Set(currentCursorHeader, resync.currentEventID)
			}
			writeAPIError(w, correlationID, apierr.New("resync_required"))
			return
		}
		if errors.Is(err, pgx.ErrNoRows) {
			writeAPIError(w, correlationID, apierr.New("task_not_found"))
			return
		}
		s.writeAccessError(w, correlationID, err)
		return
	}

	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if _, err := io.WriteString(w, "retry: 5000\n\n"); err != nil {
		return
	}
	if err := controller.Flush(); err != nil {
		return
	}

	if err := s.drainTaskEvents(r.Context(), w, controller, claims, taskID, &cursor); err != nil {
		s.logger.Printf("work api task event stream stopped correlation_id=%s", correlationID)
		return
	}
	poll := time.NewTicker(ssePollInterval)
	defer poll.Stop()
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-poll.C:
			if err := s.drainTaskEvents(r.Context(), w, controller, claims, taskID, &cursor); err != nil {
				s.logger.Printf("work api task event stream stopped correlation_id=%s", correlationID)
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			if err := controller.Flush(); err != nil {
				return
			}
		}
	}
}

func (s *Server) resolveEventCursor(ctx context.Context, claims host.Claims, taskID, lastEventID string) (int64, error) {
	var cursor int64
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			if err := tx.QueryRow(ctx, `
				SELECT 1 FROM work.task
				WHERE id = $1 AND org_id = $2 AND owner_subject_id = $3 AND deleted_at IS NULL`,
				taskID, claims.OrgID, claims.SubjectID,
			).Scan(new(int)); err != nil {
				return err
			}
			lastEventID = strings.TrimSpace(lastEventID)
			if lastEventID == "" {
				return tx.QueryRow(ctx, `
					SELECT COALESCE(MAX(seq), 0) FROM work.task_event
					WHERE task_id = $1 AND org_id = $2`,
					taskID, claims.OrgID,
				).Scan(&cursor)
			}
			if !validUUID(lastEventID) {
				current, err := latestEventID(ctx, tx, taskID, claims.OrgID)
				if err != nil {
					return err
				}
				return &eventResync{currentEventID: current}
			}
			err := tx.QueryRow(ctx, `
				SELECT seq FROM work.task_event
				WHERE id = $1 AND task_id = $2 AND org_id = $3`,
				lastEventID, taskID, claims.OrgID,
			).Scan(&cursor)
			if errors.Is(err, pgx.ErrNoRows) {
				current, err := latestEventID(ctx, tx, taskID, claims.OrgID)
				if err != nil {
					return err
				}
				return &eventResync{currentEventID: current}
			}
			return err
		},
	)
	return cursor, err
}

func latestEventID(ctx context.Context, tx pgx.Tx, taskID, orgID string) (string, error) {
	var id *string
	err := tx.QueryRow(ctx, `
		SELECT id FROM work.task_event
		WHERE task_id = $1 AND org_id = $2
		ORDER BY seq DESC LIMIT 1`,
		taskID, orgID,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if id == nil {
		return "", nil
	}
	return *id, nil
}

func (s *Server) drainTaskEvents(
	ctx context.Context,
	w io.Writer,
	controller *http.ResponseController,
	claims host.Claims,
	taskID string,
	cursor *int64,
) error {
	for {
		events, err := s.readTaskEvents(ctx, claims, taskID, *cursor, sseBatchLimit)
		if err != nil {
			return err
		}
		for _, event := range events {
			if err := writeTaskEvent(w, event); err != nil {
				return err
			}
			*cursor = event.Seq
		}
		if len(events) < sseBatchLimit {
			break
		}
	}
	return controller.Flush()
}

func (s *Server) readTaskEvents(ctx context.Context, claims host.Claims, taskID string, afterSeq int64, limit int) ([]TaskEvent, error) {
	events := []TaskEvent{}
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `
				SELECT e.id, e.task_id, e.seq, e.type, e.payload->>'run_id', e.payload, e.created_at
				FROM work.task_event e
				JOIN work.task t ON t.id = e.task_id AND t.org_id = e.org_id
				WHERE e.task_id = $1 AND e.org_id = $2
				  AND t.owner_subject_id = $3 AND t.deleted_at IS NULL
				  AND e.seq > $4
				ORDER BY e.seq
				LIMIT $5`,
				taskID, claims.OrgID, claims.SubjectID, afterSeq, limit,
			)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var event TaskEvent
				var runID *string
				var payload []byte
				if err := rows.Scan(&event.EventID, &event.TaskID, &event.Seq,
					&event.Type, &runID, &payload, &event.OccurredAt); err != nil {
					return err
				}
				event.RunID = runID
				event.SchemaVersion = taskEventSchemaVersion
				event.Payload = json.RawMessage(payload)
				events = append(events, event)
			}
			return rows.Err()
		},
	)
	return events, err
}

func writeTaskEvent(w io.Writer, event TaskEvent) error {
	body, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "id: %s\n", event.EventID); err != nil {
		return err
	}
	if eventTypePattern.MatchString(event.Type) {
		if _, err := fmt.Fprintf(w, "event: %s\n", event.Type); err != nil {
			return err
		}
	}
	_, err = fmt.Fprintf(w, "data: %s\n\n", body)
	return err
}
