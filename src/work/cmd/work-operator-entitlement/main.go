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

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/operatorentitlement"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	var command operatorentitlement.Command
	flag.StringVar(&command.OrgID, "org", "", "organization UUID (required)")
	flag.StringVar(&command.ActorSubject, "actor", "", "operator session subject (required)")
	flag.StringVar(&command.OperatorAuthorizationRef, "authorization-ref", "", "operator ticket or authorization reference (required)")
	flag.StringVar(&command.RequestID, "request-id", "", "command UUID; reuse the same value after timeout (required)")
	flag.Int64Var(&command.ExpectedEntitlementRevision, "expected-revision", -1, "current entitlement revision (required)")
	flag.Int64Var(&command.TargetEntitlementRevision, "target-revision", -1, "strictly increasing target revision (required)")
	flag.BoolVar(&command.Enabled, "enabled", false, "whether organization execution is enabled")
	flag.BoolVar(&command.OperatorSuspended, "operator-suspended", false, "whether the operator suspension flag is set")
	flag.IntVar(&command.SeatLimit, "seat-limit", 0, "positive commercial seat limit (required)")
	flag.Parse()

	databaseURL := os.Getenv("WORK_DATABASE_URL")
	if databaseURL == "" {
		return errors.New("WORK_DATABASE_URL is required and must use the work_operator role")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := workdb.OpenPool(ctx, databaseURL, "work-operator-entitlement")
	if err != nil {
		return err
	}
	defer pool.Close()
	hostClient, err := host.NewClient(host.Config{
		BaseURL:        os.Getenv("WORK_HOST_BASE_URL"),
		ClientCertFile: os.Getenv("WORK_HOST_CLIENT_CERT"),
		ClientKeyFile:  os.Getenv("WORK_HOST_CLIENT_KEY"),
		CAFile:         os.Getenv("WORK_HOST_CA"),
		Timeout:        10 * time.Second,
	})
	if err != nil {
		return err
	}
	executor := &operatorentitlement.Executor{Pool: pool, Host: hostClient}
	result, err := executor.Execute(ctx, command)
	if err != nil {
		return err
	}
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	fmt.Println(string(body))
	return nil
}
