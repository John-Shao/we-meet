package egressservice

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/authz"
	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	"github.com/we-meet/work/internal/egress"
	"github.com/we-meet/work/internal/providerctx"
	"github.com/we-meet/work/internal/runtime"
)

const (
	testOrg            = "org_egress_service"
	testTask           = "11111111-1111-4111-8111-111111111111"
	testRun            = "22222222-2222-4222-8222-222222222222"
	testSnapshot       = "33333333-3333-4333-8333-333333333333"
	testOperation      = "44444444-4444-4444-8444-444444444444"
	testAttempt        = "55555555-5555-4555-8555-555555555555"
	testExecution      = "66666666-6666-4666-8666-666666666666"
	testOtherExec      = "77777777-7777-4777-8777-777777777777"
	testGateway        = "88888888-8888-4888-8888-888888888888"
	testSlot           = "99999999-9999-4999-8999-999999999999"
	testInputRef       = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	testTemplateRef    = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	testPriorAnswerRef = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	testPriorReceipt   = "12121212-1212-4212-8212-121212121212"
	testHolder         = "holder-egress"
	testEndpoint       = "https://provider.example/v1/chat/completions"
	testSecret         = "sk-egress-service-secret"
	testToken          = "b3BhcXVlLXRva2VuLWZvci1lZ3Jlc3MtdGVzdA"
	testAnswer         = "public answer body"
	testSystemText     = "system template"
	testInputText      = "task input body"
	testPriorText      = "prior public answer"
	testModel          = "qwen3.8-flash"
)

type fakeAuthorizer struct {
	allowed    bool
	err        error
	calls      int
	org        string
	execution  string
	audience   string
	generation int
	token      string
}

func (f *fakeAuthorizer) Authorize(_ context.Context, orgID, executionID, audience string,
	generation int, token string,
) (bool, error) {
	f.calls++
	f.org, f.execution, f.audience = orgID, executionID, audience
	f.generation, f.token = generation, token
	return f.allowed, f.err
}

type fakeResolver struct {
	context providerctx.Context
	err     error
	calls   int
	org     string
}

func (f *fakeResolver) Resolve(_ context.Context, orgID string) (providerctx.Context, error) {
	f.calls++
	f.org = orgID
	return f.context, f.err
}

type fakeCommands struct {
	decision     authz.ConsumeDecision
	consumeErr   error
	attachErr    error
	consumeCalls int
	attachCalls  int
	consumes     []authz.ExecutionConsumeRequest
	attaches     []authz.ReceiptRequest
}

func newFakeCommands() *fakeCommands {
	return &fakeCommands{decision: authz.ConsumeDecision{
		Won: true, GateState: "consumed", ReceiptSlotID: testSlot,
	}}
}

func (c *fakeCommands) ConsumeByExecution(
	_ context.Context, request authz.ExecutionConsumeRequest,
) (authz.ConsumeDecision, error) {
	c.consumeCalls++
	c.consumes = append(c.consumes, request)
	return c.decision, c.consumeErr
}

func (c *fakeCommands) Attach(_ context.Context, request authz.ReceiptRequest) error {
	c.attachCalls++
	c.attaches = append(c.attaches, request)
	return c.attachErr
}

type fakeReferences struct {
	refs        map[string]contentref.Reference
	registered  []contentref.Reference
	err         error
	registerErr error
	calls       int
}

func newFakeReferences() *fakeReferences {
	return &fakeReferences{refs: map[string]contentref.Reference{}}
}

func (r *fakeReferences) add(reference contentref.Reference) {
	r.refs[reference.RefID] = reference
}

func (r *fakeReferences) Register(_ context.Context, reference contentref.Reference) error {
	if r.registerErr != nil {
		return r.registerErr
	}
	r.registered = append(r.registered, reference)
	return nil
}

func (r *fakeReferences) Resolve(_ context.Context, _ string, refID string) (contentref.Reference, error) {
	r.calls++
	if r.err != nil {
		return contentref.Reference{}, r.err
	}
	reference, ok := r.refs[refID]
	if !ok {
		return contentref.Reference{}, contentref.ErrNotFound
	}
	return reference, nil
}

type fakeBindings struct {
	binding ExecutionBinding
	err     error
	calls   int
}

func (b *fakeBindings) Resolve(_ context.Context, _ string, _ string) (ExecutionBinding, error) {
	b.calls++
	return b.binding, b.err
}

type fakeFactory struct {
	provider  egress.Provider
	err       error
	calls     int
	endpoints []string
	secrets   []string
}

func (f *fakeFactory) build(endpoint, secret string) (egress.Provider, error) {
	f.calls++
	f.endpoints = append(f.endpoints, endpoint)
	f.secrets = append(f.secrets, secret)
	if f.err != nil {
		return nil, f.err
	}
	return f.provider, nil
}

type fakeProvider struct {
	response egress.ProviderResponse
	err      error
	calls    int
	requests []egress.ProviderRequest
}

