package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/testpg"
)

func TestEnvIntFallsBackOnGarbage(t *testing.T) {
	for _, value := range []string{"", "abc", "0", "-3"} {
		t.Setenv("WORK_CANCEL_TASK_LIMIT", value)
		if got := envInt("WORK_CANCEL_TASK_LIMIT", 100); got != 100 {
			t.Fatalf("envInt(%q) = %d, want the 100 fallback", value, got)
		}
	}
	t.Setenv("WORK_CANCEL_TASK_LIMIT", "20")
	if got := envInt("WORK_CANCEL_TASK_LIMIT", 100); got != 20 {
		t.Fatalf("envInt(20) = %d, want 20", got)
	}
}

func TestRunRefusesAnEmptyOrgList(t *testing.T) {
	// A worker cannot enumerate orgs under FORCE RLS, so an empty list is a misconfigured unit,
	// not "nothing to do". It must fail before any database connection is attempted.
	t.Setenv("WORK_DATABASE_URL", "postgres://unused:unused@127.0.0.1:1/unused")
	t.Setenv("WORK_CANCEL_ORGS", "   ")
	err := run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "WORK_CANCEL_ORGS is empty") {
		t.Fatalf("run with no orgs = %v, want the misconfiguration refusal", err)
	}
}

func TestRunPassesOverTheConfiguredOrgs(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	if err := testpg.EnsureFixtures(ctx, admin); err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_cancel_cmd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = testpg.DropDatabase(cleanup, admin, dbName)
	})

	t.Setenv("WORK_DATABASE_URL", testpg.WorkerURL(dbName))
	t.Setenv("WORK_CANCEL_ORGS", "org_cancel_cmd_a org_cancel_cmd_b")
	t.Setenv("WORK_CANCEL_TASK_LIMIT", "")
	t.Setenv("WORK_CANCEL_INTENT_LIMIT", "")
	// An empty backlog is a successful pass: the wiring under test is pool -> consumer -> one
	// bounded round per configured org, and the backlog behaviour is covered in the package.
	if err := run(ctx); err != nil {
		t.Fatalf("run = %v, want nil", err)
	}
}