package intent_test

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	"github.com/we-meet/work/internal/execbinding"
	"github.com/we-meet/work/internal/intent"
	"github.com/we-meet/work/internal/testpg"
)

// These tests exercise internal/intent against a real PostgreSQL and a real
// local Content Store. Seed rows are written with the admin connection; Freeze
// runs its binding read, content-reference resolve and registration as
// work_worker with an explicit tenant context, so grants and RLS are part of
// the assertion.

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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
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
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_intent_test")
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
	contentDir, err := os.MkdirTemp("", "work-intent-test-")
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

func boundRef(t *testing.T, fill string) contentref.Reference {
	t.Helper()
	return contentref.Reference{
		RefID:       newUUID(t),
		ContentHash: "sha256:" + strings.Repeat(fill, 64),
	}
}

type fakeBindings struct {
	binding execbinding.Binding
	err     error
}

func (f fakeBindings) Bind(
	context.Context, string, string,
) (execbinding.Binding, error) {
	return f.binding, f.err
}

func newFreezer(t *testing.T, input, template contentref.Reference) *intent.Freezer {
	t.Helper()
	return &intent.Freezer{
		Pool:    testPool,
		Content: testStore,
		Bindings: fakeBindings{binding: execbinding.Binding{
			InputRef:    input,
			TemplateRef: template,
		}},
	}
}

func testRoute() canonical.Route {
	return canonical.Route{
		Provider:             canonical.ProviderAliyun,
		Model:                "qwen-text",
		ConfigRevision:       "1",
		CompatProfileVersion: "v1",
	}
}

func testParameters() canonical.Parameters {
	return canonical.Parameters{
		MaxOutputTokens:  2048,
		TemperatureMilli: 500,
		OutputFormat:     canonical.OutputFormatMarkdown,
	}
}

type fixture struct {
	org, subject, taskID, runID, snapshotID, inputID, execID string
}

// seedPlanExecution builds the minimal graph Freeze reads: an org with its
// auto-provisioned policy, an input object, a Task, a capability snapshot, an
// active Run bound to it, and a registered plan execution. A plan execution
// carries no operation by construction (runtime_execution_plan_binding).
func seedPlanExecution(t *testing.T, org string) *fixture {
	t.Helper()
	f := &fixture{
		org:        org,
		subject:    "sub_" + org,
		taskID:     newUUID(t),
		runID:      newUUID(t),
		snapshotID: newUUID(t),
		inputID:    newUUID(t),
		execID:     newUUID(t),
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
		VALUES ('%[3]s', %[1]s, %[2]s, 'content://work/seed/object?v=1',
		        'sha256:%[8]s', 1);
		INSERT INTO work.task
		  (id, org_id, owner_subject_id, state, input_id, title)
		VALUES ('%[4]s', %[1]s, %[2]s, 'open', '%[3]s', 'intent task');
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
		f.runID, f.execID, strings.Repeat("a", 64))
	if _, err := testAdmin.Exec(testContext(t), seed); err != nil {
		t.Fatalf("seed fixture: %v", err)
	}
	return f
}

func countSlotRows(t *testing.T, org, slot string) int {
	t.Helper()
	var count int
	if err := testAdmin.QueryRow(testContext(t),
		`SELECT count(*) FROM work.content_reference
		 WHERE org_id = $1 AND logical_slot = $2`, org, slot,
	).Scan(&count); err != nil {
		t.Fatalf("count references: %v", err)
	}
	return count
}

func intentCode(t *testing.T, err error) string {
	t.Helper()
	var intentErr *intent.Error
	if !errors.As(err, &intentErr) {
		t.Fatalf("error = %v, want an intent enumeration error", err)
	}
	return intentErr.Code
}

