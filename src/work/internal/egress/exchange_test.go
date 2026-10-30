package egress_test

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/we-meet/work/internal/authz"
	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/egress"
	"github.com/we-meet/work/internal/receipt"
)

func TestExecuteNeverSendsWithoutWon(t *testing.T) {
	for _, state := range []string{"observed", "sealed_not_sent", "consumed", "receipt_recorded", ""} {
		state := state
		name := state
		if name == "" {
			name = "unspecified"
		}
		t.Run("gate_"+name, func(t *testing.T) {
			store := newMemoryStore()
			gate := newGate()
			gate.decision = egress.ConsumeDecision{Won: false, GateState: state}
			provider := newProvider(t, successHandler("answer"))
			exchange := newExchange(gate, provider.provider, store)

			result, err := exchange.Execute(context.Background(), newRequest(t))

			if !errors.Is(err, egress.ErrNotSent) {
				t.Fatalf("err = %v, want ErrNotSent", err)
			}
			if result.Outcome != egress.OutcomeNotSent || result.Sent {
				t.Fatalf("result = %+v, want not_sent and Sent=false", result)
			}
			if gate.consumeCount() != 1 {
				t.Fatalf("consume calls = %d, want 1", gate.consumeCount())
			}
			if provider.requests.Load() != 0 {
				t.Fatalf("provider requests = %d, want 0", provider.requests.Load())
			}
			if gate.attachCount() != 0 || store.putCount() != 0 {
				t.Fatalf("attached=%d stored=%d, want 0/0", gate.attachCount(), store.putCount())
			}
		})
	}
}

