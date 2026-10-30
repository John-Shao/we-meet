package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/dispatch"
)

type scanRun struct {
	RunID            string `json:"run_id"`
	WorkflowID       string `json:"workflow_id"`
	RunState         string `json:"run_state"`
	TaskState        string `json:"task_state"`
	OperationID      string `json:"operation_id,omitempty"`
	OperationState   string `json:"operation_state,omitempty"`
	GateState        string `json:"gate_state,omitempty"`
	ReceiptResult    string `json:"receipt_result,omitempty"`
	ReservationState string `json:"reservation_state,omitempty"`
	SettledTokens    int64  `json:"settled_tokens"`
	WorkflowStatus   string `json:"workflow_status"`
	WorkflowError    string `json:"workflow_error,omitempty"`
	Orphan           bool   `json:"orphan"`
}

// scanOpenRuns is read-only. It reports open DB Runs and the Temporal status of
// their workflow so an operator can find orphaned Runs without mutating them.
func scanOpenRuns(ctx context.Context, pool *pgxpool.Pool, orgID string) error {
	config := dispatch.TemporalConfig{
		Address:    os.Getenv("WORK_TEMPORAL_ADDRESS"),
		Namespace:  os.Getenv("WORK_TEMPORAL_NAMESPACE"),
		TaskQueue:  os.Getenv("WORK_TEMPORAL_TASK_QUEUE"),
		CertFile:   os.Getenv("WORK_TEMPORAL_CERT"),
		KeyFile:    os.Getenv("WORK_TEMPORAL_KEY"),
		CAFile:     os.Getenv("WORK_TEMPORAL_CA"),
		ServerName: os.Getenv("WORK_TEMPORAL_SERVER_NAME"),
	}
	if strings.TrimSpace(config.Address) == "" {
		return errors.New("WORK_TEMPORAL_ADDRESS is required for -scan")
	}
	temporal, err := dispatch.NewTemporal(config)
	if err != nil {
		return fmt.Errorf("temporal client unavailable for -scan: %w", err)
	}
	defer temporal.Close()

	var runs []scanRun
	err = workdb.WithWorkerOrgContext(ctx, pool, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT r.id::text, COALESCE(r.workflow_id, ''), r.state, t.state,
			       COALESCE(o.id::text, ''), COALESCE(o.state, ''),
			       COALESCE(d.gate_state, ''), COALESCE(d.receipt_result, ''),
			       COALESCE(q.state, ''), COALESCE(q.settled_tokens, 0)
			  FROM work.run r
			  JOIN work.task t ON t.id = r.task_id AND t.org_id = r.org_id
			  LEFT JOIN work.operation o ON o.run_id = r.id AND o.org_id = r.org_id
			  LEFT JOIN work.dispatch_delivery d
			         ON d.operation_id = o.id AND d.org_id = o.org_id
			  LEFT JOIN LATERAL (
			        SELECT state, settled_tokens
			          FROM work.quota_reservation q
			         WHERE q.operation_id = o.id AND q.org_id = o.org_id
			         ORDER BY reservation_seq DESC
			         LIMIT 1
			  ) q ON true
			 WHERE r.org_id = $1
			   AND r.state IN ('queued', 'active', 'waiting', 'cancel_requested')
			 ORDER BY r.created_at`,
			orgID,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var run scanRun
			if err := rows.Scan(
				&run.RunID, &run.WorkflowID, &run.RunState, &run.TaskState,
				&run.OperationID, &run.OperationState,
				&run.GateState, &run.ReceiptResult,
				&run.ReservationState, &run.SettledTokens,
			); err != nil {
				return err
			}
			runs = append(runs, run)
		}
		return rows.Err()
	})
	if err != nil {
		return err
	}

	for index := range runs {
		status, err := temporal.DescribeWorkflowStatus(ctx, runs[index].WorkflowID)
		if err != nil {
			runs[index].WorkflowStatus = "Unavailable"
			runs[index].WorkflowError = "describe_failed"
			continue
		}
		runs[index].WorkflowStatus = status
		runs[index].Orphan = isOrphan(status)
	}

	body, err := json.MarshalIndent(map[string]any{
		"org_id": orgID,
		"runs":   runs,
	}, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(body))
	return nil
}

func isOrphan(workflowStatus string) bool {
	return workflowStatus != "Running" && workflowStatus != "Unavailable"
}
