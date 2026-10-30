package egress_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/egress"
)

const (
	testOrg        = "org_egress"
	testTask       = "11111111-1111-4111-8111-111111111111"
	testRun        = "22222222-2222-4222-8222-222222222222"
	testSnapshot   = "33333333-3333-4333-8333-333333333333"
	testOperation  = "44444444-4444-4444-8444-444444444444"
	testAttempt    = "55555555-5555-4555-8555-555555555555"
	testExecution  = "66666666-6666-4666-8666-666666666666"
	testGateway    = "77777777-7777-4777-8777-777777777777"
	testSlot       = "88888888-8888-4888-8888-888888888888"
	testAnswerRef  = "99999999-9999-4999-8999-999999999999"
	testEvidence   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	testInputRef   = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	testProviderID = "provider-request-1"
	testAPIKey     = "sk-live-test-secret"
	testFixedMs    = int64(1_700_000_000_000)
)

// newRequest builds a valid model:1 call. Model:1 means zero prior receipts per
// the signed structural rule.
func newRequest(t *testing.T) egress.ExchangeRequest {
	t.Helper()
	input := []byte("task input body")
	inputHash, err := canonical.BodyHash(input)
	if err != nil {
		t.Fatal(err)
	}
	request := egress.ExchangeRequest{
		Binding: canonical.Binding{
			OrgID: testOrg, TaskID: testTask, RunID: testRun,
			SnapshotID: testSnapshot, RuntimeVersion: "work-runtime-1.4.0",
		},
		LogicalKey: canonical.LogicalKey1,
		Input:      canonical.Reference{RefID: testInputRef, Hash: inputHash},
		Route: canonical.Route{
			Provider: canonical.ProviderAliyun, Model: "qwen3.8-flash",
			ConfigRevision: "1", CompatProfileVersion: "compat-r0a-1",
		},
		Parameters: canonical.Parameters{
			MaxOutputTokens: 512, TemperatureMilli: 200, OutputFormat: canonical.OutputFormatMarkdown,
		},
		Delivery: egress.DeliveryRequest{
			OrgID: testOrg, OperationID: testOperation, AttemptID: testAttempt,
			ExecutionID: testExecution, RunFence: 7, HolderID: "holder-1",
		},
		AnswerRefID:            testAnswerRef,
		RejectionEvidenceRefID: testEvidence,
		Messages: egress.MessageInput{
			SystemTemplate: []byte("system template"),
			Input:          input,
		},
	}
	hash, err := requestDocument(request).Hash()
	if err != nil {
		t.Fatal(err)
	}
	request.ExpectedRequestHash = hash
	request.Delivery.RequestHash = hash
	return request
}

// requestDocument independently rebuilds what Execute must canonicalise. It
// exists so tests can prove the hash and inspect the document bytes.
func requestDocument(request egress.ExchangeRequest) canonical.ModelRequest {
	return canonical.ModelRequest{
		Binding:       request.Binding,
		LogicalKey:    request.LogicalKey,
		Input:         request.Input,
		Template:      request.Template,
		PriorReceipts: request.PriorReceipts,
		Route:         request.Route,
		Parameters:    request.Parameters,
	}
}

func newExchange(gate egress.GateClient, provider egress.Provider, store content.Store) *egress.Exchange {
	return &egress.Exchange{
		Gate:      gate,
		Provider:  provider,
		Content:   store,
		GatewayID: testGateway,
		Now:       func() time.Time { return time.UnixMilli(testFixedMs).UTC() },
	}
}

type gateFixture struct {
	mu           sync.Mutex
	consumeCalls []egress.DeliveryRequest
	attachCalls  []egress.ReceiptRequest
	decision     egress.ConsumeDecision
	consumeErr   error
	attachErr    error
	decide       func(egress.DeliveryRequest) egress.ConsumeDecision
}

func newGate() *gateFixture {
	return &gateFixture{decision: egress.ConsumeDecision{
		Won: true, GateState: "consumed", ReceiptSlotID: testSlot,
	}}
}

func (g *gateFixture) Consume(_ context.Context, request egress.DeliveryRequest) (egress.ConsumeDecision, error) {
	g.mu.Lock()
	g.consumeCalls = append(g.consumeCalls, request)
	decide, decision, err := g.decide, g.decision, g.consumeErr
	g.mu.Unlock()
	if decide != nil {
		return decide(request), nil
	}
	return decision, err
}

func (g *gateFixture) Attach(_ context.Context, request egress.ReceiptRequest) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.attachCalls = append(g.attachCalls, request)
	return g.attachErr
}