func (p *fakeProvider) Complete(_ context.Context, request egress.ProviderRequest) (egress.ProviderResponse, error) {
	p.calls++
	p.requests = append(p.requests, request)
	return p.response, p.err
}

// memoryStore is an immutable in-memory content.Store: every Put mints a new
// object and Get verifies the organization.
type memoryStore struct {
	objects map[string][]byte
	orgs    map[string]string
	puts    int
}

func newMemoryStore() *memoryStore {
	return &memoryStore{objects: map[string][]byte{}, orgs: map[string]string{}}
}

func (s *memoryStore) seed(contentRef, orgID string, body []byte) {
	s.objects[contentRef] = append([]byte(nil), body...)
	s.orgs[contentRef] = orgID
}

func (s *memoryStore) Put(_ context.Context, orgID string, plaintext []byte) (content.Ref, error) {
	hash, err := canonical.BodyHash(plaintext)
	if err != nil {
		return content.Ref{}, err
	}
	ref := "content://test/" + url.PathEscape(orgID) + "/obj-" + fmt.Sprint(s.puts+1)
	s.puts++
	s.objects[ref] = append([]byte(nil), plaintext...)
	s.orgs[ref] = orgID
	return content.Ref{ContentRef: ref, Hash: hash, Bytes: int64(len(plaintext))}, nil
}

func (s *memoryStore) Get(_ context.Context, orgID, contentRef string) ([]byte, error) {
	body, ok := s.objects[contentRef]
	if !ok || s.orgs[contentRef] != orgID {
		return nil, errors.New("content object not found")
	}
	return append([]byte(nil), body...), nil
}

func (s *memoryStore) Delete(_ context.Context, orgID, contentRef string) error {
	if s.orgs[contentRef] != orgID {
		return errors.New("content object not found")
	}
	delete(s.objects, contentRef)
	delete(s.orgs, contentRef)
	return nil
}

// fixture is one fully registered model:2 request: input, template, one prior
// succeeded receipt pointing at a public answer, and the model_request itself.
type fixture struct {
	docRef    string
	docHash   string
	docBytes  []byte
	inputRef  string
	inputText string
}

type harness struct {
	authorizer *fakeAuthorizer
	resolver   *fakeResolver
	commands   *fakeCommands
	references *fakeReferences
	bindings   *fakeBindings
	store      *memoryStore
	factory    *fakeFactory
	provider   *fakeProvider
	server     *httptest.Server
	fixture    *fixture
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{
		authorizer: &fakeAuthorizer{allowed: true},
		resolver: &fakeResolver{context: providerctx.Context{
			Provider: canonical.ProviderAliyun,
			Model:    testModel,
			Endpoint: testEndpoint,
			Mode:     "managed_key",
			Secret:   []byte(testSecret),
		}},
		commands:   newFakeCommands(),
		references: newFakeReferences(),
		bindings:   &fakeBindings{},
		store:      newMemoryStore(),
		provider: &fakeProvider{response: egress.ProviderResponse{
			Answer:            []byte(testAnswer),
			ProviderRequestID: "provider-request-1",
			Usage: runtime.Usage{
				Source:            runtime.UsageProvider,
				InputTokens:       canonical.Int64(120),
				OutputTokens:      canonical.Int64(30),
				CachedInputTokens: canonical.Int64(10),
			},
		}},
	}
	h.factory = &fakeFactory{provider: h.provider}
	h.fixture = h.seed(t)

	server, err := New(Config{GatewayID: testGateway}, Dependencies{
		Authorizer: h.authorizer,
		Providers:  h.resolver,
		Commands:   h.commands,
		References: h.references,
		Executions: h.bindings,
		Content:    h.store,
		Factory:    h.factory.build,
	})
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	h.server = httptest.NewServer(server.Handler())
	t.Cleanup(h.server.Close)
	return h
}

