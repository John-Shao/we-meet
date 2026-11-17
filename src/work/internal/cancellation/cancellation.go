// Package cancellation consumes work.cancellation_intent, the governance cancel backlog.
//
// Authority: docs/work/design/work-r0b-control-design-2026-10-30.md §6.1. Deny producers
// (0023's narrowing commands and the operator suspension, 0040's revoke_device and
// revoke_workspace_grant) queue one intent per affected Run beside the deny. This package
// is the consumer that was missing: it claims due intents, re-checks the scope predicate
// inside the Task lock through work.consume_cancellation_intent, and records failures on
// §6.1's 1s..60s ladder through work.fail_cancellation_intent.
//
// The consumer is a work_worker and nothing else. Every call runs under
// workdb.WithWorkerOrgContext for one explicitly configured organization: under FORCE RLS a
// worker cannot enumerate orgs, and a cross-tenant claim would need a new visibility switch
// like app.outbox_relay. The lead ruled that out, so the org list is configuration, exactly
// as work-reconcile-scan and work-export already do it.
//
// It sends no frame and writes no terminal Run state. The consume command enters the
// registered cancel_requested path and writes the same outbox cancel_signal hand-off
// request_cancel writes; the relay turns that into a Temporal signal for a cloud Run, and
// for a local Run the state change is what the gateway's cancel getter delivers to the
// device (GW15). Cancellation intents must NOT be routed through the relay's outbox kind
// list: §6.1 forbids it and relay.go's default branch fails unknown kinds non-retryably.
//
// One Pass is bounded: at most TaskLimit Tasks and IntentLimit intents per org, oldest due
// first. Whatever the caps leave behind stays pending at its original next_attempt and is
// picked up by the next pass, never skipped. A pass is driven by a systemd timer rather than
// a resident loop, so a crashed pass costs nothing: the claim's 60s visibility window expires
// on its own and the intents become due again.
package cancellation

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
)

// Config carries the org list and the two §6.1 claim caps. The caps are clamped again by
// the claim command, so a misconfigured value cannot widen the round beyond the ruling.
type Config struct {
	Orgs        []string
	TaskLimit   int
	IntentLimit int
}

type Consumer struct {
	pool   *pgxpool.Pool
	config Config
	logger *log.Logger
}

// Intent is one claimed row. The claim returns the dedup key (source_event_id, run_id) plus
// the Task it belongs to and the attempt count, so a failure can be logged without a re-read.
type Intent struct {
	SourceEventID string `json:"source_event_id"`
	RunID         string `json:"run_id"`
	TaskID        string `json:"task_id"`
	Reason        string `json:"reason"`
	Attempts      int    `json:"attempts"`
}

type consumeResult struct {
	Outcome            string  `json:"outcome"`
	State              string  `json:"state"`
	CancelRevision     *string `json:"cancel_revision"`
	CanceledOperations int     `json:"canceled_operations"`
}

type failResult struct {
	State        string `json:"state"`
	Attempts     int    `json:"attempts"`
	DeadLettered bool   `json:"dead_lettered"`
	NextAttempt  string `json:"next_attempt"`
}

func New(pool *pgxpool.Pool, config Config, logger *log.Logger) (*Consumer, error) {
	if pool == nil {
		return nil, errors.New("cancellation requires a pool")
	}
	orgs := make([]string, 0, len(config.Orgs))
	seen := map[string]bool{}
	for _, org := range config.Orgs {
		org = strings.TrimSpace(org)
		if org == "" || seen[org] {
			continue
		}
		seen[org] = true
		orgs = append(orgs, org)
	}
	if len(orgs) == 0 {
		return nil, errors.New("cancellation requires at least one configured org")
	}
	config.Orgs = orgs
	if config.TaskLimit <= 0 {
		config.TaskLimit = 100
	}
	if config.IntentLimit <= 0 {
		config.IntentLimit = 500
	}
	if logger == nil {
		logger = log.Default()
	}
	return &Consumer{pool: pool, config: config, logger: logger}, nil
}

