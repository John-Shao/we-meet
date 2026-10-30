package canonical

import (
	"errors"
	"strings"
	"testing"
)

// Cross-check vectors produced by the signed reference model
// docs/plan/assets/work-r0a-orchestration-2026-10-25/runtime-recovery.model.mjs
// on the fixtures of runtime-recovery.test.mjs:
//
//	node --input-type=module -e "
//	  import { canonicalJson, documentHash } from './runtime-recovery.model.mjs';
//	  ... request / checkpoint / receipt fixtures from runtime-recovery.test.mjs ...
//	  console.log(canonicalJson(request), documentHash(request),
//	              documentHash(checkpoint), documentHash(receipt));"
//
// If these constants ever need to change, the Node runtime, the egress gateway
// and the control plane have stopped agreeing on request hashes and the send
// gate can no longer be bound to a request.
const (
	vectorRequestCanonical = `{"binding":{"orgId":"org_1","runId":"00000000-0000-4000-8000-000000000002","runtimeVersion":"pi-1.4.0-build1","snapshotId":"00000000-0000-4000-8000-000000000003","taskId":"00000000-0000-4000-8000-000000000001"},"input":{"hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","refId":"00000000-0000-4000-8000-000000000004"},"kind":"model_request","logicalKey":"model:1","parameters":{"maxOutputTokens":2048,"outputFormat":"markdown","temperatureMilli":500},"priorReceipts":[],"route":{"compatProfileVersion":"v1","configRevision":"1","model":"qwen-text","provider":"aliyun"},"schemaVersion":"work-model-request-v1","template":{"hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","refId":"00000000-0000-4000-8000-000000000005"}}`

	vectorRequestHash = "sha256:3c040033fc546bb7c075161c9136bc030c113dc02d6de7d6dd10c24fe78755ce"
	vectorStateHash   = "sha256:2c20b2b9046e276bd8a02c4edc0b3f5b6722711d524983789e40e954c3c2cfe9"
	vectorReceiptHash = "sha256:403db897fdde223f50657789b4d086a6365ee27856ea16deb5b6611c13be3ffd"
)

func TestCanonicalFormMatchesNodeReference(t *testing.T) {
	got, err := testRequest().Canonical()
	if err != nil {
		t.Fatalf("Canonical failed: %v", err)
	}
	if string(got) != vectorRequestCanonical {
		t.Fatalf("canonical model_request diverged from the Node reference:\ngot  %s\nwant %s", got, vectorRequestCanonical)
	}
}

func TestDocumentHashMatchesNodeReference(t *testing.T) {
	cases := []struct {
		name string
		doc  Document
		want string
	}{
		{"model_request", testRequest(), vectorRequestHash},
		{"canonical_state", testInitialState(), vectorStateHash},
		{"model_receipt", testReceipt(), vectorReceiptHash},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := tc.doc.Hash()
			if err != nil {
				t.Fatalf("Hash failed: %v", err)
			}
			if got != tc.want {
				t.Fatalf("hash = %s, want %s", got, tc.want)
			}
			if !ValidHash(got) {
				t.Fatalf("hash %q is not rendered as lowercase sha256:<hex>", got)
			}
			if !strings.HasPrefix(got, "sha256:") || got != strings.ToLower(got) {
				t.Fatalf("hash %q must be lowercase sha256:<hex>", got)
			}

			raw, err := tc.doc.Canonical()
			if err != nil {
				t.Fatal(err)
			}
			fromBytes, err := HashDocumentBytes(raw)
			if err != nil {
				t.Fatalf("HashDocumentBytes failed: %v", err)
			}
			if fromBytes != got {
				t.Fatalf("recomputing from stored bytes gave %s, want %s", fromBytes, got)
			}
		})
	}
}

func TestDocumentHashIsStableAndOrderIndependent(t *testing.T) {
	doc := testRequest()
	want, err := doc.Hash()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		got, err := doc.Hash()
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("hash is not idempotent: %s then %s", want, got)
		}
	}

	// The same document with its object keys written in a different order must
	// recompute to the same hash: that is the property the gateway relies on
	// when it re-reads a stored request document.
	permuted := `{"schemaVersion":"work-model-request-v1","parameters":{"temperatureMilli":500,"outputFormat":"markdown","maxOutputTokens":2048},"route":{"provider":"aliyun","model":"qwen-text","configRevision":"1","compatProfileVersion":"v1"},"priorReceipts":[],"template":{"refId":"00000000-0000-4000-8000-000000000005","hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"input":{"refId":"00000000-0000-4000-8000-000000000004","hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"logicalKey":"model:1","binding":{"runtimeVersion":"pi-1.4.0-build1","snapshotId":"00000000-0000-4000-8000-000000000003","runId":"00000000-0000-4000-8000-000000000002","taskId":"00000000-0000-4000-8000-000000000001","orgId":"org_1"},"kind":"model_request"}`
	got, err := HashDocumentBytes([]byte(permuted))
	if err != nil {
		t.Fatalf("HashDocumentBytes failed: %v", err)
	}
	if got != want {
		t.Fatalf("key order changed the hash: %s vs %s", got, want)
	}
}

