package runflow_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/providerctx"
	"github.com/we-meet/work/internal/runflow"
	"github.com/we-meet/work/internal/testpg"
)

type advanceTemplateSource struct {
	body []byte
	hash string
}

func (s advanceTemplateSource) Lookup(id string, version int) ([]byte, string, bool) {
	if id != "summary" || version != 1 {
		return nil, "", false
	}
	return s.body, s.hash, true
}

func newAdvanceActivities(pool *pgxpool.Pool, store content.Store) *runflow.Activities {
	body := []byte("You summarise meeting notes.")
	digest := sha256.Sum256(body)
	return &runflow.Activities{
		Pool: pool, Content: store,
		Templates:  advanceTemplateSource{body: body, hash: "sha256:" + hex.EncodeToString(digest[:])},
		Providers:  &providerctx.Resolver{Pool: pool},
		AccountKey: "default", QuotaPeriod: flowPeriod, ConsumerID: "worker-test",
		Now: time.Now,
	}
}

// seedAdvanceTask extends the legacy fixture with the frozen route parameters
// and the active provider configuration the advance path resolves.
func seedAdvanceTask(t *testing.T, dbName string, store content.Store) {
	t.Helper()
	seedTaskWithInput(t, dbName, store, 1000000)
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		UPDATE work.capability_snapshot
		SET model_route = '{"parameters":{"maxOutputTokens":2048,"temperatureMilli":500,"outputFormat":"markdown"}}'::jsonb
		WHERE id = '` + flowSnap + `';
		INSERT INTO work.provider_credential
		  (org_id, provider, mode, role_ref, secret_fingerprint, created_by)
		VALUES ('` + flowOrg + `', 'aliyun', 'sts_role', 'acs:ram::123:role/work',
		        'fp-test', 'advance-test');
		INSERT INTO work.provider_access_config
		  (org_id, revision, provider, model, region, endpoint, credential_mode,
		   credential_id, created_by, state)
		SELECT '` + flowOrg + `', 1, 'aliyun', 'qwen-test', 'cn-beijing',
		       'https://example.invalid', 'sts_role', id, 'advance-test', 'active'
		FROM work.provider_credential WHERE org_id = '` + flowOrg + `';
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
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

type advanceHeadRow struct {
	Revision    int64
	Ref         string
	Hash        string
	Runtime     string
	ExecutionID string
}

func readAdvanceHeadRow(t *testing.T, pool *pgxpool.Pool, org, runID string) advanceHeadRow {
	t.Helper()
	var row advanceHeadRow
	if err := workdb.WithWorkerOrgContext(context.Background(), pool, org, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `
			SELECT checkpoint_revision, checkpoint_ref, checkpoint_hash,
			       runtime_version, committed_execution_id::text
			FROM work.read_runtime_checkpoint_head($1, $2)`,
			org, runID,
		).Scan(&row.Revision, &row.Ref, &row.Hash, &row.Runtime, &row.ExecutionID)
	}); err != nil {
		t.Fatal(err)
	}
	return row
}

func loadAdvanceState(t *testing.T, pool *pgxpool.Pool, store content.Store,
	org string, ref canonical.Reference,
) canonical.CanonicalState {
	t.Helper()
	registry := contentref.NewRegistry(pool)
	current, err := registry.Resolve(context.Background(), org, ref.RefID)
	if err != nil {
		t.Fatal(err)
	}
	body, err := store.Get(context.Background(), org, current.ContentRef)
	if err != nil {
		t.Fatal(err)
	}
	state, err := canonical.ParseCanonicalState(body)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := state.Hash()
	if err != nil || hash != ref.Hash {
		t.Fatalf("state hash = %s, %s, want %s", hash, err, ref.Hash)
	}
	return state
}

type egressSeed struct {
	OrgID          string
	TaskID         string
	RunID          string
	SnapshotID     string
	RuntimeVersion string
	ExecutionID    string
	OperationID    string
	AttemptID      string
	RequestHash    string
	Fence          int64
	HolderID       string
}

