package egressservice

import (
	"errors"
	"net/http"
)

// invokeError is one pre-send refusal reduced to an HTTP status and an
// enumeration code. Its Error text is the code itself, so no database,
// reference or provider detail can reach a response or a log line.
type invokeError struct {
	status int
	code   string
}

func (e *invokeError) Error() string { return e.code }

func fail(status int, code string) error { return &invokeError{status: status, code: code} }

// Pre-send refusals. Every one happens before the gate is consumed, so none of
// them can have sent a provider request.
var (
	errInvalidRequest            = fail(http.StatusUnprocessableEntity, codeInvalidRequest)
	errRequestHashMismatch       = fail(http.StatusUnprocessableEntity, codeRequestHashMismatch)
	errReferenceNotFound         = fail(http.StatusNotFound, codeContentReferenceNotFound)
	errReferenceUnavailable      = fail(http.StatusServiceUnavailable, codeContentReferenceUnavail)
	errReferenceKindMismatch     = fail(http.StatusUnprocessableEntity, codeContentKindMismatch)
	errContentUnavailable        = fail(http.StatusServiceUnavailable, codeContentUnavailable)
	errContentIntegrity          = fail(http.StatusInternalServerError, codeContentIntegrityFailed)
	errModelRequestInvalid       = fail(http.StatusUnprocessableEntity, codeModelRequestInvalid)
	errRequestBindingMismatch    = fail(http.StatusUnprocessableEntity, codeRequestBindingMismatch)
	errExecutionNotExecutable    = fail(http.StatusConflict, codeExecutionNotExecutable)
	errExecutionBindingUnavail   = fail(http.StatusServiceUnavailable, codeExecutionBindingUnavail)
	errPriorReceiptUnusable      = fail(http.StatusUnprocessableEntity, codePriorReceiptUnusable)
	errMessageInvalid            = fail(http.StatusUnprocessableEntity, codeMessageInvalid)
	errAnswerReferenceGeneration = fail(http.StatusServiceUnavailable, codeAnswerRefUnavailable)
)

// writeInvokeError emits {"code":"..."} for a pre-send refusal. An unexpected
// error is reduced to content_reference_unavailable rather than echoing its
// text; the response is always a single code.
func writeInvokeError(w http.ResponseWriter, err error) {
	var refused *invokeError
	if errors.As(err, &refused) {
		writeError(w, refused.status, refused.code)
		return
	}
	writeError(w, http.StatusServiceUnavailable, codeContentReferenceUnavail)
}