// seed registers the execution-bound input, template, prior answer, prior
// receipt and model_request references and their Content Store objects.
func (h *harness) seed(t *testing.T) *fixture {
	t.Helper()
	binding := canonical.Binding{
		OrgID: testOrg, TaskID: testTask, RunID: testRun,
		SnapshotID: testSnapshot, RuntimeVersion: "pi-1",
	}

	inputBody := []byte(testInputText)
	input := h.registerBody(t, testInputRef, contentref.KindInput,
		"input:"+testExecution+":input", inputBody)

	templateBody := []byte(testSystemText)
	template := h.registerBody(t, testTemplateRef, contentref.KindTemplate,
		"template:"+testExecution+":template:v1", templateBody)

	priorBody := []byte(testPriorText)
	priorAnswer := h.registerBody(t, testPriorAnswerRef, contentref.KindAnswer,
		"answer:"+testExecution+":model:1", priorBody)

	priorReceipt := canonical.ModelReceipt{
		ReceiptID:         "abababab-abab-4bab-8bab-abababababab",
		Binding:           binding,
		LogicalKey:        canonical.LogicalKey1,
		OperationID:       testOperation,
		DispatchAttemptID: testAttempt,
		ExecutionID:       testExecution,
		RequestHash:       "sha256:" + strings.Repeat("e", 64),
		WriterGatewayID:   testGateway,
		RecordedAtUnixMs:  1700000000000,
		Outcome:           canonical.OutcomeSucceeded,
		Content: &canonical.Reference{
			RefID: priorAnswer.RefID,
			Hash:  priorAnswer.ContentHash,
		},
		ContentBytes: int64(len(priorBody)),
		Usage:        canonical.Usage{Source: canonical.UsageUnavailable},
	}
	receiptBytes, err := priorReceipt.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	receiptHash, err := priorReceipt.Hash()
	if err != nil {
		t.Fatal(err)
	}
	receiptRef := h.registerDocument(t, testPriorReceipt, contentref.KindReceipt,
		"receipt:"+testExecution+":model:1", receiptBytes, receiptHash)

	document := canonical.ModelRequest{
		Binding:    binding,
		LogicalKey: canonical.LogicalKey2,
		Input:      canonical.Reference{RefID: input.RefID, Hash: input.ContentHash},
		Template:   &canonical.Reference{RefID: template.RefID, Hash: template.ContentHash},
		PriorReceipts: []canonical.Reference{
			{RefID: receiptRef.RefID, Hash: receiptHash},
		},
		Route: canonical.Route{
			Provider: canonical.ProviderAliyun, Model: testModel,
			ConfigRevision: "1", CompatProfileVersion: "compat-r0a-1",
		},
		Parameters: canonical.Parameters{
			MaxOutputTokens: 512, TemperatureMilli: 200,
			OutputFormat: canonical.OutputFormatMarkdown,
		},
	}
	docBytes, err := document.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	docHash, err := document.Hash()
	if err != nil {
		t.Fatal(err)
	}
	docRef := h.registerDocument(t, "13131313-1313-4313-8313-131313131313",
		contentref.KindModelRequest, "model-request:"+testExecution+":model:2", docBytes, docHash)

	h.bindings.binding = ExecutionBinding{
		ExecutionID:    testExecution,
		TaskID:         testTask,
		RunID:          testRun,
		SnapshotID:     testSnapshot,
		RuntimeVersion: "pi-1",
		OperationID:    testOperation,
		AttemptID:      testAttempt,
		HolderID:       testHolder,
		RunFence:       7,
		RequestHash:    docHash,
		Mode:           "execute",
	}
	return &fixture{
		docRef: docRef.RefID, docHash: docHash, docBytes: docBytes,
		inputRef: input.RefID, inputText: testInputText,
	}
}

func (h *harness) registerBody(
	t *testing.T, refID string, kind contentref.Kind, slot string, body []byte,
) contentref.Reference {
	t.Helper()
	hash, err := canonical.BodyHash(body)
	if err != nil {
		t.Fatal(err)
	}
	return h.register(t, refID, kind, slot, body, hash)
}

func (h *harness) registerDocument(
	t *testing.T, refID string, kind contentref.Kind, slot string, body []byte, hash string,
) contentref.Reference {
	t.Helper()
	return h.register(t, refID, kind, slot, body, hash)
}

func (h *harness) register(
	t *testing.T, refID string, kind contentref.Kind, slot string, body []byte, hash string,
) contentref.Reference {
	t.Helper()
	contentRef := "content://test/" + url.PathEscape(testOrg) + "/" + refID
	h.store.seed(contentRef, testOrg, body)
	reference := contentref.Reference{
		RefID: refID, OrgID: testOrg, TaskID: testTask, RunID: testRun,
		ExecutionID: testExecution, Kind: kind, LogicalSlot: slot,
		ObjectVersion: "v1", ContentRef: contentRef, ContentHash: hash,
		Bytes: int64(len(body)), WriterKind: contentref.WriterControlPlane,
		SlotState: contentref.SlotCommitted,
	}
	h.references.add(reference)
	return reference
}

type testResponse struct {
	status int
	body   []byte
	call   invokeResponse
}

func (h *harness) postRaw(t *testing.T, body []byte, org, execution, generation, token string) testResponse {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, h.server.URL+InvokePath, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set(HeaderAuthorization, "Bearer "+token)
	}
	if org != "" {
		request.Header.Set(HeaderOrg, org)
	}
	if execution != "" {
		request.Header.Set(HeaderExecution, execution)
	}
	if generation != "" {
		request.Header.Set(HeaderGeneration, generation)
	}
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

