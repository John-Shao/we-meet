// Package receipt verifies a trusted model receipt against the dispatch gate
// binding it claims to belong to.
//
// The body is written by the egress gateway into a preallocated receipt slot.
// A valid document only proves the writer produced well-formed JSON; the caller
// must still match every binding field against the database gate and check the
// stored object hash. This package does exactly that and nothing else: it never
// decides that an outcome may be published.
package receipt

import (
	"errors"
	"fmt"

	"github.com/we-meet/work/internal/canonical"
)

var (
	ErrHashMismatch    = errors.New("receipt hash mismatch")
	ErrBindingMismatch = errors.New("receipt binding mismatch")
)

// Expectation is the authoritative gate tuple read from the database. Fields
// left empty are not compared; the caller must supply everything it knows.
type Expectation struct {
	OrgID       string
	TaskID      string
	RunID       string
	OperationID string
	AttemptID   string
	ExecutionID string
	RequestHash string
	ReceiptHash string
}

// Verified is the subset of a receipt the finishing path may act on.
type Verified struct {
	Receipt     canonical.ModelReceipt
	Outcome     canonical.Outcome
	Content     *canonical.Reference
	UsageSource canonical.UsageSource
	// SettlementTokens is nil when the caller must not settle: usage is
	// unavailable, or a rejection reports no usage.
	SettlementTokens *int64
}

// Verify parses, hashes and binds a receipt body. It performs no I/O.
func Verify(body []byte, expectation Expectation) (Verified, error) {
	document, err := canonical.ParseModelReceipt(body)
	if err != nil {
		return Verified{}, err
	}
	if expectation.ReceiptHash == "" || !canonical.ValidHash(expectation.ReceiptHash) {
		return Verified{}, fmt.Errorf("%w: expected hash is not a digest", ErrHashMismatch)
	}
	actual, err := document.Hash()
	if err != nil {
		return Verified{}, err
	}
	if actual != expectation.ReceiptHash {
		return Verified{}, fmt.Errorf("%w: computed %s", ErrHashMismatch, actual)
	}
	if err := bind(document, expectation); err != nil {
		return Verified{}, err
	}
	verified := Verified{
		Receipt:     document,
		Outcome:     document.Outcome,
		Content:     document.Content,
		UsageSource: document.Usage.Source,
	}
	if document.Outcome == canonical.OutcomeSucceeded {
		input, output, cached := document.Usage.InputTokens,
			document.Usage.OutputTokens, document.Usage.CachedInputTokens
		if input != nil && output != nil && cached != nil {
			total := *input + *output + *cached
			verified.SettlementTokens = &total
		}
	}
	return verified, nil
}

func bind(document canonical.ModelReceipt, expectation Expectation) error {
	for _, field := range []struct {
		name     string
		actual   string
		expected string
	}{
		{"org id", document.Binding.OrgID, expectation.OrgID},
		{"task id", document.Binding.TaskID, expectation.TaskID},
		{"run id", document.Binding.RunID, expectation.RunID},
		{"operation id", document.OperationID, expectation.OperationID},
		{"attempt id", document.DispatchAttemptID, expectation.AttemptID},
		{"execution id", document.ExecutionID, expectation.ExecutionID},
		{"request hash", document.RequestHash, expectation.RequestHash},
	} {
		if field.expected == "" {
			continue
		}
		if field.actual != field.expected {
			return fmt.Errorf("%w: %s is %q, want %q", ErrBindingMismatch, field.name, field.actual, field.expected)
		}
	}
	return nil
}