func TestFreezeProducesVerifiableExecutionBoundDocument(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	f := seedPlanExecution(t, "org_intent_document")
	input := boundRef(t, "a")
	template := boundRef(t, "b")
	route := testRoute()
	parameters := testParameters()

	ref, err := newFreezer(t, input, template).Freeze(
		ctx, f.org, f.execID, "model:1", route, parameters, nil)
	if err != nil {
		t.Fatalf("freeze: %v", err)
	}
	if !canonical.ValidHash(ref.Hash) {
		t.Fatalf("reference hash = %q, want a lowercase sha256 digest", ref.Hash)
	}

	registry := contentref.NewRegistry(testPool)
	row, err := registry.Resolve(ctx, f.org, ref.RefID)
	if err != nil {
		t.Fatalf("resolve frozen reference: %v", err)
	}
	slot := "model-request:" + f.execID + ":model:1"
	if row.Kind != contentref.KindModelRequest {
		t.Fatalf("kind = %q, want %q", row.Kind, contentref.KindModelRequest)
	}
	if row.WriterKind != contentref.WriterControlPlane {
		t.Fatalf("writer = %q, want control_plane", row.WriterKind)
	}
	if row.ExecutionID != f.execID {
		t.Fatalf("execution = %q, want %q", row.ExecutionID, f.execID)
	}
	if row.OrgID != f.org || row.TaskID != f.taskID || row.RunID != f.runID {
		t.Fatalf("binding row = %+v, want org/task/run %s/%s/%s",
			row, f.org, f.taskID, f.runID)
	}
	if row.LogicalSlot != slot {
		t.Fatalf("slot = %q, want %q", row.LogicalSlot, slot)
	}
	if row.ObjectVersion != "v1" {
		t.Fatalf("object version = %q, want v1", row.ObjectVersion)
	}
	if row.SlotState != contentref.SlotCommitted {
		t.Fatalf("slot state = %q, want committed", row.SlotState)
	}
	if row.ContentHash != ref.Hash {
		t.Fatalf("registered hash = %q, want the returned document hash %q",
			row.ContentHash, ref.Hash)
	}

	raw, err := testStore.Get(ctx, f.org, row.ContentRef)
	if err != nil {
		t.Fatalf("read frozen content: %v", err)
	}
	if int64(len(raw)) != row.Bytes {
		t.Fatalf("stored bytes = %d, want %d", len(raw), row.Bytes)
	}
	document, err := canonical.ParseModelRequest(raw)
	if err != nil {
		t.Fatalf("parse stored model_request: %v", err)
	}
	wantBinding := canonical.Binding{
		OrgID:          f.org,
		TaskID:         f.taskID,
		RunID:          f.runID,
		SnapshotID:     f.snapshotID,
		RuntimeVersion: "pi-1",
	}
	if document.Binding != wantBinding {
		t.Fatalf("binding = %+v, want %+v", document.Binding, wantBinding)
	}
	if document.LogicalKey != canonical.LogicalKey1 {
		t.Fatalf("logical key = %q, want model:1", document.LogicalKey)
	}
	if document.Input != (canonical.Reference{RefID: input.RefID, Hash: input.ContentHash}) {
		t.Fatalf("input = %+v, want the execution-bound input", document.Input)
	}
	wantTemplate := canonical.Reference{RefID: template.RefID, Hash: template.ContentHash}
	if document.Template == nil || *document.Template != wantTemplate {
		t.Fatalf("template = %v, want %+v", document.Template, wantTemplate)
	}
	if len(document.PriorReceipts) != 0 {
		t.Fatalf("prior receipts = %d, want 0 for model:1", len(document.PriorReceipts))
	}
	if document.Route != route {
		t.Fatalf("route = %+v, want %+v", document.Route, route)
	}
	if document.Parameters != parameters {
		t.Fatalf("parameters = %+v, want %+v", document.Parameters, parameters)
	}

	hash, err := document.Hash()
	if err != nil {
		t.Fatalf("hash stored document: %v", err)
	}
	if hash != ref.Hash {
		t.Fatalf("document hash = %q, want the returned %q", hash, ref.Hash)
	}
	recomputed, err := canonical.HashDocumentBytes(raw)
	if err != nil {
		t.Fatalf("recompute stored bytes hash: %v", err)
	}
	if recomputed != ref.Hash {
		t.Fatalf("recomputed bytes hash = %q, want %q", recomputed, ref.Hash)
	}
	if err := canonical.VerifyReference(canonical.RefKindModelRequest, ref, raw); err != nil {
		t.Fatalf("verify stored reference: %v", err)
	}

	// The signed shape has exactly these fields; no base URL, credential, raw
	// messages, execution id, fence or timestamp may appear anywhere at top
	// level, and the binding carries no execution id either.
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatalf("decode stored document keys: %v", err)
	}
	wantKeys := []string{
		"kind", "schemaVersion", "binding", "logicalKey", "input", "template",
		"priorReceipts", "route", "parameters",
	}
	if len(top) != len(wantKeys) {
		t.Fatalf("document has %d top-level fields, want %d", len(top), len(wantKeys))
	}
	for _, key := range wantKeys {
		if _, ok := top[key]; !ok {
			t.Fatalf("document is missing %q", key)
		}
	}
	for _, key := range []string{
		"executionId", "executionID", "baseURL", "baseUrl", "messages", "fence",
		"createdAt", "recordedAtUnixMs", "credentialVersion",
	} {
		if _, ok := top[key]; ok {
			t.Fatalf("document leaked forbidden field %q", key)
		}
	}
	var bindingKeys map[string]json.RawMessage
	if err := json.Unmarshal(top["binding"], &bindingKeys); err != nil {
		t.Fatalf("decode binding keys: %v", err)
	}
	wantBindingKeys := []string{"orgId", "taskId", "runId", "snapshotId", "runtimeVersion"}
	if len(bindingKeys) != len(wantBindingKeys) {
		t.Fatalf("binding has %d fields, want %d", len(bindingKeys), len(wantBindingKeys))
	}
	for _, key := range wantBindingKeys {
		if _, ok := bindingKeys[key]; !ok {
			t.Fatalf("binding is missing %q", key)
		}
	}
}

