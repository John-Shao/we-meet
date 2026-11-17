package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/we-meet/work/internal/cancellation"
	workdb "github.com/we-meet/work/internal/db"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

// run performs ONE bounded pass over the configured orgs and exits. The cadence belongs to
// the systemd timer (deploy/ecs/work-cancel.timer), not to a resident loop: a pass that dies
// leaves intents whose 60s claim window expires on its own, and the next firing picks them up.
func run(ctx context.Context) error {
	// The org list is checked before the pool is opened: a misconfigured unit must fail on its
	// own configuration, not on a database connection it was never going to use.
	orgs := strings.Fields(os.Getenv("WORK_CANCEL_ORGS"))
	if len(orgs) == 0 {
		return errors.New("WORK_CANCEL_ORGS is empty; nothing to consume (unit misconfigured)")
	}
	pool, err := workdb.OpenPool(ctx, requiredEnv("WORK_DATABASE_URL"), "work-cancel")
	if err != nil {
		return err
	}
	defer pool.Close()

	consumer, err := cancellation.New(pool, cancellation.Config{
		Orgs:        orgs,
		TaskLimit:   envInt("WORK_CANCEL_TASK_LIMIT", 100),
		IntentLimit: envInt("WORK_CANCEL_INTENT_LIMIT", 500),
	}, log.Default())
	if err != nil {
		return err
	}

	shutdownCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	n, err := consumer.Pass(shutdownCtx)
	log.Printf("work cancel pass finished orgs=%d intents=%d", len(orgs), n)
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

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}