package egress_test

// L-C04-02 (DR2 finding 4): reasoning_content and tool_calls are dropped by simply not
// being in the decode struct, so nothing proved an upstream 200 that really carries them
// is filtered on the way in. These two tests are a pair: the first shows the fields never
// reach the Content Store, the second shows the same check is not vacuous - text inside
// the answer does get stored.

import (
	"context"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/egress"
)

const reasoningMarker = "ZZ-REASONING-LEAK-MARKER"

func storedPlaintext(store *memoryStore) string {
	stored := strings.Builder{}
	for _, body := range store.objects {
		stored.Write(body)
	}
	for _, put := range store.puts {
		stored.Write(put.body)
	}
	return stored.String()
}

func TestReasoningContentFromUpstreamNeverReachesStore(t *testing.T) {
	body := `{"id":"` + testProviderID + `","choices":[{"message":{"role":"assistant",` +
		`"content":"ok","reasoning_content":"` + reasoningMarker + `",` +
		`"tool_calls":[{"id":"call_1","type":"function",` +
		`"function":{"name":"lookup","arguments":"{}"}}]},` +
		`"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":30}}`
	exchange, gate, store := sizedExchange(t, body, 1<<20)

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if err != nil {
		t.Fatalf("a 200 with a real answer is not an unknown outcome: %v", err)
	}
	if result.Outcome != egress.OutcomeSucceeded {
		t.Fatalf("outcome = %v, want succeeded", result.Outcome)
	}
	if store.putCount() == 0 || gate.attachCount() == 0 {
		t.Fatalf("stored=%d attach=%d, want both non-zero so the absence below means something",
			store.putCount(), gate.attachCount())
	}
	stored := storedPlaintext(store)
	if !strings.Contains(stored, "ok") {
		t.Fatalf("the answer is missing from what was stored: %q", stored)
	}
	if strings.Contains(stored, reasoningMarker) || strings.Contains(stored, "reasoning_content") {
		t.Fatalf("upstream reasoning leaked into stored content: %q", stored)
	}
	if strings.Contains(stored, "tool_calls") || strings.Contains(stored, "call_1") {
		t.Fatalf("upstream tool_calls leaked into stored content: %q", stored)
	}
}

// The non-vacuity control for the test above: identical fixture except the marker now sits
// inside the answer. If the absence check were reading the wrong thing, this would pass too.
func TestAnswerTextIsStoredSoAbsenceIsMeaningful(t *testing.T) {
	body := `{"id":"` + testProviderID + `","choices":[{"message":{"role":"assistant",` +
		`"content":"here is ` + reasoningMarker + ` inside the answer"},` +
		`"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":30}}`
	exchange, _, store := sizedExchange(t, body, 1<<20)

	if _, err := exchange.Execute(context.Background(), newRequest(t)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(storedPlaintext(store), reasoningMarker) {
		t.Fatalf("marker placed in the answer was not stored - the absence assertion in"+
			" TestReasoningContentFromUpstreamNeverReachesStore would then be vacuous: %q",
			storedPlaintext(store))
	}
}