func (g *gateFixture) consumeCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.consumeCalls)
}

func (g *gateFixture) attachCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.attachCalls)
}

func (g *gateFixture) attachCall(t *testing.T, index int) egress.ReceiptRequest {
	t.Helper()
	g.mu.Lock()
	defer g.mu.Unlock()
	if index >= len(g.attachCalls) {
		t.Fatalf("attach call %d missing; have %d", index, len(g.attachCalls))
	}
	return g.attachCalls[index]
}

type storedObject struct {
	contentRef string
	body       []byte
}

// memoryStore is an immutable in-memory content.Store. Put creates a new object
// and never overwrites; failPut can reject a numbered write.
type memoryStore struct {
	mu      sync.Mutex
	objects map[string][]byte
	orgs    map[string]string
	puts    []storedObject
	failPut func(index int, body []byte) error
}

func newMemoryStore() *memoryStore {
	return &memoryStore{objects: map[string][]byte{}, orgs: map[string]string{}}
}

func (s *memoryStore) Put(ctx context.Context, orgID string, plaintext []byte) (content.Ref, error) {
	if err := ctx.Err(); err != nil {
		return content.Ref{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failPut != nil {
		if err := s.failPut(len(s.puts), plaintext); err != nil {
			return content.Ref{}, err
		}
	}
	hash, err := canonical.BodyHash(plaintext)
	if err != nil {
		return content.Ref{}, err
	}
	ref := "content://test/" + url.PathEscape(orgID) + "/obj-" + fmt.Sprint(len(s.puts)+1)
	s.objects[ref] = append([]byte(nil), plaintext...)
	s.orgs[ref] = orgID
	s.puts = append(s.puts, storedObject{contentRef: ref, body: append([]byte(nil), plaintext...)})
	return content.Ref{ContentRef: ref, Hash: hash, Bytes: int64(len(plaintext))}, nil
}

func (s *memoryStore) Get(ctx context.Context, orgID, contentRef string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	body, ok := s.objects[contentRef]
	if !ok || s.orgs[contentRef] != orgID {
		return nil, fmt.Errorf("content object not found")
	}
	return append([]byte(nil), body...), nil
}

func (s *memoryStore) Delete(_ context.Context, orgID, contentRef string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.orgs[contentRef] != orgID {
		return fmt.Errorf("content object not found")
	}
	delete(s.objects, contentRef)
	delete(s.orgs, contentRef)
	return nil
}

func (s *memoryStore) putCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.puts)
}

func (s *memoryStore) put(t *testing.T, index int) storedObject {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if index >= len(s.puts) {
		t.Fatalf("store put %d missing; have %d", index, len(s.puts))
	}
	return s.puts[index]
}

func (s *memoryStore) objectRef(index int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if index >= len(s.puts) {
		return ""
	}
	return s.puts[index].contentRef
}

type providerFixture struct {
	provider   *egress.HTTPProvider
	requests   atomic.Int32
	lastBody   atomic.Value
	lastAuth   atomic.Value
	credential atomic.Value
}

type httpHandler = http.HandlerFunc

func newProvider(t *testing.T, handler http.HandlerFunc) *providerFixture {
	t.Helper()
	fixture := &providerFixture{}
	fixture.lastBody.Store([]byte(nil))
	fixture.lastAuth.Store("")
	fixture.credential.Store(testAPIKey)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.requests.Add(1)
		body, _ := io.ReadAll(r.Body)
		fixture.lastBody.Store(body)
		fixture.lastAuth.Store(r.Header.Get("Authorization"))
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	provider, err := egress.NewHTTPProvider(egress.HTTPProviderConfig{
		Endpoint: server.URL + "/v1/chat/completions",
		Credential: func(context.Context, string) (string, error) {
			return fixture.credential.Load().(string), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.provider = provider
	return fixture
}

func completionBody(answer string, withUsage bool) []byte {
	choices := []any{map[string]any{
		"message":       map[string]any{"role": "assistant", "content": answer},
		"finish_reason": "stop",
	}}
	payload := map[string]any{"id": testProviderID, "choices": choices}
	if withUsage {
		payload["usage"] = map[string]any{
			"prompt_tokens": 120, "completion_tokens": 30,
			"prompt_tokens_details": map[string]any{"cached_tokens": 10},
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	return body
}

func successHandler(answer string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(completionBody(answer, true))
	}
}

func successWithoutUsageHandler(answer string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(completionBody(answer, false))
	}
}

func statusHandler(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}
