package egress

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/we-meet/work/internal/authz"
	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/runtime"
)

// Gate types are the internal authz command contract, reused rather than
// restated: the egress gate client and the control plane must agree on the
// binding tuple byte for byte.
type (
	// DeliveryRequest is the binding tuple sent to consume_dispatch_delivery.
	DeliveryRequest = authz.DeliveryRequest
	// ConsumeDecision is the consume result. Only Won==true authorizes a send.
	ConsumeDecision = authz.ConsumeDecision
	// ReceiptRequest is the payload of attach_dispatch_receipt.
	ReceiptRequest = authz.ReceiptRequest
)

// GateClient is the atomic dispatch gate. Consume is the linearization point:
// only the caller whose gate insert committed may send once. Attach records the
// immutable receipt slot for the gate that this same call consumed.
type GateClient interface {
	Consume(ctx context.Context, request DeliveryRequest) (ConsumeDecision, error)
	Attach(ctx context.Context, request ReceiptRequest) error
}

// Outcome is the caller-facing classification of one Execute call. Only
// OutcomeSucceeded and OutcomeRejectedNotExecuted correspond to a stored
// terminal receipt; OutcomeUnknown is a reconciliation signal.
type Outcome string

const (
	// OutcomeSucceeded means the provider confirmed a result and the trusted
	// receipt was written.
	OutcomeSucceeded Outcome = "succeeded"
	// OutcomeRejectedNotExecuted means the provider proved nothing executed.
	OutcomeRejectedNotExecuted Outcome = "rejected_not_executed"
	// OutcomeUnknown means a provider call was made (or a won gate could not be
	// used) and no terminal receipt exists. Reconcile; never resend.
	OutcomeUnknown Outcome = "unknown"
	// OutcomeNotSent means nothing was sent: no gate was consumed for this call.
	OutcomeNotSent Outcome = "not_sent"
)

// ExchangeRequest is the trusted egress call. Every reference is an approved
// content reference; the gate tuple is the one the fragment wire carried.
type ExchangeRequest struct {
	Binding       canonical.Binding
	LogicalKey    canonical.LogicalKey
	Input         canonical.Reference
	Template      *canonical.Reference
	PriorReceipts []canonical.Reference
	Route         canonical.Route
	Parameters    canonical.Parameters

	// ExpectedRequestHash is the hash frozen in the pending intent. Execute
	// recomputes the document hash and refuses to consume on any difference.
	ExpectedRequestHash string

	Delivery DeliveryRequest

	// AnswerRefID is the reference id preallocated for the public answer body.
	// The reference registry owner records the mapping from this id to the
	// content locator returned in the result.
	AnswerRefID string
	// RejectionEvidenceRefID is the preallocated reference id used only when a
	// provider rejection must be recorded. An empty or malformed id turns a
	// rejection into an unknown outcome rather than an invented reference.
	RejectionEvidenceRefID string

	Messages MessageInput
}

// StoredReceipt identifies the trusted receipt object.
type StoredReceipt struct {
	// Reference is the immutable receipt reference: RefID is the preallocated
	// receipt slot, Hash is the canonical model_receipt document hash.
	Reference canonical.Reference
	// ContentRef is the content store locator of the stored receipt body.
	ContentRef string
}

// ExchangeResult is the authoritative outcome of Execute. When an error is
// returned after a confirmed success, Outcome is still OutcomeSucceeded; the
// error only describes the failed internal step.
type ExchangeResult struct {
	Outcome       Outcome
	Sent          bool
	RequestHash   string
	GateState     string
	ReceiptSlotID string

	Content      *canonical.Reference
	ContentBytes int64
	// ContentRef is the Content Store locator of the answer object. The
	// control plane registers it as an egress-written answer reference.
	ContentRef string
	Usage      canonical.Usage
	// ProviderRequestID is null when the provider gave none or an id the signed
	// schema cannot represent. The gateway never invents one.
	ProviderRequestID *string

	Receipt *StoredReceipt
	// ReceiptContentRef/ReceiptBytes locate and size the stored receipt object.
	ReceiptContentRef string
	ReceiptBytes      int64
	Attached          bool
}