func (h *harness) post(t *testing.T, executionID, requestRef, requestHash string) testResponse {
	t.Helper()
	body, err := json.Marshal(invokeEnvelope{
		ExecutionID: executionID,
		RequestRef:  referenceEnvelope{RefID: requestRef, Hash: requestHash, Object: true},
		RequestHash: requestHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	return h.postRaw(t, body, testOrg, testExecution, "1", testToken)
}

func (h *harness) postValid(t *testing.T) testResponse {
	t.Helper()
	return h.post(t, testExecution, h.fixture.docRef, h.fixture.docHash)
}

func requireErrorCode(t *testing.T, response testResponse, status int, code string) {
	t.Helper()
	if response.status != status {
		t.Fatalf("status = %d, want %d (body %q)", response.status, status, response.body)
	}
	var payload map[string]string
	if err := json.Unmarshal(response.body, &payload); err != nil {
		t.Fatalf("error body is not JSON: %q", response.body)
	}
	if len(payload) != 1 || payload["code"] != code {
		t.Fatalf("error body = %q, want one code field %q", response.body, code)
	}
}

func requireOutcome(t *testing.T, response testResponse, outcome egress.Outcome) {
	t.Helper()
	if response.status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", response.status, response.body)
	}
	if response.call.Outcome != outcome {
		t.Fatalf("outcome = %q, want %q (body %q)", response.call.Outcome, outcome, response.body)
	}
}

func requireNoLeak(t *testing.T, body []byte) {
	t.Helper()
	for _, forbidden := range []string{
		testSecret, testAnswer, testSystemText, testInputText, testPriorText, testToken,
	} {
		if bytes.Contains(body, []byte(forbidden)) {
			t.Fatalf("response leaked %q: %s", forbidden, body)
		}
	}
}

func TestInvokeSuccessCallsProviderOnceAndAttachesOnce(t *testing.T) {
	h := newHarness(t)
	response := h.postValid(t)
	requireOutcome(t, response, egress.OutcomeSucceeded)

	if h.authorizer.calls != 1 || h.authorizer.audience != "work-egress" ||
		h.authorizer.org != testOrg || h.authorizer.execution != testExecution ||
		h.authorizer.generation != 1 || h.authorizer.token != testToken {
		t.Fatalf("authorization call = %+v", h.authorizer)
	}
	if h.resolver.calls != 1 || h.resolver.org != testOrg {
		t.Fatalf("resolver calls = %d org = %q", h.resolver.calls, h.resolver.org)
	}
	if h.factory.calls != 1 || h.factory.endpoints[0] != testEndpoint ||
		h.factory.secrets[0] != testSecret {
		t.Fatalf("factory calls = %d endpoints = %v", h.factory.calls, h.factory.endpoints)
	}
	if h.provider.calls != 1 {
		t.Fatalf("provider calls = %d, want exactly one", h.provider.calls)
	}
	if h.commands.consumeCalls != 1 || h.commands.attachCalls != 1 {
		t.Fatalf("consume = %d attach = %d, want 1 and 1",
			h.commands.consumeCalls, h.commands.attachCalls)
	}
	if consume := h.commands.consumes[0]; consume.OrgID != testOrg ||
		consume.ExecutionID != testExecution || consume.RequestHash != h.fixture.docHash {
		t.Fatalf("consume request = %+v", consume)
	}
	attach := h.commands.attaches[0]
	if attach.ReceiptSlotID != testSlot ||
		attach.OperationID != testOperation || attach.AttemptID != testAttempt ||
		attach.ExecutionID != testExecution ||
		attach.ReceiptResult != authz.ReceiptSucceeded ||
		attach.ProviderRequestID != "provider-request-1" ||
		attach.ReceiptRef == "" || attach.ReceiptHash == "" {
		t.Fatalf("attach request = %+v", attach)
	}

	providerRequest := h.provider.requests[0]
	if string(providerRequest.Messages.Input) != testInputText ||
		string(providerRequest.Messages.SystemTemplate) != testSystemText {
		t.Fatal("provider messages were not assembled from the registered objects")
	}
	if len(providerRequest.Messages.PriorAnswers) != 1 ||
		string(providerRequest.Messages.PriorAnswers[0]) != testPriorText {
		t.Fatalf("prior answers = %q", providerRequest.Messages.PriorAnswers)
	}
	if providerRequest.Provider != canonical.ProviderAliyun || providerRequest.Model != testModel {
		t.Fatalf("provider route = %s/%s", providerRequest.Provider, providerRequest.Model)
	}

	if response.call.RequestHash != h.fixture.docHash || response.call.GateState != "consumed" ||
		!response.call.Sent {
		t.Fatalf("outcome coordinates = %+v", response.call)
	}
	if response.call.Receipt == nil || response.call.Receipt.RefID != testSlot ||
		response.call.Receipt.Hash == "" || response.call.Receipt.ContentRef == "" {
		t.Fatalf("receipt = %+v", response.call.Receipt)
	}
	if response.call.AnswerRefID == "" || response.call.Content == nil ||
		response.call.Content.RefID != response.call.AnswerRefID ||
		response.call.Content.Bytes != int64(len(testAnswer)) {
		t.Fatalf("content/answer = %+v / %q", response.call.Content, response.call.AnswerRefID)
	}
	if response.call.RejectionEvidenceRefID == "" ||
		response.call.RejectionEvidenceRefID == response.call.AnswerRefID {
		t.Fatalf("rejection evidence id = %q", response.call.RejectionEvidenceRefID)
	}
	if response.call.Usage == nil || response.call.Usage.Source != "provider" ||
		response.call.Usage.InputTokens == nil || *response.call.Usage.InputTokens != 120 {
		t.Fatalf("usage = %+v", response.call.Usage)
	}
	if response.call.ProviderRequestID == nil || *response.call.ProviderRequestID != "provider-request-1" {
		t.Fatalf("providerRequestId = %v", response.call.ProviderRequestID)
	}
	if response.call.Code != "" {
		t.Fatalf("code = %q on success", response.call.Code)
	}
	requireNoLeak(t, response.body)
}

func TestRequestHashMismatchIsRefusedBeforeConsume(t *testing.T) {
	h := newHarness(t)
	response := h.post(t, testExecution, h.fixture.docRef, "sha256:"+strings.Repeat("d", 64))
	requireErrorCode(t, response, http.StatusUnprocessableEntity, codeRequestHashMismatch)
	if h.commands.consumeCalls != 0 || h.provider.calls != 0 || h.commands.attachCalls != 0 {
		t.Fatalf("hash mismatch reached consume/provider/attach")
	}
}

func TestMalformedWireIsRefusedBeforeAnyProviderWork(t *testing.T) {
	cases := map[string]struct {
		body       []byte
		org        string
		execution  string
		generation string
		token      string
		status     int
		code       string
	}{
		"unknown field": {
			body: []byte(`{"executionId":"` + testExecution + `","requestRef":"` +
				testInputRef + `","requestHash":"sha256:` + strings.Repeat("a", 64) +
				`","messages":[]}`),
			org: testOrg, execution: testExecution, generation: "1", token: testToken,
			status: http.StatusUnprocessableEntity, code: codeInvalidRequest,
		},
		"malformed execution": {
			body: []byte(`{"executionId":"execution-1","requestRef":"` +
				testInputRef + `","requestHash":"sha256:` + strings.Repeat("a", 64) + `"}`),
			org: testOrg, execution: testExecution, generation: "1", token: testToken,
			status: http.StatusUnprocessableEntity, code: codeInvalidRequest,
		},
		"malformed ref": {
			body: []byte(`{"executionId":"` + testExecution + `","requestRef":"../etc/passwd","requestHash":"sha256:` +
				strings.Repeat("a", 64) + `"}`),
			org: testOrg, execution: testExecution, generation: "1", token: testToken,
			status: http.StatusUnprocessableEntity, code: codeInvalidRequest,
		},
		"malformed hash": {
			body: []byte(`{"executionId":"` + testExecution + `","requestRef":"` +
				testInputRef + `","requestHash":"sha256:xyz"}`),
			org: testOrg, execution: testExecution, generation: "1", token: testToken,
			status: http.StatusUnprocessableEntity, code: codeInvalidRequest,
		},
		"duplicate key": {
			body: []byte(`{"executionId":"` + testExecution + `","executionId":"` +
				testOtherExec + `","requestRef":"` + testInputRef +
				`","requestHash":"sha256:` + strings.Repeat("a", 64) + `"}`),
			org: testOrg, execution: testExecution, generation: "1", token: testToken,
			status: http.StatusUnprocessableEntity, code: codeInvalidRequest,
		},
		"body execution differs from header": {
			body: []byte(`{"executionId":"` + testOtherExec + `","requestRef":"` +
				testInputRef + `","requestHash":"sha256:` + strings.Repeat("a", 64) + `"}`),
			org: testOrg, execution: testExecution, generation: "1", token: testToken,
			status: http.StatusUnprocessableEntity, code: codeInvalidRequest,
		},
		"reference object unknown member": {
			body: []byte(`{"executionId":"` + testExecution + `","requestRef":{"refId":"` +
				testInputRef + `","hash":"sha256:` + strings.Repeat("a", 64) +
				`","kind":"model_request"},"requestHash":"sha256:` + strings.Repeat("a", 64) + `"}`),
			org: testOrg, execution: testExecution, generation: "1", token: testToken,
			status: http.StatusUnprocessableEntity, code: codeInvalidRequest,
		},
		"reference object hash differs": {
			body: []byte(`{"executionId":"` + testExecution + `","requestRef":{"refId":"` +
				testInputRef + `","hash":"sha256:` + strings.Repeat("b", 64) +
				`"},"requestHash":"sha256:` + strings.Repeat("a", 64) + `"}`),
			org: testOrg, execution: testExecution, generation: "1", token: testToken,
			status: http.StatusUnprocessableEntity, code: codeInvalidRequest,
		},
		"null reference": {
			body: []byte(`{"executionId":"` + testExecution + `","requestRef":null,"requestHash":"sha256:` +
				strings.Repeat("a", 64) + `"}`),
			org: testOrg, execution: testExecution, generation: "1", token: testToken,
			status: http.StatusUnprocessableEntity, code: codeInvalidRequest,
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			response := h.postRaw(t, testCase.body, testCase.org, testCase.execution,
				testCase.generation, testCase.token)
			requireErrorCode(t, response, testCase.status, testCase.code)
			if h.references.calls != 0 || h.commands.consumeCalls != 0 ||
				h.factory.calls != 0 || h.provider.calls != 0 {
				t.Fatalf("malformed wire reached references/factory/consume/provider")
			}
		})
	}
}

