// Package advance is the Go control-plane client for the Node runtime's
// internal advanceRuntime transport.
//
// The wire payload is the signed fragment contract in package fragment. This
// client only carries that shape over mTLS; it never sends task text, provider
// credentials or free-form error detail, and it never interprets an invalid
// response as a result.
package advance

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/we-meet/work/internal/fragment"
)

const (
	// Path is the only route the Node internal listener exposes.
	Path = "/internal/v1/advanceRuntime"
	// MaxResponseBytes is the signed wire cap (maxWireBytes 16 KiB).
	MaxResponseBytes = 16 << 10

	// Codes returned by the internal listener.
	CodeInvalidRequest    = "invalid_request"
	CodeBodyTooLarge      = "body_too_large"
	CodeVersionMismatch   = "version_mismatch"
	CodeResourceExhausted = "resource_exhausted"
	CodeDraining          = "draining"
	CodeRunActive         = "run_active"
	CodeInternalError     = "internal_error"

	// Local transport codes. They are never sent on the wire.
	CodeTransportTimeout  = "transport_timeout"
	CodeTransportUnknown  = "transport_unknown"
	CodeTransportCanceled = "transport_canceled"
	CodeInvalidResponse   = "invalid_response"
)

var (
	remoteCodePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)
)

// TransportError is a local failure that did not produce a usable HTTP
// response. Error() is a fixed enumeration code; Unwrap exposes only the
// context cause for cancellation/deadline classification.
type TransportError struct {
	Code string
	Err  error
}

func (e *TransportError) Error() string { return e.Code }

func (e *TransportError) Unwrap() error { return e.Err }

// RemoteError is an enumeration code returned by the Node listener. It never
// carries server text.
type RemoteError struct {
	Status int
	Code   string
}

func (e *RemoteError) Error() string { return e.Code }

// Retryable reports the scheduling refusals that are safe to retry with the
// same fragment after capacity/version conditions change.
func (e *RemoteError) Retryable() bool {
	switch e.Code {
	case CodeResourceExhausted, CodeDraining, CodeVersionMismatch, CodeRunActive:
		return true
	default:
		return false
	}
}

// ClientConfig configures the mTLS client. Transport exists for tests;
// production uses the certificate files.
type ClientConfig struct {
	BaseURL    string
	CertFile   string
	KeyFile    string
	CAFile     string
	ServerName string
	Timeout    time.Duration
	Transport  http.RoundTripper
}

type Client struct {
	baseURL string
	http    *http.Client
}

func NewClient(config ClientConfig) (*Client, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("advance runtime URL must be an https URL")
	}

	transport := config.Transport
	if transport == nil {
		certificate, err := tls.LoadX509KeyPair(config.CertFile, config.KeyFile)
		if err != nil {
			return nil, errors.New("load advance client certificate")
		}
		caBody, err := os.ReadFile(config.CAFile)
		if err != nil {
			return nil, errors.New("read advance server CA")
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(caBody) {
			return nil, errors.New("advance server CA has no certificates")
		}
		transport = &http.Transport{
			TLSClientConfig: &tls.Config{
				Certificates: []tls.Certificate{certificate},
				RootCAs:      roots,
				ServerName:   config.ServerName,
				MinVersion:   tls.VersionTLS12,
			},
			TLSHandshakeTimeout:   10 * time.Second,
			IdleConnTimeout:       90 * time.Second,
			ExpectContinueTimeout: time.Second,
		}
	}

	// A zero Timeout leaves the call bounded by the caller's context, which is
	// the activity's start-to-close budget. Never allow redirects: the request
	// is pinned to the configured internal service.
	return &Client{
		baseURL: baseURL,
		http: &http.Client{
			Transport: transport,
			Timeout:   config.Timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

// Advance calls the Node listener for exactly one fragment. The request must
// already satisfy fragment.Request.Validate; the activity validates both the
// request and the returned result.
func (c *Client) Advance(ctx context.Context, request fragment.Request) (fragment.Result, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return fragment.Result{}, &TransportError{Code: CodeTransportUnknown}
	}
	if len(body) > fragment.MaxWireBytes {
		return fragment.Result{}, &TransportError{Code: CodeBodyTooLarge}
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+Path, bytes.NewReader(body))
	if err != nil {
		return fragment.Result{}, &TransportError{Code: CodeTransportUnknown}
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "application/json")

	response, err := c.http.Do(httpRequest)
	if err != nil {
		return fragment.Result{}, classifyTransport(ctx, err)
	}
	defer response.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes+1))
	if err != nil {
		return fragment.Result{}, &TransportError{Code: CodeTransportUnknown}
	}
	if len(payload) > MaxResponseBytes {
		return fragment.Result{}, &TransportError{Code: CodeInvalidResponse}
	}

	if response.StatusCode != http.StatusOK {
		return fragment.Result{}, decodeRemoteError(response.StatusCode, payload)
	}

	var result fragment.Result
	if err := decodeStrict(payload, &result); err != nil {
		return fragment.Result{}, &TransportError{Code: CodeInvalidResponse}
	}
	return result, nil
}

func classifyTransport(ctx context.Context, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		if errors.Is(ctxErr, context.Canceled) {
			return &TransportError{Code: CodeTransportCanceled, Err: context.Canceled}
		}
		if errors.Is(ctxErr, context.DeadlineExceeded) {
			return &TransportError{Code: CodeTransportTimeout, Err: context.DeadlineExceeded}
		}
	}
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return &TransportError{Code: CodeTransportTimeout, Err: context.DeadlineExceeded}
	}
	return &TransportError{Code: CodeTransportUnknown}
}

func decodeRemoteError(status int, body []byte) error {
	var failure struct {
		Code string `json:"code"`
	}
	if err := decodeStrict(body, &failure); err != nil || !remoteCodePattern.MatchString(failure.Code) {
		return &RemoteError{Status: status, Code: CodeInvalidResponse}
	}
	return &RemoteError{Status: status, Code: failure.Code}
}

func decodeStrict(body []byte, target any) error {
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
