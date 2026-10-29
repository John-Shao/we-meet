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
