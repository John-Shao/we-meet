package egressservice

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/authz"
	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/capability"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	"github.com/we-meet/work/internal/credentials"
	"github.com/we-meet/work/internal/egress"
	"github.com/we-meet/work/internal/providerctx"
	"github.com/we-meet/work/internal/runtime"
	"github.com/we-meet/work/internal/testpg"
)

// These tests exercise the signed thin-wire listener against a real PostgreSQL
// instance. The capability is issued by internal/capability, the gate and
// receipt attach are the landed authorization commands, and every content
// reference is registered in work.content_reference bound to the execution.
// Only the provider itself is faked.

var (
	pgAdmin      *pgx.Conn
	pgDBName     string
	pgPool       *pgxpool.Pool
	pgContent    *content.Local
	pgContentDir string
	pgMaster     = bytes.Repeat([]byte{0x42}, 32)
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
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_egressservice_test")
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
	pgContentDir, err = os.MkdirTemp("", "work-egress-content")
	if err != nil {
		fmt.Fprintf(os.Stderr, "create content directory: %v\n", err)
		os.Exit(1)
	}
	store, err := content.NewLocal(pgMaster, pgContentDir, 1)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open content store: %v\n", err)
		os.Exit(1)
	}
	pgAdmin, pgDBName, pgPool, pgContent = dbAdmin, dbName, pool, store

	code := m.Run()

	pool.Close()
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cleanupCancel()
	_ = dbAdmin.Close(cleanupCtx)
	_ = testpg.DropDatabase(cleanupCtx, admin, dbName)
	_ = admin.Close(cleanupCtx)
	_ = os.RemoveAll(pgContentDir)
	os.Exit(code)
}

