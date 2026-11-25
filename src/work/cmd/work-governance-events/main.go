package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/governance"
	"github.com/we-meet/work/internal/host"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	orgs := strings.Fields(os.Getenv("WORK_GOVERNANCE_ORGS"))
	if len(orgs) == 0 {
		return errors.New("WORK_GOVERNANCE_ORGS is empty; nothing to consume")
	}
	hostClient, err := host.NewClient(host.Config{
		BaseURL:        requiredEnv("WORK_GOVERNANCE_HOST_BASE_URL", "WORK_HOST_BASE_URL"),
		ClientCertFile: requiredEnv("WORK_GOVERNANCE_CLIENT_CERT"),
		ClientKeyFile:  requiredEnv("WORK_GOVERNANCE_CLIENT_KEY"),
		CAFile:         requiredEnv("WORK_GOVERNANCE_CA", "WORK_HOST_CA"),
		Timeout:        10 * time.Second,
	})
	if err != nil {
		return err
	}
	pool, err := workdb.OpenPool(ctx, requiredEnv("WORK_DATABASE_URL"), "work-governance-events")
	if err != nil {
		return err
	}
	defer pool.Close()

	timeout := 5 * time.Minute
	if raw := os.Getenv("WORK_GOVERNANCE_TIMEOUT"); raw != "" {
		parsed, err := time.ParseDuration(raw)
		if err != nil || parsed <= 0 {
			return fmt.Errorf("WORK_GOVERNANCE_TIMEOUT must be a positive duration")
		}
		timeout = parsed
	}
	shutdownCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	runCtx, cancel := context.WithTimeout(shutdownCtx, timeout)
	defer cancel()

	puller, err := governance.New(hostClient, &governance.PGStore{Pool: pool}, governance.Config{
		Orgs:      orgs,
		PageLimit: envInt("WORK_GOVERNANCE_PAGE_LIMIT", host.GovernancePageLimit),
		MaxPages:  envInt("WORK_GOVERNANCE_MAX_PAGES", 1000),
	}, log.Default())
	if err != nil {
		return err
	}
	report, syncErr := puller.Pass(runCtx)
	encoded, err := json.Marshal(report)
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	if errors.Is(syncErr, context.Canceled) {
		return nil
	}
	if syncErr != nil {
		return syncErr
	}
	if report.Failed() {
		return errors.New("governance sync reported gaps or failures")
	}
	return nil
}

func requiredEnv(name string, fallback ...string) string {
	value := os.Getenv(name)
	if value == "" && len(fallback) > 0 {
		value = os.Getenv(fallback[0])
	}
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
