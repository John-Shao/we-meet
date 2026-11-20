package runflow_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.temporal.io/sdk/temporal"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/egress"
	"github.com/we-meet/work/internal/runflow"
	"github.com/we-meet/work/internal/testpg"
)

type advanceRecoveryFixture struct {
	pool     *pgxpool.Pool
	admin    *pgx.Conn // Read-only assertions on tables not exposed to work_worker.
	store    content.Store
	input    runflow.AdvanceFinishInput
	manifest egress.OutputManifest
}

// No provider participates in these tests: the canonical success documents are
// fixtures, not evidence of a provider call. Prepare uses the real PG route;
// every finish uses a fresh Activities (and its fresh Finisher) with only PG/store.
func newAdvanceRecoveryFixture(t *testing.T) advanceRecoveryFixture {
	t.Helper()
	ctx := context.Background()
	pool, dbName := newFlowDB(t)
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	store := newFlowContent(t)
	seedAdvanceTask(t, dbName, store)
	activities := newAdvanceActivities(pool, store)
	prepared, err := activities.PrepareAdvance(ctx, runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	head, err := activities.EnsureAdvanceHead(ctx, prepared)
	if err != nil {
		t.Fatal(err)
	}
	execution, err := activities.PrepareAdvanceExecution(ctx, runflow.PrepareExecutionInput{Prepared: prepared, Head: head})
	if err != nil || execution.ErrCode != "" {
		t.Fatalf("prepare execution = %#v, %v", execution, err)
	}
	const holder = "output-recovery-parent"
	const invocation = "output-recovery-gateway:1"
	receiptSlotID := newUUID(t)
	var state string
	if err := workdb.WithWorkerOrgContext(ctx, pool, flowOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.claim_runtime_execution($1,$2,$3)`,
			flowOrg, execution.ExecutionID, holder).Scan(&state)
	}); err != nil || state != "claimed" {
		t.Fatalf("claim = %q, %v", state, err)
	}
	var consumed []byte
	if err := workdb.WithWorkerOrgContext(ctx, pool, flowOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.consume_dispatch_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			flowOrg, execution.OperationID, execution.ExecutionID, holder, execution.AttemptID,
			execution.RequestHash, prepared.Fence, invocation, receiptSlotID).Scan(&consumed)
	}); err != nil {
		t.Fatal(err)
	}
	var decision struct {
		Outcome string `json:"outcome"`
	}
	if err := json.Unmarshal(consumed, &decision); err != nil || decision.Outcome != "won" {
		t.Fatalf("consume = %s, %v", consumed, err)
	}

	answer, err := store.Put(ctx, flowOrg, []byte("The meeting summary recovered from durable output."))
	if err != nil {
		t.Fatal(err)
	}
	answerID, writerID := newUUID(t), newUUID(t)
	document := canonical.ModelReceipt{
		ReceiptID: newUUID(t),
		Binding: canonical.Binding{
			OrgID: prepared.OrgID, TaskID: prepared.TaskID, RunID: prepared.RunID,
			SnapshotID: prepared.SnapshotID, RuntimeVersion: prepared.RuntimeVersion,
		},
		LogicalKey: canonical.LogicalKey1, OperationID: execution.OperationID,
		DispatchAttemptID: execution.AttemptID, ExecutionID: execution.ExecutionID,
		RequestHash: execution.RequestHash, WriterGatewayID: writerID,
		RecordedAtUnixMs: time.Now().UnixMilli(), Outcome: canonical.OutcomeSucceeded,
		Content: &canonical.Reference{RefID: answerID, Hash: answer.Hash}, ContentBytes: answer.Bytes,
		Usage: canonical.Usage{
			Source: canonical.UsageProvider, InputTokens: canonical.Int64(100),
			OutputTokens: canonical.Int64(50), CachedInputTokens: canonical.Int64(0),
		},
	}
	receiptHash, err := document.Hash()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := document.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	receiptObject, err := store.Put(ctx, flowOrg, raw)
	if err != nil {
		t.Fatal(err)
	}
	manifest := egress.OutputManifest{
		ExecutionID: execution.ExecutionID, AttemptID: execution.AttemptID,
		RequestHash: execution.RequestHash, GatewayInvocationID: invocation, WriterGatewayID: writerID,
		ReceiptSlotID: receiptSlotID, AnswerRefID: answerID,
		AnswerLocator: answer.ContentRef, AnswerHash: answer.Hash, AnswerBytes: answer.Bytes,
		ReceiptLocator: receiptObject.ContentRef, ReceiptHash: receiptHash,
		ReceiptBodyHash: receiptObject.Hash, ReceiptBytes: receiptObject.Bytes,
		LogicalKey: string(canonical.LogicalKey1),
	}
	if err := (&egress.OutputRecovery{Pool: pool, Content: store}).Stage(ctx, flowOrg, execution.OperationID, manifest); err != nil {
		t.Fatal(err)
	}
	// Deliberately do not use seedAdvanceEgress, Register, Restore, or attach here.
	// Both references must be absent when the new finish instance first runs.
	f := advanceRecoveryFixture{pool: pool, admin: admin, store: store,
		input: runflow.AdvanceFinishInput{Prepared: prepared, Head: head, Execution: execution}, manifest: manifest}
	f.assertUnfinished(t, 0)
	for _, id := range []string{manifest.AnswerRefID, manifest.ReceiptSlotID} {
		if _, err := contentref.NewRegistry(pool).Resolve(ctx, flowOrg, id); !errors.Is(err, contentref.ErrNotFound) {
			t.Fatalf("reference unexpectedly registered: %s, %v", id, err)
		}
	}
	var persisted []byte
	if err := workdb.WithWorkerOrgContext(ctx, pool, flowOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT manifest FROM work.egress_output_recovery WHERE org_id=$1 AND operation_id=$2`,
			flowOrg, execution.OperationID).Scan(&persisted)
	}); err != nil {
		t.Fatal(err)
	}
	var restored egress.OutputManifest
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(persisted, &restored); err != nil || restored != manifest {
		t.Fatalf("persisted manifest = %#v, %v", restored, err)
	}
	if err := json.Unmarshal(persisted, &fields); err != nil || len(fields) != 15 {
		t.Fatalf("manifest fields = %d, %v", len(fields), err)
	}
	return f
}

