package authz_test

import (
	"context"
	"crypto/rand"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/authz"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/testpg"
)

// These tests exercise increment 0013's execution-derived gate consume against
// a real PostgreSQL instance. Every command runs through the work_worker login,
// so grants, the tenant context and the SQL validation are part of the
// assertion rather than bypassed by a superuser.

type authzExecRun struct {
	org         string
	subject     string
	taskID      string
	runID       string
	opID        string
	planExec    string
	execExec    string
	holder      string
	attempt     string
	requestHash string
	headRef     string
	headHash    string
}

func authzExecUUID(t *testing.T) string {
	t.Helper()
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		t.Fatal(err)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

func authzExecHash(t *testing.T, seed string) string {
	t.Helper()
	return "sha256:" + strings.Repeat(seed, 64)[:64]
}

func authzExecQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func newAuthzExecDB(t *testing.T) (string, *pgx.Conn, *pgxpool.Pool) {
	t.Helper()
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx := testContext(t)
	root, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, root, "work_authz_exec_test")
	_ = root.Close(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		admin, err := testpg.Open(cleanupCtx, testpg.AdminURL())
		if err == nil {
			_ = testpg.DropDatabase(cleanupCtx, admin, dbName)
			_ = admin.Close(cleanupCtx)
		}
	})

	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	pool, err := workdb.OpenPool(ctx, testpg.WorkerURL(dbName), "work-authz-exec-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return dbName, admin, pool
}

