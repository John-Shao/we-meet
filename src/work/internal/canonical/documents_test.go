package canonical

import (
	"errors"
	"strings"
	"testing"
)

func objectWith(v Value, key string, value Value) Value {
	members := make([]Member, 0, len(v.Members())+1)
	replaced := false
	for _, m := range v.Members() {
		if m.Key == key {
			m.Value = value
			replaced = true
		}
		members = append(members, m)
	}
	if !replaced {
		members = append(members, Member{Key: key, Value: value})
	}
	return ObjectValue(members...)
}

func objectWithout(v Value, key string) Value {
	members := make([]Member, 0, len(v.Members()))
	for _, m := range v.Members() {
		if m.Key != key {
			members = append(members, m)
		}
	}
	return ObjectValue(members...)
}

func childWith(v Value, child, key string, value Value) Value {
	nested, ok := v.Lookup(child)
	if !ok {
		panic("fixture has no child " + child)
	}
	return objectWith(v, child, objectWith(nested, key, value))
}

func decodeValue(v Value) error {
	raw, err := Encode(v)
	if err != nil {
		return err
	}
	_, err = ParseDocument(raw)
	return err
}

func mustEncode(v Value) []byte {
	raw, err := Encode(v)
	if err != nil {
		panic(err)
	}
	return raw
}

func TestDocumentsRoundTripThroughCanonicalBytes(t *testing.T) {
	documents := []Document{
		testRequest(),
		testInitialState(),
		testReceipt(),
	}
	for _, doc := range documents {
		t.Run(string(doc.DocumentKind()), func(t *testing.T) {
			raw, err := doc.Canonical()
			if err != nil {
				t.Fatalf("Canonical failed: %v", err)
			}
			parsed, err := ParseDocument(raw)
			if err != nil {
				t.Fatalf("ParseDocument failed: %v", err)
			}
			if parsed.DocumentKind() != doc.DocumentKind() {
				t.Fatalf("kind = %s, want %s", parsed.DocumentKind(), doc.DocumentKind())
			}
			again, err := parsed.Canonical()
			if err != nil {
				t.Fatalf("re-encode failed: %v", err)
			}
			if string(again) != string(raw) {
				t.Fatalf("round trip changed the canonical bytes:\n%s\n%s", raw, again)
			}
			wantHash, err := doc.Hash()
			if err != nil {
				t.Fatal(err)
			}
			gotHash, err := parsed.Hash()
			if err != nil {
				t.Fatal(err)
			}
			if gotHash != wantHash {
				t.Fatalf("round trip changed the hash: %s vs %s", gotHash, wantHash)
			}
		})
	}
}

func TestDocumentsRejectUnknownFields(t *testing.T) {
	request := testRequest().Value()
	state := testInitialState().Value()
	receipt := testReceipt().Value()

	cases := []struct {
		name string
		in   Value
	}{
		{"request messages", objectWith(request, "messages", StringValue("synthetic"))},
		{"request reasoning", objectWith(request, "reasoning", StringValue("synthetic"))},
		{"request apiKey", objectWith(request, "apiKey", StringValue("synthetic"))},
		{"request token", objectWith(request, "token", StringValue("synthetic"))},
		{"request sdkState", objectWith(request, "sdkState", StringValue("synthetic"))},
		{"request binding token", childWith(request, "binding", "token", StringValue("synthetic"))},
		{"request route baseUrl", childWith(request, "route", "baseUrl", StringValue("https://example.invalid"))},
		{"request parameters topP", childWith(request, "parameters", "topP", IntValue(1))},
		{"request input extra", objectWith(request, "input", objectWith(testRef(4).value(), "url", StringValue("s3://x")))},
		{"state messages", objectWith(state, "messages", StringValue("synthetic"))},
		{"state sdkState", objectWith(state, "sdkState", StringValue("synthetic"))},
		{"state fence", objectWith(state, "fence", StringValue("1"))},
		{"receipt apiKey", objectWith(receipt, "apiKey", StringValue("synthetic"))},
		{"receipt provider raw response", objectWith(receipt, "providerResponse", StringValue("synthetic"))},
		{"receipt usage extra", childWith(receipt, "usage", "reasoningTokens", IntValue(1))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := decodeValue(tc.in); !errors.Is(err, ErrUnknownField) {
				t.Fatalf("error = %v, want %v", err, ErrUnknownField)
			}
		})
	}
}