// seedAdvanceEgress writes the trusted answer, receipt, consumed gate and
// receipt binding through the signed domain commands, exactly as the egress
// path does after the parent claimed the fragment.
func seedAdvanceEgress(
	t *testing.T, pool *pgxpool.Pool, store content.Store, seed egressSeed,
) canonical.Reference {
	t.Helper()
	ctx := context.Background()
	if seed.HolderID == "" {
		seed.HolderID = "work-fake-parent"
	}
	var state string
	if err := workdb.WithWorkerOrgContext(ctx, pool, seed.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.claim_runtime_execution($1, $2, $3)`,
			seed.OrgID, seed.ExecutionID, seed.HolderID).Scan(&state)
	}); err != nil {
		t.Fatal(err)
	}
	if state != "claimed" && state != "already_claimed" {
		t.Fatalf("claim state = %q", state)
	}

	answer := []byte("The meeting summary.")
	answerObject, err := store.Put(ctx, seed.OrgID, answer)
	if err != nil {
		t.Fatal(err)
	}
	answerRefID := newUUID(t)
	registry := contentref.NewRegistry(pool)
	if err := registry.Register(ctx, contentref.Reference{
		RefID: answerRefID, OrgID: seed.OrgID, TaskID: seed.TaskID, RunID: seed.RunID,
		ExecutionID: seed.ExecutionID, Kind: contentref.KindAnswer,
		LogicalSlot: "answer:" + seed.ExecutionID + ":model:1", ObjectVersion: "v1",
		ContentRef: answerObject.ContentRef, ContentHash: answerObject.Hash,
		Bytes: answerObject.Bytes, WriterKind: contentref.WriterEgress,
		SlotState: contentref.SlotCommitted,
	}); err != nil {
		t.Fatal(err)
	}

	usage := canonical.Usage{
		Source: canonical.UsageProvider, InputTokens: canonical.Int64(100),
		OutputTokens: canonical.Int64(50), CachedInputTokens: canonical.Int64(0),
	}
	document := canonical.ModelReceipt{
		ReceiptID: newUUID(t),
		Binding: canonical.Binding{
			OrgID: seed.OrgID, TaskID: seed.TaskID, RunID: seed.RunID,
			SnapshotID: seed.SnapshotID, RuntimeVersion: seed.RuntimeVersion,
		},
		LogicalKey:        canonical.LogicalKey1,
		OperationID:       seed.OperationID,
		DispatchAttemptID: seed.AttemptID,
		ExecutionID:       seed.ExecutionID,
		RequestHash:       seed.RequestHash,
		WriterGatewayID:   newUUID(t),
		RecordedAtUnixMs:  time.Now().UnixMilli(),
		Outcome:           canonical.OutcomeSucceeded,
		Content:           &canonical.Reference{RefID: answerRefID, Hash: answerObject.Hash},
		ContentBytes:      answerObject.Bytes,
		Usage:             usage,
	}
	receiptHash, err := document.Hash()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := document.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	receiptObject, err := store.Put(ctx, seed.OrgID, raw)
	if err != nil {
		t.Fatal(err)
	}
	receiptSlotID := newUUID(t)
	if err := registry.Register(ctx, contentref.Reference{
		RefID: receiptSlotID, OrgID: seed.OrgID, TaskID: seed.TaskID, RunID: seed.RunID,
		ExecutionID: seed.ExecutionID, Kind: contentref.KindReceipt,
		LogicalSlot: "receipt:" + seed.ExecutionID + ":model:1", ObjectVersion: "v1",
		ContentRef: receiptObject.ContentRef, ContentHash: receiptHash,
		Bytes: receiptObject.Bytes, WriterKind: contentref.WriterEgress,
		SlotState: contentref.SlotCommitted,
	}); err != nil {
		t.Fatal(err)
	}

	var consumed []byte
	if err := workdb.WithWorkerOrgContext(ctx, pool, seed.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT work.consume_dispatch_delivery($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			seed.OrgID, seed.OperationID, seed.ExecutionID, seed.HolderID, seed.AttemptID,
			seed.RequestHash, seed.Fence, "fake-gateway:1", receiptSlotID,
		).Scan(&consumed)
	}); err != nil {
		t.Fatal(err)
	}
	var decision struct {
		Outcome string `json:"outcome"`
	}
	if err := json.Unmarshal(consumed, &decision); err != nil || decision.Outcome != "won" {
		t.Fatalf("consume decision = %s, %v", consumed, err)
	}
	if err := workdb.WithWorkerOrgContext(ctx, pool, seed.OrgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			SELECT work.attach_dispatch_receipt($1, $2, $3, $4, $5, 'success')`,
			seed.OrgID, seed.OperationID, receiptSlotID, receiptObject.ContentRef, receiptHash)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return canonical.Reference{RefID: receiptSlotID, Hash: receiptHash}
}

