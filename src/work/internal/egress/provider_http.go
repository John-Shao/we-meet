package egress

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/runtime"
)

// HTTPProviderConfig configures the reference openai-compatible transport.
//
// Endpoint is an operational configuration value chosen by the deployed egress,
// never a Runtime-supplied base URL or redirect target (§6.3, §7.1). It must be
// https, except for loopback endpoints used by tests.
type HTTPProviderConfig struct {
	Endpoint string

	// Transport carries the deployed TLS configuration (provider CA, optional
	// client certificate for mTLS). When nil a dedicated transport is built:
	// environment proxies are disabled, the connect timeout is 5s and redirects
	// are never followed.
	Transport http.RoundTripper

	// Credential resolves the per-organization credential at call time
	// (D-08b §7.5). The value is only placed in the Authorization header; it is
	// never logged, stored or echoed in an error. A resolution failure is an
	// unknown outcome, not a rejection: the call may still be in flight.
	Credential func(ctx context.Context, orgID string) (string, error)

	// MaxResponseBytes bounds the provider response body. Defaults to
	// canonical.MaxBodyBytes; a larger body is an unknown outcome, never a
	// truncated answer.
	MaxResponseBytes int64
}

// HTTPProvider is a single-shot openai-compatible transport. It issues exactly
// one HTTP request per Complete call and never retries, follows a redirect,
// switches provider or re-reads a stream.
type HTTPProvider struct {
	endpoint    string
	client      *http.Client
	credential  func(ctx context.Context, orgID string) (string, error)
	maxResponse int64
}

// NewHTTPProvider validates the endpoint and builds the client whose
// CheckRedirect refuses every redirect. A redirect turns into a non-2xx
// response (http.ErrUseLastResponse) and therefore into an unknown outcome; the
// gateway never chases a Location header, which could move the request to an
// unapproved host or downgrade TLS.
func NewHTTPProvider(config HTTPProviderConfig) (*HTTPProvider, error) {
	endpoint, err := url.Parse(strings.TrimSpace(config.Endpoint))
	if err != nil || endpoint.Host == "" || endpoint.User != nil {
		return nil, errors.New("egress: provider endpoint is not an absolute URL")
	}
	if !secureEndpoint(endpoint) {
		return nil, errors.New("egress: provider endpoint must use https")
	}
	client := &http.Client{
		Transport: config.Transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	if client.Transport == nil {
		client.Transport = defaultProviderTransport()
	}
	maxResponse := config.MaxResponseBytes
	if maxResponse <= 0 || maxResponse > canonical.MaxBodyBytes {
		maxResponse = canonical.MaxBodyBytes
	}
	if config.Credential == nil {
		return nil, errors.New("egress: provider credential resolver is required")
	}
	return &HTTPProvider{
		endpoint:    endpoint.String(),
		client:      client,
		credential:  config.Credential,
		maxResponse: maxResponse,
	}, nil
}

// defaultProviderTransport is deliberately independent of http.DefaultTransport
// environment configuration: an egress process must not inherit HTTP_PROXY and
// forward provider traffic through an arbitrary platform proxy (§6.3).
func defaultProviderTransport() *http.Transport {
	transport := &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return transport
}

func secureEndpoint(endpoint *url.URL) bool {
	switch endpoint.Scheme {
	case "https":
		return true
	case "http":
		host := endpoint.Hostname()
		if host == "localhost" {
			return true
		}
		ip := net.ParseIP(host)
		return ip != nil && ip.IsLoopback()
	default:
		return false
	}
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	MaxTokens   int64         `json:"max_tokens"`
	Temperature float64       `json:"temperature"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	ID      string `json:"id"`
	Choices []struct {
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens        *int64 `json:"prompt_tokens"`
		CompletionTokens    *int64 `json:"completion_tokens"`
		PromptTokensDetails *struct {
			CachedTokens *int64 `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
	} `json:"usage"`
}

// Complete makes the one permitted upstream request.
func (p *HTTPProvider) Complete(ctx context.Context, request ProviderRequest) (ProviderResponse, error) {
	payload, err := encodeChatRequest(request)
	if err != nil {
		return ProviderResponse{}, &ProviderFailure{Code: "request_encode_failed"}
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(payload))
	if err != nil {
		return ProviderResponse{}, &ProviderFailure{Code: "request_build_failed"}
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "application/json")
	credential, err := p.credential(ctx, request.OrgID)
	if err != nil {
		return ProviderResponse{}, &ProviderFailure{Code: "credential_unavailable"}
	}
	if credential != "" {
		httpRequest.Header.Set("Authorization", "Bearer "+credential)
	}

	response, err := p.client.Do(httpRequest)
	if err != nil {
		return ProviderResponse{}, transportFailure(ctx, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, p.maxResponse+1))
	if err != nil {
		// A body cut short by the network is not a provider verdict.
		return ProviderResponse{}, &ProviderFailure{StatusCode: response.StatusCode, Code: "truncated_response"}
	}
	if int64(len(body)) > p.maxResponse {
		return ProviderResponse{}, &ProviderFailure{StatusCode: response.StatusCode, Code: "response_too_large"}
	}

	switch {
	case response.StatusCode >= 200 && response.StatusCode <= 299:
		return decodeChatResponse(body)
	case isValidationRejection(response.StatusCode):
		if errorBodyHasTokens(body) {
			// "rejection with no tokens" is the proof; a body claiming consumed
			// tokens is not that proof.
			return ProviderResponse{}, &ProviderFailure{StatusCode: response.StatusCode, Code: "status_with_usage"}
		}
		return ProviderResponse{}, &ProviderRejection{
			StatusCode: response.StatusCode,
			Code:       rejectionCode(response.StatusCode),
			Evidence:   body,
		}
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		// §7.2/§7.5: an auth failure blocks and alerts, it does not become a
		// rejection or a retry with another key.
		return ProviderResponse{}, &ProviderFailure{StatusCode: response.StatusCode, Code: "auth_blocked"}
	case response.StatusCode >= 300 && response.StatusCode <= 399:
		return ProviderResponse{}, &ProviderFailure{StatusCode: response.StatusCode, Code: "redirect_refused"}
	case response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooManyRequests:
		return ProviderResponse{}, &ProviderFailure{StatusCode: response.StatusCode, Code: "retryable_status"}
	case response.StatusCode >= 500:
		return ProviderResponse{}, &ProviderFailure{StatusCode: response.StatusCode, Code: "server_error"}
	default:
		return ProviderResponse{}, &ProviderFailure{StatusCode: response.StatusCode, Code: "unexpected_status"}
	}
}

