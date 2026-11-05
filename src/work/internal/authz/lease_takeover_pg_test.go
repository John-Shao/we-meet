package authz_test

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/authz"
)

// These cases exercise increment 0028 against a real PostgreSQL instance: an
// elapsed lease held by a vanished parent may be taken over, and every other
// claim decision behaves exactly as it did before. The commands go through
// authz.PGCommands on the work_worker pool, so grants, the tenant context and
// the RAISE texts are part of the assertion rather than bypassed.
//
// Production shape being reproduced (pilot host, 2026-11-05, run 0fd4f0a8,
// execution f372c418): the worker died 3 seconds into AdvanceRuntime while the
// parent kept the fragment alive through the provider exchange; 4 minutes later
// Temporal started attempt 2, whose claim met state='active' plus a lease that
// had elapsed half a minute earlier and was refused. Nothing could claim that
// row again afterwards - register refuses to replace a fragment whose operation
// already has a delivery row, and a late heartbeat commits state='expired'.

const (
	takeoverOrg    = "org_takeover"
	takeoverSecond = "parent-workload:redrive"
)

// takeoverWrite runs a fixture write and insists it landed: a 0-row UPDATE here
// would turn a refusal case into a silent pass on the wrong branch.
func takeoverWrite(t *testing.T, admin *pgx.Conn, sql string, args ...any) {
	t.Helper()
	tag, err := admin.Exec(testContext(t), sql, args...)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("fixture write affected %d rows, want 1: %s", tag.RowsAffected(), sql)
	}
}

func takeoverElapsedLease(t *testing.T, admin *pgx.Conn, org, executionID string) {
	t.Helper()
	takeoverWrite(t, admin, `
		UPDATE work.runtime_execution
		SET lease_until = now() - interval '1 second',
		    revision = revision + 1, updated_at = now()
		WHERE org_id = $1 AND execution_id = $2`, org, executionID)
}

// takeoverExecuteWithDeadline is registerAuthzExecute with a short hard deadline.
// hard_deadline is a binding column - runtime_execution_guard refuses any change to
// it - so the only way to get a fragment whose deadline has passed is to set it
// before the first claim.
func takeoverExecuteWithDeadline(
	t *testing.T, worker *pgx.Conn, run *authzExecRun, deadline string,
) {
	t.Helper()
	ctx := testContext(t)
	commitAuthzPlanHead(t, worker, run)
	var reservation string
	if err := worker.QueryRow(ctx,
		`SELECT work.reserve_quota($1, 'default', to_char(now(), 'YYYY-MM'), $2, 1000)::text`,
		run.org, run.opID,
	).Scan(&reservation); err != nil {
		t.Fatal(err)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_dispatch($1, $2, 'consumer-1', 1)::text`, run.opID, run.org,
	).Scan(&run.attempt); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := worker.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'execute', 1, 'pi-1', now() + interval '`+deadline+`',
			$4, $5, $6, $7, $8, $9, $10)`,
		run.org, run.execExec, run.runID, run.headRef, run.headHash,
		"intent/"+run.opID, authzExecHash(t, "2"), run.requestHash, run.opID, run.attempt,
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
		t.Fatalf("first claim inside the deadline window: %v", err)
	}
	if state != "claimed" {
		t.Fatalf("first claim state = %q", state)
	}
}

