package contentref_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/contentref"
	"github.com/we-meet/work/internal/migrate"
	"github.com/we-meet/work/internal/testpg"
	embedded "github.com/we-meet/work/migrations"
)

// These tests exercise increment 0011 and the contentref package against a real
// PostgreSQL instance. Domain calls run as the work_worker login with an
// explicit tenant context, so grants and RLS are part of the assertion. Base
// rows are written with the admin connection.

var (
	testAdmin *pgx.Conn
	testDB    string
	testPool  *pgxpool.Pool
)

func TestMain(m *testing.M) {
	if os.Getenv("WORK_TEST_PG_URL") == "" {
		os.Exit(m.Run())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	admin, err := pgx.Connect(ctx, testpg.AdminURL())
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect test PostgreSQL: %v\n", err)
		os.Exit(1)
	}
	if err := testpg.EnsureFixtures(ctx, admin); err != nil {
		fmt.Fprintf(os.Stderr, "prepare test fixtures: %v\n", err)
		os.Exit(1)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_contentref_test")
	if err != nil {
		fmt.Fprintf(os.Stderr, "create baseline database: %v\n", err)
		os.Exit(1)
	}
	dbAdmin, err := pgx.Connect(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect baseline database: %v\n", err)
		os.Exit(1)
	}
	pool, err := pgxpool.New(ctx, testpg.WorkerURL(dbName))
	if err != nil {
		fmt.Fprintf(os.Stderr, "open worker pool: %v\n", err)
		os.Exit(1)
	}
	testAdmin, testDB, testPool = dbAdmin, dbName, pool

	code := m.Run()

	pool.Close()
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cleanupCancel()
	_ = dbAdmin.Close(cleanupCtx)
	_ = testpg.DropDatabase(cleanupCtx, admin, dbName)
	_ = admin.Close(cleanupCtx)
	os.Exit(code)
}

func requireDB(t *testing.T) {
	t.Helper()
	if testAdmin == nil || testPool == nil {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
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

func hashFor(seed string) string {
	return "sha256:" + strings.Repeat(seed, 64)[:64]
}

type tenant struct {
	org     string
	subject string
	taskID  string
	runID   string
	execID  string
}

func seedTenant(t *testing.T, org string) tenant {
	t.Helper()
	ctx := testContext(t)
	tn := tenant{
		org:     org,
		subject: "sub_" + org,
		taskID:  newUUID(t),
		runID:   newUUID(t),
		execID:  newUUID(t),
	}
	inputID := newUUID(t)
	snapshotID := newUUID(t)
	seed := fmt.Sprintf(`
		SET app.org_id = %[1]s;
		INSERT INTO work.org (id, status, home_region) VALUES (%[1]s, 'active', 'cn-north')
		ON CONFLICT (id) DO NOTHING;
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES (%[1]s, %[2]s, 'active', 'owner', true)
		ON CONFLICT (org_id, subject_id) DO NOTHING;
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%[3]s', %[1]s, %[2]s, 'input/%[3]s', repeat('a', 64), 12);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, input_id, title)
		VALUES ('%[4]s', %[1]s, %[2]s, 'open', '%[3]s', 'contentref task');
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
		INSERT INTO work.runtime_execution
		  (execution_id, org_id, task_id, run_id, mode, run_fence, runtime_version,
		   state, holder_id, lease_until, hard_deadline)
		VALUES ('%[7]s', %[1]s, '%[4]s', '%[6]s', 'plan', 1, 'pi-1', 'active',
		        'holder-test', now() + interval '1 hour', now() + interval '2 hours');
	`, quote(tn.org), quote(tn.subject), inputID, tn.taskID, snapshotID, tn.runID, tn.execID)
	if _, err := testAdmin.Exec(ctx, seed); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	return tn
}

func quote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

var enumeratedCode = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)

func workerConn(t *testing.T, org string) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(testContext(t), testpg.WorkerURL(testDB))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	if org != "" {
		if _, err := conn.Exec(testContext(t),
			"SELECT set_config('app.org_id', $1, false)", org); err != nil {
			t.Fatal(err)
		}
	}
	return conn
}

func workerConnWithoutContext(t *testing.T) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(testContext(t), testpg.WorkerURL(testDB))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func refArgs(reference contentref.Reference) []any {
	return []any{
		reference.OrgID,
		reference.RefID,
		nullable(reference.TaskID),
		nullable(reference.RunID),
		nullable(reference.ExecutionID),
		string(reference.Kind),
		reference.LogicalSlot,
		reference.ObjectVersion,
		reference.ContentRef,
		reference.ContentHash,
		reference.Bytes,
		string(reference.WriterKind),
	}
}

func sqlRegister(t *testing.T, conn *pgx.Conn, reference contentref.Reference) (string, error) {
	t.Helper()
	var outcome string
	err := conn.QueryRow(testContext(t), `
		SELECT (work.register_content_reference(
		  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12))->>'outcome'`,
		refArgs(reference)...,
	).Scan(&outcome)
	return outcome, err
}

func sqlReserve(t *testing.T, conn *pgx.Conn, orgID, refID, executionID,
	kind, logicalSlot string,
) (string, error) {
	t.Helper()
	var outcome string
	err := conn.QueryRow(testContext(t), `
		SELECT (work.reserve_content_slot($1, $2, $3, $4, $5))->>'outcome'`,
		orgID, refID, executionID, kind, logicalSlot,
	).Scan(&outcome)
	return outcome, err
}

func sqlCommit(t *testing.T, conn *pgx.Conn, orgID, refID, contentRef,
	contentHash string, bytes int64,
) (string, error) {
	t.Helper()
	var outcome string
	err := conn.QueryRow(testContext(t), `
		SELECT (work.commit_content_slot($1, $2, $3, $4, $5))->>'outcome'`,
		orgID, refID, contentRef, contentHash, bytes,
	).Scan(&outcome)
	return outcome, err
}

func pgMessageCode(t *testing.T, err error) string {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("error = %v, want a PostgreSQL error", err)
	}
	code := pgErr.Message
	if index := strings.IndexByte(code, ':'); index >= 0 {
		code = code[:index]
	}
	if enumeratedCode.MatchString(code) {
		return code
	}
	if pgErr.Code == "42501" {
		return "permission_denied"
	}
	return code
}