// isValidationRejection lists the statuses whose semantic is "the request was
// rejected before execution". 401/403 are excluded on purpose (§7.2) and every
// other status is treated as possibly executed.
func isValidationRejection(status int) bool {
	switch status {
	case http.StatusBadRequest,
		http.StatusNotFound,
		http.StatusRequestEntityTooLarge,
		http.StatusUnprocessableEntity:
		return true
	default:
		return false
	}
}

func rejectionCode(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "invalid_request"
	case http.StatusNotFound:
		return "model_not_found"
	case http.StatusRequestEntityTooLarge:
		return "payload_too_large"
	case http.StatusUnprocessableEntity:
		return "unprocessable"
	default:
		return "rejected"
	}
}

// errorBodyHasTokens reports whether a 4xx body claims consumed tokens. Such a
// body cannot be used as proof that nothing was executed.
func errorBodyHasTokens(body []byte) bool {
	var envelope struct {
		Usage *struct {
			PromptTokens     *int64 `json:"prompt_tokens"`
			CompletionTokens *int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Usage == nil {
		return false
	}
	return (envelope.Usage.PromptTokens != nil && *envelope.Usage.PromptTokens > 0) ||
		(envelope.Usage.CompletionTokens != nil && *envelope.Usage.CompletionTokens > 0)
}

func transportFailure(ctx context.Context, err error) *ProviderFailure {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return &ProviderFailure{Code: "deadline_exceeded"}
	case errors.Is(err, context.Canceled):
		return &ProviderFailure{Code: "canceled"}
	}
	var netError net.Error
	if errors.As(err, &netError) && netError.Timeout() {
		return &ProviderFailure{Code: "timeout"}
	}
	return &ProviderFailure{Code: "network_error"}
}

func encodeChatRequest(request ProviderRequest) ([]byte, error) {
	messages := make([]chatMessage, 0, len(request.Messages.PriorAnswers)+2)
	if len(request.Messages.SystemTemplate) > 0 {
		messages = append(messages, chatMessage{Role: "system", Content: string(request.Messages.SystemTemplate)})
	}
	for _, answer := range request.Messages.PriorAnswers {
		messages = append(messages, chatMessage{Role: "assistant", Content: string(answer)})
	}
	messages = append(messages, chatMessage{Role: "user", Content: string(request.Messages.Input)})
	return json.Marshal(chatRequest{
		Model:       request.Model,
		Messages:    messages,
		MaxTokens:   request.Parameters.MaxOutputTokens,
		Temperature: float64(request.Parameters.TemperatureMilli) / 1000,
	})
}

// decodeChatResponse accepts only a complete, single-answer success. A partial
// answer (length, content filter), an empty answer or an unparseable body is an
// unknown outcome: §8.1 does not allow it to become a rejection or a success.
func decodeChatResponse(body []byte) (ProviderResponse, error) {
	var parsed chatResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ProviderResponse{}, &ProviderFailure{Code: "invalid_response"}
	}
	if len(parsed.Choices) != 1 {
		return ProviderResponse{}, &ProviderFailure{Code: "invalid_response"}
	}
	if parsed.Choices[0].FinishReason != "stop" {
		return ProviderResponse{}, &ProviderFailure{Code: "partial_answer"}
	}
	answer := []byte(parsed.Choices[0].Message.Content)
	if len(answer) == 0 {
		return ProviderResponse{}, &ProviderFailure{Code: "empty_answer"}
	}
	return ProviderResponse{
		Answer:            answer,
		ProviderRequestID: parsed.ID,
		Usage:             chatUsage(parsed.Usage),
	}, nil
}

// chatUsage maps the openai-compatible usage object. A missing field anywhere
// yields unavailable with nil counts: partial provider usage must not be
// completed with zeros. Per-provider normalisation (for example DeepSeek's
// prompt_cache_hit_tokens) is pending H02 protocol evidence and is not guessed
// here.
func chatUsage(usage *struct {
	PromptTokens        *int64 `json:"prompt_tokens"`
	CompletionTokens    *int64 `json:"completion_tokens"`
	PromptTokensDetails *struct {
		CachedTokens *int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
}) runtime.Usage {
	if usage == nil || usage.PromptTokens == nil || usage.CompletionTokens == nil ||
		usage.PromptTokensDetails == nil || usage.PromptTokensDetails.CachedTokens == nil {
		return runtime.Usage{Source: runtime.UsageUnavailable}
	}
	return runtime.Usage{
		Source:            runtime.UsageProvider,
		InputTokens:       canonical.Int64(*usage.PromptTokens),
		OutputTokens:      canonical.Int64(*usage.CompletionTokens),
		CachedInputTokens: canonical.Int64(*usage.PromptTokensDetails.CachedTokens),
	}
}