func TestDocumentsRequireEveryField(t *testing.T) {
	request := testRequest().Value()
	state := testInitialState().Value()
	receipt := testReceipt().Value()

	for _, key := range []string{"binding", "logicalKey", "input", "template", "priorReceipts", "route", "parameters"} {
		t.Run("request without "+key, func(t *testing.T) {
			if err := decodeValue(objectWithout(request, key)); !errors.Is(err, ErrMissingField) {
				t.Fatalf("error = %v, want %v", err, ErrMissingField)
			}
		})
	}
	t.Run("request without schemaVersion", func(t *testing.T) {
		if err := decodeValue(objectWithout(request, "schemaVersion")); !errors.Is(err, ErrMissingField) {
			t.Fatalf("error = %v, want %v", err, ErrMissingField)
		}
	})
	t.Run("request without kind", func(t *testing.T) {
		if err := decodeValue(objectWithout(request, "kind")); !errors.Is(err, ErrMissingField) {
			t.Fatalf("error = %v, want %v", err, ErrMissingField)
		}
	})
	t.Run("request route without configRevision", func(t *testing.T) {
		route, _ := request.Lookup("route")
		if err := decodeValue(objectWith(request, "route", objectWithout(route, "configRevision"))); !errors.Is(err, ErrMissingField) {
			t.Fatalf("error = %v, want %v", err, ErrMissingField)
		}
	})
	for _, key := range []string{"binding", "revision", "previous", "writerExecutionId", "input", "template", "completedModels", "phase", "pending", "artifact"} {
		t.Run("state without "+key, func(t *testing.T) {
			if err := decodeValue(objectWithout(state, key)); !errors.Is(err, ErrMissingField) {
				t.Fatalf("error = %v, want %v", err, ErrMissingField)
			}
		})
	}
	for _, key := range []string{"receiptId", "binding", "logicalKey", "operationId", "dispatchAttemptId", "executionId", "requestHash", "writerGatewayId", "recordedAtUnixMs", "outcome", "providerRequestId", "content", "contentBytes", "usage", "rejectionEvidence"} {
		t.Run("receipt without "+key, func(t *testing.T) {
			if err := decodeValue(objectWithout(receipt, key)); !errors.Is(err, ErrMissingField) {
				t.Fatalf("error = %v, want %v", err, ErrMissingField)
			}
		})
	}
}

