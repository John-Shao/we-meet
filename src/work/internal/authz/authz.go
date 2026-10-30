// Package authz is the internal execution-authorization boundary for the
// Node/Pi runtime parent and the model egress gateway.
//
// Those processes never connect to PostgreSQL. They reach a fixed whitelist of
// domain commands through this module, and the caller kind comes from the
// authenticated workload certificate, never from the request body.
package authz

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

type Kind string

const (
	// KindRuntimeParent is the Node parent process that owns one Run execution.
	KindRuntimeParent Kind = "runtime_parent"
	// KindEgress is the trusted model egress gateway.
	KindEgress Kind = "egress"
)

// Terminal receipt outcomes, spelled as the canonical receipt document does.
// The SQL layer stores a succeeded outcome as 'success'; the PG adapter
// translates at that boundary.
const (
	ReceiptSucceeded           = "succeeded"
	ReceiptRejectedNotExecuted = "rejected_not_executed"
)

const maxRequestBody = 64 << 10

type Caller struct {
	Kind       Kind
	WorkloadID string
}

// Verifier maps an authenticated client certificate to a workload identity.
// Unknown certificates must be rejected; a certificate may not select its own
// kind or workload ID.
type Verifier interface {
	Verify(ctx context.Context, certificate *x509.Certificate) (Caller, error)
}

var ErrUnknownWorkload = errors.New("unknown workload certificate")

type registryEntry struct {
	caller Caller
}

// RegistryVerifier accepts only explicitly registered certificate instances.
// Rotation is a registry update, not a request field.
type RegistryVerifier struct {
	entries map[string]registryEntry
}

func NewRegistryVerifier(entries map[string]Caller) (*RegistryVerifier, error) {
	if len(entries) == 0 {
		return nil, errors.New("at least one workload certificate is required")
	}
	registry := &RegistryVerifier{entries: make(map[string]registryEntry, len(entries))}
	for fingerprint, caller := range entries {
		normalized := normalizeFingerprint(fingerprint)
		if len(normalized) != 64 {
			return nil, errors.New("workload fingerprints must be sha256 hex")
		}
		if caller.Kind != KindRuntimeParent && caller.Kind != KindEgress {
			return nil, errors.New("unsupported workload kind")
		}
		if strings.TrimSpace(caller.WorkloadID) == "" || len(caller.WorkloadID) > 128 {
			return nil, errors.New("workload id is required")
		}
		registry.entries[normalized] = registryEntry{caller: caller}
	}
	return registry, nil
}

func (v *RegistryVerifier) Verify(_ context.Context, certificate *x509.Certificate) (Caller, error) {
	if certificate == nil {
		return Caller{}, ErrUnknownWorkload
	}
	digest := sha256.Sum256(certificate.Raw)
	entry, ok := v.entries[hex.EncodeToString(digest[:])]
	if !ok {
		return Caller{}, ErrUnknownWorkload
	}
	return entry.caller, nil
}

// LoadRegistry reads a JSON workload registry:
//
//	{"workloads":[{"fingerprint":"<sha256 hex>","kind":"runtime_parent","workload_id":"parent-a"}]}
//
// The file lists certificate instances explicitly; there is no wildcard and no
// self-declared role.
func LoadRegistry(body []byte) (*RegistryVerifier, error) {
	var document struct {
		Workloads []struct {
			Fingerprint string `json:"fingerprint"`
			Kind        Kind   `json:"kind"`
			WorkloadID  string `json:"workload_id"`
		} `json:"workloads"`
	}
	if err := decodeStrict(body, &document); err != nil {
		return nil, errors.New("workload registry is invalid")
	}
	if len(document.Workloads) == 0 {
		return nil, errors.New("workload registry is empty")
	}
	entries := make(map[string]Caller, len(document.Workloads))
	for _, workload := range document.Workloads {
		key := normalizeFingerprint(workload.Fingerprint)
		if _, duplicate := entries[key]; duplicate {
			return nil, errors.New("workload registry repeats a fingerprint")
		}
		entries[key] = Caller{Kind: workload.Kind, WorkloadID: workload.WorkloadID}
	}
	return NewRegistryVerifier(entries)
}