func requirePG(t *testing.T) {
	t.Helper()
	if pgAdmin == nil || pgPool == nil || pgContent == nil {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
}

func pgContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func pgUUID(t *testing.T) string {
	t.Helper()
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		t.Fatal(err)
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

func quoteSQL(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

type pgTenant struct {
	org        string
	subject    string
	taskID     string
	runID      string
	snapshotID string
	planExec   string
	planHolder string
	execID     string
	holder     string
	opID       string
	attempt    string
	headRef    string
	headHash   string
	inputRef   string
	docRef     string
	docHash    string
}

// seedExecuteTenant creates one current Run with a claimed plan fragment, an
// authorized/dispatching Operation, a claimed execute fragment, the
// execution-bound input/template references and the frozen model_request
// reference. The operation id and dispatch attempt are derived from the
// database commands, never passed to the listener.
func seedExecuteTenant(t *testing.T, org string) *pgTenant {
	t.Helper()
	ctx := pgContext(t)
	tenant := &pgTenant{
		org:        org,
		subject:    "sub_" + org,
		taskID:     pgUUID(t),
		runID:      pgUUID(t),
		snapshotID: pgUUID(t),
		planExec:   pgUUID(t),
		planHolder: "holder-plan-" + pgUUID(t),
		execID:     pgUUID(t),
		holder:     "holder-exec-" + pgUUID(t),
		opID:       pgUUID(t),
		headRef:    "cp/0/" + org + "/" + pgUUID(t),
		headHash:   "sha256:" + strings.Repeat("1", 64),
	}
	inputBody := []byte("pg task input body")
	templateBody := []byte("pg system template")
	tenant.inputRef = pgUUID(t)
	templateRef := pgUUID(t)
	inputHash, err := canonical.BodyHash(inputBody)
	if err != nil {
		t.Fatal(err)
	}
	templateHash, err := canonical.BodyHash(templateBody)
	if err != nil {
		t.Fatal(err)
	}

	document := canonical.ModelRequest{
		Binding: canonical.Binding{
			OrgID: org, TaskID: tenant.taskID, RunID: tenant.runID,
			SnapshotID: tenant.snapshotID, RuntimeVersion: "pi-1",
		},
		LogicalKey: canonical.LogicalKey1,
		Input:      canonical.Reference{RefID: tenant.inputRef, Hash: inputHash},
		Template:   &canonical.Reference{RefID: templateRef, Hash: templateHash},
		Route: canonical.Route{
			Provider: canonical.ProviderAliyun, Model: testModel,
			ConfigRevision: "1", CompatProfileVersion: "compat-r0a-1",
		},
		Parameters: canonical.Parameters{
			MaxOutputTokens: 256, TemperatureMilli: 100,
			OutputFormat: canonical.OutputFormatMarkdown,
		},
	}
	docBytes, err := document.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	tenant.docHash, err = document.Hash()
	if err != nil {
		t.Fatal(err)
	}

	inputID := pgUUID(t)
	seed := fmt.Sprintf(`
		SET app.org_id = %[1]s;
		INSERT INTO work.org (id, status, home_region) VALUES (%[1]s, 'active', 'cn-north')
		ON CONFLICT (id) DO NOTHING;
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES (%[1]s, %[2]s, 'active', 'owner', true)
		ON CONFLICT (org_id, subject_id) DO NOTHING;
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%[3]s', %[1]s, %[2]s, 'input/%[3]s', '%[4]s', 18);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, input_id, title)
		VALUES ('%[5]s', %[1]s, %[2]s, 'open', '%[3]s', 'egress thin wire');
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		VALUES ('%[6]s', %[1]s, '%[5]s', 'v1', repeat('b', 64),
		        ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		UPDATE work.task SET snapshot_id = '%[6]s' WHERE id = '%[5]s';
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('%[7]s', %[1]s, '%[5]s', 1, 'active', '%[6]s', 'run:%[7]s', 'pi-1');
		UPDATE work.task SET active_run_id = '%[7]s', latest_run_id = '%[7]s'
		WHERE id = '%[5]s';
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state)
		VALUES ('%[8]s', %[1]s, '%[7]s', 'model:1', 'model', '%[9]s', 'authorized');
	`, quoteSQL(org), quoteSQL(tenant.subject), inputID, strings.Repeat("a", 64),
		tenant.taskID, tenant.snapshotID, tenant.runID, tenant.opID, tenant.docHash)
	if _, err := pgAdmin.Exec(ctx, seed); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}

	prepareExecute(t, tenant)

	inputPut, err := pgContent.Put(ctx, org, inputBody)
	if err != nil {
		t.Fatal(err)
	}
	registerReference(t, contentref.Reference{
		RefID: tenant.inputRef, OrgID: org, TaskID: tenant.taskID, RunID: tenant.runID,
		ExecutionID: tenant.execID, Kind: contentref.KindInput,
		LogicalSlot:   "input:" + tenant.execID + ":" + tenant.inputRef,
		ObjectVersion: "v1", ContentRef: inputPut.ContentRef, ContentHash: inputPut.Hash,
		Bytes: inputPut.Bytes, WriterKind: contentref.WriterControlPlane,
		SlotState: contentref.SlotCommitted,
	})
	templatePut, err := pgContent.Put(ctx, org, templateBody)
	if err != nil {
		t.Fatal(err)
	}
	registerReference(t, contentref.Reference{
		RefID: templateRef, OrgID: org, TaskID: tenant.taskID, RunID: tenant.runID,
		ExecutionID: tenant.execID, Kind: contentref.KindTemplate,
		LogicalSlot:   "template:" + tenant.execID + ":" + templateRef + ":v1",
		ObjectVersion: "v1", ContentRef: templatePut.ContentRef,
		ContentHash: templatePut.Hash, Bytes: templatePut.Bytes,
		WriterKind: contentref.WriterControlPlane, SlotState: contentref.SlotCommitted,
	})
	docPut, err := pgContent.Put(ctx, org, docBytes)
	if err != nil {
		t.Fatal(err)
	}
	tenant.docRef = pgUUID(t)
	registerReference(t, contentref.Reference{
		RefID: tenant.docRef, OrgID: org, TaskID: tenant.taskID, RunID: tenant.runID,
		ExecutionID: tenant.execID, Kind: contentref.KindModelRequest,
		LogicalSlot:   "model-request:" + tenant.execID + ":model:1",
		ObjectVersion: "v1", ContentRef: docPut.ContentRef, ContentHash: tenant.docHash,
		Bytes: docPut.Bytes, WriterKind: contentref.WriterControlPlane,
		SlotState: contentref.SlotCommitted,
	})
	seedManagedKeyProvider(t, org)
	return tenant
}

func prepareExecute(t *testing.T, tenant *pgTenant) {
	t.Helper()
	ctx := pgContext(t)
	var state string
	if err := pgAdmin.QueryRow(ctx,
		`SELECT work.register_runtime_execution($1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes')`,
		tenant.org, tenant.planExec, tenant.runID,
	).Scan(&state); err != nil {
		t.Fatalf("register plan: %v", err)
	}
	if err := pgAdmin.QueryRow(ctx,
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		tenant.org, tenant.planExec, tenant.planHolder,
	).Scan(&state); err != nil {
		t.Fatalf("claim plan: %v", err)
	}
	var revision int64
	if err := pgAdmin.QueryRow(ctx,
		`SELECT work.commit_runtime_checkpoint($1, $2, $3, NULL, NULL, NULL, $4, $5, 'pi-1')`,
		tenant.org, tenant.runID, tenant.planExec, tenant.headRef, tenant.headHash,
	).Scan(&revision); err != nil {
		t.Fatalf("commit plan head: %v", err)
	}
	var reservation string
	if err := pgAdmin.QueryRow(ctx,
		`SELECT work.reserve_quota($1, 'default', to_char(now(), 'YYYY-MM'), $2, 1000)::text`,
		tenant.org, tenant.opID,
	).Scan(&reservation); err != nil {
		t.Fatalf("reserve quota: %v", err)
	}
	if reservation == "" {
		t.Fatal("reserve quota returned an empty reservation")
	}
	if err := pgAdmin.QueryRow(ctx,
		`SELECT work.claim_dispatch($1, $2, 'consumer-1', 1)::text`,
		tenant.opID, tenant.org,
	).Scan(&tenant.attempt); err != nil {
		t.Fatalf("claim dispatch: %v", err)
	}
	intentHash := "sha256:" + strings.Repeat("2", 64)
	if err := pgAdmin.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'execute', 1, 'pi-1', now() + interval '10 minutes',
			$4, $5, $6, $7, $8, $9, $10)`,
		tenant.org, tenant.execID, tenant.runID, tenant.headRef, tenant.headHash,
		"intent/"+tenant.opID, intentHash, tenant.docHash, tenant.opID, tenant.attempt,
	).Scan(&state); err != nil {
		t.Fatalf("register execute: %v", err)
	}
	if state != "registered" {
		t.Fatalf("execute register state = %q", state)
	}
	if err := pgAdmin.QueryRow(ctx,
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		tenant.org, tenant.execID, tenant.holder,
	).Scan(&state); err != nil {
		t.Fatalf("claim execute: %v", err)
	}
	if state != "claimed" {
		t.Fatalf("execute claim state = %q", state)
	}
}

func registerReference(t *testing.T, reference contentref.Reference) {
	t.Helper()
	if err := contentref.NewRegistry(pgPool).Register(pgContext(t), reference); err != nil {
		t.Fatalf("register %s reference: %v", reference.Kind, err)
	}
}

// seedPlanTenant creates one current Run with a claimed, still-active plan
// fragment. It is used to prove that the work-egress audience cannot be used
// by plan mode.
func seedPlanTenant(t *testing.T, org string) *pgTenant {
	t.Helper()
	tenant := &pgTenant{
		org:        org,
		subject:    "sub_" + org,
		taskID:     pgUUID(t),
		runID:      pgUUID(t),
		snapshotID: pgUUID(t),
		planExec:   pgUUID(t),
		planHolder: "holder-plan-" + pgUUID(t),
	}
	tenant.execID = tenant.planExec
	tenant.holder = tenant.planHolder
	inputID := pgUUID(t)
	seed := fmt.Sprintf(`
		SET app.org_id = %[1]s;
		INSERT INTO work.org (id, status, home_region) VALUES (%[1]s, 'active', 'cn-north')
		ON CONFLICT (id) DO NOTHING;
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES (%[1]s, %[2]s, 'active', 'owner', true)
		ON CONFLICT (org_id, subject_id) DO NOTHING;
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%[3]s', %[1]s, %[2]s, 'input/%[3]s', '%[4]s', 18);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, input_id, title)
		VALUES ('%[5]s', %[1]s, %[2]s, 'open', '%[3]s', 'egress plan');
		INSERT INTO work.capability_snapshot
		  (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist,
		   model_route, scope_caps, manifest)
		VALUES ('%[6]s', %[1]s, '%[5]s', 'v1', repeat('b', 64),
		        ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		UPDATE work.task SET snapshot_id = '%[6]s' WHERE id = '%[5]s';
		INSERT INTO work.run
		  (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version)
		VALUES ('%[7]s', %[1]s, '%[5]s', 1, 'active', '%[6]s', 'run:%[7]s', 'pi-1');
		UPDATE work.task SET active_run_id = '%[7]s', latest_run_id = '%[7]s'
		WHERE id = '%[5]s';
	`, quoteSQL(org), quoteSQL(tenant.subject), inputID, strings.Repeat("a", 64),
		tenant.taskID, tenant.snapshotID, tenant.runID)
	if _, err := pgAdmin.Exec(pgContext(t), seed); err != nil {
		t.Fatalf("seed plan tenant: %v", err)
	}
	var state string
	if err := pgAdmin.QueryRow(pgContext(t),
		`SELECT work.register_runtime_execution($1, $2, $3, 'plan', 1, 'pi-1', now() + interval '10 minutes')`,
		tenant.org, tenant.planExec, tenant.runID,
	).Scan(&state); err != nil {
		t.Fatalf("register plan: %v", err)
	}
	if err := pgAdmin.QueryRow(pgContext(t),
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		tenant.org, tenant.planExec, tenant.planHolder,
	).Scan(&state); err != nil {
		t.Fatalf("claim plan: %v", err)
	}
	if state != "claimed" {
		t.Fatalf("plan claim state = %q", state)
	}
	return tenant
}

func seedManagedKeyProvider(t *testing.T, org string) {
	t.Helper()
	ctx := pgContext(t)
	const secret = "sk-pg-egress-secret-never-echo"
	ciphertext, fingerprint, err := credentials.Seal(pgMaster, org, []byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	var credentialID string
	if err := pgAdmin.QueryRow(ctx, `
		INSERT INTO work.provider_credential
		  (org_id, provider, mode, secret_ciphertext, secret_fingerprint, created_by)
		VALUES ($1, 'aliyun', 'managed_key', $2, $3, 'egress-pg-test')
		RETURNING id::text`,
		org, ciphertext, fingerprint,
	).Scan(&credentialID); err != nil {
		t.Fatalf("seed provider credential: %v", err)
	}
	if _, err := pgAdmin.Exec(ctx, `
		INSERT INTO work.provider_access_config
		  (org_id, revision, provider, model, region, endpoint,
		   credential_mode, credential_id, created_by)
		VALUES ($1, 1, 'aliyun', $2, 'cn-beijing', $3, 'managed_key', $4, 'egress-pg-test')`,
		org, testModel, testEndpoint, credentialID,
	); err != nil {
		t.Fatalf("seed provider access config: %v", err)
	}
}

type recordingCommands struct {
	commands     *authz.PGCommands
	caller       authz.Caller
	consumeCalls int
	attachCalls  int
	consumes     []authz.ExecutionConsumeRequest
	attaches     []authz.ReceiptRequest
}

func (c *recordingCommands) ConsumeByExecution(
	ctx context.Context, request authz.ExecutionConsumeRequest,
) (authz.ConsumeDecision, error) {
	c.consumeCalls++
	c.consumes = append(c.consumes, request)
	return c.commands.ConsumeByExecution(ctx, c.caller, request)
}

func (c *recordingCommands) Attach(ctx context.Context, request authz.ReceiptRequest) error {
	c.attachCalls++
	c.attaches = append(c.attaches, request)
	return c.commands.AttachDispatchReceipt(ctx, c.caller, request)
}

type pgHarness struct {
	server   *httptest.Server
	provider *fakeProvider
	factory  *fakeFactory
	commands *recordingCommands
}

func newPGHarness(t *testing.T) *pgHarness {
	t.Helper()
	harness := &pgHarness{
		provider: &fakeProvider{response: egressSuccess()},
	}
	harness.factory = &fakeFactory{provider: harness.provider}
	harness.commands = &recordingCommands{
		commands: &authz.PGCommands{Pool: pgPool},
		caller:   authz.Caller{Kind: authz.KindEgress, WorkloadID: "egress-workload-test"},
	}
	server, err := New(Config{GatewayID: testGateway}, Dependencies{
		Authorizer: capability.NewIssuer(pgPool),
		Providers:  &providerctx.Resolver{Pool: pgPool, Master: pgMaster},
		Commands:   harness.commands,
		References: contentref.NewRegistry(pgPool),
		Executions: &PGBindings{Pool: pgPool},
		Content:    pgContent,
		Factory:    harness.factory.build,
	})
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	harness.server = httptest.NewServer(server.Handler())
	t.Cleanup(harness.server.Close)
	return harness
}

func egressSuccess() egress.ProviderResponse {
	return egress.ProviderResponse{
		Answer:            []byte("pg provider answer"),
		ProviderRequestID: "provider-request-pg",
		Usage: runtime.Usage{
			Source:            runtime.UsageProvider,
			InputTokens:       canonical.Int64(5),
			OutputTokens:      canonical.Int64(7),
			CachedInputTokens: canonical.Int64(0),
		},
	}
}

func issueEgressCapability(t *testing.T, tenant *pgTenant) (string, int) {
	t.Helper()
	token, generation, err := capability.NewIssuer(pgPool).Issue(
		pgContext(t), tenant.org, tenant.execID, tenant.holder, capability.AudienceEgress, 20*time.Second)
	if err != nil {
		t.Fatalf("issue egress capability: %v", err)
	}
	return token, generation
}

func postInvoke(t *testing.T, base string, tenant *pgTenant, token string, generation int,
	refID, requestHash string,
) testResponse {
	t.Helper()
	body, err := json.Marshal(invokeEnvelope{
		ExecutionID: tenant.execID,
		RequestRef:  referenceEnvelope{RefID: refID, Hash: requestHash, Object: true},
		RequestHash: requestHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, base+InvokePath, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set(HeaderAuthorization, "Bearer "+token)
	request.Header.Set(HeaderOrg, tenant.org)
	request.Header.Set(HeaderExecution, tenant.execID)
	request.Header.Set(HeaderGeneration, fmt.Sprint(generation))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("invoke request: %v", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	result := testResponse{status: response.StatusCode, body: responseBody}
	if response.StatusCode == http.StatusOK {
		if err := json.Unmarshal(responseBody, &result.call); err != nil {
			t.Fatalf("decode response %q: %v", responseBody, err)
		}
	}
	return result
}

func gateFacts(t *testing.T, org, operationID string) (state, slot, receiptRef, receiptHash string) {
	t.Helper()
	if err := pgAdmin.QueryRow(pgContext(t), `
		SELECT gate_state, COALESCE(receipt_slot_id::text, ''),
		       COALESCE(receipt_ref, ''), COALESCE(receipt_hash, '')
		  FROM work.dispatch_delivery
		 WHERE org_id = $1 AND operation_id = $2`,
		org, operationID,
	).Scan(&state, &slot, &receiptRef, &receiptHash); err != nil {
		t.Fatalf("read gate: %v", err)
	}
	return state, slot, receiptRef, receiptHash
}

func TestThinWireHappyPathSendsOnceAndAttaches(t *testing.T) {
	requirePG(t)
	tenant := seedExecuteTenant(t, "org_egress_pg_happy")
	token, generation := issueEgressCapability(t, tenant)
	harness := newPGHarness(t)

	response := postInvoke(t, harness.server.URL, tenant, token, generation,
		tenant.docRef, tenant.docHash)
	requireOutcome(t, response, "succeeded")
	if !response.call.Sent || response.call.RequestHash != tenant.docHash ||
		response.call.GateState != "consumed" {
		t.Fatalf("outcome coordinates = %+v", response.call)
	}
	if harness.provider.calls != 1 || harness.commands.consumeCalls != 1 ||
		harness.commands.attachCalls != 1 {
		t.Fatalf("provider/consume/attach = %d/%d/%d, want 1/1/1",
			harness.provider.calls, harness.commands.consumeCalls, harness.commands.attachCalls)
	}
	if harness.factory.calls != 1 || harness.factory.endpoints[0] != testEndpoint {
		t.Fatalf("factory calls = %d endpoint = %v", harness.factory.calls, harness.factory.endpoints)
	}
	// Operation and attempt were derived from the execution row, never supplied
	// by the request.
	if consume := harness.commands.consumes[0]; consume.ExecutionID != tenant.execID ||
		consume.RequestHash != tenant.docHash {
		t.Fatalf("consume request = %+v", consume)
	}
	attach := harness.commands.attaches[0]
	if attach.OperationID != tenant.opID || attach.AttemptID != tenant.attempt ||
		attach.ExecutionID != tenant.execID ||
		attach.ReceiptResult != authz.ReceiptSucceeded ||
		attach.ProviderRequestID != "provider-request-pg" {
		t.Fatalf("attach request = %+v", attach)
	}

	if response.call.Receipt == nil ||
		response.call.Receipt.RefID != attach.ReceiptSlotID ||
		response.call.Receipt.Hash != attach.ReceiptHash ||
		response.call.Receipt.ContentRef == "" {
		t.Fatalf("receipt = %+v", response.call.Receipt)
	}
	if response.call.Content == nil ||
		response.call.Content.RefID != response.call.AnswerRefID ||
		response.call.Content.Bytes != int64(len("pg provider answer")) {
		t.Fatalf("content = %+v answerRefId = %q", response.call.Content, response.call.AnswerRefID)
	}
	if response.call.Usage == nil || response.call.Usage.Source != "provider" {
		t.Fatalf("usage = %+v", response.call.Usage)
	}

	state, slot, receiptRef, receiptHash := gateFacts(t, tenant.org, tenant.opID)
	if state != "receipt_recorded" || slot != response.call.Receipt.RefID ||
		receiptRef == "" || receiptHash != response.call.Receipt.Hash {
		t.Fatalf("gate = %s slot=%s ref=%q hash=%q", state, slot, receiptRef, receiptHash)
	}

	providerRequest := harness.provider.requests[0]
	if string(providerRequest.Messages.SystemTemplate) != "pg system template" ||
		string(providerRequest.Messages.Input) != "pg task input body" {
		t.Fatal("provider messages were not assembled from the registered objects")
	}
	for _, forbidden := range []string{
		"sk-pg-egress-secret-never-echo", "pg provider answer",
		"pg system template", "pg task input body", token,
	} {
		if bytes.Contains(response.body, []byte(forbidden)) {
			t.Fatalf("response leaked %q: %s", forbidden, response.body)
		}
	}
}

func TestThinWireRequestHashMismatchIsRefusedBeforeConsume(t *testing.T) {
	requirePG(t)
	tenant := seedExecuteTenant(t, "org_egress_pg_hash")
	token, generation := issueEgressCapability(t, tenant)
	harness := newPGHarness(t)

	response := postInvoke(t, harness.server.URL, tenant, token, generation,
		tenant.docRef, "sha256:"+strings.Repeat("d", 64))
	requireErrorCode(t, response, http.StatusUnprocessableEntity, codeRequestHashMismatch)
	if harness.commands.consumeCalls != 0 || harness.provider.calls != 0 {
		t.Fatalf("hash mismatch reached consume/provider: %d/%d",
			harness.commands.consumeCalls, harness.provider.calls)
	}
}

func TestThinWireRefusesWrongAudienceAndTombstone(t *testing.T) {
	requirePG(t)

	t.Run("wrong audience", func(t *testing.T) {
		tenant := seedPlanTenant(t, "org_egress_pg_audience")
		token, generation, err := capability.NewIssuer(pgPool).Issue(
			pgContext(t), tenant.org, tenant.planExec, tenant.planHolder,
			capability.AudienceContent, 20*time.Second)
		if err != nil {
			t.Fatalf("issue content capability: %v", err)
		}
		harness := newPGHarness(t)
		response := postInvoke(t, harness.server.URL, tenant, token, generation,
			pgUUID(t), "sha256:"+strings.Repeat("a", 64))
		requireErrorCode(t, response, http.StatusUnauthorized, codeCapabilityInvalid)
		if harness.provider.calls != 0 || harness.commands.consumeCalls != 0 {
			t.Fatal("wrong audience reached consume/provider")
		}
	})

	t.Run("tombstoned request reference", func(t *testing.T) {
		tenant := seedExecuteTenant(t, "org_egress_pg_tombstone")
		token, generation := issueEgressCapability(t, tenant)
		changed, err := contentref.NewRegistry(pgPool).Tombstone(
			pgContext(t), tenant.org, tenant.docRef, "test_tombstone")
		if err != nil || !changed {
			t.Fatalf("tombstone = %v/%v", changed, err)
		}
		harness := newPGHarness(t)
		response := postInvoke(t, harness.server.URL, tenant, token, generation,
			tenant.docRef, tenant.docHash)
		requireErrorCode(t, response, http.StatusNotFound, codeContentReferenceNotFound)
		if harness.provider.calls != 0 || harness.commands.consumeCalls != 0 {
			t.Fatal("tombstoned reference reached consume/provider")
		}
	})
}

func TestThinWireProvider5xxIsUnknownWithoutAttach(t *testing.T) {
	requirePG(t)
	tenant := seedExecuteTenant(t, "org_egress_pg_5xx")
	token, generation := issueEgressCapability(t, tenant)
	harness := newPGHarness(t)
	harness.provider.err = &egress.ProviderFailure{StatusCode: 502, Code: "server_error"}

	response := postInvoke(t, harness.server.URL, tenant, token, generation,
		tenant.docRef, tenant.docHash)
	requireOutcome(t, response, "unknown")
	if !response.call.Sent || response.call.Code != "server_error" {
		t.Fatalf("unknown result = %+v", response.call)
	}
	if response.call.Receipt != nil || response.call.Content != nil {
		t.Fatalf("unknown result carried receipt/content: %+v", response.call)
	}
	if harness.provider.calls != 1 || harness.commands.attachCalls != 0 {
		t.Fatalf("provider calls = %d attach = %d, want 1/0",
			harness.provider.calls, harness.commands.attachCalls)
	}
	state, slot, receiptRef, _ := gateFacts(t, tenant.org, tenant.opID)
	if state != "consumed" || slot == "" || receiptRef != "" {
		t.Fatalf("gate = %s slot=%s receipt_ref=%q", state, slot, receiptRef)
	}
}

func TestThinWireRefusesAPlanExecution(t *testing.T) {
	requirePG(t)
	tenant := seedPlanTenant(t, "org_egress_pg_plan")

	// The real issuer refuses the egress audience for a plan fragment.
	if _, _, err := capability.NewIssuer(pgPool).Issue(
		pgContext(t), tenant.org, tenant.planExec, tenant.planHolder,
		capability.AudienceEgress, 20*time.Second); err == nil {
		t.Fatal("issued a work-egress capability for a plan execution")
	}

	// Even a capability row forced into the table cannot authorize: the online
	// check applies the same plan/execute audience narrowing.
	token := "plan-egress-token-0123456789"
	digest := sha256.Sum256([]byte(token))
	if err := pgAdmin.QueryRow(pgContext(t), `
		INSERT INTO work.runtime_capability
		  (org_id, execution_id, holder_id, audience, generation, token_hash, expires_at)
		VALUES ($1, $2, $3, 'work-egress', 1, $4, now() + interval '5 minutes')
		RETURNING generation`,
		tenant.org, tenant.planExec, tenant.planHolder, hex.EncodeToString(digest[:]),
	).Scan(new(int)); err != nil {
		t.Fatalf("force capability row: %v", err)
	}

	harness := newPGHarness(t)
	response := postInvoke(t, harness.server.URL, tenant, token, 1,
		pgUUID(t), "sha256:"+strings.Repeat("a", 64))
	requireErrorCode(t, response, http.StatusUnauthorized, codeCapabilityInvalid)
	if harness.provider.calls != 0 || harness.commands.consumeCalls != 0 {
		t.Fatal("plan execution reached consume/provider")
	}
}
