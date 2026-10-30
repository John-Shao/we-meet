package migrate

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/testpg"
)

// These tests exercise increment 0009 (F0-R2 fragment ownership, send
// de-duplication gate, canonical checkpoint head and the usage dedup fact)
// against a real PostgreSQL instance with several concurrent connections.
// Every domain call goes through the work_worker login, so the grants and the
// tenant context are part of the assertion, not bypassed by a superuser.

type gateRun struct {
	org      string
	subject  string
	taskID   string
	runID    string
	opID     string
	attempt  string
	planExec string
	execExec string
	holder   string
	headRef  string
	headHash string
	slot     string
}

func newUUID(t *testing.T) string {
	t.Helper()
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		t.Fatal(err)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

func docHash(t *testing.T, seed string) string {
	t.Helper()
	body := strings.Repeat(seed, 64)
	return "sha256:" + body[:64]
}

func newGateDB(t *testing.T) (string, *pgx.Conn) {
	t.Helper()
	if testAdmin == nil {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx := testContext(t)
	if err := testpg.EnsureFixtures(ctx, testAdmin); err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, testAdmin, "work_gate_test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = testpg.DropDatabase(cleanupCtx, testAdmin, dbName)
	})
	admin := connect(t, adminURL(dbName))
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	return dbName, admin
}

// newPreGateDB stops at increment 0008 so that the pre-0009 usage marker can be
// produced before the migration that replaces it.
func newPreGateDB(t *testing.T) (string, *pgx.Conn) {
	t.Helper()
	if testAdmin == nil {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx := testContext(t)
	if err := testpg.EnsureFixtures(ctx, testAdmin); err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("work_pre_gate_%d", time.Now().UnixNano())
	if len(name) > 63 {
		name = name[:63]
	}
	if _, err := testAdmin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" OWNER work_owner"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = testpg.DropDatabase(cleanupCtx, testAdmin, name)
	})
	admin := connect(t, adminURL(name))
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	for _, apply := range []func(context.Context, *pgx.Conn) error{
		testpg.ApplyBaseline,
		testpg.ApplyDirectoryAbsence,
		testpg.ApplyOutboxTaskEventKind,
		testpg.ApplyRunWorkflowID,
		testpg.ApplyOrgProvision,
		testpg.ApplyOrgProvisionBackfill,
		testpg.ApplyQuotaDirectoryUsageHardening,
	} {
		if err := apply(ctx, admin); err != nil {
			t.Fatal(err)
		}
	}
	return name, admin
}

func workerConn(t *testing.T, dbName, org string) *pgx.Conn {
	t.Helper()
	conn := connect(t, testpg.WorkerURL(dbName))
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	if org != "" {
		if _, err := conn.Exec(testContext(t), fmt.Sprintf("SET app.org_id = %s", quoteLiteral(org))); err != nil {
			t.Fatal(err)
		}
	}
	return conn
}

func quoteLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// seedRun inserts the base facts for one Run with one authorized model
// Operation. Base rows are written with the admin connection; every domain
// transition below runs through work_worker.
func seedRun(t *testing.T, admin *pgx.Conn, org string) *gateRun {
	t.Helper()
	ctx := testContext(t)
	run := &gateRun{
		org:      org,
		subject:  "sub_" + org,
		taskID:   newUUID(t),
		runID:    newUUID(t),
		opID:     newUUID(t),
		planExec: newUUID(t),
		execExec: newUUID(t),
		holder:   "holder-" + newUUID(t),
		slot:     newUUID(t),
		headRef:  "cp/0/" + org,
		headHash: docHash(t, "1"),
	}
	snapshotID := newUUID(t)
	inputID := newUUID(t)
	sql := fmt.Sprintf(`
		SET app.org_id = %[1]s;
		INSERT INTO work.org (id, status, home_region) VALUES (%[1]s, 'active', 'cn-north')
		ON CONFLICT (id) DO NOTHING;
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES (%[1]s, %[2]s, 'active', 'owner', true)
		ON CONFLICT (org_id, subject_id) DO NOTHING;
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%[3]s', %[1]s, %[2]s, 'input/%[3]s', repeat('a', 64), 12);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, input_id, title)
		VALUES ('%[4]s', %[1]s, %[2]s, 'open', '%[3]s', 'gate task');
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		VALUES ('%[5]s', %[1]s, '%[4]s', 'v1', repeat('b', 64),
		        ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		UPDATE work.task SET snapshot_id = '%[5]s' WHERE id = '%[4]s';
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('%[6]s', %[1]s, '%[4]s', 1, 'active', '%[5]s', 'run:%[6]s', 'pi-1');
		UPDATE work.task SET active_run_id = '%[6]s', latest_run_id = '%[6]s' WHERE id = '%[4]s';
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state)
		VALUES ('%[7]s', %[1]s, '%[6]s', 'model:1', 'model', repeat('c', 64), 'authorized');
	`, quoteLiteral(org), quoteLiteral(run.subject), inputID, run.taskID, snapshotID, run.runID, run.opID)
	if err := execRaw(ctx, admin, sql); err != nil {
		t.Fatal(err)
	}
	return run
}

