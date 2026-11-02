package api

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
)

const (
	InboxPath = "/work/v1/inbox"

	// inboxDefaultLimit is the shared Limit parameter's declared default. The task
	// list answers 50 and that offset is tracked for adjudication; a surface added
	// after it follows the contract instead of inheriting the deviation.
	inboxDefaultLimit = 20
)

// InboxItem is the contract's one cross-task "需要你" projection. The type enum
// is closed and derived, never stored: three display states mean three reasons
// the owner has to act.
type InboxItem struct {
	TaskID       string    `json:"task_id"`
	Type         string    `json:"type"`
	Title        string    `json:"title"`
	DisplayState string    `json:"display_state"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type InboxPage struct {
	Items      []InboxItem `json:"items"`
	NextCursor *string     `json:"next_cursor"`
}

// inboxTypes maps the view's derived display_state onto the contract's closed
// type enum. Display states absent here are not inbox material: an open or
// running task is not waiting on the owner, and a completed, canceled or
// archived one is finished. The map sits beside the query rather than in a SQL
// CASE because work.task_summary already owns the derivation - restating the
// rules in a second place is how the two drift apart.
var inboxTypes = map[string]string{
	"awaiting_acceptance": "acceptance_required",
	"failed":              "failed",
	"reconciling":         "reconciling",
}

func (s *Server) listInbox(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	limit, err := parsePageLimit(r.URL.Query().Get("limit"), inboxDefaultLimit)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_pagination"))
		return
	}
	cursor, err := optionalTaskCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_pagination"))
		return
	}
	if err := s.requireSeat(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	items, next, err := s.readInbox(r.Context(), claims, limit, cursor)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, InboxPage{Items: items, NextCursor: next})
}

// readInbox reads the same security-invoker view as the task list, so a row's
// display_state here and the same task's display_state in the list cannot
// disagree, and RLS plus owner_subject_id do the tenant and owner scoping.
// One statement carries both paging modes through the NULL cursor test, because
// two hand-built query strings is where an ORDER BY and a predicate can differ
// between the first page and the next.
func (s *Server) readInbox(
	ctx context.Context,
	claims host.Claims,
	limit int,
	cursor *taskCursor,
) ([]InboxItem, *string, error) {
	items := []InboxItem{}
	var next *string
	var cursorAt any
	var cursorID any
	if cursor != nil {
		cursorAt, cursorID = cursor.updatedAt, cursor.taskID
	}
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `
				SELECT ts.task_id, ts.title, ts.display_state, ts.updated_at
				FROM work.task_summary ts
				WHERE ts.org_id = $1 AND ts.owner_subject_id = $2
				  AND ts.display_state IN ('awaiting_acceptance', 'failed', 'reconciling')
				  AND ($3::timestamptz IS NULL
				       OR (ts.updated_at, ts.task_id) < ($3::timestamptz, $4::uuid))
				ORDER BY ts.updated_at DESC, ts.task_id DESC
				LIMIT $5`,
				claims.OrgID, claims.SubjectID, cursorAt, cursorID, limit+1,
			)
			if err != nil {
				return err
			}
			defer rows.Close()
			hasMore := false
			for rows.Next() {
				var item InboxItem
				if err := rows.Scan(&item.TaskID, &item.Title, &item.DisplayState,
					&item.UpdatedAt); err != nil {
					return err
				}
				if len(items) >= limit {
					hasMore = true
					continue
				}
				item.Type = inboxTypes[item.DisplayState]
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

// optionalTaskCursor decodes the shared opaque (updated_at, task_id) cursor,
// returning nil for the first page. A malformed cursor is invalid_pagination,
// not a silent first page: a client that keeps polling with a stale or corrupt
// cursor must learn that its window is gone rather than receive page one again.
func optionalTaskCursor(raw string) (*taskCursor, error) {
	if raw == "" {
		return nil, nil
	}
	cursor, err := parseTaskCursor(raw)
	if err != nil {
		return nil, err
	}
	return &cursor, nil
}
