package execbinding_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	"github.com/we-meet/work/internal/execbinding"
	"github.com/we-meet/work/internal/testpg"
)

// These tests exercise internal/execbinding against a real PostgreSQL and a
// real local Content Store. Seed rows are written with the admin connection;
// Bind runs all domain reads/writes as work_worker with an explicit tenant
// context, so grants and RLS are part of the assertion.

var (
	testAdmin *pgx.Conn
	testDB    string
	testPool  *pgxpool.Pool
	testStore *content.Local
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
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_execbinding_test")
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
	contentDir, err := os.MkdirTemp("", "work-execbinding-test-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "create content directory: %v\n", err)
		os.Exit(1)
	}
	store, err := content.NewLocal([]byte(strings.Repeat("k", 32)), contentDir, 1)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open content store: %v\n", err)
		os.Exit(1)
	}
	testAdmin, testDB, testPool, testStore = dbAdmin, dbName, pool, store

	code := m.Run()

	pool.Close()
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cleanupCancel()
	_ = dbAdmin.Close(cleanupCtx)
	_ = testpg.DropDatabase(cleanupCtx, admin, dbName)
	_ = admin.Close(cleanupCtx)
	_ = os.RemoveAll(contentDir)
	os.Exit(code)
}

func requireDB(t *testing.T) {
	t.Helper()
	if testAdmin == nil || testPool == nil || testStore == nil {
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

func quote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func digestOf(body []byte) string {
	sum := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(sum[:])
}

type templateEntry struct {
	body []byte
	hash string
}

type fakeTemplates map[string]templateEntry

func (f fakeTemplates) Lookup(id string, version int) ([]byte, string, bool) {
	entry, ok := f[fmt.Sprintf("%s@%d", id, version)]
	if !ok {
		return nil, "", false
	}
	return entry.body, entry.hash, true
}

type fixture struct {
	org             string
	subject         string
	taskID          string
	runID           string
	snapshotID      string
	inputID         string
	execID          string
	object          content.Ref
	inputBody       []byte
	templateID      string
	templateVersion int
	templateBody    []byte
	templateHash    string
}

// seedFixture builds the minimal graph Bind reads: an org whose policy is
// auto-provisioned by the trigger, an input_object backed by real bytes in the
// Content Store, a task, a snapshot manifest naming the template, a Run bound
// to that snapshot, and a registered plan execution. storedInputHash overrides
// the input_object hash to model tampered bytes.
func seedFixture(t *testing.T, org, storedInputHash string) *fixture {
	t.Helper()
	ctx := testContext(t)
	f := &fixture{
		org:             org,
		subject:         "sub_" + org,
		taskID:          newUUID(t),
		runID:           newUUID(t),
		snapshotID:      newUUID(t),
		inputID:         newUUID(t),
		execID:          newUUID(t),
		inputBody:       []byte(`{"goal":"summarise the meeting","background":"notes"}`),
		templateID:      "summary",
		templateVersion: 1,
		templateBody:    []byte(`{"template":"summary","system":"You summarise meeting notes."}`),
	}
	f.templateHash = digestOf(f.templateBody)
	object, err := testStore.Put(ctx, org, f.inputBody)
	if err != nil {
		t.Fatalf("put input content: %v", err)
	}
	f.object = object
	if storedInputHash == "" {
		storedInputHash = object.Hash
	}
	seed := fmt.Sprintf(`
		SET app.org_id = %[1]s;
		INSERT INTO work.org (id, status, home_region)
		VALUES (%[1]s, 'active', 'cn-north');
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES (%[1]s, %[2]s, 'active', 'owner', true)
		ON CONFLICT (org_id, subject_id) DO NOTHING;
		INSERT INTO work.input_object
		  (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%[3]s', %[1]s, %[2]s, %[8]s, %[9]s, %[10]d);
		INSERT INTO work.task
		  (id, org_id, owner_subject_id, state, input_id, title)
		VALUES ('%[4]s', %[1]s, %[2]s, 'open', '%[3]s', 'execbinding task');
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		VALUES ('%[5]s', %[1]s, '%[4]s', 'v1', repeat('b', 64),
		        ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb,
		        '{"template":{"id":"summary","version":1}}'::jsonb);
		UPDATE work.task SET snapshot_id = '%[5]s' WHERE id = '%[4]s';
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id,
		   runtime_version)
		VALUES ('%[6]s', %[1]s, '%[4]s', 1, 'active', '%[5]s', 'run:%[6]s', 'pi-1');
		UPDATE work.task SET active_run_id = '%[6]s', latest_run_id = '%[6]s'
		WHERE id = '%[4]s';
		INSERT INTO work.runtime_execution
		  (execution_id, org_id, task_id, run_id, mode, run_fence,
		   runtime_version, state, hard_deadline)
		VALUES ('%[7]s', %[1]s, '%[4]s', '%[6]s', 'plan', 1, 'pi-1',
		        'registered', now() + interval '1 hour');
	`, quote(f.org), quote(f.subject), f.inputID, f.taskID, f.snapshotID,
		f.runID, f.execID, quote(object.ContentRef), quote(storedInputHash),
		object.Bytes)
	if _, err := testAdmin.Exec(ctx, seed); err != nil {
		t.Fatalf("seed fixture: %v", err)
	}
	return f
}

// addExecution attaches a second Run (attempt 2) and a registered execution to
// the same task/snapshot/input, modelling a separate fragment.
func addExecution(t *testing.T, f *fixture, attempt int) (string, string) {
	t.Helper()
	runID := newUUID(t)
	execID := newUUID(t)
	seed := fmt.Sprintf(`
		SET app.org_id = %[1]s;
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id,
		   runtime_version)
		VALUES ('%[2]s', %[1]s, '%[3]s', %[4]d, 'failed', '%[5]s',
		        'run:%[2]s', 'pi-1');
		INSERT INTO work.runtime_execution
		  (execution_id, org_id, task_id, run_id, mode, run_fence,
		   runtime_version, state, hard_deadline)
		VALUES ('%[6]s', %[1]s, '%[3]s', '%[2]s', 'plan', 1, 'pi-1',
		        'registered', now() + interval '1 hour');
	`, quote(f.org), runID, f.taskID, attempt, f.snapshotID, execID)
	if _, err := testAdmin.Exec(testContext(t), seed); err != nil {
		t.Fatalf("add execution: %v", err)
	}
	return runID, execID
}

func newBinder(t *testing.T, entries map[string]templateEntry) *execbinding.Binder {
	t.Helper()
	return &execbinding.Binder{
		Pool:      testPool,
		Content:   testStore,
		Templates: fakeTemplates(entries),
	}
}

func entryFor(f *fixture) map[string]templateEntry {
	return map[string]templateEntry{
		fmt.Sprintf("%s@%d", f.templateID, f.templateVersion): {
			body: f.templateBody,
			hash: f.templateHash,
		},
	}
}

func countRefs(t *testing.T, org string) int {
	t.Helper()
	var count int
	if err := testAdmin.QueryRow(testContext(t),
		`SELECT count(*) FROM work.content_reference WHERE org_id = $1`, org,
	).Scan(&count); err != nil {
		t.Fatalf("count references: %v", err)
	}
	return count
}

func errorCode(t *testing.T, err error) string {
	t.Helper()
	var bindingErr *execbinding.Error
	if !errors.As(err, &bindingErr) {
		t.Fatalf("error = %v, want an execbinding enumeration error", err)
	}
	return bindingErr.Code
}

func assertBoundRef(t *testing.T, ref contentref.Reference, f *fixture,
	kind contentref.Kind, slot, executionID string,
) {
	t.Helper()
	if ref.OrgID != f.org {
		t.Fatalf("org = %q, want %q", ref.OrgID, f.org)
	}
	if ref.TaskID != f.taskID {
		t.Fatalf("task = %q, want %q", ref.TaskID, f.taskID)
	}
	if ref.RunID != f.runID {
		t.Fatalf("run = %q, want %q", ref.RunID, f.runID)
	}
	if ref.ExecutionID != executionID {
		t.Fatalf("execution = %q, want %q", ref.ExecutionID, executionID)
	}
	if ref.Kind != kind {
		t.Fatalf("kind = %q, want %q", ref.Kind, kind)
	}
	if ref.LogicalSlot != slot {
		t.Fatalf("slot = %q, want %q", ref.LogicalSlot, slot)
	}
	if ref.ObjectVersion != "v1" {
		t.Fatalf("object version = %q, want v1", ref.ObjectVersion)
	}
	if ref.WriterKind != contentref.WriterControlPlane {
		t.Fatalf("writer = %q, want control_plane", ref.WriterKind)
	}
	if ref.SlotState != contentref.SlotCommitted {
		t.Fatalf("slot state = %q, want committed", ref.SlotState)
	}
	if !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(ref.RefID) {
		t.Fatalf("ref id = %q, want a UUID", ref.RefID)
	}
}

func proxyAllows(ref contentref.Reference, executionID string) bool {
	return ref.ExecutionID == executionID
}

func TestBindMaterialisesExecutionBoundRefsIdempotently(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	f := seedFixture(t, "org_execbinding_idempotent", "")
	binder := newBinder(t, entryFor(f))

	inputSlot := "input:" + f.execID + ":" + f.inputID
	templateSlot := fmt.Sprintf("template:%s:%s:%d", f.execID, f.templateID, f.templateVersion)

	first, err := binder.Bind(ctx, f.org, f.execID)
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	assertBoundRef(t, first.InputRef, f, contentref.KindInput, inputSlot, f.execID)
	assertBoundRef(t, first.TemplateRef, f, contentref.KindTemplate, templateSlot, f.execID)
	if first.InputRef.ContentRef != f.object.ContentRef ||
		first.InputRef.ContentHash != f.object.Hash ||
		first.InputRef.Bytes != f.object.Bytes {
		t.Fatalf("input ref does not carry the verified object: %+v", first.InputRef)
	}
	if first.TemplateRef.ContentHash != f.templateHash ||
		first.TemplateRef.Bytes != int64(len(f.templateBody)) {
		t.Fatalf("template ref does not carry the frozen template: %+v", first.TemplateRef)
	}
	if got := countRefs(t, f.org); got != 2 {
		t.Fatalf("references after first bind = %d, want 2", got)
	}

	second, err := binder.Bind(ctx, f.org, f.execID)
	if err != nil {
		t.Fatalf("replay bind: %v", err)
	}
	if second.InputRef.RefID != first.InputRef.RefID {
		t.Fatalf("input ref id changed on replay: %q -> %q",
			first.InputRef.RefID, second.InputRef.RefID)
	}
	if second.TemplateRef.RefID != first.TemplateRef.RefID {
		t.Fatalf("template ref id changed on replay: %q -> %q",
			first.TemplateRef.RefID, second.TemplateRef.RefID)
	}
	if second.TemplateRef.ContentRef != first.TemplateRef.ContentRef {
		t.Fatalf("template object changed on replay: %q -> %q",
			first.TemplateRef.ContentRef, second.TemplateRef.ContentRef)
	}
	if got := countRefs(t, f.org); got != 2 {
		t.Fatalf("references after replay = %d, want 2 (no new rows)", got)
	}

	registry := contentref.NewRegistry(testPool)
	resolvedInput, err := registry.Resolve(ctx, f.org, first.InputRef.RefID)
	if err != nil {
		t.Fatalf("resolve input: %v", err)
	}
	assertBoundRef(t, resolvedInput, f, contentref.KindInput, inputSlot, f.execID)
	resolvedTemplate, err := registry.Resolve(ctx, f.org, first.TemplateRef.RefID)
	if err != nil {
		t.Fatalf("resolve template: %v", err)
	}
	assertBoundRef(t, resolvedTemplate, f, contentref.KindTemplate, templateSlot, f.execID)
}

func TestBindKeepsExecutionsIsolated(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	f := seedFixture(t, "org_execbinding_isolated", "")
	binder := newBinder(t, entryFor(f))

	first, err := binder.Bind(ctx, f.org, f.execID)
	if err != nil {
		t.Fatalf("bind first execution: %v", err)
	}
	_, secondExec := addExecution(t, f, 2)
	second, err := binder.Bind(ctx, f.org, secondExec)
	if err != nil {
		t.Fatalf("bind second execution: %v", err)
	}
	if first.InputRef.RefID == second.InputRef.RefID ||
		first.TemplateRef.RefID == second.TemplateRef.RefID {
		t.Fatal("two executions share a reference id")
	}
	if first.InputRef.LogicalSlot == second.InputRef.LogicalSlot {
		t.Fatal("two executions share an input slot")
	}
	if first.TemplateRef.LogicalSlot == second.TemplateRef.LogicalSlot {
		t.Fatal("two executions share a template slot")
	}
	if first.InputRef.ContentHash != second.InputRef.ContentHash ||
		first.TemplateRef.ContentHash != second.TemplateRef.ContentHash {
		t.Fatal("shared content objects should keep the same hashes")
	}
	if got := countRefs(t, f.org); got != 4 {
		t.Fatalf("references after two executions = %d, want 4", got)
	}

	registry := contentref.NewRegistry(testPool)
	firstInput, err := registry.Resolve(ctx, f.org, first.InputRef.RefID)
	if err != nil {
		t.Fatalf("resolve first input: %v", err)
	}
	firstTemplate, err := registry.Resolve(ctx, f.org, first.TemplateRef.RefID)
	if err != nil {
		t.Fatalf("resolve first template: %v", err)
	}
	secondInput, err := registry.Resolve(ctx, f.org, second.InputRef.RefID)
	if err != nil {
		t.Fatalf("resolve second input: %v", err)
	}
	secondTemplate, err := registry.Resolve(ctx, f.org, second.TemplateRef.RefID)
	if err != nil {
		t.Fatalf("resolve second template: %v", err)
	}
	if firstInput.ExecutionID != f.execID || firstTemplate.ExecutionID != f.execID {
		t.Fatalf("first execution refs = %q/%q, want %q",
			firstInput.ExecutionID, firstTemplate.ExecutionID, f.execID)
	}
	if secondInput.ExecutionID != secondExec || secondTemplate.ExecutionID != secondExec {
		t.Fatalf("second execution refs = %q/%q, want %q",
			secondInput.ExecutionID, secondTemplate.ExecutionID, secondExec)
	}

	// The content proxy's single rule: a ref is readable only when its
	// ExecutionID equals the presented execution.
	for _, ref := range []contentref.Reference{firstInput, firstTemplate} {
		if !proxyAllows(ref, f.execID) {
			t.Fatalf("first execution should read its own ref %q", ref.RefID)
		}
		if proxyAllows(ref, secondExec) {
			t.Fatalf("second execution resolved first execution ref %q", ref.RefID)
		}
	}
	for _, ref := range []contentref.Reference{secondInput, secondTemplate} {
		if !proxyAllows(ref, secondExec) {
			t.Fatalf("second execution should read its own ref %q", ref.RefID)
		}
		if proxyAllows(ref, f.execID) {
			t.Fatalf("first execution resolved second execution ref %q", ref.RefID)
		}
	}
}

func TestBindRefusesTamperedInputBeforeWriting(t *testing.T) {
	requireDB(t)
	f := seedFixture(t, "org_execbinding_tampered",
		digestOf([]byte("different bytes")))
	_, err := newBinder(t, entryFor(f)).Bind(testContext(t), f.org, f.execID)
	if code := errorCode(t, err); code != execbinding.CodeInputHashMismatch {
		t.Fatalf("error code = %q, want %q", code, execbinding.CodeInputHashMismatch)
	}
	if got := countRefs(t, f.org); got != 0 {
		t.Fatalf("references after tampered input = %d, want 0", got)
	}
}

func TestBindRefusesMissingTemplate(t *testing.T) {
	requireDB(t)
	f := seedFixture(t, "org_execbinding_missing_template", "")
	_, err := newBinder(t, map[string]templateEntry{}).Bind(
		testContext(t), f.org, f.execID)
	if code := errorCode(t, err); code != execbinding.CodeTemplateNotFound {
		t.Fatalf("error code = %q, want %q", code, execbinding.CodeTemplateNotFound)
	}
	if got := countRefs(t, f.org); got != 0 {
		t.Fatalf("references after missing template = %d, want 0", got)
	}
}