func TestBareUUIDReferenceIsAccepted(t *testing.T) {
	h := newHarness(t)
	body, err := json.Marshal(map[string]string{
		"executionId": testExecution,
		"requestRef":  h.fixture.docRef,
		"requestHash": h.fixture.docHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	response := h.postRaw(t, body, testOrg, testExecution, "1", testToken)
	requireOutcome(t, response, egress.OutcomeSucceeded)
	if h.provider.calls != 1 || h.commands.consumeCalls != 1 {
		t.Fatalf("provider/consume = %d/%d, want 1/1", h.provider.calls, h.commands.consumeCalls)
	}
}

func TestOversizedBodyIsRejectedBeforeAuthorization(t *testing.T) {
	h := newHarness(t)
	body := bytes.Repeat([]byte("x"), int(MaxRequestBodyBytes)+1)
	response := h.postRaw(t, body, testOrg, testExecution, "1", testToken)
	requireErrorCode(t, response, http.StatusRequestEntityTooLarge, codeRequestTooLarge)
	if h.authorizer.calls != 0 {
		t.Fatalf("authorizer calls = %d, want zero for an oversized body", h.authorizer.calls)
	}
}

func TestAuthorizationDenialStopsBeforeBodyAndProvider(t *testing.T) {
	t.Run("not allowed", func(t *testing.T) {
		h := newHarness(t)
		h.authorizer.allowed = false
		response := h.postValid(t)
		requireErrorCode(t, response, http.StatusUnauthorized, codeCapabilityInvalid)
		if h.references.calls != 0 || h.commands.consumeCalls != 0 || h.factory.calls != 0 {
			t.Fatal("denied call reached references/factory/consume")
		}
	})

	t.Run("authorization unavailable", func(t *testing.T) {
		h := newHarness(t)
		h.authorizer.err = errors.New("database unavailable")
		response := h.postValid(t)
		requireErrorCode(t, response, http.StatusServiceUnavailable, codeAuthorizationUnavailable)
	})

	t.Run("missing bearer", func(t *testing.T) {
		h := newHarness(t)
		body, err := json.Marshal(invokeEnvelope{
			ExecutionID: testExecution,
			RequestRef:  referenceEnvelope{RefID: h.fixture.docRef},
			RequestHash: h.fixture.docHash,
		})
		if err != nil {
			t.Fatal(err)
		}
		response := h.postRaw(t, body, testOrg, testExecution, "1", "")
		requireErrorCode(t, response, http.StatusUnauthorized, codeCapabilityInvalid)
		if h.authorizer.calls != 0 {
			t.Fatalf("authorizer calls = %d", h.authorizer.calls)
		}
	})
}

func TestReferenceRefusalsHappenBeforeConsume(t *testing.T) {
	cases := map[string]struct {
		mutate func(*harness)
		status int
		code   string
	}{
		"missing reference": {
			mutate: func(h *harness) { delete(h.references.refs, h.fixture.docRef) },
			status: http.StatusNotFound, code: codeContentReferenceNotFound,
		},
		"foreign execution binding": {
			mutate: func(h *harness) {
				reference := h.references.refs[h.fixture.docRef]
				reference.ExecutionID = testOtherExec
				h.references.refs[h.fixture.docRef] = reference
			},
			status: http.StatusNotFound, code: codeContentReferenceNotFound,
		},
		"wrong kind": {
			mutate: func(h *harness) {
				reference := h.references.refs[h.fixture.docRef]
				reference.Kind = contentref.KindInput
				h.references.refs[h.fixture.docRef] = reference
			},
			status: http.StatusUnprocessableEntity, code: codeContentKindMismatch,
		},
		"registry unavailable": {
			mutate: func(h *harness) { h.references.err = errors.New("database detail") },
			status: http.StatusServiceUnavailable, code: codeContentReferenceUnavail,
		},
		"tampered bytes": {
			mutate: func(h *harness) {
				reference := h.references.refs[h.fixture.docRef]
				h.store.seed(reference.ContentRef, testOrg, []byte(`{"tampered":true}`))
			},
			status: http.StatusInternalServerError, code: codeContentIntegrityFailed,
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			testCase.mutate(h)
			response := h.postValid(t)
			requireErrorCode(t, response, testCase.status, testCase.code)
			if h.commands.consumeCalls != 0 || h.factory.calls != 0 || h.provider.calls != 0 {
				t.Fatalf("refused reference reached factory/consume/provider")
			}
			if bytes.Contains(response.body, []byte("database detail")) {
				t.Fatal("registry error text leaked")
			}
		})
	}
}

func TestProviderRefusalsHappenBeforeConsume(t *testing.T) {
	t.Run("sts_role", func(t *testing.T) {
		h := newHarness(t)
		h.resolver.context = providerctx.Context{
			Provider: canonical.ProviderAliyun, Model: testModel,
			Endpoint: testEndpoint, Mode: "sts_role", RoleRef: "acs:ram::role/work-model",
		}
		response := h.postValid(t)
		requireErrorCode(t, response, http.StatusUnprocessableEntity, codeProviderModeUnsupported)
		if h.commands.consumeCalls != 0 || h.factory.calls != 0 || h.provider.calls != 0 {
			t.Fatal("sts_role reached factory/consume/provider")
		}
	})

	t.Run("frozen route model differs", func(t *testing.T) {
		h := newHarness(t)
		h.resolver.context.Model = "another-model"
		response := h.postValid(t)
		requireErrorCode(t, response, http.StatusUnprocessableEntity, codeProviderMismatch)
		if h.commands.consumeCalls != 0 || h.factory.calls != 0 {
			t.Fatal("route mismatch reached factory/consume")
		}
	})

	t.Run("provider not configured", func(t *testing.T) {
		h := newHarness(t)
		h.resolver.err = &providerctx.Error{Code: providerctx.CodeProviderNotConfigured}
		response := h.postValid(t)
		requireErrorCode(t, response, http.StatusUnprocessableEntity, codeProviderNotConfigured)
	})

	t.Run("resolve error text is not forwarded", func(t *testing.T) {
		h := newHarness(t)
		h.resolver.err = errors.New("sql detail that must not leak")
		response := h.postValid(t)
		requireErrorCode(t, response, http.StatusServiceUnavailable, codeProviderUnavailable)
		if bytes.Contains(response.body, []byte("sql detail")) {
			t.Fatal("provider resolve error text leaked")
		}
	})

	t.Run("factory refused", func(t *testing.T) {
		h := newHarness(t)
		h.factory.err = errors.New("endpoint detail that must not leak")
		response := h.postValid(t)
		requireErrorCode(t, response, http.StatusServiceUnavailable, codeProviderUnavailable)
		if bytes.Contains(response.body, []byte("endpoint detail")) {
			t.Fatal("factory error text leaked")
		}
	})
}

func TestExecutionBindingRefusalsHappenBeforeConsume(t *testing.T) {
	cases := map[string]struct {
		mutate func(*harness)
		status int
		code   string
	}{
		"plan execution": {
			mutate: func(h *harness) { h.bindings.binding.Mode = "plan" },
			status: http.StatusConflict, code: codeExecutionNotExecutable,
		},
		"missing attempt": {
			mutate: func(h *harness) { h.bindings.binding.AttemptID = "" },
			status: http.StatusConflict, code: codeExecutionNotExecutable,
		},
		"execution hash differs": {
			mutate: func(h *harness) {
				h.bindings.binding.RequestHash = "sha256:" + strings.Repeat("f", 64)
			},
			status: http.StatusUnprocessableEntity, code: codeRequestHashMismatch,
		},
		"foreign task": {
			mutate: func(h *harness) {
				h.bindings.binding.TaskID = "14141414-1414-4414-8414-141414141414"
			},
			status: http.StatusUnprocessableEntity, code: codeRequestBindingMismatch,
		},
		"foreign snapshot": {
			mutate: func(h *harness) {
				h.bindings.binding.SnapshotID = "15151515-1515-4515-8515-151515151515"
			},
			status: http.StatusUnprocessableEntity, code: codeRequestBindingMismatch,
		},
		"binding unavailable": {
			mutate: func(h *harness) {
				h.bindings.err = &BindingError{Code: codeExecutionBindingUnavail}
			},
			status: http.StatusServiceUnavailable, code: codeExecutionBindingUnavail,
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			testCase.mutate(h)
			response := h.postValid(t)
			requireErrorCode(t, response, testCase.status, testCase.code)
			if h.commands.consumeCalls != 0 || h.provider.calls != 0 {
				t.Fatal("refused execution reached consume/provider")
			}
		})
	}
}

