package egressservice

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/egress"
	"github.com/we-meet/work/internal/providerctx"
)

const (
	probeTestOrg    = "org-probe-1"
	probeTestGrant  = "aaaaaaaa-1111-4222-8333-444444444444"
	probeTestToken  = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	probeTestAPIKey = "sk-probe-test-key"
)

type fakeProber struct {
	context providerctx.Context
	err     error
	calls   int
	org     string
	grant   string
	token   string
}

func (f *fakeProber) Claim(_ context.Context, orgID, grantID, token string) (providerctx.Context, error) {
	f.calls++
	f.org, f.grant, f.token = orgID, grantID, token
	return f.context, f.err
}

type probeHarness struct {
	server   *http.Handler
	prober   *fakeProber
	factory  *fakeFactory
	provider *fakeProvider
	commands *fakeCommands
	refs     *fakeReferences
	store    *memoryStore
}

func newProbeHarness(t *testing.T, candidate providerctx.Context, claimErr error, callErr error) *probeHarness {
	t.Helper()
	harness := &probeHarness{
		prober:   &fakeProber{context: candidate, err: claimErr},
		factory:  &fakeFactory{},
		provider: &fakeProvider{response: egress.ProviderResponse{Answer: []byte("OK")}, err: callErr},
		commands: newFakeCommands(),
		refs:     newFakeReferences(),
		store:    newMemoryStore(),
	}
	harness.factory.provider = harness.provider
	server, err := New(Config{GatewayID: testGateway}, Dependencies{
		Authorizer: &fakeAuthorizer{allowed: true},
		Providers:  &fakeResolver{},
		Commands:   harness.commands,
		References: harness.refs,
		Executions: &fakeBindings{},
		Content:    harness.store,
		Factory:    harness.factory.build,
		Prober:     harness.prober,
	})
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	handler := server.Handler()
	harness.server = &handler
	return harness
}

func postProbe(t *testing.T, handler *http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, ProbePath, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	(*handler).ServeHTTP(recorder, request)
	return recorder
}

func managedCandidate() providerctx.Context {
	return providerctx.Context{
		Provider: "aliyun", Model: "qwen-max",
		Endpoint: "https://dashscope.example.test/v1",
		Mode:     "managed_key", Secret: []byte(probeTestAPIKey),
	}
}

func validProbeBody() string {
	return `{"org_id":"` + probeTestOrg + `","grant_id":"` + probeTestGrant +
		`","token":"` + probeTestToken + `"}`
}

// TestProbeRouteIsAbsentUntilWired pins the optionality of the dependency: a deployment
// that never provisions the grant path must not expose the route at all.
func TestProbeRouteIsAbsentUntilWired(t *testing.T) {
	server, err := New(Config{GatewayID: testGateway}, Dependencies{
		Authorizer: &fakeAuthorizer{allowed: true},
		Providers:  &fakeResolver{},
		Commands:   newFakeCommands(),
		References: newFakeReferences(),
		Executions: &fakeBindings{},
		Content:    newMemoryStore(),
		Factory:    (&fakeFactory{}).build,
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.Handler()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, ProbePath,
		strings.NewReader(validProbeBody())))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unwired probe status = %d body=%s, want 404", recorder.Code, recorder.Body)
	}
}

func TestProbeVerdicts(t *testing.T) {
	rejection := &egress.ProviderRejection{StatusCode: 401, Code: "invalid_api_key"}
	failure := &egress.ProviderFailure{StatusCode: 429, Code: "rate_limited"}
	unreachable := &egress.ProviderFailure{Code: "transport_error"}

	cases := []struct {
		name        string
		candidate   providerctx.Context
		callErr     error
		wantOutcome string
		wantCode    string
		wantStatus  int
	}{
		{"healthy endpoint", managedCandidate(), nil, "ok", "", http.StatusOK},
		{"provider refused", managedCandidate(), rejection, "rejected", "provider_rejected", http.StatusOK},
		{"rate limited", managedCandidate(), failure, "unknown", "rate_limited", http.StatusOK},
		{"network unreachable", managedCandidate(), unreachable, "unknown", "transport_error", http.StatusOK},
		{"sts role", providerctx.Context{Provider: "aliyun", Mode: "sts_role",
			Endpoint: "https://x.example.test/v1", RoleRef: "role"}, nil, "refused",
			codeGrantRefused, http.StatusOK},
	}
	for _, item := range cases {
		harness := newProbeHarness(t, item.candidate, nil, item.callErr)
		recorder := postProbe(t, harness.server, validProbeBody())
		if recorder.Code != item.wantStatus {
			t.Fatalf("%s: status = %d body=%s", item.name, recorder.Code, recorder.Body)
		}
		var reply probeReply
		if err := json.Unmarshal(recorder.Body.Bytes(), &reply); err != nil {
			t.Fatalf("%s: decode: %v body=%s", item.name, err, recorder.Body)
		}
		if reply.Outcome != item.wantOutcome || reply.Code != item.wantCode {
			t.Fatalf("%s: reply = %+v, want outcome %s code %q",
				item.name, reply, item.wantOutcome, item.wantCode)
		}
		if item.candidate.Mode == "managed_key" && len(item.candidate.Secret) > 0 &&
			harness.prober.calls != 1 {
			t.Fatalf("%s: prober calls = %d, want 1", item.name, harness.prober.calls)
		}
	}
}

