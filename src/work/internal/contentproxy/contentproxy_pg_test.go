package contentproxy

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

	"github.com/we-meet/work/internal/capability"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	"github.com/we-meet/work/internal/testpg"
)

// These tests exercise the content proxy against a real PostgreSQL instance
// and a real local content store. Capabilities are issued by
// internal/capability and references are registered by internal/contentref, so
// the proxy is checked against the landed commands rather than a mock of them.

var (
	pgAdmin *pgx.Conn
	pgDB    string
	pgPool  *pgxpool.Pool
	pgStore *content.Local
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
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_contentproxy_test")
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
	contentDir, err := os.MkdirTemp("", "work-contentproxy-test-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "create content directory: %v\n", err)
		os.Exit(1)
	}
	store, err := content.NewLocal(bytes.Repeat([]byte{0x5a}, 32), contentDir, 1)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open content store: %v\n", err)
		os.Exit(1)
	}
	pgAdmin, pgDB, pgPool, pgStore = dbAdmin, dbName, pool, store

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

func requireProxyDB(t *testing.T) {
	t.Helper()
	if pgAdmin == nil || pgPool == nil {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
}

func proxyContext(t *testing.T) context.Context {
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

func quoteSQL(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

type proxyTenant struct {
	org    string
	taskID string
	runID  string
	execID string
	holder string
}

// seedPlanTenant inserts an active plan execution whose Run is current, which
// is what internal/capability issues work-content for.
func seedPlanTenant(t *testing.T, org string) proxyTenant {
	t.Helper()
	tn := proxyTenant{
		org:    org,
		taskID: newUUID(t),
		runID:  newUUID(t),
		execID: newUUID(t),
		holder: "holder-plan",
	}
	inputID := newUUID(t)
	snapshotID := newUUID(t)
	subject := "sub_" + org
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
		VALUES ('%[4]s', %[1]s, %[2]s, 'open', '%[3]s', 'content proxy task');
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
		        %[8]s, now() + interval '1 hour', now() + interval '2 hours');
	`, quoteSQL(tn.org), quoteSQL(subject), inputID, tn.taskID, snapshotID,
		tn.runID, tn.execID, quoteSQL(tn.holder))
	if _, err := pgAdmin.Exec(proxyContext(t), seed); err != nil {
		t.Fatalf("seed plan tenant: %v", err)
	}
	return tn
}

// seedExecuteTenant inserts an active execute execution bound to an Operation,
// which is the only fragment internal/capability issues work-egress for.
func seedExecuteTenant(t *testing.T, org string) proxyTenant {
	t.Helper()
	tn := proxyTenant{
		org:    org,
		taskID: newUUID(t),
		runID:  newUUID(t),
		execID: newUUID(t),
		holder: "holder-execute",
	}
	inputID := newUUID(t)
	snapshotID := newUUID(t)
	operationID := newUUID(t)
	attemptID := newUUID(t)
	subject := "sub_" + org
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
		VALUES ('%[4]s', %[1]s, %[2]s, 'open', '%[3]s', 'content proxy execute task');
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
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state)
		VALUES ('%[9]s', %[1]s, '%[6]s', 'model:1', 'model', repeat('c', 64), 'authorized');
		INSERT INTO work.runtime_execution
		  (execution_id, org_id, task_id, run_id, mode, run_fence, runtime_version,
		   intent_ref, intent_hash, request_hash, operation_id, dispatch_attempt_id,
		   state, holder_id, lease_until, hard_deadline)
		VALUES ('%[7]s', %[1]s, '%[4]s', '%[6]s', 'execute', 1, 'pi-1',
		        'intent/%[9]s', 'sha256:' || repeat('2', 64), repeat('c', 64),
		        '%[9]s', '%[10]s', 'active', %[8]s,
		        now() + interval '1 hour', now() + interval '2 hours');
	`, quoteSQL(tn.org), quoteSQL(subject), inputID, tn.taskID, snapshotID,
		tn.runID, tn.execID, quoteSQL(tn.holder), operationID, attemptID)
	if _, err := pgAdmin.Exec(proxyContext(t), seed); err != nil {
		t.Fatalf("seed execute tenant: %v", err)
	}
	return tn
}

func issueCapability(t *testing.T, tn proxyTenant, audience string, ttl time.Duration) (string, int) {
	t.Helper()
	issuer := capability.NewIssuer(pgPool)
	token, generation, err := issuer.Issue(proxyContext(t), tn.org, tn.execID, tn.holder, audience, ttl)
	if err != nil {
		t.Fatalf("issue %s capability: %v", audience, err)
	}
	return token, generation
}

// registerCandidate stores one object and registers it as a fragment-bound
// checkpoint candidate.
func registerCandidate(t *testing.T, tn proxyTenant, body []byte) contentref.Reference {
	t.Helper()
	ctx := proxyContext(t)
	ref, err := pgStore.Put(ctx, tn.org, body)
	if err != nil {
		t.Fatalf("put content: %v", err)
	}
	reference := contentref.Reference{
		RefID:         newUUID(t),
		OrgID:         tn.org,
		TaskID:        tn.taskID,
		RunID:         tn.runID,
		ExecutionID:   tn.execID,
		Kind:          contentref.KindCheckpointCandidate,
		LogicalSlot:   "checkpoint:model:" + newUUID(t) + ":candidate",
		ObjectVersion: "v1",
		ContentRef:    ref.ContentRef,
		ContentHash:   ref.Hash,
		Bytes:         ref.Bytes,
		WriterKind:    contentref.WriterControlPlane,
	}
	if err := contentref.NewRegistry(pgPool).Register(ctx, reference); err != nil {
		t.Fatalf("register reference: %v", err)
	}
	return reference
}

func startProxyServer(t *testing.T) *httptest.Server {
	t.Helper()
	server, err := New(Config{ListenAddr: "127.0.0.1:0"},
		capability.NewIssuer(pgPool), contentref.NewRegistry(pgPool), pgStore)
	if err != nil {
		t.Fatalf("new content proxy: %v", err)
	}
	testingServer := httptest.NewServer(server.Handler())
	t.Cleanup(testingServer.Close)
	return testingServer
}

type proxyResponse struct {
	status int
	body   []byte
	header http.Header
}

func getContent(t *testing.T, base, refID, org, execution, token string, generation int) proxyResponse {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet,
		base+"/internal/v1/content/"+refID, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set(HeaderAuthorization, "Bearer "+token)
	request.Header.Set(HeaderOrg, org)
	request.Header.Set(HeaderExecution, execution)
	request.Header.Set(HeaderGeneration, fmt.Sprint(generation))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("content request: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return proxyResponse{status: response.StatusCode, body: body, header: response.Header}
}

func errorBodyCode(t *testing.T, body []byte) string {
	t.Helper()
	var payload map[string]string
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("error body is not JSON: %q", body)
	}
	if len(payload) != 1 || payload["code"] == "" {
		t.Fatalf("error body = %q, want one code field", body)
	}
	return payload["code"]
}

func assertExactError(t *testing.T, response proxyResponse, status int, code string) {
	t.Helper()
	if response.status != status {
		t.Fatalf("status = %d, want %d (body %q)", response.status, status, response.body)
	}
	if got := errorBodyCode(t, response.body); got != code {
		t.Fatalf("code = %q, want %q", got, code)
	}
}

func TestReadServesExactRegisteredBytes(t *testing.T) {
	requireProxyDB(t)
	tn := seedPlanTenant(t, "org_proxy_happy")
	body := []byte("checkpoint-candidate-bytes-" + newUUID(t))
	reference := registerCandidate(t, tn, body)
	token, generation := issueCapability(t, tn, capability.AudienceContent, 20*time.Second)
	base := startProxyServer(t).URL

	response := getContent(t, base, reference.RefID, tn.org, tn.execID, token, generation)
	if response.status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", response.status, response.body)
	}
	if !bytes.Equal(response.body, body) {
		t.Fatalf("body = %q, want the exact stored bytes", response.body)
	}
	if got := response.header.Get(headerContentHash); got != reference.ContentHash {
		t.Fatalf("hash header = %q", got)
	}
	if got := response.header.Get(headerContentBytes); got != fmt.Sprint(len(body)) {
		t.Fatalf("bytes header = %q", got)
	}
	if got := response.header.Get(headerContentKind); got != string(contentref.KindCheckpointCandidate) {
		t.Fatalf("kind header = %q", got)
	}
	if got := response.header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache-control = %q", got)
	}
}

