package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/directory"
	"github.com/we-meet/work/internal/host"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	hostClient, err := host.NewClient(host.Config{
		BaseURL:        requiredEnv("WORK_HOST_BASE_URL"),
		ClientCertFile: requiredEnv("WORK_HOST_CLIENT_CERT"),
		ClientKeyFile:  requiredEnv("WORK_HOST_CLIENT_KEY"),
		CAFile:         requiredEnv("WORK_HOST_CA"),
		Timeout:        10 * time.Second,
	})
	if err != nil {
		return err
	}
	pool, err := workdb.OpenPool(ctx, requiredEnv("WORK_DATABASE_URL"), "work-directory-sync")
	if err != nil {
		return err
	}
	defer pool.Close()

	timeout := 10 * time.Minute
	if raw := os.Getenv("WORK_DIRECTORY_TIMEOUT"); raw != "" {
		parsed, err := time.ParseDuration(raw)
		if err != nil || parsed <= 0 {
			return fmt.Errorf("WORK_DIRECTORY_TIMEOUT must be a positive duration")
		}
		timeout = parsed
	}
	syncCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	mode := os.Getenv("WORK_DIRECTORY_MODE")
	if mode == "" {
		mode = "full"
	}
	full := false
	switch mode {
	case "full":
		full = true
	case "incremental":
	default:
		return fmt.Errorf("WORK_DIRECTORY_MODE must be full or incremental")
	}
	allowMassAbsence := false
	switch os.Getenv("WORK_DIRECTORY_ALLOW_MASS_ABSENCE") {
	case "", "0", "false":
	case "1", "true":
		allowMassAbsence = true
	default:
		return fmt.Errorf("WORK_DIRECTORY_ALLOW_MASS_ABSENCE must be 0 or 1")
	}
	report, syncErr := directory.Sync(syncCtx, hostClient, &directory.PGWriter{Pool: pool}, directory.Options{
		OrgID:            os.Getenv("WORK_DIRECTORY_ORG_ID"),
		Full:             full,
		AllowMassAbsence: allowMassAbsence,
	})
	encoded, err := json.Marshal(report)
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	if syncErr != nil {
		return syncErr
	}
	if report.Failed() {
		return errors.New("directory sync reported failures")
	}
	return nil
}

func requiredEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}
