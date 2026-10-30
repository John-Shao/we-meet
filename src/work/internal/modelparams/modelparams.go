// Package modelparams freezes the R0a default model parameters recorded in a
// capability snapshot manifest. The advance workflow reads them from the
// manifest; a task without them fails closed before any provider call.
//
// The values are a product default pending a signed decision. Changing them
// changes the snapshot hash of every new task.
package modelparams

import "github.com/we-meet/work/internal/canonical"

const (
	DefaultMaxOutputTokens  int64 = 1024
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
