package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

// seedGovernanceGap writes the two rows §3.1's first recovery step needs: a cursor stopped
// at 0 and the Host-attested report for the interval it is missing. The report enumerates no
// seat events on purpose - the puller owns the enumeration, and this test is about who may
// jump the cursor and what the answer looks like.
func seedGovernanceGap(t *testing.T, dbName string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `
		INSERT INTO work.governance_event_cursor (org_id, last_event_seq)
		VALUES ($1, 0)`, testOrg); err != nil {
		t.Fatal(err)
	}
	var reportID string
	if err := conn.QueryRow(ctx, `
		INSERT INTO work.governance_gap_report
		  (org_id, from_seq, to_seq_exclusive, seat_events, seat_event_count, host_fetch_seq)
		VALUES ($1, 1, 5, '[]'::jsonb, 0, 5)
		RETURNING gap_report_id`, testOrg).Scan(&reportID); err != nil {
		t.Fatal(err)
	}
	return reportID
}

func TestAdminGovernanceEventCursorAdvance(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	reportID := seedGovernanceGap(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)
	path := server.URL + api.AdminGovernanceEventCursorPath

	body := func(ticket, requestID string) string {
		return `{"to_seq": 5, "gap_report_id": "` + reportID + `", "ticket_id": "` + ticket +
			`", "client_request_id": "` + requestID + `"}`
	}
	countRows := func(t *testing.T, query string) int64 {
		t.Helper()
		ctx := context.Background()
		conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close(ctx)
		var count int64
		if err := conn.QueryRow(ctx, query, testOrg).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}

	// No ticket: the command refuses with its own code rather than a validation error,
	// because the absent ticket *is* §3.1's refusal - a cursor jump has to cite something
	// visible outside this system.
	assertAPICode(t, taskRequest(t, http.MethodPost, path, csrf, body("", "req-cursor-blank")),
		http.StatusConflict, "cursor_advance_not_allowed")

	// An unregistered field is refused at the wire, before the command runs.
	assertAPICode(t, taskRequest(t, http.MethodPost, path, csrf,
		`{"to_seq": 5, "gap_report_id": "`+reportID+`", "ticket_id": "TICKET-1",`+
			`"client_request_id": "req-cursor-extra", "release_denies": true}`),
		http.StatusBadRequest, "invalid_request")

	response := taskRequest(t, http.MethodPost, path, csrf, body("TICKET-1", "req-cursor-1"))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("advance status = %d body=%s", response.StatusCode, readBody(response))
	}
	out := decodeObject(t, response)
	// The response is exactly the closed document the command produces. §1.4's row still
	// names §1.2's GovernanceChange envelope, and that envelope cannot describe this
	// operation: it reports a governance_change row, while §4.1 fixes both the kind closed set
	// (seat|assignment|entitlement) and the fact that this command's idempotent receipt is the
	// governance_gap_skipped audit rather than a change row. The affected-deny counts never
	// appear here either (R10A-14) - they live in the audit and in the report row.
	if len(out) != 3 || out["org_id"] != testOrg || out["last_event_seq"] != float64(5) ||
		out["gap_report_id"] != reportID {
		t.Fatalf("advance body = %#v, want org_id/last_event_seq/gap_report_id only", out)
	}
	if got := countRows(t, `SELECT count(*) FROM work.governance_event_cursor WHERE org_id = $1
		AND last_event_seq = 5`); got != 1 {
		t.Fatalf("cursor did not move to the reported position")
	}
	if got := countRows(t, `SELECT count(*) FROM work.audit_event WHERE org_id = $1
		AND action = 'governance_gap_skipped'`); got != 1 {
		t.Fatalf("gap skip audit rows = %d, want 1 - the ticket and the counts live here", got)
	}

	// The same request id replays the recorded result instead of jumping a second interval,
	// and a different request id citing the same report is refused: one report, one jump.
	replay := taskRequest(t, http.MethodPost, path, csrf, body("TICKET-1", "req-cursor-1"))
	if replay.StatusCode != http.StatusOK {
		t.Fatalf("replay status = %d body=%s", replay.StatusCode, readBody(replay))
	}
	if replayed := decodeObject(t, replay); replayed["last_event_seq"] != float64(5) {
		t.Fatalf("replay body = %#v", replayed)
	}
	if got := countRows(t, `SELECT count(*) FROM work.audit_event WHERE org_id = $1
		AND action = 'governance_gap_skipped'`); got != 1 {
		t.Fatalf("gap skip audit rows after a replay = %d, want still 1", got)
	}
	assertAPICode(t, taskRequest(t, http.MethodPost, path, csrf, body("TICKET-2", "req-cursor-2")),
		http.StatusConflict, "cursor_advance_not_allowed")

	// The advance is not a release: it jumps the cursor and marks denys for human
	// re-verification, and nothing on this path may lift one (§3.4 rule 2).
	if got := countRows(t, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND state = 'released'`); got != 0 {
		t.Fatalf("denys released by the cursor advance = %d, want 0", got)
	}

	// And the caller is the organization's administrator. work_api already held EXECUTE on
	// the command, so without assert_org_admin inside it any active member of the org could
	// jump the governance cursor over an interval they had not verified.
	ctx := context.Background()
	writer, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec(ctx,
		`UPDATE work.member SET role = 'viewer' WHERE org_id = $1 AND subject_id = $2`,
		testOrg, testSubject); err != nil {
		t.Fatal(err)
	}
	writer.Close(ctx)

	assertAPICode(t, taskRequest(t, http.MethodPost, path, csrf, body("TICKET-3", "req-cursor-3")),
		http.StatusForbidden, "admin_access_denied")
}
