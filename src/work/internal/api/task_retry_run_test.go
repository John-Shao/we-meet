package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/we-meet/work/internal/testpg"
)

// TestRetryTaskCreatesSecondAttempt covers the successful 202 path: a new run row
// with the next attempt number, the bumped task revision, and an idempotent replay
// of the same client_request_id that must not start a third run.
func TestRetryTaskCreatesSecondAttempt(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	ctx := context.Background()

	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	// The run-state UPDATE fires run_terminal_event, whose append_task_event is
	// SECURITY DEFINER under forced RLS: without app.org_id in this session it
	// cannot see the task row and the whole UPDATE aborts with task_not_found.
	if _, err := admin.Exec(ctx, `
		SELECT set_config('app.org_id', 'org_a', false);
		UPDATE work.run
		SET state = 'failed', terminal_reason = 'failed', wait_reason = NULL
		WHERE id = '21111111-1111-4111-8111-111111111111';
		UPDATE work.task
		SET active_run_id = NULL, state = 'open', revision = 5,
		    snapshot_id = '41111111-1111-4111-8111-111111111111'
		WHERE id = '11111111-1111-4111-8111-111111111111'`); err != nil {
		t.Fatal(err)
	}
	admin.Close(ctx)

	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)
	const body = `{"client_request_id":"retry-ok-0001","expected_revision":5,` +
		`"target":{"kind":"cloud","profile":"text-v1"},"reason":"user retry"}`

	status, out := retryCall(t, server.URL, csrf, activeTaskID, body)
	if status != http.StatusAccepted {
		t.Fatalf("retry status = %d body=%#v", status, out)
	}
	runID, _ := out["run_id"].(string)
	if runID == "" || out["task_id"] != activeTaskID ||
		out["revision"] != float64(6) || out["display_state"] != "queued" {
		t.Fatalf("retry body = %#v", out)
	}

	read, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close(ctx)
	var (
		attempt    int
		runState   string
		snapshotID string
	)
	if err := read.QueryRow(ctx,
		`SELECT attempt_no, state, snapshot_id::text FROM work.run WHERE id = $1`, runID,
	).Scan(&attempt, &runState, &snapshotID); err != nil {
		t.Fatal(err)
	}
	if attempt != 2 || runState != "queued" || snapshotID == "" {
		t.Fatalf("new run = attempt %d state %s snapshot %q", attempt, runState, snapshotID)
	}

	secondStatus, second := retryCall(t, server.URL, csrf, activeTaskID, body)
	if secondStatus != http.StatusAccepted || second["run_id"] != runID {
		t.Fatalf("idempotent replay = %d %#v", secondStatus, second)
	}
	var runs int
	if err := read.QueryRow(ctx,
		`SELECT count(*) FROM work.run WHERE task_id = $1`, activeTaskID,
	).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 2 {
		t.Fatalf("runs after replay = %d, want 2", runs)
	}
}
