// Package relay delivers work.outbox rows to their side effects.
//
// API and domain functions only write PostgreSQL facts plus outbox rows. This
// process is the single place that starts/cancels Temporal workflows and
// deletes content objects, so API requests never block on those systems.
package relay

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
)

var ErrWorkflowNotFound = errors.New("workflow not found")

type StartWorkflowRequest struct {
	OrgID      string
	RunID      string
	WorkflowID string
}

type Dispatcher interface {
	StartWorkflow(ctx context.Context, request StartWorkflowRequest) error
	CancelWorkflow(ctx context.Context, workflowID string) error
}

type Config struct {
	RelayID      string
	BatchSize    int
	LeaseSeconds int
	PollInterval time.Duration
}

type Relay struct {
	pool       *pgxpool.Pool
	content    content.Store
	dispatcher Dispatcher
	config     Config
	logger     *log.Logger
}

type Event struct {
	ID            string
	OrgID         string
	AggregateType string
	AggregateID   string
	EventID       string
	Payload       []byte
	Attempts      int
}

type payload struct {
	Kind        string   `json:"kind"`
	RunID       string   `json:"run_id"`
	WorkflowID  string   `json:"workflow_id"`
	ContentRefs []string `json:"content_refs"`
}

type failure struct {
	code      string
	retryable bool
}

func (f *failure) Error() string { return f.code }

func New(pool *pgxpool.Pool, store content.Store, dispatcher Dispatcher, config Config, logger *log.Logger) (*Relay, error) {
	if pool == nil || dispatcher == nil {
		return nil, errors.New("relay requires pool and dispatcher")
	}
	if config.RelayID == "" {
		return nil, errors.New("relay id is required")
	}
	if config.BatchSize <= 0 {
		config.BatchSize = 20
	}
	if config.LeaseSeconds <= 0 {
		config.LeaseSeconds = 60
	}
	if config.PollInterval <= 0 {
		config.PollInterval = time.Second
	}
	if logger == nil {
		logger = log.Default()
	}
	return &Relay{
		pool: pool, content: store, dispatcher: dispatcher,
		config: config, logger: logger,
	}, nil
}

