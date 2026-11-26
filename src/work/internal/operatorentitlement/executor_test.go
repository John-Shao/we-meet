package operatorentitlement_test

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/operatorentitlement"
	"github.com/we-meet/work/internal/testpg"
)

type fakeHost struct {
	apply func(context.Context, host.ExecutionEntitlementCommand, string) (host.ExecutionEntitlementReceipt, error)
	get   func(context.Context, string, string) (host.ExecutionEntitlementReceipt, error)
}

func (f fakeHost) ApplyExecutionEntitlement(ctx context.Context, command host.ExecutionEntitlementCommand, correlationID string) (host.ExecutionEntitlementReceipt, error) {
	return f.apply(ctx, command, correlationID)
}

func (f fakeHost) GetExecutionEntitlementCommand(ctx context.Context, commandID, correlationID string) (host.ExecutionEntitlementReceipt, error) {
	return f.get(ctx, commandID, correlationID)
}

func receipt(command host.ExecutionEntitlementCommand, status string) host.ExecutionEntitlementReceipt {
	return host.ExecutionEntitlementReceipt{
		CommandID: command.CommandID, OrgID: command.OrgID, Status: status,
		PayloadHash: "sha256:" + strings.Repeat("a", 64), Enabled: command.Enabled,
		SeatLimit: command.SeatLimit, OperatorSuspended: command.OperatorSuspended,
		Revision: command.TargetEntitlementRevision,
	}
}

func setup(t *testing.T) (context.Context, *pgxpool.Pool, *pgxpool.Pool, string) {
	t.Helper()
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is required")
	}
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(ctx) })
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "operator_entitlement")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = testpg.DropDatabase(ctx, admin, dbName) })
	dbAdmin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbAdmin.Close(ctx) })
	orgID := "44444444-0000-0000-0000-000000000001"
	if _, err := dbAdmin.Exec(ctx,
		`INSERT INTO work.org (id,status,home_region) VALUES ($1,'active','cn-north')`, orgID); err != nil {
		t.Fatal(err)
	}
	pool, err := workdb.OpenPool(ctx, testpg.OperatorURL(dbName), "operator-entitlement-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool, dbAdminPool(t, dbName), orgID
}

func dbAdminPool(t *testing.T, dbName string) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	pool, err := workdb.OpenPool(ctx, testpg.AdminURLFor(dbName), "operator-entitlement-observer")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestDisableLandsLocallyBeforeHostAndRestoreWaitsForAck(t *testing.T) {
	ctx, pool, observer, orgID := setup(t)
	disable := operatorentitlement.Command{
		OrgID: orgID, ActorSubject: "sub_operator", OperatorAuthorizationRef: "OPS-DISABLE",
		ExpectedEntitlementRevision: 0, TargetEntitlementRevision: 1,
		Enabled: false, SeatLimit: 2, RequestID: "11111111-0000-0000-0000-000000000001",
	}
	hostClient := &fakeHost{apply: func(_ context.Context, command host.ExecutionEntitlementCommand, _ string) (host.ExecutionEntitlementReceipt, error) {
		var enabled bool
		var restrictions int
		if err := observer.QueryRow(ctx,
			`SELECT o.execution_enabled, (SELECT count(*) FROM work.access_restriction r
			 WHERE r.org_id=o.id AND r.source='operator' AND r.state='active')
			 FROM work.org o WHERE o.id=$1`, orgID).Scan(&enabled, &restrictions); err != nil {
			t.Fatal(err)
		}
		if enabled || restrictions != 1 {
			t.Fatalf("Host called before local disable: enabled=%v restrictions=%d", enabled, restrictions)
		}
		return receipt(command, "applied"), nil
	}}
	executor := &operatorentitlement.Executor{Pool: pool, Host: hostClient}
	result, err := executor.Execute(ctx, disable)
	if err != nil {
		t.Fatal(err)
	}
	if result.LocalOutcome != "suspended" || result.FinalOutcome != "already_suspended" || result.HostRevision != 1 {
		t.Fatalf("disable result = %#v", result)
	}

	restore := disable
	restore.OperatorAuthorizationRef = "OPS-RESTORE"
	restore.ExpectedEntitlementRevision = 1
	restore.TargetEntitlementRevision = 2
	restore.Enabled = true
	restore.RequestID = "11111111-0000-0000-0000-000000000002"
	hostClient.apply = func(_ context.Context, command host.ExecutionEntitlementCommand, _ string) (host.ExecutionEntitlementReceipt, error) {
		var enabled bool
		var ack any
		if err := observer.QueryRow(ctx,
			`SELECT o.execution_enabled, e.host_ack_revision FROM work.org o
			 JOIN work.execution_entitlement e ON e.org_id=o.id WHERE o.id=$1`, orgID).Scan(&enabled, &ack); err != nil {
			t.Fatal(err)
		}
		if enabled || ack != int64(1) {
			t.Fatalf("restore became effective before Host ack: enabled=%v ack=%v", enabled, ack)
		}
		return receipt(command, "applied"), nil
	}
	result, err = executor.Execute(ctx, restore)
	if err != nil {
		t.Fatal(err)
	}
	if result.LocalOutcome != "pending_ack" || result.FinalOutcome != "restored" {
		t.Fatalf("restore result = %#v", result)
	}
	var enabled bool
	var ack int64
	var state string
	if err := observer.QueryRow(ctx,
		`SELECT o.execution_enabled, e.host_ack_revision, r.state FROM work.org o
		 JOIN work.execution_entitlement e ON e.org_id=o.id
		 JOIN work.access_restriction r ON r.org_id=o.id AND r.source='operator'
		 WHERE o.id=$1`, orgID).Scan(&enabled, &ack, &state); err != nil {
		t.Fatal(err)
	}
	if !enabled || ack != 2 || state != "released" {
		t.Fatalf("restored facts = enabled:%v ack:%d deny:%s", enabled, ack, state)
	}
}

