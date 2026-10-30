package authz_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/authz"
	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/testpg"
)

const (
	pgOrg     = "org_authz"
	pgInput   = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
	pgTask    = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb"
	pgSnap    = "cccccccc-1111-4111-8111-cccccccccccc"
	pgRun     = "dddddddd-1111-4111-8111-dddddddddddd"
	pgExec    = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee"
	pgAbsent  = "ffffffff-1111-4111-8111-ffffffffffff"
	pgRuntime = "work-runtime-1.4.0"
)

func TestPGCommandsClaimAndRenew(t *testing.T) {
	pool, _ := newAuthzDB(t)
	ctx := testContext(t)
	commands := &authz.PGCommands{Pool: pool}
	caller := authz.Caller{Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"}

	lease, err := commands.ClaimRuntimeExecution(ctx, caller,
		authz.ExecutionRequest{OrgID: pgOrg, ExecutionID: pgExec}, "parent-workload:first")
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if lease.State != "claimed" || lease.HolderID != "parent-workload:first" {
		t.Fatalf("lease = %#v", lease)
	}

	replay, err := commands.ClaimRuntimeExecution(ctx, caller,
		authz.ExecutionRequest{OrgID: pgOrg, ExecutionID: pgExec}, "parent-workload:first")
	if err != nil || replay.State != "already_claimed" {
		t.Fatalf("same-holder replay = %#v, %v", replay, err)
	}

	_, err = commands.ClaimRuntimeExecution(ctx, caller,
		authz.ExecutionRequest{OrgID: pgOrg, ExecutionID: pgExec}, "parent-workload:second")
	assertAuthzCode(t, err, "runtime_execution_holder_mismatch")

	renewed, err := commands.RenewRuntimeExecution(ctx, caller,
		authz.ExecutionRequest{OrgID: pgOrg, ExecutionID: pgExec, HolderID: "parent-workload:first", HeartbeatSeq: 1})
	if err != nil {
		t.Fatalf("renew: %v", err)
	}
	if renewed.State != "active" || renewed.LeaseUntil == nil {
		t.Fatalf("renewed = %#v", renewed)
	}

	_, err = commands.RenewRuntimeExecution(ctx, caller,
		authz.ExecutionRequest{OrgID: pgOrg, ExecutionID: pgExec, HolderID: "parent-workload:second", HeartbeatSeq: 2})
	assertAuthzCode(t, err, "runtime_execution_holder_mismatch")

	// A wrong argument order or type would surface as a PostgreSQL error and
	// map to command_failed; the domain code proves the call reached the command.
	_, err = commands.ClaimRuntimeExecution(ctx, caller,
		authz.ExecutionRequest{OrgID: pgOrg, ExecutionID: pgAbsent}, "parent-workload:first")
	assertAuthzCode(t, err, "runtime_execution_not_found")
}

func TestPGCommandsConsumeAndAttachReachDomainChecks(t *testing.T) {
	pool, store := newAuthzDB(t)
	ctx := testContext(t)
	commands := &authz.PGCommands{Pool: pool}
	egress := authz.Caller{Kind: authz.KindEgress, WorkloadID: "egress-workload"}

	ref, err := store.Put(ctx, pgOrg, []byte(`{"receipt":"placeholder"}`))
	if err != nil {
		t.Fatal(err)
	}

	_, err = commands.ConsumeDispatchDelivery(ctx, egress, authz.DeliveryRequest{
		OrgID: pgOrg, OperationID: pgAbsent, AttemptID: pgAbsent,
		ExecutionID: pgExec, RequestHash: "sha256:" + strings.Repeat("a", 64),
		RunFence: 1, HolderID: "parent-workload:first",
	})
	assertAuthzCode(t, err, "operation_not_found")

	err = commands.AttachDispatchReceipt(ctx, egress, authz.ReceiptRequest{
		OrgID: pgOrg, OperationID: pgAbsent, ExecutionID: pgExec, AttemptID: pgAbsent,
		ReceiptSlotID: uuid.NewString(), ReceiptRef: ref.ContentRef,
		ReceiptHash: ref.Hash, ReceiptResult: authz.ReceiptSucceeded,
	})
	assertAuthzCode(t, err, "operation_not_found")

	err = commands.AttachDispatchReceipt(ctx, egress, authz.ReceiptRequest{
		OrgID: pgOrg, OperationID: pgAbsent, ExecutionID: pgExec, AttemptID: pgAbsent,
		ReceiptSlotID: uuid.NewString(), ReceiptRef: ref.ContentRef,
		ReceiptHash: ref.Hash, ReceiptResult: "unknown",
	})
	assertAuthzCode(t, err, "invalid_request:receipt_result")
}

func assertAuthzCode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s, got nil", want)
	}
	var authzError *authz.Error
	if !errors.As(err, &authzError) {
		t.Fatalf("error = %v, want authz.Error", err)
	}
	if authzError.Code != want {
		t.Fatalf("code = %q, want %q", authzError.Code, want)
	}
}

func newAuthzDB(t *testing.T) (*pgxpool.Pool, content.Store) {
	t.Helper()
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx := testContext(t)
	store, err := content.NewLocal(bytes.Repeat([]byte{7}, 32), t.TempDir(), 1)
	if err != nil {
		t.Fatal(err)
	}
	root, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, root, "work_authz_test")
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

	input, err := store.Put(ctx, pgOrg, []byte(`{"goal":"authorization boundary"}`))
	if err != nil {
		t.Fatal(err)
	}
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`SELECT set_config('app.org_id', $1, false)`, []any{pgOrg}},
		{`INSERT INTO work.org (id, status, home_region, name) VALUES ($1, 'active', 'cn-north', 'Authz')`, []any{pgOrg}},
		{`INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		  VALUES ($1, $2, 'sub_authz', $3, $4, $5)`,
			[]any{pgInput, pgOrg, input.ContentRef, input.Hash, input.Bytes}},
		{`INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode, title, input_id, revision)
		  VALUES ($1, $2, 'sub_authz', 'open', 'ask_each', 'authz', $3, 0)`,
			[]any{pgTask, pgOrg, pgInput}},
		{`UPDATE work.input_object SET task_id = $1 WHERE id = $2`, []any{pgTask, pgInput}}, {`INSERT INTO work.capability_snapshot
		    (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		  VALUES ($1, $2, $3, 'test', 'sha256:test', ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb,
		    '{"template":{"id":"summary","version":1}}'::jsonb)`,
			[]any{pgSnap, pgOrg, pgTask}},
		{`INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		  VALUES ($1, $2, $3, 1, 'queued', $4, $5, $6)`,
			[]any{pgRun, pgOrg, pgTask, pgSnap, "run:" + pgRun, pgRuntime}},
		{`UPDATE work.task SET active_run_id = $1, latest_run_id = $1 WHERE id = $2`,
			[]any{pgRun, pgTask}},
	} {
		if _, err := admin.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("%s: %v", statement.sql, err)
		}
	}

	pool, err := workdb.OpenPool(ctx, testpg.WorkerURL(dbName), "work-authz-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	if err := workdb.WithWorkerOrgContext(ctx, pool, pgOrg, func(tx pgx.Tx) error {
		var state string
		var fence int64
		if err := tx.QueryRow(ctx, `SELECT state, fence FROM work.acquire_run($1, $2)`,
			pgRun, pgOrg).Scan(&state, &fence); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`SELECT work.register_runtime_execution($1, $2, $3, 'plan', $4, $5, now() + interval '10 minutes')`,
			pgOrg, pgExec, pgRun, fence, pgRuntime)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return pool, store
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}