// Exchange is the trusted send path. It is stateless and safe for concurrent
// use when its collaborators are.
type Exchange struct {
	Gate     GateClient
	Provider Provider
	Content  content.Store
	// Now overrides the clock in tests. It must never be used to extend a
	// deadline; the caller's context is the only deadline.
	Now func() time.Time
	// GatewayID is the authenticated writer identity (uuid) taken from the
	// egress workload certificate context. §8.1: writerGatewayId is verified
	// against authentication, never trusted because it appears in a body.
	GatewayID string
}

// Execute runs the send path for one model step:
//
//  1. rebuild and validate the canonical model request, recompute its hash and
//     refuse to proceed unless the frozen hash matches;
//  2. consume the gate and stop unless this call won;
//  3. make exactly one provider call with the caller's context;
//  4. on success store the answer, then the receipt, then attach;
//  5. on a provable rejection store the evidence, then a
//     rejected_not_executed receipt, then attach;
//  6. on anything else attach nothing and report an unknown outcome.
func (e *Exchange) Execute(ctx context.Context, request ExchangeRequest) (ExchangeResult, error) {
	if err := e.configError(); err != nil {
		return ExchangeResult{Outcome: OutcomeNotSent}, err
	}
	if err := validateShape(request); err != nil {
		return ExchangeResult{Outcome: OutcomeNotSent}, err
	}

	requestHash, err := requestHash(request)
	if err != nil {
		return ExchangeResult{Outcome: OutcomeNotSent}, err
	}
	if request.ExpectedRequestHash != requestHash || request.Delivery.RequestHash != requestHash {
		return ExchangeResult{Outcome: OutcomeNotSent, RequestHash: requestHash},
			&RequestHashError{
				Expected: diagnosticHash(request.ExpectedRequestHash),
				Delivery: diagnosticHash(request.Delivery.RequestHash),
				Computed: requestHash,
			}
	}

	decision, consumeErr := e.Gate.Consume(ctx, request.Delivery)
	if consumeErr != nil {
		return ExchangeResult{Outcome: OutcomeNotSent, RequestHash: requestHash},
			&GateError{Operation: "consume", Code: errorCode(consumeErr)}
	}
	gateState := sanitizeGateState(decision.GateState)
	if !decision.Won {
		return ExchangeResult{Outcome: OutcomeNotSent, RequestHash: requestHash, GateState: gateState},
			&NotSentError{GateState: gateState}
	}
	// A won gate is the one send authorization. Without a receipt slot the
	// result could never be attached, so fail closed and report the protocol
	// breach instead of sending.
	if !isUUID(decision.ReceiptSlotID) {
		return ExchangeResult{Outcome: OutcomeUnknown, RequestHash: requestHash, GateState: gateState},
			&GateProtocolError{Detail: "won_without_receipt_slot"}
	}

	// Exactly one provider call from here on. No retry loop, no fallback: §7.2
	// allows a fallback only before dispatch, which the gate decision already
	// resolved.
	response, providerErr := e.Provider.Complete(ctx, ProviderRequest{
		OrgID:                request.Binding.OrgID,
		Provider:             request.Route.Provider,
		Model:                request.Route.Model,
		ConfigRevision:       request.Route.ConfigRevision,
		CompatProfileVersion: request.Route.CompatProfileVersion,
		Parameters:           request.Parameters,
		RequestHash:          requestHash,
		Messages:             request.Messages,
	})
	if providerErr != nil {
		var rejection *ProviderRejection
		if errors.As(providerErr, &rejection) {
			return e.recordRejection(ctx, request, decision, gateState, requestHash, rejection)
		}
		return ExchangeResult{
				Outcome: OutcomeUnknown, Sent: true, RequestHash: requestHash,
				GateState: gateState, ReceiptSlotID: decision.ReceiptSlotID,
			},
			&UnknownError{Reason: unknownReason(providerErr, ctx)}
	}
	return e.recordSuccess(ctx, request, decision, gateState, requestHash, response)
}

