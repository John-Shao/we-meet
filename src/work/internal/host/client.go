package host

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	SessionCookieName = "sessionid"
	sessionVerifyPath = "/work-host/v2/sessions/verify"
	maxResponseBytes  = 8 << 10
	maxClockSkew      = 5 * time.Second
	maxVerifiedAge    = 60 * time.Second
)

type Claims struct {
	SubjectID       string
	OrgID           string
	SessionRevision int64
	VerifiedAt      time.Time
}

type SessionVerifier interface {
	VerifySession(ctx context.Context, rawCookie, correlationID string) (Claims, error)
}

type Config struct {
	BaseURL        string
	ClientCertFile string
	ClientKeyFile  string
	CAFile         string
	Timeout        time.Duration
	Now            func() time.Time
}

type Client struct {
	baseURL    string
	httpClient *http.Client
	now        func() time.Time
}

type Error struct {
	Code    string
	Message string
	Status  int
	Err     error
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.Err }

func NewClient(config Config) (*Client, error) {
	base, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil || base.Scheme != "https" || base.Host == "" {
		return nil, newError("host_config_invalid", "host base URL must be an absolute https URL", err)
	}
	if config.Timeout <= 0 {
		config.Timeout = 5 * time.Second
	}
	if config.Now == nil {
		config.Now = time.Now
	}

	cert, err := tls.LoadX509KeyPair(config.ClientCertFile, config.ClientKeyFile)
	if err != nil {
		return nil, newError("host_config_invalid", "load Host client certificate", err)
	}
	caBody, err := os.ReadFile(config.CAFile)
	if err != nil {
		return nil, newError("host_config_invalid", "read Host CA", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caBody) {
		return nil, newError("host_config_invalid", "Host CA file has no certificates", nil)
	}

	tlsConfig := &tls.Config{
		Certificates:  []tls.Certificate{cert},
		RootCAs:       roots,
		ServerName:    base.Hostname(),
		MinVersion:    tls.VersionTLS12,
		Renegotiation: tls.RenegotiateNever,
	}
	dialer := &net.Dialer{Timeout: config.Timeout, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		TLSClientConfig:       tlsConfig,
		ForceAttemptHTTP2:     true,
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   config.Timeout,
		ResponseHeaderTimeout: config.Timeout,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   config.Timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return &Client{
		baseURL:    strings.TrimRight(base.String(), "/"),
		httpClient: client,
		now:        config.Now,
	}, nil
}

func (c *Client) VerifySession(ctx context.Context, rawCookie, correlationID string) (Claims, error) {
	if strings.TrimSpace(rawCookie) == "" {
		return Claims{}, newError("session_invalid", "session cookie is missing", nil)
	}
	if strings.ContainsAny(rawCookie, "\r\n") {
		return Claims{}, newError("session_invalid", "session cookie contains invalid characters", nil)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+sessionVerifyPath, nil)
	if err != nil {
		return Claims{}, newError("session_unverifiable", "build Host session request", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cookie", SessionCookieName+"="+rawCookie)
	if correlationID != "" {
		request.Header.Set("X-Work-Request-ID", correlationID)
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		return Claims{}, newError("session_unverifiable", "call Host session verifier", err)
	}
	defer response.Body.Close()

	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return Claims{}, newError("session_invalid", "Host rejected the session", nil)
	default:
		return Claims{}, newError("session_unverifiable", fmt.Sprintf("Host returned status %d", response.StatusCode), nil)
	}

	var wire struct {
		SubjectID       string `json:"subject_id"`
		OrgID           string `json:"org_id"`
		SessionRevision *int64 `json:"session_revision"`
		VerifiedAt      string `json:"verified_at"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxResponseBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return Claims{}, newError("session_unverifiable", "decode Host session response", err)
	}
	if err := ensureEOF(decoder); err != nil {
		return Claims{}, err
	}

	if wire.SubjectID == "" || wire.OrgID == "" || wire.SessionRevision == nil || wire.VerifiedAt == "" {
		return Claims{}, newError("host_field_gap", "Host session response is missing a required field", nil)
	}
	if len(wire.SubjectID) > 128 || len(wire.OrgID) > 128 {
		return Claims{}, newError("host_field_gap", "Host session IDs exceed 128 bytes", nil)
	}
	if *wire.SessionRevision < 0 {
		return Claims{}, newError("session_invalid", "Host session revision is negative", nil)
	}
	verifiedAt, err := time.Parse(time.RFC3339Nano, wire.VerifiedAt)
	if err != nil {
		return Claims{}, newError("host_field_gap", "Host verified_at is not RFC3339", err)
	}
	age := c.now().Sub(verifiedAt)
	if age > maxVerifiedAge {
		return Claims{}, newError("session_stale", "Host session verification is older than 60s", nil)
	}
	if age < -maxClockSkew {
		return Claims{}, newError("session_invalid", "Host verified_at is too far in the future", nil)
	}

	return Claims{
		SubjectID:       wire.SubjectID,
		OrgID:           wire.OrgID,
		SessionRevision: *wire.SessionRevision,
		VerifiedAt:      verifiedAt,
	}, nil
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return newError("session_unverifiable", "Host session response has trailing JSON", nil)
		}
		return newError("session_unverifiable", "decode Host session response", err)
	}
	return nil
}

func newError(code, message string, err error) *Error {
	return &Error{Code: code, Message: message, Err: err}
}