func tenantReference(t *testing.T, tn tenant, kind contentref.Kind, slot string) contentref.Reference {
	t.Helper()
	return contentref.Reference{
		RefID:         newUUID(t),
		OrgID:         tn.org,
		TaskID:        tn.taskID,
		RunID:         tn.runID,
		ExecutionID:   tn.execID,
		Kind:          kind,
		LogicalSlot:   slot,
		ObjectVersion: "v1",
		ContentRef:    "objects/" + tn.org + "/" + slot,
		ContentHash:   hashFor("a"),
		Bytes:         256,
		WriterKind:    contentref.WriterControlPlane,
		SlotState:     contentref.SlotCommitted,
	}
}

func errorCode(t *testing.T, err error) string {
	t.Helper()
	var contentErr *contentref.Error
	if !errors.As(err, &contentErr) {
		t.Fatalf("error = %v, want a contentref enumeration error", err)
	}
	return contentErr.Code
}

func TestTableShapeHasNoBodyAndForceRLS(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	rows, err := testAdmin.Query(ctx, `
		SELECT column_name
		FROM information_schema.columns
		WHERE table_schema = 'work' AND table_name = 'content_reference'
		ORDER BY ordinal_position`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var columns []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		columns = append(columns, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"ref_id", "org_id", "task_id", "run_id", "execution_id", "kind",
		"logical_slot", "object_version", "content_ref", "content_hash", "bytes",
		"writer_kind", "tombstoned_at", "created_at", "updated_at", "slot_state",
	}
	if strings.Join(columns, ",") != strings.Join(want, ",") {
		t.Fatalf("columns = %v, want %v (no body column may ever exist)", columns, want)
	}

	var enabled, forced bool
	if err := testAdmin.QueryRow(ctx, `
		SELECT relrowsecurity, relforcerowsecurity
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'work' AND c.relname = 'content_reference'`,
	).Scan(&enabled, &forced); err != nil {
		t.Fatal(err)
	}
	if !enabled || !forced {
		t.Fatalf("RLS enabled=%v forced=%v, want both true", enabled, forced)
	}
}

func TestRegisterResolveRoundTrip(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tn := seedTenant(t, "org_contentref_roundtrip")
	registry := contentref.NewRegistry(testPool)
	reference := tenantReference(t, tn, contentref.KindCheckpointCandidate,
		"checkpoint:model:1:candidate")

	if err := registry.Register(ctx, reference); err != nil {
		t.Fatalf("register: %v", err)
	}
	got, err := registry.Resolve(ctx, tn.org, reference.RefID)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != reference {
		t.Fatalf("resolved = %#v, want %#v", got, reference)
	}
	if _, err := registry.Resolve(ctx, tn.org, newUUID(t)); !errors.Is(err, contentref.ErrNotFound) {
		t.Fatalf("missing reference error = %v, want ErrNotFound", err)
	}
}

func TestReserveCommitRoundTripHidesCandidateUntilCommit(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tn := seedTenant(t, "org_contentref_slot_roundtrip")
	registry := contentref.NewRegistry(testPool)
	refID := newUUID(t)
	slot := "checkpoint:slot:roundtrip"
	contentRef := "objects/" + tn.org + "/" + slot
	contentHash := hashFor("d")

	if err := registry.Reserve(ctx, tn.org, refID, tn.execID,
		contentref.KindCheckpointCandidate, slot); err != nil {
		t.Fatalf("reserve: %v", err)
	}

	var state, writer string
	var storedRef, storedHash *string
	var storedBytes *int64
	if err := testAdmin.QueryRow(ctx, `
		SELECT slot_state, writer_kind, content_ref, content_hash, bytes
		FROM work.content_reference WHERE org_id = $1 AND ref_id = $2`,
		tn.org, refID,
	).Scan(&state, &writer, &storedRef, &storedHash, &storedBytes); err != nil {
		t.Fatal(err)
	}
	if state != "reserved" || writer != "runtime_child" {
		t.Fatalf("reserved row state=%q writer=%q", state, writer)
	}
	if storedRef != nil || storedHash != nil || storedBytes != nil {
		t.Fatalf("reserved row carried content: ref=%v hash=%v bytes=%v",
			storedRef, storedHash, storedBytes)
	}

	// A reserved candidate is not a fact and must not authorise a read.
	if _, err := registry.Resolve(ctx, tn.org, refID); !errors.Is(err, contentref.ErrNotFound) {
		t.Fatalf("resolve before commit = %v, want ErrNotFound", err)
	}

	if err := registry.Commit(ctx, tn.org, refID, contentRef, contentHash, 321); err != nil {
		t.Fatalf("commit: %v", err)
	}
	got, err := registry.Resolve(ctx, tn.org, refID)
	if err != nil {
		t.Fatalf("resolve after commit: %v", err)
	}
	want := contentref.Reference{
		RefID:         refID,
		OrgID:         tn.org,
		TaskID:        tn.taskID,
		RunID:         tn.runID,
		ExecutionID:   tn.execID,
		Kind:          contentref.KindCheckpointCandidate,
		LogicalSlot:   slot,
		ObjectVersion: refID,
		ContentRef:    contentRef,
		ContentHash:   contentHash,
		Bytes:         321,
		WriterKind:    contentref.WriterRuntimeChild,
		SlotState:     contentref.SlotCommitted,
	}
	if got != want {
		t.Fatalf("resolved = %#v, want %#v", got, want)
	}

	var audits int
	if err := testAdmin.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND target_id = $2
		  AND action IN ('content.reference_reserved', 'content.reference_committed')`,
		tn.org, refID,
	).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 2 {
		t.Fatalf("reserve/commit audits = %d, want 2", audits)
	}
}

func TestReserveReplayIsIdempotentAndOccupiedSlotsConflict(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tn := seedTenant(t, "org_contentref_slot_replay")
	registry := contentref.NewRegistry(testPool)
	worker := workerConn(t, tn.org)
	refID := newUUID(t)
	otherRefID := newUUID(t)
	slot := "checkpoint:slot:replay"

	if outcome, err := sqlReserve(t, worker, tn.org, refID, tn.execID,
		string(contentref.KindCheckpointCandidate), slot); err != nil || outcome != "reserved" {
		t.Fatalf("first reserve outcome=%q err=%v", outcome, err)
	}
	if outcome, err := sqlReserve(t, worker, tn.org, refID, tn.execID,
		string(contentref.KindCheckpointCandidate), slot); err != nil || outcome != "idempotent" {
		t.Fatalf("replay reserve outcome=%q err=%v", outcome, err)
	}
	var rows int
	if err := testAdmin.QueryRow(ctx, `
		SELECT count(*) FROM work.content_reference
		WHERE org_id = $1 AND logical_slot = $2`, tn.org, slot).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("rows = %d, want 1", rows)
	}

	if err := registry.Reserve(ctx, tn.org, otherRefID, tn.execID,
		contentref.KindCheckpointCandidate, slot); !errors.Is(err, contentref.ErrSlotConflict) {
		t.Fatalf("different ref on occupied slot = %v, want ErrSlotConflict", err)
	}

	if err := registry.Commit(ctx, tn.org, refID,
		"objects/"+tn.org+"/"+slot, hashFor("e"), 10); err != nil {
		t.Fatalf("commit: %v", err)
	}
	// A committed slot is a fact; it cannot be reserved again.
	if err := registry.Reserve(ctx, tn.org, refID, tn.execID,
		contentref.KindCheckpointCandidate, slot); !errors.Is(err, contentref.ErrSlotConflict) {
		t.Fatalf("reserve committed slot = %v, want ErrSlotConflict", err)
	}
}

func TestCommitRules(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tn := seedTenant(t, "org_contentref_commit_rules")
	registry := contentref.NewRegistry(testPool)

	// No reservation at all.
	if err := registry.Commit(ctx, tn.org, newUUID(t),
		"objects/missing", hashFor("f"), 1); !errors.Is(err, contentref.ErrNotFound) {
		t.Fatalf("commit without reservation = %v, want ErrNotFound", err)
	}

	// A plain registered control-plane candidate is committed already and is
	// not a runtime-child reservation.
	registered := tenantReference(t, tn, contentref.KindCheckpointCandidate,
		"checkpoint:slot:registered")
	if err := registry.Register(ctx, registered); err != nil {
		t.Fatalf("register: %v", err)
	}
	err := registry.Commit(ctx, tn.org, registered.RefID,
		registered.ContentRef, registered.ContentHash, registered.Bytes)
	if code := errorCode(t, err); code != "content_reference_writer_not_allowed" {
		t.Fatalf("commit registered row code = %q", code)
	}

	// A tombstoned reservation can never commit.
	tombstonedRef := newUUID(t)
	tombstonedSlot := "checkpoint:slot:tombstoned"
	if err := registry.Reserve(ctx, tn.org, tombstonedRef, tn.execID,
		contentref.KindCheckpointCandidate, tombstonedSlot); err != nil {
		t.Fatalf("reserve before tombstone: %v", err)
	}
	if changed, err := registry.Tombstone(ctx, tn.org, tombstonedRef,
		"retention_expired"); err != nil || !changed {
		t.Fatalf("tombstone reserved: changed=%v err=%v", changed, err)
	}
	if err := registry.Commit(ctx, tn.org, tombstonedRef,
		"objects/"+tn.org+"/"+tombstonedSlot, hashFor("a"), 1); !errors.Is(err, contentref.ErrSlotConflict) {
		t.Fatalf("commit tombstoned slot = %v, want ErrSlotConflict", err)
	}
	if err := registry.Reserve(ctx, tn.org, tombstonedRef, tn.execID,
		contentref.KindCheckpointCandidate, tombstonedSlot); !errors.Is(err, contentref.ErrSlotConflict) {
		t.Fatalf("reserve tombstoned slot = %v, want ErrSlotConflict", err)
	}

	// Same-content replay is idempotent; a different hash conflicts.
	refID := newUUID(t)
	slot := "checkpoint:slot:content"
	contentRef := "objects/" + tn.org + "/" + slot
	if err := registry.Reserve(ctx, tn.org, refID, tn.execID,
		contentref.KindCheckpointCandidate, slot); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if err := registry.Commit(ctx, tn.org, refID, contentRef, hashFor("b"), 64); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := registry.Commit(ctx, tn.org, refID, contentRef, hashFor("b"), 64); err != nil {
		t.Fatalf("same-content replay: %v", err)
	}
	if err := registry.Commit(ctx, tn.org, refID, contentRef, hashFor("c"), 64); !errors.Is(err, contentref.ErrSlotConflict) {
		t.Fatalf("different hash = %v, want ErrSlotConflict", err)
	}
	if err := registry.Commit(ctx, tn.org, refID, contentRef+"/other", hashFor("b"), 64); !errors.Is(err, contentref.ErrSlotConflict) {
		t.Fatalf("different content ref = %v, want ErrSlotConflict", err)
	}
}

func TestReserveRequiresLiveExecution(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tn := seedTenant(t, "org_contentref_slot_dead")
	registry := contentref.NewRegistry(testPool)
	if _, err := testAdmin.Exec(ctx, `
		UPDATE work.runtime_execution SET state = 'completed'
		WHERE execution_id = $1 AND org_id = $2`, tn.execID, tn.org); err != nil {
		t.Fatal(err)
	}
	if err := registry.Reserve(ctx, tn.org, newUUID(t), tn.execID,
		contentref.KindCheckpointCandidate, "checkpoint:slot:dead"); err == nil {
		t.Fatal("reserve accepted a completed execution")
	} else if code := errorCode(t, err); code != "runtime_execution_not_active" {
		t.Fatalf("dead execution code = %q", code)
	}
	if err := registry.Reserve(ctx, tn.org, newUUID(t), newUUID(t),
		contentref.KindCheckpointCandidate, "checkpoint:slot:missing"); err == nil {
		t.Fatal("reserve accepted an unknown execution")
	} else if code := errorCode(t, err); code != "runtime_execution_not_found" {
		t.Fatalf("unknown execution code = %q", code)
	}
	if err := registry.Reserve(ctx, tn.org, newUUID(t), tn.execID,
		contentref.KindCheckpointCandidate, "checkpoint slot invalid"); err == nil {
		t.Fatal("reserve accepted an invalid logical slot")
	}
	if err := registry.Reserve(ctx, tn.org, newUUID(t), tn.execID,
		contentref.KindAnswer, "checkpoint:slot:kind"); err == nil {
		t.Fatal("reserve accepted a non-candidate kind")
	}
}

func TestRegisterReplayOutcomes(t *testing.T) {
	requireDB(t)
	tn := seedTenant(t, "org_contentref_replay")
	registry := contentref.NewRegistry(testPool)
	reference := tenantReference(t, tn, contentref.KindCheckpointCandidate,
		"checkpoint:model:2:candidate")
	worker := workerConn(t, tn.org)

	outcome, err := sqlRegister(t, worker, reference)
	if err != nil {
		t.Fatalf("first register: %v", err)
	}
	if outcome != "registered" {
		t.Fatalf("first outcome = %q", outcome)
	}
	outcome, err = sqlRegister(t, worker, reference)
	if err != nil {
		t.Fatalf("replay register: %v", err)
	}
	if outcome != "idempotent" {
		t.Fatalf("replay outcome = %q", outcome)
	}
	if err := registry.Register(testContext(t), reference); err != nil {
		t.Fatalf("go replay: %v", err)
	}
	var rows int
	if err := testAdmin.QueryRow(testContext(t), `
		SELECT count(*) FROM work.content_reference
		WHERE org_id = $1 AND logical_slot = $2`,
		tn.org, reference.LogicalSlot,
	).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("rows = %d, want 1", rows)
	}
}

func TestSameSlotDifferentBindingIsTypedConflict(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tn := seedTenant(t, "org_contentref_conflict")
	registry := contentref.NewRegistry(testPool)
	reference := tenantReference(t, tn, contentref.KindCheckpointCandidate,
		"checkpoint:model:3:candidate")
	if err := registry.Register(ctx, reference); err != nil {
		t.Fatalf("register: %v", err)
	}

	differentHash := reference
	differentHash.ContentHash = hashFor("b")
	differentHash.ContentRef = reference.ContentRef + "/other"
	if err := registry.Register(ctx, differentHash); !errors.Is(err, contentref.ErrSlotConflict) {
		t.Fatalf("different hash error = %v, want ErrSlotConflict", err)
	}

	differentID := reference
	differentID.RefID = newUUID(t)
	differentID.ContentHash = hashFor("c")
	if err := registry.Register(ctx, differentID); !errors.Is(err, contentref.ErrSlotConflict) {
		t.Fatalf("different ref error = %v, want ErrSlotConflict", err)
	}

	var rows int
	if err := testAdmin.QueryRow(ctx, `
		SELECT count(*) FROM work.content_reference
		WHERE org_id = $1 AND logical_slot = $2`,
		tn.org, reference.LogicalSlot,
	).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("rows = %d, want 1", rows)
	}
}

func TestReceiptRequiresEgressWriter(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tn := seedTenant(t, "org_contentref_receipt")
	registry := contentref.NewRegistry(testPool)

	receipt := tenantReference(t, tn, contentref.KindReceipt, "receipt:"+newUUID(t))
	receipt.WriterKind = contentref.WriterControlPlane
	err := registry.Register(ctx, receipt)
	if code := errorCode(t, err); code != "content_reference_writer_not_allowed" {
		t.Fatalf("control-plane receipt code = %q", code)
	}

	receipt.WriterKind = contentref.WriterEgress
	if err := registry.Register(ctx, receipt); err != nil {
		t.Fatalf("egress receipt: %v", err)
	}
	if _, err := registry.Resolve(ctx, tn.org, receipt.RefID); err != nil {
		t.Fatalf("resolve receipt: %v", err)
	}

	answer := tenantReference(t, tn, contentref.KindAnswer, "answer:"+newUUID(t))
	answer.WriterKind = contentref.WriterControlPlane
	if code := errorCode(t, registry.Register(ctx, answer)); code != "content_reference_writer_not_allowed" {
		t.Fatalf("control-plane answer code = %q", code)
	}
	answer.WriterKind = contentref.WriterEgress
	if err := registry.Register(ctx, answer); err != nil {
		t.Fatalf("egress answer: %v", err)
	}
}

func TestCheckpointRequiresBoundExecution(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tn := seedTenant(t, "org_contentref_checkpoint")
	registry := contentref.NewRegistry(testPool)

	unbound := tenantReference(t, tn, contentref.KindCheckpointCandidate,
		"checkpoint:model:4:candidate")
	unbound.ExecutionID = ""
	if err := registry.Register(ctx, unbound); err == nil {
		t.Fatal("unbound checkpoint candidate was accepted")
	} else if code := errorCode(t, err); code != "invalid_request" {
		t.Fatalf("unbound checkpoint code = %q", code)
	}

	worker := workerConn(t, tn.org)
	raw := unbound
	if _, err := sqlRegister(t, worker, raw); err == nil {
		t.Fatal("SQL accepted an unbound checkpoint candidate")
	} else if code := pgMessageCode(t, err); code != "content_reference_execution_required" {
		t.Fatalf("SQL unbound checkpoint code = %q", code)
	}

	bogus := unbound
	bogus.ExecutionID = newUUID(t)
	if err := registry.Register(ctx, bogus); err == nil {
		t.Fatal("checkpoint candidate with unknown execution was accepted")
	} else if code := errorCode(t, err); code != "runtime_execution_not_found" {
		t.Fatalf("unknown execution code = %q", code)
	}

	if err := registry.Register(ctx, tenantReference(t, tn,
		contentref.KindCheckpointCandidate, "checkpoint:model:5:candidate")); err != nil {
		t.Fatalf("bound checkpoint candidate: %v", err)
	}
}

func TestResolveAfterTombstoneFailsAndEvidenceRemains(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tn := seedTenant(t, "org_contentref_tombstone")
	registry := contentref.NewRegistry(testPool)
	reference := tenantReference(t, tn, contentref.KindInput, "input:"+newUUID(t))
	if err := registry.Register(ctx, reference); err != nil {
		t.Fatalf("register: %v", err)
	}

	changed, err := registry.Tombstone(ctx, tn.org, reference.RefID, "retention_expired")
	if err != nil {
		t.Fatalf("tombstone: %v", err)
	}
	if !changed {
		t.Fatal("first tombstone did not change the row")
	}
	if _, err := registry.Resolve(ctx, tn.org, reference.RefID); !errors.Is(err, contentref.ErrNotFound) {
		t.Fatalf("resolve after tombstone = %v, want ErrNotFound", err)
	}
	if err := registry.Register(ctx, reference); !errors.Is(err, contentref.ErrSlotConflict) {
		t.Fatalf("re-register tombstoned slot = %v, want ErrSlotConflict", err)
	}
	changed, err = registry.Tombstone(ctx, tn.org, reference.RefID, "retention_expired")
	if err != nil {
		t.Fatalf("second tombstone: %v", err)
	}
	if changed {
		t.Fatal("replayed tombstone reported a change")
	}

	var tombstoned bool
	if err := testAdmin.QueryRow(ctx, `
		SELECT tombstoned_at IS NOT NULL FROM work.content_reference
		WHERE org_id = $1 AND ref_id = $2`, tn.org, reference.RefID,
	).Scan(&tombstoned); err != nil {
		t.Fatal(err)
	}
	if !tombstoned {
		t.Fatal("row was deleted instead of tombstoned")
	}

	var audits, firstChanges, replayChanges int
	if err := testAdmin.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE metadata->>'changed' = 'true'),
		       count(*) FILTER (WHERE metadata->>'changed' = 'false')
		FROM work.audit_event
		WHERE org_id = $1 AND action = 'content.reference_tombstoned'
		  AND target_id = $2 AND metadata->>'reason' = 'retention_expired'`,
		tn.org, reference.RefID,
	).Scan(&audits, &firstChanges, &replayChanges); err != nil {
		t.Fatal(err)
	}
	if audits != 2 || firstChanges != 1 || replayChanges != 1 {
		t.Fatalf("audits=%d first=%d replay=%d, want 2/1/1", audits, firstChanges, replayChanges)
	}

	if _, err := testAdmin.Exec(ctx,
		`DELETE FROM work.content_reference WHERE org_id = $1 AND ref_id = $2`,
		tn.org, reference.RefID,
	); err == nil {
		t.Fatal("DELETE removed a reference row")
	}
}

