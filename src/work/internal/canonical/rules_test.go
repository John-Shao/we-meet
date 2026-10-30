package canonical

import (
	"errors"
	"testing"
)

func mustHash(t *testing.T, doc Document) string {
	t.Helper()
	hash, err := doc.Hash()
	if err != nil {
		t.Fatalf("hash failed: %v", err)
	}
	return hash
}

func testPending(t *testing.T, key LogicalKey) *ModelIntent {
	t.Helper()
	request := testRequest()
	request.LogicalKey = key
	index, _ := key.Index()
	for i := 1; i < index; i++ {
		request.PriorReceipts = append(request.PriorReceipts, testRef(20+i))
	}
	hash := mustHash(t, request)
	return &ModelIntent{Request: Reference{RefID: testUUID(6), Hash: hash}, RequestHash: hash, LogicalKey: key}
}

func TestCanonicalStateStructuralRules(t *testing.T) {
	initial := testInitialState()

	readyAfterOne := testInitialState()
	readyAfterOne.Revision = 1
	readyAfterOne.Previous = Ref(testRef(13))
	readyAfterOne.CompletedModels = []CompletedModel{testCompletedModel(1)}

	awaitingFirst := testInitialState()
	awaitingFirst.Revision = 1
	awaitingFirst.Previous = Ref(testRef(13))
	awaitingFirst.Phase = PhaseAwaitingModel
	awaitingFirst.Pending = testPending(t, LogicalKey1)

	awaitingThird := testInitialState()
	awaitingThird.Revision = 5
	awaitingThird.Previous = Ref(testRef(13))
	awaitingThird.Phase = PhaseAwaitingModel
	awaitingThird.CompletedModels = []CompletedModel{testCompletedModel(1), testCompletedModel(2)}
	awaitingThird.Pending = testPending(t, LogicalKey3)

	finished := testInitialState()
	finished.Revision = 2
	finished.Previous = Ref(testRef(13))
	finished.Phase = PhaseFinished
	finished.CompletedModels = []CompletedModel{testCompletedModel(1)}
	finished.Artifact = Ref(testRef(12))

	allThree := testInitialState()
	allThree.Revision = 6
	allThree.Previous = Ref(testRef(13))
	allThree.CompletedModels = []CompletedModel{testCompletedModel(1), testCompletedModel(2), testCompletedModel(3)}

	mutate := func(base CanonicalState, fn func(*CanonicalState)) CanonicalState {
		copied := base
		copied.CompletedModels = append([]CompletedModel(nil), base.CompletedModels...)
		fn(&copied)
		return copied
	}

	positive := []struct {
		name  string
		state CanonicalState
	}{
		{"revision zero is the initial ready state", initial},
		{"ready after one confirmed model", readyAfterOne},
		{"awaiting the first model", awaitingFirst},
		{"awaiting the third model after two", awaitingThird},
		{"finished with an artifact", finished},
		{"ready with all three models confirmed", allThree},
		{"initial state without a template", mutate(initial, func(s *CanonicalState) { s.Template = nil })},
	}
	for _, tc := range positive {
		t.Run("accept "+tc.name, func(t *testing.T) {
			if err := tc.state.Validate(); err != nil {
				t.Fatalf("Validate rejected a legal state: %v", err)
			}
		})
	}

	negative := []struct {
		name  string
		state CanonicalState
		want  error
	}{
		{"revision zero with a predecessor", mutate(initial, func(s *CanonicalState) { s.Previous = Ref(testRef(13)) }), ErrStructuralViolation},
		{"revision zero that is not ready", mutate(initial, func(s *CanonicalState) {
			s.Phase = PhaseAwaitingModel
			s.Pending = testPending(t, LogicalKey1)
		}), ErrStructuralViolation},
		{"revision zero with completed models", mutate(initial, func(s *CanonicalState) {
			s.CompletedModels = []CompletedModel{testCompletedModel(1)}
		}), ErrStructuralViolation},
		{"later revision without a predecessor", mutate(initial, func(s *CanonicalState) { s.Revision = 1 }), ErrStructuralViolation},
		{"ready carrying a pending request", mutate(readyAfterOne, func(s *CanonicalState) { s.Pending = testPending(t, LogicalKey2) }), ErrStructuralViolation},
		{"ready carrying an artifact", mutate(readyAfterOne, func(s *CanonicalState) { s.Artifact = Ref(testRef(12)) }), ErrStructuralViolation},
		{"awaiting_model without a pending request", mutate(awaitingFirst, func(s *CanonicalState) { s.Pending = nil }), ErrStructuralViolation},
		{"awaiting_model with an artifact", mutate(awaitingFirst, func(s *CanonicalState) { s.Artifact = Ref(testRef(12)) }), ErrStructuralViolation},
		{"pending logical key ahead of the completed count", mutate(awaitingFirst, func(s *CanonicalState) {
			s.Pending = testPending(t, LogicalKey2)
		}), ErrStructuralViolation},
		{"pending logical key behind the completed count", mutate(awaitingThird, func(s *CanonicalState) {
			s.Pending = testPending(t, LogicalKey2)
		}), ErrStructuralViolation},
		{"pending a fourth model call", mutate(allThree, func(s *CanonicalState) {
			s.Phase = PhaseAwaitingModel
			s.Pending = testPending(t, LogicalKey3)
		}), ErrStructuralViolation},
		{"finished without an artifact", mutate(finished, func(s *CanonicalState) { s.Artifact = nil }), ErrStructuralViolation},
		{"finished retaining a pending request", mutate(finished, func(s *CanonicalState) { s.Pending = testPending(t, LogicalKey2) }), ErrStructuralViolation},
		{"finished without any completed model", mutate(finished, func(s *CanonicalState) { s.CompletedModels = nil }), ErrStructuralViolation},
		{"completed models starting at model:2", mutate(readyAfterOne, func(s *CanonicalState) {
			s.CompletedModels = []CompletedModel{testCompletedModel(2)}
		}), ErrStructuralViolation},
		{"completed models with a gap", mutate(readyAfterOne, func(s *CanonicalState) {
			s.CompletedModels = []CompletedModel{testCompletedModel(1), testCompletedModel(3)}
		}), ErrStructuralViolation},
		{"completed models with a duplicated logical key", mutate(readyAfterOne, func(s *CanonicalState) {
			second := testCompletedModel(1)
			second.Receipt = testRef(99)
			s.CompletedModels = []CompletedModel{testCompletedModel(1), second}
		}), ErrStructuralViolation},
		{"completed models reusing one receipt", mutate(readyAfterOne, func(s *CanonicalState) {
			second := testCompletedModel(2)
			second.Receipt = testCompletedModel(1).Receipt
			s.CompletedModels = []CompletedModel{testCompletedModel(1), second}
		}), ErrStructuralViolation},
		{"completed model with an invalid request hash", mutate(readyAfterOne, func(s *CanonicalState) {
			s.CompletedModels[0].RequestHash = "sha256:NOTAHASH"
		}), ErrSchemaViolation},
		{"unknown phase", mutate(readyAfterOne, func(s *CanonicalState) { s.Phase = Phase("paused") }), ErrSchemaViolation},
		{"invalid binding", mutate(initial, func(s *CanonicalState) { s.Binding.OrgID = "org 1" }), ErrSchemaViolation},
		{"negative revision", mutate(initial, func(s *CanonicalState) { s.Revision = -1 }), ErrSchemaViolation},
	}
	for _, tc := range negative {
		t.Run("reject "+tc.name, func(t *testing.T) {
			err := tc.state.Validate()
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestReceiptStructuralRules(t *testing.T) {
	success := testReceipt()

	rejected := testReceipt()
	rejected.Outcome = OutcomeRejectedNotExec
	rejected.Content = nil
	rejected.ContentBytes = 0
	rejected.RejectionEvidence = Ref(testRef(14))
	rejected.Usage = Usage{Source: UsageProvider, InputTokens: Int64(0), OutputTokens: Int64(0), CachedInputTokens: Int64(0)}

	mutate := func(base ModelReceipt, fn func(*ModelReceipt)) ModelReceipt {
		copied := base
		fn(&copied)
		return copied
	}

	positive := []struct {
		name    string
		receipt ModelReceipt
	}{
		{"full success with provider usage", success},
		{"full success with gateway estimated usage", mutate(success, func(r *ModelReceipt) { r.Usage.Source = UsageGatewayEstimate })},
		{"full success with unavailable usage", mutate(success, func(r *ModelReceipt) { r.Usage = Usage{Source: UsageUnavailable} })},
		{"full success without a provider request id", mutate(success, func(r *ModelReceipt) { r.ProviderRequestID = nil })},
		{"provable not-executed rejection", rejected},
		{"rejection without a provider request id", mutate(rejected, func(r *ModelReceipt) { r.ProviderRequestID = nil })},
	}
	for _, tc := range positive {
		t.Run("accept "+tc.name, func(t *testing.T) {
			if err := tc.receipt.Validate(); err != nil {
				t.Fatalf("Validate rejected a legal receipt: %v", err)
			}
		})
	}

	negative := []struct {
		name    string
		receipt ModelReceipt
		want    error
	}{
		{"success without content", mutate(success, func(r *ModelReceipt) { r.Content = nil }), ErrStructuralViolation},
		{"success with zero content bytes", mutate(success, func(r *ModelReceipt) { r.ContentBytes = 0 }), ErrStructuralViolation},
		{"success carrying rejection evidence", mutate(success, func(r *ModelReceipt) { r.RejectionEvidence = Ref(testRef(14)) }), ErrStructuralViolation},
		{"unavailable usage with a zero token count", mutate(success, func(r *ModelReceipt) {
			r.Usage = Usage{Source: UsageUnavailable, OutputTokens: Int64(0)}
		}), ErrStructuralViolation},
		{"unavailable usage with all zero token counts", mutate(success, func(r *ModelReceipt) {
			r.Usage = Usage{Source: UsageUnavailable, InputTokens: Int64(0), OutputTokens: Int64(0), CachedInputTokens: Int64(0)}
		}), ErrStructuralViolation},
		{"provider usage with a missing token count", mutate(success, func(r *ModelReceipt) {
			r.Usage = Usage{Source: UsageProvider, InputTokens: Int64(1), OutputTokens: Int64(1)}
		}), ErrStructuralViolation},
		{"unknown usage source", mutate(success, func(r *ModelReceipt) { r.Usage.Source = UsageSource("estimate") }), ErrSchemaViolation},
		{"rejection without evidence", mutate(rejected, func(r *ModelReceipt) { r.RejectionEvidence = nil }), ErrStructuralViolation},
		{"rejection carrying content", mutate(rejected, func(r *ModelReceipt) { r.Content = Ref(testRef(12)) }), ErrStructuralViolation},
		{"rejection with content bytes", mutate(rejected, func(r *ModelReceipt) { r.ContentBytes = 32 }), ErrStructuralViolation},
		{"rejection with billed usage", mutate(rejected, func(r *ModelReceipt) { r.Usage.OutputTokens = Int64(1) }), ErrStructuralViolation},
		{"rejection with estimated usage", mutate(rejected, func(r *ModelReceipt) { r.Usage.Source = UsageGatewayEstimate }), ErrStructuralViolation},
		{"rejection with unavailable usage", mutate(rejected, func(r *ModelReceipt) { r.Usage = Usage{Source: UsageUnavailable} }), ErrStructuralViolation},
		{"unknown outcome", mutate(success, func(r *ModelReceipt) { r.Outcome = Outcome("unknown") }), ErrSchemaViolation},
		{"aborted outcome", mutate(success, func(r *ModelReceipt) { r.Outcome = Outcome("aborted") }), ErrSchemaViolation},
		{"empty provider request id", mutate(success, func(r *ModelReceipt) { r.ProviderRequestID = String("") }), ErrSchemaViolation},
		{"invalid request hash", mutate(success, func(r *ModelReceipt) { r.RequestHash = "sha256:xyz" }), ErrSchemaViolation},
		{"invalid writer gateway id", mutate(success, func(r *ModelReceipt) { r.WriterGatewayID = "gateway-1" }), ErrSchemaViolation},
		{"zero recorded timestamp", mutate(success, func(r *ModelReceipt) { r.RecordedAtUnixMs = 0 }), ErrSchemaViolation},
	}
	for _, tc := range negative {
		t.Run("reject "+tc.name, func(t *testing.T) {
			if err := tc.receipt.Validate(); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestModelRequestStructuralRules(t *testing.T) {
	first := testRequest()

	second := testRequest()
	second.LogicalKey = LogicalKey2
	second.PriorReceipts = []Reference{testRef(21)}

	third := testRequest()
	third.LogicalKey = LogicalKey3
	third.PriorReceipts = []Reference{testRef(21), testRef(22)}

	for _, doc := range []ModelRequest{first, second, third} {
		if err := doc.Validate(); err != nil {
			t.Fatalf("Validate rejected a legal request for %s: %v", doc.LogicalKey, err)
		}
	}

	mutate := func(base ModelRequest, fn func(*ModelRequest)) ModelRequest {
		copied := base
		copied.PriorReceipts = append([]Reference(nil), base.PriorReceipts...)
		fn(&copied)
		return copied
	}

	negative := []struct {
		name string
		doc  ModelRequest
		want error
	}{
		{"first call with a prior receipt", mutate(first, func(d *ModelRequest) { d.PriorReceipts = []Reference{testRef(21)} }), ErrStructuralViolation},
		{"second call without a prior receipt", mutate(second, func(d *ModelRequest) { d.PriorReceipts = nil }), ErrStructuralViolation},
		{"third call with a repeated prior receipt", mutate(third, func(d *ModelRequest) {
			d.PriorReceipts = []Reference{testRef(21), testRef(21)}
		}), ErrStructuralViolation},
		{"logical key beyond the ceiling", mutate(first, func(d *ModelRequest) { d.LogicalKey = LogicalKey("model:4") }), ErrSchemaViolation},
		{"configRevision outside the bigint range", mutate(first, func(d *ModelRequest) {
			d.Route.ConfigRevision = "9999999999999999999"
		}), ErrSchemaViolation},
	}
	for _, tc := range negative {
		t.Run("reject "+tc.name, func(t *testing.T) {
			if err := tc.doc.Validate(); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestValidateSuccession(t *testing.T) {
	base := testInitialState()
	baseRef := Reference{RefID: testUUID(13), Hash: mustHash(t, base)}

	next := testInitialState()
	next.Revision = 1
	next.Previous = &baseRef
	next.Phase = PhaseAwaitingModel
	next.Pending = testPending(t, LogicalKey1)

	if err := ValidateSuccession(base, baseRef, next); err != nil {
		t.Fatalf("ValidateSuccession rejected a legal successor: %v", err)
	}

	confirmed := testInitialState()
	confirmed.Revision = 1
	confirmed.Previous = &baseRef
	confirmed.CompletedModels = []CompletedModel{testCompletedModel(1)}
	if err := ValidateSuccession(base, baseRef, confirmed); err != nil {
		t.Fatalf("ValidateSuccession rejected a legal confirming successor: %v", err)
	}

	secondRef := Reference{RefID: testUUID(14), Hash: mustHash(t, confirmed)}
	finished := testInitialState()
	finished.Revision = 2
	finished.Previous = &secondRef
	finished.Phase = PhaseFinished
	finished.CompletedModels = []CompletedModel{testCompletedModel(1)}
	finished.Artifact = Ref(testRef(12))
	if err := ValidateSuccession(confirmed, secondRef, finished); err != nil {
		t.Fatalf("ValidateSuccession rejected a legal finishing successor: %v", err)
	}

	mutate := func(fn func(*CanonicalState)) CanonicalState {
		copied := next
		copied.CompletedModels = append([]CompletedModel(nil), next.CompletedModels...)
		fn(&copied)
		return copied
	}

	negative := []struct {
		name    string
		base    CanonicalState
		baseRef Reference
		next    CanonicalState
		want    error
	}{
		{"revision skips ahead", base, baseRef, mutate(func(s *CanonicalState) { s.Revision = 2 }), ErrStructuralViolation},
		{"revision repeats the head", base, baseRef, mutate(func(s *CanonicalState) { s.Revision = 0; s.Previous = nil; s.Phase = PhaseReady; s.Pending = nil }), ErrStructuralViolation},
		{"previous points at another object", base, baseRef, mutate(func(s *CanonicalState) {
			s.Previous = Ref(Reference{RefID: testUUID(77), Hash: baseRef.Hash})
		}), ErrStructuralViolation},
		{"previous carries a stale hash", base, baseRef, mutate(func(s *CanonicalState) {
			s.Previous = Ref(Reference{RefID: baseRef.RefID, Hash: testHash('b')})
		}), ErrStructuralViolation},
		{"binding changes", base, baseRef, mutate(func(s *CanonicalState) { s.Binding.SnapshotID = testUUID(50) }), ErrStructuralViolation},
		{"input reference changes", base, baseRef, mutate(func(s *CanonicalState) { s.Input = testRef(40) }), ErrStructuralViolation},
		{"template reference changes", base, baseRef, mutate(func(s *CanonicalState) { s.Template = nil }), ErrStructuralViolation},
		{"base reference hash does not match the head", base, Reference{RefID: baseRef.RefID, Hash: testHash('c')}, next, ErrHashMismatch},
		{"completed models shrink", confirmed, secondRef, func() CanonicalState {
			shrunk := testInitialState()
			shrunk.Revision = 2
			shrunk.Previous = &secondRef
			return shrunk
		}(), ErrStructuralViolation},
		{"confirmed receipt is rewritten", confirmed, secondRef, func() CanonicalState {
			rewritten := testInitialState()
			rewritten.Revision = 2
			rewritten.Previous = &secondRef
			model := testCompletedModel(1)
			model.RequestHash = testHash('d')
			rewritten.CompletedModels = []CompletedModel{model}
			return rewritten
		}(), ErrStructuralViolation},
		{"two model steps confirmed at once", base, baseRef, func() CanonicalState {
			jump := testInitialState()
			jump.Revision = 1
			jump.Previous = &baseRef
			jump.CompletedModels = []CompletedModel{testCompletedModel(1), testCompletedModel(2)}
			return jump
		}(), ErrStructuralViolation},
	}
	for _, tc := range negative {
		t.Run("reject "+tc.name, func(t *testing.T) {
			if err := ValidateSuccession(tc.base, tc.baseRef, tc.next); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestValidateIntentForRequest(t *testing.T) {
	request := testRequest()
	hash := mustHash(t, request)
	intent := ModelIntent{Request: Reference{RefID: testUUID(6), Hash: hash}, RequestHash: hash, LogicalKey: LogicalKey1}

	if err := ValidateIntentForRequest(intent, request); err != nil {
		t.Fatalf("ValidateIntentForRequest rejected a matching pair: %v", err)
	}

	negative := []struct {
		name   string
		intent ModelIntent
		doc    ModelRequest
		want   error
	}{
		{"request hash does not match the document", func() ModelIntent {
			copied := intent
			copied.RequestHash = testHash('b')
			return copied
		}(), request, ErrHashMismatch},
		{"stored reference hash does not match the document", func() ModelIntent {
			copied := intent
			copied.Request.Hash = testHash('b')
			return copied
		}(), request, ErrHashMismatch},
		{"logical key does not match the document", func() ModelIntent {
			copied := intent
			copied.LogicalKey = LogicalKey2
			return copied
		}(), request, ErrStructuralViolation},
		{"routing changed under a frozen intent", intent, func() ModelRequest {
			copied := request
			copied.Route.Model = "other"
			return copied
		}(), ErrHashMismatch},
	}
	for _, tc := range negative {
		t.Run("reject "+tc.name, func(t *testing.T) {
			if err := ValidateIntentForRequest(tc.intent, tc.doc); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestValidateRequestAgainstHead(t *testing.T) {
	head := testInitialState()
	head.Revision = 1
	head.Previous = Ref(testRef(13))
	head.CompletedModels = []CompletedModel{testCompletedModel(1)}

	request := testRequest()
	request.LogicalKey = LogicalKey2
	request.PriorReceipts = []Reference{testCompletedModel(1).Receipt}
	if err := ValidateRequestAgainstHead(request, head); err != nil {
		t.Fatalf("ValidateRequestAgainstHead rejected a matching pair: %v", err)
	}

	firstHead := testInitialState()
	firstRequest := testRequest()
	if err := ValidateRequestAgainstHead(firstRequest, firstHead); err != nil {
		t.Fatalf("ValidateRequestAgainstHead rejected the first model request: %v", err)
	}

	negative := []struct {
		name string
		doc  ModelRequest
		head CanonicalState
		want error
	}{
		{"logical key repeats a completed step", firstRequest, head, ErrStructuralViolation},
		{"prior receipts omit a confirmed receipt", func() ModelRequest {
			copied := request
			copied.PriorReceipts = []Reference{testRef(99)}
			return copied
		}(), head, ErrStructuralViolation},
		{"binding does not match the head", func() ModelRequest {
			copied := request
			copied.Binding.RunID = testUUID(60)
			return copied
		}(), head, ErrStructuralViolation},
		{"input does not match the approved head input", func() ModelRequest {
			copied := request
			copied.Input = testRef(41)
			return copied
		}(), head, ErrStructuralViolation},
		{"template does not match the approved head template", func() ModelRequest {
			copied := request
			copied.Template = nil
			return copied
		}(), head, ErrStructuralViolation},
	}
	for _, tc := range negative {
		t.Run("reject "+tc.name, func(t *testing.T) {
			if err := ValidateRequestAgainstHead(tc.doc, tc.head); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestValidateReceiptForIntent(t *testing.T) {
	intent := *testPending(t, LogicalKey1)
	receipt := testReceipt()
	receipt.RequestHash = intent.RequestHash
	if err := ValidateReceiptForIntent(intent, receipt); err != nil {
		t.Fatalf("ValidateReceiptForIntent rejected a matching pair: %v", err)
	}

	wrongHash := receipt
	wrongHash.RequestHash = testHash('b')
	if err := ValidateReceiptForIntent(intent, wrongHash); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("error = %v, want %v", err, ErrHashMismatch)
	}

	wrongKey := receipt
	wrongKey.LogicalKey = LogicalKey2
	if err := ValidateReceiptForIntent(intent, wrongKey); !errors.Is(err, ErrStructuralViolation) {
		t.Fatalf("error = %v, want %v", err, ErrStructuralViolation)
	}
}
