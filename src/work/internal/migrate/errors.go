package migrate

import "fmt"

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Diff    any    `json:"diff,omitempty"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func newError(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

func withDiff(err *Error, diff any) *Error {
	err.Diff = diff
	return err
}