func TestBindingIsImmutable(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tn := seedTenant(t, "org_contentref_immutable")
	registry := contentref.NewRegistry(testPool)
	reference := tenantReference(t, tn, contentref.KindInput, "input:"+newUUID(t))
	if err := registry.Register(ctx, reference); err != nil {
		t.Fatalf("register: %v", err)
	}
	for _, statement := range []string{
		`UPDATE work.content_reference SET content_ref = 'other/object'
		 WHERE org_id = $1 AND ref_id = $2`,
		`UPDATE work.content_reference SET object_version = 'v2'
		 WHERE org_id = $1 AND ref_id = $2`,
		`UPDATE work.content_reference SET content_hash = 'sha256:' || repeat('b', 64)
		 WHERE org_id = $1 AND ref_id = $2`,
		`DELETE FROM work.content_reference WHERE org_id = $1 AND ref_id = $2`,
	} {
		if _, err := testAdmin.Exec(ctx, statement, tn.org, reference.RefID); err == nil {
			t.Fatalf("mutation succeeded: %s", statement)
		}
	}
	if _, err := registry.Resolve(ctx, tn.org, reference.RefID); err != nil {
		t.Fatalf("reference should still be live: %v", err)
	}
	if changed, err := registry.Tombstone(ctx, tn.org, reference.RefID, "retention_expired"); err != nil || !changed {
		t.Fatalf("tombstone: changed=%v err=%v", changed, err)
	}
	if _, err := testAdmin.Exec(ctx, `
		UPDATE work.content_reference SET tombstoned_at = now()
		WHERE org_id = $1 AND ref_id = $2`, tn.org, reference.RefID,
	); err == nil {
		t.Fatal("tombstoned row was updated again")
	} else if code := pgMessageCode(t, err); code != "content_reference_tombstone_immutable" {
		t.Fatalf("tombstone update code = %q", code)
	}
}