func TestFreezeAcceptsPlanExecutionWithoutOperation(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	f := seedPlanExecution(t, "org_intent_plan")
	var operationID *string
	if err := testAdmin.QueryRow(ctx,
		`SELECT operation_id::text FROM work.runtime_execution
		 WHERE execution_id = $1`, f.execID,
	).Scan(&operationID); err != nil {
		t.Fatalf("read execution operation: %v", err)
	}
	if operationID != nil {
		t.Fatalf("plan execution operation = %q, want NULL", *operationID)
	}

	ref, err := newFreezer(t, boundRef(t, "a"), boundRef(t, "b")).Freeze(
		ctx, f.org, f.execID, "model:1", testRoute(), testParameters(), nil)
	if err != nil {
		t.Fatalf("freeze on plan execution: %v", err)
	}
	if !canonical.ValidHash(ref.Hash) {
		t.Fatalf("reference hash = %q, want a lowercase sha256 digest", ref.Hash)
	}
}

func TestFreezeReplayIsIdempotent(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	f := seedPlanExecution(t, "org_intent_replay")
	freezer := newFreezer(t, boundRef(t, "a"), boundRef(t, "b"))

	first, err := freezer.Freeze(
		ctx, f.org, f.execID, "model:1", testRoute(), testParameters(), nil)
	if err != nil {
		t.Fatalf("freeze: %v", err)
	}
	registry := contentref.NewRegistry(testPool)
	firstRow, err := registry.Resolve(ctx, f.org, first.RefID)
	if err != nil {
		t.Fatalf("resolve first reference: %v", err)
	}

	second, err := freezer.Freeze(
		ctx, f.org, f.execID, "model:1", testRoute(), testParameters(), nil)
	if err != nil {
		t.Fatalf("replay freeze: %v", err)
	}
	if second != first {
		t.Fatalf("replay reference = %+v, want the exact first %+v", second, first)
	}
	secondRow, err := registry.Resolve(ctx, f.org, second.RefID)
	if err != nil {
		t.Fatalf("resolve replay reference: %v", err)
	}
	if secondRow.ContentRef != firstRow.ContentRef {
		t.Fatalf("replay object = %q, want the first %q",
			secondRow.ContentRef, firstRow.ContentRef)
	}
	if got := countSlotRows(t, f.org, "model-request:"+f.execID+":model:1"); got != 1 {
		t.Fatalf("slot rows after replay = %d, want 1", got)
	}
}

