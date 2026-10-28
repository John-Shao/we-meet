package apierr

import (
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

var sqlStateFallback = map[string]string{
	"22P02": "invalid_request",
	"22001": "invalid_request",
	"22023": "invalid_request",
	"23514": "invalid_request",
}

var conflictCodes = map[string]bool{
	"version_conflict":   true,
	"run_not_quiescent":  true,
	"artifact_read_only": true,
}

type Error struct {
	Code            string
	Message         string
	Status          int
	Retryable       bool
	RecoveryAction  *string
	CurrentRevision *int64
	InternalCode    string
	SQLState        string
}

type Payload struct {
	Code            string  `json:"code"`
	Message         string  `json:"message"`
	Retryable       bool    `json:"retryable"`
	CorrelationID   string  `json:"correlation_id"`
	CurrentRevision *int64  `json:"current_revision"`
	RecoveryAction  *string `json:"recovery_action"`
}

func New(code string) *Error {
	catalog := Default()
	entry, ok := catalog.Lookup(code)
	if !ok {
		return serviceDegraded(code, "")
	}
	return &Error{
		Code:           code,
		Message:        catalog.Message(code),
		Status:         entry.Status,
		Retryable:      entry.Retryable,
		RecoveryAction: entry.RecoveryAction,
	}
}

func NewWithRevision(code string, revision int64) *Error {
	err := New(code)
	err.CurrentRevision = &revision
	return err
}

func FromDB(err error) *Error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return serviceDegraded("database_error", "")
	}
	raw := rawCode(pgErr.Message)
	catalog := Default()
	code, ok := catalog.DBExceptionMap[raw]
	if !ok {
		code = raw
	}
	entry, public := catalog.Lookup(code)
	if !public {
		code = sqlStateFallback[pgErr.Code]
		entry, public = catalog.Lookup(code)
	}
	if !public {
		return serviceDegraded(raw, pgErr.Code)
	}

	out := &Error{
		Code:           code,
		Message:        catalog.Message(code),
		Status:         entry.Status,
		Retryable:      entry.Retryable,
		RecoveryAction: entry.RecoveryAction,
		InternalCode:   raw,
		SQLState:       pgErr.Code,
	}
	if conflictCodes[code] {
		revision, err := strconv.ParseInt(strings.TrimSpace(pgErr.Detail), 10, 64)
		if err != nil || revision < 0 {
			return serviceDegraded("conflict_detail_missing", pgErr.Code)
		}
		out.CurrentRevision = &revision
	}
	return out
}

func serviceDegraded(internalCode, sqlState string) *Error {
	entry, _ := Default().Lookup("service_degraded")
	return &Error{
		Code:         "service_degraded",
		Message:      Default().Message("service_degraded"),
		Status:       entry.Status,
		Retryable:    entry.Retryable,
		InternalCode: internalCode,
		SQLState:     sqlState,
	}
}

func rawCode(message string) string {
	raw := strings.TrimSpace(message)
	if index := strings.IndexByte(raw, ':'); index >= 0 {
		raw = raw[:index]
	}
	return strings.TrimSpace(raw)
}

func (e *Error) Payload(correlationID string) Payload {
	return Payload{
		Code:            e.Code,
		Message:         e.Message,
		Retryable:       e.Retryable,
		CorrelationID:   correlationID,
		CurrentRevision: e.CurrentRevision,
		RecoveryAction:  e.RecoveryAction,
	}
}