func TestExecuteSuccessStoresBodyThenReceiptThenAttaches(t *testing.T) {
	const answer = "the public answer"
	store := newMemoryStore()
	gate := newGate()
	provider := newProvider(t, successHandler(answer))
	exchange := newExchange(gate, provider.provider, store)
	request := newRequest(t)

	result, err := exchange.Execute(context.Background(), request)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if result.Outcome != egress.OutcomeSucceeded || !result.Sent || !result.Attached {
		t.Fatalf("result = %+v, want succeeded/sent/attached", result)
	}
	if result.RequestHash != request.ExpectedRequestHash {
		t.Fatalf("request hash = %s, want %s", result.RequestHash, request.ExpectedRequestHash)
	}
	if result.ReceiptSlotID != testSlot {
		t.Fatalf("slot = %s, want %s", result.ReceiptSlotID, testSlot)
	}
	if result.Content == nil || result.Content.RefID != testAnswerRef {
		t.Fatalf("content = %+v, want ref %s", result.Content, testAnswerRef)
	}
	if result.ContentBytes != int64(len(answer)) {
		t.Fatalf("content bytes = %d, want %d", result.ContentBytes, len(answer))
	}
	if result.Usage.Source != canonical.UsageProvider ||
		result.Usage.InputTokens == nil || *result.Usage.InputTokens != 120 ||
		result.Usage.OutputTokens == nil || *result.Usage.OutputTokens != 30 ||
		result.Usage.CachedInputTokens == nil || *result.Usage.CachedInputTokens != 10 {
		t.Fatalf("usage = %+v, want provider 120/30/10", result.Usage)
	}
	if result.ProviderRequestID == nil || *result.ProviderRequestID != testProviderID {
		t.Fatalf("provider request id = %v, want %s", result.ProviderRequestID, testProviderID)
	}
	if provider.requests.Load() != 1 {
		t.Fatalf("provider requests = %d, want exactly 1", provider.requests.Load())
	}
	if gate.consumeCount() != 1 || gate.attachCount() != 1 {
		t.Fatalf("consume=%d attach=%d, want 1/1", gate.consumeCount(), gate.attachCount())
	}

	// Answer object first, receipt object second: the receipt references an
	// object that already exists.
	if store.putCount() != 2 {
		t.Fatalf("store puts = %d, want 2", store.putCount())
	}
	answerObject := store.put(t, 0)
	receiptObject := store.put(t, 1)
	if !bytes.Equal(answerObject.body, []byte(answer)) {
		t.Fatalf("first stored object is not the answer: %q", answerObject.body)
	}
	if answerObject.contentRef == receiptObject.contentRef {
		t.Fatal("answer and receipt share a content object")
	}
	document, err := canonical.ParseModelReceipt(receiptObject.body)
	if err != nil {
		t.Fatalf("stored receipt: %v", err)
	}
	if document.Outcome != canonical.OutcomeSucceeded {
		t.Fatalf("outcome = %s, want succeeded", document.Outcome)
	}
	if document.Content == nil || *document.Content != *result.Content {
		t.Fatalf("receipt content = %+v, want %+v", document.Content, result.Content)
	}
	if document.ContentBytes != int64(len(answer)) {
		t.Fatalf("receipt content bytes = %d, want %d", document.ContentBytes, len(answer))
	}
	if document.Binding != request.Binding || document.RequestHash != request.ExpectedRequestHash {
		t.Fatalf("receipt binding/hash not bound to the request: %+v", document)
	}
	if document.WriterGatewayID != testGateway {
		t.Fatalf("writer = %s, want %s", document.WriterGatewayID, testGateway)
	}
	documentHash, err := document.Hash()
	if err != nil {
		t.Fatal(err)
	}

	attach := gate.attachCall(t, 0)
	if attach.ReceiptSlotID != testSlot {
		t.Fatalf("attach slot = %s, want %s", attach.ReceiptSlotID, testSlot)
	}
	if attach.ReceiptHash != documentHash {
		t.Fatalf("attach hash = %s, want canonical %s", attach.ReceiptHash, documentHash)
	}
	if result.Receipt == nil || result.Receipt.Reference.Hash != documentHash ||
		result.Receipt.Reference.RefID != testSlot || result.Receipt.ContentRef != attach.ReceiptRef {
		t.Fatalf("result receipt = %+v, want slot %s hash %s ref %s", result.Receipt, testSlot, documentHash, attach.ReceiptRef)
	}
	if attach.ReceiptRef != receiptObject.contentRef {
		t.Fatalf("attach ref = %s, want stored receipt %s", attach.ReceiptRef, receiptObject.contentRef)
	}
	if attach.ReceiptResult != authz.ReceiptSucceeded {
		t.Fatalf("attach result = %s, want %s", attach.ReceiptResult, authz.ReceiptSucceeded)
	}
	if attach.OperationID != testOperation || attach.AttemptID != testAttempt ||
		attach.ExecutionID != testExecution || attach.OrgID != testOrg {
		t.Fatalf("attach tuple = %+v", attach)
	}
}