func TestCheckpointWriteThroughRealRegistry(t *testing.T) {
	requireProxyDB(t)
	tn := seedPlanTenant(t, "org_proxy_checkpoint")
	body := []byte("child-checkpoint-candidate-" + newUUID(t))
	sum := sha256.Sum256(body)
	declared := "sha256:" + hex.EncodeToString(sum[:])
	refID := newUUID(t)
	token, generation := issueCapability(t, tn, capability.AudienceContent, 20*time.Second)
	base := startProxyServer(t).URL

	request, err := http.NewRequest(http.MethodPost, base+"/internal/v1/checkpoints", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set(HeaderAuthorization, "Bearer "+token)
	request.Header.Set(HeaderOrg, tn.org)
	request.Header.Set(HeaderExecution, tn.execID)
	request.Header.Set(HeaderGeneration, fmt.Sprint(generation))
	request.Header.Set(HeaderRefID, refID)
	request.Header.Set(HeaderLogicalSlot, "checkpoint:model:9:candidate")
	request.Header.Set(HeaderContentHash, declared)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("checkpoint request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		responseBody, _ := io.ReadAll(response.Body)
		t.Fatalf("status = %d, want 201 (body %q)", response.StatusCode, responseBody)
	}
	var created checkpointResponse
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatalf("decode checkpoint response: %v", err)
	}
	if created.RefID != refID || created.ContentHash != declared || created.Bytes != int64(len(body)) {
		t.Fatalf("checkpoint response = %+v", created)
	}

	token, generation = issueCapability(t, tn, capability.AudienceContent, 20*time.Second)
	read := getContent(t, base, refID, tn.org, tn.execID, token, generation)
	if read.status != http.StatusOK || !bytes.Equal(read.body, body) {
		t.Fatalf("committed candidate read = %d %q", read.status, read.body)
	}
}