func TestCrossTenantAndMissingOrgContextRejected(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tenantA := seedTenant(t, "org_contentref_tenant_a")
	tenantB := seedTenant(t, "org_contentref_tenant_b")
	registry := contentref.NewRegistry(testPool)
	reference := tenantReference(t, tenantA, contentref.KindInput, "input:"+newUUID(t))
	if err := registry.Register(ctx, reference); err != nil {
		t.Fatalf("register: %v", err)
	}

	if _, err := registry.Resolve(ctx, tenantB.org, reference.RefID); !errors.Is(err, contentref.ErrNotFound) {
		t.Fatalf("cross-tenant resolve = %v, want ErrNotFound", err)
	}
	if _, err := registry.Tombstone(ctx, tenantB.org, reference.RefID, "tenant_cleanup"); !errors.Is(err, contentref.ErrNotFound) {
		t.Fatalf("cross-tenant tombstone = %v, want ErrNotFound", err)
	}

	foreign := workerConn(t, tenantB.org)
	_, err := foreign.Exec(ctx, `SELECT work.resolve_content_reference($1, $2)`,
		tenantA.org, reference.RefID)
	if err == nil {
		t.Fatal("function accepted a foreign org context")
	}
	if code := pgMessageCode(t, err); code != "runtime_org_context_mismatch" {
		t.Fatalf("foreign context code = %q", code)
	}

	missing := workerConnWithoutContext(t)
	_, err = missing.Exec(ctx, `SELECT work.resolve_content_reference($1, $2)`,
		tenantA.org, reference.RefID)
	if err == nil {
		t.Fatal("function accepted a missing org context")
	}
	if code := pgMessageCode(t, err); code != "runtime_org_context_mismatch" {
		t.Fatalf("missing context code = %q", code)
	}

	refID := newUUID(t)
	_, err = foreign.Exec(ctx, `
		SELECT work.register_content_reference(
		  $1, $2, $3, $4, $5, 'input', 'input:' || $6, 'v1',
		  'objects/foreign', 'sha256:' || repeat('a', 64), 1, 'control_plane')`,
		tenantA.org, refID, tenantA.taskID, tenantA.runID, nil, refID,
	)
	if err == nil {
		t.Fatal("register accepted a foreign org context")
	}
	if code := pgMessageCode(t, err); code != "runtime_org_context_mismatch" {
		t.Fatalf("foreign register code = %q", code)
	}

	reserveRefID := newUUID(t)
	_, err = foreign.Exec(ctx, `
		SELECT work.reserve_content_slot($1, $2, $3, 'checkpoint_candidate', $4)`,
		tenantA.org, reserveRefID, tenantA.execID, "checkpoint:foreign:"+reserveRefID[:8],
	)
	if err == nil {
		t.Fatal("reserve accepted a foreign org context")
	}
	if code := pgMessageCode(t, err); code != "runtime_org_context_mismatch" {
		t.Fatalf("foreign reserve code = %q", code)
	}

	_, err = foreign.Exec(ctx, `
		SELECT work.commit_content_slot($1, $2, 'objects/foreign', $3, 1)`,
		tenantA.org, reserveRefID, hashFor("a"),
	)
	if err == nil {
		t.Fatal("commit accepted a foreign org context")
	}
	if code := pgMessageCode(t, err); code != "runtime_org_context_mismatch" {
		t.Fatalf("foreign commit code = %q", code)
	}

	if err := registry.Reserve(ctx, tenantB.org, newUUID(t), tenantA.execID,
		contentref.KindCheckpointCandidate, "checkpoint:cross:"+reserveRefID[:8]); err == nil {
		t.Fatal("reserve accepted another organization's execution")
	} else if code := errorCode(t, err); code != "runtime_execution_not_found" {
		t.Fatalf("cross-tenant execution code = %q", code)
	}

	_, err = missing.Exec(ctx, `
		SELECT work.reserve_content_slot($1, $2, $3, 'checkpoint_candidate', $4)`,
		tenantA.org, reserveRefID, tenantA.execID, "checkpoint:missing:"+reserveRefID[:8],
	)
	if err == nil {
		t.Fatal("reserve accepted a missing org context")
	}
	if code := pgMessageCode(t, err); code != "runtime_org_context_mismatch" {
		t.Fatalf("missing context reserve code = %q", code)
	}
	_, err = missing.Exec(ctx, `
		SELECT work.commit_content_slot($1, $2, 'objects/missing', $3, 1)`,
		tenantA.org, reserveRefID, hashFor("a"),
	)
	if err == nil {
		t.Fatal("commit accepted a missing org context")
	}
	if code := pgMessageCode(t, err); code != "runtime_org_context_mismatch" {
		t.Fatalf("missing context commit code = %q", code)
	}
}