// recordSuccess implements the signed write order: public answer put-if-absent
// → receipt put-if-absent into the preallocated slot → attach. A failure after
// the provider confirmed the call never changes Outcome away from succeeded.
func (e *Exchange) recordSuccess(
	ctx context.Context,
	request ExchangeRequest,
	decision ConsumeDecision,
	gateState, requestHash string,
	response ProviderResponse,
) (ExchangeResult, error) {
	result := ExchangeResult{
		Outcome:           OutcomeSucceeded,
		Sent:              true,
		RequestHash:       requestHash,
		GateState:         gateState,
		ReceiptSlotID:     decision.ReceiptSlotID,
		Usage:             canonicalUsage(response.Usage),
		ProviderRequestID: providerRequestID(response.ProviderRequestID),
	}
	if len(response.Answer) == 0 {
		// An empty body is not a deliverable answer; nothing trustworthy can be
		// attached, so the caller must reconcile rather than treat it as a
		// rejection or a success.
		result.Outcome = OutcomeUnknown
		return result, &UnknownError{Reason: "empty_answer"}
	}

	answerHash, hashErr := canonical.BodyHash(response.Answer)
	if hashErr != nil {
		// Not representable as a body reference (oversize or not UTF-8). The
		// call happened but has no deliverable result.
		result.Outcome = OutcomeUnknown
		return result, &UnknownError{Reason: "answer_not_representable"}
	}
	answerObject, storeErr := e.putImmutable(ctx, request.Binding.OrgID, response.Answer)
	if storeErr != nil {
		return result, &PersistenceError{Step: stepAnswer, Code: storeCode(storeErr)}
	}
	contentRef := canonical.Reference{RefID: request.AnswerRefID, Hash: answerHash}
	result.Content = &contentRef
	result.ContentBytes = int64(len(response.Answer))
	result.ContentRef = answerObject.ContentRef

	receiptID, idErr := newUUID()
	if idErr != nil {
		return result, &PersistenceError{Step: stepReceipt, Code: "id_generation_failed"}
	}
	recordedAt := e.now().UnixMilli()
	if recordedAt < 1 {
		return result, &ReceiptInvalidError{Detail: "clock_out_of_range"}
	}
	receipt := canonical.ModelReceipt{
		ReceiptID:         receiptID,
		Binding:           request.Binding,
		LogicalKey:        request.LogicalKey,
		OperationID:       request.Delivery.OperationID,
		DispatchAttemptID: request.Delivery.AttemptID,
		ExecutionID:       request.Delivery.ExecutionID,
		RequestHash:       requestHash,
		WriterGatewayID:   e.GatewayID,
		RecordedAtUnixMs:  recordedAt,
		Outcome:           canonical.OutcomeSucceeded,
		ProviderRequestID: result.ProviderRequestID,
		Content:           &contentRef,
		ContentBytes:      int64(len(response.Answer)),
		Usage:             result.Usage,
	}
	if err := receipt.Validate(); err != nil {
		return result, &ReceiptInvalidError{Detail: "validate_failed"}
	}
	receiptHash, err := receipt.Hash()
	if err != nil {
		return result, &ReceiptInvalidError{Detail: "hash_failed"}
	}
	receiptBody, err := receipt.Canonical()
	if err != nil {
		return result, &ReceiptInvalidError{Detail: "encode_failed"}
	}
	receiptObject, storeErr := e.putImmutable(ctx, request.Binding.OrgID, receiptBody)
	if storeErr != nil {
		return result, &PersistenceError{Step: stepReceipt, Code: storeCode(storeErr)}
	}

	// The receipt slot is the preallocated uuid; the hash is the canonical
	// document hash (not the body hash), because the gate verifies the receipt
	// document it will parse.
	result.Receipt = &StoredReceipt{
		Reference:  canonical.Reference{RefID: decision.ReceiptSlotID, Hash: receiptHash},
		ContentRef: receiptObject.ContentRef,
	}
	result.ReceiptContentRef = receiptObject.ContentRef
	result.ReceiptBytes = int64(len(receiptBody))
	attachRequest := ReceiptRequest{
		OrgID:             request.Binding.OrgID,
		OperationID:       request.Delivery.OperationID,
		ExecutionID:       request.Delivery.ExecutionID,
		AttemptID:         request.Delivery.AttemptID,
		ReceiptSlotID:     decision.ReceiptSlotID,
		ReceiptRef:        receiptObject.ContentRef,
		ReceiptHash:       receiptHash,
		ReceiptResult:     authz.ReceiptSucceeded,
		ProviderRequestID: deref(result.ProviderRequestID),
	}
	if attachErr := e.Gate.Attach(ctx, attachRequest); attachErr != nil {
		// The model call is not failed. Return the receipt coordinates so the
		// caller retries only the attach.
		return result, &AttachError{
			Receipt:    result.Receipt.Reference,
			ContentRef: receiptObject.ContentRef,
			Code:       errorCode(attachErr),
			Request:    attachRequest,
		}
	}
	result.Attached = true
	return result, nil
}