func takeoverText(t *testing.T, admin *pgx.Conn, sql string, args ...any) string {
	t.Helper()
	var value string
	if err := admin.QueryRow(testContext(t), sql, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func takeoverInt(t *testing.T, admin *pgx.Conn, sql string, args ...any) int {
	t.Helper()
	var value int
	if err := admin.QueryRow(testContext(t), sql, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

// assertGuardRefusal reads the RAISE text straight off the trigger: these writes
// never pass through authz.PGCommands, so the domain code is all there is.
func assertGuardRefusal(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s, got nil", want)
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("error = %v, want *pgconn.PgError", err)
	}
	if pgErr.Message != want {
		t.Fatalf("message = %q, want %q", pgErr.Message, want)
	}
	if pgErr.Code != "23514" {
		t.Fatalf("sqlstate = %q, want 23514 for %s", pgErr.Code, want)
	}
}

// TestLeaseTakeoverHandsTheRedriveALiveLease is the recovery half: the second
// attempt gets a lease it can extend, the dead holder loses the right to renew,
// and the audit names the holder it displaced.
func TestLeaseTakeoverHandsTheRedriveALiveLease(t *testing.T) {
	dbName, admin, pool := newAuthzExecDB(t)
	worker := authzExecWorker(t, dbName, takeoverOrg)
	commands := &authz.PGCommands{Pool: pool}
	parent := authz.Caller{Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"}
	ctx := testContext(t)

	run := seedAuthzExecRun(t, admin, takeoverOrg, authzExecHash(t, "a"))
	prepareAuthzExecute(t, worker, run)
	// The first parent got as far as thirteen heartbeats before it disappeared.
	takeoverWrite(t, admin,
		`UPDATE work.runtime_execution SET heartbeat_seq = 13 WHERE execution_id = $1`, run.execExec)
	takeoverElapsedLease(t, admin, run.org, run.execExec)

	taken, err := commands.ClaimRuntimeExecution(ctx, parent,
		authz.ExecutionRequest{OrgID: run.org, ExecutionID: run.execExec}, takeoverSecond)
	if err != nil {
		t.Fatalf("takeover claim: %v", err)
	}
	if taken.State != "claimed" || taken.HolderID != takeoverSecond {
		t.Fatalf("takeover lease = %#v, want claimed by %s", taken, takeoverSecond)
	}

	if got := takeoverText(t, admin,
		`SELECT holder_id FROM work.runtime_execution WHERE execution_id = $1`, run.execExec); got != takeoverSecond {
		t.Fatalf("holder after takeover = %q", got)
	}
	// heartbeat_seq orders one holder's own heartbeats, so an inherited 13 would
	// make the new parent's renewals 1..13 no-ops and strand it on a 30s lease.
	if got := takeoverInt(t, admin,
		`SELECT heartbeat_seq FROM work.runtime_execution WHERE execution_id = $1`, run.execExec); got != 0 {
		t.Fatalf("heartbeat_seq after takeover = %d, want 0", got)
	}

	// The vanished holder can no longer extend anything.
	_, err = commands.RenewRuntimeExecution(ctx, parent, authz.ExecutionRequest{
		OrgID: run.org, ExecutionID: run.execExec, HolderID: run.holder, HeartbeatSeq: 14,
	})
	assertAuthzCode(t, err, "runtime_execution_holder_mismatch")

	// The new holder's first heartbeat does extend its lease, which is the whole
	// point of resetting the sequence above.
	before := takeoverText(t, admin,
		`SELECT lease_until::text FROM work.runtime_execution WHERE execution_id = $1`, run.execExec)
	renewed, err := commands.RenewRuntimeExecution(ctx, parent, authz.ExecutionRequest{
		OrgID: run.org, ExecutionID: run.execExec, HolderID: takeoverSecond, HeartbeatSeq: 1,
	})
	if err != nil {
		t.Fatalf("renew after takeover: %v", err)
	}
	if renewed.State != "active" || renewed.LeaseUntil == nil {
		t.Fatalf("renewed = %#v", renewed)
	}
	if after := takeoverText(t, admin,
		`SELECT lease_until::text FROM work.runtime_execution WHERE execution_id = $1`, run.execExec); after == before {
		t.Fatalf("first heartbeat after takeover did not extend the lease (%s)", after)
	}

	// The takeover is auditable and says which parent it displaced.
	if got := takeoverText(t, admin, `
		SELECT action FROM work.audit_event
		WHERE target_id = $1 ORDER BY created_at DESC LIMIT 1`, run.execExec); got != "runtime.execution_taken_over" {
		t.Fatalf("last audit action = %q", got)
	}
	if got := takeoverText(t, admin, `
		SELECT metadata->>'previous_holder_id' FROM work.audit_event
		WHERE target_id = $1 AND action = 'runtime.execution_taken_over'`, run.execExec); got != run.holder {
		t.Fatalf("previous_holder_id = %q, want %s", got, run.holder)
	}
	if got := takeoverText(t, admin, `
		SELECT (metadata->>'previous_lease_until' IS NOT NULL)::text FROM work.audit_event
		WHERE target_id = $1 AND action = 'runtime.execution_taken_over'`,
		run.execExec); got != "true" {
		t.Fatal("takeover audit did not record the elapsed lease it displaced")
	}
	// The original grant is untouched: exactly one execution_claimed row, so a
	// reader can still tell "one parent, then a takeover" from "two claims".
	if got := takeoverInt(t, admin, `
		SELECT count(*) FROM work.audit_event
		WHERE target_id = $1 AND action = 'runtime.execution_claimed'`, run.execExec); got != 1 {
		t.Fatalf("execution_claimed audit rows = %d, want 1", got)
	}
}

// TestLeaseTakeoverCannotBuyASecondSend pins the money invariant that makes a
// takeover safe at all: the gate, not the lease, decides who may call the
// provider, and a takeover never reopens it.
func TestLeaseTakeoverCannotBuyASecondSend(t *testing.T) {
	dbName, admin, pool := newAuthzExecDB(t)
	worker := authzExecWorker(t, dbName, takeoverOrg)
	commands := &authz.PGCommands{Pool: pool}
	parent := authz.Caller{Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"}
	egress := authz.Caller{Kind: authz.KindEgress, WorkloadID: "egress-workload"}
	ctx := testContext(t)

	run := seedAuthzExecRun(t, admin, takeoverOrg, authzExecHash(t, "b"))
	prepareAuthzExecute(t, worker, run)
	// The first parent reaches the gateway and wins the gate: one send authorized.
	first, err := commands.ConsumeByExecution(ctx, egress, authz.ExecutionConsumeRequest{
		OrgID: run.org, ExecutionID: run.execExec, RequestHash: run.requestHash,
	})
	if err != nil {
		t.Fatalf("first consume: %v", err)
	}
	if !first.Won {
		t.Fatalf("first consume did not win: %#v", first)
	}

	takeoverElapsedLease(t, admin, run.org, run.execExec)
	if _, err := commands.ClaimRuntimeExecution(ctx, parent,
		authz.ExecutionRequest{OrgID: run.org, ExecutionID: run.execExec}, takeoverSecond); err != nil {
		t.Fatalf("takeover claim: %v", err)
	}

	second, err := commands.ConsumeByExecution(ctx, egress, authz.ExecutionConsumeRequest{
		OrgID: run.org, ExecutionID: run.execExec, RequestHash: run.requestHash,
	})
	if err != nil {
		t.Fatalf("consume after takeover: %v", err)
	}
	if second.Won {
		t.Fatalf("takeover bought a second send authorization: %#v", second)
	}
	if second.GateState != "consumed" {
		t.Fatalf("observed gate state = %q, want consumed", second.GateState)
	}
	if got := takeoverInt(t, admin,
		`SELECT count(*) FROM work.dispatch_delivery WHERE operation_id = $1`, run.opID); got != 1 {
		t.Fatalf("dispatch_delivery rows = %d, want 1", got)
	}
	// The gate still names the holder that won it, not the one that took over.
	if got := takeoverText(t, admin,
		`SELECT holder_id FROM work.dispatch_delivery WHERE operation_id = $1`, run.opID); got != run.holder {
		t.Fatalf("gate holder_id = %q, want %s", got, run.holder)
	}
}

// TestLeaseTakeoverKeepsEveryOtherRefusal is the "nothing else moved" half. Each
// case is a decision 0028 must not change, asserted by its own RAISE text.
func TestLeaseTakeoverKeepsEveryOtherRefusal(t *testing.T) {
	dbName, admin, pool := newAuthzExecDB(t)
	worker := authzExecWorker(t, dbName, takeoverOrg)
	commands := &authz.PGCommands{Pool: pool}
	parent := authz.Caller{Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"}
	ctx := testContext(t)

	t.Run("live lease with a foreign holder is refused", func(t *testing.T) {
		run := seedAuthzExecRun(t, admin, takeoverOrg, authzExecHash(t, "c"))
		prepareAuthzExecute(t, worker, run)
		_, err := commands.ClaimRuntimeExecution(ctx, parent, authz.ExecutionRequest{
			OrgID: run.org, ExecutionID: run.execExec,
		}, takeoverSecond)
		assertAuthzCode(t, err, "runtime_execution_holder_mismatch")
	})

	t.Run("the row guard still refuses a holder move that is not a takeover", func(t *testing.T) {
		run := seedAuthzExecRun(t, admin, takeoverOrg, authzExecHash(t, "i"))
		prepareAuthzExecute(t, worker, run)
		// Live lease: the holder may not move, by any route, exactly as before 0028.
		_, err := admin.Exec(ctx, `
			UPDATE work.runtime_execution SET holder_id = $3
			WHERE org_id = $1 AND execution_id = $2`, run.org, run.execExec, takeoverSecond)
		assertGuardRefusal(t, err, "runtime_execution_holder_immutable")

		// A heartbeat sequence going backwards with no holder move stays refused:
		// the reset is tied to displacement, not handed out as a general licence.
		takeoverWrite(t, admin,
			`UPDATE work.runtime_execution SET heartbeat_seq = 4 WHERE execution_id = $1`,
			run.execExec)
		_, err = admin.Exec(ctx,
			`UPDATE work.runtime_execution SET heartbeat_seq = 1 WHERE execution_id = $1`,
			run.execExec)
		assertGuardRefusal(t, err, "runtime_execution_heartbeat_not_monotonic")
	})

	t.Run("elapsed lease replayed by the same holder is still expiry", func(t *testing.T) {
		run := seedAuthzExecRun(t, admin, takeoverOrg, authzExecHash(t, "d"))
		prepareAuthzExecute(t, worker, run)
		takeoverElapsedLease(t, admin, run.org, run.execExec)
		_, err := commands.ClaimRuntimeExecution(ctx, parent, authz.ExecutionRequest{
			OrgID: run.org, ExecutionID: run.execExec,
		}, run.holder)
		assertAuthzCode(t, err, "runtime_execution_expired")
	})

	t.Run("a passed hard deadline is never takeover-able", func(t *testing.T) {
		run := seedAuthzExecRun(t, admin, takeoverOrg, authzExecHash(t, "e"))
		takeoverExecuteWithDeadline(t, worker, run, "3 seconds")
		// Both the lease and the deadline are now behind the clock: the lease may
		// say "take me over", the deadline says "this fragment is dead".
		time.Sleep(4 * time.Second)
		_, err := commands.ClaimRuntimeExecution(ctx, parent, authz.ExecutionRequest{
			OrgID: run.org, ExecutionID: run.execExec,
		}, takeoverSecond)
		assertAuthzCode(t, err, "runtime_execution_expired")
	})

	t.Run("terminal fragment states are still not claimable", func(t *testing.T) {
		for _, state := range []string{"revoked", "completed", "expired"} {
			run := seedAuthzExecRun(t, admin, takeoverOrg, authzExecHash(t, "f"))
			prepareAuthzExecute(t, worker, run)
			takeoverWrite(t, admin, `
				UPDATE work.runtime_execution
				SET state = $3, lease_until = NULL, revision = revision + 1, updated_at = now()
				WHERE org_id = $1 AND execution_id = $2`, run.org, run.execExec, state)
			_, err := commands.ClaimRuntimeExecution(ctx, parent, authz.ExecutionRequest{
				OrgID: run.org, ExecutionID: run.execExec,
			}, takeoverSecond)
			assertAuthzCode(t, err, "runtime_execution_not_claimable")
		}
	})

	t.Run("a run that is no longer current cannot be revived", func(t *testing.T) {
		run := seedAuthzExecRun(t, admin, takeoverOrg, authzExecHash(t, "g"))
		prepareAuthzExecute(t, worker, run)
		takeoverElapsedLease(t, admin, run.org, run.execExec)
		takeoverWrite(t, admin,
			`UPDATE work.run SET state = 'cancel_requested' WHERE id = $1`, run.runID)
		_, err := commands.ClaimRuntimeExecution(ctx, parent, authz.ExecutionRequest{
			OrgID: run.org, ExecutionID: run.execExec,
		}, takeoverSecond)
		assertAuthzCode(t, err, "run_not_current")
	})
}

// TestPlanFragmentLeaseIsTakeoverToo records the mode-generality of the rule: the
// plan fragment is claimed by the control plane with a stable holder, so a replay
// is already_claimed, and a vanished plan parent is displaced the same way. There
// is no provider call on that path, and the head commit still settles the race.
func TestPlanFragmentLeaseIsTakeoverToo(t *testing.T) {
	dbName, admin, pool := newAuthzExecDB(t)
	worker := authzExecWorker(t, dbName, takeoverOrg)
	commands := &authz.PGCommands{Pool: pool}
	parent := authz.Caller{Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"}
	ctx := testContext(t)

	run := seedAuthzExecRun(t, admin, takeoverOrg, authzExecHash(t, "h"))
	prepareAuthzPlanOnly(t, worker, run)
	planHolder := run.holder + "-plan"

	replay, err := commands.ClaimRuntimeExecution(ctx, parent,
		authz.ExecutionRequest{OrgID: run.org, ExecutionID: run.planExec}, planHolder)
	if err != nil || replay.State != "already_claimed" {
		t.Fatalf("same-holder plan replay = %#v, %v", replay, err)
	}

	takeoverElapsedLease(t, admin, run.org, run.planExec)
	taken, err := commands.ClaimRuntimeExecution(ctx, parent,
		authz.ExecutionRequest{OrgID: run.org, ExecutionID: run.planExec}, takeoverSecond)
	if err != nil {
		t.Fatalf("plan takeover: %v", err)
	}
	if taken.State != "claimed" {
		t.Fatalf("plan takeover state = %q", taken.State)
	}
}
