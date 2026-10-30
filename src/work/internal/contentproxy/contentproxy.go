// Package contentproxy is the F0-R5 content proxy on the internal
// work-control-internal:8444 listener (D4 §6.3, D1 §5.5).
//
// The listener is separate from capability issuance. It authenticates the
// caller with mandatory mTLS and then with an opaque work-content bearer that
// internal/capability issued to that execution. Every request re-checks the
// bearer online through work.authorize_runtime_capability: token digest,
// audience, generation, holder/execution/org/task/run/fence, mode, lease, hard
// deadline and Run/Task tombstone are all read from trusted records at call
// time. A positive answer is never cached, and an unavailable authorization
// backend or database is a denial (503), never a bypass.
//
// Only bound reads are implemented:
//
//   - GET /internal/v1/content/{refId}
//
// with headers Authorization: Bearer <token>, X-Work-Org, X-Work-Execution and
// X-Work-Generation. After the online authorization the proxy resolves the
// reference through internal/contentref, refuses a reference that is not bound
// to the presented execution, reads the object through content.Store and
// verifies the stored byte count and SHA-256 digest before writing any byte to
// the caller.
//
// The checkpoint-candidate write route (POST /internal/v1/checkpoints) is
// deliberately absent. Migration 0012 added the runtime_child writer and the
// reserved -> committed slot state, but the write route also needs a defined
// reference-graph authorisation (which template/input refs a child may bind)
// before it can accept bytes; without it the proxy fails closed rather than
// letting a child choose its own slots. Only bound reads are served today.
//
// Errors are written as {"code":"..."} only. The proxy never echoes the
// reference id, content bytes, bearer token or database text, and never logs a
// request body.
package contentproxy

import (
	"context"
	"errors"

	"github.com/we-meet/work/internal/capability"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
)

const (
	// DefaultListenAddr is the signed work-control-internal content proxy port.
	DefaultListenAddr = "127.0.0.1:8444"

	// MaxRequestBodyBytes is the signed candidate body ceiling (256 KiB). The
	// proxy enforces it on the listener even though no accepting write route
	// exists yet.
	MaxRequestBodyBytes int64 = 256 << 10
)

// Wire header names of the content-proxy contract. The org/execution/generation
// triple only names the capability binding; it never becomes an authorization
// context on its own.
const (
	HeaderAuthorization = "Authorization"     // "Bearer <opaque token>"
	HeaderOrg           = "X-Work-Org"        // organization id
	HeaderExecution     = "X-Work-Execution"  // runtime execution uuid
	HeaderGeneration    = "X-Work-Generation" // capability generation
	HeaderRefID         = "X-Work-Ref-Id"     // preallocated candidate ref uuid
	HeaderLogicalSlot   = "X-Work-Logical-Slot"
	HeaderContentHash   = "X-Work-Content-Hash"
)

// Response metadata headers. They carry the immutable binding that was read
// and verified, never a new object location or grant.
const (
	headerContentKind   = "X-Work-Content-Kind"
	headerContentHash   = "X-Work-Content-Hash"
	headerContentBytes  = "X-Work-Content-Bytes"
	headerObjectVersion = "X-Work-Object-Version"
)

// Enumeration codes. Every failure is one of these; the original error text is
// dropped because it may carry bound values, object references or SQL text.
const (
	codeCapabilityInvalid           = "capability_invalid"
	codeAuthorizationUnavailable    = "authorization_unavailable"
	codeContentAccessDenied         = "content_access_denied"
	codeContentReferenceNotFound    = "content_reference_not_found"
	codeContentReferenceUnavailable = "content_reference_unavailable"
	codeContentUnavailable          = "content_unavailable"
	codeContentIntegrityFailed      = "content_integrity_failed"
	codeInvalidRequest              = "invalid_request"
	codeRequestTooLarge             = "request_too_large"
	codeSlotConflict                = "content_slot_conflict"
	codeHashMismatch                = "content_hash_mismatch"
)

// Authorizer is the online capability check. *capability.Issuer implements it.
// A false answer denies; an error means the authorization backend could not be
// read and must also deny.
type Authorizer interface {
	Authorize(ctx context.Context, orgID, executionID, audience string, generation int, token string) (bool, error)
}

// References resolves live content-reference metadata.
// *contentref.Registry implements it.
type References interface {
	Resolve(ctx context.Context, orgID, refID string) (contentref.Reference, error)
	Reserve(ctx context.Context, orgID, refID, executionID string, kind contentref.Kind, logicalSlot string) error
	Commit(ctx context.Context, orgID, refID, contentRef, contentHash string, bytes int64) error
}

// Reader reads immutable content objects. *content.Local / content.Store
// implement it.
type Reader interface {
	Get(ctx context.Context, orgID, contentRef string) ([]byte, error)
	Put(ctx context.Context, orgID string, plaintext []byte) (content.Ref, error)
}

// Config holds the listener settings. The certificate and key are files on the
// control-plane host; the private key never enters a pool Pod. Callers are
// authenticated by the work-content bearer, not by a client certificate
// (D4 §6.3).
type Config struct {
	ListenAddr string
	CertFile   string
	KeyFile    string
}

// Server is one content-proxy listener. It holds no tokens and no
// authorization cache.
type Server struct {
	config     Config
	authorizer Authorizer
	references References
	store      Reader
}

// New validates the dependencies and returns a listener-bound server. TLS
// material is loaded by ListenAndServe so a bad configuration stops startup.
func New(config Config, authorizer Authorizer, references References, store Reader) (*Server, error) {
	if authorizer == nil || references == nil || store == nil {
		return nil, errors.New("contentproxy: authorizer, reference registry and content store are required")
	}
	if config.ListenAddr == "" {
		config.ListenAddr = DefaultListenAddr
	}
	return &Server{
		config:     config,
		authorizer: authorizer,
		references: references,
		store:      store,
	}, nil
}

// Audience is the only capability audience this listener accepts.
const audience = capability.AudienceContent
