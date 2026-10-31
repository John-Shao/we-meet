package egressservice

import (
	"context"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/we-meet/work/internal/authz"
	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/contentref"
	"github.com/we-meet/work/internal/egress"
	"github.com/we-meet/work/internal/providerctx"
)

var (
	generationPattern = regexp.MustCompile(`^[1-9][0-9]{0,8}$`)
	codeValuePattern  = regexp.MustCompile(`^[a-z][a-z0-9_]{1,63}(?::[a-z0-9_]{1,63})?$`)
)

// credential is the capability binding presented by the caller. None of it is
// trusted until Authorize re-reads the authoritative records.
type credential struct {
	org        string
	execution  string
	generation int
	token      string
}

// handleInvoke serves one signed thin-wire model call.
//
// Order (each failure is final, and nothing is consumed or sent until every
// pre-send check passed):
//  1. credential headers are present and shaped (401);
//  2. capability.Authorize(org, execution, "work-egress", generation, token)
//     is true against live records (401/503), never cached;
//  3. the body is within the ceiling and strictly decodes to
//     {executionId, requestRef, requestHash}; unknown fields, malformed ids and
//     a body/header execution mismatch are 422 (413 for oversize);
//  4. requestRef resolves to a live model_request bound to this execution, its
//     bytes hash equals the registry hash and the body hash, and it parses as
//     a canonical model_request (404/409/422/500);
//  5. input, template and prior-receipt objects are read and hash-verified;
//     the deterministic message sequence is assembled in memory;
//  6. providerctx resolves the organization's managed_key endpoint and secret;
//     sts_role is refused and the frozen route must name the resolved
//     provider/model;
//  7. the execution row supplies operation/attempt/holder/fence; a plan
//     fragment, a different request hash or another task/run is refused;
//  8. authz.ConsumeByExecution is the only send authorization;
//  9. egress.Exchange makes exactly one provider call and the Gate adapter
//     attaches the receipt slot from the won decision.
func (s *Server) handleInvoke(w http.ResponseWriter, r *http.Request) {
	presented, ok := readCredential(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, codeCapabilityInvalid)
		return
	}
	started := time.Now()
	stage := func(name string) {
		execution := presented.execution
		if len(execution) > 8 {
			execution = execution[:8]
		}
		log.Printf("work egress invoke execution=%s stage=%s elapsed_ms=%d",
			execution, name, time.Since(started).Milliseconds())
	}

	allowed, err := s.authorizer.Authorize(r.Context(), presented.org, presented.execution,
		audience, presented.generation, presented.token)
	if err != nil {
		// The authorization service or database is unavailable: deny.
		writeError(w, http.StatusServiceUnavailable, codeAuthorizationUnavailable)
		return
	}
	if !allowed {
		writeError(w, http.StatusUnauthorized, codeCapabilityInvalid)
		return
	}
	stage("authorized")

	body, err := readBody(r)
	if err != nil {
		if errors.Is(err, errBodyTooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, codeRequestTooLarge)
			return
		}
		writeError(w, http.StatusUnprocessableEntity, codeInvalidRequest)
		return
	}
	envelope, err := decodeInvoke(body)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, codeInvalidRequest)
		return
	}
	if err := envelope.validate(presented.execution); err != nil {
		writeError(w, http.StatusUnprocessableEntity, codeInvalidRequest)
		return
	}
	stage("request_validated")

	// The provider call and receipt attach must outlive a vanished child. D4
	// §6.2 item 7 keeps a late receipt on the original gate/slot under the egress
	// service identity, which is only possible if the call does not inherit the
	// child's request cancellation. The signed 15-minute budget still bounds it.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), invokeTimeout)
	defer cancel()

	document, documentHash, err := s.loadModelRequest(
		ctx, presented.org, presented.execution, envelope.RequestRef.RefID, envelope.RequestHash)
	if err != nil {
		writeInvokeError(w, err)
		return
	}
	stage("intent_loaded")

	messages, err := s.assembleMessages(ctx, presented.org, presented.execution, document)
	if err != nil {
		writeInvokeError(w, err)
		return
	}
	stage("messages_ready")

	resolved, err := s.providers.Resolve(ctx, presented.org)
	if err != nil {
		writeProviderResolveError(w, err)
		return
	}
	// The decrypted managed_key secret is only handed to the provider factory.
	// Wipe the local copy as soon as the factory has captured what it needs.
	defer wipe(resolved.Secret)
	if resolved.Mode != "managed_key" {
		// §7.5: sts_role exchange is not part of R0a. Refuse instead of sending
		// with a missing or invented credential.
		writeError(w, http.StatusUnprocessableEntity, codeProviderModeUnsupported)
		return
	}
	if resolved.Provider != document.Route.Provider || resolved.Model != document.Route.Model {
		// The frozen request routes to one provider/model; the organization's
		// active configuration names another. Never send the frozen intent
		// through a different target than the one it was authorized for.
		writeError(w, http.StatusUnprocessableEntity, codeProviderMismatch)
		return
	}
	if resolved.Endpoint == "" || len(resolved.Secret) == 0 {
		writeError(w, http.StatusServiceUnavailable, codeProviderUnavailable)
		return
	}
	provider, err := s.factory(resolved.Endpoint, string(resolved.Secret))
	if err != nil {
		// The factory error text may name the endpoint; never echo it.
		writeError(w, http.StatusServiceUnavailable, codeProviderUnavailable)
		return
	}
	stage("provider_ready")

	binding, err := s.resolveExecution(ctx, presented.org, presented.execution, document, documentHash)
	if err != nil {
		writeInvokeError(w, err)
		return
	}
	stage("execution_resolved")

	// Answer and rejection evidence are the only reference ids the caller never
	// names. Mint them before consuming so a failed allocation cannot burn a
	// gate that could no longer be attached.
	answerRefID, err := newReferenceID()
	if err != nil {
		writeInvokeError(w, errAnswerReferenceGeneration)
		return
	}
	evidenceRefID, err := newReferenceID()
	if err != nil {
		writeInvokeError(w, errAnswerReferenceGeneration)
		return
	}

	decision, err := s.commands.ConsumeByExecution(ctx, authz.ExecutionConsumeRequest{
		OrgID:       presented.org,
		ExecutionID: presented.execution,
		RequestHash: documentHash,
	})
	if err != nil {
		writeConsumeError(w, err)
		return
	}
	stage("gate_consumed")

	exchange := &egress.Exchange{
		Gate: &decisionGate{
			commands:    s.commands,
			decision:    decision,
			binding:     binding,
			requestHash: documentHash,
		},
		Provider:  provider,
		Content:   s.store,
		GatewayID: s.config.GatewayID,
	}
	result, executeErr := exchange.Execute(ctx, egress.ExchangeRequest{
		Binding:                document.Binding,
		LogicalKey:             document.LogicalKey,
		Input:                  document.Input,
		Template:               document.Template,
		PriorReceipts:          document.PriorReceipts,
		Route:                  document.Route,
		Parameters:             document.Parameters,
		ExpectedRequestHash:    documentHash,
		Delivery:               deliveryFromBinding(presented.org, binding),
		AnswerRefID:            answerRefID,
		RejectionEvidenceRefID: evidenceRefID,
		Messages:               messages.Input,
	})
	if executeErr == nil {
		// The receipt is attached by now. Register the egress-written answer
		// and receipt references so the control plane can resolve them when it
		// commits the canonical successor.
		if err := s.registerOutputs(ctx, presented.org, binding, string(document.LogicalKey), result); err != nil {
			stage("registration_failed")
			writeError(w, http.StatusServiceUnavailable, codeContentRegistrationFailed)
			return
		}
	} else {
		// The code is a closed enumeration; never log the provider body.
		log.Printf("work egress invoke execution=%s outcome=%s code=%s sent=%t",
			presented.execution, result.Outcome, unknownReasonCode(executeErr), result.Sent)
	}
	stage("exchange_done")
	writeExchangeResult(w, result, executeErr, answerRefID, evidenceRefID)
}