func TestNonWonGateIsNotSentWithoutProviderCall(t *testing.T) {
	h := newHarness(t)
	h.commands.decision = authz.ConsumeDecision{
		Won: false, GateState: "observed", ReceiptSlotID: testSlot,
	}
	response := h.postValid(t)
	requireOutcome(t, response, egress.OutcomeNotSent)
	if response.call.Code != codeDispatchNotWon {
		t.Fatalf("code = %q", response.call.Code)
	}
	if h.provider.calls != 0 || h.commands.attachCalls != 0 {
		t.Fatalf("not-sent call reached provider or attach")
	}
}

func TestConsumeFailureIsAControlledCode(t *testing.T) {
	h := newHarness(t)
	h.commands.consumeErr = authz.Fail("runtime_execution_not_active")
	response := h.postValid(t)
	requireErrorCode(t, response, http.StatusConflict, "runtime_execution_not_active")
	if h.provider.calls != 0 || h.commands.attachCalls != 0 {
		t.Fatal("consume refusal reached provider or attach")
	}
}

func TestProviderFailureIsUnknownWithoutReceiptOrAttach(t *testing.T) {
	h := newHarness(t)
	h.provider.err = &egress.ProviderFailure{StatusCode: 502, Code: "server_error"}

	response := h.postValid(t)
	requireOutcome(t, response, egress.OutcomeUnknown)
	if !response.call.Sent {
		t.Fatal("unknown after a provider call must report sent=true")
	}
	if response.call.Receipt != nil || response.call.Content != nil {
		t.Fatalf("unknown result carried receipt/content: %+v", response.call)
	}
	if response.call.Code != "server_error" {
		t.Fatalf("code = %q", response.call.Code)
	}
	if h.provider.calls != 1 {
		t.Fatalf("provider calls = %d", h.provider.calls)
	}
	if h.commands.attachCalls != 0 {
		t.Fatalf("attach calls = %d, want zero for an unknown outcome", h.commands.attachCalls)
	}
}

