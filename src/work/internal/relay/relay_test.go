package relay_test

import (
	"context"
	"errors"
	"io"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/relay"
	"github.com/we-meet/work/internal/testpg"
)

func TestMain(m *testing.M) {
	if testpg.AdminURL() == "" {
		os.Exit(m.Run())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err == nil {
		err = testpg.EnsureFixtures(ctx, admin)
		_ = admin.Close(ctx)
	}
	cancel()
	if err != nil {
		log.Printf("prepare relay test fixtures: %v", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

const (
	relayOrg   = "org_relay"
	relayTask  = "61111111-1111-4111-8111-111111111111"
	relayRun   = "71111111-1111-4111-8111-111111111111"
	relayInput = "81111111-1111-4111-8111-111111111111"
	relaySnap  = "91111111-1111-4111-8111-111111111111"
)

func TestRelayStartsWorkflowAndAcknowledgesTaskEvent(t *testing.T) {
	pool, dbName := newRelayDB(t)
	seedRun(t, dbName)
	insertOutbox(t, dbName, "aaaaaaaa-1111-4111-8111-111111111111", relayOrg, "run", relayRun,
		`{"kind":"start_workflow","run_id":"`+relayRun+`","workflow_id":"run:`+relayRun+`"}`)
	insertOutbox(t, dbName, "aaaaaaaa-1111-4111-8111-222222222222", relayOrg, "task", relayTask,
		`{"kind":"task_event"}`)
	dispatcher := &fakeDispatcher{}
	service := newRelay(t, pool, dispatcher, &fakeStore{})

	n, err := service.Once(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 || len(dispatcher.starts) != 1 {
		t.Fatalf("events=%d starts=%#v", n, dispatcher.starts)
	}
	start := dispatcher.starts[0]
	if start.OrgID != relayOrg || start.RunID != relayRun || start.WorkflowID != "run:"+relayRun {
		t.Fatalf("start = %#v", start)
	}
	for _, eventID := range []string{
		"aaaaaaaa-1111-4111-8111-111111111111",
		"aaaaaaaa-1111-4111-8111-222222222222",
	} {
		assertDelivered(t, dbName, eventID)
	}
	if n, _ := service.Once(context.Background()); n != 0 {
		t.Fatalf("second pass claimed %d events", n)
	}
}

func TestRelayCancelsActiveRunAndSkipsTerminalRun(t *testing.T) {
	pool, dbName := newRelayDB(t)
	seedRun(t, dbName)
	insertOutbox(t, dbName, "bbbbbbbb-1111-4111-8111-111111111111", relayOrg, "run", relayRun,
		`{"kind":"cancel_signal","run_id":"`+relayRun+`"}`)
	dispatcher := &fakeDispatcher{}
	service := newRelay(t, pool, dispatcher, &fakeStore{})
	if _, err := service.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(dispatcher.signals) != 1 || dispatcher.signals[0].workflowID != "run:"+relayRun ||
		dispatcher.signals[0].name != "cancel" {
		t.Fatalf("signals = %#v", dispatcher.signals)
	}
	assertDelivered(t, dbName, "bbbbbbbb-1111-4111-8111-111111111111")

	setRunState(t, dbName, "canceled")
	for {
		n, err := service.Once(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			break
		}
	}
	insertOutbox(t, dbName, "bbbbbbbb-1111-4111-8111-222222222222", relayOrg, "run", relayRun,
		`{"kind":"cancel_signal","run_id":"`+relayRun+`"}`)
	if _, err := service.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(dispatcher.signals) != 1 {
		t.Fatalf("terminal run was signaled again: %#v", dispatcher.signals)
	}
	assertDelivered(t, dbName, "bbbbbbbb-1111-4111-8111-222222222222")
}

func TestRelayShredsContent(t *testing.T) {
	pool, dbName := newRelayDB(t)
	insertOutbox(t, dbName, "cccccccc-1111-4111-8111-111111111111", relayOrg, "content", relayTask,
		`{"kind":"content_shred","task_id":"`+relayTask+`","content_refs":["content://a","content://b"]}`)
	store := &fakeStore{}
	service := newRelay(t, pool, &fakeDispatcher{}, store)
	if _, err := service.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(store.deleted, ",") != "content://a,content://b" {
		t.Fatalf("deleted = %#v", store.deleted)
	}
	assertDelivered(t, dbName, "cccccccc-1111-4111-8111-111111111111")
}

func TestRelayRetriesDispatchAndDeadLettersUnknownKind(t *testing.T) {
	pool, dbName := newRelayDB(t)
	insertOutbox(t, dbName, "dddddddd-1111-4111-8111-111111111111", relayOrg, "run", relayRun,
		`{"kind":"start_workflow","run_id":"`+relayRun+`","workflow_id":"run:`+relayRun+`"}`)
	service := newRelay(t, pool, &fakeDispatcher{startErr: errors.New("temporal offline")}, &fakeStore{})
	if _, err := service.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertOutboxFields(t, dbName, "dddddddd-1111-4111-8111-111111111111",
		false, false, 1, "temporal_start_failed", true)

	insertOutbox(t, dbName, "dddddddd-1111-4111-8111-222222222222", relayOrg, "run",
		"72111111-1111-4111-8111-111111111111", `{"kind":"not_a_kind"}`)
	if _, err := service.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertOutboxFields(t, dbName, "dddddddd-1111-4111-8111-222222222222",
		false, true, 1, "unknown_outbox_kind", false)
}

func newRelayDB(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_relay_test")
	if err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	dbPool, err := pgxpool.New(ctx, testpg.WorkerURL(dbName))
	if err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		dbPool.Close()
		cleanup, err := testpg.Open(context.Background(), testpg.AdminURL())
		if err == nil {
			_ = testpg.DropDatabase(context.Background(), cleanup, dbName)
			_ = cleanup.Close(context.Background())
		}
		_ = admin.Close(context.Background())
	})
	return dbPool, dbName
}

func seedRun(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', '` + relayOrg + `', false);
		INSERT INTO work.org (id, status, home_region, name)
		VALUES ('` + relayOrg + `', 'active', 'cn-north', 'Relay');
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('` + relayInput + `', '` + relayOrg + `', 'sub_relay', 'content://relay', 'sha256:relay', 10);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode, title, input_id, revision)
		VALUES ('` + relayTask + `', '` + relayOrg + `', 'sub_relay', 'open', 'ask_each', 'Relay task', '` + relayInput + `', 0);
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		VALUES ('` + relaySnap + `', '` + relayOrg + `', '` + relayTask + `', 'test', 'sha256:relay',
		  ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('` + relayRun + `', '` + relayOrg + `', '` + relayTask + `', 1, 'queued',
		  '` + relaySnap + `', 'run:` + relayRun + `', 'r0a');
		UPDATE work.task SET snapshot_id = '` + relaySnap + `',
		  active_run_id = '` + relayRun + `', latest_run_id = '` + relayRun + `', revision = 1
		WHERE id = '` + relayTask + `';
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

func insertOutbox(t *testing.T, dbName, eventID, orgID, aggregateType, aggregateID, payload string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `
		INSERT INTO work.outbox (org_id, aggregate_type, aggregate_id, event_id, payload)
		VALUES ($1, $2, $3, $4, $5::jsonb)`,
		orgID, aggregateType, aggregateID, eventID, payload,
	); err != nil {
		t.Fatal(err)
	}
}

func assertDelivered(t *testing.T, dbName, eventID string) {
	t.Helper()
	assertOutboxFields(t, dbName, eventID, true, false, 1, "", false)
}

func assertOutboxFields(t *testing.T, dbName, eventID string, delivered, dead bool, attempts int, code string, future bool) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var isDelivered, isDead, isFuture bool
	var gotAttempts int
	var gotCode *string
	if err := conn.QueryRow(ctx, `
		SELECT delivered_at IS NOT NULL, dead_lettered_at IS NOT NULL, attempts,
		       last_error_code, available_at > now()
		FROM work.outbox WHERE event_id = $1`, eventID,
	).Scan(&isDelivered, &isDead, &gotAttempts, &gotCode, &isFuture); err != nil {
		t.Fatal(err)
	}
	gotCodeValue := ""
	if gotCode != nil {
		gotCodeValue = *gotCode
	}
	if isDelivered != delivered || isDead != dead || gotAttempts != attempts ||
		gotCodeValue != code || isFuture != future {
		t.Fatalf("outbox delivered=%t dead=%t attempts=%d code=%q future=%t",
			isDelivered, isDead, gotAttempts, gotCodeValue, isFuture)
	}
}

func setRunState(t *testing.T, dbName, state string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', $1, true)`, relayOrg); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.subject_id', 'sub_relay', true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT work.acquire_run($1, $2)`, relayRun, relayOrg); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT work.request_cancel($1, $2, 'sub_relay', NULL)`, relayOrg, relayRun); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT work.finish_run($1, $2, $3, NULL)`, relayRun, relayOrg, state); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func newRelay(t *testing.T, pool *pgxpool.Pool, dispatcher relay.Dispatcher, store content.Store) *relay.Relay {
	t.Helper()
	service, err := relay.New(pool, store, dispatcher, relay.Config{
		RelayID: "relay-test-1", BatchSize: 20, LeaseSeconds: 30, PollInterval: time.Millisecond,
	}, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	return service
}

type fakeDispatcher struct {
	starts    []relay.StartWorkflowRequest
	signals   []fakeSignal
	startErr  error
	signalErr error
}

type fakeSignal struct {
	workflowID string
	name       string
	payload    any
}

func (f *fakeDispatcher) StartWorkflow(_ context.Context, request relay.StartWorkflowRequest) error {
	f.starts = append(f.starts, request)
	return f.startErr
}

func (f *fakeDispatcher) CancelWorkflow(context.Context, string) error {
	return errors.New("hard cancel must not be used")
}

func (f *fakeDispatcher) SignalWorkflow(_ context.Context, workflowID, name string, payload any) error {
	f.signals = append(f.signals, fakeSignal{workflowID: workflowID, name: name, payload: payload})
	return f.signalErr
}

type fakeStore struct {
	deleted []string
	err     error
}

func (f *fakeStore) Put(context.Context, string, []byte) (content.Ref, error) {
	return content.Ref{}, errors.New("not implemented")
}

func (f *fakeStore) Get(context.Context, string, string) ([]byte, error) {
	return nil, errors.New("not implemented")
}

func (f *fakeStore) Delete(_ context.Context, _ string, contentRef string) error {
	if f.err != nil {
		return f.err
	}
	f.deleted = append(f.deleted, contentRef)
	return nil
}
