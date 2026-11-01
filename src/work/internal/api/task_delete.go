package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

// deleteTask serves the contract's DELETE /work/v1/tasks/{taskId}. work.delete_task
// keeps the ledger and audit rows and tombstones the content, and returns 0 without
// re-checking the revision when the task is already deleted, so repeat calls stay 200.
func (s *Server) deleteTask(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	taskID := r.PathValue("taskId")
	if !validUUID(taskID) {
		writeAPIError(w, correlationID, apierr.New("task_not_found"))
		return
	}
	rawRevision := strings.TrimSpace(r.URL.Query().Get("expected_revision"))
	expectedRevision, err := strconv.ParseInt(rawRevision, 10, 64)
	if err != nil || expectedRevision < 0 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}

	var deletedAt time.Time
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var refs int
			if err := tx.QueryRow(r.Context(),
				`SELECT work.delete_task($1, $2, $3, $4, NULL)`,
				claims.OrgID, taskID, claims.SubjectID, expectedRevision,
			).Scan(&refs); err != nil {
				return err
			}
			// now() is the transaction timestamp, which is the same value
			// delete_task wrote into deleted_at.
			return tx.QueryRow(r.Context(), `SELECT now()`).Scan(&deletedAt)
		},
	)
	if err != nil {
		if quiescent := asQuiescenceError(err); quiescent != nil {
			writeAPIError(w, correlationID, quiescent)
			return
		}
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"task_id":       taskID,
		"deleted_at":    deletedAt.UTC().Format(time.RFC3339),
		"content_purge": "scheduled",
	})
}

// asQuiescenceError keeps run_not_quiescent a 409 with its own code. The SQL
// raises it without DETAIL, while the generic mapper expects a revision detail
// for every P0001, so it would otherwise degrade to service_degraded.
func asQuiescenceError(err error) *apierr.Error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return nil
	}
	if !strings.HasPrefix(pgErr.Message, "run_not_quiescent") {
		return nil
	}
	return apierr.New("run_not_quiescent")
}
