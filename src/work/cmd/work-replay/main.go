package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	apienum "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/we-meet/work/internal/dispatch"
	"github.com/we-meet/work/internal/runflow"
)

// work-replay is the read side of the pre-rollout check in
// docs/plan/work-operations-runbook-2026-10-25.md §5.32: before a work-worker swap, every workflow
// that is still open has to be replayed against the code that is about to run it.
//
// It has two modes because that check needs both halves, and only the consumer half existed until
// now - which is why §5.32 could say "replay first" without being able to say "and here is how you
// get the histories".
//
//	work-replay HISTORY.json [...]                    replay the shipped code against history files
//	work-replay -export WORKFLOW_ID[,RUN_ID] -out FILE   read one execution's history out of Temporal
//
// The export mode is read-only: it calls GetWorkflowHistory and writes a file. It changes no
// workflow, no reservation and no row.
const usage = `usage:
  work-replay HISTORY.json [...]
  work-replay -export WORKFLOW_ID[,RUN_ID] -out FILE

-export reads a workflow's full event history from Temporal and writes the JSON that the
replay mode above consumes. It is read-only and needs the same environment as
work-reconcile -scan: WORK_TEMPORAL_ADDRESS, WORK_TEMPORAL_NAMESPACE, WORK_TEMPORAL_CERT,
WORK_TEMPORAL_KEY, WORK_TEMPORAL_CA, WORK_TEMPORAL_SERVER_NAME.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}

	args := flag.NewFlagSet("work-replay", flag.ContinueOnError)
	args.SetOutput(os.Stderr)
	args.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	export := args.String("export", "",
		"workflow id, optionally followed by a comma and the run id, to export history from")
	output := args.String("out", "", "file to write the exported history to (required with -export)")
	deadline := args.Duration("timeout", 2*time.Minute, "give up on the export after this long")
	if err := args.Parse(os.Args[1:]); err != nil {
		os.Exit(2)
	}

	if *export != "" {
		if err := runExport(*export, *output, *deadline); err != nil {
			fmt.Fprintf(os.Stderr, "export %s: %v\n", *export, err)
			os.Exit(1)
		}
		return
	}

	files := args.Args()
	if len(files) == 0 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	replayer := newReplayer()
	failed := false
	for _, path := range files {
		if err := replayer.ReplayWorkflowHistoryFromJSONFile(nil, path); err != nil {
			fmt.Fprintf(os.Stderr, "replay %s: %v\n", path, err)
			failed = true
			continue
		}
		fmt.Printf("replay ok: %s\n", path)
	}
	if failed {
		os.Exit(1)
	}
}

// newReplayer registers exactly the two workflow types the worker runs, under the names the
// history carries. A type missing here is not a harmless omission: the replayer reports an
// unregistered type as a replay failure, which is the outcome a preflight must not read as "ok".
func newReplayer() worker.WorkflowReplayer {
	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflowWithOptions(runflow.RunWorkflow,
		workflow.RegisterOptions{Name: runflow.WorkflowName})
	replayer.RegisterWorkflowWithOptions(runflow.RunWorkflowAdvance,
		workflow.RegisterOptions{Name: runflow.WorkflowAdvanceName})
	return replayer
}

// historyFileBody is the only place the file format is decided. The consumer parses the file as a
// historypb.History (SDK internal_worker.go: extractHistoryFromFile unmarshals into that message
// with DiscardUnknown), so this marshals the same message with protojson defaults - camelCase field
// names and int64 as strings, which protojson accepts on both sides. Keeping it in one function is
// what lets replay_format_test.go prove the two legs agree, instead of trusting that they do.
func historyFileBody(history *historypb.History) ([]byte, error) {
	if history == nil || len(history.GetEvents()) == 0 {
		return nil, errors.New("refusing to write an empty history: an export that found no events " +
			"is a failure to read, not a workflow that did nothing")
	}
	body, err := protojson.Marshal(history)
	if err != nil {
		return nil, fmt.Errorf("marshal history: %w", err)
	}
	return body, nil
}

func writeHistoryFile(path string, history *historypb.History) (int, int, error) {
	body, err := historyFileBody(history)
	if err != nil {
		return 0, 0, err
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		return 0, 0, fmt.Errorf("write %s: %w", path, err)
	}
	return len(history.GetEvents()), len(body), nil
}

func runExport(spec, output string, timeout time.Duration) error {
	if strings.TrimSpace(output) == "" {
		return errors.New("-export needs -out FILE")
	}
	workflowID, runID, _ := strings.Cut(spec, ",")
	if strings.TrimSpace(workflowID) == "" {
		return errors.New("-export needs a workflow id")
	}
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
		return errors.New("WORK_TEMPORAL_ADDRESS is required for -export")
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	temporal, err := dispatch.NewTemporal(config)
	if err != nil {
		return err
	}
	defer temporal.Close()

	// isLongPoll stays false: a long poll on a Running workflow waits for the next event instead of
	// returning what already happened, and the preflight is supposed to finish before the rollout.
	iterator := temporal.Client().GetWorkflowHistory(ctx, workflowID, runID, false,
		apienum.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	events := []*historypb.HistoryEvent{}
	// HasNext keeps reporting true once the iterator has an error (SDK
	// internal_workflow_client.go:1873), so the failure surfaces from Next below instead of ending the
	// loop quietly - which is the difference between "export failed" and a truncated history that
	// replays as a determinism problem.
	for iterator.HasNext() {
		event, err := iterator.Next()
		if err != nil {
			return fmt.Errorf("read history: %w", err)
		}
		events = append(events, event)
	}

	count, bytes, err := writeHistoryFile(output, &historypb.History{Events: events})
	if err != nil {
		return err
	}
	fmt.Printf("exported workflow_id=%s run_id=%s events=%d bytes=%d file=%s\n",
		workflowID, runID, count, bytes, output)
	return nil
}