func TestProviderRejectionStoresEvidenceAndAttaches(t *testing.T) {
	h := newHarness(t)
	h.provider.err = &egress.ProviderRejection{
		StatusCode: 400, Code: "invalid_request", Evidence: []byte(`{"error":"bad input"}`),
	}
	response := h.postValid(t)
	requireOutcome(t, response, egress.OutcomeRejectedNotExecuted)
	if response.call.Receipt == nil || response.call.Content != nil {
		t.Fatalf("rejection result = %+v", response.call)
	}
	if h.commands.attachCalls != 1 {
		t.Fatalf("attach calls = %d, want 1", h.commands.attachCalls)
	}
	if h.commands.attaches[0].ReceiptResult != authz.ReceiptRejectedNotExecuted {
		t.Fatalf("receipt result = %q", h.commands.attaches[0].ReceiptResult)
	}
	if response.call.RejectionEvidenceRefID == "" {
		t.Fatal("rejection evidence refId missing")
	}
}

func TestAttachFailureStillReportsTheStoredReceipt(t *testing.T) {
	h := newHarness(t)
	h.commands.attachErr = errors.New("authorization service unreachable")
	response := h.postValid(t)
	requireOutcome(t, response, egress.OutcomeSucceeded)
	if response.call.Code != codeReceiptAttachFailed {
		t.Fatalf("code = %q", response.call.Code)
	}
	if response.call.Receipt == nil || response.call.Receipt.RefID != testSlot {
		t.Fatalf("receipt = %+v", response.call.Receipt)
	}
	if h.provider.calls != 1 {
		t.Fatalf("provider calls = %d, want 1", h.provider.calls)
	}
}