// recordRejection writes the only other terminal receipt: a provider rejection
// that proves no execution, with zero provider usage and no content.
func (e *Exchange) recordRejection(
	ctx context.Context,
	request ExchangeRequest,
	decision ConsumeDecision,
	gateState, requestHash string,
	rejection *ProviderRejection,
) (ExchangeResult, error) {
	// Zero provider usage is a claim ("no tokens consumed"), not an unknown
	// value, so it is spelled with present zeros (§8.1). The same value goes
	// into the receipt and the result.
	zeroUsage := canonical.Usage{
		Source:            canonical.UsageProvider,
		InputTokens:       canonical.Int64(0),
		OutputTokens:      canonical.Int64(0),
		CachedInputTokens: canonical.Int64(0),
	}
	result := ExchangeResult{
		Outcome:       OutcomeRejectedNotExecuted,
		Sent:          true,
		RequestHash:   requestHash,
		GateState:     gateState,
		ReceiptSlotID: decision.ReceiptSlotID,
		Usage:         zeroUsage,
	}
	// A terminal rejection needs a rejection evidence reference. Without bytes
	// or a preallocated slot the gateway cannot produce one, and inventing a
	// reference is forbidden; stay unknown instead.
	if len(rejection.Evidence) == 0 || !isUUID(request.RejectionEvidenceRefID) {
		result.Outcome = OutcomeUnknown
		return result, &UnknownError{Reason: "rejection_evidence_unavailable"}
	}
	evidenceObject, storeErr := e.putImmutable(ctx, request.Binding.OrgID, rejection.Evidence)
	if storeErr != nil {
		result.Outcome = OutcomeUnknown
		return result, &UnknownError{Reason: "rejection_evidence_not_persisted"}
	}
	evidence := canonical.Reference{RefID: request.RejectionEvidenceRefID, Hash: evidenceObject.Hash}

	receiptID, idErr := newUUID()
	if idErr != nil {
		result.Outcome = OutcomeUnknown
		return result, &UnknownError{Reason: "rejection_receipt_not_persisted"}
	}
	recordedAt := e.now().UnixMilli()
	if recordedAt < 1 {
		result.Outcome = OutcomeUnknown
		return result, &UnknownError{Reason: "clock_out_of_range"}
	}
	receipt := canonical.ModelReceipt{
		ReceiptID:         receiptID,
		Binding:           request.Binding,
		LogicalKey:        request.LogicalKey,
		OperationID:       request.Delivery.OperationID,
		DispatchAttemptID: request.Delivery.AttemptID,
		ExecutionID:       request.Delivery.ExecutionID,
		RequestHash:       requestHash,
		WriterGatewayID:   e.GatewayID,
		RecordedAtUnixMs:  recordedAt,
		Outcome:           canonical.OutcomeRejectedNotExec,
		ContentBytes:      0,
		Usage:             zeroUsage,
		RejectionEvidence: &evidence,
	}
	if err := receipt.Validate(); err != nil {
		result.Outcome = OutcomeUnknown
		return result, &UnknownError{Reason: "rejection_receipt_invalid"}
	}
	receiptHash, err := receipt.Hash()
	if err != nil {
		result.Outcome = OutcomeUnknown
		return result, &UnknownError{Reason: "rejection_receipt_invalid"}
	}
	receiptBody, err := receipt.Canonical()
	if err != nil {
		result.Outcome = OutcomeUnknown
		return result, &UnknownError{Reason: "rejection_receipt_invalid"}
	}
	receiptObject, storeErr := e.putImmutable(ctx, request.Binding.OrgID, receiptBody)
	if storeErr != nil {
		result.Outcome = OutcomeUnknown
		return result, &UnknownError{Reason: "rejection_receipt_not_persisted"}
	}
	result.Receipt = &StoredReceipt{
		Reference:  canonical.Reference{RefID: decision.ReceiptSlotID, Hash: receiptHash},
		ContentRef: receiptObject.ContentRef,
	}
	attachRequest := ReceiptRequest{
		OrgID:         request.Binding.OrgID,
		OperationID:   request.Delivery.OperationID,
		ExecutionID:   request.Delivery.ExecutionID,
		AttemptID:     request.Delivery.AttemptID,
		ReceiptSlotID: decision.ReceiptSlotID,
		ReceiptRef:    receiptObject.ContentRef,
		ReceiptHash:   receiptHash,
		ReceiptResult: authz.ReceiptRejectedNotExecuted,
	}
	if attachErr := e.Gate.Attach(ctx, attachRequest); attachErr != nil {
		return result, &AttachError{
			Receipt:    result.Receipt.Reference,
			ContentRef: receiptObject.ContentRef,
			Code:       errorCode(attachErr),
			Request:    attachRequest,
		}
	}
	result.Attached = true
	return result, &RejectedError{Receipt: result.Receipt.Reference, Code: rejection.Code}
}

