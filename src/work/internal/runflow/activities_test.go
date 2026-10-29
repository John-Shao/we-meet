package runflow_test

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/runflow"
	"github.com/we-meet/work/internal/runtime/reference"
	"github.com/we-meet/work/internal/testpg"
)

const (
	flowOrg    = "org_runflow"
	flowInput  = "a1111111-1111-4111-8111-111111111111"
	flowTask   = "a2222222-2222-4222-8222-222222222222"
	flowRun    = "a3333333-3333-4333-8333-333333333333"
	flowSnap   = "a4444444-4444-4444-8444-444444444444"
	flowPeriod = "2026-10"
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
		log.Printf("prepare runflow fixtures: %v", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func TestRunWorkflowActivitiesCompleteReferenceRun(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	activities := newActivities(pool, store)

	prepared, err := activities.PrepareRun(context.Background(), runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	if prepared.TaskID != flowTask || prepared.Goal != "写一份发布计划" ||
		prepared.Background != "包含回滚" || prepared.TemplateID != "summary" ||
		prepared.TokenUpperBound != 100000 || prepared.Canceled {
		t.Fatalf("prepared = %#v", prepared)
	}
	acquired, err := activities.AcquireRun(context.Background(), runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	if acquired.State != "active" || acquired.Canceled {
		t.Fatalf("acquired = %#v", acquired)
	}
	step, err := activities.ExecuteStep(context.Background(), runflow.ExecuteStepInput{
		Prepared: prepared, Fence: acquired.Fence,
	})
	if err != nil {
		t.Fatal(err)
	}
	if step.ErrCode != "" || step.ArtifactID == "" || step.ContentRef == "" ||
		step.UsageTokens <= 0 || !step.Settled {
		t.Fatalf("step = %#v", step)
	}
	if err := activities.FinishRun(context.Background(), runflow.FinishRunInput{
		RunID: flowRun, OrgID: flowOrg, Outcome: "succeeded",
	}); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	var taskState, runState, opState, reservationState, artifactState string
	var settledTokens int64
	if err := admin.QueryRow(ctx, `
		SELECT t.state, r.state, o.state, qr.state, av.content_ref, qa.settled_tokens
		FROM work.task t
		JOIN work.run r ON r.task_id = t.id AND r.org_id = t.org_id
		JOIN work.operation o ON o.run_id = r.id AND o.org_id = r.org_id
		JOIN work.quota_reservation qr ON qr.operation_id = o.id AND qr.org_id = o.org_id
		JOIN work.quota_account qa ON qa.id = qr.account_id AND qa.org_id = qr.org_id
		JOIN work.artifact_version av ON av.org_id = t.org_id
		  AND av.artifact_id = $2 AND av.version_no = 1
		WHERE t.id = $1`,
		flowTask, step.ArtifactID,
	).Scan(&taskState, &runState, &opState, &reservationState, &artifactState, &settledTokens); err != nil {
		t.Fatal(err)
	}
	if taskState != "awaiting_acceptance" || runState != "succeeded" ||
		opState != "succeeded" || reservationState != "settled" ||
		artifactState != step.ContentRef || settledTokens <= 0 {
		t.Fatalf("task=%s run=%s op=%s reservation=%s artifact=%s settled=%d",
			taskState, runState, opState, reservationState, artifactState, settledTokens)
	}
	read, err := store.Get(ctx, flowOrg, step.ContentRef)
	if err != nil || len(read) == 0 {
		t.Fatalf("artifact read: %v bytes=%d", err, len(read))
	}
	var eventCount int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM work.task_event WHERE task_id = $1`, flowTask).Scan(&eventCount); err != nil {
		t.Fatal(err)
	}
	if eventCount == 0 {
		t.Fatal("task has no events")
	}
}

func TestExecuteStepProvisionsMissingQuotaAccount(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 0)
	activities := newActivities(pool, store)
	prepared, err := activities.PrepareRun(context.Background(), runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	acquired, err := activities.AcquireRun(context.Background(), runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	step, err := activities.ExecuteStep(context.Background(), runflow.ExecuteStepInput{
		Prepared: prepared, Fence: acquired.Fence,
	})
	if err != nil {
		t.Fatal(err)
	}
	if step.ErrCode != "" || step.ArtifactID == "" || !step.Settled {
		t.Fatalf("step = %#v", step)
	}
	if err := activities.FinishRun(context.Background(), runflow.FinishRunInput{
		RunID: flowRun, OrgID: flowOrg, Outcome: "succeeded",
	}); err != nil {
		t.Fatal(err)
	}
	var runState, accountKey, enforcement string
	var limit int64
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	if err := admin.QueryRow(ctx, `SELECT state FROM work.run WHERE id = $1`, flowRun).Scan(&runState); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `
		SELECT account_key, limit_tokens, enforcement FROM work.quota_account
		WHERE org_id = $1 AND period_id = $2`, flowOrg, flowPeriod,
	).Scan(&accountKey, &limit, &enforcement); err != nil {
		t.Fatal(err)
	}
	if runState != "succeeded" || accountKey != "default" || limit != 1000000 || enforcement != "soft" {
		t.Fatalf("run=%s account=%s limit=%d enforcement=%s", runState, accountKey, limit, enforcement)
	}
}

func newFlowDB(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_runflow_test")
	if err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, testpg.WorkerURL(dbName))
	if err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanup, err := testpg.Open(context.Background(), testpg.AdminURL())
		if err == nil {
			_ = testpg.DropDatabase(context.Background(), cleanup, dbName)
			_ = cleanup.Close(context.Background())
		}
		_ = admin.Close(context.Background())
	})
	return pool, dbName
}

func newFlowContent(t *testing.T) *content.Local {
	t.Helper()
	store, err := content.NewLocal([]byte("0123456789abcdef0123456789abcdef"), t.TempDir(), 1)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func newActivities(pool *pgxpool.Pool, store content.Store) *runflow.Activities {
	return &runflow.Activities{
		Pool: pool, Content: store, Runtime: reference.New(),
		AccountKey: "default", QuotaPeriod: flowPeriod, ConsumerID: "worker-test",
		Now: func() time.Time { return time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC) },
	}
}

func seedTaskWithInput(t *testing.T, dbName string, store content.Store, quotaLimit int64) {
	t.Helper()
	payload, _ := json.Marshal(map[string]string{
		"goal": "写一份发布计划", "background": "包含回滚",
	})
	ref, err := store.Put(context.Background(), flowOrg, payload)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', '` + flowOrg + `', false);
		INSERT INTO work.org (id, status, home_region, name)
		VALUES ('` + flowOrg + `', 'active', 'cn-north', 'Runflow');
		INSERT INTO work.org_policy (org_id, run_cap_tokens, revision)
		VALUES ('` + flowOrg + `', 100000, 1)
		ON CONFLICT (org_id) DO UPDATE SET run_cap_tokens = EXCLUDED.run_cap_tokens;
	`
	if quotaLimit > 0 {
		script += `
		INSERT INTO work.quota_account (org_id, account_key, period_id, limit_tokens, enforcement)
		VALUES ('` + flowOrg + `', 'default', '` + flowPeriod + `', ` +
			fmt.Sprintf("%d", quotaLimit) + `, 'soft')
		ON CONFLICT (org_id, account_key, period_id) DO UPDATE SET limit_tokens = EXCLUDED.limit_tokens;
		`
	}
	script += `
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('` + flowInput + `', '` + flowOrg + `', 'sub_runflow', '` + ref.ContentRef + `', '` + ref.Hash + `', ` +
		fmt.Sprintf("%d", ref.Bytes) + `);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode, title, input_id, revision)
		VALUES ('` + flowTask + `', '` + flowOrg + `', 'sub_runflow', 'open', 'ask_each',
		  '发布计划', '` + flowInput + `', 0);
		UPDATE work.input_object SET task_id = '` + flowTask + `' WHERE id = '` + flowInput + `';
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		VALUES ('` + flowSnap + `', '` + flowOrg + `', '` + flowTask + `', 'test', 'sha256:test',
		  ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb,
		  '{"template":{"id":"summary","version":1}}'::jsonb);
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('` + flowRun + `', '` + flowOrg + `', '` + flowTask + `', 1, 'queued',
		  '` + flowSnap + `', 'run:` + flowRun + `', '` + reference.Version + `');
		UPDATE work.task SET snapshot_id = '` + flowSnap + `', active_run_id = '` + flowRun + `',
		  latest_run_id = '` + flowRun + `', revision = 1
		WHERE id = '` + flowTask + `';
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}