func (f advanceRecoveryFixture) finish(store content.Store) (runflow.AdvanceFinishOutput, error) {
	return (&runflow.Activities{Pool: f.pool, Content: store}).FinishAdvance(context.Background(), f.input)
}

func (f advanceRecoveryFixture) assertCounts(t *testing.T, refs, facts, artifacts, versions int, tokens int64) {
	t.Helper()
	ctx := context.Background()
	var gotRefs, gotFacts, gotArtifacts, gotVersions int
	var settled, inputTokens, outputTokens, cachedTokens int64
	if err := f.admin.QueryRow(ctx, `SELECT
		 (SELECT count(*) FROM work.content_reference WHERE org_id=$1 AND execution_id=$2 AND kind IN ('answer','receipt')),
		 (SELECT count(*) FROM work.operation_usage_fact WHERE org_id=$1 AND operation_id=$3),
		 (SELECT count(*) FROM work.artifact WHERE org_id=$1 AND task_id=$4),
		 (SELECT count(*) FROM work.artifact_version av JOIN work.artifact a ON a.id=av.artifact_id AND a.org_id=av.org_id WHERE a.org_id=$1 AND a.task_id=$4),
		 (SELECT COALESCE(sum(settled_tokens),0) FROM work.quota_reservation WHERE org_id=$1 AND operation_id=$3),
		 (SELECT COALESCE(sum(input_tokens),0) FROM work.usage_daily WHERE org_id=$1),
		 (SELECT COALESCE(sum(output_tokens),0) FROM work.usage_daily WHERE org_id=$1),
		 (SELECT COALESCE(sum(cached_input_tokens),0) FROM work.usage_daily WHERE org_id=$1)`,
		flowOrg, f.input.Execution.ExecutionID, f.input.Execution.OperationID, flowTask).
		Scan(&gotRefs, &gotFacts, &gotArtifacts, &gotVersions, &settled, &inputTokens, &outputTokens, &cachedTokens); err != nil {
		t.Fatal(err)
	}
	if gotRefs != refs || gotFacts != facts || gotArtifacts != artifacts || gotVersions != versions ||
		settled != tokens || inputTokens != int64(facts)*100 || outputTokens != int64(facts)*50 || cachedTokens != 0 {
		t.Fatalf("refs=%d facts=%d artifacts=%d versions=%d settled=%d usage=%d/%d/%d; want %d/%d/%d/%d/%d",
			gotRefs, gotFacts, gotArtifacts, gotVersions, settled, inputTokens, outputTokens, cachedTokens,
			refs, facts, artifacts, versions, tokens)
	}
}

