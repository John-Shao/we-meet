package receipt_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/receipt"
)

const (
	testOrg       = "org_receipt"
	testTask      = "11111111-1111-4111-8111-111111111111"
	testRun       = "22222222-2222-4222-8222-222222222222"
	testSnapshot  = "33333333-3333-4333-8333-333333333333"
	testOperation = "44444444-4444-4444-8444-444444444444"
	testAttempt   = "55555555-5555-4555-8555-555555555555"
	testExecution = "66666666-6666-4666-8666-666666666666"
	testGateway   = "77777777-7777-4777-8777-777777777777"
	testReceiptID = "88888888-8888-4888-8888-888888888888"
	testContent   = "99999999-9999-4999-8999-999999999999"
	testIntent    = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testBody      = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func baseReceipt() canonical.ModelReceipt {
	input, output, cached := int64(120), int64(30), int64(10)
	return canonical.ModelReceipt{
		ReceiptID: testReceiptID,
		Binding: canonical.Binding{
			OrgID: testOrg, TaskID: testTask, RunID: testRun,
			SnapshotID: testSnapshot, RuntimeVersion: "work-runtime-1.4.0",
		},
		LogicalKey:        canonical.LogicalKey1,
		OperationID:       testOperation,
		DispatchAttemptID: testAttempt,
		ExecutionID:       testExecution,
		RequestHash:       testIntent,
		WriterGatewayID:   testGateway,
		RecordedAtUnixMs:  1_700_000_000_000,
		Outcome:           canonical.OutcomeSucceeded,
		Content:           &canonical.Reference{RefID: testContent, Hash: testBody},
		ContentBytes:      12,
		Usage: canonical.Usage{
			Source:            canonical.UsageProvider,
			InputTokens:       &input,
			OutputTokens:      &output,
			CachedInputTokens: &cached,
		},
	}
}

func encode(t *testing.T, document canonical.ModelReceipt) ([]byte, string) {
	t.Helper()
	body, err := document.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	hash, err := document.Hash()
	if err != nil {
		t.Fatal(err)
	}
	return body, hash
}

func expectation(hash string) receipt.Expectation {
	return receipt.Expectation{
		OrgID: testOrg, TaskID: testTask, RunID: testRun,
		OperationID: testOperation, AttemptID: testAttempt,
		ExecutionID: testExecution, RequestHash: testIntent, ReceiptHash: hash,
	}
}

func TestVerifyAcceptsBoundSuccess(t *testing.T) {
	body, hash := encode(t, baseReceipt())
	verified, err := receipt.Verify(body, expectation(hash))
	if err != nil {
		t.Fatal(err)
	}
	if verified.Outcome != canonical.OutcomeSucceeded || verified.UsageSource != canonical.UsageProvider {
		t.Fatalf("verified = %#v", verified)
	}
	if verified.SettlementTokens == nil || *verified.SettlementTokens != 160 {
		t.Fatalf("settlement tokens = %v", verified.SettlementTokens)
	}
	if verified.Content == nil || verified.Content.Hash != testBody {
		t.Fatalf("content = %#v", verified.Content)
	}
}

func TestVerifyRejectsTamperedBody(t *testing.T) {
	body, hash := encode(t, baseReceipt())
	tampered := strings.Replace(string(body), `"contentBytes":12`, `"contentBytes":13`, 1)
	if tampered == string(body) {
		t.Fatal("test did not modify the body")
	}
	_, err := receipt.Verify([]byte(tampered), expectation(hash))
	if !errors.Is(err, receipt.ErrHashMismatch) {
		t.Fatalf("error = %v, want ErrHashMismatch", err)
	}
}

func TestVerifyRejectsBindingDrift(t *testing.T) {
	body, hash := encode(t, baseReceipt())
	for name, mutate := range map[string]func(*receipt.Expectation){
		"org":         func(e *receipt.Expectation) { e.OrgID = "org_other" },
		"task":        func(e *receipt.Expectation) { e.TaskID = "12111111-1111-4111-8111-111111111111" },
		"run":         func(e *receipt.Expectation) { e.RunID = "22222222-2222-4222-8222-222222222223" },
		"operation":   func(e *receipt.Expectation) { e.OperationID = "44444444-4444-4444-8444-444444444445" },
		"attempt":     func(e *receipt.Expectation) { e.AttemptID = "55555555-5555-4555-8555-555555555556" },
		"execution":   func(e *receipt.Expectation) { e.ExecutionID = "66666666-6666-4666-8666-666666666667" },
		"requestHash": func(e *receipt.Expectation) { e.RequestHash = testBody },
	} {
		t.Run(name, func(t *testing.T) {
			expected := expectation(hash)
			mutate(&expected)
			_, err := receipt.Verify(body, expected)
			if !errors.Is(err, receipt.ErrBindingMismatch) {
				t.Fatalf("error = %v, want ErrBindingMismatch", err)
			}
		})
	}
}

func TestVerifyRequiresExpectedHash(t *testing.T) {
	body, _ := encode(t, baseReceipt())
	for name, hash := range map[string]string{
		"empty":  "",
		"legacy": "md5:abc",
		"short":  "sha256:abc",
	} {
		t.Run(name, func(t *testing.T) {
			expected := expectation(hash)
			_, err := receipt.Verify(body, expected)
			if !errors.Is(err, receipt.ErrHashMismatch) {
				t.Fatalf("error = %v, want ErrHashMismatch", err)
			}
		})
	}
}

func TestVerifyUnavailableUsageKeepsReservation(t *testing.T) {
	document := baseReceipt()
	document.Usage = canonical.Usage{Source: canonical.UsageUnavailable}
	body, hash := encode(t, document)
	verified, err := receipt.Verify(body, expectation(hash))
	if err != nil {
		t.Fatal(err)
	}
	if verified.SettlementTokens != nil {
		t.Fatalf("unavailable usage produced settlement %v", *verified.SettlementTokens)
	}
	if verified.UsageSource != canonical.UsageUnavailable {
		t.Fatalf("source = %q", verified.UsageSource)
	}
}

func TestVerifyGatewayEstimateIsSettleableButDistinguishable(t *testing.T) {
	document := baseReceipt()
	input, output, cached := int64(5), int64(6), int64(7)
	document.Usage = canonical.Usage{
		Source: canonical.UsageGatewayEstimate, InputTokens: &input,
		OutputTokens: &output, CachedInputTokens: &cached,
	}
	body, hash := encode(t, document)
	verified, err := receipt.Verify(body, expectation(hash))
	if err != nil {
		t.Fatal(err)
	}
	if verified.UsageSource != canonical.UsageGatewayEstimate {
		t.Fatalf("source = %q", verified.UsageSource)
	}
	if verified.SettlementTokens == nil || *verified.SettlementTokens != 18 {
		t.Fatalf("settlement = %v", verified.SettlementTokens)
	}
}

func TestVerifyRejectedReceiptHasNoSettlement(t *testing.T) {
	document := baseReceipt()
	zero := int64(0)
	document.Outcome = canonical.OutcomeRejectedNotExec
	document.Content = nil
	document.ContentBytes = 0
	document.RejectionEvidence = &canonical.Reference{RefID: testContent, Hash: testBody}
	document.Usage = canonical.Usage{
		Source: canonical.UsageProvider, InputTokens: &zero, OutputTokens: &zero, CachedInputTokens: &zero,
	}
	body, hash := encode(t, document)
	verified, err := receipt.Verify(body, expectation(hash))
	if err != nil {
		t.Fatal(err)
	}
	if verified.Outcome != canonical.OutcomeRejectedNotExec || verified.SettlementTokens != nil {
		t.Fatalf("verified = %#v", verified)
	}
}

func TestVerifyRejectsNonTerminalAndMalformedDocuments(t *testing.T) {
	for name, mutate := range map[string]func(*canonical.ModelReceipt){
		"success without content": func(d *canonical.ModelReceipt) { d.Content = nil },
		"unknown outcome":         func(d *canonical.ModelReceipt) { d.Outcome = canonical.Outcome("unknown") },
		"unavailable with zero": func(d *canonical.ModelReceipt) {
			zero := int64(0)
			d.Usage = canonical.Usage{Source: canonical.UsageUnavailable, InputTokens: &zero}
		},
		"rejection with content": func(d *canonical.ModelReceipt) {
			d.Outcome = canonical.OutcomeRejectedNotExec
			d.RejectionEvidence = &canonical.Reference{RefID: testContent, Hash: testBody}
		},
		"empty provider request id":  func(d *canonical.ModelReceipt) { empty := ""; d.ProviderRequestID = &empty },
		"receipt id is not a uuid":   func(d *canonical.ModelReceipt) { d.ReceiptID = "not-a-uuid" },
		"request hash is not sha256": func(d *canonical.ModelReceipt) { d.RequestHash = "sha256:xyz" },
	} {
		t.Run(name, func(t *testing.T) {
			document := baseReceipt()
			mutate(&document)
			body, hash := encode(t, document)
			if _, err := receipt.Verify(body, expectation(hash)); err == nil {
				t.Fatal("malformed receipt was accepted")
			} else if errors.Is(err, receipt.ErrHashMismatch) || errors.Is(err, receipt.ErrBindingMismatch) {
				t.Fatalf("wrong error class: %v", err)
			}
		})
	}
}

func TestVerifyRejectsDuplicateKeysAndTrailingData(t *testing.T) {
	body, hash := encode(t, baseReceipt())
	duplicated := strings.Replace(string(body), `"outcome":"succeeded"`,
		`"outcome":"succeeded","outcome":"rejected_not_executed"`, 1)
	if _, err := receipt.Verify([]byte(duplicated), expectation(hash)); err == nil {
		t.Fatal("duplicate keys were accepted")
	}
	if _, err := receipt.Verify(append(append([]byte{}, body...), []byte(`{}`)...), expectation(hash)); err == nil {
		t.Fatal("trailing data was accepted")
	}
}