func TestHostTimeoutQueriesOriginalCommandBeforeAck(t *testing.T) {
	ctx, pool, observer, orgID := setup(t)
	command := operatorentitlement.Command{
		OrgID: orgID, ActorSubject: "sub_operator", OperatorAuthorizationRef: "OPS-TIMEOUT",
		ExpectedEntitlementRevision: 0, TargetEntitlementRevision: 1,
		Enabled: false, SeatLimit: 2, RequestID: "22222222-0000-0000-0000-000000000001",
	}
	gets := 0
	hostClient := &fakeHost{
		apply: func(context.Context, host.ExecutionEntitlementCommand, string) (host.ExecutionEntitlementReceipt, error) {
			return host.ExecutionEntitlementReceipt{}, &host.Error{Code: "entitlement_unavailable"}
		},
		get: func(_ context.Context, commandID, _ string) (host.ExecutionEntitlementReceipt, error) {
			gets++
			if commandID != command.RequestID {
				t.Fatalf("queried command = %s", commandID)
			}
			return receipt(host.ExecutionEntitlementCommand{
				CommandID: commandID, OrgID: orgID, Enabled: command.Enabled,
				SeatLimit: command.SeatLimit, OperatorSuspended: command.OperatorSuspended,
				TargetEntitlementRevision: command.TargetEntitlementRevision,
			}, "applied"), nil
		},
	}
	executor := &operatorentitlement.Executor{Pool: pool, Host: hostClient}
	if _, err := executor.Execute(ctx, command); err != nil {
		t.Fatal(err)
	}
	if gets != 1 {
		t.Fatalf("GET calls = %d", gets)
	}
	var ack int64
	if err := observer.QueryRow(ctx,
		`SELECT host_ack_revision FROM work.execution_entitlement WHERE org_id=$1`, orgID).Scan(&ack); err != nil {
		t.Fatal(err)
	}
	if ack != 1 {
		t.Fatalf("host ack = %d", ack)
	}
}

