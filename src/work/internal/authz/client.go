package authz

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

// ClientConfig configures the mTLS client used by the Node parent and the
// egress gateway. Transport exists for tests; production always uses the
// certificate files.
type ClientConfig struct {
	BaseURL    string
	CertFile   string
	KeyFile    string
	CAFile     string
	ServerName string
	Timeout    time.Duration
	Transport  http.RoundTripper
}

// RemoteError is an enumeration code returned by the authorization service.
// It never carries free-form server text.
type RemoteError struct {
	Status int
	Code   string
}

func (e *RemoteError) Error() string { return e.Code }

type Client struct {
	baseURL string
	http    *http.Client
}

func NewClient(config ClientConfig) (*Client, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	if baseURL == "" {
		return nil, errors.New("authorization service URL is required")
	}
	transport := config.Transport
	if transport == nil {
		certificate, err := tls.LoadX509KeyPair(config.CertFile, config.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("load authorization client certificate: %w", err)
		}
		caBody, err := os.ReadFile(config.CAFile)
		if err != nil {
			return nil, errors.New("read authorization CA")
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(caBody) {
			return nil, errors.New("authorization CA has no certificates")
		}
		transport = &http.Transport{TLSClientConfig: &tls.Config{
			Certificates: []tls.Certificate{certificate},
			RootCAs:      roots,
			ServerName:   config.ServerName,
			MinVersion:   tls.VersionTLS12,
		}}
	}
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &Client{baseURL: baseURL, http: &http.Client{Transport: transport, Timeout: timeout}}, nil
}

func (c *Client) Claim(ctx context.Context, request ExecutionRequest) (ExecutionLease, error) {
	var lease ExecutionLease
	err := c.call(ctx, "claim_runtime_execution", request, &lease)
	return lease, err
}

func (c *Client) Renew(ctx context.Context, request ExecutionRequest) (ExecutionLease, error) {
	var lease ExecutionLease
	err := c.call(ctx, "renew_runtime_execution", request, &lease)
	return lease, err
}

// IssueCapability asks the internal authorization service for one opaque
// runtime bearer. The plaintext token is returned once; callers must deliver it
// to the child over the private bootstrap channel and never persist or log it.
func (c *Client) IssueCapability(ctx context.Context, request IssueCapabilityRequest) (IssuedCapability, error) {
	var issued IssuedCapability
	err := c.call(ctx, "issue_capability", request, &issued)
	return issued, err
}

func (c *Client) Consume(ctx context.Context, request DeliveryRequest) (ConsumeDecision, error) {
	var decision ConsumeDecision
	err := c.call(ctx, "consume_dispatch_delivery", request, &decision)
	return decision, err
}

func (c *Client) ConsumeByExecution(ctx context.Context, request ExecutionConsumeRequest) (ConsumeDecision, error) {
	var decision ConsumeDecision
	err := c.call(ctx, "consume_dispatch_by_execution", request, &decision)
	return decision, err
}

func (c *Client) Attach(ctx context.Context, request ReceiptRequest) error {
	return c.call(ctx, "attach_dispatch_receipt", request, nil)
}

func (c *Client) call(ctx context.Context, command string, request, response any) error {
	body, err := json.Marshal(request)
	if err != nil {
		return errors.New("encode authorization request")
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/internal/v1/commands/"+command, bytes.NewReader(body))
	if err != nil {
		return errors.New("build authorization request")
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	result, err := c.http.Do(httpRequest)
	if err != nil {
		return fmt.Errorf("authorization service unreachable: %s", command)
	}
	defer result.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(result.Body, 64<<10))
	if err != nil {
		return errors.New("read authorization response")
	}
	if result.StatusCode != http.StatusOK {
		var failure struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(payload, &failure) == nil && failure.Code != "" {
			return &RemoteError{Status: result.StatusCode, Code: failure.Code}
		}
		return &RemoteError{Status: result.StatusCode, Code: "internal_error"}
	}
	if response == nil || len(payload) == 0 {
		return nil
	}
	if err := json.Unmarshal(payload, response); err != nil {
		return errors.New("authorization response is invalid")
	}
	return nil
}
