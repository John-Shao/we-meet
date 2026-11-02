package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/we-meet/work/internal/testpg"
)

// work.request_cancel puts the run into cancel_requested and, in the same statement,
// enqueues the cancel_signal outbox row that the relay turns into a Temporal signal
// (baseline/0002:1807; consumed at internal/relay/relay.go:189). The API tests asserted
// the state and the relay tests consumed a hand-inserted row, so nobody ever checked that
// POST /runs/{id}/cancel actually produces the hand-off - a dropped enqueue would leave
// every cancellation parked in cancel_requested with a perfectly healthy 202.

func cancelSignalRows(t *testing.T, dbName, runID string) (int, string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.outbox_relay', 'on', false)`); err != nil {
		t.Fatal(err)
	}
	var rows int
	var reason string
	if err := conn.QueryRow(ctx, `
		SELECT count(*), coalesce(max(payload->>'reason'), '')
		FROM work.outbox
		WHERE aggregate_type = 'run' AND aggregate_id = $1::uuid
		  AND payload->>'kind' = 'cancel_signal'
		  AND payload->>'run_id' = $2::text`, runID, runID,
	).Scan(&rows, &reason); err != nil {
		t.Fatal(err)
	}
	return rows, reason
}

func TestCancelRunEnqueuesExactlyOneSignalPerRequest(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	token := bootstrapCSRF(t, server.URL)

	response := cancelRunWithBody(t, server.URL, runA, token,
		`{"client_request_id":"cancel-signal-0001","reason":"user_initiated"}`, true)
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("cancel status = %d body=%s", response.StatusCode, readBody(response))
	}
	response.Body.Close()
	if got := runState(t, dbName, runA); got != "cancel_requested" {
		t.Fatalf("db state = %q", got)
	}

	rows, reason := cancelSignalRows(t, dbName, runA)
	if rows != 1 {
		t.Fatalf("cancel_signal rows after one cancel = %d, want 1", rows)
	}
	// The caller's reason has to survive into the hand-off; work.reason_code only
	// checks the shape (baseline/0002:1272-1279), which is the open #286 question of
	// whether cancel reasons are free text or an enum.
	if reason != "user_initiated" {
		t.Fatalf("cancel_signal reason = %q, want the caller's user_initiated", reason)
	}

	// A second request for the same run - which is what a retrying client sends, since
	// the control plane does not dedupe cancellation - must not add a second signal:
	// the run is already cancel_requested, so the state machine has nothing to change
	// and Temporal must not be signalled twice.
	replay := cancelRunWithBody(t, server.URL, runA, token,
		`{"client_request_id":"cancel-signal-0002","reason":"user_initiated"}`, true)
	if replay.StatusCode != http.StatusAccepted {
		t.Fatalf("replay status = %d body=%s", replay.StatusCode, readBody(replay))
	}
	replay.Body.Close()
	afterRows, _ := cancelSignalRows(t, dbName, runA)
	if afterRows != rows {
		t.Fatalf("cancel_signal rows after a repeat request = %d, want still %d", afterRows, rows)
	}

	// An unrelated run must not inherit the signal.
	if foreign, _ := cancelSignalRows(t, dbName, "21111111-1111-4111-8111-999999999999"); foreign != 0 {
		t.Fatalf("cancel_signal rows for an untouched run = %d, want 0", foreign)
	}
}
