package main

import (
	"fmt"
	"os"

	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"github.com/we-meet/work/internal/runflow"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "usage: work-replay HISTORY.json [...]\n")
		os.Exit(2)
	}
	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflowWithOptions(runflow.RunWorkflow,
		workflow.RegisterOptions{Name: runflow.WorkflowName})
	replayer.RegisterWorkflowWithOptions(runflow.RunWorkflowAdvance,
		workflow.RegisterOptions{Name: runflow.WorkflowAdvanceName})

	failed := false
	for _, path := range os.Args[1:] {
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
