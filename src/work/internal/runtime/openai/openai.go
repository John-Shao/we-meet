// Package openai talks to an OpenAI-compatible chat-completions endpoint.
// It is the pilot bridge to a real provider; Work still owns quota, operation
// state and artifact publication. API keys belong to the Work deployment, not
// to the meet backend.
package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	workruntime "github.com/we-meet/work/internal/runtime"
)

type Config struct {
	BaseURL    string
	APIKey     string
	Model      string
	Provider   string
	MaxTokens  int
	Timeout    time.Duration
	HTTPClient *http.Client
}

type Runtime struct {
	config Config
	client *http.Client
}

type chatRequest struct {
	Model     string        `json:"model"`
	Messages  []chatMessage `json:"messages"`
	MaxTokens int           `json:"max_tokens,omitempty"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	ID      string `json:"id"`
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int64 `json:"prompt_tokens"`
		CompletionTokens int64 `json:"completion_tokens"`
	} `json:"usage"`
}

func New(config Config) (*Runtime, error) {
	if strings.TrimSpace(config.BaseURL) == "" || strings.TrimSpace(config.APIKey) == "" ||
		strings.TrimSpace(config.Model) == "" {
		return nil, fmt.Errorf("model base URL, API key and model are required")
	}
	if config.Provider == "" {
		config.Provider = "deepseek"
	}
	switch config.Provider {
	case "aliyun", "volcengine", "deepseek":
	default:
		return nil, fmt.Errorf("unsupported model provider %q", config.Provider)
	}
	if config.MaxTokens <= 0 {
		config.MaxTokens = 1024
	}
	if config.Timeout <= 0 {
		config.Timeout = 5 * time.Minute
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: config.Timeout}
	}
	return &Runtime{config: config, client: client}, nil
}

func (r *Runtime) Execute(ctx context.Context, request workruntime.Request) (workruntime.Result, error) {
	if err := ctx.Err(); err != nil {
		return workruntime.Result{}, err
	}
	system := "你是 Work 任务执行助手。根据给定目标、背景和模板输出简洁的 Markdown 正文；不要输出 JSON 包装或解释性前言。"
	user := fmt.Sprintf("模板：%s v%d\n目标：\n%s\n\n背景：\n%s",
		request.TemplateID, request.TemplateVersion, request.Goal, request.Background)
	body, err := json.Marshal(chatRequest{
		Model: r.config.Model,
		Messages: []chatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		MaxTokens: r.config.MaxTokens,
	})
	if err != nil {
		return workruntime.Result{}, err
	}
	endpoint := strings.TrimRight(r.config.BaseURL, "/")
	if !strings.HasSuffix(endpoint, "/chat/completions") {
		endpoint += "/chat/completions"
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return workruntime.Result{}, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Authorization", "Bearer "+r.config.APIKey)
	response, err := r.client.Do(httpRequest)
	if err != nil {
		return workruntime.Result{}, fmt.Errorf("model request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return workruntime.Result{}, fmt.Errorf("model request status=%d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return workruntime.Result{}, fmt.Errorf("read model response: %w", err)
	}
	var parsed chatResponse
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return workruntime.Result{}, fmt.Errorf("decode model response: %w", err)
	}
	if len(parsed.Choices) == 0 || strings.TrimSpace(parsed.Choices[0].Message.Content) == "" {
		return workruntime.Result{}, fmt.Errorf("model response has no content")
	}
	return workruntime.Result{
		Content:           []byte(parsed.Choices[0].Message.Content),
		MediaType:         "text/markdown",
		RuntimeVersion:    r.config.Provider + ":" + r.config.Model,
		Provider:          r.config.Provider,
		Model:             r.config.Model,
		ProviderRequestID: parsed.ID,
		InputTokens:       parsed.Usage.PromptTokens,
		OutputTokens:      parsed.Usage.CompletionTokens,
	}, nil
}
