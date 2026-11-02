package relay_test

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/testpg"
)

// D3-N06 has two halves, and only the refusing half was pinned. The switch must stop
// new submissions, new exports and new dispatch - that is asserted through the endpoint
// in internal/api/audit_export_gate_pg_test.go against migration 0026. The other half is
// the one the drill doc words as "开关打开时：relay/shredder/投影同步/到期清扫继续"
// (work-r0a-c03-u3-drills-2026-10-27.md:80), and that the orchestration design states as
// a property of two of its rows: "kill switch 不停 relay"
// (work-r0a-orchestration-design-2026-10-25.md:505) and "停用不取消清理：留存/删除是义务，
// 不随功能开关关闭" (:506).
//
// That half is easy to break in the direction that looks safe: a reviewer who sees a
// suspended organization and adds a suspension check to the relay or to a sweep function
// would silently strand encrypted content on disk for every paused tenant, which is the
// opposite of what a suspension means. So this case runs the retention sweeps and the
// relay itself while the org is switched off and requires them to do their work.
//
// operator_suspended is set directly here because R0a has no producer for it - the
// operational switch is work.apply_execution_entitlement (increments/0023:263), which
// belongs to R0b's I2 and is tested there. The column is the fact every reader sees, so
// writing it is the same state the real producer leaves.

const (
	susInputID    = "22222222-1111-4111-8111-111111111111"
	susExportID   = "33333333-1111-4111-8111-111111111111"
	susRelayID    = "relay-while-suspended"
	susSubject    = "sub_relay"
	susTTLInputID = "44444444-1111-4111-8111-111111111111"
)

type shredCounts struct {
	rows      int
	delivered int
	dead      int
}

func readShredCounts(t *testing.T, dbName string) shredCounts {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.outbox_relay', 'on', false)`); err != nil {
		t.Fatal(err)
	}
	var counts shredCounts
	if err := conn.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE delivered_at IS NOT NULL),
		       count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)
		FROM work.outbox WHERE payload->>'kind' = 'content_shred'`).
		Scan(&counts.rows, &counts.delivered, &counts.dead); err != nil {
		t.Fatal(err)
	}
	return counts
}

// seedSuspendedOrg writes one of every fact a sweep is supposed to act on: an unbound
// input past its TTL and a ready-since-expired audit export that still carries its
// content reference. Then it switches the organization off.
func seedSuspendedOrg(t *testing.T, dbName, directory string) (string, string) {
	t.Helper()
	ctx := context.Background()
	store := openCrashStore(t, directory)
	fromInput, err := store.Put(ctx, relayOrg, []byte("swept input body"))
	if err != nil {
		t.Fatal(err)
	}
	fromExport, err := store.Put(ctx, relayOrg, []byte("swept export body"))
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
		INSERT INTO work.input_object
		  (id, org_id, subject_id, content_ref, content_hash, bytes, status, expires_at)
		VALUES ('%s', '%s', '%s', '%s', '%s', %d, 'active', now() - interval '1 hour');
		INSERT INTO work.input_object
		  (id, org_id, subject_id, content_ref, content_hash, bytes, status, expires_at)
		VALUES ('%s', '%s', '%s', 'content://relay-not-due', 'sha256:notdue', 11,
		        'active', now() + interval '1 hour');
		INSERT INTO work.audit_export
		  (id, org_id, requested_by, client_request_id, request_hash, range_from, range_to,
		   format, status, content_ref, content_hash, bytes)
		VALUES ('%s', '%s', '%s', 'suspended-export', 'sha256:export-request',
		        now() - interval '2 day', now() - interval '1 day', 'csv', 'expired',
		        '%s', '%s', %d);
		UPDATE work.org SET operator_suspended = true, execution_enabled = false
		WHERE id = '%s';
	`, relayOrg, relayOrg,
		susInputID, relayOrg, susSubject, fromInput.ContentRef, fromInput.Hash, fromInput.Bytes,
		susTTLInputID, relayOrg, susSubject,
		susExportID, relayOrg, susSubject, fromExport.ContentRef, fromExport.Hash, fromExport.Bytes,
		relayOrg)
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
	return fromInput.ContentRef, fromExport.ContentRef
}

