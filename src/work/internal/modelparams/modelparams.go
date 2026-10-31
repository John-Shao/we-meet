// Package modelparams freezes the R0a default model parameters recorded in a
// capability snapshot manifest. The advance workflow reads them from the
// manifest; a task without them fails closed before any provider call.
//
// John signed these R0a defaults on 2026-10-31; Lily's review remains open.
// Changing them changes the snapshot hash of every new task.
//
// 2026-10-31: John approved raising maxOutputTokens from 1024 to 4096 after
// E8 observed provider finish_reason != stop (partial_answer) on tasks whose
// signed acceptance range is 600-2500 characters. Lily re-review is pending.
package modelparams

import "github.com/we-meet/work/internal/canonical"

const (
	DefaultMaxOutputTokens  int64 = 4096
	DefaultTemperatureMilli int64 = 0
)

// Default returns the canonical parameters for one model step.
func Default() canonical.Parameters {
	return canonical.Parameters{
		MaxOutputTokens:  DefaultMaxOutputTokens,
		TemperatureMilli: DefaultTemperatureMilli,
		OutputFormat:     canonical.OutputFormatMarkdown,
	}
}

// Manifest returns the snapshot-manifest object read by the advance workflow.
func Manifest() map[string]any {
	return map[string]any{
		"maxOutputTokens":  DefaultMaxOutputTokens,
		"temperatureMilli": DefaultTemperatureMilli,
		"outputFormat":     canonical.OutputFormatMarkdown,
	}
}