// Pass runs one bounded round over every configured org. An org that fails does not stop the
// others: the backlog of a healthy org must not wait on a broken one. The first error is
// returned so the caller can mark the unit red, and the count covers every org attempted.
func (c *Consumer) Pass(ctx context.Context) (int, error) {
	total := 0
	var firstErr error
	for _, org := range c.config.Orgs {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := c.Once(ctx, org)
		total += n
		if err != nil {
			c.logger.Printf("work cancel pass failed org_id=%s intents=%d error=%v", org, n, err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return total, firstErr
}

// Once claims and consumes at most one batch for one org. It is exported for tests and for
// an operator who needs a single bounded round. A consume refusal is recorded on the failure
// ladder and logged, not returned: only a claim failure or a ladder write that itself could
// not land is an infrastructure error the caller must act on.
func (c *Consumer) Once(ctx context.Context, orgID string) (int, error) {
	intents, err := c.claim(ctx, orgID)
	if err != nil {
		return 0, err
	}
	for _, intent := range intents {
		if err := ctx.Err(); err != nil {
			return len(intents), err
		}
		if err := c.consume(ctx, orgID, intent); err != nil {
			return len(intents), err
		}
	}
	return len(intents), nil
}

func (c *Consumer) claim(ctx context.Context, orgID string) ([]Intent, error) {
	intents := []Intent{}
	err := workdb.WithWorkerOrgContext(ctx, c.pool, orgID, func(tx pgx.Tx) error {
		var body []byte
		if err := tx.QueryRow(ctx,
			`SELECT work.claim_pending_cancellation_intents($1, $2, $3)`,
			orgID, c.config.TaskLimit, c.config.IntentLimit).Scan(&body); err != nil {
			return err
		}
		var claimed struct {
			Intents []Intent `json:"intents"`
		}
		if err := json.Unmarshal(body, &claimed); err != nil {
			return err
		}
		intents = claimed.Intents
		return nil
	})
	return intents, err
}

func (c *Consumer) consume(ctx context.Context, orgID string, intent Intent) error {
	var result consumeResult
	err := workdb.WithWorkerOrgContext(ctx, c.pool, orgID, func(tx pgx.Tx) error {
		var body []byte
		if err := tx.QueryRow(ctx,
			`SELECT work.consume_cancellation_intent($1, $2::uuid, $3::uuid)`,
			orgID, intent.SourceEventID, intent.RunID).Scan(&body); err != nil {
			return err
		}
		return json.Unmarshal(body, &result)
	})
	if err == nil {
		revision := ""
		if result.CancelRevision != nil {
			revision = *result.CancelRevision
		}
		c.logger.Printf("work cancel consumed org_id=%s run_id=%s restriction_id=%s outcome=%s cancel_revision=%s canceled_operations=%d",
			orgID, intent.RunID, intent.SourceEventID, result.Outcome, revision, result.CanceledOperations)
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	code := failureCode(err)
	// The intent moved under us (ops replayed it, or it is already dead_letter). It is no
	// longer the worker's to fail, and fail_cancellation_intent would refuse it too.
	if code == "cancellation_intent_not_pending" {
		c.logger.Printf("work cancel skipped org_id=%s run_id=%s restriction_id=%s code=%s",
			orgID, intent.RunID, intent.SourceEventID, code)
		return nil
	}
	retryable := retryableFailure(err)
	if failErr := c.fail(ctx, orgID, intent, retryable); failErr != nil {
		return failErr
	}
	return nil
}

func (c *Consumer) fail(ctx context.Context, orgID string, intent Intent, retryable bool) error {
	var result failResult
	err := workdb.WithWorkerOrgContext(ctx, c.pool, orgID, func(tx pgx.Tx) error {
		var body []byte
		if err := tx.QueryRow(ctx,
			`SELECT work.fail_cancellation_intent($1, $2::uuid, $3::uuid, $4)`,
			orgID, intent.SourceEventID, intent.RunID, retryable).Scan(&body); err != nil {
			return err
		}
		return json.Unmarshal(body, &result)
	})
	if err != nil {
		return err
	}
	c.logger.Printf("work cancel failed org_id=%s run_id=%s restriction_id=%s retryable=%t state=%s attempts=%d next_attempt=%s",
		orgID, intent.RunID, intent.SourceEventID, retryable, result.State, result.Attempts, result.NextAttempt)
	return nil
}

// failureCode reads the business code a definer command raised. The catalog's commands raise
// the code as the message with a P0001/P0002 SQLSTATE, so the message is the code.
func failureCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Message
	}
	return ""
}

// retryableFailure separates a refusal another attempt cannot change from a transient one.
// Privilege, transition/shape and invalid-argument SQLSTATEs are permanent configuration or
// content faults; so are the three business codes that name a fact outside this consumer's
// authority. Everything else - a deny not yet visible, a serialization failure, a lost
// connection - goes on §6.1's ladder and dead-letters with an audit alert at ten attempts.
func retryableFailure(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return true
	}
	switch pgErr.Code {
	case "42501", "23514", "22023", "42883", "42P01":
		return false
	}
	switch pgErr.Message {
	case "run_not_found", "org_context_mismatch", "invalid_reason_code":
		return false
	}
	return true
}