package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/dispatch"
	"github.com/we-meet/work/internal/finishing"
)

type config struct {
	orgID             string
	operationID       string
	runID             string
	resolution        string
	providerRequestID string
	settledTokens     int64
	evidenceRef       string
	resume            bool
	signalOnly        bool
	finishFromReceipt bool
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	var cfg config
	flag.StringVar(&cfg.orgID, "org", "", "organization id (required)")
	flag.StringVar(&cfg.operationID, "operation", "", "operation id (required)")
	flag.StringVar(&cfg.runID, "run", "", "run id (defaults to the operation's run)")
	flag.StringVar(&cfg.resolution, "resolution", "", "sent_succeeded|not_sent|unresolved (required)")
	flag.StringVar(&cfg.providerRequestID, "provider-request-id", "", "provider request id, if known")
	flag.Int64Var(&cfg.settledTokens, "settled-tokens", 0, "tokens to settle for sent_succeeded")
	flag.StringVar(&cfg.evidenceRef, "evidence-ref", "", "evidence reference; required unless unresolved")
	flag.BoolVar(&cfg.resume, "resume", false, "signal the RunWorkflow to resume after reconciliation")
	flag.BoolVar(&cfg.signalOnly, "signal-only", false,
		"deliver the resume signal without reconciling: for an Operation no resolution accepts, "+
			"so the worker's own close path decides the outcome from the dispatch gate")
	flag.BoolVar(&cfg.finishFromReceipt, "finish-from-receipt", false,
		"recover a confirmed model success from the trusted receipt instead of reconciling by resolution")
	flag.Parse()

	if cfg.orgID == "" || cfg.operationID == "" {
		return errors.New("-org and -operation are required")
	}
	if cfg.signalOnly {
		if cfg.finishFromReceipt || cfg.resolution != "" {
			return errors.New("-signal-only cannot be combined with -resolution or -finish-from-receipt")
		}
		cfg.resume = true
	} else if !cfg.finishFromReceipt {
		switch cfg.resolution {
		case "sent_succeeded", "not_sent":
			if cfg.evidenceRef == "" {
				return errors.New("-evidence-ref is required for sent_succeeded/not_sent")
			}
		case "unresolved":
			if cfg.resume {
				return errors.New("-resume is not allowed for unresolved")
			}
		default:
			return errors.New("-resolution must be sent_succeeded, not_sent or unresolved")
		}
	}
	databaseURL := os.Getenv("WORK_DATABASE_URL")
	if databaseURL == "" {
		return errors.New("WORK_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := workdb.OpenPool(ctx, databaseURL, "work-reconcile")
	if err != nil {
		return err
	}
	defer pool.Close()

	runID := cfg.runID
	if err := workdb.WithWorkerOrgContext(ctx, pool, cfg.orgID, func(tx pgx.Tx) error {
		var actualRun string
		if err := tx.QueryRow(ctx, `SELECT run_id FROM work.operation WHERE id = $1 AND org_id = $2`,
			cfg.operationID, cfg.orgID).Scan(&actualRun); err != nil {
			return err
		}
		if runID == "" {
			runID = actualRun
		}
		if runID != actualRun {
			return fmt.Errorf("operation belongs to run %s, not %s", actualRun, runID)
		}
		return nil
	}); err != nil {
		return err
	}
	var recovered *finishing.Outcome
	if cfg.signalOnly {
		// Nothing is written here: the workflow re-enters its own finish/abort
		// path, which reads the dispatch gate as the authority.
	} else if cfg.finishFromReceipt {
		outcome, err := recoverFromReceipt(ctx, pool, cfg.orgID, cfg.operationID)
		if err != nil {
			return err
		}
		recovered = &outcome
	} else {
		var providerRequestID, evidenceRef any
		if cfg.providerRequestID != "" {
			providerRequestID = cfg.providerRequestID
		}
		if cfg.evidenceRef != "" {
			evidenceRef = cfg.evidenceRef
		}
		if err := workdb.WithWorkerOrgContext(ctx, pool, cfg.orgID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT work.reconcile_operation($1::text, $2::uuid, $3::text, $4::text, $5::bigint, $6::text)`,
				cfg.orgID, cfg.operationID, cfg.resolution, providerRequestID, cfg.settledTokens, evidenceRef)
			return err
		}); err != nil {
			return err
		}
	}

	resumed := false
	if cfg.resume {
		dispatcher, err := dispatch.NewTemporal(dispatch.TemporalConfig{
			Address:      os.Getenv("WORK_TEMPORAL_ADDRESS"),
			Namespace:    os.Getenv("WORK_TEMPORAL_NAMESPACE"),
			TaskQueue:    os.Getenv("WORK_TEMPORAL_TASK_QUEUE"),
			WorkflowType: os.Getenv("WORK_TEMPORAL_WORKFLOW_TYPE"),
			CertFile:     os.Getenv("WORK_TEMPORAL_CERT"),
			KeyFile:      os.Getenv("WORK_TEMPORAL_KEY"),
			CAFile:       os.Getenv("WORK_TEMPORAL_CA"),
			ServerName:   os.Getenv("WORK_TEMPORAL_SERVER_NAME"),
		})
		if err != nil {
			return fmt.Errorf("reconcile committed but Temporal client failed: %w", err)
		}
		defer dispatcher.Close()
		if err := dispatcher.SignalWorkflow(ctx, "run:"+runID, "resume", map[string]any{
			"request_id": "reconcile:" + cfg.operationID,
			"reason":     "operator_reconcile",
		}); err != nil {
			return fmt.Errorf("reconcile committed but resume signal failed: %w", err)
		}
		resumed = true
	}
	output := map[string]any{
		"operation_id": cfg.operationID,
		"run_id":       runID,
		"resolution":   cfg.resolution,
		"signal_only":  cfg.signalOnly,
		"resumed":      resumed,
	}
	if recovered != nil {
		output["recovered"] = recovered.Status
		output["receipt_hash"] = recovered.ReceiptHash
		output["usage_source"] = recovered.UsageSource
		output["settlement_tokens"] = recovered.SettlementTokens
	}
	body, _ := json.Marshal(output)
	fmt.Println(string(body))
	return nil
}

// recoverFromReceipt finishes an operation from its trusted receipt. It is the
// operator path for a confirmed model success whose activity died before it
// could settle or publish; it never re-sends the provider request.
func recoverFromReceipt(
	ctx context.Context, pool *pgxpool.Pool, orgID, operationID string,
) (finishing.Outcome, error) {
	key, err := content.EncodeMasterKey(os.Getenv("WORK_CONTENT_MASTER_KEY"))
	if err != nil {
		return finishing.Outcome{}, errors.New("WORK_CONTENT_MASTER_KEY is required for -finish-from-receipt")
	}
	directory := os.Getenv("WORK_CONTENT_DIR")
	if directory == "" {
		directory = "/var/lib/work/content"
	}
	store, err := content.NewLocal(key, directory, 1)
	if err != nil {
		return finishing.Outcome{}, err
	}
	finisher := &finishing.Finisher{Pool: pool, Content: store, Now: time.Now}
	return finisher.FinishFromReceipt(ctx, orgID, operationID)
}
