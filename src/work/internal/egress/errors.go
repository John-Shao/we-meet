package egress

import (
	"errors"
	"regexp"

	"github.com/we-meet/work/internal/canonical"
)

// Stable failure codes. §5.4: "所有命令的公开错误只含枚举与允许的修订元数据，不回显
// 正文/凭据." Every typed error below prints enumeration codes and shape-checked
// identifiers only; provider bodies, task text, prompts and credentials are
// never part of an error message.
var (
	// ErrNotSent means the dispatch gate did not return won. Nothing was sent.
	ErrNotSent = errors.New("dispatch_not_won")
	// ErrRequestHashMismatch means the caller's frozen hash is not the hash of
	// the canonical request document. Nothing was consumed and nothing was sent.
	ErrRequestHashMismatch = errors.New("request_hash_mismatch")
	// ErrInvalidRequest means Execute refused the call before the gate.
	ErrInvalidRequest = errors.New("invalid_request")
	// ErrGateError means the gate RPC/backend failed.
	ErrGateError = errors.New("gate_error")
	// ErrGateProtocol means the gate returned a decision Execute cannot act on.
	ErrGateProtocol = errors.New("gate_protocol_violation")
	// ErrUnknownOutcome means the provider call was made and its outcome cannot
	// be proven. No receipt exists; the caller reconciles.
	ErrUnknownOutcome = errors.New("provider_outcome_unknown")
	// ErrRejectedNotExecuted means the provider proved nothing executed and a
	// rejected_not_executed receipt was attached.
	ErrRejectedNotExecuted = errors.New("provider_rejected_not_executed")
	// ErrReceiptAttachFailed means a trusted receipt exists but Gate.Attach
	// failed. Retry the attach with RetryReceipt; never re-call the provider.
	ErrReceiptAttachFailed = errors.New("receipt_attach_failed")
	// ErrReceiptNotPersisted means a terminal receipt could not be stored.
	ErrReceiptNotPersisted = errors.New("receipt_not_persisted")
	// ErrContentStore means content could not be written or verified.
	ErrContentStore = errors.New("content_store_failed")
	// ErrReceiptInvalid means the built receipt failed signed validation.
	ErrReceiptInvalid = errors.New("receipt_invalid")
)

// InvalidRequestError carries a fixed field enumeration. Cause is available for
// local diagnostics but is not printed, because canonical error text can quote
// caller-supplied field values.
type InvalidRequestError struct {
	Field string
	Cause error
}

func (e *InvalidRequestError) Error() string {
	return "egress: invalid_request: field=" + sanitizeField(e.Field)
}

// Unwrap implements errors.Is/As for ErrInvalidRequest.
func (e *InvalidRequestError) Unwrap() error { return ErrInvalidRequest }

// RequestHashError reports the frozen hash comparison. Expected and Delivery
// hold either a valid digest or "not_a_digest"; Computed is always a digest.
type RequestHashError struct {
	Expected string
	Delivery string
	Computed string
}

func (e *RequestHashError) Error() string {
	return "egress: request_hash_mismatch: expected=" + e.Expected +
		" delivery=" + e.Delivery + " computed=" + e.Computed
}

// Unwrap implements errors.Is/As for ErrRequestHashMismatch.
func (e *RequestHashError) Unwrap() error { return ErrRequestHashMismatch }

// NotSentError reports a non-won consume decision. GateState is the sanitized
// database gate state; it never authorizes a send.
type NotSentError struct {
	GateState string
}

func (e *NotSentError) Error() string {
	return "egress: dispatch_not_won: gate_state=" + e.GateState
}

// Unwrap implements errors.Is/As for ErrNotSent.
func (e *NotSentError) Unwrap() error { return ErrNotSent }

// GateError reports a gate RPC failure with an enumeration code.
type GateError struct {
	Operation string
	Code      string
}

func (e *GateError) Error() string {
	return "egress: gate_error: operation=" + sanitizeField(e.Operation) + " code=" + sanitizeCode(e.Code)
}

// Unwrap implements errors.Is/As for ErrGateError.
func (e *GateError) Unwrap() error { return ErrGateError }

