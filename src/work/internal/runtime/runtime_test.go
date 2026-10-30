package runtime_test

import (
	"testing"

	"github.com/we-meet/work/internal/runtime"
)

func TestUsageTotal(t *testing.T) {
	zero, one, two, three := int64(0), int64(1), int64(2), int64(3)
	tests := []struct {
		name  string
		usage runtime.Usage
		total int64
		known bool
	}{
		{
			name: "provider complete",
			usage: runtime.Usage{
				Source: runtime.UsageProvider, InputTokens: &one, OutputTokens: &two, CachedInputTokens: &three,
			},
			total: 6, known: true,
		},
		{
			name: "gateway estimate complete",
			usage: runtime.Usage{
				Source: runtime.UsageGatewayEstimate, InputTokens: &one, OutputTokens: &two, CachedInputTokens: &zero,
			},
			total: 3, known: true,
		},
		{
			name: "provider reported zeros are known",
			usage: runtime.Usage{
				Source: runtime.UsageProvider, InputTokens: &zero, OutputTokens: &zero, CachedInputTokens: &zero,
			},
			total: 0, known: true,
		},
		{
			name:  "unavailable with nil counts",
			usage: runtime.Usage{Source: runtime.UsageUnavailable},
			total: 0, known: false,
		},
		{
			name: "unavailable ignores non-nil zeros",
			usage: runtime.Usage{
				Source: runtime.UsageUnavailable, InputTokens: &zero, OutputTokens: &zero, CachedInputTokens: &zero,
			},
			total: 0, known: false,
		},
		{
			name:  "missing input tokens",
			usage: runtime.Usage{Source: runtime.UsageProvider, OutputTokens: &two, CachedInputTokens: &three},
			total: 0, known: false,
		},
		{
			name:  "missing output tokens",
			usage: runtime.Usage{Source: runtime.UsageProvider, InputTokens: &one, CachedInputTokens: &three},
			total: 0, known: false,
		},
		{
			name:  "missing cached input tokens",
			usage: runtime.Usage{Source: runtime.UsageProvider, InputTokens: &one, OutputTokens: &two},
			total: 0, known: false,
		},
		{
			name:  "zero value usage",
			usage: runtime.Usage{},
			total: 0, known: false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			total, known := test.usage.Total()
			if total != test.total || known != test.known {
				t.Fatalf("Total() = %d, %v; want %d, %v", total, known, test.total, test.known)
			}
		})
	}
}
