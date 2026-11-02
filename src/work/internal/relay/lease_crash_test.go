package relay_test

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/testpg"
)

// D3-N01: the relay claims an outbox row and its process is killed before it can
// deliver. The drill doc requires a *process-level* kill, not only a database-side
// interleaving, so the claimer below is a second OS process (this same test binary
// re-invoked) that is SIGKILLed by the parent. What the kill leaves behind is
// exactly what a crashed worker leaves: a committed claim with no delivery, and a
// lease nobody can renew.

const (
	crashURLenv      = "WORK_RELAY_CRASH_DATABASE_URL"
	crashRelayEnv    = "WORK_RELAY_CRASH_RELAY_ID"
	crashHelperRelay = "relay-a-crash"
	crashTakeoverID  = "relay-b-takeover"
	crashEvent       = "0f0f0f0f-1111-4111-8111-000000000001"
	crashLease       = 5
)

type crashRow struct {
	claimedBy    *string
	claimedUntil *time.Time
	deliveredAt  *time.Time
	deadLettered *time.Time
	attempts     int
}

func readCrashRow(t *testing.T, dbName string) crashRow {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var row crashRow
	// The relay tables are readable only on the relay path, so the probe has to
	// open it the way the relay does rather than reaching for the columns.
	if _, err := conn.Exec(ctx, `SELECT set_config('app.outbox_relay', 'on', false)`); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `
		SELECT claimed_by, claimed_until, delivered_at, dead_lettered_at, attempts
		FROM work.outbox WHERE event_id = $1`, crashEvent,
	).Scan(&row.claimedBy, &row.claimedUntil, &row.deliveredAt,
		&row.deadLettered, &row.attempts); err != nil {
		t.Fatal(err)
	}
	return row
}

// claimOnce claims one batch as the given relay and returns how many rows it got.
func claimOnce(ctx context.Context, pool *pgxpool.Pool, relayID string) (int, string, error) {
	count := 0
	eventID := ""
	err := workdb.WithRelayContext(ctx, pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT event_id::text FROM work.claim_outbox($1, $2, $3)`,
			relayID, 20, crashLease,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if err := rows.Scan(&eventID); err != nil {
				return err
			}
			count++
		}
		return rows.Err()
	})
	return count, eventID, err
}

func ackAs(ctx context.Context, pool *pgxpool.Pool, relayID string) error {
	return workdb.WithRelayContext(ctx, pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.mark_outbox_delivered($1, $2)`,
			crashEvent, relayID)
		return err
	})
}

func failAs(ctx context.Context, pool *pgxpool.Pool, relayID string) (string, error) {
	outcome := ""
	err := workdb.WithRelayContext(ctx, pool, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.mark_outbox_failed($1, $2, $3, $4)`,
			crashEvent, relayID, "relay_delivery_failed", true).Scan(&outcome)
	})
	return outcome, err
}

func taskDeletedAt(t *testing.T, dbName string) *time.Time {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.org_id', $1, false)`, relayOrg); err != nil {
		t.Fatal(err)
	}
	var deletedAt *time.Time
	if err := conn.QueryRow(ctx,
		`SELECT deleted_at, state FROM work.task WHERE id = $1 AND org_id = $2`,
		relayTask, relayOrg,
	).Scan(&deletedAt, new(string)); err != nil {
		t.Fatal(err)
	}
	return deletedAt
}

// seedCrashTask puts a soft-deleted task and one undelivered outbox row on the
// page. The task is deleted on purpose: whatever the relay does with the row,
// a shred/deletion event must never bring a task back.
func seedCrashTask(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', '` + relayOrg + `', false);
		INSERT INTO work.org (id, status, home_region, name)
		VALUES ('` + relayOrg + `', 'active', 'cn-north', 'Relay');
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('` + relayInput + `', '` + relayOrg + `', 'sub_relay', 'content://relay', 'sha256:relay', 10);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode, title,
		                        input_id, revision, deleted_at)
		VALUES ('` + relayTask + `', '` + relayOrg + `', 'sub_relay', 'canceled', 'ask_each',
		        'Crash task', '` + relayInput + `', 0, now());
		SELECT set_config('app.outbox_relay', 'on', false);
		INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
		VALUES ('` + relayOrg + `', 'task', '` + relayTask + `', '` + crashEvent + `',
		        '{"kind":"task_deleted"}'::jsonb);
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

// crashHelperChild claims one row with a five-second lease, reports the event it
// took, then blocks. Nothing here catches a signal or drains a queue: the parent
// kills it, and the committed claim with no delivery is the state under test.
func crashHelperChild(t *testing.T) {
	t.Helper()
	url := os.Getenv(crashURLenv)
	relayID := os.Getenv(crashRelayEnv)
	if url == "" || relayID == "" {
		t.Fatal("crash helper needs a database url and a relay id")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "crash helper connect: "+err.Error())
		os.Exit(3)
	}
	count, eventID, err := claimOnce(ctx, pool, relayID)
	if err != nil {
		fmt.Fprintln(os.Stderr, "crash helper claim: "+err.Error())
		os.Exit(4)
	}
	if count != 1 {
		fmt.Fprintf(os.Stderr, "crash helper claimed %d rows\n", count)
		os.Exit(5)
	}
	fmt.Printf("claimed %s\n", eventID)
	select {}
}