func normalizeFingerprint(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, ":", "")
	return value
}

// Error is a command failure with an enumeration code. The message must stay
// free of task text, credentials and SQL detail.
type Error struct {
	Code string
}

func (e *Error) Error() string { return e.Code }

func Fail(code string) error { return &Error{Code: code} }

// RuntimeParentCommands are the only commands a Run's parent process may call.
// The holder ID is minted by this module and bound to the authenticated
// workload; the parent cannot choose or reuse another workload's holder.
type RuntimeParentCommands interface {
	ClaimRuntimeExecution(ctx context.Context, caller Caller, request ExecutionRequest, holderID string) (ExecutionLease, error)
	RenewRuntimeExecution(ctx context.Context, caller Caller, request ExecutionRequest) (ExecutionLease, error)
	IssueRuntimeCapability(ctx context.Context, caller Caller, request IssueCapabilityRequest) (IssuedCapability, error)
}

// EgressCommands are the only commands the trusted egress gateway may call.
type EgressCommands interface {
	ConsumeDispatchDelivery(ctx context.Context, caller Caller, request DeliveryRequest) (ConsumeDecision, error)
	ConsumeByExecution(ctx context.Context, caller Caller, request ExecutionConsumeRequest) (ConsumeDecision, error)
	AttachDispatchReceipt(ctx context.Context, caller Caller, request ReceiptRequest) error
}

// ExecutionRequest carries identifiers only. None of them authorizes the call.
type ExecutionRequest struct {
	OrgID        string `json:"org_id"`
	ExecutionID  string `json:"execution_id"`
	HolderID     string `json:"holder_id,omitempty"`
	HeartbeatSeq int64  `json:"heartbeat_seq,omitempty"`
}

func newHolderID(caller Caller) (string, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return caller.WorkloadID + ":" + hex.EncodeToString(nonce), nil
}

func holderBelongsTo(caller Caller, holderID string) bool {
	prefix, _, found := strings.Cut(holderID, ":")
	return found && prefix == caller.WorkloadID
}

// IssueCapabilityRequest is the signed thin wire for runtime capability
// issuance. The body names only the execution and the requested audience; the
// organization comes from the tenant-scoped command call and the holder is
// re-read from the execution row. The audience must match the fragment mode.
type IssueCapabilityRequest struct {
	OrgID       string `json:"org_id"`
	ExecutionID string `json:"execution_id"`
	Audience    string `json:"audience"`
}

