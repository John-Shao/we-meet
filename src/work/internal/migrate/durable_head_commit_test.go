package migrate

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// gateExecuteWithDeadline registers and claims an execute fragment whose hard deadline is
// the caller's interval. The deadline cannot be moved afterwards (runtime_execution_guard
// treats hard_deadline as binding), so a short window is the only way to reach a row the
// clock has passed - the same method internal/authz uses for its takeover cases.
func gateExecuteWithDeadline(t *testing.T, worker *pgx.Conn, run *gateRun, deadline string) {
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
		`SELECT work.claim_dispatch($1, $2, 'consumer-1', 1)::text`, run.opID, run.org,
	).Scan(&run.attempt); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := worker.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'execute', 1, 'pi-1', now() + interval '`+deadline+`',
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
		`SELECT work.claim_runtime_execution($1, $2, $3)`, run.org, run.execExec, run.holder,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "claimed" {
		t.Fatalf("execute claim state = %q", state)
	}
}

func commitPastDeadline(t *testing.T, worker *pgx.Conn, run *gateRun) (int64, error) {
	t.Helper()
	var revision int64
	err := worker.QueryRow(testContext(t),
		`SELECT work.commit_runtime_checkpoint($1, $2, $3, 0, $4, $5, $6, $7, 'pi-1')`,
		run.org, run.runID, run.execExec, run.headRef, run.headHash,
		"cp/after/"+run.org, docHash(t, "9"),
	).Scan(&revision)
	return revision, err
}

// RH-01/RH-02/RH-03: increment 0030's exception is one arm wide. Past the hard deadline the
// commit is refused unless a success receipt is already recorded against this exact
// execution, operation and attempt. The two refusals are what keep #82 = F1 from reading as
// "the deadline no longer matters": removing the receipt predicate, or widening it to any
// gate row, turns one of these two red.
func TestDurableReceiptIsTheOnlyWayToCommitPastDeadline(t *testing.T) {
	ctx := context.Background()

	// RH-01 - elapsed deadline, no gate row at all.
	t.Run("no gate row", func(t *testing.T) {
		dbName, admin := newGateDB(t)
		worker := workerConn(t, dbName, "org_dh_none")
		run := seedRun(t, admin, "org_dh_none")
		commitFirstHead(t, worker, run)
		gateExecuteWithDeadline(t, worker, run, "1 second")
		time.Sleep(2 * time.Second)
		if _, err := commitPastDeadline(t, worker, run); err == nil {
			t.Fatal("commit past the deadline without any gate row succeeded; 0030 stopped refusing")
		} else {
			assertPgMessage(t, err, "runtime_execution_expired")
		}
	})

	// RH-02 - elapsed deadline, gate consumed but no receipt recorded: the send happened, the
	// answer never arrived, so there is nothing paid for to commit.
	t.Run("consumed without receipt", func(t *testing.T) {
		dbName, admin := newGateDB(t)
		worker := workerConn(t, dbName, "org_dh_consumed")
		run := seedRun(t, admin, "org_dh_consumed")
		commitFirstHead(t, worker, run)
		gateExecuteWithDeadline(t, worker, run, "3 seconds")
		// receipt_slot_id is a uuid column, so the slot is an identifier, not a path.
		slot := newUUID(t)
		decision, err := consume(ctx, worker, run, "gateway-invocation-1", slot)
		if err != nil {
			t.Fatal(err)
		}
		if decision["outcome"] != "won" {
			t.Fatalf("consume decision = %#v, want won", decision)
		}
		time.Sleep(4 * time.Second)
		if _, err := commitPastDeadline(t, worker, run); err == nil {
			t.Fatal("commit past the deadline with only a consumed gate succeeded; receipt_recorded is not required")
		} else {
			assertPgMessage(t, err, "runtime_execution_expired")
		}
	})

	// RH-03 - elapsed deadline with the receipt recorded and bound: the step is already paid
	// for, so the successor commits, and it does so without touching the lease or the holder.
	t.Run("recorded success receipt", func(t *testing.T) {
		dbName, admin := newGateDB(t)
		worker := workerConn(t, dbName, "org_dh_recorded")
		run := seedRun(t, admin, "org_dh_recorded")
		commitFirstHead(t, worker, run)
		gateExecuteWithDeadline(t, worker, run, "3 seconds")
		slot := newUUID(t)
		if _, err := consume(ctx, worker, run, "gateway-invocation-1", slot); err != nil {
			t.Fatal(err)
		}
		hash := docHash(t, "4")
		attached, err := attachReceipt(ctx, worker, run, slot, "receipt/1", hash, "success")
		if err != nil {
			t.Fatal(err)
		}
		if attached["gate_state"] != "receipt_recorded" {
			t.Fatalf("attach decision = %#v, want gate_state receipt_recorded", attached)
		}
		time.Sleep(4 * time.Second)
		revision, err := commitPastDeadline(t, worker, run)
		if err != nil {
			t.Fatalf("commit past the deadline with a bound success receipt: %v", err)
		}
		if revision != 1 {
			t.Fatalf("revision = %d, want 1", revision)
		}
		// The arm must announce itself, and it must not have taken the lease over.
		if got := scalarString(t, admin, `
			SELECT metadata->>'durable_receipt_after_deadline' FROM work.audit_event
			WHERE org_id = $1 AND action = 'runtime.checkpoint_committed' AND target_id = $2
			  AND metadata->>'checkpoint_revision' = '1'`, run.org, run.runID); got != "true" {
			t.Fatalf("durable_receipt_after_deadline = %q, want true", got)
		}
		if got := scalarString(t, admin, `
			SELECT holder_id FROM work.runtime_execution
			WHERE org_id = $1 AND execution_id = $2`, run.org, run.execExec); got != run.holder {
			t.Fatalf("holder after the past-deadline commit = %q, want the original %q", got, run.holder)
		}
		if got := scalarString(t, admin, `
			SELECT state FROM work.runtime_execution
			WHERE org_id = $1 AND execution_id = $2`, run.org, run.execExec); got != "completed" {
			t.Fatalf("execution state after commit = %q, want completed", got)
		}
	})
}