func (r *Relay) Run(ctx context.Context) error {
	for {
		n, err := r.Once(ctx)
		if err != nil && ctx.Err() == nil {
			r.logger.Printf("work relay pass failed relay_id=%s events=%d error=%v", r.config.RelayID, n, err)
		}
		if n >= r.config.BatchSize {
			continue
		}
		timer := time.NewTimer(r.config.PollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// Once claims and processes at most one batch. It is exported for tests and
// for a future reconciler that needs a bounded pass.
func (r *Relay) Once(ctx context.Context) (int, error) {
	events, err := r.claim(ctx)
	if err != nil {
		return 0, err
	}
	for _, event := range events {
		if err := r.deliver(ctx, event); err != nil {
			if ctx.Err() != nil {
				return len(events), ctx.Err()
			}
			r.logger.Printf("work relay delivery failed relay_id=%s event_id=%s kind=%s error=%v",
				r.config.RelayID, event.EventID, eventKind(event), err)
		}
	}
	return len(events), nil
}

func (r *Relay) claim(ctx context.Context) ([]Event, error) {
	events := []Event{}
	err := workdb.WithRelayContext(ctx, r.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, org_id, aggregate_type, aggregate_id, event_id, payload, attempts
			FROM work.claim_outbox($1, $2, $3)`,
			r.config.RelayID, r.config.BatchSize, r.config.LeaseSeconds,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var event Event
			if err := rows.Scan(&event.ID, &event.OrgID, &event.AggregateType,
				&event.AggregateID, &event.EventID, &event.Payload, &event.Attempts); err != nil {
				return err
			}
			event.Payload = append([]byte(nil), event.Payload...)
			events = append(events, event)
		}
		return rows.Err()
	})
	return events, err
}

func (r *Relay) deliver(ctx context.Context, event Event) error {
	kind := eventKind(event)
	var body payload
	if len(event.Payload) > 0 {
		if err := json.Unmarshal(event.Payload, &body); err != nil {
			return r.fail(ctx, event, "invalid_outbox_payload", false)
		}
	}
	switch kind {
	case "task_event":
		// Task events are read from work.task_event by the API SSE stream.
		// The outbox copy is a routing record in R0a, so acknowledge it here
		// instead of building a second event bus.
		return r.ack(ctx, event)
	case "start_workflow":
		if body.RunID == "" || body.WorkflowID == "" {
			return r.fail(ctx, event, "invalid_outbox_payload", false)
		}
		if err := r.dispatcher.StartWorkflow(ctx, StartWorkflowRequest{
			OrgID: event.OrgID, RunID: body.RunID, WorkflowID: body.WorkflowID,
		}); err != nil {
			return r.fail(ctx, event, "temporal_start_failed", true)
		}
		return r.ack(ctx, event)
	case "cancel_signal":
		if body.RunID == "" {
			return r.fail(ctx, event, "invalid_outbox_payload", false)
		}
		return r.cancel(ctx, event, body.RunID)
	case "content_shred":
		return r.shred(ctx, event, body.ContentRefs)
	default:
		return r.fail(ctx, event, "unknown_outbox_kind", false)
	}
}

func (r *Relay) cancel(ctx context.Context, event Event, runID string) error {
	workflowID, state, err := r.runState(ctx, event.OrgID, runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return r.fail(ctx, event, "run_not_found", false)
	}
	if err != nil {
		return r.fail(ctx, event, "run_lookup_failed", true)
	}
	if terminalRunState(state) {
		return r.ack(ctx, event)
	}
	if workflowID == "" {
		return r.fail(ctx, event, "workflow_id_missing", false)
	}
	if err := r.dispatcher.CancelWorkflow(ctx, workflowID); err != nil {
		if errors.Is(err, ErrWorkflowNotFound) {
			if _, current, lookupErr := r.runState(ctx, event.OrgID, runID); lookupErr == nil && terminalRunState(current) {
				return r.ack(ctx, event)
			}
			return r.fail(ctx, event, "workflow_missing", true)
		}
		return r.fail(ctx, event, "temporal_cancel_failed", true)
	}
	return r.ack(ctx, event)
}

func (r *Relay) shred(ctx context.Context, event Event, refs []string) error {
	if r.content == nil {
		return r.fail(ctx, event, "content_store_unavailable", true)
	}
	for _, ref := range refs {
		if err := r.content.Delete(ctx, event.OrgID, ref); err != nil {
			return r.fail(ctx, event, "content_delete_failed", true)
		}
	}
	return r.ack(ctx, event)
}

func (r *Relay) runState(ctx context.Context, orgID, runID string) (string, string, error) {
	var workflowID, state string
	err := workdb.WithWorkerOrgContext(ctx, r.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT workflow_id, state FROM work.run
			WHERE id = $1 AND org_id = $2`,
			runID, orgID,
		).Scan(&workflowID, &state)
	})
	return workflowID, state, err
}

func (r *Relay) ack(ctx context.Context, event Event) error {
	return workdb.WithRelayContext(ctx, r.pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.mark_outbox_delivered($1, $2)`,
			event.EventID, r.config.RelayID)
		return err
	})
}

func (r *Relay) fail(ctx context.Context, event Event, code string, retryable bool) error {
	var outcome string
	err := workdb.WithRelayContext(ctx, r.pool, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.mark_outbox_failed($1, $2, $3, $4)`,
			event.EventID, r.config.RelayID, code, retryable).Scan(&outcome)
	})
	if err != nil {
		return err
	}
	r.logger.Printf("work relay marked failed relay_id=%s event_id=%s code=%s retryable=%t outcome=%s",
		r.config.RelayID, event.EventID, code, retryable, outcome)
	return &failure{code: code, retryable: retryable}
}

func eventKind(event Event) string {
	var body struct {
		Kind string `json:"kind"`
	}
	if len(event.Payload) > 0 && json.Unmarshal(event.Payload, &body) == nil && body.Kind != "" {
		return body.Kind
	}
	if event.AggregateType == "task" {
		return "task_event"
	}
	return ""
}

func terminalRunState(state string) bool {
	switch state {
	case "succeeded", "failed", "canceled":
		return true
	default:
		return false
	}
}
