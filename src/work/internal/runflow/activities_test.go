package runflow_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.temporal.io/sdk/temporal"
	"google.golang.org/protobuf/proto"

	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/runflow"
	workruntime "github.com/we-meet/work/internal/runtime"
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

const failureMarker = "secret-token-DO-NOT-PERSIST private-goal-DO-NOT-PERSIST"

func activityFailureCases() []struct {
	name     string
	err      error
	canceled bool
} {
	fc := temporal.GetDefaultFailureConverter()
	failure := fc.ErrorToFailure(temporal.NewApplicationErrorWithCause(
		failureMarker, failureMarker, errors.New(failureMarker), failureMarker))
	failure.StackTrace = failureMarker
	return []struct {
		name     string
		err      error
		canceled bool
	}{
		{"plain", errors.New(failureMarker), false},
		{"postgres", &pgconn.PgError{
			Code: "P0001", Message: failureMarker, Detail: failureMarker,
			Hint: failureMarker, Where: failureMarker, InternalQuery: failureMarker,
		}, false},
		{"temporal_with_cause_details_stack", fc.FailureToError(failure), false},
		{"context_canceled", fmt.Errorf("%s: %w", failureMarker, context.Canceled), true},
		{"temporal_canceled", fmt.Errorf("%s: %w", failureMarker, temporal.NewCanceledError(failureMarker)), true},
		{"deadline", fmt.Errorf("%s: %w", failureMarker, context.DeadlineExceeded), false},
	}
}

func assertSafeActivityFailure(t *testing.T, err error, code string, canceled bool) {
	t.Helper()
	if err == nil {
		t.Fatal("expected activity failure")
	}
	if temporal.IsCanceledError(err) != canceled {
		t.Fatalf("cancellation classification = %v, want %v", temporal.IsCanceledError(err), canceled)
	}
	if !canceled && err.Error() != code {
		t.Fatalf("error = %q, want %q", err.Error(), code)
	}
	if errors.Unwrap(err) != nil {
		t.Fatal("activity retained a cause")
	}
	fc := temporal.GetDefaultFailureConverter()
	failure := fc.ErrorToFailure(err)
	// Binary protobuf preserves raw details that JSON would base64-encode.
	wire, marshalErr := proto.Marshal(failure)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	for _, marker := range strings.Fields(failureMarker) {
		if strings.Contains(string(wire), marker) {
			t.Fatal("serialized Temporal failure leaked a marker")
		}
	}
	if failure.GetCause() != nil || failure.GetStackTrace() != "" || failure.GetEncodedAttributes() != nil {
		t.Fatal("serialized failure retained cause, stack or encoded attributes")
	}
	if canceled {
		info := failure.GetCanceledFailureInfo()
		if info == nil || info.GetDetails() != nil || failure.GetMessage() != "canceled" {
			t.Fatal("cancellation must have only the SDK's fixed message and no details")
		}
	} else {
		info := failure.GetApplicationFailureInfo()
		if info == nil || info.GetDetails() != nil || info.GetNonRetryable() || failure.GetMessage() != code {
			t.Fatal("application failure must be a retryable static code without details")
		}
	}
	if temporal.IsCanceledError(fc.FailureToError(failure)) != canceled {
		t.Fatal("cancellation classification changed on SDK round trip")
	}
}

func TestActivityDatabaseFailuresAreSafe(t *testing.T) {
	for _, tc := range activityFailureCases() {
		t.Run(tc.name, func(t *testing.T) {
			config, err := pgxpool.ParseConfig("postgres://unused:unused@localhost/unused?sslmode=disable")
			if err != nil {
				t.Fatal(err)
			}
			// Fail before any network access, through the real DB transaction wrapper.
			config.BeforeConnect = func(context.Context, *pgx.ConnConfig) error { return tc.err }
			pool, err := pgxpool.NewWithConfig(context.Background(), config)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			a := newActivities(pool, nil)
			ctx := context.Background()
			input := runflow.Input{RunID: flowRun, OrgID: flowOrg}
			_, err = a.PrepareRun(ctx, input)
			assertSafeActivityFailure(t, err, "prepare_run_failed", tc.canceled)
			_, err = a.AcquireRun(ctx, input)
			assertSafeActivityFailure(t, err, "acquire_run_failed", tc.canceled)
			_, err = a.CheckRun(ctx, input)
			assertSafeActivityFailure(t, err, "check_run_failed", tc.canceled)
			err = a.WaitRun(ctx, runflow.WaitRunInput{RunID: flowRun, OrgID: flowOrg})
			assertSafeActivityFailure(t, err, "wait_run_failed", tc.canceled)
			err = a.FinishRun(ctx, runflow.FinishRunInput{RunID: flowRun, OrgID: flowOrg})
			assertSafeActivityFailure(t, err, "finish_run_failed", tc.canceled)
			err = a.AbortRun(ctx, runflow.AbortRunInput{RunID: flowRun, OrgID: flowOrg})
			assertSafeActivityFailure(t, err, "abort_run_failed", tc.canceled)
		})
	}
}

