package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"go.temporal.io/sdk/worker"
	temporalworkflow "go.temporal.io/sdk/workflow"

	"github.com/we-meet/work/internal/advance"
	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/dispatch"
	"github.com/we-meet/work/internal/runflow"
	workruntime "github.com/we-meet/work/internal/runtime"
	"github.com/we-meet/work/internal/runtime/reference"
	"github.com/we-meet/work/internal/templates"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func newRuntime(mode string) (workruntime.Runtime, error) {
	switch mode {
	case "", "reference":
		return reference.New(), nil
	default:
		return nil, fmt.Errorf("WORK_RUNTIME_MODE=%q is not supported; the worker runs the reference runtime until the signed Node/Pi runtime and work-egress boundary is implemented", mode)
	}
}

// advanceEnabled keeps the R0a advance workflow dark by default. It is an
// explicit opt-in because the Node parent lease (D-3) and the production
// template asset source are not part of this increment.
func advanceEnabled() bool {
	return os.Getenv("WORK_WORKFLOW_ADVANCE") == "1"
}

func newAdvanceClient() (*advance.Client, error) {
	baseURL := os.Getenv("WORK_ADVANCE_URL")
	if baseURL == "" {
		return nil, fmt.Errorf("WORK_ADVANCE_URL is required when WORK_WORKFLOW_ADVANCE=1")
	}
	timeout := time.Duration(envInt("WORK_ADVANCE_TIMEOUT_SECONDS", 30)) * time.Second
	return advance.NewClient(advance.ClientConfig{
		BaseURL:    baseURL,
		CertFile:   requiredEnv("WORK_ADVANCE_CERT"),
		KeyFile:    requiredEnv("WORK_ADVANCE_KEY"),
		CAFile:     requiredEnv("WORK_ADVANCE_CA"),
		ServerName: envOrDefault("WORK_ADVANCE_SERVER_NAME", "work-runtime"),
		Timeout:    timeout,
	})
}

func run(ctx context.Context) error {
	runtimeMode := envOrDefault("WORK_RUNTIME_MODE", "reference")
	executionRuntime, err := newRuntime(runtimeMode)
	if err != nil {
		return err
	}
	databaseURL := requiredEnv("WORK_DATABASE_URL")
	contentKey, err := content.EncodeMasterKey(requiredEnv("WORK_CONTENT_MASTER_KEY"))
	if err != nil {
		return err
	}
	store, err := content.NewLocal(contentKey, envOrDefault("WORK_CONTENT_DIR", "/var/lib/work/content"), 1)
	if err != nil {
		return err
	}
	pool, err := workdb.OpenPool(ctx, databaseURL, "work-worker")
	if err != nil {
		return err
	}
	defer pool.Close()

	dispatcher, err := dispatch.NewTemporal(dispatch.TemporalConfig{
		Address:      requiredEnv("WORK_TEMPORAL_ADDRESS"),
		Namespace:    envOrDefault("WORK_TEMPORAL_NAMESPACE", "work-r0a"),
		TaskQueue:    envOrDefault("WORK_TEMPORAL_TASK_QUEUE", "work-r0a-run"),
		WorkflowType: envOrDefault("WORK_TEMPORAL_WORKFLOW_TYPE", runflow.WorkflowName),
		CertFile:     requiredEnv("WORK_TEMPORAL_CERT"),
		KeyFile:      requiredEnv("WORK_TEMPORAL_KEY"),
		CAFile:       requiredEnv("WORK_TEMPORAL_CA"),
		ServerName:   envOrDefault("WORK_TEMPORAL_SERVER_NAME", "temporal-server"),
	})
	if err != nil {
		return err
	}
	defer dispatcher.Close()

	activities := &runflow.Activities{
		Pool: pool, Content: store, Runtime: executionRuntime,
		Templates:        templates.Source{},
		AccountKey:       envOrDefault("WORK_QUOTA_ACCOUNT_KEY", "default"),
		QuotaPeriod:      os.Getenv("WORK_QUOTA_PERIOD"),
		QuotaLimit:       int64(envInt("WORK_QUOTA_LIMIT_TOKENS", 1000000)),
		QuotaEnforcement: envOrDefault("WORK_QUOTA_ENFORCEMENT", "soft"),
		ConsumerID:       envOrDefault("WORK_WORKER_ID", "work-worker-1"),
		StepCount:        envInt("WORK_MODEL_STEPS", 2),
		Now:              time.Now,
	}
	if advanceEnabled() {
		client, err := newAdvanceClient()
		if err != nil {
			return err
		}
		activities.Advance = client
	}
	temporalWorker := worker.New(dispatcher.Client(), envOrDefault("WORK_TEMPORAL_TASK_QUEUE", "work-r0a-run"), worker.Options{
		Identity: envOrDefault("WORK_WORKER_ID", "work-worker-1"),
	})
	workflowType := envOrDefault("WORK_TEMPORAL_WORKFLOW_TYPE", runflow.WorkflowName)
	temporalWorker.RegisterWorkflowWithOptions(runflow.RunWorkflow, temporalworkflow.RegisterOptions{Name: workflowType})
	if advanceEnabled() {
		temporalWorker.RegisterWorkflowWithOptions(runflow.RunWorkflowAdvance,
			temporalworkflow.RegisterOptions{Name: runflow.WorkflowAdvanceName})
	}
	temporalWorker.RegisterActivity(activities)

	interrupt := make(chan any, 1)
	go func() {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
		select {
		case <-ctx.Done():
		case <-signals:
		}
		interrupt <- struct{}{}
	}()
	log.Printf("work worker started mode=%s queue=%s", runtimeMode, envOrDefault("WORK_TEMPORAL_TASK_QUEUE", "work-r0a-run"))
	return temporalWorker.Run(interrupt)
}

func requiredEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}
