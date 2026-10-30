package egressservice

import (
	"unicode/utf8"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/egress"
)

// Signed message roles. The assembly below is the only place these strings are
// produced; the provider adapter renders them in the compat profile's order.
const (
	roleSystem    = "system"
	roleUser      = "user"
	roleAssistant = "assistant"
)

// message is one assembled text message. Content is the exact UTF-8 text of the
// referenced object; nothing is trimmed, normalised or re-encoded.
type message struct {
	Role    string
	Content string
}

// assembled is one deterministic message sequence plus the egress input that
// carries the same bytes. Ordered is the trusted view (system, user, then one
// assistant per prior receipt); Input is what egress.Exchange hands to the
// provider adapter.
type assembled struct {
	Ordered []message
	Input   egress.MessageInput
}

// assemble builds the message sequence fixed by D4 §8.1 item 5:
//
//  1. system(template) when the document has a template;
//  2. user(input);
//  3. assistant(priorAnswers[0..n]) in document order.
//
// The order is never sorted or deduplicated. The total text budget is the same
// 256 KiB body ceiling canonical bodies use, so a short reference list cannot
// bypass the assembly limit. Invalid UTF-8, empty input and empty prior
// answers are refused rather than sent with U+FFFD replacements.
func assemble(template []byte, hasTemplate bool, input []byte, priorAnswers [][]byte) (assembled, error) {
	if len(input) == 0 || !utf8.Valid(input) {
		return assembled{}, errMessageInvalid
	}
	if len(priorAnswers) > canonical.MaxModelOperations-1 {
		return assembled{}, errMessageInvalid
	}
	total := int64(len(input))
	ordered := make([]message, 0, len(priorAnswers)+2)
	if hasTemplate {
		if !utf8.Valid(template) {
			return assembled{}, errMessageInvalid
		}
		total += int64(len(template))
		ordered = append(ordered, message{Role: roleSystem, Content: string(template)})
	}
	ordered = append(ordered, message{Role: roleUser, Content: string(input)})
	for _, answer := range priorAnswers {
		if len(answer) == 0 || !utf8.Valid(answer) {
			return assembled{}, errMessageInvalid
		}
		total += int64(len(answer))
		ordered = append(ordered, message{Role: roleAssistant, Content: string(answer)})
	}
	if total > canonical.MaxBodyBytes {
		return assembled{}, errMessageInvalid
	}

	var systemTemplate []byte
	if hasTemplate {
		systemTemplate = append([]byte(nil), template...)
	}
	copiedPrior := make([][]byte, len(priorAnswers))
	for i, answer := range priorAnswers {
		copiedPrior[i] = append([]byte(nil), answer...)
	}
	return assembled{
		Ordered: ordered,
		Input: egress.MessageInput{
			SystemTemplate: systemTemplate,
			Input:          append([]byte(nil), input...),
			PriorAnswers:   copiedPrior,
		},
	}, nil
}
