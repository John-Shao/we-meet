package cancellation

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for the §6.1 consumer. The SQL commands themselves are covered in internal/migrate
// (r0b_cancellation_consumer_test.go); what is under test here is the loop around them: the
// per-org tenant context, the bounded pass and its cursor, the retryable/non-retryable split
// that decides whether an intent goes back on the ladder or straight to dead_letter, and the
// fact that one broken org does not stop the others.

func TestMain(m *testing.M) {
	if testpg.AdminURL() == "" {
		os.Exit(m.Run())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err == nil {
		err = testpg.EnsureFixtures(ctx, admin)
		_ = admin.Close(ctx)
	}
	cancel()
	if err != nil {
		log.Printf("prepare cancellation test fixtures: %v", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

type seededRun struct {
	org    string
	taskID string
	runID  string
	denyID string
}

func newCancelDB(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_cancel_test")
	if err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, testpg.WorkerURL(dbName))
	if err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanup, err := testpg.Open(context.Background(), testpg.AdminURL())
		if err == nil {
			_ = testpg.DropDatabase(context.Background(), cleanup, dbName)
			_ = cleanup.Close(context.Background())
		}
		_ = admin.Close(context.Background())
	})
	return pool, dbName
}

func adminConn(t *testing.T, dbName string) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func execSQL(t *testing.T, conn *pgx.Conn, sql string) {
	t.Helper()
	if _, err := conn.Exec(context.Background(), sql); err != nil {
		t.Fatalf("exec: %v\nsql: %s", err, sql)
	}
}

func scalar(t *testing.T, conn *pgx.Conn, sql string) string {
	t.Helper()
	var out string
	if err := conn.QueryRow(context.Background(), sql).Scan(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func quote(v string) string { return "'" + strings.ReplaceAll(v, "'", "''") + "'" }

func seedBacklog(t *testing.T, conn *pgx.Conn, org string, n int) []seededRun {
	t.Helper()
	return seedBacklogReason(t, conn, org, n, "seat_revoked")
}

// seedBacklogReason writes one org with n Runs, each with an org-scope deny at the current epoch
// and a due cancellation intent carrying `reason`. The deny is the scope authority the consume
// command re-checks, so a Run seeded without one would fail closed rather than cancel. The
// reason is a parameter because it is immutable once written (0018:497): a non-retryable
// content fault has to be seeded, not edited in afterwards.
func seedBacklogReason(t *testing.T, conn *pgx.Conn, org string, n int, reason string) []seededRun {
	t.Helper()
	execs := []string{
		"SET app.org_id = " + quote(org),
		"INSERT INTO work.org (id, status, home_region) VALUES (" + quote(org) + ", 'active', 'cn-hangzhou') ON CONFLICT (id) DO NOTHING",
		"INSERT INTO work.member (org_id, subject_id, status, role, work_seat) VALUES (" + quote(org) +
			", 'sub_" + org + "', 'active', 'owner', true) ON CONFLICT (org_id, subject_id) DO NOTHING",
	}
	runs := make([]seededRun, 0, n)
	for i := 0; i < n; i++ {
		suffix := fmt.Sprintf("%s-%d", org, i)
		task, run, snap, input, deny := uuidLike(t, suffix+"-task"), uuidLike(t, suffix+"-run"),
			uuidLike(t, suffix+"-snap"), uuidLike(t, suffix+"-input"), uuidLike(t, suffix+"-deny")
		runs = append(runs, seededRun{org: org, taskID: task, runID: run, denyID: deny})
		execs = append(execs,
			"INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes) VALUES ("+
				quote(input)+", "+quote(org)+", 'sub_"+org+"', 'ref', '"+strings.Repeat("a", 63)+fmt.Sprint(i)+"', 1)",
			"INSERT INTO work.capability_snapshot (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest) VALUES ("+
				quote(snap)+", "+quote(org)+", "+quote(task)+", 'v1', '"+strings.Repeat("b", 64)+"', ARRAY['workspace.read'], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)",
			"INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, input_id, title) VALUES ("+
				quote(task)+", "+quote(org)+", 'sub_"+org+"', 'open', "+quote(snap)+", "+quote(input)+", 'cancel backlog')",
			"INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version) VALUES ("+
				quote(run)+", "+quote(org)+", "+quote(task)+", 1, 'active', "+quote(snap)+", 'wf-"+suffix+"', 'v1')",
			"UPDATE work.task SET active_run_id = "+quote(run)+", latest_run_id = "+quote(run)+" WHERE id = "+quote(task),
			"INSERT INTO work.access_restriction (id, org_id, scope, source, reason, epoch, release_floor_revision) VALUES ("+
				quote(deny)+", "+quote(org)+", 'org', 'governance', 'seat_revoked', 0, 0)",
			"INSERT INTO work.cancellation_intent (org_id, source_event_id, run_id, reason, next_attempt) VALUES ("+
				quote(org)+", "+quote(deny)+", "+quote(run)+", "+quote(reason)+", now() - interval '1 second')",
		)
	}
	// task and capability_snapshot reference each other, so the whole graph lands in one batch.
	if _, err := conn.Exec(context.Background(), strings.Join(execs, ";\n")); err != nil {
		t.Fatalf("seed backlog: %v", err)
	}
	return runs
}

// uuidLike derives a stable UUID-shaped id from a seed so a failure names the row it meant.
// It hashes the whole seed: a prefix encoding would collide for seeds sharing a long stem.
func uuidLike(t *testing.T, seed string) string {
	t.Helper()
	sum := fmt.Sprintf("%x", sha256.Sum256([]byte(seed)))
	return fmt.Sprintf("%s-%s-4%s-8%s-%s", sum[0:8], sum[8:12], sum[13:16], sum[17:20], sum[20:32])
}

func newConsumer(t *testing.T, pool *pgxpool.Pool, orgs ...string) *Consumer {
	t.Helper()
	c, err := New(pool, Config{Orgs: orgs}, log.New(os.Stderr, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestPassConsumesTheBacklogIntoTheCancelPath(t *testing.T) {
	pool, dbName := newCancelDB(t)
	admin := adminConn(t, dbName)
	runs := seedBacklog(t, admin, "org_cancel_pass", 2)
	c := newConsumer(t, pool, "org_cancel_pass")

	n, err := c.Pass(context.Background())
	if err != nil || n != 2 {
		t.Fatalf("Pass = (%d, %v), want (2, nil)", n, err)
	}
	for _, r := range runs {
		if got := scalar(t, admin, "SELECT state || '/' || control_revision::text FROM work.run WHERE id = "+quote(r.runID)); got != "cancel_requested/1" {
			t.Fatalf("Run = %s, want cancel_requested/1", got)
		}
		if got := scalar(t, admin, "SELECT state FROM work.cancellation_intent WHERE source_event_id = "+quote(r.denyID)); got != "consumed" {
			t.Fatalf("intent = %s, want consumed", got)
		}
		if got := scalar(t, admin, "SELECT count(*)::text FROM work.outbox WHERE org_id = "+quote(r.org)+
			" AND aggregate_id = "+quote(r.runID)+" AND payload->>'kind' = 'cancel_signal'"); got != "1" {
			t.Fatalf("cancel_signal rows = %s, want 1 (the relay hand-off, not a frame)", got)
		}
	}
	// A second pass finds nothing: the backlog is drained, not re-cancelled.
	if n, err := c.Pass(context.Background()); err != nil || n != 0 {
		t.Fatalf("second Pass = (%d, %v), want (0, nil)", n, err)
	}
	// append_task_event writes its own outbox routing row (0002:1346), so the hand-off count
	// is the cancel_signal kind, not the org's total.
	if got := scalar(t, admin, "SELECT count(*)::text FROM work.outbox WHERE org_id = 'org_cancel_pass' "+
		"AND payload->>'kind' = 'cancel_signal'"); got != "2" {
		t.Fatalf("cancel_signal rows after a second pass = %s, want 2", got)
	}
}

func TestPassIsBoundedAndKeepsTheCursor(t *testing.T) {
	pool, dbName := newCancelDB(t)
	admin := adminConn(t, dbName)
	seedBacklog(t, admin, "org_cancel_bounded", 3)
	c, err := New(pool, Config{Orgs: []string{"org_cancel_bounded"}, TaskLimit: 1, IntentLimit: 1}, log.New(os.Stderr, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	if n, err := c.Pass(context.Background()); err != nil || n != 1 {
		t.Fatalf("bounded Pass = (%d, %v), want (1, nil)", n, err)
	}
	// §6.1 "超量保留cursor继续，不跳过": the overflow is still pending and still due.
	if got := scalar(t, admin, "SELECT count(*)::text FROM work.cancellation_intent WHERE org_id = 'org_cancel_bounded' "+
		"AND state = 'pending' AND next_attempt <= now()"); got != "2" {
		t.Fatalf("still-due overflow = %s, want 2", got)
	}
	// The claimed row is inside the visibility window; the overflow is not, so the next round
	// continues the cursor rather than re-claiming the row already in flight.
	if got := scalar(t, admin, "SELECT count(*)::text FROM work.cancellation_intent WHERE org_id = 'org_cancel_bounded' "+
		"AND next_attempt > now()"); got != "1" {
		t.Fatalf("rows inside the visibility window = %s, want the 1 claimed", got)
	}
	// With the ruled caps the rest drains, and the cursor never skipped a row.
	wide := newConsumer(t, pool, "org_cancel_bounded")
	if n, err := wide.Pass(context.Background()); err != nil || n != 2 {
		t.Fatalf("wide Pass = (%d, %v), want (2, nil)", n, err)
	}
	if got := scalar(t, admin, "SELECT count(*)::text FROM work.cancellation_intent WHERE org_id = 'org_cancel_bounded' "+
		"AND state = 'consumed'"); got != "3" {
		t.Fatalf("consumed intents = %s, want all 3", got)
	}
	if n, err := wide.Pass(context.Background()); err != nil || n != 0 {
		t.Fatalf("drained Pass = (%d, %v), want (0, nil)", n, err)
	}
}

func TestPassPutsRetryableFailuresOnTheLadder(t *testing.T) {
	pool, dbName := newCancelDB(t)
	admin := adminConn(t, dbName)
	runs := seedBacklog(t, admin, "org_cancel_retry", 1)
	r := runs[0]
	// The deny is the scope authority. Without it the consume fails closed (not_found), which
	// is transient from the consumer's point of view: a cursor recovery can still produce it.
	missing := uuidLike(t, "org_cancel_retry-missing")
	execsSQL(t, admin, []string{"SET app.org_id = " + quote(r.org),
		"INSERT INTO work.cancellation_intent (org_id, source_event_id, run_id, reason) VALUES (" +
			quote(r.org) + ", " + quote(missing) + ", " + quote(r.runID) + ", 'seat_revoked')"})
	c := newConsumer(t, pool, r.org)
	if n, err := c.Pass(context.Background()); err != nil || n != 2 {
		t.Fatalf("Pass = (%d, %v), want (2, nil)", n, err)
	}
	if got := scalar(t, admin, "SELECT state || '/' || attempts::text FROM work.cancellation_intent "+
		"WHERE source_event_id = "+quote(missing)); got != "pending/1" {
		t.Fatalf("unverifiable intent = %s, want pending/1 (back on the ladder)", got)
	}
	if got := scalar(t, admin, "SELECT extract(epoch from (next_attempt - updated_at))::int::text "+
		"FROM work.cancellation_intent WHERE source_event_id = "+quote(missing)); got != "1" {
		t.Fatalf("first retry backoff = %ss, want §6.1's 1s", got)
	}
	// The healthy intent in the same org still consumed: one bad row does not stop the round.
	if got := scalar(t, admin, "SELECT state FROM work.cancellation_intent WHERE source_event_id = "+quote(r.denyID)); got != "consumed" {
		t.Fatalf("healthy intent = %s, want consumed", got)
	}
	// A second round after the backoff expires counts the second attempt.
	execsSQL(t, admin, []string{"UPDATE work.cancellation_intent SET next_attempt = now() - interval '1 second' "+
		"WHERE org_id = " + quote(r.org) + " AND source_event_id = " + quote(missing)})
	if _, err := c.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := scalar(t, admin, "SELECT attempts::text FROM work.cancellation_intent WHERE source_event_id = "+quote(missing)); got != "2" {
		t.Fatalf("attempts after the second round = %s, want 2", got)
	}
	if got := scalar(t, admin, "SELECT state FROM work.run WHERE id = "+quote(r.runID)); got != "cancel_requested" {
		t.Fatalf("Run = %s, want the healthy intent's cancel_requested", got)
	}
}

func TestPassDeadLettersANonRetryableFailureWithTheAlert(t *testing.T) {
	pool, dbName := newCancelDB(t)
	admin := adminConn(t, dbName)
	runs := seedBacklogReason(t, admin, "org_cancel_dead", 1, "Not A Code")
	r := runs[0]
	// reason_code only accepts an enumeration code, and the intent's reason is immutable, so a
	// free-text one can never be consumed: retrying it ten times would only delay the alert.
	c := newConsumer(t, pool, r.org)
	if n, err := c.Pass(context.Background()); err != nil || n != 1 {
		t.Fatalf("Pass = (%d, %v), want (1, nil)", n, err)
	}
	if got := scalar(t, admin, "SELECT state || '/' || attempts::text FROM work.cancellation_intent "+
		"WHERE source_event_id = "+quote(r.denyID)); got != "dead_letter/1" {
		t.Fatalf("intent = %s, want dead_letter/1 (non-retryable, no ten-round wait)", got)
	}
	if got := scalar(t, admin, "SELECT count(*)::text FROM work.audit_event WHERE org_id = "+quote(r.org)+
		" AND action = 'cancellation_intent.dead_lettered' AND actor_subject_id = 'system:work-cancel'"); got != "1" {
		t.Fatalf("dead-letter alert audits = %s, want 1", got)
	}
	// The deny is retained and the Run is untouched: a dead intent is not a cancellation.
	if got := scalar(t, admin, "SELECT state FROM work.access_restriction WHERE id = "+quote(r.denyID)); got != "active" {
		t.Fatalf("deny = %s, want it retained", got)
	}
	if got := scalar(t, admin, "SELECT state FROM work.run WHERE id = "+quote(r.runID)); got != "active" {
		t.Fatalf("Run = %s, want active", got)
	}
	// The next pass does not pick a dead intent up: it belongs to ops replay now.
	if n, err := c.Pass(context.Background()); err != nil || n != 0 {
		t.Fatalf("pass after dead-letter = (%d, %v), want (0, nil)", n, err)
	}
}

func TestConsumeSkipsAnIntentThatIsNoLongerPending(t *testing.T) {
	pool, dbName := newCancelDB(t)
	admin := adminConn(t, dbName)
	runs := seedBacklog(t, admin, "org_cancel_moved", 1)
	r := runs[0]
	c := newConsumer(t, pool, r.org)
	ctx := context.Background()

	intents, err := c.claim(ctx, r.org)
	if err != nil || len(intents) != 1 {
		t.Fatalf("claim = (%v, %v), want one intent", intents, err)
	}
	// Ops dead-letters the row between the claim and the consume. The worker must neither
	// consume it nor fail it: fail_cancellation_intent would refuse a non-pending row too.
	execsSQL(t, admin, []string{"SET app.org_id = " + quote(r.org),
		"UPDATE work.cancellation_intent SET state = 'dead_letter' WHERE source_event_id = " + quote(r.denyID)})
	if err := c.consume(ctx, r.org, intents[0]); err != nil {
		t.Fatalf("consume of a moved intent = %v, want a logged skip", err)
	}
	if got := scalar(t, admin, "SELECT state || '/' || attempts::text FROM work.cancellation_intent "+
		"WHERE source_event_id = "+quote(r.denyID)); got != "dead_letter/0" {
		t.Fatalf("moved intent = %s, want dead_letter/0 (the worker wrote nothing)", got)
	}
	if got := scalar(t, admin, "SELECT count(*)::text FROM work.audit_event WHERE org_id = "+quote(r.org)+
		" AND target_type = 'cancellation_intent'"); got != "0" {
		t.Fatalf("intent audits = %s, want 0", got)
	}
	t.Logf("org audit actions after the skip: %s", scalar(t, admin,
		"SELECT coalesce(string_agg(action, ','), 'none') FROM work.audit_event WHERE org_id = "+quote(r.org)))
}

func TestPassCoversEveryOrgAndIsolatesABrokenOne(t *testing.T) {
	pool, dbName := newCancelDB(t)
	admin := adminConn(t, dbName)
	seedBacklog(t, admin, "org_cancel_a", 1)
	seedBacklog(t, admin, "org_cancel_b", 1)
	// A misconfigured entry (over the 128-byte identity limit) fails its own org's claim and
	// must not stop the healthy ones: the backlog of a working org cannot wait on a broken one.
	broken := strings.Repeat("x", 129)
	c := newConsumer(t, pool, "org_cancel_a", broken, "org_cancel_b")
	n, err := c.Pass(context.Background())
	if n != 2 {
		t.Fatalf("Pass claimed %d, want 2 (both healthy orgs)", n)
	}
	if err == nil || !strings.Contains(err.Error(), "invalid_identity") {
		t.Fatalf("Pass error = %v, want the broken org's invalid_identity", err)
	}
	for _, org := range []string{"org_cancel_a", "org_cancel_b"} {
		if got := scalar(t, admin, "SELECT count(*)::text FROM work.cancellation_intent WHERE org_id = "+quote(org)+
			" AND state = 'consumed'"); got != "1" {
			t.Fatalf("org %s consumed = %s, want 1", org, got)
		}
	}
}

func TestPassStopsOnACancelledContext(t *testing.T) {
	pool, dbName := newCancelDB(t)
	admin := adminConn(t, dbName)
	seedBacklog(t, admin, "org_cancel_ctx", 1)
	c := newConsumer(t, pool, "org_cancel_ctx")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Pass(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Pass on a cancelled context = %v, want context.Canceled", err)
	}
	if got := scalar(t, admin, "SELECT state FROM work.cancellation_intent WHERE org_id = 'org_cancel_ctx'"); got != "pending" {
		t.Fatalf("intent = %s, want pending (nothing was claimed)", got)
	}
}

func TestNewRequiresAnOrgListAndDeduplicatesIt(t *testing.T) {
	pool, _ := newCancelDB(t)
	if _, err := New(pool, Config{}, nil); err == nil {
		t.Fatal("New with no orgs must refuse: a worker cannot enumerate orgs under RLS")
	}
	if _, err := New(nil, Config{Orgs: []string{"org_a"}}, nil); err == nil {
		t.Fatal("New without a pool must refuse")
	}
	c, err := New(pool, Config{Orgs: []string{"org_a", " org_a ", "", "org_b"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.config.Orgs) != 2 || c.config.Orgs[0] != "org_a" || c.config.Orgs[1] != "org_b" {
		t.Fatalf("orgs = %v, want [org_a org_b]", c.config.Orgs)
	}
	if c.config.TaskLimit != 100 || c.config.IntentLimit != 500 {
		t.Fatalf("caps = %d/%d, want the ruled 100/500 defaults", c.config.TaskLimit, c.config.IntentLimit)
	}
}

func TestRetryableFailureSplit(t *testing.T) {
	for _, c := range []struct {
		err  error
		want bool
	}{
		{errors.New("connection reset by peer"), true},
		{&pgconn.PgError{Code: "P0002", Message: "not_found"}, true},
		{&pgconn.PgError{Code: "40001", Message: "serialization_failure"}, true},
		{&pgconn.PgError{Code: "P0001", Message: "run_not_found"}, false},
		{&pgconn.PgError{Code: "P0001", Message: "org_context_mismatch"}, false},
		{&pgconn.PgError{Code: "22023", Message: "invalid_reason_code"}, false},
		{&pgconn.PgError{Code: "42501", Message: "permission denied for function consume_cancellation_intent"}, false},
		{&pgconn.PgError{Code: "23514", Message: "invalid_transition:cancellation_intent:consumed->pending"}, false},
	} {
		if got := retryableFailure(c.err); got != c.want {
			t.Fatalf("retryableFailure(%v) = %t, want %t", c.err, got, c.want)
		}
	}
	if got := failureCode(&pgconn.PgError{Code: "P0001", Message: "cancellation_intent_not_pending"}); got != "cancellation_intent_not_pending" {
		t.Fatalf("failureCode = %q", got)
	}
	if got := failureCode(errors.New("transport")); got != "" {
		t.Fatalf("failureCode of a transport error = %q, want empty", got)
	}
}

func execsSQL(t *testing.T, conn *pgx.Conn, stmts []string) {
	t.Helper()
	execs := strings.Join(stmts, ";\n")
	if _, err := conn.Exec(context.Background(), execs); err != nil {
		t.Fatalf("exec: %v\nsql: %s", err, execs)
	}
}