func authzExecWorker(t *testing.T, dbName, org string) *pgx.Conn {
	t.Helper()
	conn, err := testpg.Open(testContext(t), testpg.WorkerURL(dbName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	if _, err := conn.Exec(testContext(t), "SET app.org_id = "+authzExecQuote(org)); err != nil {
		t.Fatal(err)
	}
	return conn
}

// seedAuthzExecRun inserts one active Run with one model Operation in
// authorized state. The plan head still has to be committed before an execute
// fragment may bind to it.
func seedAuthzExecRun(t *testing.T, admin *pgx.Conn, org, requestHash string) *authzExecRun {
	t.Helper()
	run := &authzExecRun{
		org:         org,
		subject:     "sub_" + org,
		taskID:      authzExecUUID(t),
		runID:       authzExecUUID(t),
		opID:        authzExecUUID(t),
		planExec:    authzExecUUID(t),
		execExec:    authzExecUUID(t),
		holder:      "holder-" + authzExecUUID(t),
		requestHash: requestHash,
		headRef:     "cp/0/" + org + "/" + authzExecUUID(t),
		headHash:    authzExecHash(t, "1"),
	}
	inputID := authzExecUUID(t)
	snapshotID := authzExecUUID(t)
	inputHash := strings.ReplaceAll(authzExecUUID(t), "-", "") +
		strings.ReplaceAll(authzExecUUID(t), "-", "")
	sql := fmt.Sprintf(`
		SET app.org_id = %[1]s;
		INSERT INTO work.org (id, status, home_region)
		VALUES (%[1]s, 'active', 'cn-north')
		ON CONFLICT (id) DO NOTHING;
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES (%[1]s, %[2]s, 'active', 'owner', true)
		ON CONFLICT (org_id, subject_id) DO NOTHING;
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%[3]s', %[1]s, %[2]s, 'input/%[3]s', '%[9]s', 12);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, input_id, title)
		VALUES ('%[4]s', %[1]s, %[2]s, 'open', '%[3]s', 'authz execution consume');
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		VALUES ('%[5]s', %[1]s, '%[4]s', 'v1', repeat('b', 64),
		        ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		UPDATE work.task SET snapshot_id = '%[5]s' WHERE id = '%[4]s';
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('%[6]s', %[1]s, '%[4]s', 1, 'active', '%[5]s', 'run:%[6]s', 'pi-1');
		UPDATE work.task SET active_run_id = '%[6]s', latest_run_id = '%[6]s'
		WHERE id = '%[4]s';
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state)
		VALUES ('%[7]s', %[1]s, '%[6]s', 'model:1', 'model', %[8]s, 'authorized');
	`, authzExecQuote(run.org), authzExecQuote(run.subject), inputID, run.taskID,
		snapshotID, run.runID, run.opID, authzExecQuote(requestHash), inputHash)
	if err := testpg.ExecRaw(testContext(t), admin, sql); err != nil {
		t.Fatal(err)
	}
	return run
}

func commitAuthzPlanHead(t *testing.T, worker *pgx.Conn, run *authzExecRun) {
	t.Helper()
	ctx := testContext(t)
	var state string
	if err := worker.QueryRow(ctx,
		`SELECT work.register_runtime_execution($1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes')`,
		run.org, run.planExec, run.runID,
	).Scan(&state); err != nil {
		t.Fatal(err)
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

func registerAuthzExecute(t *testing.T, worker *pgx.Conn, run *authzExecRun) {
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
			$4, $5, $6, $7, $8, $9, $10)`,
		run.org, run.execExec, run.runID, run.headRef, run.headHash,
		"intent/"+run.opID, authzExecHash(t, "2"), run.requestHash, run.opID, run.attempt,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "registered" {
		t.Fatalf("execute register state = %q", state)
	}
}

func claimAuthzExecute(t *testing.T, worker *pgx.Conn, run *authzExecRun) {
	t.Helper()
	var state string
	if err := worker.QueryRow(testContext(t),
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		run.org, run.execExec, run.holder,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "claimed" {
		t.Fatalf("execute claim state = %q", state)
	}
}

func prepareAuthzExecute(t *testing.T, worker *pgx.Conn, run *authzExecRun) {
	t.Helper()
	commitAuthzPlanHead(t, worker, run)
	registerAuthzExecute(t, worker, run)
	claimAuthzExecute(t, worker, run)
}

func prepareAuthzPlanOnly(t *testing.T, worker *pgx.Conn, run *authzExecRun) {
	t.Helper()
	ctx := testContext(t)
	var state string
	if err := worker.QueryRow(ctx,
		`SELECT work.register_runtime_execution($1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes')`,
		run.org, run.planExec, run.runID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		run.org, run.planExec, run.holder+"-plan",
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
}

func authzExecCount(t *testing.T, admin *pgx.Conn, sql string, args ...any) int {
	t.Helper()
	var value int
	if err := admin.QueryRow(testContext(t), sql, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestConsumeByExecutionHasExactlyOneWinner(t *testing.T) {
	dbName, admin, pool := newAuthzExecDB(t)
	worker := authzExecWorker(t, dbName, "org_exec_race")
	run := seedAuthzExecRun(t, admin, "org_exec_race", authzExecHash(t, "c"))
	prepareAuthzExecute(t, worker, run)

	commands := &authz.PGCommands{Pool: pool}
	egress := authz.Caller{Kind: authz.KindEgress, WorkloadID: "egress-workload"}
	request := authz.ExecutionConsumeRequest{
		OrgID: run.org, ExecutionID: run.execExec, RequestHash: run.requestHash,
	}

	results := make([]authz.ConsumeDecision, 2)
	errs := make([]error, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	ctx := testContext(t)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			results[index], errs[index] = commands.ConsumeByExecution(ctx, egress, request)
		}(i)
	}
	close(start)
	wg.Wait()

	won := 0
	observed := 0
	for i, decision := range results {
		if errs[i] != nil {
			t.Fatalf("consume %d: %v", i, errs[i])
		}
		if decision.Won {
			won++
			if !strings.HasPrefix(decision.GatewayInvocation, "egress-workload:") ||
				decision.ReceiptSlotID == "" {
				t.Fatalf("winner decision = %#v", decision)
			}
			if results[1-i].Won || results[1-i].ReceiptSlotID != decision.ReceiptSlotID {
				t.Fatalf("loser did not observe the winner's slot: %#v / %#v", decision, results[1-i])
			}
		} else {
			observed++
			if decision.GateState != "consumed" {
				t.Fatalf("observed decision = %#v", decision)
			}
		}
	}
	if won != 1 || observed != 1 {
		t.Fatalf("won = %d, observed = %d, results = %#v", won, observed, results)
	}
	if got := authzExecCount(t, admin,
		`SELECT count(*) FROM work.dispatch_delivery WHERE org_id = $1 AND operation_id = $2`,
		run.org, run.opID); got != 1 {
		t.Fatalf("gate rows = %d, want 1", got)
	}
	if got := authzExecCount(t, admin,
		`SELECT count(*) FROM work.audit_event WHERE org_id = $1 AND action = 'dispatch.gate_consumed'`,
		run.org); got != 1 {
		t.Fatalf("gate audit rows = %d, want 1", got)
	}
}

func TestConsumeByExecutionRefusals(t *testing.T) {
	dbName, admin, pool := newAuthzExecDB(t)
	worker := authzExecWorker(t, dbName, "org_exec_refuse")
	commands := &authz.PGCommands{Pool: pool}
	egress := authz.Caller{Kind: authz.KindEgress, WorkloadID: "egress-workload"}

	// A different hash than the frozen execution intent never reaches the gate.
	mismatch := seedAuthzExecRun(t, admin, "org_exec_refuse", authzExecHash(t, "c"))
	prepareAuthzExecute(t, worker, mismatch)
	_, err := commands.ConsumeByExecution(testContext(t), egress, authz.ExecutionConsumeRequest{
		OrgID: mismatch.org, ExecutionID: mismatch.execExec, RequestHash: authzExecHash(t, "d"),
	})
	assertAuthzCode(t, err, "runtime_request_hash_mismatch")

	// Registered but never claimed.
	registered := seedAuthzExecRun(t, admin, "org_exec_refuse", authzExecHash(t, "c"))
	commitAuthzPlanHead(t, worker, registered)
	registerAuthzExecute(t, worker, registered)
	_, err = commands.ConsumeByExecution(testContext(t), egress, authz.ExecutionConsumeRequest{
		OrgID: registered.org, ExecutionID: registered.execExec, RequestHash: registered.requestHash,
	})
	assertAuthzCode(t, err, "runtime_execution_not_active")

	// Revoked after a successful claim.
	revoked := seedAuthzExecRun(t, admin, "org_exec_refuse", authzExecHash(t, "c"))
	prepareAuthzExecute(t, worker, revoked)
	if _, err := admin.Exec(testContext(t), `
		UPDATE work.runtime_execution
		SET state = 'revoked', lease_until = NULL, terminal_reason = 'test_revoke',
		    revision = revision + 1, updated_at = now()
		WHERE org_id = $1 AND execution_id = $2`, revoked.org, revoked.execExec); err != nil {
		t.Fatal(err)
	}
	_, err = commands.ConsumeByExecution(testContext(t), egress, authz.ExecutionConsumeRequest{
		OrgID: revoked.org, ExecutionID: revoked.execExec, RequestHash: revoked.requestHash,
	})
	assertAuthzCode(t, err, "runtime_execution_not_active")

	// Active but with an elapsed lease.
	expired := seedAuthzExecRun(t, admin, "org_exec_refuse", authzExecHash(t, "c"))
	prepareAuthzExecute(t, worker, expired)
	if _, err := admin.Exec(testContext(t), `
		UPDATE work.runtime_execution
		SET lease_until = now() - interval '1 second',
		    revision = revision + 1, updated_at = now()
		WHERE org_id = $1 AND execution_id = $2`, expired.org, expired.execExec); err != nil {
		t.Fatal(err)
	}
	_, err = commands.ConsumeByExecution(testContext(t), egress, authz.ExecutionConsumeRequest{
		OrgID: expired.org, ExecutionID: expired.execExec, RequestHash: expired.requestHash,
	})
	assertAuthzCode(t, err, "runtime_execution_expired")

	// Plan fragments never carry dispatch authority.
	plan := seedAuthzExecRun(t, admin, "org_exec_refuse", authzExecHash(t, "c"))
	prepareAuthzPlanOnly(t, worker, plan)
	_, err = commands.ConsumeByExecution(testContext(t), egress, authz.ExecutionConsumeRequest{
		OrgID: plan.org, ExecutionID: plan.planExec, RequestHash: plan.requestHash,
	})
	assertAuthzCode(t, err, "runtime_execution_intent_mismatch")

	if got := authzExecCount(t, admin,
		`SELECT count(*) FROM work.dispatch_delivery WHERE org_id = $1`,
		"org_exec_refuse"); got != 0 {
		t.Fatalf("refusals created gate rows = %d", got)
	}
}

func TestConsumeDispatchDeliveryStillWinsAndExecutionConsumeObserves(t *testing.T) {
	dbName, admin, pool := newAuthzExecDB(t)
	worker := authzExecWorker(t, dbName, "org_exec_legacy")
	run := seedAuthzExecRun(t, admin, "org_exec_legacy", authzExecHash(t, "c"))
	prepareAuthzExecute(t, worker, run)

	commands := &authz.PGCommands{Pool: pool}
	egress := authz.Caller{Kind: authz.KindEgress, WorkloadID: "egress-workload"}
	first, err := commands.ConsumeDispatchDelivery(testContext(t), egress, authz.DeliveryRequest{
		OrgID: run.org, OperationID: run.opID, AttemptID: run.attempt,
		ExecutionID: run.execExec, RequestHash: run.requestHash,
		RunFence: 1, HolderID: run.holder,
	})
	if err != nil {
		t.Fatalf("legacy consume: %v", err)
	}
	if !first.Won || first.GateState != "consumed" || first.ReceiptSlotID == "" {
		t.Fatalf("legacy decision = %#v", first)
	}

	second, err := commands.ConsumeByExecution(testContext(t), egress, authz.ExecutionConsumeRequest{
		OrgID: run.org, ExecutionID: run.execExec, RequestHash: run.requestHash,
	})
	if err != nil {
		t.Fatalf("execution consume after legacy win: %v", err)
	}
	if second.Won || second.GateState != "consumed" || second.ReceiptSlotID != first.ReceiptSlotID {
		t.Fatalf("execution decision = %#v, legacy = %#v", second, first)
	}
	if got := authzExecCount(t, admin,
		`SELECT count(*) FROM work.dispatch_delivery WHERE org_id = $1 AND operation_id = $2`,
		run.org, run.opID); got != 1 {
		t.Fatalf("gate rows = %d, want 1", got)
	}
}