func (f advanceRecoveryFixture) assertGate(t *testing.T, attached bool) {
	t.Helper()
	ctx := context.Background()
	var state, slot, locator, hash, result string
	if err := workdb.WithWorkerOrgContext(ctx, f.pool, flowOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT gate_state, receipt_slot_id::text, COALESCE(receipt_ref,''),
		 COALESCE(receipt_hash,''), COALESCE(receipt_result,'') FROM work.dispatch_delivery WHERE org_id=$1 AND operation_id=$2`,
			flowOrg, f.input.Execution.OperationID).Scan(&state, &slot, &locator, &hash, &result)
	}); err != nil {
		t.Fatal(err)
	}
	wantState, wantLocator, wantHash, wantResult := "consumed", "", "", ""
	if attached {
		wantState, wantLocator, wantHash, wantResult = "receipt_recorded", f.manifest.ReceiptLocator, f.manifest.ReceiptHash, "success"
	}
	if state != wantState || slot != f.manifest.ReceiptSlotID || locator != wantLocator || hash != wantHash || result != wantResult {
		t.Fatalf("gate = %q %q %q %q %q", state, slot, locator, hash, result)
	}
}

func (f advanceRecoveryFixture) assertUnfinished(t *testing.T, refs int) {
	t.Helper()
	f.assertCounts(t, refs, 0, 0, 0, 0)
	f.assertGate(t, false)
	head := readAdvanceHeadRow(t, f.pool, flowOrg, flowRun)
	if head.Revision != 0 || head.Ref != f.input.Head.Ref || head.Hash != f.input.Head.Hash {
		t.Fatalf("unfinished head = %#v", head)
	}
}

func (f advanceRecoveryFixture) assertFinished(t *testing.T, output runflow.AdvanceFinishOutput) {
	t.Helper()
	if output.Status != runflow.AdvanceStatusSucceeded || output.HeadRevision != 1 || output.ArtifactID == "" || output.VersionNo != 1 {
		t.Fatalf("finish = %#v", output)
	}
	f.assertCounts(t, 2, 1, 1, 1, 150)
	f.assertGate(t, true)
	for _, want := range []contentref.Reference{
		{RefID: f.manifest.AnswerRefID, Kind: contentref.KindAnswer, ContentRef: f.manifest.AnswerLocator, ContentHash: f.manifest.AnswerHash, Bytes: f.manifest.AnswerBytes},
		{RefID: f.manifest.ReceiptSlotID, Kind: contentref.KindReceipt, ContentRef: f.manifest.ReceiptLocator, ContentHash: f.manifest.ReceiptBodyHash, Bytes: f.manifest.ReceiptBytes},
	} {
		got, err := contentref.NewRegistry(f.pool).Resolve(context.Background(), flowOrg, want.RefID)
		if err != nil || got.Kind != want.Kind || got.ContentRef != want.ContentRef || got.ContentHash != want.ContentHash || got.Bytes != want.Bytes ||
			got.ExecutionID != f.input.Execution.ExecutionID || got.TaskID != flowTask || got.RunID != flowRun ||
			got.WriterKind != contentref.WriterEgress || got.SlotState != contentref.SlotCommitted {
			t.Fatalf("restored reference = %#v, %v", got, err)
		}
	}
	head := readAdvanceHeadRow(t, f.pool, flowOrg, flowRun)
	if head.Revision != 1 || head.Ref != output.HeadRef || head.Hash != output.HeadHash || head.ExecutionID != f.input.Execution.ExecutionID {
		t.Fatalf("finished head = %#v", head)
	}
	state := loadAdvanceState(t, f.pool, f.store, flowOrg, canonical.Reference{RefID: head.Ref, Hash: head.Hash})
	if state.Phase != canonical.PhaseFinished || state.Artifact == nil ||
		*state.Artifact != (canonical.Reference{RefID: f.manifest.AnswerRefID, Hash: f.manifest.AnswerHash}) ||
		len(state.CompletedModels) != 1 || state.CompletedModels[0].Receipt != (canonical.Reference{RefID: f.manifest.ReceiptSlotID, Hash: f.manifest.ReceiptHash}) {
		t.Fatalf("finished state = %#v", state)
	}
	var locator, hash, publication string
	if err := workdb.WithWorkerOrgContext(context.Background(), f.pool, flowOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT content_ref, content_hash, state FROM work.artifact_version WHERE org_id=$1 AND artifact_id=$2 AND version_no=$3`,
			flowOrg, output.ArtifactID, output.VersionNo).Scan(&locator, &hash, &publication)
	}); err != nil || locator != f.manifest.AnswerLocator || hash != f.manifest.AnswerHash || publication != "published" {
		t.Fatalf("artifact = %q %q %q, %v", locator, hash, publication, err)
	}
}