// commitFirstHead registers and claims a plan fragment and commits checkpoint
// head revision 0, which is the base every execute fragment must bind to.
func commitFirstHead(t *testing.T, worker *pgx.Conn, run *gateRun) {
	t.Helper()
	ctx := testContext(t)
	var state string
	if err := worker.QueryRow(ctx,
		`SELECT work.register_runtime_execution($1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes')`,
		run.org, run.planExec, run.runID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "registered" {
		t.Fatalf("plan register state = %q", state)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		run.org, run.planExec, run.holder+"-plan",
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := worker.QueryRow(ctx,
		`SELECT work.commit_runtime_checkpoint($1, $2, $3, NULL, NULL, NULL, $4, $5, 'pi-1')`,
		run.org, run.runID, run.planExec, run.headRef, run.headHash,
	).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision != 0 {
		t.Fatalf("first head revision = %d, want 0", revision)
	}
}

// prepareExecuteFragment reserves quota, claims the dispatch attempt and
// registers plus claims the execute fragment. It stops right before the send
// boundary.
func prepareExecuteFragment(t *testing.T, worker *pgx.Conn, run *gateRun) {
	t.Helper()
	ctx := testContext(t)
	var reservation string
	if err := worker.QueryRow(ctx,
		`SELECT work.reserve_quota($1, 'default', to_char(now(), 'YYYY-MM'), $2, 1000)::text`,
		run.org, run.opID,
	).Scan(&reservation); err != nil {
		t.Fatal(err)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_dispatch($1, $2, 'consumer-1', 1)::text`,
		run.opID, run.org,
	).Scan(&run.attempt); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := worker.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'execute', 1, 'pi-1', now() + interval '10 minutes',
			$4, $5, $6, $7, repeat('c', 64), $8, $9)`,
		run.org, run.execExec, run.runID, run.headRef, run.headHash,
		"intent/"+run.opID, docHash(t, "2"), run.opID, run.attempt,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "registered" {
		t.Fatalf("execute register state = %q", state)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		run.org, run.execExec, run.holder,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "claimed" {
		t.Fatalf("execute claim state = %q", state)
	}
}

func consume(ctx context.Context, conn *pgx.Conn, run *gateRun, invocation, slot string) (map[string]any, error) {
	var body []byte
	err := conn.QueryRow(ctx, `
		SELECT work.consume_dispatch_delivery($1, $2, $3, $4, $5, repeat('c', 64), 1, $6, $7)`,
		run.org, run.opID, run.execExec, run.holder, run.attempt, invocation, slot,
	).Scan(&body)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func attachReceipt(ctx context.Context, conn *pgx.Conn, run *gateRun, slot, ref, hash, result string) (map[string]any, error) {
	var body []byte
	err := conn.QueryRow(ctx,
		`SELECT work.attach_dispatch_receipt($1, $2, $3, $4, $5, $6, 'prov-1', 'gw-1')`,
		run.org, run.opID, slot, ref, hash, result,
	).Scan(&body)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func assertPgMessage(t *testing.T, err error, message string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("error = %v, want PostgreSQL error %q", err, message)
	}
	if !strings.Contains(pgErr.Message, message) {
		t.Fatalf("error message = %q, want %q", pgErr.Message, message)
	}
}

func scalarString(t *testing.T, conn *pgx.Conn, sql string, args ...any) string {
	t.Helper()
	var value string
	if err := conn.QueryRow(testContext(t), sql, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func scalarCount(t *testing.T, conn *pgx.Conn, sql string, args ...any) int {
	t.Helper()
	var value int
	if err := conn.QueryRow(testContext(t), sql, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

// RR-02: two egress callers race for the same gate. Exactly one is told "won";
// the loser only observes, and PostgreSQL holds exactly one gate row.
func TestConcurrentConsumeHasExactlyOneWinner(t *testing.T) {
	dbName, admin := newGateDB(t)
	setup := workerConn(t, dbName, "org_race")
	run := seedRun(t, admin, "org_race")
	commitFirstHead(t, setup, run)
	prepareExecuteFragment(t, setup, run)

	first := workerConn(t, dbName, run.org)
	second := workerConn(t, dbName, run.org)
	results := make([]map[string]any, 2)
	errs := make([]error, 2)
	conns := []*pgx.Conn{first, second}
	slots := []string{run.slot, newUUID(t)}
	start := make(chan struct{})
	var wg sync.WaitGroup
	ctx := testContext(t)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			results[index], errs[index] = consume(ctx, conns[index],
				run, fmt.Sprintf("gw-invocation-%d", index), slots[index])
		}(i)
	}
	close(start)
	wg.Wait()

	won := 0
	observed := 0
	for i, result := range results {
		if errs[i] != nil {
			t.Fatalf("consume %d: %v", i, errs[i])
		}
		switch result["outcome"] {
		case "won":
			won++
		case "observed":
			observed++
		default:
			t.Fatalf("consume %d outcome = %v", i, result["outcome"])
		}
	}
	if won != 1 || observed != 1 {
		t.Fatalf("won = %d, observed = %d, results = %#v", won, observed, results)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.dispatch_delivery WHERE org_id = $1 AND operation_id = $2`,
		run.org, run.opID); got != 1 {
		t.Fatalf("gate rows = %d, want 1", got)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.audit_event WHERE org_id = $1 AND action = 'dispatch.gate_consumed'`,
		run.org); got != 1 {
		t.Fatalf("gate_consumed audits = %d, want 1", got)
	}
}

// RR-04: seal and consume are linearized by the same lock order. A consumed
// gate can never be sealed into "not sent", and a sealed gate can never be
// consumed afterwards.
func TestSealLosesToConsumedGateAndConsumeLosesToSeal(t *testing.T) {
	dbName, admin := newGateDB(t)

	consumedWorker := workerConn(t, dbName, "org_seal_a")
	consumed := seedRun(t, admin, "org_seal_a")
	commitFirstHead(t, consumedWorker, consumed)
	prepareExecuteFragment(t, consumedWorker, consumed)
	result, err := consume(testContext(t), consumedWorker, consumed, "gw-1", consumed.slot)
	if err != nil {
		t.Fatal(err)
	}
	if result["outcome"] != "won" {
		t.Fatalf("consume outcome = %v", result["outcome"])
	}
	var sealBody []byte
	if err := consumedWorker.QueryRow(testContext(t),
		`SELECT work.seal_dispatch_not_sent($1, $2, 'lease_expired', $3)`,
		consumed.org, consumed.opID, consumed.execExec,
	).Scan(&sealBody); err != nil {
		t.Fatal(err)
	}
	seal := map[string]any{}
	if err := json.Unmarshal(sealBody, &seal); err != nil {
		t.Fatal(err)
	}
	if seal["outcome"] != "already_consumed" || seal["not_sent_proven"] != false {
		t.Fatalf("seal over consumed gate = %#v", seal)
	}
	if got := scalarString(t, admin,
		`SELECT gate_state FROM work.dispatch_delivery WHERE org_id = $1 AND operation_id = $2`,
		consumed.org, consumed.opID); got != "consumed" {
		t.Fatalf("gate state after seal attempt = %q", got)
	}

	sealedWorker := workerConn(t, dbName, "org_seal_b")
	sealed := seedRun(t, admin, "org_seal_b")
	commitFirstHead(t, sealedWorker, sealed)
	prepareExecuteFragment(t, sealedWorker, sealed)
	if err := sealedWorker.QueryRow(testContext(t),
		`SELECT work.seal_dispatch_not_sent($1, $2, 'cancel_requested', $3)`,
		sealed.org, sealed.opID, sealed.execExec,
	).Scan(&sealBody); err != nil {
		t.Fatal(err)
	}
	seal = map[string]any{}
	if err := json.Unmarshal(sealBody, &seal); err != nil {
		t.Fatal(err)
	}
	if seal["outcome"] != "sealed" || seal["not_sent_proven"] != true {
		t.Fatalf("seal on empty gate = %#v", seal)
	}
	// The sealing command also revoked the fragment, so the late consume has
	// two independent reasons to fail; the gate itself stays sealed.
	late, err := consume(testContext(t), sealedWorker, sealed, "gw-late", sealed.slot)
	if err != nil {
		t.Fatal(err)
	}
	if late["outcome"] != "observed" || late["gate_state"] != "sealed_not_sent" {
		t.Fatalf("late consume = %#v", late)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.dispatch_delivery
		  WHERE org_id = $1 AND gate_state = 'sealed_not_sent'`, sealed.org); got != 1 {
		t.Fatalf("sealed rows = %d, want 1", got)
	}
	// Re-sealing is idempotent and still proves not_sent.
	if err := sealedWorker.QueryRow(testContext(t),
		`SELECT work.seal_dispatch_not_sent($1, $2, 'cancel_requested', NULL)`,
		sealed.org, sealed.opID,
	).Scan(&sealBody); err != nil {
		t.Fatal(err)
	}
	seal = map[string]any{}
	if err := json.Unmarshal(sealBody, &seal); err != nil {
		t.Fatal(err)
	}
	if seal["outcome"] != "already_sealed" || seal["not_sent_proven"] != true {
		t.Fatalf("re-seal = %#v", seal)
	}
}

// RR-01/RR-03: a consumed gate does not reopen when the lease expires, when the
// holder restarts under a new identity, or when the receipt is lost.
func TestConsumedGateNeverReopens(t *testing.T) {
	dbName, admin := newGateDB(t)
	worker := workerConn(t, dbName, "org_reopen")
	run := seedRun(t, admin, "org_reopen")
	commitFirstHead(t, worker, run)
	prepareExecuteFragment(t, worker, run)
	if result, err := consume(testContext(t), worker, run, "gw-1", run.slot); err != nil {
		t.Fatal(err)
	} else if result["outcome"] != "won" {
		t.Fatalf("consume outcome = %v", result["outcome"])
	}

	// Simulate a lease that elapsed while the gateway call was in flight.
	if _, err := admin.Exec(testContext(t),
		`UPDATE work.runtime_execution SET lease_until = now() - interval '1 second'
		  WHERE org_id = $1 AND execution_id = $2`, run.org, run.execExec); err != nil {
		t.Fatal(err)
	}
	_, err := consume(testContext(t), worker, run, "gw-2", newUUID(t))
	if err != nil {
		t.Fatal(err)
	}
	// An existing gate short-circuits the decision before any lease check.
	if got := scalarString(t, admin,
		`SELECT gate_state FROM work.dispatch_delivery WHERE org_id = $1 AND operation_id = $2`,
		run.org, run.opID); got != "consumed" {
		t.Fatalf("gate state = %q", got)
	}

	// A restarted parent process gets a new holder and must register a new
	// fragment; the gate still refuses to hand out a second "won".
	if _, err := worker.Exec(testContext(t),
		`SELECT work.revoke_runtime_execution($1, $2, 'holder_restart')`, run.org, run.execExec); err != nil {
		t.Fatal(err)
	}
	restarted := *run
	restarted.execExec = newUUID(t)
	restarted.holder = "holder-restarted"
	var state string
	err = worker.QueryRow(testContext(t), `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'execute', 1, 'pi-1', now() + interval '10 minutes',
			$4, $5, $6, $7, repeat('c', 64), $8, $9)`,
		restarted.org, restarted.execExec, restarted.runID, restarted.headRef, restarted.headHash,
		"intent/"+restarted.opID, docHash(t, "2"), restarted.opID, restarted.attempt,
	).Scan(&state)
	assertPgMessage(t, err, "dispatch_gate_exists")

	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.audit_event WHERE org_id = $1 AND action = 'dispatch.gate_consumed'`,
		run.org); got != 1 {
		t.Fatalf("gate_consumed audits = %d, want 1", got)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.dispatch_delivery WHERE org_id = $1`, run.org); got != 1 {
		t.Fatalf("gate rows = %d, want 1", got)
	}
}

// RR-06: the first terminal receipt version is immutable. Re-attaching the same
// document is idempotent; different content conflicts and changes nothing.
func TestReceiptAttachIsIdempotentAndRejectsConflict(t *testing.T) {
	dbName, admin := newGateDB(t)
	worker := workerConn(t, dbName, "org_receipt")
	run := seedRun(t, admin, "org_receipt")
	commitFirstHead(t, worker, run)
	prepareExecuteFragment(t, worker, run)
	if _, err := consume(testContext(t), worker, run, "gw-1", run.slot); err != nil {
		t.Fatal(err)
	}

	hash := docHash(t, "3")
	first, err := attachReceipt(testContext(t), worker, run, run.slot, "receipt/1", hash, "success")
	if err != nil {
		t.Fatal(err)
	}
	if first["outcome"] != "recorded" {
		t.Fatalf("first attach = %#v", first)
	}
	again, err := attachReceipt(testContext(t), worker, run, run.slot, "receipt/1", hash, "success")
	if err != nil {
		t.Fatal(err)
	}
	if again["outcome"] != "idempotent" {
		t.Fatalf("replayed attach = %#v", again)
	}

	_, err = attachReceipt(testContext(t), worker, run, run.slot, "receipt/2", docHash(t, "4"), "success")
	assertPgMessage(t, err, "receipt_content_conflict")
	_, err = attachReceipt(testContext(t), worker, run, run.slot, "receipt/1", hash, "rejected_not_executed")
	assertPgMessage(t, err, "receipt_content_conflict")
	_, err = attachReceipt(testContext(t), worker, run, newUUID(t), "receipt/1", hash, "success")
	assertPgMessage(t, err, "receipt_slot_mismatch")

	if got := scalarString(t, admin,
		`SELECT receipt_hash FROM work.dispatch_delivery WHERE org_id = $1 AND operation_id = $2`,
		run.org, run.opID); got != hash {
		t.Fatalf("stored receipt hash = %q, want %q", got, hash)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.audit_event WHERE org_id = $1 AND action = 'dispatch.receipt_attached'`,
		run.org); got != 1 {
		t.Fatalf("receipt audits = %d, want 1", got)
	}
}

// RR-07/RR-09: the head only advances by CAS on the expected revision/ref/hash.
// A stale base conflicts, a committed candidate replays to its historical
// revision, and a revoked fragment's candidate is refused.
func TestCheckpointHeadCASConflictAndRevokedCandidate(t *testing.T) {
	dbName, admin := newGateDB(t)
	worker := workerConn(t, dbName, "org_head")
	run := seedRun(t, admin, "org_head")
	commitFirstHead(t, worker, run)

	// Second fragment advances the head from revision 0 to 1.
	secondExec := newUUID(t)
	nextRef := "cp/1/" + run.org
	nextHash := docHash(t, "5")
	var state string
	if err := worker.QueryRow(testContext(t), `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes', $4, $5)`,
		run.org, secondExec, run.runID, run.headRef, run.headHash,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.Exec(testContext(t),
		`SELECT work.claim_runtime_execution($1, $2, 'holder-head-2')`, run.org, secondExec); err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := worker.QueryRow(testContext(t),
		`SELECT work.commit_runtime_checkpoint($1, $2, $3, 0, $4, $5, $6, $7, 'pi-1')`,
		run.org, run.runID, secondExec, run.headRef, run.headHash, nextRef, nextHash,
	).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision != 1 {
		t.Fatalf("second head revision = %d, want 1", revision)
	}
	// Replay of the committed candidate returns history, never a new revision.
	if err := worker.QueryRow(testContext(t),
		`SELECT work.commit_runtime_checkpoint($1, $2, $3, 0, $4, $5, $6, $7, 'pi-1')`,
		run.org, run.runID, secondExec, run.headRef, run.headHash, nextRef, nextHash,
	).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision != 1 {
		t.Fatalf("replayed head revision = %d, want 1", revision)
	}

	// A third fragment that still believes in revision 0 loses the CAS.
	thirdExec := newUUID(t)
	if err := worker.QueryRow(testContext(t), `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes', $4, $5)`,
		run.org, thirdExec, run.runID, nextRef, nextHash,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.Exec(testContext(t),
		`SELECT work.claim_runtime_execution($1, $2, 'holder-head-3')`, run.org, thirdExec); err != nil {
		t.Fatal(err)
	}
	err := worker.QueryRow(testContext(t),
		`SELECT work.commit_runtime_checkpoint($1, $2, $3, 0, $4, $5, $6, $7, 'pi-1')`,
		run.org, run.runID, thirdExec, run.headRef, run.headHash, "cp/stale", docHash(t, "6"),
	).Scan(&revision)
	assertPgMessage(t, err, "runtime_checkpoint_base_mismatch")

	// A revoked fragment cannot advance the head even with a valid base.
	if _, err := worker.Exec(testContext(t),
		`SELECT work.revoke_runtime_execution($1, $2, 'run_canceled')`, run.org, thirdExec); err != nil {
		t.Fatal(err)
	}
	err = worker.QueryRow(testContext(t),
		`SELECT work.commit_runtime_checkpoint($1, $2, $3, 1, $4, $5, $6, $7, 'pi-1')`,
		run.org, run.runID, thirdExec, nextRef, nextHash, "cp/2", docHash(t, "7"),
	).Scan(&revision)
	assertPgMessage(t, err, "runtime_execution_revoked")

	if got := scalarString(t, admin,
		`SELECT checkpoint_revision::text || ':' || checkpoint_hash
		   FROM work.runtime_checkpoint_head WHERE org_id = $1 AND run_id = $2`,
		run.org, run.runID); got != "1:"+nextHash {
		t.Fatalf("head after conflicts = %q", got)
	}
}

// Two concurrent commits against the same base: one advances, one conflicts.
func TestConcurrentCheckpointCommitHasOneWinner(t *testing.T) {
	dbName, admin := newGateDB(t)
	worker := workerConn(t, dbName, "org_head_race")
	run := seedRun(t, admin, "org_head_race")
	commitFirstHead(t, worker, run)

	execs := []string{newUUID(t), newUUID(t)}
	// Only one fragment may be live per Run, so the second fragment is
	// registered after the first is revoked; both still hold a valid base.
	var state string
	for i, execID := range execs {
		if i == 1 {
			if _, err := worker.Exec(testContext(t),
				`SELECT work.revoke_runtime_execution($1, $2, 'drain')`, run.org, execs[0]); err != nil {
				t.Fatal(err)
			}
		}
		if err := worker.QueryRow(testContext(t), `
			SELECT work.register_runtime_execution(
				$1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes', $4, $5)`,
			run.org, execID, run.runID, run.headRef, run.headHash,
		).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if _, err := worker.Exec(testContext(t),
			`SELECT work.claim_runtime_execution($1, $2, $3)`,
			run.org, execID, fmt.Sprintf("holder-%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	// Revoking the first fragment removed its commit right: the surviving
	// fragment is the only one that may advance the head.
	err := worker.QueryRow(testContext(t),
		`SELECT work.commit_runtime_checkpoint($1, $2, $3, 0, $4, $5, 'cp/revoked', $6, 'pi-1')`,
		run.org, run.runID, execs[0], run.headRef, run.headHash, docHash(t, "8"),
	).Scan(&state)
	assertPgMessage(t, err, "runtime_execution_revoked")
	var revision int64
	if err := worker.QueryRow(testContext(t),
		`SELECT work.commit_runtime_checkpoint($1, $2, $3, 0, $4, $5, 'cp/live', $6, 'pi-1')`,
		run.org, run.runID, execs[1], run.headRef, run.headHash, docHash(t, "9"),
	).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision != 1 {
		t.Fatalf("head revision = %d, want 1", revision)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.runtime_checkpoint_head WHERE org_id = $1`, run.org); got != 1 {
		t.Fatalf("head rows = %d", got)
	}
}

// RR-01: only the current holder may claim or renew, a replay by the same
// holder is a query, an older sequence does not extend the lease and a late
// heartbeat never revives an expired fragment.
func TestFragmentOwnershipRejectsNonHolder(t *testing.T) {
	dbName, admin := newGateDB(t)
	worker := workerConn(t, dbName, "org_holder")
	run := seedRun(t, admin, "org_holder")
	commitFirstHead(t, worker, run)
	prepareExecuteFragment(t, worker, run)

	ctx := testContext(t)
	var state string
	err := worker.QueryRow(ctx, `SELECT work.claim_runtime_execution($1, $2, 'other-holder')`,
		run.org, run.execExec).Scan(&state)
	assertPgMessage(t, err, "runtime_execution_holder_mismatch")
	if err := worker.QueryRow(ctx, `SELECT work.claim_runtime_execution($1, $2, $3)`,
		run.org, run.execExec, run.holder).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "already_claimed" {
		t.Fatalf("same-holder claim = %q", state)
	}

	var lease, lease2 time.Time
	if err := worker.QueryRow(ctx, `SELECT work.renew_runtime_execution($1, $2, $3, 5)`,
		run.org, run.execExec, run.holder).Scan(&lease); err != nil {
		t.Fatal(err)
	}
	err = worker.QueryRow(ctx, `SELECT work.renew_runtime_execution($1, $2, 'other-holder', 6)`,
		run.org, run.execExec).Scan(&lease2)
	assertPgMessage(t, err, "runtime_execution_holder_mismatch")
	// A duplicate or older sequence returns the current lease unchanged.
	if err := worker.QueryRow(ctx, `SELECT work.renew_runtime_execution($1, $2, $3, 5)`,
		run.org, run.execExec, run.holder).Scan(&lease2); err != nil {
		t.Fatal(err)
	}
	if !lease2.Equal(lease) {
		t.Fatalf("duplicate heartbeat extended the lease: %v -> %v", lease, lease2)
	}
	if got := scalarCount(t, admin,
		`SELECT heartbeat_seq FROM work.runtime_execution WHERE execution_id = $1`,
		run.execExec); got != 5 {
		t.Fatalf("heartbeat_seq = %d, want 5", got)
	}

	// An expired lease is not revived by a late heartbeat: the fragment is
	// terminated and renew returns NULL, which is not a lease.
	if _, err := admin.Exec(ctx,
		`UPDATE work.runtime_execution SET lease_until = now() - interval '1 second'
		  WHERE execution_id = $1`, run.execExec); err != nil {
		t.Fatal(err)
	}
	var lateLease *time.Time
	if err := worker.QueryRow(ctx, `SELECT work.renew_runtime_execution($1, $2, $3, 9)`,
		run.org, run.execExec, run.holder).Scan(&lateLease); err != nil {
		t.Fatal(err)
	}
	if lateLease != nil {
		t.Fatalf("late heartbeat returned a lease: %v", *lateLease)
	}
	if got := scalarString(t, admin,
		`SELECT state FROM work.runtime_execution WHERE execution_id = $1`, run.execExec); got != "expired" {
		t.Fatalf("state after late heartbeat = %q", got)
	}
	err = worker.QueryRow(ctx, `SELECT work.claim_runtime_execution($1, $2, $3)`,
		run.org, run.execExec, run.holder).Scan(&state)
	assertPgMessage(t, err, "runtime_execution_not_claimable")
	// A consume attempt by the expired fragment is refused as well.
	_, err = consume(ctx, worker, run, "gw-expired", run.slot)
	assertPgMessage(t, err, "runtime_execution_not_active")
}

// A live fragment blocks a second registration for the same Run; an elapsed
// fragment is expired explicitly by the registering command under the lock, so
// the partial unique index never has to consult the clock.
func TestRegisterExpiresStaleFragmentUnderLock(t *testing.T) {
	dbName, admin := newGateDB(t)
	worker := workerConn(t, dbName, "org_expire")
	run := seedRun(t, admin, "org_expire")
	commitFirstHead(t, worker, run)

	ctx := testContext(t)
	stale := newUUID(t)
	fresh := newUUID(t)
	var state string
	if err := worker.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes', $4, $5)`,
		run.org, stale, run.runID, run.headRef, run.headHash,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.Exec(ctx,
		`SELECT work.claim_runtime_execution($1, $2, 'holder-stale')`, run.org, stale); err != nil {
		t.Fatal(err)
	}
	err := worker.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes', $4, $5)`,
		run.org, fresh, run.runID, run.headRef, run.headHash,
	).Scan(&state)
	assertPgMessage(t, err, "runtime_execution_already_live")

	if _, err := admin.Exec(ctx,
		`UPDATE work.runtime_execution SET lease_until = now() - interval '1 second'
		  WHERE execution_id = $1`, stale); err != nil {
		t.Fatal(err)
	}
	if err := worker.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes', $4, $5)`,
		run.org, fresh, run.runID, run.headRef, run.headHash,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "registered" {
		t.Fatalf("register after expiry = %q", state)
	}
	if got := scalarString(t, admin,
		`SELECT state FROM work.runtime_execution WHERE execution_id = $1`, stale); got != "expired" {
		t.Fatalf("stale fragment state = %q", got)
	}
	if got := scalarCount(t, admin, `
		SELECT count(*) FROM work.runtime_execution
		 WHERE org_id = $1 AND run_id = $2 AND state IN ('registered', 'active')`,
		run.org, run.runID); got != 1 {
		t.Fatalf("live fragments = %d, want 1", got)
	}
	if got := scalarCount(t, admin, `
		SELECT count(*) FROM work.audit_event
		 WHERE org_id = $1 AND action = 'runtime.execution_expired'`, run.org); got != 1 {
		t.Fatalf("expiry audits = %d, want 1", got)
	}
	// Re-registering the same execution id with a different binding conflicts.
	err = worker.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'plan', 1, 'pi-2', now() + interval '10 minutes', $4, $5)`,
		run.org, fresh, run.runID, run.headRef, run.headHash,
	).Scan(&state)
	assertPgMessage(t, err, "runtime_execution_binding_conflict")
}

// Every 0009 command requires a matching tenant context. A foreign context and
// a missing context are both rejections, never silent empty results.
func TestRuntimeCommandsRejectCrossTenantAndMissingOrgContext(t *testing.T) {
	dbName, admin := newGateDB(t)
	owner := workerConn(t, dbName, "org_ctx_a")
	run := seedRun(t, admin, "org_ctx_a")
	commitFirstHead(t, owner, run)
	prepareExecuteFragment(t, owner, run)
	if _, err := consume(testContext(t), owner, run, "gw-1", run.slot); err != nil {
		t.Fatal(err)
	}
	if _, err := attachReceipt(testContext(t), owner, run, run.slot, "receipt/1", docHash(t, "3"), "success"); err != nil {
		t.Fatal(err)
	}
	// A second tenant exists so that the foreign context is a real org.
	_ = seedRun(t, admin, "org_ctx_b")

	calls := []struct {
		name string
		sql  string
		args []any
	}{
		{"register_runtime_execution", `SELECT work.register_runtime_execution(
			$1, gen_random_uuid(), $2, 'plan', 1, 'pi-1', now() + interval '5 minutes')`,
			[]any{run.org, run.runID}},
		{"claim_runtime_execution", `SELECT work.claim_runtime_execution($1, $2, 'holder-x')`,
			[]any{run.org, run.execExec}},
		{"renew_runtime_execution", `SELECT work.renew_runtime_execution($1, $2, 'holder-x', 2)`,
			[]any{run.org, run.execExec}},
		{"revoke_runtime_execution", `SELECT work.revoke_runtime_execution($1, $2, 'cancel_requested')`,
			[]any{run.org, run.execExec}},
		{"consume_dispatch_delivery", `SELECT work.consume_dispatch_delivery(
			$1, $2, $3, 'holder-x', gen_random_uuid(), repeat('c', 64), 1, 'gw-x', gen_random_uuid())`,
			[]any{run.org, run.opID, run.execExec}},
		{"seal_dispatch_not_sent", `SELECT work.seal_dispatch_not_sent($1, $2, 'cancel_requested', NULL)`,
			[]any{run.org, run.opID}},
		{"attach_dispatch_receipt", `SELECT work.attach_dispatch_receipt(
			$1, $2, gen_random_uuid(), 'receipt/x', 'sha256:` + strings.Repeat("a", 64) + `', 'success')`,
			[]any{run.org, run.opID}},
		{"commit_runtime_checkpoint", `SELECT work.commit_runtime_checkpoint(
			$1, $2, $3, NULL, NULL, NULL, 'cp/x', 'sha256:` + strings.Repeat("b", 64) + `', 'pi-1')`,
			[]any{run.org, run.runID, run.execExec}},
		{"finish_operation_from_receipt", `SELECT work.finish_operation_from_receipt(
			$1, $2, 'sha256:` + strings.Repeat("3", 64) + `', 'provider', 'aliyun', 'qwen3.8-flash',
			current_date, 10, 5, 0, 15)`,
			[]any{run.org, run.opID}},
	}

	foreign := workerConn(t, dbName, "org_ctx_b")
	anonymous := workerConn(t, dbName, "")
	for _, call := range calls {
		var ignored []byte
		err := foreign.QueryRow(testContext(t), call.sql, call.args...).Scan(&ignored)
		if err == nil {
			t.Fatalf("%s accepted a foreign tenant context", call.name)
		}
		assertPgMessage(t, err, "runtime_org_context_mismatch")
		err = anonymous.QueryRow(testContext(t), call.sql, call.args...).Scan(&ignored)
		if err == nil {
			t.Fatalf("%s accepted a missing tenant context", call.name)
		}
		assertPgMessage(t, err, "runtime_org_context_mismatch")
	}

	// The foreign tenant also cannot reach the rows by passing its own org id.
	var ignored []byte
	err := foreign.QueryRow(testContext(t),
		`SELECT work.seal_dispatch_not_sent('org_ctx_b', $1, 'cancel_requested', NULL)`, run.opID).Scan(&ignored)
	assertPgMessage(t, err, "operation_not_found")
	if got := scalarString(t, admin,
		`SELECT gate_state FROM work.dispatch_delivery WHERE org_id = $1 AND operation_id = $2`,
		run.org, run.opID); got != "receipt_recorded" {
		t.Fatalf("gate state after cross-tenant attempts = %q", got)
	}
}

// Replaying usage for an operation that the pre-0009 marker already counted
// must not add a second contribution to usage_daily.
func TestLegacyUsageReplayDoesNotDoubleCount(t *testing.T) {
	dbName, admin := newPreGateDB(t)
	run := seedRun(t, admin, "org_legacy")
	preWorker := workerConn(t, dbName, run.org)

	// 0008 behaviour: usage is recorded through the timestamp marker.
	if _, err := preWorker.Exec(testContext(t), `
		SELECT work.record_usage($1, $2, $3, 'aliyun', 'qwen3.8-flash', current_date, 100, 50, 0, 1)`,
		run.org, run.subject, run.opID); err != nil {
		t.Fatal(err)
	}
	if got := scalarCount(t, admin,
		`SELECT input_tokens FROM work.usage_daily WHERE org_id = $1`, run.org); got != 100 {
		t.Fatalf("pre-migration input tokens = %d", got)
	}

	if err := testpg.ApplyRuntimeExecutionDispatchGate(testContext(t), admin); err != nil {
		t.Fatal(err)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.operation_usage_fact
		  WHERE org_id = $1 AND operation_id = $2 AND origin = 'legacy_marker_backfill'`,
		run.org, run.opID); got != 1 {
		t.Fatalf("backfilled dedup facts = %d, want 1", got)
	}

	worker := workerConn(t, dbName, run.org)
	// Replay through the legacy entry point.
	if _, err := worker.Exec(testContext(t), `
		SELECT work.record_usage($1, $2, $3, 'aliyun', 'qwen3.8-flash', current_date, 100, 50, 0, 1)`,
		run.org, run.subject, run.opID); err != nil {
		t.Fatal(err)
	}
	// Replay through the receipt-driven finishing command.
	commitFirstHead(t, worker, run)
	prepareExecuteFragment(t, worker, run)
	if _, err := consume(testContext(t), worker, run, "gw-1", run.slot); err != nil {
		t.Fatal(err)
	}
	hash := docHash(t, "3")
	if _, err := attachReceipt(testContext(t), worker, run, run.slot, "receipt/1", hash, "success"); err != nil {
		t.Fatal(err)
	}
	var body []byte
	if err := worker.QueryRow(testContext(t), `
		SELECT work.finish_operation_from_receipt(
			$1, $2, $3, 'provider', 'aliyun', 'qwen3.8-flash', current_date, 100, 50, 0, 150)`,
		run.org, run.opID, hash,
	).Scan(&body); err != nil {
		t.Fatal(err)
	}
	result := map[string]any{}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	if result["usage"] != "legacy_counted" || result["usage_counted"] != false {
		t.Fatalf("legacy replay result = %#v", result)
	}
	if result["outcome"] != "confirmed" {
		t.Fatalf("legacy replay outcome = %#v", result)
	}
	if got := scalarCount(t, admin,
		`SELECT input_tokens FROM work.usage_daily WHERE org_id = $1`, run.org); got != 100 {
		t.Fatalf("input tokens after replays = %d, want 100", got)
	}
	if got := scalarCount(t, admin,
		`SELECT output_tokens FROM work.usage_daily WHERE org_id = $1`, run.org); got != 50 {
		t.Fatalf("output tokens after replays = %d, want 50", got)
	}
	if got := scalarCount(t, admin,
		`SELECT run_count FROM work.usage_daily WHERE org_id = $1`, run.org); got != 1 {
		t.Fatalf("run_count after replays = %d, want 1", got)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.operation_usage_fact WHERE org_id = $1`, run.org); got != 1 {
		t.Fatalf("usage facts = %d, want 1", got)
	}
	if got := scalarString(t, admin,
		`SELECT state FROM work.operation WHERE id = $1`, run.opID); got != "succeeded" {
		t.Fatalf("operation state = %q", got)
	}
}

// usage_source = 'unavailable' keeps NULL tokens, never 0, does not settle, and
// a later provider revision only adds the difference. The confirmed success is
// never reversed.
func TestUnavailableUsageStaysNullAndSuccessIsNotReversed(t *testing.T) {
	dbName, admin := newGateDB(t)
	worker := workerConn(t, dbName, "org_unavailable")
	run := seedRun(t, admin, "org_unavailable")
	commitFirstHead(t, worker, run)
	prepareExecuteFragment(t, worker, run)
	if _, err := consume(testContext(t), worker, run, "gw-1", run.slot); err != nil {
		t.Fatal(err)
	}
	hash := docHash(t, "3")
	if _, err := attachReceipt(testContext(t), worker, run, run.slot, "receipt/1", hash, "success"); err != nil {
		t.Fatal(err)
	}

	ctx := testContext(t)
	var body []byte
	// Zero is not a stand-in for unknown.
	err := worker.QueryRow(ctx, `
		SELECT work.finish_operation_from_receipt(
			$1, $2, $3, 'unavailable', 'aliyun', 'qwen3.8-flash', current_date, 0, 0, 0, 0)`,
		run.org, run.opID, hash,
	).Scan(&body)
	assertPgMessage(t, err, "usage_unavailable_requires_null_tokens")

	if err := worker.QueryRow(ctx, `
		SELECT work.finish_operation_from_receipt(
			$1, $2, $3, 'unavailable', 'aliyun', 'qwen3.8-flash', current_date, NULL, NULL, NULL, NULL)`,
		run.org, run.opID, hash,
	).Scan(&body); err != nil {
		t.Fatal(err)
	}
	result := map[string]any{}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	if result["outcome"] != "confirmed" || result["settled"] != false ||
		result["usage"] != "unavailable_pending_reconciliation" {
		t.Fatalf("unavailable finish = %#v", result)
	}
	if got := scalarCount(t, admin, `
		SELECT count(*) FROM work.operation_usage_fact
		 WHERE org_id = $1 AND usage_source = 'unavailable'
		   AND input_tokens IS NULL AND output_tokens IS NULL AND cached_input_tokens IS NULL`,
		run.org); got != 1 {
		t.Fatalf("unavailable facts with NULL tokens = %d, want 1", got)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.usage_daily WHERE org_id = $1`, run.org); got != 0 {
		t.Fatalf("usage_daily rows for unavailable usage = %d, want 0", got)
	}
	if got := scalarString(t, admin,
		`SELECT state FROM work.quota_reservation WHERE org_id = $1`, run.org); got != "held" {
		t.Fatalf("reservation state = %q, want held", got)
	}
	if got := scalarString(t, admin,
		`SELECT state FROM work.operation WHERE id = $1`, run.opID); got != "succeeded" {
		t.Fatalf("operation state = %q", got)
	}

	// Downgrading a known usage back to unknown is refused.
	if err := worker.QueryRow(ctx, `
		SELECT work.finish_operation_from_receipt(
			$1, $2, $3, 'provider', 'aliyun', 'qwen3.8-flash', current_date, 120, 30, 0, 150)`,
		run.org, run.opID, hash,
	).Scan(&body); err != nil {
		t.Fatal(err)
	}
	result = map[string]any{}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	if result["outcome"] != "already_confirmed" || result["usage"] != "revised" ||
		result["settled"] != true {
		t.Fatalf("revised finish = %#v", result)
	}
	if got := scalarCount(t, admin,
		`SELECT input_tokens FROM work.usage_daily WHERE org_id = $1`, run.org); got != 120 {
		t.Fatalf("input tokens after revision = %d, want 120", got)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.operation_usage_fact WHERE org_id = $1`, run.org); got != 2 {
		t.Fatalf("usage facts after revision = %d, want 2", got)
	}
	err = worker.QueryRow(ctx, `
		SELECT work.finish_operation_from_receipt(
			$1, $2, $3, 'unavailable', 'aliyun', 'qwen3.8-flash', current_date, NULL, NULL, NULL, NULL)`,
		run.org, run.opID, hash,
	).Scan(&body)
	assertPgMessage(t, err, "usage_source_downgrade")
	if got := scalarString(t, admin,
		`SELECT state FROM work.operation WHERE id = $1`, run.opID); got != "succeeded" {
		t.Fatalf("operation state after downgrade attempt = %q", got)
	}
	// A different receipt cannot recount usage for the same operation.
	err = worker.QueryRow(ctx, `
		SELECT work.finish_operation_from_receipt(
			$1, $2, $3, 'provider', 'aliyun', 'qwen3.8-flash', current_date, 10, 10, 0, 20)`,
		run.org, run.opID, docHash(t, "7"),
	).Scan(&body)
	assertPgMessage(t, err, "receipt_hash_mismatch")
}

// Internal finishing must verify the gate's terminal receipt. A missing or
// unbound receipt cannot be finished, and only work_worker may call the
// commands; no role gets direct DML on the new tables.
func TestFinishRequiresBoundReceiptAndMinimalGrants(t *testing.T) {
	dbName, admin := newGateDB(t)
	worker := workerConn(t, dbName, "org_grants")
	run := seedRun(t, admin, "org_grants")
	commitFirstHead(t, worker, run)
	prepareExecuteFragment(t, worker, run)

	ctx := testContext(t)
	var body []byte
	hash := docHash(t, "3")
	err := worker.QueryRow(ctx, `
		SELECT work.finish_operation_from_receipt(
			$1, $2, $3, 'provider', 'aliyun', 'qwen3.8-flash', current_date, 10, 5, 0, 15)`,
		run.org, run.opID, hash,
	).Scan(&body)
	assertPgMessage(t, err, "dispatch_gate_not_found")
	if _, err := consume(ctx, worker, run, "gw-1", run.slot); err != nil {
		t.Fatal(err)
	}
	err = worker.QueryRow(ctx, `
		SELECT work.finish_operation_from_receipt(
			$1, $2, $3, 'provider', 'aliyun', 'qwen3.8-flash', current_date, 10, 5, 0, 15)`,
		run.org, run.opID, hash,
	).Scan(&body)
	assertPgMessage(t, err, "dispatch_receipt_not_bound")
	if _, err := attachReceipt(ctx, worker, run, run.slot, "receipt/1", hash, "rejected_not_executed"); err != nil {
		t.Fatal(err)
	}
	err = worker.QueryRow(ctx, `
		SELECT work.finish_operation_from_receipt(
			$1, $2, $3, 'provider', 'aliyun', 'qwen3.8-flash', current_date, 10, 5, 0, 15)`,
		run.org, run.opID, hash,
	).Scan(&body)
	assertPgMessage(t, err, "receipt_not_successful")

	api := connect(t, appURL(dbName))
	defer api.Close(context.Background())
	if _, err := api.Exec(ctx, fmt.Sprintf("SET app.org_id = %s", quoteLiteral(run.org))); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{
		`SELECT work.consume_dispatch_delivery($1, $2, gen_random_uuid(), 'h', gen_random_uuid(), repeat('c', 64), 1, 'gw', gen_random_uuid())`,
		`SELECT work.seal_dispatch_not_sent($1, $2, 'cancel_requested', NULL)`,
		`SELECT work.register_runtime_execution($1, gen_random_uuid(), $2, 'plan', 1, 'pi-1', now())`,
	} {
		var ignored []byte
		err := api.QueryRow(ctx, sql, run.org, run.opID).Scan(&ignored)
		if err == nil {
			t.Fatalf("work_api executed %q", sql)
		}
		assertPgMessage(t, err, "permission denied")
	}
	for _, sql := range []string{
		`INSERT INTO work.dispatch_delivery (org_id, operation_id, gate_state, sealed_at)
		 VALUES ($1, $2, 'sealed_not_sent', now())`,
		`UPDATE work.dispatch_delivery SET gate_state = 'sealed_not_sent'
		 WHERE org_id = $1 AND operation_id = $2`,
		`DELETE FROM work.dispatch_delivery WHERE org_id = $1 AND operation_id = $2`,
		`INSERT INTO work.operation_usage_fact (org_id, operation_id, usage_revision, origin)
		 VALUES ($1, $2, 1, 'legacy_marker_backfill')`,
		`UPDATE work.runtime_execution SET state = 'revoked' WHERE org_id = $1 AND run_id <> $2::uuid`,
		`UPDATE work.runtime_checkpoint_head SET checkpoint_revision = 99
		 WHERE org_id = $1 AND run_id <> $2::uuid`,
	} {
		_, err := worker.Exec(ctx, sql, run.org, run.opID)
		if err == nil {
			t.Fatalf("work_worker performed direct DML: %q", sql)
		}
		assertPgMessage(t, err, "permission denied")
	}
	if got := scalarString(t, admin,
		`SELECT gate_state FROM work.dispatch_delivery WHERE org_id = $1 AND operation_id = $2`,
		run.org, run.opID); got != "receipt_recorded" {
		t.Fatalf("gate state = %q", got)
	}
}
