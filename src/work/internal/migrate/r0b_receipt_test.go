package migrate

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for increment 0027.
//
// §3.1 and §3.3 make the audit row the receipt for a retried governance command, and
// EV106 states the half 0019 and 0023 left out: 幂等重放返回原结果、异 payload 409.
// A receipt keyed by request id alone answers a different command with somebody else's
// success, so these tests hold the comparison, the lock order in front of it, and the
// one-receipt-per-key index.

func TestR0bGapSkipReceiptIsBoundToItsPayload(t *testing.T) {
	_, admin := newGateDB(t)
	ctx := testContext(t)
	org := "org_r0b_gap_receipt"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)
	actor := r0bAdminSubject(org)

	var payload []byte
	skipped := newUUID(t)
	if err := admin.QueryRow(ctx, fmt.Sprintf(`
		SELECT work.consume_governance_events('%s',
		  jsonb_build_array(%s),
		  jsonb_build_object('from_seq', 1, 'to_seq_exclusive', 5,
		    'seat_events', jsonb_build_array(%s)),
		  0)`,
		org,
		governanceEvent(t, 5, newUUID(t), "sub_a", true, 1),
		governanceEvent(t, 2, skipped, "sub_a", true, 9))).Scan(&payload); err != nil {
		t.Fatalf("the gap attestation was refused: %v", err)
	}
	reportID := scalarString(t, admin,
		`SELECT gap_report_id FROM work.governance_gap_report WHERE org_id = $1`, org)

	advance := func(toSeq int, ticket, requestID string) error {
		_, err := admin.Exec(ctx, fmt.Sprintf(
			`SELECT work.advance_governance_event_cursor('%s', %d, '%s', '%s', '%s', '%s')`,
			org, toSeq, reportID, ticket, actor, requestID))
		return err
	}
	if err := advance(5, "TICKET-7", "req-once"); err != nil {
		t.Fatalf("the first advance failed: %v", err)
	}
	// The same command retried is a replay: the recorded result, no second jump, and
	// still exactly one receipt.
	if err := advance(5, "TICKET-7", "req-once"); err != nil {
		t.Fatalf("replaying the same request id failed: %v", err)
	}
	if got := scalarCount(t, admin,
		`SELECT last_event_seq FROM work.governance_event_cursor WHERE org_id = $1`, org); got != 5 {
		t.Fatalf("cursor after a replay = %d, want 5", got)
	}
	// The same request id carrying a different jump used to be answered with the first
	// command's result, which read as a success for a command the database never ran.
	// Both a different interval and a different citation are different commands.
	if err := advance(6, "TICKET-7", "req-once"); err == nil {
		t.Fatal("a reused request id with a different to_seq returned the earlier success")
	} else {
		assertPgMessage(t, err, "idempotency_key_conflict")
	}
	if err := advance(5, "TICKET-8", "req-once"); err == nil {
		t.Fatal("a reused request id with a different ticket returned the earlier success")
	} else {
		assertPgMessage(t, err, "idempotency_key_conflict")
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND action = 'governance_gap_skipped'`, org); got != 1 {
		t.Fatalf("receipts after three attempts on one key = %d, want 1", got)
	}
	// The binding is what makes a receipt re-checkable afterwards, so it has to live on
	// the row rather than only inside the comparison.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND action = 'governance_gap_skipped'
		  AND metadata ->> 'request_hash' IS NOT NULL`, org); got != 1 {
		t.Fatalf("receipts carrying a request hash = %d, want 1", got)
	}
}

// TestR0bGovernanceReceiptIndexesAreUnique is the storage half of the same rule. One
// request id may have one receipt; a non-unique index leaves two rows for one decision
// and the read side answers whichever row it finds first. 0023 already created its
// counterpart this way.
func TestR0bGovernanceReceiptIndexesAreUnique(t *testing.T) {
	_, admin := newGateDB(t)
	for _, name := range []string{
		"work_audit_event_gap_skip_request",
		"work_audit_event_entitlement_request",
	} {
		definition := scalarString(t, admin,
			`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, name)
		if !strings.Contains(definition, "UNIQUE") {
			t.Fatalf("receipt index %s is not unique: %s", name, definition)
		}
	}
}

// TestR0bConsumeInitializesTheCursorWithoutColliding is the cursor-first-insert race.
// FOR UPDATE across a row that does not exist yet locks nothing, so two pullers starting
// the same organization both take the initialize branch; the published body inserted
// plainly there, so the second died on the primary key. That SQLSTATE is none of the four
// FromDB falls back on, so a pull that had succeeded elsewhere surfaced as 503
// service_degraded.
func TestR0bConsumeInitializesTheCursorWithoutColliding(t *testing.T) {
	dbName, admin := newGateDB(t)
	ctx := testContext(t)
	org := "org_r0b_cursor_init"
	seedRun(t, admin, org)

	first := connect(t, testpg.GovernanceURL(dbName))
	defer first.Close(ctx)
	second := connect(t, testpg.GovernanceURL(dbName))
	defer second.Close(ctx)
	for _, conn := range []*pgx.Conn{first, second} {
		if _, err := conn.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
			t.Fatal(err)
		}
	}

	consume := `SELECT work.consume_governance_events($1, '[]'::jsonb, NULL, 0)`
	firstTx, err := first.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := firstTx.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}
	var ignored []byte
	if err := firstTx.QueryRow(ctx, consume, org).Scan(&ignored); err != nil {
		t.Fatalf("the first puller could not initialize the cursor: %v", err)
	}

	// The first puller still holds the uncommitted cursor row, so the second is parked on
	// the unique index. What differs is what it does when the row appears.
	retryCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	done := make(chan error, 1)
	secondTx, err := second.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := secondTx.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}
	go func() {
		var body []byte
		done <- secondTx.QueryRow(retryCtx, consume, org).Scan(&body)
	}()

	waitForLockWait(t, admin)
	if err := firstTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("the second puller failed after a concurrent cursor init: %v", err)
		}
	case <-time.After(45 * time.Second):
		t.Fatal("the second puller never returned after the first committed")
	}
	if err := secondTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.governance_event_cursor WHERE org_id = $1`, org); got != 1 {
		t.Fatalf("cursor rows after two concurrent initializations = %d, want 1", got)
	}
}

// waitForLockWait blocks until some backend of this database is parked on a lock, which
// is how the test knows the two pullers really did overlap. It gives up after a second:
// a race that never opened is worth a log line, not a false failure.
func waitForLockWait(t *testing.T, admin *pgx.Conn) {
	t.Helper()
	for attempt := 0; attempt < 20; attempt++ {
		if scalarCount(t, admin, `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'
			  AND state = 'active'`) > 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Log("no lock wait was observed; the concurrent cursor init may not have overlapped")
}
