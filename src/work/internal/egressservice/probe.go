package egressservice

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"time"

	"github.com/we-meet/work/internal/egress"
	"github.com/we-meet/work/internal/modelparams"
	"github.com/we-meet/work/internal/providerctx"
)

// ProbePath is the second and only other route on this listener. It exists because
// setProviderConfig owes a pre-save connectivity check ("保存前网关会发一次最小真实请求做
// 连通探测，失败不生效", contract r0a-openapi-v1.yaml:523-547) and this process is the only
// one allowed to dial a provider. Unlike InvokePath it is bound to a one-shot
// administration grant rather than a dispatch gate, and it writes no content object, no
// receipt and no usage row.
const ProbePath = "/runtime/v1/provider-probe"

const (
	// probeTimeout bounds one connectivity check. It is deliberately far shorter than
	// invokeTimeout, but not small: a healthy endpoint can take tens of seconds to
	// answer, and a stingy deadline would report a working configuration as unknown.
	probeTimeout     = 2 * time.Minute
	probeMaxBody     = 8 << 10
	probeInputText   = "Reply with exactly: OK"
	codeGrantBad     = "probe_grant_invalid"
	codeGrantUnavail = "provider_context_unavailable"
	codeGrantRefused = "provider_context_unsupported"
	codeBodyTooLarge = "probe_request_too_large"
)

type probeRequest struct {
	OrgID   string `json:"org_id"`
	GrantID string `json:"grant_id"`
	Token   string `json:"token"`
}

// probeReply carries no provider body, no credential and no endpoint: the caller
// already named the endpoint it asked about, and the answer is a verdict.
type probeReply struct {
	Outcome   string `json:"outcome"`
	Code      string `json:"code,omitempty"`
	ElapsedMS int64  `json:"elapsed_ms"`
}

// ProbeGrants claims the one-shot administration grant and returns the candidate
// provider context. *providerctx.Probe implements it in production. Nothing here holds
// or derives a provider secret, and no claim is cached.
type ProbeGrants interface {
	Claim(ctx context.Context, orgID, grantID, token string) (providerctx.Context, error)
}

var probeTokenPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// handleProbe answers one connectivity question.
//
// probeMaxOutputTokens comes from the signed model defaults rather than a small number,
// because the adapter only calls a 2xx answer a success when finish_reason is "stop": a
// stingy budget makes a healthy endpoint answer with "length", and a working
// configuration then probes as unknown. That misread is the same one that cost the E8
// golden runs before the default moved to 4096.
func (s *Server) handleProbe(w http.ResponseWriter, r *http.Request) {
	started := time.Now()

	var request probeRequest
	limited := http.MaxBytesReader(w, r.Body, probeMaxBody)
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusUnauthorized, codeGrantBad)
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeError(w, http.StatusUnauthorized, codeGrantBad)
		return
	}
	if !bindingIDPattern.MatchString(request.OrgID) ||
		!uuidPattern.MatchString(request.GrantID) ||
		!probeTokenPattern.MatchString(request.Token) {
		writeError(w, http.StatusUnauthorized, codeGrantBad)
		return
	}

	candidate, err := s.prober.Claim(r.Context(), request.OrgID, request.GrantID, request.Token)
	if err != nil {
		writeProbeClaimError(w, err)
		return
	}
	// sts_role carries no secret to dial with. The grant could only ever be minted over
	// a managed_key credential - work.issue_provider_probe_grant is reached from the API
	// path that checks the mode - so a row saying otherwise is refused rather than
	// probed and reported as broken.
	if candidate.Mode != "managed_key" || len(candidate.Secret) == 0 {
		writeJSON(w, http.StatusOK, probeReply{
			Outcome:   "refused",
			Code:      codeGrantRefused,
			ElapsedMS: time.Since(started).Milliseconds(),
		})
		return
	}

	provider, err := s.factory(candidate.Endpoint, string(candidate.Secret))
	if err != nil {
		// A malformed endpoint is an answer about the configuration, and it never
		// reached the provider: report it as rejected rather than unknown.
		writeJSON(w, http.StatusOK, probeReply{
			Outcome:   "rejected",
			Code:      "endpoint_unusable",
			ElapsedMS: time.Since(started).Milliseconds(),
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), probeTimeout)
	defer cancel()
	parameters := modelparams.Default()
	_, callErr := provider.Complete(ctx, egress.ProviderRequest{
		OrgID:      request.OrgID,
		Provider:   candidate.Provider,
		Model:      candidate.Model,
		Parameters: parameters,
		Messages:   egress.MessageInput{Input: []byte(probeInputText)},
	})

	// The adapter is the classifier: it returns ProviderRejection only for a
	// validation-class status whose body proves nothing executed. So "rejected" means
	// endpoint and credential were reachable and the provider refused the request -
	// connectivity is answered either way, and only the refused-versus-unreachable
	// distinction comes from the provider.
	switch {
	case callErr == nil:
		s.logProbe(request.GrantID, "ok", started)
		writeJSON(w, http.StatusOK, probeReply{
			Outcome:   "ok",
			ElapsedMS: time.Since(started).Milliseconds(),
		})
	case isProviderRejection(callErr):
		s.logProbe(request.GrantID, "rejected", started)
		writeJSON(w, http.StatusOK, probeReply{
			Outcome:   "rejected",
			Code:      "provider_rejected",
			ElapsedMS: time.Since(started).Milliseconds(),
		})
	default:
		s.logProbe(request.GrantID, "unknown", started)
		writeJSON(w, http.StatusOK, probeReply{
			Outcome:   "unknown",
			Code:      probeFailureCode(ctx, callErr),
			ElapsedMS: time.Since(started).Milliseconds(),
		})
	}
}

func (s *Server) logProbe(grantID, outcome string, started time.Time) {
	// The grant id is truncated the same way invoke truncates the execution id: enough
	// to correlate a line, not enough to be a usable credential.
	short := grantID
	if len(short) > 8 {
		short = short[:8]
	}
	log.Printf("work egress probe grant=%s outcome=%s elapsed_ms=%d",
		short, outcome, time.Since(started).Milliseconds())
}

func isProviderRejection(err error) bool {
	var rejection *egress.ProviderRejection
	return errors.As(err, &rejection)
}

// probeFailureCode names why a call did not reach a conclusion, from the adapter's own
// bounded codes only. The egress package keeps its classifier unexported because it is
// coupled to receipt writing; this path writes nothing, so it reads the same signal
// without re-deciding it.
func probeFailureCode(ctx context.Context, err error) string {
	var failure *egress.ProviderFailure
	if errors.As(err, &failure) && codeValuePattern.MatchString(failure.Code) {
		return failure.Code
	}
	if ctx.Err() != nil {
		return "context_expired"
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return "response_too_large"
	}
	return "provider_error"
}

func writeProbeClaimError(w http.ResponseWriter, err error) {
	var typed *providerctx.Error
	if !errors.As(err, &typed) {
		writeError(w, http.StatusServiceUnavailable, codeGrantUnavail)
		return
	}
	switch typed.Code {
	case providerctx.CodeProbeGrantInvalid:
		// Expired, consumed, unknown and wrong-token all land here on purpose: a
		// distinguishable answer would make this route an oracle over grant ids.
		writeError(w, http.StatusUnauthorized, codeGrantBad)
	case providerctx.CodeProviderContextUnsupported:
		writeError(w, http.StatusUnauthorized, codeGrantRefused)
	default:
		// A database or key failure is not an answer about the configuration, so it
		// must never read as "this config does not work".
		writeError(w, http.StatusServiceUnavailable, codeGrantUnavail)
	}
}
