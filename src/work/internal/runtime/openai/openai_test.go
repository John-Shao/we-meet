package openai_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	workruntime "github.com/we-meet/work/internal/runtime"
	"github.com/we-meet/work/internal/runtime/openai"
)

func TestOpenAICompatibleRuntimeSendsPromptAndParsesUsage(t *testing.T) {
	var gotPath, gotAuth, gotModel, gotUser string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		var request struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
		}
		gotModel = request.Model
		if len(request.Messages) > 1 {
			gotUser = request.Messages[1].Content
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"resp-1",
			"choices":[{"message":{"role":"assistant","content":"# 结果\n\n正文"}}],
			"usage":{"prompt_tokens":11,"completion_tokens":22}
		}`))
	}))
	defer server.Close()

	runtime, err := openai.New(openai.Config{
		BaseURL: server.URL + "/v1", APIKey: "test-key",
		Model: "qwen-test", Provider: "aliyun",
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := runtime.Execute(context.Background(), workruntime.Request{
		RunID: "run-1", TaskID: "task-1", OrgID: "org-1",
		TemplateID: "summary", TemplateVersion: 1,
		Goal: "写一份发布计划", Background: "包含回滚",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/chat/completions" || gotAuth != "Bearer test-key" ||
		gotModel != "qwen-test" {
		t.Fatalf("path=%q auth=%q model=%q", gotPath, gotAuth, gotModel)
	}
	if gotUser == "" || !contains(gotUser, "写一份发布计划") || !contains(gotUser, "包含回滚") {
		t.Fatalf("user prompt = %q", gotUser)
	}
	if string(result.Content) != "# 结果\n\n正文" || result.Provider != "aliyun" ||
		result.Model != "qwen-test" || result.ProviderRequestID != "resp-1" ||
		result.InputTokens != 11 || result.OutputTokens != 22 {
		t.Fatalf("result = %#v", result)
	}
}

func TestOpenAICompatibleRuntimeRejectsMissingConfig(t *testing.T) {
	if _, err := openai.New(openai.Config{}); err == nil {
		t.Fatal("missing config accepted")
	}
}

func contains(value, part string) bool {
	for i := 0; i+len(part) <= len(value); i++ {
		if value[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