func TestUnknownHostOutcomeLeavesPendingAndSameRequestReplays(t *testing.T) {
	ctx, pool, observer, orgID := setup(t)
	command := operatorentitlement.Command{
		OrgID: orgID, ActorSubject: "sub_operator", OperatorAuthorizationRef: "OPS-UNKNOWN",
		ExpectedEntitlementRevision: 0, TargetEntitlementRevision: 1,
		Enabled: false, SeatLimit: 2, RequestID: "33333333-0000-0000-0000-000000000001",
	}
	hostClient := &fakeHost{
		apply: func(context.Context, host.ExecutionEntitlementCommand, string) (host.ExecutionEntitlementReceipt, error) {
			return host.ExecutionEntitlementReceipt{}, &host.Error{Code: "entitlement_unavailable"}
		},
		get: func(context.Context, string, string) (host.ExecutionEntitlementReceipt, error) {
			return host.ExecutionEntitlementReceipt{}, &host.Error{Code: "command_not_found"}
		},
	}
	executor := &operatorentitlement.Executor{Pool: pool, Host: hostClient}
	if _, err := executor.Execute(ctx, command); err == nil {
		t.Fatal("unknown Host outcome was acknowledged")
	}
	var ack any
	if err := observer.QueryRow(ctx,
		`SELECT host_ack_revision FROM work.execution_entitlement WHERE org_id=$1`, orgID).Scan(&ack); err != nil {
		t.Fatal(err)
	}
	if ack != nil {
		t.Fatalf("unknown Host outcome wrote ack = %v", ack)
	}

	hostClient.apply = func(_ context.Context, command host.ExecutionEntitlementCommand, _ string) (host.ExecutionEntitlementReceipt, error) {
		return receipt(command, "replayed"), nil
	}
	result, err := executor.Execute(ctx, command)
	if err != nil {
		t.Fatal(err)
	}
	if result.HostStatus != "replayed" || result.FinalOutcome != "already_suspended" {
		t.Fatalf("replay result = %#v", result)
	}
	var audits int
	if err := observer.QueryRow(ctx,
		`SELECT count(*) FROM work.audit_event WHERE org_id=$1 AND action='execution_entitlement.applied'`, orgID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 2 {
		t.Fatalf("entitlement audit rows = %d, want original plus one ack", audits)
	}
}

func TestHostConflictLeavesLocalCommandUnacknowledged(t *testing.T) {
	ctx, pool, observer, orgID := setup(t)
	command := operatorentitlement.Command{
		OrgID: orgID, ActorSubject: "sub_operator", OperatorAuthorizationRef: "OPS-CONFLICT",
		ExpectedEntitlementRevision: 9, TargetEntitlementRevision: 10,
		Enabled: false, SeatLimit: 2, RequestID: "55555555-0000-0000-0000-000000000001",
	}
	hostClient := &fakeHost{apply: func(context.Context, host.ExecutionEntitlementCommand, string) (host.ExecutionEntitlementReceipt, error) {
		return host.ExecutionEntitlementReceipt{}, &host.Error{Code: "governance_revision_conflict"}
	}}
	executor := &operatorentitlement.Executor{Pool: pool, Host: hostClient}
	if _, err := executor.Execute(ctx, command); err == nil {
		t.Fatal("Host revision conflict was acknowledged")
	}
	var revision int64
	var ack any
	if err := observer.QueryRow(ctx,
		`SELECT revision, host_ack_revision FROM work.execution_entitlement WHERE org_id=$1`, orgID).Scan(&revision, &ack); err != nil {
		t.Fatal(err)
	}
	if revision != 10 || ack != nil {
		t.Fatalf("conflict facts = revision:%d ack:%v", revision, ack)
	}
}

func TestPendingApplyConflictKeepsTheRevisionMonotonic(t *testing.T) {
	ctx, pool, observer, orgID := setup(t)
	first := operatorentitlement.Command{
		OrgID: orgID, ActorSubject: "sub_operator", OperatorAuthorizationRef: "OPS-PENDING",
		ExpectedEntitlementRevision: 0, TargetEntitlementRevision: 1,
		Enabled: false, SeatLimit: 2, RequestID: "66666666-0000-0000-0000-000000000001",
	}
	applyCalls := 0
	hostClient := &fakeHost{
		apply: func(context.Context, host.ExecutionEntitlementCommand, string) (host.ExecutionEntitlementReceipt, error) {
			applyCalls++
			if applyCalls == 1 {
				return host.ExecutionEntitlementReceipt{}, &host.Error{Code: "entitlement_unavailable"}
			}
			return host.ExecutionEntitlementReceipt{}, &host.Error{Code: "governance_revision_conflict"}
		},
		get: func(context.Context, string, string) (host.ExecutionEntitlementReceipt, error) {
			return host.ExecutionEntitlementReceipt{}, &host.Error{Code: "command_not_found"}
		},
	}
	executor := &operatorentitlement.Executor{Pool: pool, Host: hostClient}
	if _, err := executor.Execute(ctx, first); err == nil {
		t.Fatal("unknown Host outcome was acknowledged")
	}

	second := first
	second.OperatorAuthorizationRef = "OPS-PENDING-CONFLICT"
	second.ExpectedEntitlementRevision = 0
	second.TargetEntitlementRevision = 2
	second.RequestID = "66666666-0000-0000-0000-000000000002"
	if _, err := executor.Execute(ctx, second); err == nil {
		t.Fatal("a second Apply against an unacknowledged revision was acknowledged")
	}
	var revision int64
	var ack any
	if err := observer.QueryRow(ctx,
		`SELECT revision, host_ack_revision FROM work.execution_entitlement WHERE org_id=$1`, orgID).Scan(&revision, &ack); err != nil {
		t.Fatal(err)
	}
	if revision != 1 || ack != nil {
		t.Fatalf("pending conflict facts = revision:%d ack:%v", revision, ack)
	}
}

func TestInvalidCommandDoesNotTouchDatabase(t *testing.T) {
	_, pool, _, _ := setup(t)
	executor := &operatorentitlement.Executor{Pool: pool, Host: fakeHost{}}
	_, err := executor.Execute(context.Background(), operatorentitlement.Command{RequestID: "bad"})
	if err == nil {
		t.Fatal("invalid command accepted")
	}
	if !strings.Contains(err.Error(), "required") {
		t.Fatalf("error = %v", err)
	}
}