type failingGetStore struct {
	content.Store
	err error
}

func (s failingGetStore) Get(context.Context, string, string) ([]byte, error) {
	return nil, s.err
}

func TestActivityContentFailuresAreSafe(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	a := newActivities(pool, store)
	prepared, err := a.PrepareRun(context.Background(), runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range activityFailureCases() {
		t.Run(tc.name, func(t *testing.T) {
			a.Content = failingGetStore{Store: store, err: tc.err}
			_, err := a.PrepareRun(context.Background(), runflow.Input{RunID: flowRun, OrgID: flowOrg})
			assertSafeActivityFailure(t, err, "input_read_failed", tc.canceled)
			step, err := a.ExecuteStep(context.Background(), runflow.ExecuteStepInput{
				Prepared: prepared, Step: 1, StepCount: 1, Final: true,
			})
			if err != nil || step.ErrCode != "input_read_failed" || step.Unknown || step.Canceled {
				t.Fatalf("ExecuteStep classification changed: step=%#v err=%v", step, err)
			}
		})
	}
}

func TestActivityLaterDatabaseFailuresAreSafe(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	ctx := context.Background()
	for _, tc := range []struct {
		name   string
		failAt int
		code   string
		call   func(*runflow.Activities) error
	}{
		{"acquire_write", 2, "acquire_run_failed", func(a *runflow.Activities) error {
			_, err := a.AcquireRun(ctx, runflow.Input{RunID: flowRun, OrgID: flowOrg})
			return err
		}},
		{"wait_write", 2, "wait_run_failed", func(a *runflow.Activities) error {
			return a.WaitRun(ctx, runflow.WaitRunInput{RunID: flowRun, OrgID: flowOrg})
		}},
		{"finish_write", 2, "finish_run_failed", func(a *runflow.Activities) error {
			return a.FinishRun(ctx, runflow.FinishRunInput{RunID: flowRun, OrgID: flowOrg})
		}},
		{"abort_operation", 2, "abort_run_failed", func(a *runflow.Activities) error {
			return a.AbortRun(ctx, runflow.AbortRunInput{RunID: flowRun, OrgID: flowOrg, OperationID: flowSnap})
		}},
		{"abort_open_operations", 2, "abort_run_failed", func(a *runflow.Activities) error {
			return a.AbortRun(ctx, runflow.AbortRunInput{RunID: flowRun, OrgID: flowOrg})
		}},
		{"abort_finish_read", 3, "abort_run_failed", func(a *runflow.Activities) error {
			return a.AbortRun(ctx, runflow.AbortRunInput{RunID: flowRun, OrgID: flowOrg})
		}},
		{"abort_finish_write", 4, "abort_run_failed", func(a *runflow.Activities) error {
			return a.AbortRun(ctx, runflow.AbortRunInput{RunID: flowRun, OrgID: flowOrg})
		}},
		{"abort_finish_not_current", 4, "", func(a *runflow.Activities) error {
			return a.AbortRun(ctx, runflow.AbortRunInput{RunID: flowRun, OrgID: flowOrg})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := pool.Config()
			config.MaxConns = 1
			// Discard each connection so the next transaction hits BeforeConnect.
			config.AfterRelease = func(*pgx.Conn) bool { return false }
			connects := 0
			config.BeforeConnect = func(context.Context, *pgx.ConnConfig) error {
				connects++
				if connects >= tc.failAt {
					message := failureMarker
					if tc.code == "" {
						message = "run_not_current: " + message
					}
					return &pgconn.PgError{Code: "P0001", Message: message, Detail: failureMarker}
				}
				return nil
			}
			failingPool, err := pgxpool.NewWithConfig(ctx, config)
			if err != nil {
				t.Fatal(err)
			}
			defer failingPool.Close()
			err = tc.call(newActivities(failingPool, store))
			if tc.code == "" {
				if err != nil {
					t.Fatalf("run_not_current must remain a successful abort: %v", err)
				}
			} else {
				assertSafeActivityFailure(t, err, tc.code, false)
			}
			if connects != tc.failAt {
				t.Fatalf("connections = %d, want %d", connects, tc.failAt)
			}
		})
	}
}

func TestActivityTerminalAndMissingRunBehaviorUnchanged(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	a := newActivities(pool, store)
	ctx := context.Background()
	if _, err := a.AcquireRun(ctx, runflow.Input{RunID: flowRun, OrgID: flowOrg}); err != nil {
		t.Fatal(err)
	}
	if err := a.FinishRun(ctx, runflow.FinishRunInput{RunID: flowRun, OrgID: flowOrg, Outcome: "failed", Reason: "test_failed"}); err != nil {
		t.Fatal(err)
	}
	prepared, err := a.PrepareRun(ctx, runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil || !prepared.Canceled {
		t.Fatalf("terminal prepare = %#v, %v", prepared, err)
	}
	acquired, err := a.AcquireRun(ctx, runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil || !acquired.Canceled {
		t.Fatalf("terminal acquire = %#v, %v", acquired, err)
	}
	control, err := a.CheckRun(ctx, runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil || control.State != "failed" {
		t.Fatalf("terminal check = %#v, %v", control, err)
	}
	for name, err := range map[string]error{
		"wait":          a.WaitRun(ctx, runflow.WaitRunInput{RunID: flowRun, OrgID: flowOrg}),
		"finish":        a.FinishRun(ctx, runflow.FinishRunInput{RunID: flowRun, OrgID: flowOrg}),
		"abort":         a.AbortRun(ctx, runflow.AbortRunInput{RunID: flowRun, OrgID: flowOrg}),
		"abort_missing": a.AbortRun(ctx, runflow.AbortRunInput{RunID: flowSnap, OrgID: flowOrg}),
	} {
		if err != nil {
			t.Fatalf("%s must remain a no-op: %v", name, err)
		}
	}
	_, err = a.PrepareRun(ctx, runflow.Input{RunID: flowSnap, OrgID: flowOrg})
	assertSafeActivityFailure(t, err, "run_not_found", false)
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
	if prepared.TaskID != flowTask || prepared.TemplateID != "summary" ||
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
		Step: 1, StepCount: 1, Final: true,
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
		Step: 1, StepCount: 1, Final: true,
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

func TestRunWorkflowActivitiesPublishOnlyFinalStep(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	activities := newActivities(pool, store)
	prepared, err := activities.PrepareRun(context.Background(), runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	acquired, err := activities.AcquireRun(context.Background(), runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	first, err := activities.ExecuteStep(context.Background(), runflow.ExecuteStepInput{
		Prepared: prepared, Fence: acquired.Fence,
		Step: 1, StepCount: 2, Final: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.ErrCode != "" || first.ContentRef == "" || first.ArtifactID != "" || !first.Settled {
		t.Fatalf("first = %#v", first)
	}
	second, err := activities.ExecuteStep(context.Background(), runflow.ExecuteStepInput{
		Prepared: prepared, Fence: acquired.Fence,
		Step: 2, StepCount: 2, Final: true,
		PreviousContentRef: first.ContentRef, PreviousContentHash: first.ContentHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.ErrCode != "" || second.ArtifactID == "" || second.VersionNo != 1 || !second.Settled {
		t.Fatalf("second = %#v", second)
	}
	if first.ContentRef == second.ContentRef {
		t.Fatal("steps must use distinct content checkpoints")
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
	var operations, artifacts int
	var taskState string
	if err := admin.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM work.operation WHERE run_id=$1),
		       (SELECT count(*) FROM work.artifact WHERE task_id=$2),
		       (SELECT state FROM work.task WHERE id=$2)`,
		flowRun, flowTask).Scan(&operations, &artifacts, &taskState); err != nil {
		t.Fatal(err)
	}
	if operations != 2 || artifacts != 1 || taskState != "awaiting_acceptance" {
		t.Fatalf("operations=%d artifacts=%d task=%s", operations, artifacts, taskState)
	}
}

func tokenPtr(value int64) *int64 { return &value }

type capturingRuntime struct {
	request workruntime.Request
}

func (c *capturingRuntime) Execute(_ context.Context, request workruntime.Request) (workruntime.Result, error) {
	c.request = request
	return workruntime.Result{
		Content: []byte("# captured"), MediaType: "text/markdown",
		RuntimeVersion: "capture-test",
		Usage: workruntime.Usage{
			Source:            workruntime.UsageProvider,
			InputTokens:       tokenPtr(1),
			OutputTokens:      tokenPtr(1),
			CachedInputTokens: tokenPtr(0),
		},
	}, nil
}

func TestExecuteStepLoadsInputInsideActivity(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	activities := newActivities(pool, store)
	capture := &capturingRuntime{}
	activities.Runtime = capture
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
		Step: 1, StepCount: 1, Final: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if step.ErrCode != "" {
		t.Fatalf("step = %#v", step)
	}
	if capture.request.Goal != "写一份发布计划" || capture.request.Background != "包含回滚" {
		t.Fatalf("runtime request lost input: goal=%q background=%q",
			capture.request.Goal, capture.request.Background)
	}
}

type failingPutStore struct {
	content.Store
}

func (failingPutStore) Put(context.Context, string, []byte) (content.Ref, error) {
	return content.Ref{}, errors.New("content disk full")
}

func TestExecuteStepContentFailureBecomesUnknown(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	activities := newActivities(pool, store)
	activities.Content = failingPutStore{Store: store}
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
		Step: 1, StepCount: 1, Final: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !step.Unknown || step.ErrCode != "content_write_failed" || step.ArtifactID != "" {
		t.Fatalf("step = %#v", step)
	}
	admin, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	var operationState, reservationState string
	if err := admin.QueryRow(context.Background(), `
		SELECT o.state, qr.state FROM work.operation o
		JOIN work.quota_reservation qr ON qr.operation_id = o.id AND qr.org_id = o.org_id
		WHERE o.id = $1`, step.OperationID,
	).Scan(&operationState, &reservationState); err != nil {
		t.Fatal(err)
	}
	if operationState != "unknown" || reservationState != "held" {
		t.Fatalf("operation=%s reservation=%s", operationState, reservationState)
	}
}

func TestAbortRunCancelsOpenOperations(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	activities := newActivities(pool, store)
	if _, err := activities.AcquireRun(context.Background(), runflow.Input{RunID: flowRun, OrgID: flowOrg}); err != nil {
		t.Fatal(err)
	}
	operationID := createAuthorizedOperation(t, pool, "model:abort", "sha256:abort")
	if err := activities.AbortRun(context.Background(), runflow.AbortRunInput{
		RunID: flowRun, OrgID: flowOrg, Outcome: "failed", Reason: "execute_failed",
	}); err != nil {
		t.Fatal(err)
	}
	admin, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	var operationState, runState string
	if err := admin.QueryRow(context.Background(),
		`SELECT state FROM work.operation WHERE id = $1`, operationID,
	).Scan(&operationState); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(context.Background(),
		`SELECT state FROM work.run WHERE id = $1`, flowRun,
	).Scan(&runState); err != nil {
		t.Fatal(err)
	}
	if operationState != "canceled" || runState != "failed" {
		t.Fatalf("operation=%s run=%s", operationState, runState)
	}
}

type usageRuntime struct{}

func (usageRuntime) Execute(context.Context, workruntime.Request) (workruntime.Result, error) {
	return workruntime.Result{
		Content: []byte("# usage"), MediaType: "text/markdown", RuntimeVersion: "usage-test",
		Provider: "aliyun", Model: "test-model",
		Usage: workruntime.Usage{
			Source:            workruntime.UsageProvider,
			InputTokens:       tokenPtr(1),
			OutputTokens:      tokenPtr(2),
			CachedInputTokens: tokenPtr(0),
		},
	}, nil
}

func TestRecordUsageIsIdempotentPerOperation(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	activities := newActivities(pool, store)
	activities.Runtime = usageRuntime{}
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
		Step: 1, StepCount: 1, Final: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if step.ErrCode != "" || step.OperationID == "" {
		t.Fatalf("step = %#v", step)
	}
	admin, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	ctx := context.Background()
	script := `
		SELECT set_config('app.org_id', '` + flowOrg + `', false);
		SELECT work.record_usage('` + flowOrg + `', 'sub_runflow', '` + step.OperationID + `',
		  'aliyun', 'test-model', '2026-10-29'::date, 1, 2, 0, 1);
	`
	if err := testpg.ExecRaw(ctx, admin, script); err != nil {
		t.Fatal(err)
	}
	var inputTokens, outputTokens int64
	if err := admin.QueryRow(ctx, `
		SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0)
		FROM work.usage_daily
		WHERE org_id = $1 AND subject_id = 'sub_runflow'`,
		flowOrg,
	).Scan(&inputTokens, &outputTokens); err != nil {
		t.Fatal(err)
	}
	if inputTokens != 1 || outputTokens != 2 {
		t.Fatalf("usage = %d/%d, want 1/2", inputTokens, outputTokens)
	}
}

func TestReserveQuotaSerializesRunCap(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	if _, err := admin.Exec(ctx, `UPDATE work.org_policy SET run_cap_tokens = 100 WHERE org_id = $1`, flowOrg); err != nil {
		t.Fatal(err)
	}
	activities := newActivities(pool, store)
	if _, err := activities.AcquireRun(ctx, runflow.Input{RunID: flowRun, OrgID: flowOrg}); err != nil {
		t.Fatal(err)
	}
	first := createAuthorizedOperation(t, pool, "model:cap-1", "sha256:cap-1")
	second := createAuthorizedOperation(t, pool, "model:cap-2", "sha256:cap-2")

	start := make(chan struct{})
	results := make(chan error, 2)
	for _, operationID := range []string{first, second} {
		go func(operationID string) {
			<-start
			results <- workdb.WithWorkerOrgContext(ctx, pool, flowOrg, func(tx pgx.Tx) error {
				var reservationID string
				return tx.QueryRow(ctx,
					`SELECT work.reserve_quota($1, 'default', $2, $3, 60)`,
					flowOrg, flowPeriod, operationID,
				).Scan(&reservationID)
			})
		}(operationID)
	}
	close(start)
	success, capExceeded := 0, 0
	for range []string{first, second} {
		err := <-results
		switch {
		case err == nil:
			success++
		case strings.Contains(err.Error(), "run_cap_exceeded"):
			capExceeded++
		default:
			t.Fatalf("reserve quota: %v", err)
		}
	}
	if success != 1 || capExceeded != 1 {
		t.Fatalf("success=%d capExceeded=%d", success, capExceeded)
	}
}

func createAuthorizedOperation(t *testing.T, pool *pgxpool.Pool, logicalKey, requestHash string) string {
	t.Helper()
	ctx := context.Background()
	var operationID string
	if err := workdb.WithWorkerOrgContext(ctx, pool, flowOrg, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT work.create_operation($1, $2, $3, 'model', $4)`,
			flowRun, flowOrg, logicalKey, requestHash,
		).Scan(&operationID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `SELECT work.authorize_operation($1, $2, $3, 'policy_auto')`,
			flowOrg, operationID, 1)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return operationID
}

type zeroUsageRuntime struct{}

func (zeroUsageRuntime) Execute(context.Context, workruntime.Request) (workruntime.Result, error) {
	return workruntime.Result{
		Content: []byte("# no usage"), MediaType: "text/markdown",
		RuntimeVersion: "zero-usage",
		Usage:          workruntime.Usage{Source: workruntime.UsageUnavailable},
	}, nil
}

func TestExecuteStepTreatsMissingUsageAsUnknown(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	activities := newActivities(pool, store)
	activities.Runtime = zeroUsageRuntime{}
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
		Step: 1, StepCount: 1, Final: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !step.Unknown || step.ErrCode != "usage_unavailable" || step.ArtifactID != "" {
		t.Fatalf("step = %#v", step)
	}
}

type unavailableUsageRuntime struct{}

func (unavailableUsageRuntime) Execute(context.Context, workruntime.Request) (workruntime.Result, error) {
	return workruntime.Result{
		Content: []byte("# unavailable usage"), MediaType: "text/markdown",
		RuntimeVersion: "unavailable-usage",
		Provider:       "aliyun", Model: "test-model",
		Usage: workruntime.Usage{
			Source:            workruntime.UsageUnavailable,
			InputTokens:       tokenPtr(0),
			OutputTokens:      tokenPtr(0),
			CachedInputTokens: tokenPtr(0),
		},
	}, nil
}

func TestExecuteStepUnavailableUsageKeepsReservationWithoutRecordingZero(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	activities := newActivities(pool, store)
	activities.Runtime = unavailableUsageRuntime{}
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
		Step: 1, StepCount: 1, Final: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !step.Unknown || step.ErrCode != "usage_unavailable" || step.Settled ||
		step.ArtifactID != "" || step.ContentRef != "" || step.UsageTokens != 0 {
		t.Fatalf("step = %#v", step)
	}
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	var operationState, reservationState string
	if err := admin.QueryRow(ctx, `
		SELECT o.state, qr.state FROM work.operation o
		JOIN work.quota_reservation qr ON qr.operation_id = o.id AND qr.org_id = o.org_id
		WHERE o.id = $1`, step.OperationID,
	).Scan(&operationState, &reservationState); err != nil {
		t.Fatal(err)
	}
	if operationState != "unknown" || reservationState != "held" {
		t.Fatalf("operation=%s reservation=%s", operationState, reservationState)
	}
	var recorded int
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM work.usage_daily WHERE org_id = $1`, flowOrg,
	).Scan(&recorded); err != nil {
		t.Fatal(err)
	}
	if recorded != 0 {
		t.Fatalf("usage_daily rows = %d, want 0", recorded)
	}
}

type unknownRuntime struct{}

func (unknownRuntime) Execute(context.Context, workruntime.Request) (workruntime.Result, error) {
	return workruntime.Result{}, workruntime.Unknown(errors.New("provider timeout"))
}

func TestExecuteStepMarksUnknownAndWaitsForReconcile(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedTaskWithInput(t, dbName, store, 1000000)
	activities := newActivities(pool, store)
	activities.Runtime = unknownRuntime{}
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
		Step: 1, StepCount: 1, Final: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !step.Unknown || step.ErrCode != "runtime_unknown" || step.Settled || step.ArtifactID != "" {
		t.Fatalf("step = %#v", step)
	}
	if err := activities.WaitRun(context.Background(), runflow.WaitRunInput{
		RunID: flowRun, OrgID: flowOrg, Reason: "reconcile",
	}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	var runState, waitReason, opState, reservationState, storedOperationID string
	if err := admin.QueryRow(ctx, `
		SELECT r.state, r.wait_reason, o.state, qr.state, o.id::text
		FROM work.run r
		JOIN work.operation o ON o.run_id = r.id AND o.org_id = r.org_id
		JOIN work.quota_reservation qr ON qr.operation_id = o.id AND qr.org_id = o.org_id
		WHERE r.id = $1`, flowRun).Scan(&runState, &waitReason, &opState, &reservationState, &storedOperationID); err != nil {
		t.Fatal(err)
	}
	if step.OperationID == "" || step.OperationID != storedOperationID {
		t.Fatalf("step operation=%q stored=%q", step.OperationID, storedOperationID)
	}
	if runState != "waiting" || waitReason != "reconcile" || opState != "unknown" || reservationState != "held" {
		t.Fatalf("run=%s wait=%s op=%s reservation=%s", runState, waitReason, opState, reservationState)
	}
	if _, err := admin.Exec(ctx, `SELECT set_config('app.org_id', $1, false)`, flowOrg); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `SELECT work.reconcile_operation($1::text, $2::uuid, 'not_sent', NULL::text, 0::bigint, 'evidence://test'::text)`,
		flowOrg, storedOperationID); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `
		SELECT o.state, qr.state FROM work.operation o
		JOIN work.quota_reservation qr ON qr.operation_id = o.id AND qr.org_id = o.org_id
		WHERE o.id = $1`, step.OperationID).Scan(&opState, &reservationState); err != nil {
		t.Fatal(err)
	}
	if opState != "reconciled" || reservationState != "released" {
		t.Fatalf("op=%s reservation=%s", opState, reservationState)
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