// registerOutputs records the egress-written answer and receipt references in
// the content reference registry. The answer is what the control plane commits
// as the canonical successor; both rows are execution-bound and egress-written.
func (s *Server) registerOutputs(
	ctx context.Context, orgID string, binding ExecutionBinding,
	logicalKey string, result egress.ExchangeResult,
) error {
	if result.Content == nil || result.ContentRef == "" || result.ContentBytes <= 0 {
		return nil
	}
	answer := contentref.Reference{
		RefID:         result.Content.RefID,
		OrgID:         orgID,
		TaskID:        binding.TaskID,
		RunID:         binding.RunID,
		ExecutionID:   binding.ExecutionID,
		Kind:          contentref.KindAnswer,
		LogicalSlot:   "answer:" + binding.ExecutionID + ":" + logicalKey,
		ObjectVersion: "v1",
		ContentRef:    result.ContentRef,
		ContentHash:   result.Content.Hash,
		Bytes:         result.ContentBytes,
		WriterKind:    contentref.WriterEgress,
		SlotState:     contentref.SlotCommitted,
	}
	if err := s.references.Register(ctx, answer); err != nil {
		return err
	}
	if result.Receipt == nil || result.ReceiptContentRef == "" {
		return nil
	}
	// The receipt slot's hash is the canonical document hash; the registry
	// stores the body hash of the same object, so read and hash the body.
	body, err := s.store.Get(ctx, orgID, result.ReceiptContentRef)
	if err != nil || int64(len(body)) != result.ReceiptBytes {
		return errors.New("receipt_body_unavailable")
	}
	bodyHash, err := canonical.BodyHash(body)
	if err != nil {
		return errors.New("receipt_body_invalid")
	}
	receipt := contentref.Reference{
		RefID:         result.Receipt.Reference.RefID,
		OrgID:         orgID,
		TaskID:        binding.TaskID,
		RunID:         binding.RunID,
		ExecutionID:   binding.ExecutionID,
		Kind:          contentref.KindReceipt,
		LogicalSlot:   "receipt:" + binding.ExecutionID + ":" + logicalKey,
		ObjectVersion: "v1",
		ContentRef:    result.ReceiptContentRef,
		ContentHash:   bodyHash,
		Bytes:         result.ReceiptBytes,
		WriterKind:    contentref.WriterEgress,
		SlotState:     contentref.SlotCommitted,
	}
	return s.references.Register(ctx, receipt)
}

