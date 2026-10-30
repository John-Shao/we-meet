// Package egressservice is the F0-R5 trusted model-egress listener on the
// work-egress:8445 boundary (D4 §6.3, §7).
//
// One route is served:
//
//	POST /runtime/v1/model/invoke
//	  Authorization: Bearer <work-egress capability>
//	  X-Work-Org, X-Work-Execution, X-Work-Generation
//	  {"executionId":"<uuid>",
//	   "requestRef":{"refId":"<uuid>","hash":"sha256:<64 hex>"},
//	   "requestHash":"sha256:<64 hex>"}
//
// requestRef may also be the bare uuid; the object form is what the Node child
// sends. Both are closed shapes and the optional repeated hash must agree with
// requestHash.
//
// The body is the signed thin wire. It names only the execution, the frozen
// model_request content reference and that reference's document hash.
// Everything else is derived server-side from trusted records:
//
//   - operation, attempt, holder and run fence come from the execution row;
//   - the org, task, run, snapshot, runtime version, logical key, route,
//     parameters and reference graph come from the model_request document;
//   - input, template and prior-receipt objects are re-read through the
//     content-reference registry and the Content Store and their bytes are
//     hash-verified;
//   - the provider endpoint and managed_key secret come from providerctx;
//   - the answerRefId and rejectionEvidenceRefId are minted here.
//
// The listener requires mandatory mTLS and then re-checks a work-egress opaque
// bearer online on every request; a positive answer is never cached. The body
// is parsed strictly: unknown fields, duplicate keys, invalid UTF-8,
// non-integer numbers, trailing data, malformed identifiers or hashes are
// refused with {"code":"..."} only. Nothing reaches the provider before every
// hash and binding check passed.
//
// # Message assembly
//
// Message assembly is deterministic and fixed by D4 §8.1 item 5. For one
// model_request document the trusted text sequence is:
//
//  1. one system message carrying the template bytes decoded as UTF-8 text,
//     omitted entirely when the document has no template reference;
//  2. one user message carrying the input bytes decoded as UTF-8 text;
//  3. one assistant message per priorReceipts entry, in document order, each
//     carrying the public answer bytes that the referenced trusted succeeded
//     receipt points at, decoded as UTF-8 text.
//
// The order is never sorted, trimmed, normalised or deduplicated. Roles are
// exactly "system", "user" and "assistant". Invalid UTF-8, an empty input, a
// prior receipt that is not a succeeded receipt, and an assembly whose total
// bytes exceed canonical.MaxBodyBytes are refused before the gate is
// consumed.
//
// # Send boundary
//
// The service consumes exactly once through authz.ConsumeByExecution, which
// derives operation/attempt/holder/fence from the locked execution; only a won
// decision may send. egress.Exchange then performs the single provider call,
// stores the answer and the trusted receipt, and the Gate adapter attaches the
// receipt slot minted by the authorization service. A retry of the same thin
// wire observes the existing gate and never sends again.
//
// # Responses
//
// Responses carry only the exchange outcome, gate state, request hash, receipt
// coordinates (refId/hash/contentRef), answer coordinates (refId/hash/bytes),
// the minted answer and rejection-evidence reference ids, usage and the
// provider request id. Message text, the bearer token, the provider secret and
// any provider raw body are never echoed or logged.
package egressservice

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"regexp"

	"github.com/we-meet/work/internal/authz"
	"github.com/we-meet/work/internal/capability"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	"github.com/we-meet/work/internal/egress"
	"github.com/we-meet/work/internal/providerctx"
)

const (
	// DefaultListenAddr is the signed work-egress listener address.
	DefaultListenAddr = "127.0.0.1:8445"

	// MaxRequestBodyBytes is the signed JSON metadata ceiling for this
	// listener (16 KiB). The thin body has three fields; a larger body is
	// refused before any handler work.
	MaxRequestBodyBytes int64 = 16 << 10

	// InvokePath is the signed thin-wire route.
	InvokePath = "/runtime/v1/model/invoke"
)

// Wire header names of the work-egress contract. The org/execution/generation
// triple only names the capability binding; it never authorizes anything by
// itself.
const (
	HeaderAuthorization = "Authorization"     // "Bearer <opaque token>"
	HeaderOrg           = "X-Work-Org"        // organization id
	HeaderExecution     = "X-Work-Execution"  // runtime execution uuid
	HeaderGeneration    = "X-Work-Generation" // capability generation
)

