package relay_test

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/relay"
	"github.com/we-meet/work/internal/testpg"
)

// D3-N01 (orchestration design:603): "Shredder 领取 content_shred 后崩溃 |
// 租约过期后可重领；不重复投递新事件；任务不会因清理失败复活".
//
// The drill doc asks for a process-level kill, so the claimer here is a second OS
// process - this same test binary re-invoked - running the real relay against a real
// content store. It is killed while shredding the *first* of two references, which is
// the state an OOM-killed or restarted work-*.unit actually leaves behind: a committed
// claim, content already gone, no delivery, and a lease nobody can renew.
//
// Each clause of the matrix is asserted against that state rather than described:
// the live lease blocks a replica until it expires and the replica then re-claims the
// same row (租约过期后可重领); the re-delivery re-deletes the already-gone reference
// instead of dead-lettering, and no further pass ever claims anything (不重复投递新事件);
// the soft-deleted task keeps its deleted_at and state across every phase
// (任务不会因清理失败复活).
//
// The other half of the same row - 清理失败 rather than 崩溃 - is the second case:
// a store whose every delete fails must release its lease, schedule a backoffed retry,
// remove no content, and leave the deleted task deleted with its original timestamp;
// the retry then delivers the same row without queueing anything new.

const (
	crashURLenv     = "WORK_RELAY_CRASH_DATABASE_URL"
	crashRelayEnv   = "WORK_RELAY_CRASH_RELAY_ID"
	crashContentEnv = "WORK_RELAY_CRASH_CONTENT_DIR"

	crashHelperRelay = "relay-a-crash"
	crashTakeoverID  = "relay-b-takeover"
	failRelayID      = "relay-a-failing"
	repairRelayID    = "relay-b-repaired"
	crashEvent       = "0f0f0f0f-1111-4111-8111-000000000001"
	crashCompanion   = "0f0f0f0f-1111-4111-8111-000000000002"
	crashLease       = 5
)

// Test-only master key for a throwaway temp directory.
var crashMasterKey = bytes.Repeat([]byte{7}, 32)

type crashRow struct {
	claimedBy      *string
	claimedUntil   *time.Time
	deliveredAt    *time.Time
	deadLettered   *time.Time
	lastErrorCode  *string
	attempts       int
	availableAfter bool
}