func TestDocumentHashChangesWithMeaning(t *testing.T) {
	base, err := testRequest().Hash()
	if err != nil {
		t.Fatal(err)
	}
	variants := map[string]func(ModelRequest) ModelRequest{
		"model":            func(d ModelRequest) ModelRequest { d.Route.Model = "other"; return d },
		"snapshot":         func(d ModelRequest) ModelRequest { d.Binding.SnapshotID = testUUID(50); return d },
		"input version":    func(d ModelRequest) ModelRequest { d.Input.Hash = testHash('b'); return d },
		"maxOutputTokens":  func(d ModelRequest) ModelRequest { d.Parameters.MaxOutputTokens = 4096; return d },
		"temperatureMilli": func(d ModelRequest) ModelRequest { d.Parameters.TemperatureMilli = 501; return d },
		"configRevision":   func(d ModelRequest) ModelRequest { d.Route.ConfigRevision = "2"; return d },
		"compatProfile":    func(d ModelRequest) ModelRequest { d.Route.CompatProfileVersion = "v2"; return d },
	}
	for name, mutate := range variants {
		t.Run(name, func(t *testing.T) {
			got, err := mutate(testRequest()).Hash()
			if err != nil {
				t.Fatal(err)
			}
			if got == base {
				t.Fatalf("changing %s must change the request hash", name)
			}
		})
	}
}

func TestHashValueRequiresAMatchingDomain(t *testing.T) {
	raw, err := testRequest().Canonical()
	if err != nil {
		t.Fatal(err)
	}
	v, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := HashValue(v); err != nil {
		t.Fatalf("HashValue on a well-formed document failed: %v", err)
	}

	cases := []struct {
		name string
		raw  string
		want error
	}{
		{"unknown kind", `{"kind":"model_intent","schemaVersion":"work-model-request-v1"}`, ErrUnsupportedSchemaVersion},
		{"schema version does not match kind", `{"kind":"model_request","schemaVersion":"work-canonical-v1"}`, ErrUnsupportedSchemaVersion},
		{"schema version unknown", `{"kind":"model_request","schemaVersion":"unknown"}`, ErrUnsupportedSchemaVersion},
		{"kind missing", `{"schemaVersion":"work-model-request-v1"}`, ErrMissingField},
		{"not an object", `["model_request"]`, ErrSchemaViolation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := HashDocumentBytes([]byte(tc.raw)); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}

	if _, err := HashCanonical("work-runtime-fragment-v1", ObjectValue()); !errors.Is(err, ErrUnsupportedSchemaVersion) {
		t.Fatalf("HashCanonical must only accept the three document domains, got %v", err)
	}
}

func TestHashCanonicalEnforcesThePrefixedSizeLimit(t *testing.T) {
	// The limit applies to schemaVersion + LF + canonical_json, so the usable
	// payload is MaxDocumentBytes minus the domain and the newline.
	overhead := len(SchemaVersionCanonicalState) + 1 + len(`{"a":""}`)
	fits := ObjectValue(Field("a", StringValue(strings.Repeat("x", MaxDocumentBytes-overhead))))
	if _, err := HashCanonical(SchemaVersionCanonicalState, fits); err != nil {
		t.Fatalf("a document at exactly %d prefixed bytes must be accepted: %v", MaxDocumentBytes, err)
	}
	over := ObjectValue(Field("a", StringValue(strings.Repeat("x", MaxDocumentBytes-overhead+1))))
	if _, err := HashCanonical(SchemaVersionCanonicalState, over); !errors.Is(err, ErrDocumentTooLarge) {
		t.Fatalf("one byte over the prefixed limit error = %v, want %v", err, ErrDocumentTooLarge)
	}
}

func TestBodyHashIsTheRawFormAndIsNeverMixedWithDocumentHashes(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"empty body", "", "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
		{"ascii body", "hello", "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := BodyHash([]byte(tc.body))
			if err != nil {
				t.Fatalf("BodyHash failed: %v", err)
			}
			if got != tc.want {
				t.Fatalf("BodyHash = %s, want %s", got, tc.want)
			}
		})
	}

	// A document's own canonical bytes hashed as a body must not equal its
	// document hash: the domain prefix is what keeps the two kinds apart.
	raw, err := testRequest().Canonical()
	if err != nil {
		t.Fatal(err)
	}
	asBody, err := BodyHash(raw)
	if err != nil {
		t.Fatal(err)
	}
	if asBody == vectorRequestHash {
		t.Fatalf("body hash and request hash must differ for the same bytes")
	}

	if _, err := BodyHash([]byte{0xff}); !errors.Is(err, ErrInvalidUnicode) {
		t.Fatalf("BodyHash must reject invalid UTF-8, got %v", err)
	}
	if _, err := BodyHash(make([]byte, MaxBodyBytes+1)); !errors.Is(err, ErrDocumentTooLarge) {
		t.Fatalf("BodyHash must reject oversized bodies, got %v", err)
	}
}