// Enumeration codes. Every failure is one of these; original error text is
// dropped because it may carry bound values, provider bodies or SQL text.
const (
	codeCapabilityInvalid          = "capability_invalid"
	codeAuthorizationUnavailable   = "authorization_unavailable"
	codeInvalidRequest             = "invalid_request"
	codeRequestTooLarge            = "request_too_large"
	codeRequestHashMismatch        = "request_hash_mismatch"
	codeContentReferenceNotFound   = "content_reference_not_found"
	codeContentReferenceUnavail    = "content_reference_unavailable"
	codeContentKindMismatch        = "content_kind_mismatch"
	codeContentUnavailable         = "content_unavailable"
	codeContentIntegrityFailed     = "content_integrity_failed"
	codeModelRequestInvalid        = "model_request_invalid"
	codeRequestBindingMismatch     = "request_binding_mismatch"
	codeExecutionNotExecutable     = "execution_not_executable"
	codeContentRegistrationFailed  = "content_registration_failed"
	codeExecutionBindingUnavail    = "execution_binding_unavailable"
	codePriorReceiptUnusable       = "prior_receipt_unusable"
	codeMessageInvalid             = "message_invalid"
	codeAnswerRefUnavailable       = "answer_ref_generation_failed"
	codeProviderModeUnsupported    = "provider_mode_unsupported"
	codeProviderNotConfigured      = "provider_not_configured"
	codeProviderCredentialRevoked  = "provider_credential_revoked"
	codeProviderContextUnsupported = "provider_context_unsupported"
	codeProviderContextUnavailable = "provider_context_unavailable"
	codeProviderUnavailable        = "provider_unavailable"
	codeProviderMismatch           = "provider_mismatch"
	codeGateUnavailable            = "gate_unavailable"
	codeGateProtocol               = "gate_protocol_violation"
	codeDispatchNotWon             = "dispatch_not_won"
	codeReceiptAttachFailed        = "receipt_attach_failed"
	codeReceiptNotPersisted        = "receipt_not_persisted"
	codeContentStoreFailed         = "content_store_failed"
	codeReceiptInvalid             = "receipt_invalid"
	codeUnknownOutcome             = "provider_unknown"
)

// audience is the only capability audience this listener accepts.
const audience = capability.AudienceEgress

// Authorizer is the online capability check. *capability.Issuer implements it.
// A false answer denies; an error means the authorization backend could not be
// read and must also deny.
type Authorizer interface {
	Authorize(ctx context.Context, orgID, executionID, audience string, generation int, token string) (bool, error)
}

// ProviderResolver resolves an organization's active provider context.
// *providerctx.Resolver implements it.
type ProviderResolver interface {
	Resolve(ctx context.Context, orgID string) (providerctx.Context, error)
}

// EgressCommands are the two authorization commands this service may call.
// *authz.Client implements them in production; the client authenticates with
// the egress workload certificate. ConsumeByExecution derives every binding
// from the locked execution, and Attach records the receipt for that gate.
type EgressCommands interface {
	ConsumeByExecution(ctx context.Context, request authz.ExecutionConsumeRequest) (authz.ConsumeDecision, error)
	Attach(ctx context.Context, request authz.ReceiptRequest) error
}

// ReferenceResolver resolves one content reference by organization and id and
// registers the egress-written answer/receipt references. *contentref.Registry
// implements it.
type ReferenceResolver interface {
	Resolve(ctx context.Context, orgID, refID string) (contentref.Reference, error)
	Register(ctx context.Context, reference contentref.Reference) error
}

// ExecutionBindings derives the send tuple the thin wire does not carry.
// *PGBindings implements it by reading the authoritative execution row as
// work_worker under the tenant context.
type ExecutionBindings interface {
	Resolve(ctx context.Context, orgID, executionID string) (ExecutionBinding, error)
}

// ProviderFactory builds the single-shot transport for one provider context.
// The endpoint comes from providerctx, never from the request; the secret is
// only placed in the provider Authorization header.
type ProviderFactory func(endpoint, secret string) (egress.Provider, error)

