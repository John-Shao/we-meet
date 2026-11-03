package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/testpg"
)

// pgDBName is the throwaway baseline database prepared once for the PG-backed
// tests in this package. EnsureFixtures must run here: the CI Postgres starts
// without work_api / work_worker, so a cmd package that skips it breaks the
// required gate even when the same test passes on a developer machine.
var pgDBName string

func TestMain(m *testing.M) {
	if os.Getenv("WORK_TEST_PG_URL") == "" {
		os.Exit(m.Run())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	admin, err := pgx.Connect(ctx, testpg.AdminURL())
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect test PostgreSQL failed")
		os.Exit(1)
	}
	if err := testpg.EnsureFixtures(ctx, admin); err != nil {
		fmt.Fprintln(os.Stderr, "prepare test fixtures failed")
		_ = admin.Close(ctx)
		os.Exit(1)
	}
	name, err := testpg.CreateBaselineDB(ctx, admin, "work_reconcile_test")
	if err != nil {
		fmt.Fprintln(os.Stderr, "create baseline database failed")
		_ = admin.Close(ctx)
		os.Exit(1)
	}
	pgDBName = name
	code := m.Run()
	if err := testpg.DropDatabase(ctx, admin, pgDBName); err != nil {
		fmt.Fprintf(os.Stderr, "drop test database %s failed: %v\n", pgDBName, err)
		if code == 0 {
			code = 1
		}
	}
	_ = admin.Close(ctx)
	os.Exit(code)
}