func TestRelayCrashAfterClaimIsReclaimedExactlyOnce(t *testing.T) {
	if os.Getenv(crashURLenv) != "" {
		crashHelperChild(t)
		return
	}
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	pool, dbName := newRelayDB(t)
	seedCrashTask(t, dbName)
	ctx := context.Background()

	before := readCrashRow(t, dbName)
	if before.deliveredAt != nil || before.claimedBy != nil {
		t.Fatalf("row must start unclaimed and undelivered: %#v", before)
	}
	deletedBefore := taskDeletedAt(t, dbName)
	if deletedBefore == nil {
		t.Fatal("seed must leave the task soft-deleted")
	}

	// The child claims on its own connection, so the lease it commits is the same
	// kind of lease a real relay unit holds - and the same kind it cannot renew
	// once it is dead.
	cmd := exec.Command(os.Args[0], "-test.run=TestRelayCrashAfterClaimIsReclaimedExactlyOnce")
	cmd.Env = append(os.Environ(),
		crashURLenv+"="+testpg.WorkerURL(dbName),
		crashRelayEnv+"="+crashHelperRelay,
	)
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line <- scanner.Text()
			return
		}
		line <- ""
	}()
	var claimed string
	select {
	case text := <-line:
		if !strings.HasPrefix(text, "claimed ") {
			t.Fatalf("crash helper said %q", text)
		}
		claimed = strings.TrimPrefix(text, "claimed ")
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("crash helper never reported its claim")
	}
	if claimed != crashEvent {
		t.Fatalf("helper claimed event %s, want %s", claimed, crashEvent)
	}

	// Process-level kill: SIGKILL, no cleanup, no chance to release the claim.
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()

	held := readCrashRow(t, dbName)
	if held.claimedBy == nil || *held.claimedBy != crashHelperRelay {
		t.Fatalf("dead relay must still own the lease, got %v", held.claimedBy)
	}
	if held.deliveredAt != nil || held.attempts != 0 {
		t.Fatalf("killed worker cannot have delivered: %#v", held)
	}
	if held.claimedUntil == nil || !time.Now().Before(*held.claimedUntil) {
		t.Fatalf("lease must still be inside its window: %#v", held.claimedUntil)
	}

	// A healthy replica may not take a live lease, even though its holder is dead.
	// This is the half of the crash that must not be papered over.
	count, _, err := claimOnce(ctx, pool, crashTakeoverID)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("a live lease must block another replica from claiming")
	}

	// Wait out the lease: this is the server-side state a killed process leaves,
	// with nothing to renew it.
	deadline := time.Now().Add(time.Duration(crashLease+8) * time.Second)
	for {
		row := readCrashRow(t, dbName)
		if row.claimedUntil != nil && !time.Now().Before(*row.claimedUntil) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("lease never expired")
		}
		time.Sleep(200 * time.Millisecond)
	}

	count, eventID, err := claimOnce(ctx, pool, crashTakeoverID)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 || eventID != crashEvent {
		t.Fatalf("takeover claim = %d rows (%v), want the crashed row", count, eventID)
	}
	if err := ackAs(ctx, pool, crashTakeoverID); err != nil {
		t.Fatal(err)
	}
	delivered := readCrashRow(t, dbName)
	if delivered.deliveredAt == nil || delivered.attempts != 1 {
		t.Fatalf("takeover delivery = %#v", delivered)
	}
	if delivered.deadLettered != nil {
		t.Fatalf("takeover must not dead-letter: %#v", delivered)
	}

	// The dead holder cannot write over the delivery it missed.
	// mark_outbox_delivered returns early once delivered_at is set, so the
	// timestamp and the attempt count are the proof of exactly-once - not an
	// error code.
	if err := ackAs(ctx, pool, crashHelperRelay); err != nil {
		t.Fatalf("late ack from the dead relay must be a no-op, got %v", err)
	}
	afterLate := readCrashRow(t, dbName)
	if afterLate.attempts != 1 || !afterLate.deliveredAt.Equal(*delivered.deliveredAt) {
		t.Fatalf("late ack changed the delivery: before %#v after %#v", delivered, afterLate)
	}
	outcome, err := failAs(ctx, pool, crashHelperRelay)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != "delivered" {
		t.Fatalf("late fail outcome = %q, want delivered", outcome)
	}
	final := readCrashRow(t, dbName)
	if final.deadLettered != nil || final.attempts != 1 || final.deliveredAt == nil {
		t.Fatalf("final outbox row = %#v", final)
	}
	afterDeleted := taskDeletedAt(t, dbName)
	if afterDeleted == nil || !afterDeleted.Equal(*deletedBefore) {
		t.Fatalf("a delivery must not resurrect the deleted task: %v", afterDeleted)
	}

	// Exactly-once over the whole crash: one row, one delivery, one claim chain.
	var rows int
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	if _, err := admin.Exec(ctx,
		`SELECT set_config('app.outbox_relay', 'on', false)`); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM work.outbox WHERE delivered_at IS NOT NULL`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("delivered outbox rows = %d, want 1", rows)
	}
}