func TestWorkAPIHasNoExecuteAndNoTableDML(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)

	for _, privilege := range []string{"SELECT", "INSERT", "UPDATE", "DELETE"} {
		var allowed bool
		if err := testAdmin.QueryRow(ctx,
			`SELECT has_table_privilege('work_api', 'work.content_reference', $1)`,
			privilege,
		).Scan(&allowed); err != nil {
			t.Fatal(err)
		}
		if allowed {
			t.Fatalf("work_api has %s on work.content_reference", privilege)
		}
	}
	for _, signature := range []string{
		"work.register_content_reference(text, uuid, uuid, uuid, uuid, text, text, text, text, text, bigint, text)",
		"work.resolve_content_reference(text, uuid)",
		"work.tombstone_content_reference(text, uuid, text)",
		"work.reserve_content_slot(text, uuid, uuid, text, text)",
		"work.commit_content_slot(text, uuid, text, text, bigint)",
	} {
		var allowed bool
		if err := testAdmin.QueryRow(ctx,
			`SELECT has_function_privilege('work_api', $1, 'EXECUTE')`, signature,
		).Scan(&allowed); err != nil {
			t.Fatal(err)
		}
		if allowed {
			t.Fatalf("work_api can execute %s", signature)
		}
		if err := testAdmin.QueryRow(ctx,
			`SELECT has_function_privilege('work_worker', $1, 'EXECUTE')`, signature,
		).Scan(&allowed); err != nil {
			t.Fatal(err)
		}
		if !allowed {
			t.Fatalf("work_worker cannot execute %s", signature)
		}
	}

	api, err := pgx.Connect(ctx, testpg.AppURL(testDB))
	if err != nil {
		t.Fatal(err)
	}
	defer api.Close(context.Background())
	if _, err := api.Exec(ctx, `
		INSERT INTO work.content_reference
		  (ref_id, org_id, kind, logical_slot, object_version, content_ref,
		   content_hash, bytes, writer_kind)
		VALUES (gen_random_uuid(), 'org_api', 'input', 'input:api', 'v1',
		        'objects/api', 'sha256:' || repeat('a', 64), 1, 'control_plane')`,
	); err == nil {
		t.Fatal("work_api inserted a content reference")
	} else if pgMessageCode(t, err) != "permission_denied" {
		t.Fatalf("work_api insert code = %q", pgMessageCode(t, err))
	}
	if _, err := api.Exec(ctx,
		`SELECT work.resolve_content_reference('org_api', $1)`, newUUID(t),
	); err == nil {
		t.Fatal("work_api executed resolve_content_reference")
	} else if pgMessageCode(t, err) != "permission_denied" {
		t.Fatalf("work_api execute code = %q", pgMessageCode(t, err))
	}
}

