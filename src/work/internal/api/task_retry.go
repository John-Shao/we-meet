package api

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

const TaskRunsPath = "/work/v1/tasks/{taskId}/runs"

type retryTaskRequest struct {
	ClientRequestID  string `json:"client_request_id"`
	ExpectedRevision *int64 `json:"expected_revision"`
	Target           *struct {
		Kind    string `json:"kind"`
		Profile string `json:"profile"`
	} `json:"target"`
	Reason string `json:"reason"`
}

// retryTask creates the next Run for a task whose last Run ended failed/canceled.
// work.retry_task keeps the task snapshot, enforces the revision and dedupes on
// client_request_id, so a network retry cannot start a second Run.
func (s *Server) retryTask(w http.ResponseWriter, r *http.Request) {
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
	var body retryTaskRequest
	if err := decodeStrictJSONBody(r.Body, &body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_json"))
		return
	}
	if !validClientRequestID(body.ClientRequestID) || body.ExpectedRevision == nil ||
		*body.ExpectedRevision < 0 || len([]rune(body.Reason)) > 500 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	// R0a executes in the cloud text profile only; anything else is refused
	// before the domain function sees it.
	if body.Target == nil || body.Target.Kind != "cloud" || body.Target.Profile != "text-v1" {
		writeAPIError(w, correlationID, apierr.New("execution_target_unavailable"))
		return
	}

	var runID string
	var revision int64
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(), `
				SELECT run_id, revision
				FROM work.retry_task($1, $2::uuid, $3, $4, $5, $6, $7)`,
				claims.OrgID, taskID, claims.SubjectID, body.ClientRequestID,
				*body.ExpectedRevision, "", s.executionRuntimeVersion(),
			).Scan(&runID, &revision)
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"task_id":       taskID,
		"run_id":        runID,
		"revision":      revision,
		"task_state":    "open",
		"display_state": "queued",
	})
}