func TestAdvanceOutputRecoveryRestoresAndReplays(t *testing.T) {
	f := newAdvanceRecoveryFixture(t)
	first, err := f.finish(f.store)
	if err != nil {
		t.Fatal(err)
	}
	f.assertFinished(t, first)
	replay, err := f.finish(f.store)
	if err != nil || replay != first {
		t.Fatalf("replay = %#v, %v; first = %#v", replay, err, first)
	}
	f.assertFinished(t, replay)
}

// Only the selected locator is affected; all other store operations remain real.
type advanceRecoveryGetFault struct {
	content.Store
	locator string
	corrupt bool
	hits    int
	skip    int
	err     error
}

func (s *advanceRecoveryGetFault) Get(ctx context.Context, orgID, locator string) ([]byte, error) {
	if locator != s.locator {
		return s.Store.Get(ctx, orgID, locator)
	}
	s.hits++
	if s.hits <= s.skip {
		return s.Store.Get(ctx, orgID, locator)
	}
	if s.err != nil {
		return nil, s.err
	}
	if !s.corrupt {
		return nil, errors.New("injected output locator unavailable")
	}
	body, err := s.Store.Get(ctx, orgID, locator)
	if err != nil {
		return nil, err
	}
	body = append([]byte(nil), body...)
	body[0] ^= 1 // Preserve length, violate only the expected body hash.
	return body, nil
}

func TestAdvanceOutputRecoveryUnavailableRetriesSameInput(t *testing.T) {
	for _, target := range []string{"answer", "receipt"} {
		t.Run(target, func(t *testing.T) {
			f := newAdvanceRecoveryFixture(t)
			locator := f.manifest.AnswerLocator
			if target == "receipt" {
				locator = f.manifest.ReceiptLocator
			}
			fault := &advanceRecoveryGetFault{Store: f.store, locator: locator}
			_, err := f.finish(fault)
			var appErr *temporal.ApplicationError
			if !errors.As(err, &appErr) || appErr.Type() != runflow.AdvanceErrRecoveryUnavailable || appErr.NonRetryable() || fault.hits != 1 {
				t.Fatalf("Get failure = %v, hits=%d; want retryable recovery type", err, fault.hits)
			}
			f.assertUnfinished(t, 0)
			// The input and persisted manifest are unchanged; only storage recovers.
			finished, err := f.finish(f.store)
			if err != nil {
				t.Fatal(err)
			}
			f.assertFinished(t, finished)
			replay, err := f.finish(f.store)
			if err != nil || replay != finished {
				t.Fatalf("recovered replay = %#v, %v", replay, err)
			}
			f.assertFinished(t, replay)
		})
	}
}

func TestAdvanceOutputRecoveryFailureAfterConfirmation(t *testing.T) {
	for _, target := range []string{"answer", "receipt", "head"} {
		t.Run(target, func(t *testing.T) {
			f := newAdvanceRecoveryFixture(t)
			locator, skip := f.manifest.AnswerLocator, 1
			if target == "receipt" {
				locator, skip = f.manifest.ReceiptLocator, 2
			}
			if target == "head" {
				ref, err := contentref.NewRegistry(f.pool).Resolve(context.Background(), flowOrg, f.input.Head.Ref)
				if err != nil {
					t.Fatal(err)
				}
				locator, skip = ref.ContentRef, 0
			}
			fault := &advanceRecoveryGetFault{Store: f.store, locator: locator, skip: skip}
			_, err := f.finish(fault)
			var app *temporal.ApplicationError
			if !errors.As(err, &app) || app.Type() != runflow.AdvanceErrRecoveryUnavailable || app.NonRetryable() || fault.hits != skip+1 {
				t.Fatalf("post-confirmation failure=%v hits=%d", err, fault.hits)
			}
			var n int
			if err := f.admin.QueryRow(context.Background(), `SELECT count(*) FROM work.operation_usage_fact WHERE org_id=$1 AND operation_id=$2`, flowOrg, f.input.Execution.OperationID).Scan(&n); err != nil || n != 1 {
				t.Fatalf("confirmed usage=%d err=%v", n, err)
			}
			finished, err := f.finish(f.store)
			if err != nil {
				t.Fatal(err)
			}
			f.assertFinished(t, finished)
			replay, err := f.finish(f.store)
			if err != nil || replay != finished {
				t.Fatalf("replay=%+v err=%v", replay, err)
			}
			f.assertFinished(t, replay)
		})
	}
}