func readOutboxRow(t *testing.T, dbName, eventID string) crashRow {
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
		SELECT claimed_by, claimed_until, delivered_at, dead_lettered_at,
		       last_error_code, attempts, available_at > now()
		FROM work.outbox WHERE event_id = $1`, eventID,
	).Scan(&row.claimedBy, &row.claimedUntil, &row.deliveredAt,
		&row.deadLettered, &row.lastErrorCode, &row.attempts, &row.availableAfter); err != nil {
		t.Fatal(err)
	}
	return row
}

func readCrashRow(t *testing.T, dbName string) crashRow {
	t.Helper()
	return readOutboxRow(t, dbName, crashEvent)
}

// crashTaskState reads the task the event is shredding for. It is read as the
// application role: whether a shred can resurrect a task is a question about the
// facts the API can observe, not about what a superuser can force.
func crashTaskState(t *testing.T, dbName string) (*time.Time, string) {
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
	var state string
	if err := conn.QueryRow(ctx,
		`SELECT deleted_at, state FROM work.task WHERE id = $1 AND org_id = $2`,
		relayTask, relayOrg,
	).Scan(&deletedAt, &state); err != nil {
		t.Fatal(err)
	}
	return deletedAt, state
}

func openCrashStore(t *testing.T, directory string) *content.Local {
	t.Helper()
	store, err := content.NewLocal(crashMasterKey, directory, 1)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// contentReadable asks the store itself whether a reference still resolves. The
// encrypted object path is an implementation detail of content.Local, so the test
// never reaches for the file.
func contentReadable(t *testing.T, store *content.Local, contentRef string) bool {
	t.Helper()
	_, err := store.Get(context.Background(), relayOrg, contentRef)
	return err == nil
}

func crashRelay(t *testing.T, pool *pgxpool.Pool, relayID string, store content.Store) *relay.Relay {
	t.Helper()
	service, err := relay.New(pool, store, &fakeDispatcher{}, relay.Config{
		RelayID: relayID, BatchSize: 20, LeaseSeconds: crashLease, PollInterval: time.Millisecond,
	}, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	return service
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

// seedCrashShred writes the facts a real task deletion writes: the task is already
// soft-deleted, its input holds the first content reference, and the outbox row is a
// content_shred event carrying two references. The second reference exists so a crash
// lands between two deletions instead of after all of them.
func seedCrashShred(t *testing.T, dbName, directory string) (string, string) {
	t.Helper()
	ctx := context.Background()
	store := openCrashStore(t, directory)
	first, err := store.Put(ctx, relayOrg, []byte("crash body one"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Put(ctx, relayOrg, []byte("crash body two"))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := fmt.Sprintf(`
		SELECT set_config('app.org_id', '%s', false);
		INSERT INTO work.org (id, status, home_region, name)
		VALUES ('%s', 'active', 'cn-north', 'Relay');
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%s', '%s', 'sub_relay', '%s', '%s', %d);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode, title,
		                        input_id, revision, deleted_at)
		VALUES ('%s', '%s', 'sub_relay', 'canceled', 'ask_each', 'Crash task',
		        '%s', 0, now());
	`, relayOrg, relayOrg, relayInput, relayOrg, first.ContentRef, first.Hash, first.Bytes,
		relayTask, relayOrg, relayInput)
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
	payload := fmt.Sprintf(
		`{"kind":"content_shred","task_id":%q,"content_refs":[%q,%q]}`,
		relayTask, first.ContentRef, second.ContentRef,
	)
	insertOutbox(t, dbName, crashEvent, relayOrg, "content", relayTask, payload)
	return first.ContentRef, second.ContentRef
}

// shredThenHang is the crash injection: it deletes for real, then hangs on the first
// successful deletion so the parent can kill the process mid-shred. Nothing here
// catches a signal or drains a queue, which is what makes the state under test the
// state a killed unit leaves.
type shredThenHang struct {
	store   content.Store
	deleted int
}

func (s shredThenHang) Put(ctx context.Context, orgID string, plaintext []byte) (content.Ref, error) {
	return s.store.Put(ctx, orgID, plaintext)
}

func (s shredThenHang) Get(ctx context.Context, orgID, contentRef string) ([]byte, error) {
	return s.store.Get(ctx, orgID, contentRef)
}

func (s *shredThenHang) Delete(ctx context.Context, orgID, contentRef string) error {
	if err := s.store.Delete(ctx, orgID, contentRef); err != nil {
		return err
	}
	s.deleted++
	if s.deleted == 1 {
		fmt.Printf("shredded %s\n", contentRef)
		select {}
	}
	return nil
}

// crashHelperChild runs the real relay over the real shred path and never returns
// unless the relay finished - which it must not, because it hangs inside the first
// deletion.
func crashHelperChild(t *testing.T) {
	t.Helper()
	url := os.Getenv(crashURLenv)
	relayID := os.Getenv(crashRelayEnv)
	directory := os.Getenv(crashContentEnv)
	if url == "" || relayID == "" || directory == "" {
		t.Fatal("crash helper needs a database url, a relay id and a content directory")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "crash helper connect: "+err.Error())
		os.Exit(3)
	}
	defer pool.Close()
	service := crashRelay(t, pool, relayID,
		&shredThenHang{store: openCrashStore(t, directory)})
	count, err := service.Once(ctx)
	fmt.Fprintf(os.Stderr, "crash helper returned count=%d err=%v\n", count, err)
	os.Exit(6)
}

// shredCase is the same starting state for both halves of D3-N01: a soft-deleted
// task, one undelivered content_shred event carrying two live content objects.
type shredCase struct {
	pool      *pgxpool.Pool
	dbName    string
	directory string
	store     *content.Local
	refFirst  string
	refSecond string
}

func newShredCase(t *testing.T) shredCase {
	t.Helper()
	pool, dbName := newRelayDB(t)
	directory, err := os.MkdirTemp("", "work-relay-crash")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	refFirst, refSecond := seedCrashShred(t, dbName, directory)
	return shredCase{
		pool: pool, dbName: dbName, directory: directory,
		store: openCrashStore(t, directory), refFirst: refFirst, refSecond: refSecond,
	}
}

func TestRelayCrashAfterClaimIsReclaimedExactlyOnce(t *testing.T) {
	if os.Getenv(crashURLenv) != "" {
		crashHelperChild(t)
		return
	}
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	c := newShredCase(t)
	pool, dbName, store, directory := c.pool, c.dbName, c.store, c.directory
	refFirst, refSecond := c.refFirst, c.refSecond
	ctx := context.Background()

	before := readCrashRow(t, dbName)
	if before.deliveredAt != nil || before.claimedBy != nil {
		t.Fatalf("row must start unclaimed and undelivered: %#v", before)
	}
	if !contentReadable(t, store, refFirst) || !contentReadable(t, store, refSecond) {
		t.Fatal("seed must leave both content objects readable")
	}
	deletedBefore, stateBefore := crashTaskState(t, dbName)
	if deletedBefore == nil || stateBefore != "canceled" {
		t.Fatal("seed must leave the task soft-deleted")
	}

	// The child claims and shreds on its own connection, so the lease it commits is
	// the same kind of lease a real relay unit holds - and the same kind it cannot
	// renew once it is dead.
	cmd := exec.Command(os.Args[0], "-test.run=TestRelayCrashAfterClaimIsReclaimedExactlyOnce")
	cmd.Env = append(os.Environ(),
		crashURLenv+"="+testpg.WorkerURL(dbName),
		crashRelayEnv+"="+crashHelperRelay,
		crashContentEnv+"="+directory,
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
	var shredded string
	select {
	case text := <-line:
		if !strings.HasPrefix(text, "shredded ") {
			t.Fatalf("crash helper said %q", text)
		}
		shredded = strings.TrimPrefix(text, "shredded ")
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("crash helper never reported a deletion")
	}
	if shredded != refFirst {
		t.Fatalf("helper shredded %s, want the first reference %s", shredded, refFirst)
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
	if held.deliveredAt != nil || held.attempts != 0 || held.deadLettered != nil {
		t.Fatalf("killed worker cannot have delivered: %#v", held)
	}
	if held.claimedUntil == nil || !time.Now().Before(*held.claimedUntil) {
		t.Fatalf("lease must still be inside its window: %#v", held.claimedUntil)
	}
	// The crash lands with side effects already on disk and no delivery recorded.
	// This is the reason a re-delivery has to tolerate an object that is already gone.
	if contentReadable(t, store, refFirst) {
		t.Fatal("the killed relay did delete the first object")
	}
	if !contentReadable(t, store, refSecond) {
		t.Fatal("a killed relay cannot have deleted the object it never reached")
	}
	crashDeleted, crashState := crashTaskState(t, dbName)
	if crashDeleted == nil || !crashDeleted.Equal(*deletedBefore) || crashState != stateBefore {
		t.Fatalf("crash must not touch the deleted task: %v %q", crashDeleted, crashState)
	}

	// A healthy replica may not take a live lease, even though its holder is dead.
	// This is the half of the crash that must not be papered over.
	takeover := crashRelay(t, pool, crashTakeoverID, store)
	count, err := takeover.Once(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("a live lease must block another replica from claiming")
	}
	if !contentReadable(t, store, refSecond) {
		t.Fatal("a blocked replica must not start shredding")
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

	count, err = takeover.Once(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("takeover claimed %d events, want the crashed row", count)
	}
	// The re-delivery re-deletes the object the dead relay already removed and still
	// finishes: content.Local.Delete treats a missing object as done, so a partial
	// shred is idempotent rather than permanently dead-lettered. That tolerance is
	// what this assertion pins - deleting the errors.Is(err, os.ErrNotExist) clause in
	// content/local.go makes the takeover pass end at attempts=1 with
	// content_delete_failed and no delivery at all, i.e. a crash mid-shred would wedge
	// the row through ten backoffs and then dead-letter it with content still on disk.
	after := readCrashRow(t, dbName)
	if after.deliveredAt == nil || after.attempts != 1 || after.deadLettered != nil {
		t.Fatalf("takeover delivery = %#v, want delivered once with no dead letter", after)
	}
	if after.lastErrorCode != nil && *after.lastErrorCode != "" {
		t.Fatalf("takeover left an error code: %q", *after.lastErrorCode)
	}
	if contentReadable(t, store, refFirst) || contentReadable(t, store, refSecond) {
		t.Fatal("the takeover pass must leave no content behind")
	}

	// Nothing new is queued by the crash or by the recovery, and no second pass finds
	// work: one event, one delivery.
	count, err = takeover.Once(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("a delivered row must never be claimable again")
	}
	var rows, delivered int
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	if _, err := admin.Exec(ctx,
		`SELECT set_config('app.outbox_relay', 'on', false)`); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE delivered_at IS NOT NULL)
		FROM work.outbox`).Scan(&rows, &delivered); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || delivered != 1 {
		t.Fatalf("outbox rows = %d, delivered = %d, want exactly one of each", rows, delivered)
	}

	// The dead holder cannot write over the delivery it missed.
	// mark_outbox_delivered returns early once delivered_at is set, so the timestamp
	// and the attempt count are the proof of exactly-once - not an error code.
	if err := ackAs(ctx, pool, crashHelperRelay); err != nil {
		t.Fatalf("late ack from the dead relay must be a no-op, got %v", err)
	}
	afterLate := readCrashRow(t, dbName)
	if afterLate.attempts != 1 || !afterLate.deliveredAt.Equal(*after.deliveredAt) {
		t.Fatalf("late ack changed the delivery: before %#v after %#v", after, afterLate)
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
	// And the task the shredded content belonged to stays deleted through all of it.
	finalDeleted, finalState := crashTaskState(t, dbName)
	if finalDeleted == nil || !finalDeleted.Equal(*deletedBefore) || finalState != stateBefore {
		t.Fatalf("a crashed-then-recovered shred resurrected the task: %v %q",
			finalDeleted, finalState)
	}
}

