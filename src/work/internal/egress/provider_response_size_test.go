package egress_test

// L-C04-01 (DR2 finding 3): the response-size bound had no assertion at all - deleting
// the check left CI green. These tests pin the refusal code and the half that matters
// operationally: an oversized answer never reaches the Content Store and is never
// attached to the execution. Everything runs through the exchange, which is the path
// the worker actually calls.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/egress"
)

func sizedExchange(t *testing.T, body string, maxBytes int64) (*egress.Exchange, *gateFixture, *memoryStore) {
	t.Helper()
	server := httptest.NewServer(statusHandler(http.StatusOK, body))
	t.Cleanup(server.Close)
	provider, err := egress.NewHTTPProvider(egress.HTTPProviderConfig{
		Endpoint:         server.URL + "/v1/chat/completions",
		MaxResponseBytes: maxBytes,
		Credential: func(context.Context, string) (string, error) {
			return testAPIKey, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	gate := newGate()
	store := newMemoryStore()
	return newExchange(gate, provider, store), gate, store
}

func TestOversizedProviderResponseIsRefusedAndNeverStored(t *testing.T) {
	oversized := `{"id":"` + testProviderID + `","choices":[{"message":{"role":"assistant",` +
		`"content":"` + strings.Repeat("x", 4096) + `"},"finish_reason":"stop"}],"usage":` +
		`{"prompt_tokens":120,"completion_tokens":1024}}`
	exchange, gate, store := sizedExchange(t, oversized, 512)

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if !errors.Is(err, egress.ErrUnknownOutcome) {
		t.Fatalf("err = %v, want ErrUnknownOutcome", err)
	}
	if result.Outcome != egress.OutcomeUnknown {
		t.Fatalf("outcome = %v, want unknown", result.Outcome)
	}
	// UnknownError.Reason is what the audit row and the duty readout carry, so assert the
	// bound by that code rather than by any error at all: a refusal from further down the
	// path (an unparseable body, a status mismatch) would otherwise look the same here.
	var unknown *egress.UnknownError
	if !errors.As(err, &unknown) {
		t.Fatalf("err = %v, want a *egress.UnknownError carrying the bound code", err)
	}
	if unknown.Reason != "response_too_large" {
		t.Fatalf("reason = %q, want response_too_large - the bound, not a later refusal", unknown.Reason)
	}
	if store.putCount() != 0 || gate.attachCount() != 0 {
		t.Fatalf("stored=%d attach=%d, want 0/0 - the oversized body must never be written"+
			" or attached, and no usage may be settled from it", store.putCount(), gate.attachCount())
	}
}

// The bound must not reject a body exactly at the limit. Without this the refusal test
// would still pass if someone tightened the comparison to >=, which turns a legal
// provider answer into an unknown outcome under load.
func TestProviderResponseExactlyAtBoundIsAccepted(t *testing.T) {
	exact := `{"id":"` + testProviderID + `","choices":[{"message":{"role":"assistant",` +
		`"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":30}}`
	if len(exact) > 1024 {
		t.Fatalf("fixture body is %d bytes; keep the planned bound above it", len(exact))
	}
	exchange, gate, store := sizedExchange(t, exact, int64(len(exact)))

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if err != nil {
		t.Fatalf("a body exactly at the bound is legal, and must not become unknown: %v", err)
	}
	if result.Outcome != egress.OutcomeSucceeded {
		t.Fatalf("outcome = %v, want succeeded", result.Outcome)
	}
	if store.putCount() == 0 || gate.attachCount() == 0 {
		t.Fatalf("stored=%d attach=%d, want both non-zero: the legal answer must be persisted",
			store.putCount(), gate.attachCount())
	}
}
