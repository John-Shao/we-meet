// Package egressclient calls the trusted model egress gateway's administration
// connectivity probe. It exists so work-api can ask "would this configuration work"
// without ever holding a provider credential or dialling a provider itself: the gateway
// is the only process allowed to make an upstream model call, and the 2026-10-29 P0 fix
// deleted the Go-direct path that used to bypass it.
package egressclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// ProbePath mirrors egressservice.ProbePath. It is repeated rather than imported
// because importing the gateway package would drag its provider and content
// dependencies into the control-plane binary.
const ProbePath = "/runtime/v1/provider-probe"

// DefaultTimeout has to outlast the gateway's own probe deadline (2 minutes), or the
// control plane would report a provider that is merely slow as inconclusive.
const DefaultTimeout = 3 * time.Minute

// ErrGrantInvalid means the gateway refused the grant: expired, already used, never
// issued, or bound to another organization. The caller must not read it as "the
// provider is broken", and must not retry - retrying cannot succeed.
var ErrGrantInvalid = errors.New("provider probe grant invalid")

// ErrUnavailable means the answer is not about the configuration at all: the gateway,
// its database or its credential store could not be consulted.
var ErrUnavailable = errors.New("provider probe service unavailable")

type Config struct {
	BaseURL    string
	CAFile     string
	ServerName string
	Timeout    time.Duration
	// CertFile/KeyFile are optional: the gateway listener presents a server
	// certificate but does not request client certificates, so the grant token in the
	// request body is the authenticator here, exactly as it is for the runtime callers.
	CertFile string
	KeyFile  string
	// Transport is for tests; production uses the certificate files.
	Transport http.RoundTripper
}

type Verdict string

const (
	// VerdictOK means the provider answered the probe request normally.
	VerdictOK Verdict = "ok"
	// VerdictRejected means the provider was reached and refused the request, which
	// proves the endpoint and credential are usable even though this call was rejected.
	VerdictRejected Verdict = "rejected"
	// VerdictUnknown means no conclusion: a timeout, a rate limit, a partial answer or
	// an unreachable endpoint. The configuration must not be saved on this answer.
	VerdictUnknown Verdict = "unknown"
	// VerdictRefused means the gateway declined to dial at all, e.g. a credential form
	// it cannot use. Also not a verdict about provider health.
	VerdictRefused Verdict = "refused"
)

type Result struct {
	Verdict   Verdict
	Code      string
	ElapsedMS int64
}

type Client struct {
	baseURL string
	http    *http.Client
}

type probeRequest struct {
	OrgID   string `json:"org_id"`
	GrantID string `json:"grant_id"`
	Token   string `json:"token"`
}

type probeReply struct {
	Outcome   string `json:"outcome"`
	Code      string `json:"code"`
	ElapsedMS int64  `json:"elapsed_ms"`
}

func NewClient(config Config) (*Client, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	if baseURL == "" {
		return nil, errors.New("provider probe gateway URL is required")
	}
	transport := config.Transport
	if transport == nil {
		caBody, err := os.ReadFile(config.CAFile)
		if err != nil {
			return nil, errors.New("read provider probe gateway CA")
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(caBody) {
			return nil, errors.New("provider probe gateway CA has no certificates")
		}
		tlsConfig := &tls.Config{RootCAs: roots, ServerName: config.ServerName, MinVersion: tls.VersionTLS12}
		if config.CertFile != "" && config.KeyFile != "" {
			certificate, err := tls.LoadX509KeyPair(config.CertFile, config.KeyFile)
			if err != nil {
				return nil, errors.New("load provider probe client certificate")
			}
			tlsConfig.Certificates = []tls.Certificate{certificate}
		}
		transport = &http.Transport{TLSClientConfig: tlsConfig}
	}
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &Client{baseURL: baseURL, http: &http.Client{Transport: transport, Timeout: timeout}}, nil
}

// Probe spends one grant. The token is never echoed into an error, a log line or a
// wrapped message: it is the single-use credential for a provider call.
func (c *Client) Probe(ctx context.Context, orgID, grantID, token string) (Result, error) {
	body, err := json.Marshal(probeRequest{OrgID: orgID, GrantID: grantID, Token: token})
	if err != nil {
		return Result{}, errors.New("encode provider probe request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+ProbePath,
		bytes.NewReader(body))
	if err != nil {
		return Result{}, errors.New("build provider probe request")
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := c.http.Do(request)
	if err != nil {
		// Deliberately %s-free of the underlying error: transport errors can carry the
		// URL, and this call's URL identifies an internal listener.
		return Result{}, ErrUnavailable
	}
	defer response.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(response.Body, 16<<10))
	if err != nil {
		return Result{}, ErrUnavailable
	}
	switch response.StatusCode {
	case http.StatusOK:
		var reply probeReply
		if err := json.Unmarshal(payload, &reply); err != nil {
			return Result{}, ErrUnavailable
		}
		verdict := Verdict(reply.Outcome)
		switch verdict {
		case VerdictOK, VerdictRejected, VerdictUnknown, VerdictRefused:
			return Result{Verdict: verdict, Code: reply.Code, ElapsedMS: reply.ElapsedMS}, nil
		default:
			return Result{}, ErrUnavailable
		}
	case http.StatusUnauthorized:
		return Result{}, ErrGrantInvalid
	case http.StatusServiceUnavailable:
		return Result{}, ErrUnavailable
	default:
		return Result{}, fmt.Errorf("%w: gateway returned status %d", ErrUnavailable, response.StatusCode)
	}
}