func (e *Exchange) configError() error {
	switch {
	case e.Gate == nil:
		return &InvalidRequestError{Field: "gate_not_configured"}
	case e.Provider == nil:
		return &InvalidRequestError{Field: "provider_not_configured"}
	case e.Content == nil:
		return &InvalidRequestError{Field: "content_not_configured"}
	case !isUUID(e.GatewayID):
		return &InvalidRequestError{Field: "gateway_id"}
	default:
		return nil
	}
}

func validateShape(request ExchangeRequest) error {
	switch {
	case !isUUID(request.AnswerRefID):
		return &InvalidRequestError{Field: "answer_ref_id"}
	case request.RejectionEvidenceRefID != "" && !isUUID(request.RejectionEvidenceRefID):
		return &InvalidRequestError{Field: "rejection_evidence_ref_id"}
	case request.Binding.OrgID == "" || request.Binding.OrgID != request.Delivery.OrgID:
		return &InvalidRequestError{Field: "org_binding"}
	case request.Delivery.OperationID == "":
		return &InvalidRequestError{Field: "operation_id"}
	case request.Delivery.AttemptID == "":
		return &InvalidRequestError{Field: "attempt_id"}
	case request.Delivery.ExecutionID == "":
		return &InvalidRequestError{Field: "execution_id"}
	default:
		return nil
	}
}

func requestHash(request ExchangeRequest) (string, error) {
	document := canonical.ModelRequest{
		Binding:       request.Binding,
		LogicalKey:    request.LogicalKey,
		Input:         request.Input,
		Template:      request.Template,
		PriorReceipts: append([]canonical.Reference(nil), request.PriorReceipts...),
		Route:         request.Route,
		Parameters:    request.Parameters,
	}
	// The document is built from identifiers and references only: no base URL,
	// API key, credential version or raw message array has a field here.
	if err := document.Validate(); err != nil {
		return "", &InvalidRequestError{Field: "model_request", Cause: err}
	}
	hash, err := document.Hash()
	if err != nil {
		return "", &InvalidRequestError{Field: "model_request", Cause: err}
	}
	return hash, nil
}

func diagnosticHash(value string) string {
	if canonical.ValidHash(value) {
		return value
	}
	return "not_a_digest"
}