func TestReadRejectsInvalidCapabilities(t *testing.T) {
	requireProxyDB(t)
	base := startProxyServer(t).URL

	t.Run("wrong token", func(t *testing.T) {
		tn := seedPlanTenant(t, "org_proxy_token")
		body := []byte("secret-bytes-wrong-token")
		reference := registerCandidate(t, tn, body)
		_, generation := issueCapability(t, tn, capability.AudienceContent, 20*time.Second)
		response := getContent(t, base, reference.RefID, tn.org, tn.execID,
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", generation)
		assertExactError(t, response, http.StatusUnauthorized, codeCapabilityInvalid)
		if bytes.Contains(response.body, body) {
			t.Fatal("denied response contained content")
		}
	})

	t.Run("wrong generation", func(t *testing.T) {
		tn := seedPlanTenant(t, "org_proxy_generation")
		reference := registerCandidate(t, tn, []byte("secret-bytes-wrong-generation"))
		token, generation := issueCapability(t, tn, capability.AudienceContent, 20*time.Second)
		response := getContent(t, base, reference.RefID, tn.org, tn.execID, token, generation+1)
		assertExactError(t, response, http.StatusUnauthorized, codeCapabilityInvalid)
	})

	t.Run("wrong execution", func(t *testing.T) {
		tn := seedPlanTenant(t, "org_proxy_execution")
		reference := registerCandidate(t, tn, []byte("secret-bytes-wrong-execution"))
		token, generation := issueCapability(t, tn, capability.AudienceContent, 20*time.Second)
		response := getContent(t, base, reference.RefID, tn.org, newUUID(t), token, generation)
		assertExactError(t, response, http.StatusUnauthorized, codeCapabilityInvalid)
	})

	t.Run("wrong audience", func(t *testing.T) {
		tn := seedExecuteTenant(t, "org_proxy_audience")
		reference := registerCandidate(t, tn, []byte("secret-bytes-wrong-audience"))
		token, generation := issueCapability(t, tn, capability.AudienceEgress, 20*time.Second)
		response := getContent(t, base, reference.RefID, tn.org, tn.execID, token, generation)
		assertExactError(t, response, http.StatusUnauthorized, codeCapabilityInvalid)
	})

	t.Run("revoked execution", func(t *testing.T) {
		tn := seedPlanTenant(t, "org_proxy_revoked")
		reference := registerCandidate(t, tn, []byte("secret-bytes-revoked"))
		token, generation := issueCapability(t, tn, capability.AudienceContent, 20*time.Second)
		if _, err := pgAdmin.Exec(proxyContext(t),
			`UPDATE work.runtime_execution SET state = 'revoked'
			 WHERE org_id = $1 AND execution_id = $2`, tn.org, tn.execID); err != nil {
			t.Fatalf("revoke execution: %v", err)
		}
		response := getContent(t, base, reference.RefID, tn.org, tn.execID, token, generation)
		assertExactError(t, response, http.StatusUnauthorized, codeCapabilityInvalid)
	})

	t.Run("expired capability", func(t *testing.T) {
		tn := seedPlanTenant(t, "org_proxy_expired")
		reference := registerCandidate(t, tn, []byte("secret-bytes-expired"))
		token, generation := issueCapability(t, tn, capability.AudienceContent, 150*time.Millisecond)
		time.Sleep(500 * time.Millisecond)
		response := getContent(t, base, reference.RefID, tn.org, tn.execID, token, generation)
		assertExactError(t, response, http.StatusUnauthorized, codeCapabilityInvalid)
	})
}

func TestReadRejectsTombstonedReference(t *testing.T) {
	requireProxyDB(t)
	tn := seedPlanTenant(t, "org_proxy_tombstone")
	body := []byte("secret-bytes-tombstone")
	reference := registerCandidate(t, tn, body)
	token, generation := issueCapability(t, tn, capability.AudienceContent, 20*time.Second)
	if changed, err := contentref.NewRegistry(pgPool).
		Tombstone(proxyContext(t), tn.org, reference.RefID, "retention_expired"); err != nil || !changed {
		t.Fatalf("tombstone: changed=%v err=%v", changed, err)
	}
	base := startProxyServer(t).URL

	response := getContent(t, base, reference.RefID, tn.org, tn.execID, token, generation)
	assertExactError(t, response, http.StatusNotFound, codeContentReferenceNotFound)
	if bytes.Contains(response.body, body) || bytes.Contains(response.body, []byte(reference.RefID)) {
		t.Fatalf("tombstoned response leaked: %q", response.body)
	}
}

func TestReadRejectsUnknownAndCrossTenantReferences(t *testing.T) {
	requireProxyDB(t)
	base := startProxyServer(t).URL

	t.Run("unknown reference", func(t *testing.T) {
		tn := seedPlanTenant(t, "org_proxy_unknown")
		token, generation := issueCapability(t, tn, capability.AudienceContent, 20*time.Second)
		response := getContent(t, base, newUUID(t), tn.org, tn.execID, token, generation)
		assertExactError(t, response, http.StatusNotFound, codeContentReferenceNotFound)
	})

	t.Run("cross tenant reference", func(t *testing.T) {
		owner := seedPlanTenant(t, "org_proxy_owner")
		body := []byte("secret-bytes-cross-tenant")
		reference := registerCandidate(t, owner, body)
		foreign := seedPlanTenant(t, "org_proxy_foreign")
		token, generation := issueCapability(t, foreign, capability.AudienceContent, 20*time.Second)
		response := getContent(t, base, reference.RefID, foreign.org, foreign.execID, token, generation)
		assertExactError(t, response, http.StatusNotFound, codeContentReferenceNotFound)
		if bytes.Contains(response.body, body) {
			t.Fatal("cross-tenant response contained content")
		}
	})
}

func TestReadRejectsReferenceNotBoundToTheExecution(t *testing.T) {
	requireProxyDB(t)
	tn := seedPlanTenant(t, "org_proxy_unbound")
	reference := contentref.Reference{
		RefID:         newUUID(t),
		OrgID:         tn.org,
		Kind:          contentref.KindInput,
		LogicalSlot:   "input:" + newUUID(t),
		ObjectVersion: "v1",
		ContentRef:    "objects/" + tn.org + "/unbound",
		ContentHash:   hashBytes([]byte("unbound")),
		Bytes:         7,
		WriterKind:    contentref.WriterControlPlane,
	}
	if err := contentref.NewRegistry(pgPool).Register(proxyContext(t), reference); err != nil {
		t.Fatalf("register unbound input: %v", err)
	}
	token, generation := issueCapability(t, tn, capability.AudienceContent, 20*time.Second)
	base := startProxyServer(t).URL

	response := getContent(t, base, reference.RefID, tn.org, tn.execID, token, generation)
	assertExactError(t, response, http.StatusForbidden, codeContentAccessDenied)
}

// TestReadRechecksAuthorizationOnEveryRequest proves there is no positive
// cache: the same still-unexpired token is refused immediately after the
// fragment is revoked.
func TestReadRechecksAuthorizationOnEveryRequest(t *testing.T) {
	requireProxyDB(t)
	tn := seedPlanTenant(t, "org_proxy_recheck")
	body := []byte("secret-bytes-recheck-" + newUUID(t))
	reference := registerCandidate(t, tn, body)
	token, generation := issueCapability(t, tn, capability.AudienceContent, 20*time.Second)
	base := startProxyServer(t).URL

	first := getContent(t, base, reference.RefID, tn.org, tn.execID, token, generation)
	if first.status != http.StatusOK || !bytes.Equal(first.body, body) {
		t.Fatalf("first read status = %d body = %q", first.status, first.body)
	}
	if _, err := pgAdmin.Exec(proxyContext(t),
		`UPDATE work.runtime_execution SET state = 'revoked'
		 WHERE org_id = $1 AND execution_id = $2`, tn.org, tn.execID); err != nil {
		t.Fatalf("revoke execution: %v", err)
	}
	second := getContent(t, base, reference.RefID, tn.org, tn.execID, token, generation)
	assertExactError(t, second, http.StatusUnauthorized, codeCapabilityInvalid)
	if bytes.Contains(second.body, body) {
		t.Fatal("revoked response contained content")
	}
}

func TestOversizedBodyIsRejectedBeforeAuthorization(t *testing.T) {
	requireProxyDB(t)
	base := startProxyServer(t).URL
	oversized := bytes.Repeat([]byte("x"), int(MaxRequestBodyBytes)+1)
	request, err := http.NewRequest(http.MethodGet, base+"/internal/v1/content/"+newUUID(t),
		bytes.NewReader(oversized))
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("oversized request: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413 (body %q)", response.StatusCode, body)
	}
	if code := errorBodyCode(t, body); code != codeRequestTooLarge {
		t.Fatalf("code = %q", code)
	}
}
