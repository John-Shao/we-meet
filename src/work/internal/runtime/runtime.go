// Package runtime defines the execution boundary used by RunWorkflow.
//
// The production runtime (Pi/Node sandbox + model egress) is not part of the
// control-plane worker yet. Implementations must therefore be selected
// explicitly by configuration; the reference implementation is for tests and
// lifecycle drills, not a model-backed product runtime.
package runtime

import (
	"context"
	"errors"
)

var ErrUnavailable = errors.New("runtime unavailable")

// UnknownError marks a provider call whose outcome cannot be proven (timeout,
// disconnect, truncated response). Callers must reconcile instead of retrying.
type UnknownError struct {
	Err error
}

func (e *UnknownError) Error() string { return "unknown outcome: " + e.Err.Error() }
func (e *UnknownError) Unwrap() error { return e.Err }

func Unknown(err error) error {
	if err == nil {
		return nil
	}
	var existing *UnknownError
	if errors.As(err, &existing) {
		return err
	}
	return &UnknownError{Err: err}
}

func IsUnknown(err error) bool {
	var unknown *UnknownError
	return errors.As(err, &unknown)
}

type Request struct {
	RunID           string
	TaskID          string
	OrgID           string
	TemplateID      string
	TemplateName    string
	TemplateVersion int
	Goal            string
	Background      string
	TokenUpperBound int64
	Step            int
	StepCount       int
	PreviousContent string
}

// UsageSource identifies where a token count came from.
type UsageSource string

const (
	// UsageProvider means the provider reported the counts.
	UsageProvider UsageSource = "provider"
	// UsageGatewayEstimate means the gateway estimated the counts.
	UsageGatewayEstimate UsageSource = "gateway_estimate"
	// UsageUnavailable means usage is unknown; all token fields must be nil.
	UsageUnavailable UsageSource = "unavailable"
)

// Usage carries token counts for one runtime result. Counts are pointers so a
// provider-reported zero stays distinguishable from unknown usage; when Source
// is UsageUnavailable every count is nil.
type Usage struct {
	Source            UsageSource
	InputTokens       *int64
	OutputTokens      *int64
	CachedInputTokens *int64
}

// Total sums the token counts. It reports ok=false unless the source is not
// UsageUnavailable and all three counts are present.
func (u Usage) Total() (int64, bool) {
	if u.Source == UsageUnavailable {
		return 0, false
	}
	if u.InputTokens == nil || u.OutputTokens == nil || u.CachedInputTokens == nil {
		return 0, false
	}
	return *u.InputTokens + *u.OutputTokens + *u.CachedInputTokens, true
}

type Result struct {
	Content           []byte
	MediaType         string
	RuntimeVersion    string
	Provider          string
	Model             string
	ProviderRequestID string
	Usage             Usage
}

type Runtime interface {
	Execute(ctx context.Context, request Request) (Result, error)
}