func TestFreezeChangedParametersConflict(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	f := seedPlanExecution(t, "org_intent_conflict")
	freezer := newFreezer(t, boundRef(t, "a"), boundRef(t, "b"))

	first, err := freezer.Freeze(
		ctx, f.org, f.execID, "model:1", testRoute(), testParameters(), nil)
	if err != nil {
		t.Fatalf("freeze: %v", err)
	}
	changed := testParameters()
	changed.TemperatureMilli = 501
	if _, err := freezer.Freeze(
		ctx, f.org, f.execID, "model:1", testRoute(), changed, nil); err == nil {
		t.Fatal("freeze with different parameters did not conflict")
	} else if code := intentCode(t, err); code != intent.CodeConflict {
		t.Fatalf("error code = %q, want %q", code, intent.CodeConflict)
	} else if !errors.Is(err, intent.ErrConflict) {
		t.Fatalf("error %v is not the typed conflict", err)
	}

	if got := countSlotRows(t, f.org, "model-request:"+f.execID+":model:1"); got != 1 {
		t.Fatalf("slot rows after conflict = %d, want 1", got)
	}
	row, err := contentref.NewRegistry(testPool).Resolve(ctx, f.org, first.RefID)
	if err != nil {
		t.Fatalf("resolve first reference: %v", err)
	}
	if row.ContentHash != first.Hash {
		t.Fatalf("conflict overwrote the frozen hash: %q -> %q",
			first.Hash, row.ContentHash)
	}
}

func TestFreezePreservesPriorReceiptOrder(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	f := seedPlanExecution(t, "org_intent_prior")
	freezer := newFreezer(t, boundRef(t, "a"), boundRef(t, "b"))
	firstReceipt := canonical.Reference{
		RefID: newUUID(t),
		Hash:  "sha256:" + strings.Repeat("d", 64),
	}
	secondReceipt := canonical.Reference{
		RefID: newUUID(t),
		Hash:  "sha256:" + strings.Repeat("e", 64),
	}

	ref, err := freezer.Freeze(ctx, f.org, f.execID, "model:3", testRoute(),
		testParameters(), []canonical.Reference{firstReceipt, secondReceipt})
	if err != nil {
		t.Fatalf("freeze model:3: %v", err)
	}
	row, err := contentref.NewRegistry(testPool).Resolve(ctx, f.org, ref.RefID)
	if err != nil {
		t.Fatalf("resolve reference: %v", err)
	}
	raw, err := testStore.Get(ctx, f.org, row.ContentRef)
	if err != nil {
		t.Fatalf("read frozen content: %v", err)
	}
	document, err := canonical.ParseModelRequest(raw)
	if err != nil {
		t.Fatalf("parse stored model_request: %v", err)
	}
	if len(document.PriorReceipts) != 2 ||
		document.PriorReceipts[0] != firstReceipt ||
		document.PriorReceipts[1] != secondReceipt {
		t.Fatalf("prior receipts = %+v, want [%+v %+v] in that order",
			document.PriorReceipts, firstReceipt, secondReceipt)
	}

	if _, err := freezer.Freeze(ctx, f.org, f.execID, "model:3", testRoute(),
		testParameters(),
		[]canonical.Reference{secondReceipt, firstReceipt}); !errors.Is(err, intent.ErrConflict) {
		t.Fatalf("reordered prior receipts error = %v, want ErrConflict", err)
	}
}

func TestFreezeRefusesUnknownExecution(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	f := &fixture{org: "org_intent_unknown"}
	_, err := newFreezer(t, boundRef(t, "a"), boundRef(t, "b")).Freeze(
		ctx, f.org, newUUID(t), "model:1", testRoute(), testParameters(), nil)
	if code := intentCode(t, err); code != intent.CodeExecutionNotFound {
		t.Fatalf("error code = %q, want %q", code, intent.CodeExecutionNotFound)
	}
	if !errors.Is(err, intent.ErrExecutionNotFound) {
		t.Fatalf("error %v is not ErrExecutionNotFound", err)
	}
}

func TestFreezeReportsBindingFailureAsCode(t *testing.T) {
	requireDB(t)
	ctx := testContext(t)
	f := seedPlanExecution(t, "org_intent_binding")
	freezer := &intent.Freezer{
		Pool:     testPool,
		Content:  testStore,
		Bindings: fakeBindings{err: errors.New("input body must never be echoed")},
	}
	_, err := freezer.Freeze(ctx, f.org, f.execID, "model:1",
		testRoute(), testParameters(), nil)
	if code := intentCode(t, err); code != intent.CodeBindingsUnavailable {
		t.Fatalf("error code = %q, want %q", code, intent.CodeBindingsUnavailable)
	}
	if strings.Contains(err.Error(), "echoed") {
		t.Fatalf("error leaked a foreign message: %q", err.Error())
	}
	if got := countSlotRows(t, f.org, "model-request:"+f.execID+":model:1"); got != 0 {
		t.Fatalf("slot rows after binding failure = %d, want 0", got)
	}
}
