package egress

import (
	"context"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/runtime"
)

// Provider performs the one upstream model call of a won gate. An
// implementation must issue at most one request per call, must honour the
// caller's context, and must keep SDK/proxy/transport retries off (§5.4 item 3).
//
// The returned error decides the receipt:
//
//   - *ProviderRejection means the provider's own response proves no model
//     execution happened: a validation-class 4xx with no consumed tokens.
//     Execute then writes a rejected_not_executed receipt.
//   - anything else is treated as an unknown outcome. 429, 5xx, timeouts,
//     network errors, truncated or partial answers must NOT be returned as a
//     *ProviderRejection; Execute attaches nothing for them.
type Provider interface {
	Complete(ctx context.Context, request ProviderRequest) (ProviderResponse, error)
}

// ProviderRequest is the already-authorized call handed to the adapter. None of
// its message bytes, endpoint or credential enters the canonical model_request
// document, a log line or an error message.
type ProviderRequest struct {
	OrgID                string
	Provider             string
	Model                string
	ConfigRevision       string
	CompatProfileVersion string
	Parameters           canonical.Parameters
	// RequestHash is the canonical model_request hash the gate consumed. It is
	// for correlation only.
	RequestHash string
	Messages    MessageInput
}

// MessageInput is the authorized message assembly for this step. The compat
// profile owns how it is rendered into provider messages; Execute only carries
// it from the trusted caller to the adapter.
type MessageInput struct {
	SystemTemplate []byte
	Input          []byte
	// PriorAnswers are the public answers of the completed steps in logical
	// order, derived by the caller from trusted receipts. They are never model
	// supplied history text (§8.1 item 5).
	PriorAnswers [][]byte
}

// ProviderResponse is a terminal provider success.
type ProviderResponse struct {
	// Answer is the public answer body only: reasoning, raw tool calls and
	// provider metadata are dropped by the adapter (§7.4).
	Answer []byte
	// ProviderRequestID is optional. When empty or not representable in the
	// signed schema, the receipt records null rather than an invented id.
	ProviderRequestID string
	// Usage is the provider-reported or gateway-estimated usage. Leaving Source
	// empty (or any count nil) records source=unavailable with null counts.
	Usage runtime.Usage
}

// ProviderRejection is an adapter-classified proof that nothing was executed.
// Evidence is the bounded provider rejection body; it is stored as a content
// object and never printed.
type ProviderRejection struct {
	StatusCode int
	Code       string
	Evidence   []byte
}

func (e *ProviderRejection) Error() string {
	return "provider rejection: status=" + itoa(e.StatusCode) + " code=" + sanitizeCode(e.Code)
}

// ProviderFailure is an adapter-classified non-terminal failure: the request
// may or may not have executed. Execute turns it into an unknown outcome.
type ProviderFailure struct {
	StatusCode int
	Code       string
}

func (e *ProviderFailure) Error() string {
	return "provider failure: status=" + itoa(e.StatusCode) + " code=" + sanitizeCode(e.Code)
}

// itoa avoids importing strconv in the error path for a tiny status number.
func itoa(n int) string {
	if n <= 0 {
		return "none"
	}
	if n > 999 {
		return "invalid"
	}
	var digits [3]byte
	i := len(digits)
	for n > 0 {
		i--
		digits[i] = byte('0' + n%10)
		n /= 10
	}
	return string(digits[i:])
}
