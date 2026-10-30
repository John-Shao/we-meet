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

	"github.com/google/uuid"

	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/dispatch"
	"github.com/we-meet/work/internal/relay"
)

func defaultRelayID() string {
	return envOrDefault("WORK_RELAY_ID", "work-relay") + "-" + uuid.NewString()
}

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	databaseURL := requiredEnv("WORK_DATABASE_URL")
	contentKey, err := content.EncodeMasterKey(requiredEnv("WORK_CONTENT_MASTER_KEY"))
	if err != nil {
		return err
	}
	store, err := content.NewLocal(contentKey, envOrDefault("WORK_CONTENT_DIR", "/var/lib/work/content"), 1)
	if err != nil {
		return err
	}
	pool, err := workdb.OpenPool(ctx, databaseURL, "work-relay")
	if err != nil {
		return err
	}
	defer pool.Close()

	dispatcher, err := dispatch.NewTemporal(dispatch.TemporalConfig{
		Address:      requiredEnv("WORK_TEMPORAL_ADDRESS"),
		Namespace:    envOrDefault("WORK_TEMPORAL_NAMESPACE", "work-r0a"),
		TaskQueue:    envOrDefault("WORK_TEMPORAL_TASK_QUEUE", "work-r0a-run"),
		WorkflowType: envOrDefault("WORK_TEMPORAL_WORKFLOW_TYPE", "RunWorkflow"),
		CertFile:     requiredEnv("WORK_TEMPORAL_CERT"),
		KeyFile:      requiredEnv("WORK_TEMPORAL_KEY"),
		CAFile:       requiredEnv("WORK_TEMPORAL_CA"),
		ServerName:   envOrDefault("WORK_TEMPORAL_SERVER_NAME", "temporal-server"),
	})
	if err != nil {
		return err
	}
	defer dispatcher.Close()

	relayID := defaultRelayID()
	service, err := relay.New(pool, store, dispatcher, relay.Config{
		RelayID:      relayID,
		BatchSize:    envInt("WORK_RELAY_BATCH_SIZE", 20),
		LeaseSeconds: envInt("WORK_RELAY_LEASE_SECONDS", 60),
		PollInterval: envDuration("WORK_RELAY_POLL_INTERVAL", time.Second),
	}, log.Default())
	if err != nil {
		return err
	}

	shutdownCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("work relay started relay_id=%s", relayID)
	err = service.Run(shutdownCtx)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
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

func envDuration(name string, fallback time.Duration) time.Duration {
	value, err := time.ParseDuration(os.Getenv(name))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}
