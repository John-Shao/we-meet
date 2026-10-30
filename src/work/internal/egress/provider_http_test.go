package egress_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/we-meet/work/internal/egress"
)

func TestHTTPProviderDoesNotFollowRedirects(t *testing.T) {
	var targetHits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetHits.Add(1)
		_, _ = w.Write(completionBody("redirected answer", true))
	}))
	defer target.Close()

	store := newMemoryStore()
	gate := newGate()
	provider := newProvider(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	})
	exchange := newExchange(gate, provider.provider, store)

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if !errors.Is(err, egress.ErrUnknownOutcome) {
		t.Fatalf("err = %v, want ErrUnknownOutcome", err)
	}
	var unknown *egress.UnknownError
	if !errors.As(err, &unknown) || unknown.Reason != "redirect_refused" {
		t.Fatalf("reason = %v, want redirect_refused", err)
	}
	if provider.requests.Load() != 1 {
		t.Fatalf("gateway hit origin %d times, want exactly 1", provider.requests.Load())
	}
	if targetHits.Load() != 0 {
		t.Fatalf("redirect target was contacted %d times, want 0", targetHits.Load())
	}
	if result.Receipt != nil || gate.attachCount() != 0 || store.putCount() != 0 {
		t.Fatalf("redirect produced a receipt or content: %+v", result)
	}
}

func TestHTTPProviderRejectsUnapprovedEndpoints(t *testing.T) {
	credential := func(context.Context, string) (string, error) { return testAPIKey, nil }
	cases := []struct {
		name     string
		endpoint string
		cred     func(context.Context, string) (string, error)
		wantErr  bool
	}{
		{name: "plain_http_remote", endpoint: "http://provider.example.com/v1/chat", cred: credential, wantErr: true},
		{name: "relative", endpoint: "/v1/chat", cred: credential, wantErr: true},
		{name: "empty", endpoint: "", cred: credential, wantErr: true},
		{name: "userinfo", endpoint: "https://user:key@provider.example.com/v1", cred: credential, wantErr: true},
		{name: "https", endpoint: "https://provider.example.com/v1/chat", cred: credential},
		{name: "loopback_http", endpoint: "http://127.0.0.1:1234/v1/chat", cred: credential},
		{name: "no_credential_resolver", endpoint: "https://provider.example.com/v1", cred: nil, wantErr: true},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			_, err := egress.NewHTTPProvider(egress.HTTPProviderConfig{
				Endpoint:   testCase.endpoint,
				Credential: testCase.cred,
			})
			if testCase.wantErr && err == nil {
				t.Fatal("endpoint accepted, want rejection")
			}
			if !testCase.wantErr && err != nil {
				t.Fatalf("endpoint rejected: %v", err)
			}
		})
	}
}

func TestCredentialFailureIsUnknownWithoutSending(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write(completionBody("answer", true))
	}))
	defer server.Close()
	provider, err := egress.NewHTTPProvider(egress.HTTPProviderConfig{
		Endpoint: server.URL + "/v1/chat/completions",
		Credential: func(context.Context, string) (string, error) {
			return "", errors.New("revoked provider credential value sk-live-should-not-leak")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	store := newMemoryStore()
	gate := newGate()
	exchange := newExchange(gate, provider, store)

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if !errors.Is(err, egress.ErrUnknownOutcome) {
		t.Fatalf("err = %v, want ErrUnknownOutcome", err)
	}
	var unknown *egress.UnknownError
	if !errors.As(err, &unknown) || unknown.Reason != "credential_unavailable" {
		t.Fatalf("reason = %v, want credential_unavailable", err)
	}
	if hits.Load() != 0 {
		t.Fatalf("request left the process without a credential: %d", hits.Load())
	}
	if result.Outcome != egress.OutcomeUnknown || !result.Sent {
		t.Fatalf("result = %+v, want unknown and sent", result)
	}
	if gate.attachCount() != 0 || store.putCount() != 0 {
		t.Fatalf("attach=%d stored=%d, want 0/0", gate.attachCount(), store.putCount())
	}
}

func TestUnparseableProviderBodyIsUnknown(t *testing.T) {
	store := newMemoryStore()
	gate := newGate()
	provider := newProvider(t, statusHandler(http.StatusOK, `not json`))
	exchange := newExchange(gate, provider.provider, store)

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if !errors.Is(err, egress.ErrUnknownOutcome) {
		t.Fatalf("err = %v, want ErrUnknownOutcome", err)
	}
	if result.Outcome != egress.OutcomeUnknown || gate.attachCount() != 0 || store.putCount() != 0 {
		t.Fatalf("result=%+v attach=%d stored=%d", result, gate.attachCount(), store.putCount())
	}
}