func TestTenantPolicyHidesOtherOrganizations(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	tenantA := seedTenant(t, "org_contentref_rls_a")
	tenantB := seedTenant(t, "org_contentref_rls_b")
	registry := contentref.NewRegistry(testPool)
	for _, tn := range []tenant{tenantA, tenantB} {
		if err := registry.Register(ctx, tenantReference(t, tn, contentref.KindInput,
			"input:"+newUUID(t))); err != nil {
			t.Fatalf("register %s: %v", tn.org, err)
		}
	}

	conn, err := pgx.Connect(ctx, testpg.MigratorURL(testDB))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, `SET ROLE work_owner`); err != nil {
		t.Fatal(err)
	}
	for _, tn := range []tenant{tenantA, tenantB} {
		if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', $1, false)`, tn.org); err != nil {
			t.Fatal(err)
		}
		rows, err := conn.Query(ctx, `SELECT org_id FROM work.content_reference`)
		if err != nil {
			t.Fatal(err)
		}
		seen := 0
		for rows.Next() {
			var org string
			if err := rows.Scan(&org); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			if org != tn.org {
				rows.Close()
				t.Fatalf("org %s saw row from %s", tn.org, org)
			}
			seen++
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		rows.Close()
		if seen == 0 {
			t.Fatalf("org %s saw no rows", tn.org)
		}
	}
}

