package egressservice

import (
	"errors"
	"net/http"

	"github.com/we-meet/work/internal/egress"
)

// receiptResponse is the trusted receipt reference plus the Content Store
// locator of the stored receipt body, so the control plane can register the
// kind/object mapping later. It never contains a host path or object key.
type receiptResponse struct {
	RefID      string `json:"refId"`
	Hash       string `json:"hash"`
	ContentRef string `json:"contentRef"`
}

// contentResponse is the public answer reference. Bytes is the answer length;
// the body itself is not returned.
type contentResponse struct {
	RefID string `json:"refId"`
	Hash  string `json:"hash"`
	Bytes int64  `json:"bytes"`
}

// usageResponse mirrors canonical.Usage: unavailable counts are null, never
// zero.
type usageResponse struct {
	Source            string `json:"source"`
	InputTokens       *int64 `json:"inputTokens"`
	OutputTokens      *int64 `json:"outputTokens"`
	CachedInputTokens *int64 `json:"cachedInputTokens"`
}

// invokeResponse is the closed outcome body. Message text, token, provider
// secret and any provider raw body have no field here.
type invokeResponse struct {
	Outcome                egress.Outcome   `json:"outcome"`
	Sent                   bool             `json:"sent"`
	RequestHash            string           `json:"requestHash"`
	GateState              string           `json:"gateState"`
	Code                   string           `json:"code,omitempty"`
	Receipt                *receiptResponse `json:"receipt"`
	Content                *contentResponse `json:"content"`
	AnswerRefID            string           `json:"answerRefId"`
	RejectionEvidenceRefID string           `json:"rejectionEvidenceRefId"`
	Usage                  *usageResponse   `json:"usage"`
	ProviderRequestID      *string          `json:"providerRequestId"`
}

// writeExchangeResult writes the authoritative Exchange result. Only failures
// that happened before any send may be replaced by a bare {"code":...} error;
// once Execute reached the gate, its outcome is returned even when a later
// internal step failed (for example a receipt attach).
func writeExchangeResult(
	w http.ResponseWriter, result egress.ExchangeResult, err error,
	answerRefID, evidenceRefID string,
) {
	status, code := classifyExchangeError(err)
	if status != http.StatusOK {
		writeError(w, status, code)
		return
	}
	response := invokeResponse{
		Outcome:                result.Outcome,
		Sent:                   result.Sent,
		RequestHash:            result.RequestHash,
		GateState:              result.GateState,
		Code:                   code,
		AnswerRefID:            answerRefID,
		RejectionEvidenceRefID: evidenceRefID,
		ProviderRequestID:      result.ProviderRequestID,
	}
	if result.Receipt != nil {
		response.Receipt = &receiptResponse{
			RefID:      result.Receipt.Reference.RefID,
			Hash:       result.Receipt.Reference.Hash,
			ContentRef: result.Receipt.ContentRef,
		}
	}
	if result.Content != nil {
		response.Content = &contentResponse{
			RefID: result.Content.RefID,
			Hash:  result.Content.Hash,
			Bytes: result.ContentBytes,
		}
	}
	if result.Usage.Source != "" {
		response.Usage = &usageResponse{
			Source:            string(result.Usage.Source),
			InputTokens:       result.Usage.InputTokens,
			OutputTokens:      result.Usage.OutputTokens,
			CachedInputTokens: result.Usage.CachedInputTokens,
		}
	}
	writeJSON(w, http.StatusOK, response)
}

// classifyExchangeError reduces an Execute failure to a status and an
// enumeration code. No error text is used.
func classifyExchangeError(err error) (int, string) {
	switch {
	case err == nil:
		return http.StatusOK, ""
	case errors.Is(err, egress.ErrInvalidRequest):
		return http.StatusUnprocessableEntity, codeInvalidRequest
	case errors.Is(err, egress.ErrRequestHashMismatch):
		return http.StatusUnprocessableEntity, codeRequestHashMismatch
	case errors.Is(err, egress.ErrGateError):
		return http.StatusServiceUnavailable, codeGateUnavailable
	case errors.Is(err, egress.ErrGateProtocol):
		return http.StatusBadGateway, codeGateProtocol
	case errors.Is(err, egress.ErrNotSent):
		return http.StatusOK, codeDispatchNotWon
	case errors.Is(err, egress.ErrUnknownOutcome):
		return http.StatusOK, unknownReasonCode(err)
	case errors.Is(err, egress.ErrRejectedNotExecuted):
		return http.StatusOK, rejectionCode(err)
	case errors.Is(err, egress.ErrReceiptAttachFailed):
		return http.StatusOK, codeReceiptAttachFailed
	case errors.Is(err, egress.ErrReceiptNotPersisted):
		return http.StatusOK, codeReceiptNotPersisted
	case errors.Is(err, egress.ErrContentStore):
		return http.StatusOK, codeContentStoreFailed
	case errors.Is(err, egress.ErrReceiptInvalid):
		return http.StatusOK, codeReceiptInvalid
	default:
		return http.StatusOK, codeUnknownOutcome
	}
}

func unknownReasonCode(err error) string {
	var unknown *egress.UnknownError
	if errors.As(err, &unknown) && codeValuePattern.MatchString(unknown.Reason) {
		return unknown.Reason
	}
	return codeUnknownOutcome
}

func rejectionCode(err error) string {
	var rejected *egress.RejectedError
	if errors.As(err, &rejected) && codeValuePattern.MatchString(rejected.Code) {
		return rejected.Code
	}
	return "rejected"
}
