package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"go.temporal.io/sdk/worker"
	temporalworkflow "go.temporal.io/sdk/workflow"

	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/dispatch"
	"github.com/we-meet/work/internal/runflow"
	workruntime "github.com/we-meet/work/internal/runtime"
	"github.com/we-meet/work/internal/runtime/openai"
	"github.com/we-meet/work/internal/runtime/reference"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	runtimeMode := os.Getenv("WORK_RUNTIME_MODE")
	var executionRuntime workruntime.Runtime
	var err error
	switch runtimeMode {
	case "reference":
		executionRuntime = reference.New()
	case "openai_compatible":
		executionRuntime, err = openai.New(openai.Config{
			BaseURL:   requiredEnv("WORK_MODEL_BASE_URL"),
			APIKey:    requiredEnv("WORK_MODEL_API_KEY"),
			Model:     requiredEnv("WORK_MODEL_NAME"),
			Provider:  envOrDefault("WORK_MODEL_PROVIDER", "deepseek"),
			MaxTokens: envInt("WORK_MODEL_MAX_TOKENS", 1024),
		})
		if err != nil {
			return err
		}
	default:
		return errors.New("WORK_RUNTIME_MODE must be 'reference' or 'openai_compatible'")
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
		AccountKey:       envOrDefault("WORK_QUOTA_ACCOUNT_KEY", "default"),
		QuotaPeriod:      os.Getenv("WORK_QUOTA_PERIOD"),
		QuotaLimit:       int64(envInt("WORK_QUOTA_LIMIT_TOKENS", 1000000)),
		QuotaEnforcement: envOrDefault("WORK_QUOTA_ENFORCEMENT", "soft"),
		ConsumerID:       envOrDefault("WORK_WORKER_ID", "work-worker-1"),
		StepCount:        envInt("WORK_MODEL_STEPS", 2),
		Now:              time.Now,
	}
	temporalWorker := worker.New(dispatcher.Client(), envOrDefault("WORK_TEMPORAL_TASK_QUEUE", "work-r0a-run"), worker.Options{
		Identity: envOrDefault("WORK_WORKER_ID", "work-worker-1"),
	})
	workflowType := envOrDefault("WORK_TEMPORAL_WORKFLOW_TYPE", runflow.WorkflowName)
	temporalWorker.RegisterWorkflowWithOptions(runflow.RunWorkflow, temporalworkflow.RegisterOptions{Name: workflowType})
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
