// Package capability is the F0-R4 runtime capability issuer and checker used
// by the control plane's internal execution-authorization module.
//
// A capability is an opaque bearer bound to one (organization, execution,
// audience, holder, generation) tuple. The plaintext token exists only in the
// issuer response and the child process's memory: the database stores the
// lowercase-hex SHA-256 digest and nothing else. Issuance and revocation are
// domain commands executed as work_worker with an explicit tenant context;
// authorization is an online check on every call and is never cached here
// (D4 §6.2 items 3-5).
//
// Errors carry an enumeration code only. They never echo the token, the token
// digest or the database statement, so a caller may log them safely.
package capability

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
)

const (
	// AudienceContent is the child-process content-proxy audience (port 8444).
	AudienceContent = "work-content"
	// AudienceEgress is the model-egress audience (port 8445).
	AudienceEgress = "work-egress"

	// tokenBytes is the CSPRNG size of the opaque bearer (D4 §6.2).
	tokenBytes = 32
	// maxTokenTTL is the issuance policy ceiling. The database additionally
	// clamps the stored expiry to the execution lease and hard deadline.
	maxTokenTTL = 30 * time.Second
)

// Error is an enumerated capability failure code.
type Error struct {
	Code string
}

func (e *Error) Error() string { return "capability: " + e.Code }

func codeError(code string) *Error { return &Error{Code: code} }

// Issuer issues, authorizes and revokes capabilities through the work_worker
// connection pool. It holds no local state and no authorization cache.
type Issuer struct {
	pool *pgxpool.Pool
}

func NewIssuer(pool *pgxpool.Pool) *Issuer {
	return &Issuer{pool: pool}
}

// Issue mints a new 32-byte opaque token for the current holder of the given
// execution and audience, stores only its SHA-256 hex digest, and returns the
// plaintext token plus the new generation. The plaintext must be delivered
// once over the private child-process channel and never persisted.
//
// ttl is clamped to the issuance policy ceiling (30s); the database further
// clamps the stored expiry to lease_until and hard_deadline, so issuance never
// extends the lease.
func (i *Issuer) Issue(
	ctx context.Context,
	orgID, executionID, holderID, audience string,
	ttl time.Duration,
) (token string, generation int, err error) {
	token, generation, _, err = i.IssueWithExpiry(ctx, orgID, executionID, holderID, audience, ttl)
	return token, generation, err
}

// IssueWithExpiry is Issue plus the expiry requested on the wire. The database
// clamps the stored expiry to the execution lease and hard deadline, so a
// caller that must report the effective lifetime has to clamp this value with
// the lease it already holds. No plaintext or digest is read back.
func (i *Issuer) IssueWithExpiry(
	ctx context.Context,
	orgID, executionID, holderID, audience string,
	ttl time.Duration,
) (token string, generation int, expiresAt time.Time, err error) {
	if orgID == "" || executionID == "" || holderID == "" {
		return "", 0, time.Time{}, codeError("invalid_request")
	}
	if audience != AudienceContent && audience != AudienceEgress {
		return "", 0, time.Time{}, codeError("invalid_request")
	}
	if ttl <= 0 {
		return "", 0, time.Time{}, codeError("invalid_request")
	}
	if ttl > maxTokenTTL {
		ttl = maxTokenTTL
	}
	if !i.usable() {
		return "", 0, time.Time{}, codeError("pool_required")
	}

	raw := make([]byte, tokenBytes)
	if _, readErr := rand.Read(raw); readErr != nil {
		return "", 0, time.Time{}, codeError("entropy_unavailable")
	}
	plaintext := base64.RawURLEncoding.EncodeToString(raw)
	digest := hashToken(plaintext)
	expiresAt = time.Now().Add(ttl)

	issueErr := workdb.WithWorkerOrgContext(ctx, i.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.issue_runtime_capability($1, $2, $3, $4, $5, $6)`,
			orgID, executionID, holderID, audience, digest, expiresAt,
		).Scan(&generation)
	})
	if issueErr != nil {
		return "", 0, time.Time{}, sanitize(issueErr)
	}
	return plaintext, generation, expiresAt, nil
}

// Authorize checks one presented bearer against trusted records. It returns
// false for every binding, state or liveness failure and never reports which
// check failed. The answer is never cached: every call reaches the database.
//
// A broken tenant context is an error (the caller's fault), not a denial.
func (i *Issuer) Authorize(
	ctx context.Context,
	orgID, executionID, audience string,
	generation int,
	token string,
) (bool, error) {
	if !i.usable() {
		return false, codeError("pool_required")
	}
	digest := hashToken(token)
	var allowed bool
	authErr := workdb.WithWorkerOrgContext(ctx, i.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.authorize_runtime_capability($1, $2, $3, $4, $5)`,
			orgID, executionID, audience, generation, digest,
		).Scan(&allowed)
	})
	if authErr != nil {
		return false, sanitize(authErr)
	}
	return allowed, nil
}

// Revoke invalidates every live generation of one execution. It is idempotent
// (the second call revokes nothing) and the audit trail records the call. The
// very next Authorize call observes the revocation; no sweeper is involved.
func (i *Issuer) Revoke(ctx context.Context, orgID, executionID, reason string) (int, error) {
	if orgID == "" || executionID == "" || reason == "" {
		return 0, codeError("invalid_request")
	}
	if !i.usable() {
		return 0, codeError("pool_required")
	}
	var revoked int
	revokeErr := workdb.WithWorkerOrgContext(ctx, i.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.revoke_runtime_capability($1, $2, $3)`,
			orgID, executionID, reason,
		).Scan(&revoked)
	})
	if revokeErr != nil {
		return 0, sanitize(revokeErr)
	}
	return revoked, nil
}

func (i *Issuer) usable() bool {
	return i != nil && i.pool != nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

var codePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)

// sanitize reduces any failure to an enumeration code. The original message is
// deliberately dropped: it could carry bound values, and the token digest must
// never appear in an error string.
func sanitize(err error) error {
	if err == nil {
		return nil
	}
	var dbErr *workdb.Error
	if errors.As(err, &dbErr) && codePattern.MatchString(dbErr.Code) {
		return codeError(dbErr.Code)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if code := messageCode(pgErr.Message); code != "" &&
			(pgErr.Code == "P0001" || pgErr.Code == "P0002" || pgErr.Code == "42501") {
			return codeError(code)
		}
		switch {
		case pgErr.Code == "42501":
			return codeError("permission_denied")
		case len(pgErr.Code) >= 2 && pgErr.Code[:2] == "22":
			return codeError("invalid_request")
		case len(pgErr.Code) >= 2 && pgErr.Code[:2] == "23":
			return codeError("capability_conflict")
		}
	}
	return codeError("capability_unavailable")
}

// messageCode keeps a leading snake_case code (before any ':') only.
func messageCode(message string) string {
	for index, r := range message {
		if r == ':' {
			message = message[:index]
			break
		}
	}
	if !codePattern.MatchString(message) {
		return ""
	}
	return message
}