// IssuedCapability is the one-time issuance response. Token is plaintext and
// must be delivered only over the private child bootstrap channel; it is never
// persisted, logged or echoed in an error.
type IssuedCapability struct {
	Token      string    `json:"token"`
	Generation int       `json:"generation"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type ExecutionLease struct {
	ExecutionID string     `json:"execution_id"`
	HolderID    string     `json:"holder_id"`
	State       string     `json:"state"`
	LeaseUntil  *time.Time `json:"lease_until,omitempty"`
}

// DeliveryRequest is what the egress gateway received from the Run's parent.
// The identifiers prove nothing on their own; the gate command re-reads the
// database state before it decides whether this call may send.
type DeliveryRequest struct {
	OrgID       string `json:"org_id"`
	OperationID string `json:"operation_id"`
	AttemptID   string `json:"attempt_id"`
	ExecutionID string `json:"execution_id"`
	RequestHash string `json:"request_hash"`
	RunFence    int64  `json:"run_fence"`
	HolderID    string `json:"holder_id"`
}

// ExecutionConsumeRequest is the signed thin wire from the egress model-invoke
// endpoint: the caller names only the fragment and the request hash. Operation,
// attempt, holder, fence and mode are re-read from the locked execution by the
// database command; a body that tries to supply them is rejected as unknown.
type ExecutionConsumeRequest struct {
	OrgID       string `json:"org_id"`
	ExecutionID string `json:"execution_id"`
	RequestHash string `json:"request_hash"`
}

type ConsumeDecision struct {
	// Won is true only for the caller whose gate insert committed. Every retry,
	// conflict or lookup receives observed instead and must not send.
	Won               bool   `json:"won"`
	GateState         string `json:"gate_state"`
	GatewayInvocation string `json:"gateway_invocation_id,omitempty"`
	ReceiptSlotID     string `json:"receipt_slot_id,omitempty"`
}

type ReceiptRequest struct {
	OrgID             string `json:"org_id"`
	OperationID       string `json:"operation_id"`
	ExecutionID       string `json:"execution_id"`
	AttemptID         string `json:"attempt_id"`
	ReceiptSlotID     string `json:"receipt_slot_id"`
	ReceiptRef        string `json:"receipt_ref"`
	ReceiptHash       string `json:"receipt_hash"`
	ReceiptResult     string `json:"receipt_result"`
	ProviderRequestID string `json:"provider_request_id,omitempty"`
}

type Server struct {
	verifier Verifier
	parent   RuntimeParentCommands
	egress   EgressCommands
}

func NewServer(verifier Verifier, parent RuntimeParentCommands, egress EgressCommands) (*Server, error) {
	if verifier == nil {
		return nil, errors.New("authz verifier is required")
	}
	if parent == nil || egress == nil {
		return nil, errors.New("authz command implementations are required")
	}
	return &Server{verifier: verifier, parent: parent, egress: egress}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/v1/commands/{command}", s.loggedCommand(s.handle))
	return mux
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(body []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(body)
}

// loggedCommand emits command, status and duration only. Tokens, holders and
// body fields are never logged.
func (s *Server) loggedCommand(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w}
		next(recorder, r)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		log.Printf("work authz command=%s status=%d elapsed_ms=%d",
			r.PathValue("command"), status, time.Since(started).Milliseconds())
	}
}

type commandSpec struct {
	kind  Kind
	allow func(*Server, context.Context, Caller, []byte) (any, error)
}

func (s *Server) commandSpecs() map[string]commandSpec {
	return map[string]commandSpec{
		"claim_runtime_execution": {
			kind: KindRuntimeParent,
			allow: func(server *Server, ctx context.Context, caller Caller, body []byte) (any, error) {
				var request ExecutionRequest
				if err := decodeStrict(body, &request); err != nil {
					return nil, Fail("invalid_request")
				}
				if !validID(request.OrgID) || !validID(request.ExecutionID) || request.HolderID != "" {
					return nil, Fail("invalid_request")
				}
				holderID, err := newHolderID(caller)
				if err != nil {
					return nil, err
				}
				lease, err := server.parent.ClaimRuntimeExecution(ctx, caller, request, holderID)
				if err != nil {
					return nil, err
				}
				lease.HolderID = holderID
				return lease, nil
			},
		},
		"renew_runtime_execution": {
			kind: KindRuntimeParent,
			allow: func(server *Server, ctx context.Context, caller Caller, body []byte) (any, error) {
				var request ExecutionRequest
				if err := decodeStrict(body, &request); err != nil {
					return nil, Fail("invalid_request")
				}
				if !validID(request.OrgID) || !validID(request.ExecutionID) ||
					request.HolderID == "" || request.HeartbeatSeq <= 0 {
					return nil, Fail("invalid_request")
				}
				if !holderBelongsTo(caller, request.HolderID) {
					return nil, Fail("holder_not_owned")
				}
				return server.parent.RenewRuntimeExecution(ctx, caller, request)
			},
		},
		"issue_capability": {
			kind: KindRuntimeParent,
			allow: func(server *Server, ctx context.Context, caller Caller, body []byte) (any, error) {
				var request IssueCapabilityRequest
				if err := decodeStrict(body, &request); err != nil {
					return nil, Fail("invalid_request")
				}
				if !validID(request.OrgID) || !validID(request.ExecutionID) ||
					(request.Audience != "work-content" && request.Audience != "work-egress") {
					return nil, Fail("invalid_request")
				}
				return server.parent.IssueRuntimeCapability(ctx, caller, request)
			},
		},
		"consume_dispatch_delivery": {
			kind: KindEgress,
			allow: func(server *Server, ctx context.Context, caller Caller, body []byte) (any, error) {
				var request DeliveryRequest
				if err := decodeStrict(body, &request); err != nil {
					return nil, Fail("invalid_request")
				}
				if !validID(request.OrgID) || !validID(request.OperationID) ||
					request.AttemptID == "" || request.ExecutionID == "" ||
					request.RequestHash == "" || request.RunFence <= 0 || request.HolderID == "" {
					return nil, Fail("invalid_request")
				}
				return server.egress.ConsumeDispatchDelivery(ctx, caller, request)
			},
		},
		"consume_dispatch_by_execution": {
			kind: KindEgress,
			allow: func(server *Server, ctx context.Context, caller Caller, body []byte) (any, error) {
				var request ExecutionConsumeRequest
				if err := decodeStrict(body, &request); err != nil {
					return nil, Fail("invalid_request")
				}
				if !validID(request.OrgID) || !validID(request.ExecutionID) ||
					request.RequestHash == "" {
					return nil, Fail("invalid_request")
				}
				return server.egress.ConsumeByExecution(ctx, caller, request)
			},
		},
		"attach_dispatch_receipt": {
			kind: KindEgress,
			allow: func(server *Server, ctx context.Context, caller Caller, body []byte) (any, error) {
				var request ReceiptRequest
				if err := decodeStrict(body, &request); err != nil {
					return nil, Fail("invalid_request")
				}
				if !validID(request.OrgID) || !validID(request.OperationID) ||
					request.ExecutionID == "" || request.AttemptID == "" ||
					!validID(request.ReceiptSlotID) || request.ReceiptRef == "" ||
					request.ReceiptHash == "" ||
					(request.ReceiptResult != ReceiptSucceeded && request.ReceiptResult != ReceiptRejectedNotExecuted) {
					return nil, Fail("invalid_request")
				}
				return struct{}{}, server.egress.AttachDispatchReceipt(ctx, caller, request)
			},
		},
	}
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	caller, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	spec, ok := s.commandSpecs()[r.PathValue("command")]
	if !ok {
		writeError(w, http.StatusNotFound, "unknown_command")
		return
	}
	if caller.Kind != spec.kind {
		writeError(w, http.StatusForbidden, "caller_not_permitted")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "invalid_request")
		return
	}
	result, err := spec.allow(s, r.Context(), caller, body)
	if err != nil {
		var authzError *Error
		if errors.As(err, &authzError) && authzError.Code != "" {
			writeError(w, http.StatusConflict, authzError.Code)
			return
		}
		// Never echo an unexpected error: it may contain SQL text or user data.
		writeError(w, http.StatusInternalServerError, "internal_error")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (Caller, bool) {
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		writeError(w, http.StatusUnauthorized, "client_certificate_required")
		return Caller{}, false
	}
	caller, err := s.verifier.Verify(r.Context(), r.TLS.PeerCertificates[0])
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized_caller")
		return Caller{}, false
	}
	return caller, true
}

func decodeStrict(body []byte, target any) error {
	if err := rejectDuplicateKeys(body); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("trailing data")
	}
	return nil
}

// rejectDuplicateKeys makes ambiguous input explicit. encoding/json keeps the
// last duplicate, which would let a request smuggle two values for one field.
func rejectDuplicateKeys(body []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := walkJSON(decoder, 0); err != nil {
		return err
	}
	return nil
}

func walkJSON(decoder *json.Decoder, depth int) error {
	if depth > 64 {
		return errors.New("document is too deeply nested")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("object key must be a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return errors.New("duplicate object key")
			}
			seen[key] = struct{}{}
			if err := walkJSON(decoder, depth+1); err != nil {
				return err
			}
		}
		_, err := decoder.Token()
		return err
	case '[':
		for decoder.More() {
			if err := walkJSON(decoder, depth+1); err != nil {
				return err
			}
		}
		_, err := decoder.Token()
		return err
	default:
		return errors.New("unexpected delimiter")
	}
}

func validID(value string) bool {
	return value != "" && len(value) <= 128 && !strings.ContainsRune(value, '\x00') &&
		strings.TrimSpace(value) == value
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"code": code})
}