func TestExecuteProviderFailureIsUnknown(t *testing.T) {
	truncated := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "500")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"x","choices":[`))
	}
	timeout := func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}

	cases := []struct {
		name      string
		handler   httpHandler
		ctx       func() (context.Context, context.CancelFunc)
		wantCause string
	}{
		{name: "429", handler: statusHandler(429, `{"error":{"message":"slow down"}}`), wantCause: "retryable_status"},
		{name: "500", handler: statusHandler(500, `{"error":{"message":"boom"}}`), wantCause: "server_error"},
		{name: "503", handler: statusHandler(503, `{"error":{"message":"unavailable"}}`), wantCause: "server_error"},
		{name: "401", handler: statusHandler(401, `{"error":{"message":"revoked"}}`), wantCause: "auth_blocked"},
		{name: "403", handler: statusHandler(403, `{"error":{"message":"forbidden"}}`), wantCause: "auth_blocked"},
		{name: "400_with_usage", handler: statusHandler(400, `{"error":{"message":"x"},"usage":{"prompt_tokens":5,"completion_tokens":1}}`), wantCause: "status_with_usage"},
		{name: "truncated", handler: truncated, wantCause: "truncated_response"},
		{
			name:    "timeout",
			handler: timeout,
			ctx: func() (context.Context, context.CancelFunc) {
				return context.WithTimeout(context.Background(), 30*time.Millisecond)
			},
			wantCause: "deadline_exceeded",
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			store := newMemoryStore()
			gate := newGate()
			provider := newProvider(t, testCase.handler)
			exchange := newExchange(gate, provider.provider, store)

			ctx := context.Background()
			if testCase.ctx != nil {
				var cancel context.CancelFunc
				ctx, cancel = testCase.ctx()
				defer cancel()
			}
			result, err := exchange.Execute(ctx, newRequest(t))

			if !errors.Is(err, egress.ErrUnknownOutcome) {
				t.Fatalf("err = %v, want ErrUnknownOutcome", err)
			}
			var unknown *egress.UnknownError
			if !errors.As(err, &unknown) || unknown.Reason != testCase.wantCause {
				t.Fatalf("reason = %v, want %s", err, testCase.wantCause)
			}
			if result.Outcome != egress.OutcomeUnknown || !result.Sent {
				t.Fatalf("result = %+v, want unknown and sent", result)
			}
			if provider.requests.Load() != 1 {
				t.Fatalf("provider requests = %d, want exactly 1", provider.requests.Load())
			}
			if gate.attachCount() != 0 {
				t.Fatalf("attach calls = %d, want 0", gate.attachCount())
			}
			if store.putCount() != 0 {
				t.Fatalf("stored objects = %d, want 0", store.putCount())
			}
			if result.Receipt != nil || result.Content != nil {
				t.Fatalf("result carries receipt/content on unknown: %+v", result)
			}
		})
	}
}

func TestExecuteProviderRejectionAttachesZeroUsageReceipt(t *testing.T) {
	const evidenceBody = `{"error":{"message":"model not allowed","type":"invalid_request_error"}}`
	store := newMemoryStore()
	gate := newGate()
	provider := newProvider(t, statusHandler(400, evidenceBody))
	exchange := newExchange(gate, provider.provider, store)

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if !errors.Is(err, egress.ErrRejectedNotExecuted) {
		t.Fatalf("err = %v, want ErrRejectedNotExecuted", err)
	}
	if result.Outcome != egress.OutcomeRejectedNotExecuted || !result.Sent || !result.Attached {
		t.Fatalf("result = %+v, want rejected/sent/attached", result)
	}
	if result.Content != nil || result.ContentBytes != 0 {
		t.Fatalf("rejection carries content: %+v", result)
	}
	if result.Usage.Source != canonical.UsageProvider || !result.Usage.IsZeroBilled() {
		t.Fatalf("usage = %+v, want provider 0/0/0", result.Usage)
	}
	if provider.requests.Load() != 1 || gate.attachCount() != 1 {
		t.Fatalf("provider=%d attach=%d, want 1/1", provider.requests.Load(), gate.attachCount())
	}
	if store.putCount() != 2 {
		t.Fatalf("store puts = %d, want evidence + receipt", store.putCount())
	}
	evidenceObject := store.put(t, 0)
	if !bytes.Equal(evidenceObject.body, []byte(evidenceBody)) {
		t.Fatalf("first stored object is not the rejection evidence: %q", evidenceObject.body)
	}
	document, err := canonical.ParseModelReceipt(store.put(t, 1).body)
	if err != nil {
		t.Fatalf("stored receipt: %v", err)
	}
	if document.Outcome != canonical.OutcomeRejectedNotExec {
		t.Fatalf("outcome = %s", document.Outcome)
	}
	if document.Content != nil || document.ContentBytes != 0 {
		t.Fatalf("rejection receipt carries content: %+v", document)
	}
	if document.Usage.Source != canonical.UsageProvider || !document.Usage.IsZeroBilled() {
		t.Fatalf("rejection usage = %+v, want provider zeros", document.Usage)
	}
	if document.RejectionEvidence == nil || document.RejectionEvidence.RefID != testEvidence {
		t.Fatalf("evidence = %+v, want ref %s", document.RejectionEvidence, testEvidence)
	}
	evidenceHash, err := canonical.BodyHash([]byte(evidenceBody))
	if err != nil {
		t.Fatal(err)
	}
	if document.RejectionEvidence.Hash != evidenceHash {
		t.Fatalf("evidence hash = %s, want %s", document.RejectionEvidence.Hash, evidenceHash)
	}
	if document.ProviderRequestID != nil {
		t.Fatalf("rejection provider id = %v, want null", document.ProviderRequestID)
	}
	attach := gate.attachCall(t, 0)
	if attach.ReceiptResult != authz.ReceiptRejectedNotExecuted {
		t.Fatalf("attach result = %s", attach.ReceiptResult)
	}
	documentHash, err := document.Hash()
	if err != nil {
		t.Fatal(err)
	}
	if attach.ReceiptHash != documentHash || attach.ReceiptRef != store.objectRef(1) {
		t.Fatalf("attach = %+v (hash %s, stored %s)", attach, documentHash, store.objectRef(1))
	}
}

func TestExecuteRejectionWithoutEvidenceSlotStaysUnknown(t *testing.T) {
	store := newMemoryStore()
	gate := newGate()
	provider := newProvider(t, statusHandler(400, `{"error":{"message":"bad"}}`))
	exchange := newExchange(gate, provider.provider, store)
	request := newRequest(t)
	request.RejectionEvidenceRefID = ""

	result, err := exchange.Execute(context.Background(), request)
	if !errors.Is(err, egress.ErrUnknownOutcome) {
		t.Fatalf("err = %v, want ErrUnknownOutcome", err)
	}
	if result.Outcome != egress.OutcomeUnknown || result.Receipt != nil {
		t.Fatalf("result = %+v, want unknown without receipt", result)
	}
	if gate.attachCount() != 0 || store.putCount() != 0 {
		t.Fatalf("attach=%d stored=%d, want 0/0", gate.attachCount(), store.putCount())
	}
}

func TestExecuteAttachFailureKeepsConfirmedSuccess(t *testing.T) {
	const attachText = "rpc connection reset while sending prompt-like text"
	store := newMemoryStore()
	gate := newGate()
	gate.attachErr = errors.New(attachText)
	provider := newProvider(t, successHandler("answer"))
	exchange := newExchange(gate, provider.provider, store)

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if !errors.Is(err, egress.ErrReceiptAttachFailed) {
		t.Fatalf("err = %v, want ErrReceiptAttachFailed", err)
	}
	var attachErr *egress.AttachError
	if !errors.As(err, &attachErr) {
		t.Fatalf("err type = %T, want *AttachError", err)
	}
	if result.Outcome != egress.OutcomeSucceeded || !result.Sent || result.Attached {
		t.Fatalf("result = %+v, want succeeded and attach pending", result)
	}
	if result.Receipt == nil {
		t.Fatal("result lost the receipt coordinates")
	}
	if attachErr.Receipt != result.Receipt.Reference || attachErr.ContentRef != result.Receipt.ContentRef {
		t.Fatalf("error coordinates = %+v, want %+v", attachErr, result.Receipt)
	}
	if attachErr.Receipt.RefID != testSlot || !canonical.ValidHash(attachErr.Receipt.Hash) {
		t.Fatalf("error receipt = %+v", attachErr.Receipt)
	}
	// The attach can be retried as-is; the provider must not be involved.
	if attachErr.Request.ReceiptHash != attachErr.Receipt.Hash ||
		attachErr.Request.ReceiptSlotID != attachErr.Receipt.RefID ||
		attachErr.Request.ReceiptRef != attachErr.ContentRef ||
		attachErr.Request.ReceiptResult != authz.ReceiptSucceeded {
		t.Fatalf("retry payload = %+v, want the stored receipt", attachErr.Request)
	}
	gate.mu.Lock()
	gate.attachErr = nil
	gate.mu.Unlock()
	if err := gate.Attach(context.Background(), attachErr.Request); err != nil {
		t.Fatalf("retried attach: %v", err)
	}
	if gate.attachCount() != 2 {
		t.Fatalf("attach calls after retry = %d, want 2", gate.attachCount())
	}
	if provider.requests.Load() != 1 {
		t.Fatalf("provider requests = %d, want exactly 1", provider.requests.Load())
	}
	if store.putCount() != 2 {
		t.Fatalf("store puts = %d, want answer + receipt", store.putCount())
	}
	if strings.Contains(err.Error(), attachText) {
		t.Fatalf("error leaked the gate error text: %v", err)
	}
}

func TestExecuteRequestHashMismatchNeverConsumes(t *testing.T) {
	validWrong := "sha256:" + strings.Repeat("0", 64)
	cases := []struct {
		name   string
		mutate func(*egress.ExchangeRequest)
	}{
		{name: "expected_digest_differs", mutate: func(r *egress.ExchangeRequest) { r.ExpectedRequestHash = validWrong }},
		{name: "expected_not_a_digest", mutate: func(r *egress.ExchangeRequest) { r.ExpectedRequestHash = "task text disguised as a hash" }},
		{name: "delivery_hash_differs", mutate: func(r *egress.ExchangeRequest) { r.Delivery.RequestHash = validWrong }},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			store := newMemoryStore()
			gate := newGate()
			provider := newProvider(t, successHandler("answer"))
			exchange := newExchange(gate, provider.provider, store)
			request := newRequest(t)
			testCase.mutate(&request)

			result, err := exchange.Execute(context.Background(), request)
			if !errors.Is(err, egress.ErrRequestHashMismatch) {
				t.Fatalf("err = %v, want ErrRequestHashMismatch", err)
			}
			if result.Outcome != egress.OutcomeNotSent || result.Sent {
				t.Fatalf("result = %+v, want not_sent", result)
			}
			if gate.consumeCount() != 0 || provider.requests.Load() != 0 || gate.attachCount() != 0 {
				t.Fatalf("consume=%d provider=%d attach=%d, want 0/0/0",
					gate.consumeCount(), provider.requests.Load(), gate.attachCount())
			}
			if store.putCount() != 0 {
				t.Fatalf("store puts = %d, want 0", store.putCount())
			}
			if strings.Contains(err.Error(), "task text disguised") {
				t.Fatalf("error echoed caller text: %v", err)
			}
		})
	}
}

func TestExecuteConsumeErrorSendsNothing(t *testing.T) {
	const gateText = "connection reset while reading task text"
	store := newMemoryStore()
	gate := newGate()
	gate.consumeErr = errors.New(gateText)
	provider := newProvider(t, successHandler("answer"))
	exchange := newExchange(gate, provider.provider, store)

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if !errors.Is(err, egress.ErrGateError) {
		t.Fatalf("err = %v, want ErrGateError", err)
	}
	if result.Outcome != egress.OutcomeNotSent || provider.requests.Load() != 0 || store.putCount() != 0 {
		t.Fatalf("result=%+v provider=%d stored=%d", result, provider.requests.Load(), store.putCount())
	}
	if strings.Contains(err.Error(), gateText) {
		t.Fatalf("error leaked gate text: %v", err)
	}
}

func TestExecuteConsumeErrorKeepsAuthzCode(t *testing.T) {
	store := newMemoryStore()
	gate := newGate()
	gate.consumeErr = authz.Fail("run_not_active")
	provider := newProvider(t, successHandler("answer"))
	exchange := newExchange(gate, provider.provider, store)

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if !errors.Is(err, egress.ErrGateError) {
		t.Fatalf("err = %v, want ErrGateError", err)
	}
	var gateErr *egress.GateError
	if !errors.As(err, &gateErr) || gateErr.Code != "run_not_active" {
		t.Fatalf("gate error = %v, want code run_not_active", err)
	}
	if result.Outcome != egress.OutcomeNotSent || provider.requests.Load() != 0 {
		t.Fatalf("result=%+v provider=%d", result, provider.requests.Load())
	}
}

func TestExecuteWonWithoutReceiptSlotDoesNotSend(t *testing.T) {
	store := newMemoryStore()
	gate := newGate()
	gate.decision = egress.ConsumeDecision{Won: true, GateState: "consumed", ReceiptSlotID: ""}
	provider := newProvider(t, successHandler("answer"))
	exchange := newExchange(gate, provider.provider, store)

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if !errors.Is(err, egress.ErrGateProtocol) {
		t.Fatalf("err = %v, want ErrGateProtocol", err)
	}
	if provider.requests.Load() != 0 || gate.attachCount() != 0 || store.putCount() != 0 {
		t.Fatalf("provider=%d attach=%d stored=%d, want 0/0/0",
			provider.requests.Load(), gate.attachCount(), store.putCount())
	}
	if result.Outcome != egress.OutcomeUnknown || result.Sent {
		t.Fatalf("result = %+v, want unknown and not sent", result)
	}
}

func TestExecuteConcurrentCallsSendOnce(t *testing.T) {
	var first sync.Once
	store := newMemoryStore()
	gate := newGate()
	gate.decide = func(egress.DeliveryRequest) egress.ConsumeDecision {
		decision := egress.ConsumeDecision{Won: false, GateState: "observed"}
		first.Do(func() {
			decision = egress.ConsumeDecision{Won: true, GateState: "consumed", ReceiptSlotID: testSlot}
		})
		return decision
	}
	provider := newProvider(t, successHandler("answer"))
	exchange := newExchange(gate, provider.provider, store)
	request := newRequest(t)

	start := make(chan struct{})
	results := make([]egress.ExchangeResult, 2)
	errs := make([]error, 2)
	var wait sync.WaitGroup
	for index := 0; index < 2; index++ {
		index := index
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			results[index], errs[index] = exchange.Execute(context.Background(), request)
		}()
	}
	close(start)
	wait.Wait()

	succeeded, notSent := 0, 0
	for index := range results {
		switch {
		case errs[index] == nil && results[index].Outcome == egress.OutcomeSucceeded:
			succeeded++
		case errors.Is(errs[index], egress.ErrNotSent) && results[index].Outcome == egress.OutcomeNotSent:
			notSent++
		default:
			t.Fatalf("call %d: result=%+v err=%v", index, results[index], errs[index])
		}
	}
	if succeeded != 1 || notSent != 1 {
		t.Fatalf("succeeded=%d not_sent=%d, want 1/1", succeeded, notSent)
	}
	if provider.requests.Load() != 1 {
		t.Fatalf("provider requests = %d, want exactly 1", provider.requests.Load())
	}
	if gate.consumeCount() != 2 || gate.attachCount() != 1 {
		t.Fatalf("consume=%d attach=%d, want 2/1", gate.consumeCount(), gate.attachCount())
	}
}

func TestReceiptRoundTripThroughVerify(t *testing.T) {
	const answer = "round-trip answer"
	store := newMemoryStore()
	gate := newGate()
	provider := newProvider(t, successHandler(answer))
	exchange := newExchange(gate, provider.provider, store)
	request := newRequest(t)

	result, err := exchange.Execute(context.Background(), request)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	attach := gate.attachCall(t, 0)
	body, err := store.Get(context.Background(), testOrg, attach.ReceiptRef)
	if err != nil {
		t.Fatalf("read receipt: %v", err)
	}
	verified, err := receipt.Verify(body, receipt.Expectation{
		OrgID: testOrg, TaskID: testTask, RunID: testRun,
		OperationID: testOperation, AttemptID: testAttempt, ExecutionID: testExecution,
		RequestHash: request.ExpectedRequestHash, ReceiptHash: attach.ReceiptHash,
	})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if verified.Outcome != canonical.OutcomeSucceeded {
		t.Fatalf("verified outcome = %s", verified.Outcome)
	}
	if verified.Content == nil || result.Content == nil || *verified.Content != *result.Content {
		t.Fatalf("verified content = %+v, want %+v", verified.Content, result.Content)
	}
	if verified.SettlementTokens == nil || *verified.SettlementTokens != 160 {
		t.Fatalf("settlement tokens = %v, want 160", verified.SettlementTokens)
	}
	if verified.Receipt.WriterGatewayID != testGateway {
		t.Fatalf("writer = %s", verified.Receipt.WriterGatewayID)
	}
}

func TestExecuteRecordsUnavailableUsageAsNull(t *testing.T) {
	store := newMemoryStore()
	gate := newGate()
	provider := newProvider(t, successWithoutUsageHandler("answer"))
	exchange := newExchange(gate, provider.provider, store)

	result, err := exchange.Execute(context.Background(), newRequest(t))
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if result.Usage.Source != canonical.UsageUnavailable {
		t.Fatalf("usage source = %s, want unavailable", result.Usage.Source)
	}
	if result.Usage.InputTokens != nil || result.Usage.OutputTokens != nil || result.Usage.CachedInputTokens != nil {
		t.Fatalf("usage counts = %+v, want all null", result.Usage)
	}
	document, err := canonical.ParseModelReceipt(store.put(t, 1).body)
	if err != nil {
		t.Fatalf("stored receipt: %v", err)
	}
	if document.Usage.Source != canonical.UsageUnavailable ||
		document.Usage.InputTokens != nil || document.Usage.OutputTokens != nil ||
		document.Usage.CachedInputTokens != nil {
		t.Fatalf("receipt usage = %+v, want unavailable with null counts", document.Usage)
	}
}

func TestExecuteContentFailureAfterSuccessKeepsSuccess(t *testing.T) {
	cases := []struct {
		name      string
		failIndex int
		wantErr   error
	}{
		{name: "answer_not_persisted", failIndex: 0, wantErr: egress.ErrContentStore},
		{name: "receipt_not_persisted", failIndex: 1, wantErr: egress.ErrReceiptNotPersisted},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			store := newMemoryStore()
			store.failPut = func(index int, _ []byte) error {
				if index == testCase.failIndex {
					return errors.New("content disk full")
				}
				return nil
			}
			gate := newGate()
			provider := newProvider(t, successHandler("answer"))
			exchange := newExchange(gate, provider.provider, store)

			result, err := exchange.Execute(context.Background(), newRequest(t))
			if !errors.Is(err, testCase.wantErr) {
				t.Fatalf("err = %v, want %v", err, testCase.wantErr)
			}
			if result.Outcome != egress.OutcomeSucceeded || !result.Sent {
				t.Fatalf("result = %+v, want succeeded after a confirmed provider call", result)
			}
			if provider.requests.Load() != 1 {
				t.Fatalf("provider requests = %d, want exactly 1", provider.requests.Load())
			}
			if gate.attachCount() != 0 || result.Attached {
				t.Fatalf("attach=%d attached=%v, want no attach", gate.attachCount(), result.Attached)
			}
		})
	}
}

func TestCanonicalRequestDocumentExcludesRuntimeSecrets(t *testing.T) {
	const prompt = "sensitive prompt text"
	store := newMemoryStore()
	gate := newGate()
	provider := newProvider(t, successHandler("answer"))
	exchange := newExchange(gate, provider.provider, store)
	request := newRequest(t)
	request.Messages = egress.MessageInput{SystemTemplate: []byte(prompt), Input: []byte(prompt)}

	result, err := exchange.Execute(context.Background(), request)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	document := requestDocument(request)
	body, err := document.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{prompt, testAPIKey, "v1/chat/completions"} {
		if bytes.Contains(body, []byte(secret)) {
			t.Fatalf("canonical request document contains %q", secret)
		}
	}
	hash, err := document.Hash()
	if err != nil {
		t.Fatal(err)
	}
	if result.RequestHash != hash || request.ExpectedRequestHash != hash {
		t.Fatalf("request hash = %s, want %s", result.RequestHash, hash)
	}
	// The provider payload does carry the prompt and the credential, which is
	// exactly what must not leak into the document, errors or logs.
	payload, _ := provider.lastBody.Load().([]byte)
	if !bytes.Contains(payload, []byte(prompt)) {
		t.Fatal("provider payload did not carry the input")
	}
	if auth, _ := provider.lastAuth.Load().(string); auth != "Bearer "+testAPIKey {
		t.Fatalf("authorization = %q", auth)
	}
}
