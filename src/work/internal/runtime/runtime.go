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

type Result struct {
	Content           []byte
	MediaType         string
	RuntimeVersion    string
	Provider          string
	Model             string
	ProviderRequestID string
	InputTokens       int64
	OutputTokens      int64
	CachedInputTokens int64
}

type Runtime interface {
	Execute(ctx context.Context, request Request) (Result, error)
}