// failingStore is the other half of the matrix row - "清理失败" rather than "崩溃":
// the store answers every request but no delete succeeds, which is what a mounted
// read-only or permission-broken content directory looks like from the relay.
type failingStore struct{ store content.Store }

func (s failingStore) Put(ctx context.Context, orgID string, plaintext []byte) (content.Ref, error) {
	return s.store.Put(ctx, orgID, plaintext)
}

func (s failingStore) Get(ctx context.Context, orgID, contentRef string) ([]byte, error) {
	return s.store.Get(ctx, orgID, contentRef)
}

func (s failingStore) Delete(context.Context, string, string) error {
	return errors.New("content store is read only")
}

// awaitClaimable waits out the retry backoff mark_outbox_failed scheduled
// (2^attempts seconds, so the first retry is two seconds away) instead of rewriting
// available_at, which would put the relay in a state the database never creates.
func awaitClaimable(t *testing.T, dbName string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		row := readCrashRow(t, dbName)
		if row.deliveredAt == nil && row.deadLettered == nil &&
			row.claimedUntil == nil && !row.availableAfter {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("row never became claimable again: %#v", row)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func TestRelayContentDeleteFailureRetriesAndNeverRevivesTask(t *testing.T) {
	c := newShredCase(t)
	ctx := context.Background()
	deletedBefore, stateBefore := crashTaskState(t, c.dbName)
	// A second aggregate rides along in the same batch. The matrix's recovery text
	// says a persistently failing shred "backs off 2^n and dead-letters without
	// blocking task events on other aggregates", so the failure half has to prove the
	// other aggregate still gets delivered in the pass where the shred fails.
	insertOutbox(t, c.dbName, crashCompanion, relayOrg, "task", relayTask,
		`{"kind":"task_event","task_id":"`+relayTask+`"}`)

	broken := crashRelay(t, c.pool, failRelayID, failingStore{store: c.store})
	count, err := broken.Once(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("failing pass claimed %d events, want the shred row and its companion", count)
	}
	companion := readOutboxRow(t, c.dbName, crashCompanion)
	if companion.deliveredAt == nil || companion.deadLettered != nil || companion.attempts != 1 {
		t.Fatalf("a failing shred must not stall another aggregate: %#v", companion)
	}
	failed := readCrashRow(t, c.dbName)
	if failed.deliveredAt != nil || failed.deadLettered != nil {
		t.Fatalf("a retryable content failure neither delivers nor dead-letters: %#v", failed)
	}
	if failed.attempts != 1 || failed.lastErrorCode == nil ||
		*failed.lastErrorCode != "content_delete_failed" {
		t.Fatalf("failure bookkeeping = %#v", failed)
	}
	if failed.claimedUntil != nil {
		t.Fatalf("a failed delivery must release its lease, got %v", *failed.claimedUntil)
	}
	if !failed.availableAfter {
		t.Fatal("a failed delivery must schedule a retry")
	}
	if !contentReadable(t, c.store, c.refFirst) || !contentReadable(t, c.store, c.refSecond) {
		t.Fatal("a delete that failed cannot have removed content")
	}
	// The clause the matrix names: a failed shred does not roll the deletion back.
	// The task stays deleted, with the timestamp it was deleted at.
	failDeleted, failState := crashTaskState(t, c.dbName)
	if failDeleted == nil || !failDeleted.Equal(*deletedBefore) || failState != stateBefore {
		t.Fatalf("a failed shred changed the deleted task: %v %q", failDeleted, failState)
	}

	awaitClaimable(t, c.dbName)
	repaired := crashRelay(t, c.pool, repairRelayID, c.store)
	count, err = repaired.Once(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("retry claimed %d events, want the failed row", count)
	}
	retried := readCrashRow(t, c.dbName)
	if retried.deliveredAt == nil || retried.attempts != 2 || retried.deadLettered != nil {
		t.Fatalf("retry delivery = %#v, want delivered on the second attempt", retried)
	}
	if contentReadable(t, c.store, c.refFirst) || contentReadable(t, c.store, c.refSecond) {
		t.Fatal("the retry must leave no content behind")
	}
	if _, err := repaired.Once(ctx); err != nil {
		t.Fatal(err)
	}
	// One failure and its retry queue nothing new: still one content_shred event,
	// delivered once, next to the companion row that never stopped.
	var shredRows, shredDelivered int
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(c.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	if _, err := admin.Exec(ctx,
		`SELECT set_config('app.outbox_relay', 'on', false)`); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE delivered_at IS NOT NULL)
		FROM work.outbox WHERE payload->>'kind' = 'content_shred'`).
		Scan(&shredRows, &shredDelivered); err != nil {
		t.Fatal(err)
	}
	if shredRows != 1 || shredDelivered != 1 {
		t.Fatalf("content_shred rows = %d, delivered = %d, want the retry to queue nothing new",
			shredRows, shredDelivered)
	}
	finalDeleted, finalState := crashTaskState(t, c.dbName)
	if finalDeleted == nil || !finalDeleted.Equal(*deletedBefore) || finalState != stateBefore {
		t.Fatalf("the retry resurrected the deleted task: %v %q", finalDeleted, finalState)
	}
}
