package api

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
)

const (
	RunOperationsPath = "/work/v1/runs/{runId}/operations"

	operationsDefaultLimit = 20
)

// Operation is the run's execution ledger without any body material: the columns
// below are identity, classification and status only. The request hash and the
// receipt reference are content *locators*, which is what the summary promises
// ("不含正文"); the provider answer, the model request bytes and the tool
// arguments live in tables this query never names.
type Operation struct {
	ID                string     `json:"id"`
	RunID             string     `json:"run_id"`
	LogicalKey        string     `json:"logical_key"`
	Kind              string     `json:"kind"`
	State             string     `json:"state"`
	RequestHash       string     `json:"request_hash"`
	ProviderRequestID *string    `json:"provider_request_id"`
	ReceiptRef        *string    `json:"receipt_ref"`
	Revision          int64      `json:"revision"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

type OperationPage struct {
	Items      []Operation `json:"items"`
	NextCursor *string     `json:"next_cursor"`
}

// listOperations answers "what is this Run doing right now". The run must be the
// caller's own before any operation row is read, so a foreign runId is a 404
// rather than an empty page - an empty page would say "this run has nothing
// pending", which is a fact about somebody else's run.
func (s *Server) listOperations(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	if !validUUID(runID) {
		writeAPIError(w, correlationID, apierr.New("run_not_found"))
		return
	}
	limit, err := parsePageLimit(r.URL.Query().Get("limit"), operationsDefaultLimit)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_pagination"))
		return
	}
	cursor, err := parseOperationCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_pagination"))
		return
	}
	if err := s.requireSeat(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	items, next, err := s.readRunOperations(r.Context(), claims, runID, limit, cursor)
	if errors.Is(err, pgx.ErrNoRows) {
		// loadRun found no run this caller owns. That is a 404 and not an empty
		// page: an empty page would be a claim about somebody else's Run.
		writeAPIError(w, correlationID, apierr.New("run_not_found"))
		return
	}
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, OperationPage{Items: items, NextCursor: next})
}

func (s *Server) readRunOperations(
	ctx context.Context,
	claims host.Claims,
	runID string,
	limit int,
	cursor *operationCursor,
) ([]Operation, *string, error) {
	items := []Operation{}
	var next *string
	var cursorAt any
	var cursorID any
	if cursor != nil {
		cursorAt, cursorID = cursor.createdAt, cursor.operationID
	}
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			// loadRun owns the run-to-task-to-owner chain, so this endpoint cannot
			// scope operations differently from GET /work/v1/runs/{runId}.
			if _, err := loadRun(ctx, tx, runID, claims); err != nil {
				return err
			}
			rows, err := tx.Query(ctx, `
				SELECT o.id, o.run_id, o.logical_key, o.kind, o.state, o.request_hash,
				       o.provider_request_id, o.receipt_ref, o.revision,
				       o.created_at, o.updated_at
				FROM work.operation o
				WHERE o.org_id = $1 AND o.run_id = $2::uuid
				  AND ($3::timestamptz IS NULL
				       OR (o.created_at, o.id) < ($3::timestamptz, $4::uuid))
				ORDER BY o.created_at DESC, o.id DESC
				LIMIT $5`,
				claims.OrgID, runID, cursorAt, cursorID, limit+1,
			)
			if err != nil {
				return err
			}
			defer rows.Close()
			hasMore := false
			for rows.Next() {
				var item Operation
				if err := rows.Scan(&item.ID, &item.RunID, &item.LogicalKey, &item.Kind,
					&item.State, &item.RequestHash, &item.ProviderRequestID,
					&item.ReceiptRef, &item.Revision, &item.CreatedAt,
					&item.UpdatedAt); err != nil {
					return err
				}
				if len(items) >= limit {
					hasMore = true
					continue
				}
				items = append(items, item)
			}
			if err := rows.Err(); err != nil {
				return err
			}
			if hasMore && len(items) > 0 {
				last := items[len(items)-1]
				encoded := encodeOperationCursor(last.CreatedAt, last.ID)
				next = &encoded
			}
			return nil
		},
	)
	return items, next, err
}

// operationCursor pages the ledger newest-first, which is what an observer of a
// live Run asks for. (created_at, id) is the sort key and the seek key together,
// so a row inserted while a page is open cannot shift an earlier row into a
// later page. The wire format is the same opaque "<RFC3339Nano>|<uuid>" in
// base64url as the task list's, because clients treat cursors as opaque strings
// and a second shape would buy nothing.
type operationCursor struct {
	createdAt   time.Time
	operationID string
}

func encodeOperationCursor(createdAt time.Time, operationID string) string {
	return base64.RawURLEncoding.EncodeToString(
		[]byte(createdAt.UTC().Format(time.RFC3339Nano) + "|" + operationID),
	)
}

func parseOperationCursor(raw string) (*operationCursor, error) {
	if raw == "" {
		return nil, nil
	}
	body, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	parts := strings.SplitN(string(body), "|", 2)
	if len(parts) != 2 || !validUUID(parts[1]) {
		return nil, fmt.Errorf("invalid operation cursor")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return nil, err
	}
	return &operationCursor{createdAt: createdAt, operationID: parts[1]}, nil
}