// HTTPProviderFactory builds the reference openai-compatible provider. The
// captured secret is never logged, stored or returned in an error.
func HTTPProviderFactory(endpoint, secret string) (egress.Provider, error) {
	return egress.NewHTTPProvider(egress.HTTPProviderConfig{
		Endpoint: endpoint,
		Credential: func(context.Context, string) (string, error) {
			return secret, nil
		},
	})
}

// Config holds the listener settings. The certificate and key are files on the
// control-plane host; the private key never enters a pool Pod. Callers are
// authenticated by the work-egress bearer, not by a client certificate
// (D4 §6.3).
//
// GatewayID is the egress workload's authenticated writer identity (uuid)
// recorded as writerGatewayId in trusted receipts (§8.1). It is derived from
// the egress workload certificate by GatewayIDFromCertificateFile and is never
// read from a request.
type Config struct {
	ListenAddr string
	CertFile   string
	KeyFile    string
	GatewayID  string
}

// Dependencies are the trusted collaborators of the listener. All are
// required; none is reachable with caller-supplied addresses or credentials.
type Dependencies struct {
	Authorizer Authorizer
	Providers  ProviderResolver
	Commands   EgressCommands
	References ReferenceResolver
	Executions ExecutionBindings
	Content    content.Store
	Factory    ProviderFactory
}

// Server is one work-egress listener. It holds no tokens, no provider secret
// and no authorization cache.
type Server struct {
	config     Config
	authorizer Authorizer
	providers  ProviderResolver
	commands   EgressCommands
	references ReferenceResolver
	executions ExecutionBindings
	store      content.Store
	factory    ProviderFactory
}

// New validates the dependencies and returns a listener-bound server. TLS
// material is loaded by ListenAndServe so a bad configuration stops startup.
func New(config Config, deps Dependencies) (*Server, error) {
	if deps.Authorizer == nil || deps.Providers == nil || deps.Commands == nil ||
		deps.References == nil || deps.Executions == nil || deps.Content == nil ||
		deps.Factory == nil {
		return nil, errors.New("egressservice: authorizer, provider resolver, egress commands, reference registry, execution bindings, content store and provider factory are required")
	}
	if !uuidPattern.MatchString(config.GatewayID) {
		return nil, errors.New("egressservice: gateway id must be a uuid")
	}
	if config.ListenAddr == "" {
		config.ListenAddr = DefaultListenAddr
	}
	return &Server{
		config:     config,
		authorizer: deps.Authorizer,
		providers:  deps.Providers,
		commands:   deps.Commands,
		references: deps.References,
		executions: deps.Executions,
		store:      deps.Content,
		factory:    deps.Factory,
	}, nil
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// GatewayIDFromCertificateFile derives the stable uuid-shaped writer identity
// of the egress workload from its registered leaf certificate. §8.1 requires
// writerGatewayId to come from the authenticated service identity, not from a
// request field; this process presents that certificate to the authorization
// service on every gate call.
func GatewayIDFromCertificateFile(path string) (string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("egressservice: read egress certificate")
	}
	return GatewayIDFromCertificatePEM(body)
}

// GatewayIDFromCertificatePEM parses the first certificate in body and derives
// the uuid-shaped identity from its DER encoding.
func GatewayIDFromCertificatePEM(body []byte) (string, error) {
	for block, rest := pem.Decode(body); block != nil; block, rest = pem.Decode(rest) {
		if block.Type != "CERTIFICATE" {
			continue
		}
		certificate, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return "", errors.New("egressservice: parse egress certificate")
		}
		return GatewayIDFromDER(certificate.Raw), nil
	}
	return "", errors.New("egressservice: no certificate in egress certificate file")
}

// GatewayIDFromDER hashes the certificate DER into a uuid-shaped identifier
// (version 5 nibble, RFC 4122 variant). It is deterministic across restarts so
// receipts written by the same workload certificate share one writer id.
func GatewayIDFromDER(der []byte) string {
	sum := sha256.Sum256(der)
	var id [16]byte
	copy(id[:], sum[:16])
	id[6] = (id[6] & 0x0f) | 0x50
	id[8] = (id[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(id[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", encoded[0:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:32])
}