func TestReferenceKindSelectsTheHashForm(t *testing.T) {
	cases := []struct {
		kind ReferenceKind
		want HashForm
	}{
		{RefKindModelRequest, HashFormDocument},
		{RefKindCanonicalState, HashFormDocument},
		{RefKindModelReceipt, HashFormDocument},
		{RefKindTaskInputBody, HashFormBody},
		{RefKindSystemTemplateBody, HashFormBody},
		{RefKindPublicAnswerBody, HashFormBody},
		{RefKindArtifactBody, HashFormBody},
		{RefKindRejectionEvidence, HashFormBody},
	}
	for _, tc := range cases {
		got, err := tc.kind.HashForm()
		if err != nil {
			t.Fatalf("%s: %v", tc.kind, err)
		}
		if got != tc.want {
			t.Fatalf("%s hash form = %s, want %s", tc.kind, got, tc.want)
		}
	}
	if _, err := ReferenceKind("receipt_slot").HashForm(); !errors.Is(err, ErrSchemaViolation) {
		t.Fatalf("an unregistered reference kind must be rejected, got %v", err)
	}
	if _, err := RefKindPublicAnswerBody.DocumentKind(); !errors.Is(err, ErrHashFormMismatch) {
		t.Fatalf("a body kind has no document kind, got %v", err)
	}
}

func TestVerifyReferenceRefusesTheWrongHashForm(t *testing.T) {
	raw, err := testRequest().Canonical()
	if err != nil {
		t.Fatal(err)
	}
	documentRef := Reference{RefID: testUUID(6), Hash: vectorRequestHash}
	if err := VerifyReference(RefKindModelRequest, documentRef, raw); err != nil {
		t.Fatalf("verifying a request document against its request hash failed: %v", err)
	}

	// Registering the same bytes under a body kind must not verify: that is
	// exactly the forbidden "正文 hash" / "请求 hash" mix.
	if err := VerifyReference(RefKindPublicAnswerBody, documentRef, raw); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("a request hash must not verify a body reference, got %v", err)
	}

	answer := []byte("# answer\n")
	bodyHash, err := BodyHash(answer)
	if err != nil {
		t.Fatal(err)
	}
	bodyRef := Reference{RefID: testUUID(12), Hash: bodyHash}
	if err := VerifyReference(RefKindPublicAnswerBody, bodyRef, answer); err != nil {
		t.Fatalf("verifying a public answer body failed: %v", err)
	}
	if err := VerifyReference(RefKindModelRequest, bodyRef, answer); err == nil {
		t.Fatalf("a body must not verify as a model_request document")
	}
	if err := VerifyReference(RefKindCanonicalState, Reference{RefID: testUUID(7), Hash: vectorRequestHash}, raw); !errors.Is(err, ErrSchemaViolation) {
		t.Fatalf("a request document must not verify under the canonical_state kind, got %v", err)
	}
	if err := VerifyReference(RefKindPublicAnswerBody, Reference{RefID: "not-a-uuid", Hash: bodyHash}, answer); !errors.Is(err, ErrSchemaViolation) {
		t.Fatalf("an invalid reference shape must be rejected, got %v", err)
	}
}

func TestValidateDecimalBigintFields(t *testing.T) {
	cases := []struct {
		name    string
		value   string
		fence   bool
		wantErr bool
	}{
		{"configRevision one", "1", false, false},
		{"configRevision bigint max", "9223372036854775807", false, false},
		{"configRevision above bigint max", "9223372036854775808", false, true},
		{"configRevision nineteen nines passes the pattern but overflows", "9999999999999999999", false, true},
		{"configRevision zero", "0", false, true},
		{"configRevision leading zero", "01", false, true},
		{"configRevision empty", "", false, true},
		{"configRevision non numeric", "1e3", false, true},
		{"fence zero", "0", true, false},
		{"fence bigint max", "9223372036854775807", true, false},
		{"fence above bigint max", "9223372036854775808", true, true},
		{"fence negative", "-1", true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var err error
			if tc.fence {
				_, err = ValidateFence(tc.value)
			} else {
				_, err = ValidateConfigRevision(tc.value)
			}
			if tc.wantErr && err == nil {
				t.Fatalf("expected %q to be rejected", tc.value)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected %q to be accepted: %v", tc.value, err)
			}
		})
	}
}
