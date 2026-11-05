package runflow_test

// #60=B wired two database commands into the advance path - wait_run('quota') and
// resume_run - and the live tests prove the worker can use them. Nothing proved that a
// different workload role cannot, which is the half that makes the grant the boundary
// rather than a convention.

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/testpg"
)

func pgRefusalCode(t *testing.T, err error) (string, string) {
	t.Helper()
	if err == nil {
		return "", ""
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("expected a PostgreSQL error, got %v", err)
	}
	return pgErr.SQLState(), pgErr.Message
}

func TestResumeAndWaitRunAreWorkerOnly(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	_, dbName := newFlowDB(t)
	ctx := context.Background()

	app, err := pgx.Connect(ctx, testpg.AppURL(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close(ctx)

	// The privilege check happens before the function body, so the Run's state is
	// irrelevant to the refusal - which is what makes this a grant test rather than a
	// state test wearing a grant costume.
	for _, call := range []struct {
		sql  string
		name string
	}{
		{`SELECT work.wait_run($1, $2::uuid, 'quota')`, "wait_run"},
		{`SELECT work.resume_run($1, $2::uuid)`, "resume_run"},
	} {
		var ignored any
		err := app.QueryRow(ctx, call.sql, flowOrg, flowRun).Scan(&ignored)
		state, message := pgRefusalCode(t, err)
		if state != "42501" {
			t.Fatalf("%s as work_api = %s %q, want 42501", call.name, state, message)
		}
		if message != "permission denied for function "+call.name {
			t.Fatalf("%s refusal message = %q, want it to name the function", call.name, message)
		}
	}

	// The positive side of the same predicate: the boundary is exactly one role wide, so
	// the worker must hold EXECUTE. Actual use is proven by the advance tests that call
	// these through the worker pool.
	admin, err := pgx.Connect(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	for _, pair := range []struct {
		role, function string
		want           bool
	}{
		{"work_worker", "work.wait_run(text, uuid, text)", true},
		{"work_worker", "work.resume_run(text, uuid)", true},
		{"work_api", "work.wait_run(text, uuid, text)", false},
		{"work_api", "work.resume_run(text, uuid)", false},
		{"work_directory", "work.resume_run(text, uuid)", false},
		{"work_ops", "work.resume_run(text, uuid)", false},
	} {
		var held bool
		if err := admin.QueryRow(ctx,
			"SELECT has_function_privilege($1, $2, 'EXECUTE')", pair.role, pair.function).Scan(&held); err != nil {
			t.Fatal(err)
		}
		if held != pair.want {
			t.Fatalf("has_function_privilege(%s, %s) = %v, want %v",
				pair.role, pair.function, held, pair.want)
		}
	}
}