// GateProtocolError reports a decision Execute refuses to act on. Detail is a
// fixed enumeration written by this package.
type GateProtocolError struct {
	Detail string
}

func (e *GateProtocolError) Error() string {
	return "egress: gate_protocol_violation: " + sanitizeField(e.Detail)
}

// Unwrap implements errors.Is/As for ErrGateProtocol.
func (e *GateProtocolError) Unwrap() error { return ErrGateProtocol }

// UnknownError reports a provider call whose outcome cannot be proven. Reason is
// a fixed enumeration or a provider-adapter code, never provider text.
type UnknownError struct {
	Reason string
}

func (e *UnknownError) Error() string {
	return "egress: provider_outcome_unknown: reason=" + sanitizeCode(e.Reason)
}

// Unwrap implements errors.Is/As for ErrUnknownOutcome.
func (e *UnknownError) Unwrap() error { return ErrUnknownOutcome }

// RejectedError reports an attached rejected_not_executed receipt.
type RejectedError struct {
	Receipt canonical.Reference
	Code    string
}

func (e *RejectedError) Error() string {
	return "egress: provider_rejected_not_executed: receipt=" + e.Receipt.RefID +
		" hash=" + e.Receipt.Hash + " code=" + sanitizeCode(e.Code)
}

// Unwrap implements errors.Is/As for ErrRejectedNotExecuted.
func (e *RejectedError) Unwrap() error { return ErrRejectedNotExecuted }

// AttachError reports a failed receipt attach after a trusted receipt was
// stored. It carries the receipt reference, hash and content locator so the
// caller can retry AttachDispatchReceipt with the same values; Request is the
// exact payload to retry (it contains identifiers and hashes only).
type AttachError struct {
	Receipt    canonical.Reference
	ContentRef string
	Code       string
	Request    ReceiptRequest
}

func (e *AttachError) Error() string {
	return "egress: receipt_attach_failed: receipt=" + e.Receipt.RefID +
		" hash=" + e.Receipt.Hash + " code=" + sanitizeCode(e.Code)
}

// Unwrap implements errors.Is/As for ErrReceiptAttachFailed.
func (e *AttachError) Unwrap() error { return ErrReceiptAttachFailed }

// PersistenceError reports a failed content write. Step is "answer" or
// "receipt"; Code is a fixed enumeration.
type PersistenceError struct {
	Step string
	Code string
}

func (e *PersistenceError) Error() string {
	return "egress: " + e.sentinel().Error() + ": step=" + sanitizeField(e.Step) + " code=" + sanitizeCode(e.Code)
}

func (e *PersistenceError) sentinel() error {
	if e.Step == stepReceipt {
		return ErrReceiptNotPersisted
	}
	return ErrContentStore
}

// Unwrap selects the step-specific sentinel.
func (e *PersistenceError) Unwrap() error { return e.sentinel() }

// ReceiptInvalidError reports a receipt that failed signed validation. A
// confirmed success keeps Outcome succeeded; only the attach is withheld.
type ReceiptInvalidError struct {
	Detail string
}

func (e *ReceiptInvalidError) Error() string {
	return "egress: receipt_invalid: " + sanitizeField(e.Detail)
}

// Unwrap implements errors.Is/As for ErrReceiptInvalid.
func (e *ReceiptInvalidError) Unwrap() error { return ErrReceiptInvalid }

const (
	stepAnswer  = "answer"
	stepReceipt = "receipt"
)

var (
	codePattern  = regexp.MustCompile(`^[a-z][a-z0-9_]{1,63}(?::[a-z0-9_]{1,63})?$`)
	fieldPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{1,63}$`)
)

// sanitizeCode keeps an enumeration code; anything else becomes "unclassified"
// so an upstream error string can never reach a caller through this package.
func sanitizeCode(code string) string {
	if codePattern.MatchString(code) {
		return code
	}
	return "unclassified"
}

func sanitizeField(field string) string {
	if fieldPattern.MatchString(field) {
		return field
	}
	return "unclassified"
}

// sanitizeGateState accepts only the signed dispatch_delivery gate states.
func sanitizeGateState(state string) string {
	switch state {
	case "won", "consumed", "sealed_not_sent", "receipt_recorded", "observed":
		return state
	default:
		return "unspecified"
	}
}