// putImmutable writes body and proves the returned locator resolves to exactly
// the bytes that were hashed. The stores in this repository are create-only
// (each Put mints a fresh immutable object id), so a second write cannot replace
// an existing receipt or answer; the read-back additionally catches a store that
// returned a different body, a different hash form or a truncated object. A
// future mutable-slot store must enforce create-only writes itself: this check
// cannot prove that an unrelated object was not overwritten.
func (e *Exchange) putImmutable(ctx context.Context, orgID string, body []byte) (content.Ref, error) {
	bodyHash, err := canonical.BodyHash(body)
	if err != nil {
		return content.Ref{}, errStoreRejected
	}
	ref, err := e.Content.Put(ctx, orgID, body)
	if err != nil {
		return content.Ref{}, err
	}
	if ref.ContentRef == "" || ref.Hash != bodyHash || ref.Bytes != int64(len(body)) {
		return content.Ref{}, errStoreMismatch
	}
	stored, err := e.Content.Get(ctx, orgID, ref.ContentRef)
	if err != nil {
		return content.Ref{}, err
	}
	if !bytes.Equal(stored, body) {
		return content.Ref{}, errStoreMismatch
	}
	return ref, nil
}

var (
	errStoreRejected = errors.New("content body rejected")
	errStoreMismatch = errors.New("content object does not match its reference")
)

func storeCode(err error) string {
	switch {
	case errors.Is(err, errStoreRejected):
		return "body_rejected"
	case errors.Is(err, errStoreMismatch):
		return "reference_mismatch"
	default:
		return "write_failed"
	}
}

// canonicalUsage maps the runtime usage type onto the signed receipt usage.
// A provider that reported no counts, partial counts or a negative count yields
// unavailable with all fields nil: §8.1 forbids using 0 for unknown.
func canonicalUsage(usage runtime.Usage) canonical.Usage {
	source := canonical.UsageSource(usage.Source)
	switch source {
	case canonical.UsageProvider, canonical.UsageGatewayEstimate:
		input, output, cached := usage.InputTokens, usage.OutputTokens, usage.CachedInputTokens
		if input == nil || output == nil || cached == nil {
			break
		}
		if *input < 0 || *output < 0 || *cached < 0 ||
			*input > canonical.MaxSafeInteger || *output > canonical.MaxSafeInteger ||
			*cached > canonical.MaxSafeInteger {
			break
		}
		return canonical.Usage{
			Source:            source,
			InputTokens:       canonical.Int64(*input),
			OutputTokens:      canonical.Int64(*output),
			CachedInputTokens: canonical.Int64(*cached),
		}
	}
	return canonical.Usage{Source: canonical.UsageUnavailable}
}

var providerRequestIDShape = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,256}$`)

// providerRequestID keeps a representable provider id and otherwise records
// null. §8.1: without upstream query capability the gateway must not invent an
// id; an empty or malformed string is not an id.
func providerRequestID(value string) *string {
	if !providerRequestIDShape.MatchString(value) {
		return nil
	}
	return canonical.String(value)
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (e *Exchange) now() time.Time {
	if e.Now == nil {
		return time.Now()
	}
	return e.Now()
}

var uuidShape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// isUUID mirrors the signed schema pattern. Canonicalisation and hashing stay
// in internal/canonical; this is only the identifier shape check needed before
// a gate is consumed.
func isUUID(value string) bool { return uuidShape.MatchString(value) }

// newUUID mints a random identifier for fields the schema requires to be a uuid
// (receipt id). It does not create content references: answer and evidence
// reference ids are preallocated by the reference registry owner.
func newUUID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

// errorCode reduces a gate error to an enumeration. authz.Error already carries
// a code; any other error is replaced by a fixed code so unexpected text (SQL,
// request bodies, secrets) can never reach the caller.
func errorCode(err error) string {
	if err == nil {
		return ""
	}
	var authzError *authz.Error
	if errors.As(err, &authzError) {
		return sanitizeCode(authzError.Code)
	}
	var coded interface{ ErrorCode() string }
	if errors.As(err, &coded) {
		return sanitizeCode(coded.ErrorCode())
	}
	return "gate_unavailable"
}

func unknownReason(err error, ctx context.Context) string {
	var failure *ProviderFailure
	if errors.As(err, &failure) && failure.Code != "" {
		return sanitizeCode(failure.Code)
	}
	if ctx != nil && ctx.Err() != nil {
		return "context_expired"
	}
	return "provider_error"
}
