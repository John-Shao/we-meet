package reference_test

import (
	"context"
	"testing"

	"github.com/we-meet/work/internal/runtime"
	"github.com/we-meet/work/internal/runtime/reference"
)

func TestExecuteLabelsUsageAsGatewayEstimate(t *testing.T) {
	result, err := reference.New().Execute(context.Background(), runtime.Request{
		RunID: "run-reference-test", TemplateID: "summary",
		Goal: "写一份发布计划", Step: 1, StepCount: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Usage.Source != runtime.UsageGatewayEstimate {
		t.Fatalf("usage source = %q, want %q", result.Usage.Source, runtime.UsageGatewayEstimate)
	}
	if result.Usage.InputTokens == nil || result.Usage.OutputTokens == nil || result.Usage.CachedInputTokens == nil {
		t.Fatalf("usage = %#v, want all counts set", result.Usage)
	}
	if *result.Usage.CachedInputTokens != 0 {
		t.Fatalf("cached input tokens = %d, want 0", *result.Usage.CachedInputTokens)
	}
	if result.Provider != "" {
		t.Fatalf("provider = %q, reference output is not provider-reported", result.Provider)
	}
	total, known := result.Usage.Total()
	if !known || total <= 0 {
		t.Fatalf("Total() = %d, %v; want a positive known total", total, known)
	}
}