func deliveryFromBinding(orgID string, binding ExecutionBinding) authz.DeliveryRequest {
	return authz.DeliveryRequest{
		OrgID:       orgID,
		OperationID: binding.OperationID,
		AttemptID:   binding.AttemptID,
		ExecutionID: binding.ExecutionID,
		RequestHash: binding.RequestHash,
		RunFence:    binding.RunFence,
		HolderID:    binding.HolderID,
	}
}

// writeProviderResolveError maps providerctx enumeration failures to a status
// and the same enumeration code. Database text is never forwarded.
func writeProviderResolveError(w http.ResponseWriter, err error) {
	var providerErr *providerctx.Error
	if errors.As(err, &providerErr) {
		switch providerErr.Code {
		case providerctx.CodeProviderNotConfigured:
			writeError(w, http.StatusUnprocessableEntity, codeProviderNotConfigured)
			return
		case providerctx.CodeProviderCredentialRevoked:
			writeError(w, http.StatusUnprocessableEntity, codeProviderCredentialRevoked)
			return
		case providerctx.CodeProviderContextUnsupported:
			writeError(w, http.StatusUnprocessableEntity, codeProviderContextUnsupported)
			return
		case providerctx.CodeProviderContextUnavailable:
			writeError(w, http.StatusServiceUnavailable, codeProviderContextUnavailable)
			return
		}
	}
	writeError(w, http.StatusServiceUnavailable, codeProviderUnavailable)
}

// writeConsumeError maps a pre-send authorization command failure. A refusal
// is a controlled code and a conflict; an unreachable authorization backend
// is a 503. No error text is forwarded.
func writeConsumeError(w http.ResponseWriter, err error) {
	var remote *authz.RemoteError
	if errors.As(err, &remote) {
		if remote.Status >= http.StatusInternalServerError {
			writeError(w, http.StatusServiceUnavailable, codeGateUnavailable)
			return
		}
		if codeValuePattern.MatchString(remote.Code) {
			writeError(w, http.StatusConflict, remote.Code)
			return
		}
		writeError(w, http.StatusConflict, codeGateUnavailable)
		return
	}
	var authzErr *authz.Error
	if errors.As(err, &authzErr) && codeValuePattern.MatchString(authzErr.Code) {
		writeError(w, http.StatusConflict, authzErr.Code)
		return
	}
	writeError(w, http.StatusServiceUnavailable, codeGateUnavailable)
}

func wipe(secret []byte) {
	for i := range secret {
		secret[i] = 0
	}
}

// readCredential extracts the four credential headers. A missing, duplicated
// or malformed credential is a 401: the caller has not presented a usable
// identity, and the service deliberately does not say which part was wrong.
func readCredential(r *http.Request) (credential, bool) {
	authorization, ok := singleHeader(r, HeaderAuthorization)
	if !ok {
		return credential{}, false
	}
	scheme, token, ok := strings.Cut(authorization, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return credential{}, false
	}
	token = strings.TrimSpace(token)
	if !validToken(token) {
		return credential{}, false
	}

	org, ok := singleHeader(r, HeaderOrg)
	if !ok || !validOrg(org) {
		return credential{}, false
	}
	execution, ok := singleHeader(r, HeaderExecution)
	if !ok || !uuidPattern.MatchString(execution) {
		return credential{}, false
	}
	rawGeneration, ok := singleHeader(r, HeaderGeneration)
	if !ok || !generationPattern.MatchString(rawGeneration) {
		return credential{}, false
	}
	generation, err := strconv.Atoi(rawGeneration)
	if err != nil || generation < 1 {
		return credential{}, false
	}
	return credential{org: org, execution: execution, generation: generation, token: token}, true
}

// singleHeader returns a header only when exactly one value was sent. A
// repeated Authorization/org/execution header is ambiguous and refused.
func singleHeader(r *http.Request, name string) (string, bool) {
	values := r.Header.Values(name)
	if len(values) != 1 {
		return "", false
	}
	value := strings.TrimSpace(values[0])
	if value == "" {
		return "", false
	}
	return value, true
}

func validToken(token string) bool {
	if len(token) < 16 || len(token) > 512 {
		return false
	}
	return !strings.ContainsFunc(token, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	})
}

func validOrg(org string) bool {
	if org == "" || len(org) > 128 || strings.TrimSpace(org) != org {
		return false
	}
	return !strings.ContainsFunc(org, func(r rune) bool {
		return unicode.IsControl(r)
	})
}