func TestAdvanceEnsureHeadCreatesRevisionZeroAndReplays(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedAdvanceTask(t, dbName, store)
	activities := newAdvanceActivities(pool, store)
	ctx := context.Background()

	prepared, err := activities.PrepareAdvance(ctx, runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	if prepared.RunState != "active" || prepared.TaskID != flowTask || prepared.TemplateID != "summary" {
		t.Fatalf("prepared = %#v", prepared)
	}
	first, err := activities.EnsureAdvanceHead(ctx, prepared)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 0 || first.Ref == "" || first.Hash == "" {
		t.Fatalf("first head = %#v", first)
	}
	second, err := activities.EnsureAdvanceHead(ctx, prepared)
	if err != nil {
		t.Fatal(err)
	}
	if second.Ref != first.Ref || second.Hash != first.Hash || second.Revision != 0 {
		t.Fatalf("replay head = %#v, first = %#v", second, first)
	}
	row := readAdvanceHeadRow(t, pool, flowOrg, flowRun)
	if row.Revision != 0 || row.Ref != first.Ref || row.Hash != first.Hash {
		t.Fatalf("head row = %#v", row)
	}
	state := loadAdvanceState(t, pool, store, flowOrg, canonical.Reference{RefID: row.Ref, Hash: row.Hash})
	if state.Revision != 0 || state.Phase != canonical.PhaseReady || state.Previous != nil ||
		len(state.CompletedModels) != 0 || state.Pending != nil || state.Artifact != nil {
		t.Fatalf("revision 0 = %#v", state)
	}
	if state.Binding.OrgID != flowOrg || state.Binding.TaskID != flowTask ||
		state.Binding.RunID != flowRun || state.Binding.SnapshotID != flowSnap {
		t.Fatalf("binding = %#v", state.Binding)
	}
}

func TestAdvancePrepareExecutionRegistersAndFreezesIdempotently(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedAdvanceTask(t, dbName, store)
	activities := newAdvanceActivities(pool, store)
	ctx := context.Background()
	prepared, err := activities.PrepareAdvance(ctx, runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	head, err := activities.EnsureAdvanceHead(ctx, prepared)
	if err != nil {
		t.Fatal(err)
	}
	first, err := activities.PrepareAdvanceExecution(ctx, runflow.PrepareExecutionInput{
		Prepared: prepared, Head: head,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.ExecutionID == "" || first.OperationID == "" || first.AttemptID == "" ||
		first.IntentRef == "" || first.IntentHash != first.RequestHash ||
		first.DeadlineUnixMs <= time.Now().UnixMilli() {
		t.Fatalf("execution = %#v", first)
	}
	second, err := activities.PrepareAdvanceExecution(ctx, runflow.PrepareExecutionInput{
		Prepared: prepared, Head: head,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.ExecutionID != first.ExecutionID || second.OperationID != first.OperationID ||
		second.AttemptID != first.AttemptID || second.IntentRef != first.IntentRef {
		t.Fatalf("replay = %#v, first = %#v", second, first)
	}
	registry := contentref.NewRegistry(pool)
	intentRef, err := registry.Resolve(ctx, flowOrg, first.IntentRef)
	if err != nil {
		t.Fatal(err)
	}
	if intentRef.Kind != contentref.KindModelRequest || intentRef.ExecutionID != first.ExecutionID {
		t.Fatalf("intent reference = %#v", intentRef)
	}
	intentBody, err := store.Get(ctx, flowOrg, intentRef.ContentRef)
	if err != nil {
		t.Fatal(err)
	}
	request, err := canonical.ParseModelRequest(intentBody)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := request.Hash()
	if err != nil || hash != first.IntentHash {
		t.Fatalf("request hash = %s, %v", hash, err)
	}
	if request.Route.Provider != "aliyun" || request.Route.CompatProfileVersion != providerctx.CompatProfileVersion ||
		request.Route.ConfigRevision != "1" {
		t.Fatalf("route = %#v", request.Route)
	}
}

func TestAdvanceFinishCommitsRevisionOneAndPublishesArtifact(t *testing.T) {
	pool, dbName := newFlowDB(t)
	store := newFlowContent(t)
	seedAdvanceTask(t, dbName, store)
	activities := newAdvanceActivities(pool, store)
	ctx := context.Background()
	prepared, err := activities.PrepareAdvance(ctx, runflow.Input{RunID: flowRun, OrgID: flowOrg})
	if err != nil {
		t.Fatal(err)
	}
	head, err := activities.EnsureAdvanceHead(ctx, prepared)
	if err != nil {
		t.Fatal(err)
	}
	execution, err := activities.PrepareAdvanceExecution(ctx, runflow.PrepareExecutionInput{
		Prepared: prepared, Head: head,
	})
	if err != nil {
		t.Fatal(err)
	}
	seedAdvanceEgress(t, pool, store, egressSeed{
		OrgID: prepared.OrgID, TaskID: prepared.TaskID, RunID: prepared.RunID,
		SnapshotID: prepared.SnapshotID, RuntimeVersion: prepared.RuntimeVersion,
		ExecutionID: execution.ExecutionID, OperationID: execution.OperationID,
		AttemptID: execution.AttemptID, RequestHash: execution.RequestHash,
		Fence: prepared.Fence,
	})
	finished, err := activities.FinishAdvance(ctx, runflow.AdvanceFinishInput{
		Prepared: prepared, Head: head, Execution: execution,
	})
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != runflow.AdvanceStatusSucceeded || finished.HeadRevision != 1 ||
		finished.HeadRef == "" || finished.ArtifactID == "" || finished.VersionNo != 1 {
		t.Fatalf("finished = %#v", finished)
	}
	row := readAdvanceHeadRow(t, pool, flowOrg, flowRun)
	if row.Revision != 1 || row.Ref != finished.HeadRef || row.Hash != finished.HeadHash ||
		row.ExecutionID != execution.ExecutionID {
		t.Fatalf("head row = %#v", row)
	}
	base := loadAdvanceState(t, pool, store, flowOrg, canonical.Reference{RefID: head.Ref, Hash: head.Hash})
	next := loadAdvanceState(t, pool, store, flowOrg, canonical.Reference{RefID: row.Ref, Hash: row.Hash})
	if err := canonical.ValidateSuccession(base, canonical.Reference{RefID: head.Ref, Hash: head.Hash}, next); err != nil {
		t.Fatalf("succession: %v", err)
	}
	if next.Phase != canonical.PhaseFinished || next.Artifact == nil ||
		len(next.CompletedModels) != 1 ||
		next.CompletedModels[0].LogicalKey != canonical.LogicalKey1 ||
		next.CompletedModels[0].Receipt.Hash == "" {
		t.Fatalf("revision 1 = %#v", next)
	}
	var artifactHash, artifactRef, artifactState string
	if err := workdb.WithWorkerOrgContext(ctx, pool, flowOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT av.content_hash, av.content_ref, av.state
			FROM work.artifact_version av
			WHERE av.org_id = $1 AND av.artifact_id = $2 AND av.version_no = $3`,
			flowOrg, finished.ArtifactID, finished.VersionNo,
		).Scan(&artifactHash, &artifactRef, &artifactState)
	}); err != nil {
		t.Fatal(err)
	}
	if artifactHash != next.Artifact.Hash || artifactRef == "" || artifactState != "published" {
		t.Fatalf("artifact = %s %s %s", artifactHash, artifactRef, artifactState)
	}
	if err := activities.FinishRun(ctx, runflow.FinishRunInput{
		RunID: flowRun, OrgID: flowOrg, Outcome: "succeeded",
	}); err != nil {
		t.Fatal(err)
	}
	var runState string
	if err := workdb.WithWorkerOrgContext(ctx, pool, flowOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM work.run WHERE id = $1 AND org_id = $2`,
			flowRun, flowOrg).Scan(&runState)
	}); err != nil {
		t.Fatal(err)
	}
	if runState != "succeeded" {
		t.Fatalf("run state = %q", runState)
	}

	// Replaying the finish activity after the commit is idempotent.
	replay, err := activities.FinishAdvance(ctx, runflow.AdvanceFinishInput{
		Prepared: prepared, Head: head, Execution: execution,
	})
	if err != nil {
		t.Fatal(err)
	}
	if replay.Status != runflow.AdvanceStatusSucceeded || replay.HeadRevision != 1 {
		t.Fatalf("finish replay = %#v", replay)
	}
}
