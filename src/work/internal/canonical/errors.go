package canonical

import (
	"errors"
	"fmt"
)

// Error codes are stable strings so the Node runtime, the gateway and the Go
// control plane can report the same rejection reason. They intentionally match
// the vocabulary of runtime-recovery.model.mjs where it has one.
var (
	ErrSyntax                   = errors.New("invalid_json_syntax")
	ErrTrailingData             = errors.New("trailing_data")
	ErrDuplicateKey             = errors.New("duplicate_key")
	ErrInvalidUnicode           = errors.New("invalid_unicode")
	ErrInvalidNumber            = errors.New("invalid_integer")
	ErrNegativeZero             = errors.New("negative_zero")
	ErrNonFiniteNumber          = errors.New("non_finite_number")
	ErrInvalidValue             = errors.New("invalid_json_value")
	ErrDepthExceeded            = errors.New("depth_exceeded")
	ErrDocumentTooLarge         = errors.New("document_too_large")
	ErrUnknownField             = errors.New("unknown_field")
	ErrMissingField             = errors.New("missing_field")
	ErrSchemaViolation          = errors.New("schema_violation")
	ErrStructuralViolation      = errors.New("structural_violation")
	ErrUnsupportedSchemaVersion = errors.New("unsupported_version")
	ErrHashFormMismatch         = errors.New("hash_form_mismatch")
	ErrHashMismatch             = errors.New("hash_mismatch")
)

func wrapf(sentinel error, format string, args ...any) error {
	return fmt.Errorf("canonical: %w: %s", sentinel, fmt.Sprintf(format, args...))
}