func TestAdvanceOutputRecoveryPreservesCancellation(t *testing.T) {
	for _, target := range []string{"answer_restore", "receipt_restore", "intent", "answer_confirmed", "receipt_confirmed", "head"} {
		t.Run(target, func(t *testing.T) {
			f := newAdvanceRecoveryFixture(t)
			locator, skip := f.manifest.AnswerLocator, 0
			switch target {
			case "receipt_restore":
				locator = f.manifest.ReceiptLocator
			case "answer_confirmed":
				skip = 1
			case "receipt_confirmed":
				locator, skip = f.manifest.ReceiptLocator, 2
			case "head":
				ref, err := contentref.NewRegistry(f.pool).Resolve(context.Background(), flowOrg, f.input.Head.Ref)
				if err != nil {
					t.Fatal(err)
				}
				locator = ref.ContentRef
			case "intent":
				// The Finisher reads the intent by its stored locator directly (no
				// registry resolve), so the fault must target runtime_execution.intent_ref.
				if err := f.admin.QueryRow(context.Background(),
					`SELECT intent_ref FROM work.runtime_execution WHERE org_id=$1 AND execution_id=$2`,
					flowOrg, f.input.Execution.ExecutionID).Scan(&locator); err != nil {
					t.Fatal(err)
				}
			}
			fault := &advanceRecoveryGetFault{Store: f.store, locator: locator, skip: skip, err: context.Canceled}
			_, err := f.finish(fault)
			if !temporal.IsCanceledError(err) || fault.hits != skip+1 {
				t.Fatalf("cancellation=%v hits=%d want %d", err, fault.hits, skip+1)
			}
		})
	}
}

func TestOutputRecoveryLookupFailureDoesNotAssertSuccess(t *testing.T) {
	config, err := pgxpool.ParseConfig("postgres://unused:unused@localhost/unused?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	config.BeforeConnect = func(context.Context, *pgx.ConnConfig) error { return context.DeadlineExceeded }
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	err = (&egress.OutputRecovery{Pool: pool}).Restore(context.Background(), flowOrg, newUUID(t))
	if !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, egress.ErrOutputRecoveryUnavailable) {
		t.Fatalf("unproven success classified as recovery: %v", err)
	}
}

func TestAdvanceOutputRecoveryInvalidIsNotRetryable(t *testing.T) {
	for _, target := range []string{"answer_hash", "receipt_hash", "tombstone"} {
		t.Run(target, func(t *testing.T) {
			f := newAdvanceRecoveryFixture(t)
			store, refs := f.store, 0
			if target == "tombstone" {
				// Only this negative control registers an answer after Stage, so a
				// real domain tombstone exists. The receipt remains absent/unattached.
				registry := contentref.NewRegistry(f.pool)
				m := f.manifest
				if err := registry.Register(context.Background(), contentref.Reference{
					RefID: m.AnswerRefID, OrgID: flowOrg, TaskID: flowTask, RunID: flowRun,
					ExecutionID: m.ExecutionID, Kind: contentref.KindAnswer,
					LogicalSlot: "answer:" + m.ExecutionID + ":" + m.LogicalKey, ObjectVersion: "v1",
					ContentRef: m.AnswerLocator, ContentHash: m.AnswerHash, Bytes: m.AnswerBytes,
					WriterKind: contentref.WriterEgress, SlotState: contentref.SlotCommitted,
				}); err != nil {
					t.Fatal(err)
				}
				if changed, err := registry.Tombstone(context.Background(), flowOrg, m.AnswerRefID, "retention_expired"); err != nil || !changed {
					t.Fatalf("tombstone = %t, %v", changed, err)
				}
				refs = 1
			} else {
				locator := f.manifest.AnswerLocator
				if target == "receipt_hash" {
					locator = f.manifest.ReceiptLocator
				}
				store = &advanceRecoveryGetFault{Store: f.store, locator: locator, corrupt: true}
			}
			// Check both the recovery error identity and its activity projection.
			if err := (&egress.OutputRecovery{Pool: f.pool, Content: store}).Restore(context.Background(), flowOrg, f.input.Execution.OperationID); !errors.Is(err, egress.ErrOutputRecoveryInvalid) {
				t.Fatalf("invalid recovery = %v", err)
			}
			finished, err := f.finish(store)
			if err != nil || finished.Status != runflow.AdvanceStatusFailed || finished.ErrCode == "" || finished.ErrCode == runflow.AdvanceErrRecoveryUnavailable {
				t.Fatalf("invalid output must be a domain failure, not retryable recovery: %#v, %v", finished, err)
			}
			f.assertUnfinished(t, refs)
			for _, id := range []string{f.manifest.AnswerRefID, f.manifest.ReceiptSlotID} {
				if _, err := contentref.NewRegistry(f.pool).Resolve(context.Background(), flowOrg, id); !errors.Is(err, contentref.ErrNotFound) {
					t.Fatalf("invalid output became readable: %s, %v", id, err)
				}
			}
		})
	}
}