// TestProbeWritesNothing is the difference between a probe and an execution: it must not
// consume a gate, attach a receipt, register a content reference or store an object.
func TestProbeWritesNothing(t *testing.T) {
	harness := newProbeHarness(t, managedCandidate(), nil, nil)
	recorder := postProbe(t, harness.server, validProbeBody())
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body)
	}
	if harness.commands.consumeCalls != 0 || harness.commands.attachCalls != 0 {
		t.Fatalf("gate calls: consume %d attach %d, want none",
			harness.commands.consumeCalls, harness.commands.attachCalls)
	}
	if len(harness.refs.registered) != 0 {
		t.Fatalf("content references registered = %d, want none", len(harness.refs.registered))
	}
	if harness.store.puts != 0 {
		t.Fatalf("content objects written = %d, want none", harness.store.puts)
	}
	// The probe must still make exactly one upstream call, and with the candidate's
	// endpoint and key rather than whatever config is live.
	if harness.provider.calls != 1 {
		t.Fatalf("provider calls = %d, want exactly 1", harness.provider.calls)
	}
	if harness.factory.endpoints[0] != "https://dashscope.example.test/v1" ||
		harness.factory.secrets[0] != probeTestAPIKey {
		t.Fatalf("factory got endpoint %q secret %q",
			harness.factory.endpoints[0], harness.factory.secrets[0])
	}
	sent := harness.provider.requests[0]
	if sent.Model != "qwen-max" || sent.Provider != "aliyun" || sent.OrgID != probeTestOrg {
		t.Fatalf("probe request = %+v", sent)
	}
	// A stingy token budget makes a healthy endpoint finish with "length", which the
	// adapter reports as a partial answer - so the probe must use the signed default.
	if sent.Parameters.MaxOutputTokens != 4096 {
		t.Fatalf("probe MaxOutputTokens = %d, want the signed default 4096",
			sent.Parameters.MaxOutputTokens)
	}
}

func TestProbeMalformedRequestsNeverSpendAClaim(t *testing.T) {
	body := validProbeBody()
	var parsed probeRequest
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		body string
	}{
		{"empty", ``},
		{"not json", `nope`},
		{"unknown field", `{"org_id":"o","grant_id":"` + probeTestGrant +
			`","token":"` + probeTestToken + `","extra":1}`},
		{"trailing object", body + ` {}`},
		{"missing token", `{"org_id":"` + probeTestOrg + `","grant_id":"` + probeTestGrant + `"}`},
		{"short token", `{"org_id":"` + probeTestOrg + `","grant_id":"` + probeTestGrant +
			`","token":"abc"}`},
		{"non hex token", `{"org_id":"` + probeTestOrg + `","grant_id":"` + probeTestGrant +
			`","token":"` + strings.Repeat("z", 64) + `"}`},
		{"bad grant", `{"org_id":"` + probeTestOrg + `","grant_id":"not-a-uuid","token":"` +
			probeTestToken + `"}`},
		{"empty org", `{"org_id":"","grant_id":"` + probeTestGrant + `","token":"` +
			probeTestToken + `"}`},
	}
	for _, item := range cases {
		harness := newProbeHarness(t, managedCandidate(), nil, nil)
		recorder := postProbe(t, harness.server, item.body)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status = %d body=%s, want 401", item.name, recorder.Code, recorder.Body)
		}
		var payload struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("%s: decode: %v", item.name, err)
		}
		if payload.Code != codeGrantBad {
			t.Fatalf("%s: code = %q, want %q", item.name, payload.Code, codeGrantBad)
		}
		// The whole point of validating first: a malformed request must not burn the
		// holder's single use.
		if harness.prober.calls != 0 {
			t.Fatalf("%s: claimed %d times on a malformed request", item.name, harness.prober.calls)
		}
	}
}

func TestProbeClaimErrors(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{"invalid grant", &providerctx.Error{Code: providerctx.CodeProbeGrantInvalid},
			http.StatusUnauthorized, codeGrantBad},
		{"unsupported envelope", &providerctx.Error{Code: providerctx.CodeProviderContextUnsupported},
			http.StatusUnauthorized, codeGrantRefused},
		{"unavailable", &providerctx.Error{Code: providerctx.CodeProviderContextUnavailable},
			http.StatusServiceUnavailable, codeGrantUnavail},
		{"bare error is not a verdict", errors.New("pool closed"),
			http.StatusServiceUnavailable, codeGrantUnavail},
	}
	for _, item := range cases {
		harness := newProbeHarness(t, providerctx.Context{}, item.err, nil)
		recorder := postProbe(t, harness.server, validProbeBody())
		if recorder.Code != item.wantStatus {
			t.Fatalf("%s: status = %d, want %d body=%s",
				item.name, recorder.Code, item.wantStatus, recorder.Body)
		}
		if !strings.Contains(recorder.Body.String(), item.wantCode) {
			t.Fatalf("%s: body = %s, want code %q", item.name, recorder.Body, item.wantCode)
		}
		if harness.provider.calls != 0 {
			t.Fatalf("%s: dialled the provider %d times after a failed claim",
				item.name, harness.provider.calls)
		}
	}
}