// runRetentionSweeps calls the two sweep entrypoints as work_worker, per organization,
// exactly the way the scheduled job does (baseline:4993 - "这些作业按组织逐个事务运行").
func runRetentionSweeps(t *testing.T, pool *pgxpool.Pool) (int, int) {
	t.Helper()
	ctx := context.Background()
	inputs, exports := -1, -1
	err := workdb.WithWorkerOrgContext(ctx, pool, relayOrg, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT work.expire_due_inputs()`).Scan(&inputs); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT work.shred_due_audit_exports()`).Scan(&exports)
	})
	if err != nil {
		t.Fatal(err)
	}
	return inputs, exports
}

func readOrgFlags(t *testing.T, dbName string) (bool, bool) {
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
	var suspended, executionEnabled bool
	if err := conn.QueryRow(ctx, `
		SELECT operator_suspended, execution_enabled FROM work.org WHERE id = $1`, relayOrg,
	).Scan(&suspended, &executionEnabled); err != nil {
		t.Fatal(err)
	}
	return suspended, executionEnabled
}

func readInputState(t *testing.T, dbName, inputID string) (string, bool) {
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
	var status string
	var deleted bool
	if err := conn.QueryRow(ctx, `
		SELECT status, deleted_at IS NOT NULL FROM work.input_object
		WHERE id = $1 AND org_id = $2`, inputID, relayOrg,
	).Scan(&status, &deleted); err != nil {
		t.Fatal(err)
	}
	return status, deleted
}

func TestRelayKeepsObligationsWhileOrgSuspended(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	pool, dbName := newRelayDB(t)
	directory, err := os.MkdirTemp("", "work-relay-suspended")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	refInput, refExport := seedSuspendedOrg(t, dbName, directory)
	store := openCrashStore(t, directory)
	ctx := context.Background()

	suspended, executionEnabled := readOrgFlags(t, dbName)
	if !suspended || executionEnabled {
		t.Fatalf("seed must leave the org switched off: suspended=%t enabled=%t",
			suspended, executionEnabled)
	}
	if counts := readShredCounts(t, dbName); counts.rows != 0 {
		t.Fatalf("seed must not pre-enqueue shreds: %#v", counts)
	}

	// The duty jobs run against a switched-off organization, and they still do the work.
	inputs, exports := runRetentionSweeps(t, pool)
	if inputs != 1 || exports != 1 {
		t.Fatalf("sweeps while suspended swept inputs=%d exports=%d, want 1 and 1",
			inputs, exports)
	}
	counts := readShredCounts(t, dbName)
	if counts.rows != 2 || counts.delivered != 0 || counts.dead != 0 {
		t.Fatalf("shred queue while suspended = %#v, want two undelivered rows", counts)
	}
	// Each sweep acted on its own predicate, not on "everything in the tenant": the
	// input that is not yet due is still an active, undeleted object.
	if status, deleted := readInputState(t, dbName, susTTLInputID); status != "active" || deleted {
		t.Fatalf("not-yet-due input = %q deleted=%t, must be untouched", status, deleted)
	}
	if status, deleted := readInputState(t, dbName, susInputID); status != "expired" || !deleted {
		t.Fatalf("due input = %q deleted=%t, want expired and deleted", status, deleted)
	}

	service := crashRelay(t, pool, susRelayID, store)
	claimed, err := service.Once(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if claimed != 2 {
		t.Fatalf("relay while suspended claimed %d events, want both shreds", claimed)
	}
	after := readShredCounts(t, dbName)
	if after.rows != 2 || after.delivered != 2 || after.dead != 0 {
		t.Fatalf("shred delivery while suspended = %#v, want both delivered", after)
	}
	if contentReadable(t, store, refInput) || contentReadable(t, store, refExport) {
		t.Fatal("a suspension cannot leave task content behind")
	}

	// Delivery of a duty event neither queues a follow-up nor relaxes the switch:
	// recovery has to be the explicit operator action, not a side effect of the relay.
	if _, err := service.Once(ctx); err != nil {
		t.Fatal(err)
	}
	final := readShredCounts(t, dbName)
	if final.rows != 2 || final.delivered != 2 || final.dead != 0 {
		t.Fatalf("after a second pass = %#v, want no new shred events and no dead letters", final)
	}
	if stillSuspended, stillEnabled := readOrgFlags(t, dbName); !stillSuspended || stillEnabled {
		t.Fatalf("the relay changed the operator switch: suspended=%t enabled=%t",
			stillSuspended, stillEnabled)
	}
}