func TestApplyThroughLatestAndManifestChecksums(t *testing.T) {
	requireDB(t)
	manifest, err := migrate.LoadManifest(embedded.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Increments) != 14 {
		t.Fatalf("increments = %d, want 14", len(manifest.Increments))
	}
	last := manifest.Increments[len(manifest.Increments)-1]
	if last.Version != 16 || last.Name != "0016_reconcile_rejected_receipt" {
		t.Fatalf("last increment = %d/%s", last.Version, last.Name)
	}
	body, err := fs.ReadFile(embedded.FS, last.File)
	if err != nil {
		t.Fatal(err)
	}
	if sum := fmt.Sprintf("sha256:%x", sha256.Sum256(body)); sum != last.Checksum {
		t.Fatalf("latest checksum = %s, manifest pins %s", sum, last.Checksum)
	}
	catalogBody, err := fs.ReadFile(embedded.FS, last.Catalog)
	if err != nil {
		t.Fatal(err)
	}
	if sum := fmt.Sprintf("sha256:%x", sha256.Sum256(catalogBody)); sum != last.CatalogChecksum {
		t.Fatalf("0013 catalog checksum = %s, manifest pins %s", sum, last.CatalogChecksum)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	name := fmt.Sprintf("work_contentref_migrate_%d_%d", os.Getpid(), time.Now().UnixNano())
	if len(name) > 63 {
		name = name[:63]
	}
	if _, err := testAdmin.Exec(ctx,
		"CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" OWNER work_owner"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		_ = testpg.DropDatabase(cleanupCtx, testAdmin, name)
	})
	runner, err := migrate.New(migrate.Config{
		DatabaseURL:            testpg.MigratorURL(name),
		Migrations:             embedded.FS,
		Root:                   ".",
		LegacyMigratorDisabled: true,
		LockTimeout:            10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := runner.Apply(ctx)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if result.State != "applied" {
		t.Fatalf("apply state = %q", result.State)
	}
	if got := ledgerVersions(t, name); len(got) != 16 {
		t.Fatalf("ledger versions = %v", got)
	} else {
		for index, version := range got {
			if version != int64(index+1) {
				t.Fatalf("ledger versions = %v", got)
			}
		}
	}
	again, err := runner.Apply(ctx)
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if again.State != "up_to_date" {
		t.Fatalf("second apply state = %q", again.State)
	}
}

func ledgerVersions(t *testing.T, dbName string) []int64 {
	t.Helper()
	ctx := testContext(t)
	conn, err := pgx.Connect(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, `SELECT version FROM work.schema_migration ORDER BY version`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var versions []int64
	for rows.Next() {
		var version int64
		if err := rows.Scan(&version); err != nil {
			t.Fatal(err)
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return versions
}
