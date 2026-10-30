package finishing

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/receipt"
	"github.com/we-meet/work/internal/testpg"
)

var (
	testAdmin   *pgx.Conn
	testDB      string
	testPool    *pgxpool.Pool
	testContent *content.Local
)

func TestMain(m *testing.M) {
	if os.Getenv("WORK_TEST_PG_URL") == "" {
		os.Exit(m.Run())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
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
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_finishing_test")
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
	directory, err := os.MkdirTemp("", "work-finishing-content-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "create content directory: %v\n", err)
		os.Exit(1)
	}
	store, err := content.NewLocal(bytes.Repeat([]byte{0x42}, 32), directory, 1)
	if err != nil {
		fmt.Fprintf(os.Stderr, "create content store: %v\n", err)
		os.Exit(1)
	}

	testAdmin, testDB, testPool, testContent = dbAdmin, dbName, pool, store
	code := m.Run()

	pool.Close()
	_ = os.RemoveAll(directory)
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cleanupCancel()
	_ = dbAdmin.Close(cleanupCtx)
	_ = testpg.DropDatabase(cleanupCtx, admin, dbName)
	_ = admin.Close(cleanupCtx)
	os.Exit(code)
}

func requireDB(t *testing.T) {
	t.Helper()
	if testAdmin == nil || testPool == nil || testContent == nil {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func connect(t *testing.T, databaseURL string) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(testContext(t), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func execRaw(ctx context.Context, conn *pgx.Conn, sql string) error {
	results, err := conn.PgConn().Exec(ctx, sql).ReadAll()
	if err != nil {
		return err
	}
	for _, result := range results {
		if result.Err != nil {
			return result.Err
		}
	}
	return nil
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

func quoteLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func testHash(seed string) string {
	return "sha256:" + strings.Repeat(seed, 64)[:64]
}

type fixture struct {
	org        string
	subject    string
	inputID    string
	taskID     string
	runID      string
	snapshotID string
	opID       string
	attemptID  string
	planExec   string
	execID     string
	holder     string
	slot       string
	headRef    string
	headHash   string
	intentRef  string
	intentHash string
	requestDoc canonical.ModelRequest
	fence      int64
}

func newFixture(t *testing.T, org string) *fixture {
	t.Helper()
	requireDB(t)
	ctx := testContext(t)
	fx := &fixture{
		org:        org,
		subject:    "sub_" + org,
		inputID:    newUUID(t),
		taskID:     newUUID(t),
		runID:      newUUID(t),
		snapshotID: newUUID(t),
		opID:       newUUID(t),
		planExec:   newUUID(t),
		execID:     newUUID(t),
		holder:     "holder-" + newUUID(t),
		slot:       newUUID(t),
		headRef:    "cp/0/" + org,
		headHash:   testHash("d"),
		fence:      1,
	}
	fx.requestDoc = canonical.ModelRequest{
		Binding: canonical.Binding{
			OrgID:          org,
			TaskID:         fx.taskID,
			RunID:          fx.runID,
			SnapshotID:     fx.snapshotID,
			RuntimeVersion: "pi-1",
		},
		LogicalKey: canonical.LogicalKey1,
		Input: canonical.Reference{
			RefID: newUUID(t),
			Hash:  testHash("a"),
		},
		Route: canonical.Route{
			Provider:             canonical.ProviderAliyun,
			Model:                "qwen-test",
			ConfigRevision:       "1",
			CompatProfileVersion: "v1",
		},
		Parameters: canonical.Parameters{
			MaxOutputTokens:  1024,
			TemperatureMilli: 500,
			OutputFormat:     canonical.OutputFormatMarkdown,
		},
	}
	requestHash, err := fx.requestDoc.Hash()
	if err != nil {
		t.Fatal(err)
	}

	sql := fmt.Sprintf(`
		SET app.org_id = %[1]s;
		INSERT INTO work.org (id, status, home_region) VALUES (%[1]s, 'active', 'cn-north');
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES (%[1]s, %[2]s, 'active', 'owner', true);
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%[3]s', %[1]s, %[2]s, 'input/%[3]s', repeat('a', 64), 12);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, input_id, title)
		VALUES ('%[4]s', %[1]s, %[2]s, 'open', '%[3]s', 'finishing task');
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		VALUES ('%[5]s', %[1]s, '%[4]s', 'v1', repeat('b', 64),
		        ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		UPDATE work.task SET snapshot_id = '%[5]s' WHERE id = '%[4]s';
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('%[6]s', %[1]s, '%[4]s', 1, 'queued', '%[5]s', 'run:%[6]s', 'pi-1');
		UPDATE work.task SET active_run_id = '%[6]s', latest_run_id = '%[6]s' WHERE id = '%[4]s';
	`, quoteLiteral(org), quoteLiteral(fx.subject), fx.inputID, fx.taskID,
		fx.snapshotID, fx.runID)
	if err := execRaw(ctx, testAdmin, sql); err != nil {
		t.Fatal(err)
	}

	body, err := fx.requestDoc.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	ref, err := testContent.Put(ctx, org, body)
	if err != nil {
		t.Fatal(err)
	}
	fx.intentRef = ref.ContentRef
	fx.intentHash = requestHash
	return fx
}

func (fx *fixture) worker(t *testing.T) *pgx.Conn {
	t.Helper()
	conn := connect(t, testpg.WorkerURL(testDB))
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	if _, err := conn.Exec(testContext(t),
		`SELECT set_config('app.org_id', $1, false)`, fx.org); err != nil {
		t.Fatal(err)
	}
	return conn
}

// prepare builds the full graph up to an active execute fragment and returns
// the worker connection used for the domain commands.
func (fx *fixture) prepare(t *testing.T) *pgx.Conn {
	t.Helper()
	ctx := testContext(t)
	worker := fx.worker(t)

	// The Run is seeded queued; acquiring it is the domain transition that
	// makes it current and bumps the fence every later command must present.
	if err := worker.QueryRow(ctx, `SELECT fence FROM work.acquire_run($1, $2)`,
		fx.runID, fx.org).Scan(&fx.fence); err != nil {
		t.Fatal(err)
	}
	// The operation trigger requires the Run to be active and current, so the
	// operation is seeded after the acquiring transition.
	if _, err := testAdmin.Exec(ctx, `
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state)
		VALUES ($1, $2, $3, 'model:1', 'model', $4, 'authorized')`,
		fx.opID, fx.org, fx.runID, fx.intentHash); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.Exec(ctx, `
		SELECT work.reserve_quota($1, 'default', to_char(now(), 'YYYY-MM'), $2, 1000)`,
		fx.org, fx.opID); err != nil {
		t.Fatal(err)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_dispatch($1, $2, 'consumer-1', $3)::text`,
		fx.opID, fx.org, fx.fence).Scan(&fx.attemptID); err != nil {
		t.Fatal(err)
	}
	if fx.attemptID == "" {
		t.Fatal("claim_dispatch returned no attempt")
	}
	var state string
	if err := worker.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'plan', $4, 'pi-1', now() + interval '10 minutes')`,
		fx.org, fx.planExec, fx.runID, fx.fence).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		fx.org, fx.planExec, fx.holder+"-plan").Scan(&state); err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := worker.QueryRow(ctx,
		`SELECT work.commit_runtime_checkpoint($1, $2, $3, NULL, NULL, NULL, $4, $5, 'pi-1')`,
		fx.org, fx.runID, fx.planExec, fx.headRef, fx.headHash).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision != 0 {
		t.Fatalf("first head revision = %d, want 0", revision)
	}

	requestHash, err := fx.requestDoc.Hash()
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'execute', $4, 'pi-1', now() + interval '10 minutes',
			$5, $6, $7, $8, $9, $10, $11)`,
		fx.org, fx.execID, fx.runID, fx.fence, fx.headRef, fx.headHash, fx.intentRef,
		fx.intentHash, requestHash, fx.opID, fx.attemptID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		fx.org, fx.execID, fx.holder).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return worker
}

func (fx *fixture) consume(t *testing.T, worker *pgx.Conn) {
	t.Helper()
	requestHash, err := fx.requestDoc.Hash()
	if err != nil {
		t.Fatal(err)
	}
	var body []byte
	if err := worker.QueryRow(testContext(t), `
		SELECT work.consume_dispatch_delivery(
			$1, $2, $3, $4, $5, $6, $7, 'gw-1', $8)`,
		fx.org, fx.opID, fx.execID, fx.holder, fx.attemptID, requestHash, fx.fence, fx.slot,
	).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(`"won"`)) {
		t.Fatalf("consume outcome = %s", body)
	}
}

func (fx *fixture) seal(t *testing.T, worker *pgx.Conn) {
	t.Helper()
	var body []byte
	if err := worker.QueryRow(testContext(t), `
		SELECT work.seal_dispatch_not_sent($1, $2, 'cancel_requested', $3)`,
		fx.org, fx.opID, fx.execID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(`"sealed"`)) {
		t.Fatalf("seal outcome = %s", body)
	}
}

func (fx *fixture) storeReceipt(t *testing.T, document canonical.ModelReceipt) (string, string) {
	t.Helper()
	body, err := document.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	ref, err := testContent.Put(testContext(t), fx.org, body)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := document.Hash()
	if err != nil {
		t.Fatal(err)
	}
	return ref.ContentRef, hash
}

func (fx *fixture) attachRaw(t *testing.T, worker *pgx.Conn, receiptRef, receiptHash, result string) {
	t.Helper()
	var body []byte
	if err := worker.QueryRow(testContext(t), `
		SELECT work.attach_dispatch_receipt($1, $2, $3, $4, $5, $6, 'provider-req-1', 'gw-1')`,
		fx.org, fx.opID, fx.slot, receiptRef, receiptHash, result,
	).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(`"recorded"`)) {
		t.Fatalf("attach outcome = %s", body)
	}
}

func (fx *fixture) attach(t *testing.T, worker *pgx.Conn, document canonical.ModelReceipt) {
	t.Helper()
	receiptRef, receiptHash := fx.storeReceipt(t, document)
	result := "success"
	if document.Outcome == canonical.OutcomeRejectedNotExec {
		result = "rejected_not_executed"
	}
	fx.attachRaw(t, worker, receiptRef, receiptHash, result)
}

func (fx *fixture) succeededReceipt(t *testing.T) canonical.ModelReceipt {
	return canonical.ModelReceipt{
		ReceiptID:         newUUID(t),
		Binding:           fx.requestDoc.Binding,
		LogicalKey:        canonical.LogicalKey1,
		OperationID:       fx.opID,
		DispatchAttemptID: fx.attemptID,
		ExecutionID:       fx.execID,
		RequestHash:       fx.intentHash,
		WriterGatewayID:   newUUID(t),
		RecordedAtUnixMs:  1_800_000_000_000, // 2027-01-15T08:00:00Z
		Outcome:           canonical.OutcomeSucceeded,
		ProviderRequestID: canonical.String("provider-req-1"),
		Content: canonical.Ref(canonical.Reference{
			RefID: newUUID(t),
			Hash:  testHash("b"),
		}),
		ContentBytes: 32,
		Usage: canonical.Usage{
			Source:            canonical.UsageProvider,
			InputTokens:       canonical.Int64(100),
			OutputTokens:      canonical.Int64(50),
			CachedInputTokens: canonical.Int64(0),
		},
	}
}

func queryString(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var value string
	if err := testAdmin.QueryRow(testContext(t), sql, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func queryInt(t *testing.T, sql string, args ...any) int64 {
	t.Helper()
	var value int64
	if err := testAdmin.QueryRow(testContext(t), sql, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func newFinisher() *Finisher {
	return &Finisher{
		Pool:    testPool,
		Content: testContent,
		// A recovery day far from the receipt's recorded day proves the usage
		// date comes from the receipt, not from the wall clock.
		Now: func() time.Time { return time.Date(2030, 6, 1, 12, 0, 0, 0, time.UTC) },
	}
}

func TestFinishSucceededReceiptAdvancesAndSettles(t *testing.T) {
	fx := newFixture(t, "fin_success")
	worker := fx.prepare(t)
	fx.consume(t, worker)
	document := fx.succeededReceipt(t)
	fx.attach(t, worker, document)

	out, err := newFinisher().FinishFromReceipt(testContext(t), fx.org, fx.opID)
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != StatusConfirmed {
		t.Fatalf("status = %q, want %q", out.Status, StatusConfirmed)
	}
	if out.UsageSource != string(canonical.UsageProvider) {
		t.Fatalf("usage source = %q", out.UsageSource)
	}
	if out.SettlementTokens == nil || *out.SettlementTokens != 150 {
		t.Fatalf("settlement tokens = %v, want 150", out.SettlementTokens)
	}
	if out.ReceiptHash == "" {
		t.Fatal("receipt hash is empty")
	}
	if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "succeeded" {
		t.Fatalf("operation state = %q, want succeeded", got)
	}
	if got := queryString(t,
		`SELECT state FROM work.quota_reservation WHERE org_id = $1 AND operation_id = $2`,
		fx.org, fx.opID); got != "settled" {
		t.Fatalf("reservation state = %q, want settled", got)
	}
	if got := queryInt(t,
		`SELECT settled_tokens FROM work.quota_reservation WHERE org_id = $1 AND operation_id = $2`,
		fx.org, fx.opID); got != 150 {
		t.Fatalf("settled tokens = %d, want 150", got)
	}
	if got := queryInt(t,
		`SELECT reserved_tokens FROM work.quota_account WHERE org_id = $1`, fx.org); got != 0 {
		t.Fatalf("reserved account tokens = %d, want 0", got)
	}
	if got := queryInt(t,
		`SELECT input_tokens FROM work.usage_daily WHERE org_id = $1`, fx.org); got != 100 {
		t.Fatalf("usage_daily input = %d, want 100", got)
	}
	if got := queryInt(t,
		`SELECT output_tokens FROM work.usage_daily WHERE org_id = $1`, fx.org); got != 50 {
		t.Fatalf("usage_daily output = %d, want 50", got)
	}
	if got := queryInt(t,
		`SELECT run_count FROM work.usage_daily WHERE org_id = $1`, fx.org); got != 1 {
		t.Fatalf("usage_daily run_count = %d, want 1", got)
	}
	if got := queryString(t,
		`SELECT usage_date::text FROM work.usage_daily WHERE org_id = $1`, fx.org); got != "2027-01-15" {
		t.Fatalf("usage date = %q, want the receipt's UTC day 2027-01-15", got)
	}
	if got := queryInt(t, `
		SELECT count(*) FROM work.operation_usage_fact
		 WHERE org_id = $1 AND operation_id = $2
		   AND usage_source = 'provider' AND counted_in_usage_daily`,
		fx.org, fx.opID); got != 1 {
		t.Fatalf("counted usage facts = %d, want 1", got)
	}
}

func TestFinishIsIdempotentAndDoesNotDoubleCountUsage(t *testing.T) {
	fx := newFixture(t, "fin_idempotent")
	worker := fx.prepare(t)
	fx.consume(t, worker)
	fx.attach(t, worker, fx.succeededReceipt(t))

	finisher := newFinisher()
	first, err := finisher.FinishFromReceipt(testContext(t), fx.org, fx.opID)
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != StatusConfirmed {
		t.Fatalf("first status = %q", first.Status)
	}
	second, err := finisher.FinishFromReceipt(testContext(t), fx.org, fx.opID)
	if err != nil {
		t.Fatal(err)
	}
	if second.Status != StatusAlreadyConfirmed {
		t.Fatalf("second status = %q, want %q", second.Status, StatusAlreadyConfirmed)
	}
	if got := queryInt(t,
		`SELECT input_tokens FROM work.usage_daily WHERE org_id = $1`, fx.org); got != 100 {
		t.Fatalf("usage_daily input after replay = %d, want 100", got)
	}
	if got := queryInt(t,
		`SELECT output_tokens FROM work.usage_daily WHERE org_id = $1`, fx.org); got != 50 {
		t.Fatalf("usage_daily output after replay = %d, want 50", got)
	}
	if got := queryInt(t,
		`SELECT run_count FROM work.usage_daily WHERE org_id = $1`, fx.org); got != 1 {
		t.Fatalf("usage_daily run_count after replay = %d, want 1", got)
	}
	if got := queryInt(t,
		`SELECT count(*) FROM work.operation_usage_fact WHERE org_id = $1`, fx.org); got != 1 {
		t.Fatalf("usage facts after replay = %d, want 1", got)
	}
	if got := queryInt(t, `
		SELECT count(*) FROM work.quota_entry
		 WHERE org_id = $1 AND kind = 'settle'`, fx.org); got != 1 {
		t.Fatalf("settle entries after replay = %d, want 1", got)
	}
}

func TestUnavailableUsageKeepsReservationHeld(t *testing.T) {
	fx := newFixture(t, "fin_unavailable")
	worker := fx.prepare(t)
	fx.consume(t, worker)
	document := fx.succeededReceipt(t)
	document.Usage = canonical.Usage{Source: canonical.UsageUnavailable}
	fx.attach(t, worker, document)

	out, err := newFinisher().FinishFromReceipt(testContext(t), fx.org, fx.opID)
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != StatusUsageUnavailable {
		t.Fatalf("status = %q, want %q", out.Status, StatusUsageUnavailable)
	}
	if out.SettlementTokens != nil {
		t.Fatalf("settlement tokens = %v, want nil", *out.SettlementTokens)
	}
	if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "succeeded" {
		t.Fatalf("operation state = %q, want succeeded", got)
	}
	if got := queryString(t,
		`SELECT state FROM work.quota_reservation WHERE org_id = $1 AND operation_id = $2`,
		fx.org, fx.opID); got != "held" {
		t.Fatalf("reservation state = %q, want held", got)
	}
	if got := queryInt(t,
		`SELECT count(*) FROM work.usage_daily WHERE org_id = $1`, fx.org); got != 0 {
		t.Fatalf("usage_daily rows = %d, want 0", got)
	}
	if got := queryInt(t, `
		SELECT count(*) FROM work.operation_usage_fact
		 WHERE org_id = $1 AND usage_source = 'unavailable'
		   AND input_tokens IS NULL AND output_tokens IS NULL
		   AND cached_input_tokens IS NULL AND NOT counted_in_usage_daily`,
		fx.org); got != 1 {
		t.Fatalf("unavailable usage facts = %d, want 1", got)
	}
}

func TestConsumedGateWithoutReceiptIsRejected(t *testing.T) {
	fx := newFixture(t, "fin_consumed")
	worker := fx.prepare(t)
	fx.consume(t, worker)

	_, err := newFinisher().FinishFromReceipt(testContext(t), fx.org, fx.opID)
	if !errors.Is(err, ErrReceiptNotAttached) {
		t.Fatalf("error = %v, want ErrReceiptNotAttached", err)
	}
	if got := queryString(t, `SELECT gate_state FROM work.dispatch_delivery WHERE org_id = $1`, fx.org); got != "consumed" {
		t.Fatalf("gate state = %q, want consumed", got)
	}
	if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "dispatching" {
		t.Fatalf("operation state = %q, want dispatching", got)
	}
	if got := queryInt(t,
		`SELECT count(*) FROM work.operation_usage_fact WHERE org_id = $1`, fx.org); got != 0 {
		t.Fatalf("usage facts = %d, want 0", got)
	}
	if got := queryString(t,
		`SELECT state FROM work.quota_reservation WHERE org_id = $1 AND operation_id = $2`,
		fx.org, fx.opID); got != "held" {
		t.Fatalf("reservation state = %q, want held", got)
	}
}

func TestSealedNotSentIsRejected(t *testing.T) {
	fx := newFixture(t, "fin_sealed")
	worker := fx.prepare(t)
	fx.seal(t, worker)

	_, err := newFinisher().FinishFromReceipt(testContext(t), fx.org, fx.opID)
	if !errors.Is(err, ErrSealedNotSent) {
		t.Fatalf("error = %v, want ErrSealedNotSent", err)
	}
	if got := queryString(t, `SELECT gate_state FROM work.dispatch_delivery WHERE org_id = $1`, fx.org); got != "sealed_not_sent" {
		t.Fatalf("gate state = %q, want sealed_not_sent", got)
	}
	if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "dispatching" {
		t.Fatalf("operation state = %q, want dispatching", got)
	}
	if got := queryInt(t,
		`SELECT count(*) FROM work.operation_usage_fact WHERE org_id = $1`, fx.org); got != 0 {
		t.Fatalf("usage facts = %d, want 0", got)
	}
}

func TestTamperedReceiptBodyIsAHashError(t *testing.T) {
	fx := newFixture(t, "fin_tamper")
	worker := fx.prepare(t)
	fx.consume(t, worker)
	bound := fx.succeededReceipt(t)
	tampered := bound
	tampered.RecordedAtUnixMs++
	tampered.Usage.InputTokens = canonical.Int64(101)
	tamperedRef, _ := fx.storeReceipt(t, tampered)
	boundHash, err := bound.Hash()
	if err != nil {
		t.Fatal(err)
	}
	// The gate is bound to the first document's hash but the stored object is
	// the tampered document.
	fx.attachRaw(t, worker, tamperedRef, boundHash, "success")

	_, err = newFinisher().FinishFromReceipt(testContext(t), fx.org, fx.opID)
	if !errors.Is(err, receipt.ErrHashMismatch) {
		t.Fatalf("error = %v, want receipt.ErrHashMismatch", err)
	}
	if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "dispatching" {
		t.Fatalf("operation state = %q, want dispatching", got)
	}
	if got := queryInt(t,
		`SELECT count(*) FROM work.operation_usage_fact WHERE org_id = $1`, fx.org); got != 0 {
		t.Fatalf("usage facts = %d, want 0", got)
	}
}

func TestReceiptBindingIsEnforced(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(t *testing.T, document *canonical.ModelReceipt)
	}{
		{"operation", func(t *testing.T, document *canonical.ModelReceipt) {
			document.OperationID = newUUID(t)
		}},
		{"attempt", func(t *testing.T, document *canonical.ModelReceipt) {
			document.DispatchAttemptID = newUUID(t)
		}},
		{"execution", func(t *testing.T, document *canonical.ModelReceipt) {
			document.ExecutionID = newUUID(t)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newFixture(t, "fin_bind_"+tc.name)
			worker := fx.prepare(t)
			fx.consume(t, worker)
			document := fx.succeededReceipt(t)
			tc.mutate(t, &document)
			fx.attach(t, worker, document)

			_, err := newFinisher().FinishFromReceipt(testContext(t), fx.org, fx.opID)
			if !errors.Is(err, receipt.ErrBindingMismatch) {
				t.Fatalf("error = %v, want receipt.ErrBindingMismatch", err)
			}
			if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "dispatching" {
				t.Fatalf("operation state = %q, want dispatching", got)
			}
			if got := queryInt(t,
				`SELECT count(*) FROM work.operation_usage_fact WHERE org_id = $1`, fx.org); got != 0 {
				t.Fatalf("usage facts = %d, want 0", got)
			}
		})
	}
}

func TestDispatchingRejectedReceiptRequiresAbort(t *testing.T) {
	fx := newFixture(t, "fin_rejected")
	worker := fx.prepare(t)
	fx.consume(t, worker)
	document := fx.succeededReceipt(t)
	document.Outcome = canonical.OutcomeRejectedNotExec
	document.ProviderRequestID = nil
	document.Content = nil
	document.ContentBytes = 0
	document.RejectionEvidence = canonical.Ref(canonical.Reference{
		RefID: newUUID(t),
		Hash:  testHash("c"),
	})
	document.Usage = canonical.Usage{
		Source:            canonical.UsageProvider,
		InputTokens:       canonical.Int64(0),
		OutputTokens:      canonical.Int64(0),
		CachedInputTokens: canonical.Int64(0),
	}
	fx.attach(t, worker, document)

	_, err := newFinisher().FinishFromReceipt(testContext(t), fx.org, fx.opID)
	if !errors.Is(err, ErrRejectedNotReconcilable) {
		t.Fatalf("error = %v, want ErrRejectedNotReconcilable", err)
	}
	if got := queryString(t,
		`SELECT gate_state || ':' || receipt_result FROM work.dispatch_delivery WHERE org_id = $1`,
		fx.org); got != "receipt_recorded:rejected_not_executed" {
		t.Fatalf("gate = %q, want the rejected receipt untouched", got)
	}
	if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "dispatching" {
		t.Fatalf("operation state = %q, want dispatching", got)
	}
	if got := queryInt(t,
		`SELECT count(*) FROM work.operation_usage_fact WHERE org_id = $1`, fx.org); got != 0 {
		t.Fatalf("usage facts = %d, want 0", got)
	}
	if got := queryInt(t, `
		SELECT count(*) FROM work.audit_event
		 WHERE org_id = $1 AND action = 'operation.finish_from_receipt'`, fx.org); got != 0 {
		t.Fatalf("finish audits = %d, want 0", got)
	}
}

func (fx *fixture) rejectedReceipt(t *testing.T) canonical.ModelReceipt {
	document := fx.succeededReceipt(t)
	document.Outcome = canonical.OutcomeRejectedNotExec
	document.Content = nil
	document.ContentBytes = 0
	document.RejectionEvidence = canonical.Ref(canonical.Reference{RefID: newUUID(t), Hash: testHash("c")})
	document.Usage = canonical.Usage{
		Source: canonical.UsageProvider, InputTokens: canonical.Int64(0),
		OutputTokens: canonical.Int64(0), CachedInputTokens: canonical.Int64(0),
	}
	return document
}

func TestRejectedReceiptReconcilesWithoutUsage(t *testing.T) {
	for _, state := range []string{"unknown", "unresolved"} {
		for _, reservation := range []string{"held", "unknown"} {
			t.Run(state+"_"+reservation, func(t *testing.T) {
				fx := newFixture(t, "fin_rej_"+state+"_"+reservation)
				worker := fx.prepare(t)
				fx.consume(t, worker)
				fx.attach(t, worker, fx.rejectedReceipt(t))
				ctx := testContext(t)
				if _, err := worker.Exec(ctx, `SELECT work.mark_operation_unknown($1, $2, 'provider_unknown')`, fx.org, fx.opID); err != nil {
					t.Fatal(err)
				}
				if state == "unresolved" {
					if _, err := worker.Exec(ctx, `SELECT work.reconcile_operation($1, $2, 'unresolved')`, fx.org, fx.opID); err != nil {
						t.Fatal(err)
					}
				}
				if reservation == "unknown" {
					if _, err := testAdmin.Exec(ctx, `UPDATE work.quota_reservation SET state = 'unknown' WHERE operation_id = $1`, fx.opID); err != nil {
						t.Fatal(err)
					}
				}
				for replay := 0; replay < 2; replay++ {
					out, err := newFinisher().FinishFromReceipt(ctx, fx.org, fx.opID)
					if err != nil {
						t.Fatal(err)
					}
					if out.Status != StatusRejected || out.SettlementTokens == nil || *out.SettlementTokens != 0 || out.ReceiptHash == "" {
						t.Fatalf("outcome = %+v", out)
					}
				}
				if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "reconciled" {
					t.Fatalf("operation = %s", got)
				}
				want := "released"
				if reservation == "unknown" {
					want = "settled"
				}
				if got := queryString(t, `SELECT state FROM work.quota_reservation WHERE operation_id = $1`, fx.opID); got != want {
					t.Fatalf("reservation = %s, want %s", got, want)
				}
				for _, sql := range []string{
					`SELECT reserved_tokens FROM work.quota_account WHERE org_id = $1`,
					`SELECT settled_tokens FROM work.quota_account WHERE org_id = $1`,
					`SELECT count(*) FROM work.operation_usage_fact WHERE org_id = $1`,
					`SELECT count(*) FROM work.usage_daily WHERE org_id = $1`,
					`SELECT count(*) FROM work.artifact WHERE org_id = $1`,
				} {
					if got := queryInt(t, sql, fx.org); got != 0 {
						t.Fatalf("%s = %d, want 0", sql, got)
					}
				}
				if got := queryInt(t, `SELECT count(*) FROM work.quota_entry WHERE org_id = $1 AND kind IN ('settle', 'release')`, fx.org); got != 1 {
					t.Fatalf("close entries = %d", got)
				}
				if got := queryInt(t, `SELECT count(*) FROM work.audit_event WHERE org_id = $1 AND action = 'operation.reconcile' AND metadata->>'resolution' = 'rejected_not_executed'`, fx.org); got != 1 {
					t.Fatalf("rejection audits = %d", got)
				}
			})
		}
	}
}

func TestReconcileRejectionRejectsInvalidEvidence(t *testing.T) {
	cases := []struct {
		name, gate, evidence, want string
		tokens                     any
	}{
		{"missing_gate", "missing", "evidence", "dispatch_gate_not_found", int64(0)},
		{"consumed", "consumed", "evidence", "dispatch_receipt_not_bound", int64(0)},
		{"sealed", "sealed", "evidence", "dispatch_receipt_not_bound", int64(0)},
		{"success", "success", "bound", "dispatch_receipt_not_rejection", int64(0)},
		{"mismatch", "rejection", "wrong", "rejection_evidence_mismatch", int64(0)},
		{"nonzero", "rejection", "bound", "rejected_receipt_requires_zero_settlement", int64(1)},
		{"null_tokens", "rejection", "bound", "rejected_receipt_requires_zero_settlement", nil},
		{"empty_evidence", "rejection", "", "reconciliation_evidence_required", int64(0)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newFixture(t, "fin_rej_bad_"+tc.name)
			worker := fx.prepare(t)
			if tc.gate == "sealed" {
				fx.seal(t, worker)
			} else if tc.gate != "missing" {
				fx.consume(t, worker)
			}
			if tc.gate == "success" {
				fx.attach(t, worker, fx.succeededReceipt(t))
			} else if tc.gate == "rejection" {
				fx.attach(t, worker, fx.rejectedReceipt(t))
			}
			ctx := testContext(t)
			if _, err := worker.Exec(ctx, `SELECT work.mark_operation_unknown($1, $2, 'provider_unknown')`, fx.org, fx.opID); err != nil {
				t.Fatal(err)
			}
			evidence := tc.evidence
			if evidence == "bound" {
				evidence = queryString(t, `SELECT receipt_ref FROM work.dispatch_delivery WHERE operation_id = $1`, fx.opID)
			}
			_, err := worker.Exec(ctx, `SELECT work.reconcile_operation($1, $2, 'rejected_not_executed', NULL, $3, $4)`, fx.org, fx.opID, tc.tokens, evidence)
			var pgErr interface{ SQLState() string }
			if err == nil || !errors.As(err, &pgErr) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %s", err, tc.want)
			}
			if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "unknown" {
				t.Fatalf("operation = %s", got)
			}
			if got := queryString(t, `SELECT state FROM work.quota_reservation WHERE operation_id = $1`, fx.opID); got != "held" {
				t.Fatalf("reservation = %s", got)
			}
		})
	}
}

func TestRejectedReceiptValidatesSnapshotBindingBeforeReconcile(t *testing.T) {
	fx := newFixture(t, "fin_rej_binding")
	worker := fx.prepare(t)
	fx.consume(t, worker)
	document := fx.rejectedReceipt(t)
	document.Binding.SnapshotID = newUUID(t)
	fx.attach(t, worker, document)
	if _, err := worker.Exec(testContext(t), `SELECT work.mark_operation_unknown($1, $2, 'provider_unknown')`, fx.org, fx.opID); err != nil {
		t.Fatal(err)
	}
	_, err := newFinisher().FinishFromReceipt(testContext(t), fx.org, fx.opID)
	if !errors.Is(err, receipt.ErrBindingMismatch) {
		t.Fatalf("error = %v, want binding mismatch", err)
	}
	if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "unknown" {
		t.Fatalf("operation = %s", got)
	}
}

func TestReconcileRejectionPreservesUsageAndChecksReplayEvidence(t *testing.T) {
	fx := newFixture(t, "fin_rej_conflict")
	worker := fx.prepare(t)
	fx.consume(t, worker)
	fx.attach(t, worker, fx.rejectedReceipt(t))
	ctx := testContext(t)
	if _, err := worker.Exec(ctx, `SELECT work.mark_operation_unknown($1, $2, 'provider_unknown')`, fx.org, fx.opID); err != nil {
		t.Fatal(err)
	}
	if _, err := testAdmin.Exec(ctx, `INSERT INTO work.operation_usage_fact (org_id, operation_id, usage_revision, origin, counted_in_usage_daily) VALUES ($1, $2, 1, 'legacy_marker_backfill', true)`, fx.org, fx.opID); err != nil {
		t.Fatal(err)
	}
	_, err := newFinisher().FinishFromReceipt(ctx, fx.org, fx.opID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Message != "rejection_usage_conflict" {
		t.Fatalf("error = %v, want usage conflict", err)
	}
	if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "unknown" {
		t.Fatalf("operation = %s", got)
	}
	if got := queryInt(t, `SELECT count(*) FROM work.operation_usage_fact WHERE operation_id = $1 AND counted_in_usage_daily`, fx.opID); got != 1 {
		t.Fatalf("usage facts = %d", got)
	}
	if got := queryString(t, `SELECT state FROM work.quota_reservation WHERE operation_id = $1`, fx.opID); got != "held" {
		t.Fatalf("reservation = %s", got)
	}

	clean := newFixture(t, "fin_rej_replay")
	cleanWorker := clean.prepare(t)
	clean.consume(t, cleanWorker)
	clean.attach(t, cleanWorker, clean.rejectedReceipt(t))
	if _, err := cleanWorker.Exec(ctx, `SELECT work.mark_operation_unknown($1, $2, 'provider_unknown')`, clean.org, clean.opID); err != nil {
		t.Fatal(err)
	}
	if _, err := newFinisher().FinishFromReceipt(ctx, clean.org, clean.opID); err != nil {
		t.Fatal(err)
	}
	_, err = cleanWorker.Exec(ctx, `SELECT work.reconcile_operation($1, $2, 'rejected_not_executed', NULL, 0, 'wrong')`, clean.org, clean.opID)
	if err == nil || !strings.Contains(err.Error(), "rejection_evidence_mismatch") {
		t.Fatalf("replay error = %v", err)
	}
	if _, err := cleanWorker.Exec(ctx, `SELECT set_config('app.org_id', 'other_tenant', false)`); err != nil {
		t.Fatal(err)
	}
	_, err = cleanWorker.Exec(ctx, `SELECT work.reconcile_operation($1, $2, 'rejected_not_executed', NULL, 0, 'wrong')`, clean.org, clean.opID)
	if err == nil || !strings.Contains(err.Error(), "runtime_org_context_mismatch") {
		t.Fatalf("cross-org error = %v", err)
	}
}

func TestReconcileRejectionRetainsDefinerAndMinimalPrivileges(t *testing.T) {
	requireDB(t)
	if got := queryInt(t, `SELECT count(*) FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
		WHERE p.oid = 'work.reconcile_operation(text,uuid,text,text,bigint,text)'::regprocedure
		AND p.prosecdef AND r.rolname = 'work_owner' AND p.proconfig @> ARRAY['search_path=work, pg_catalog']`); got != 1 {
		t.Fatal("reconcile command lost its execution identity")
	}
	if got := queryInt(t, `SELECT has_function_privilege('work_worker', 'work.reconcile_operation(text,uuid,text,text,bigint,text)', 'EXECUTE')::int`); got != 1 {
		t.Fatal("worker cannot execute reconcile")
	}
	if got := queryInt(t, `SELECT has_function_privilege('work_api', 'work.reconcile_operation(text,uuid,text,text,bigint,text)', 'EXECUTE')::int`); got != 0 {
		t.Fatal("API can execute reconcile")
	}
	if got := queryInt(t, `SELECT has_table_privilege('work_worker', 'work.dispatch_delivery', 'UPDATE')::int`); got != 0 {
		t.Fatal("worker has direct gate update privilege")
	}
}

func TestConcurrentRejectedReceiptReconcilesOnce(t *testing.T) {
	fx := newFixture(t, "fin_rej_concurrent")
	worker := fx.prepare(t)
	fx.consume(t, worker)
	fx.attach(t, worker, fx.rejectedReceipt(t))
	ctx := testContext(t)
	if _, err := worker.Exec(ctx, `SELECT work.mark_operation_unknown($1, $2, 'provider_unknown')`, fx.org, fx.opID); err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			out, err := newFinisher().FinishFromReceipt(ctx, fx.org, fx.opID)
			if err == nil && out.Status != StatusRejected {
				err = fmt.Errorf("unexpected status %s", out.Status)
			}
			errs <- err
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := queryInt(t, `SELECT count(*) FROM work.quota_entry WHERE org_id = $1 AND kind = 'release'`, fx.org); got != 1 {
		t.Fatalf("release entries = %d", got)
	}
	if got := queryInt(t, `SELECT count(*) FROM work.audit_event WHERE org_id = $1 AND action = 'operation.reconcile'`, fx.org); got != 1 {
		t.Fatalf("reconcile audits = %d", got)
	}
}

func TestReconcileRejectionDoesNotReverseSettlement(t *testing.T) {
	fx := newFixture(t, "fin_rej_settled")
	worker := fx.prepare(t)
	fx.consume(t, worker)
	fx.attach(t, worker, fx.rejectedReceipt(t))
	ctx := testContext(t)
	if _, err := worker.Exec(ctx, `SELECT work.mark_operation_unknown($1, $2, 'provider_unknown')`, fx.org, fx.opID); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.Exec(ctx, `SELECT work.settle_quota(id, 3, '{}'::jsonb, 1) FROM work.quota_reservation WHERE operation_id = $1`, fx.opID); err != nil {
		t.Fatal(err)
	}
	_, err := newFinisher().FinishFromReceipt(ctx, fx.org, fx.opID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Message != "rejection_usage_conflict" {
		t.Fatalf("error = %v, want usage conflict", err)
	}
	if got := queryInt(t, `SELECT settled_tokens FROM work.quota_account WHERE org_id = $1`, fx.org); got != 3 {
		t.Fatalf("settled tokens = %d", got)
	}
	if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "unknown" {
		t.Fatalf("operation = %s", got)
	}
}

func TestCrossOrgCannotReadAnotherTenantsGate(t *testing.T) {
	fx := newFixture(t, "fin_tenant_a")
	worker := fx.prepare(t)
	fx.consume(t, worker)
	fx.attach(t, worker, fx.succeededReceipt(t))

	other := "fin_tenant_b"
	if err := execRaw(testContext(t), testAdmin, fmt.Sprintf(
		`INSERT INTO work.org (id, status, home_region) VALUES (%s, 'active', 'cn-north')`,
		quoteLiteral(other))); err != nil {
		t.Fatal(err)
	}

	_, err := newFinisher().FinishFromReceipt(testContext(t), other, fx.opID)
	if !errors.Is(err, ErrGateNotFound) {
		t.Fatalf("error = %v, want ErrGateNotFound", err)
	}
	if got := queryString(t, `SELECT gate_state FROM work.dispatch_delivery WHERE org_id = $1`, fx.org); got != "receipt_recorded" {
		t.Fatalf("owner gate state = %q, want receipt_recorded", got)
	}
	if got := queryString(t, `SELECT state FROM work.operation WHERE id = $1`, fx.opID); got != "dispatching" {
		t.Fatalf("operation state = %q, want dispatching", got)
	}
	if got := queryInt(t,
		`SELECT count(*) FROM work.operation_usage_fact WHERE org_id = $1`, fx.org); got != 0 {
		t.Fatalf("usage facts = %d, want 0", got)
	}
}

// TestConcurrentFinishersSettleOnce exercises the 0009 locks with independent
// connections: one recovery confirms, the rest observe the confirmed state,
// and usage is counted exactly once.
func TestConcurrentFinishersSettleOnce(t *testing.T) {
	fx := newFixture(t, "fin_concurrent")
	worker := fx.prepare(t)
	fx.consume(t, worker)
	fx.attach(t, worker, fx.succeededReceipt(t))

	const recoveries = 4
	ctx := testContext(t)
	statuses := make(chan string, recoveries)
	errs := make(chan error, recoveries)
	var wait sync.WaitGroup
	for index := 0; index < recoveries; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			out, err := newFinisher().FinishFromReceipt(ctx, fx.org, fx.opID)
			if err != nil {
				errs <- err
				return
			}
			statuses <- out.Status
		}()
	}
	wait.Wait()
	close(statuses)
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent recovery failed: %v", err)
	}
	counts := map[string]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[StatusConfirmed] != 1 || counts[StatusAlreadyConfirmed] != recoveries-1 {
		t.Fatalf("statuses = %#v, want 1 confirmed and %d already_confirmed", counts, recoveries-1)
	}
	if got := queryInt(t, `SELECT input_tokens FROM work.usage_daily WHERE org_id = $1`, fx.org); got != 100 {
		t.Fatalf("usage_daily input = %d, want the single receipt's 100", got)
	}
	if got := queryInt(t, `
		SELECT count(*) FROM work.operation_usage_fact
		 WHERE org_id = $1 AND operation_id = $2 AND counted_in_usage_daily`,
		fx.org, fx.opID); got != 1 {
		t.Fatalf("counted usage facts = %d, want 1", got)
	}
}