func TestDocumentsEnforceFieldShapes(t *testing.T) {
	request := testRequest().Value()
	state := testInitialState().Value()
	receipt := testReceipt().Value()

	cases := []struct {
		name string
		in   Value
		want error
	}{
		{"kind mismatch", objectWith(request, "kind", StringValue("model_intent")), ErrUnsupportedSchemaVersion},
		{"schema version mismatch", objectWith(request, "schemaVersion", StringValue("work-model-request-v2")), ErrSchemaViolation},
		{"logical key out of range", objectWith(request, "logicalKey", StringValue("model:4")), ErrSchemaViolation},
		{"logical key wrong shape", objectWith(request, "logicalKey", StringValue("1")), ErrSchemaViolation},
		{"provider not approved", childWith(request, "route", "provider", StringValue("openai")), ErrSchemaViolation},
		{"configRevision zero", childWith(request, "route", "configRevision", StringValue("0")), ErrSchemaViolation},
		{"configRevision overflows bigint", childWith(request, "route", "configRevision", StringValue("9999999999999999999")), ErrSchemaViolation},
		{"configRevision as integer", childWith(request, "route", "configRevision", IntValue(1)), ErrSchemaViolation},
		{"temperatureMilli above 2000", childWith(request, "parameters", "temperatureMilli", IntValue(2001)), ErrSchemaViolation},
		{"temperatureMilli negative", childWith(request, "parameters", "temperatureMilli", IntValue(-1)), ErrSchemaViolation},
		{"maxOutputTokens zero", childWith(request, "parameters", "maxOutputTokens", IntValue(0)), ErrSchemaViolation},
		{"outputFormat not markdown", childWith(request, "parameters", "outputFormat", StringValue("html")), ErrSchemaViolation},
		{"orgId invalid", childWith(request, "binding", "orgId", StringValue("org 1")), ErrSchemaViolation},
		{"taskId not a uuid", childWith(request, "binding", "taskId", StringValue("task-1")), ErrSchemaViolation},
		{"runtimeVersion invalid", childWith(request, "binding", "runtimeVersion", StringValue("pi 1.4.0")), ErrSchemaViolation},
		{"input hash uppercase", objectWith(request, "input", objectWith(testRef(4).value(), "hash", StringValue("sha256:"+strings.Repeat("A", 64)))), ErrSchemaViolation},
		{"input hash too short", objectWith(request, "input", objectWith(testRef(4).value(), "hash", StringValue("sha256:"+strings.Repeat("a", 63)))), ErrSchemaViolation},
		{"input hash wrong algorithm", objectWith(request, "input", objectWith(testRef(4).value(), "hash", StringValue("sha512:"+strings.Repeat("a", 64)))), ErrSchemaViolation},
		{"priorReceipts too many", objectWith(request, "priorReceipts", ArrayValue(testRef(30).value(), testRef(31).value(), testRef(32).value())), ErrSchemaViolation},
		{"revision as string", objectWith(state, "revision", StringValue("0")), ErrSchemaViolation},
		{"revision above the cap", objectWith(state, "revision", IntValue(1000001)), ErrSchemaViolation},
		{"phase unknown", objectWith(objectWith(state, "phase", StringValue("paused")), "revision", IntValue(0)), ErrSchemaViolation},
		{"writerExecutionId not a uuid", objectWith(state, "writerExecutionId", StringValue("exec-1")), ErrSchemaViolation},
		{"completedModels too many", objectWith(state, "completedModels", ArrayValue(
			testCompletedModel(1).value(), testCompletedModel(2).value(), testCompletedModel(3).value(),
			objectWith(testCompletedModel(3).value(), "logicalKey", StringValue("model:3")),
		)), ErrSchemaViolation},
		{"outcome unknown is not terminal", objectWith(receipt, "outcome", StringValue("unknown")), ErrSchemaViolation},
		{"outcome aborted is not terminal", objectWith(receipt, "outcome", StringValue("aborted")), ErrSchemaViolation},
		{"providerRequestId empty string", objectWith(receipt, "providerRequestId", StringValue("")), ErrSchemaViolation},
		{"providerRequestId with spaces", objectWith(receipt, "providerRequestId", StringValue("req 1")), ErrSchemaViolation},
		{"recordedAtUnixMs zero", objectWith(receipt, "recordedAtUnixMs", IntValue(0)), ErrSchemaViolation},
		{"contentBytes above the body limit", objectWith(receipt, "contentBytes", IntValue(MaxBodyBytes+1)), ErrSchemaViolation},
		{"usage source unknown", childWith(receipt, "usage", "source", StringValue("estimate")), ErrSchemaViolation},
		{"usage token negative", childWith(receipt, "usage", "outputTokens", IntValue(-1)), ErrSchemaViolation},
		{"pending as a string", objectWith(state, "pending", StringValue("model:1")), ErrSchemaViolation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := decodeValue(tc.in); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestDocumentsAcceptTheSignedPositiveShapes(t *testing.T) {
	requestHash, err := testRequest().Hash()
	if err != nil {
		t.Fatal(err)
	}
	pending := ModelIntent{Request: testRef(6), RequestHash: requestHash, LogicalKey: LogicalKey1}

	awaiting := testInitialState()
	awaiting.Revision = 1
	awaiting.Previous = Ref(testRef(13))
	awaiting.Phase = PhaseAwaitingModel
	awaiting.Pending = &pending

	finished := testInitialState()
	finished.Revision = 2
	finished.Previous = Ref(testRef(13))
	finished.Phase = PhaseFinished
	finished.CompletedModels = []CompletedModel{testCompletedModel(1)}
	finished.Artifact = Ref(testRef(12))

	secondRequest := testRequest()
	secondRequest.LogicalKey = LogicalKey2
	secondRequest.PriorReceipts = []Reference{testRef(21)}

	unavailableUsage := testReceipt()
	unavailableUsage.Usage = Usage{Source: UsageUnavailable}

	rejected := testReceipt()
	rejected.Outcome = OutcomeRejectedNotExec
	rejected.Content = nil
	rejected.ContentBytes = 0
	rejected.RejectionEvidence = Ref(testRef(14))
	rejected.Usage = Usage{Source: UsageProvider, InputTokens: Int64(0), OutputTokens: Int64(0), CachedInputTokens: Int64(0)}

	noProviderID := testReceipt()
	noProviderID.ProviderRequestID = nil

	noTemplate := testInitialState()
	noTemplate.Template = nil

	for _, doc := range []Document{
		testRequest(), secondRequest, testInitialState(), noTemplate, awaiting, finished,
		testReceipt(), unavailableUsage, rejected, noProviderID,
	} {
		raw, err := doc.Canonical()
		if err != nil {
			t.Fatalf("%s canonical failed: %v", doc.DocumentKind(), err)
		}
		if _, err := ParseDocument(raw); err != nil {
			t.Fatalf("%s round trip rejected a signed positive shape: %v\n%s", doc.DocumentKind(), err, raw)
		}
	}
}

func TestParseDocumentRejectsForeignDocuments(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want error
	}{
		{"advance request wire message", `{"kind":"advance_request","contractVersion":"work-runtime-fragment-v1"}`, ErrUnsupportedSchemaVersion},
		{"missing kind", `{"schemaVersion":"work-canonical-v1"}`, ErrMissingField},
		{"array document", `[]`, ErrSchemaViolation},
		{"string document", `"model_request"`, ErrSchemaViolation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseDocument([]byte(tc.raw)); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}