func TestNewRequiresDependenciesAndGatewayIdentity(t *testing.T) {
	deps := Dependencies{
		Authorizer: &fakeAuthorizer{},
		Providers:  &fakeResolver{},
		Commands:   newFakeCommands(),
		References: newFakeReferences(),
		Executions: &fakeBindings{},
		Content:    newMemoryStore(),
		Factory:    (&fakeFactory{}).build,
	}
	variants := map[string]Dependencies{
		"authorizer": deps,
		"resolver":   deps,
		"commands":   deps,
		"references": deps,
		"executions": deps,
		"content":    deps,
		"factory":    deps,
	}
	for name := range variants {
		broken := deps
		switch name {
		case "authorizer":
			broken.Authorizer = nil
		case "resolver":
			broken.Providers = nil
		case "commands":
			broken.Commands = nil
		case "references":
			broken.References = nil
		case "executions":
			broken.Executions = nil
		case "content":
			broken.Content = nil
		case "factory":
			broken.Factory = nil
		}
		if _, err := New(Config{GatewayID: testGateway}, broken); err == nil {
			t.Fatalf("nil %s accepted", name)
		}
	}
	if _, err := New(Config{GatewayID: "not-a-uuid"}, deps); err == nil {
		t.Fatal("invalid gateway id accepted")
	}

	server, err := New(Config{GatewayID: testGateway}, deps)
	if err != nil {
		t.Fatal(err)
	}
	if server.config.ListenAddr != DefaultListenAddr {
		t.Fatalf("listen addr = %q", server.config.ListenAddr)
	}
}
