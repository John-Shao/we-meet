package apierr

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/contracts"
)

func TestCatalogIsComplete(t *testing.T) {
	catalog := Default()
	if catalog.Version != "r0a-errors-v3" {
		t.Fatalf("version = %q", catalog.Version)
	}
	if len(catalog.Public) != 50 {
		t.Fatalf("public codes = %d, want 50", len(catalog.Public))
	}
	if len(catalog.DBExceptionMap) != 105 {
		t.Fatalf("db exception map = %d, want 105", len(catalog.DBExceptionMap))
	}
	for code := range catalog.Public {
		if catalog.Message(code) == "" {
			t.Fatalf("code %q has no message", code)
		}
	}
}

func TestNewFallsBackToServiceDegraded(t *testing.T) {
	if got := New("version_conflict"); got.Code != "version_conflict" || got.Status != 409 || got.Retryable {
		t.Fatalf("version_conflict = %#v", got)
	}
	got := New("not_a_public_code")
	if got.Code != "service_degraded" || got.Status != 503 || !got.Retryable {
		t.Fatalf("unknown code = %#v", got)
	}
}

func TestFromDBMapsCatalogSQLStateAndConflicts(t *testing.T) {
	revision := func(value int64) *int64 { return &value }
	cases := []struct {
		name      string
		err       error
		code      string
		status    int
		retryable bool
		revision  *int64
		internal  string
	}{
		{
			name: "version conflict with detail",
			err:  &pgconn.PgError{Code: "P0001", Message: "version_conflict", Detail: "7"},
			code: "version_conflict", status: 409, revision: revision(7), internal: "version_conflict",
		},
		{
			name: "version conflict without detail",
			err:  &pgconn.PgError{Code: "P0001", Message: "version_conflict"},
			code: "service_degraded", status: 503, retryable: true, internal: "conflict_detail_missing",
		},
		{
			name: "version conflict with invalid detail",
			err:  &pgconn.PgError{Code: "P0001", Message: "version_conflict", Detail: "latest"},
			code: "service_degraded", status: 503, retryable: true, internal: "conflict_detail_missing",
		},
		{
			name: "run not quiescent",
			err:  &pgconn.PgError{Code: "P0001", Message: "run_not_quiescent", Detail: "3"},
			code: "run_not_quiescent", status: 409, revision: revision(3), internal: "run_not_quiescent",
		},
		{
			name: "artifact read only",
			err:  &pgconn.PgError{Code: "P0001", Message: "artifact_read_only", Detail: "9"},
			code: "artifact_read_only", status: 409, revision: revision(9), internal: "artifact_read_only",
		},
		{
			name: "mapped raw code",
			err:  &pgconn.PgError{Code: "42501", Message: "actor_mismatch"},
			code: "forbidden", status: 403, internal: "actor_mismatch",
		},
		{
			name: "public raw code",
			err:  &pgconn.PgError{Code: "P0001", Message: "invalid_input"},
			code: "invalid_request", status: 400, internal: "invalid_input",
		},
		{
			name: "sqlstate fallback",
			err:  &pgconn.PgError{Code: "22P02", Message: "unknown_internal"},
			code: "invalid_request", status: 400, internal: "unknown_internal",
		},
		{
			name: "unmapped internal code",
			err:  &pgconn.PgError{Code: "XX000", Message: "unknown_internal", Detail: "secret detail"},
			code: "service_degraded", status: 503, retryable: true, internal: "unknown_internal",
		},
		{
			name: "non postgres error",
			err:  errors.New("connection reset"),
			code: "service_degraded", status: 503, retryable: true, internal: "database_error",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := FromDB(tc.err)
			if got.Code != tc.code || got.Status != tc.status || got.Retryable != tc.retryable {
				t.Fatalf("got %#v, want %s/%d/%t", got, tc.code, tc.status, tc.retryable)
			}
			if got.InternalCode != tc.internal {
				t.Fatalf("internal code = %q, want %q", got.InternalCode, tc.internal)
			}
			if tc.revision == nil {
				if got.CurrentRevision != nil {
					t.Fatalf("revision = %d, want nil", *got.CurrentRevision)
				}
			} else if got.CurrentRevision == nil || *got.CurrentRevision != *tc.revision {
				t.Fatalf("revision = %v, want %d", got.CurrentRevision, *tc.revision)
			}
		})
	}
}

func TestPayloadDoesNotExposeInternalCodes(t *testing.T) {
	err := FromDB(&pgconn.PgError{Code: "XX000", Message: "raw_internal", Detail: "secret"})
	payload := err.Payload("corr")
	if payload.Code != "service_degraded" || payload.CorrelationID != "corr" {
		t.Fatalf("payload = %#v", payload)
	}
	if payload.Message == "raw_internal" || payload.Message == "secret" {
		t.Fatalf("payload leaked internal text: %#v", payload)
	}
	if payload.CurrentRevision != nil {
		t.Fatalf("payload leaked revision: %#v", payload)
	}
}

func TestErrorCatalogMatchesDesignAsset(t *testing.T) {
	current, err := fs.ReadFile(contracts.FS, "error-codes.json")
	if err != nil {
		t.Fatal(err)
	}
	legacyPath := "../../../../docs/plan/assets/work-r0a-design-2026-10-25/error-codes.json"
	legacy, err := os.ReadFile(legacyPath)
	if os.IsNotExist(err) {
		t.Skip("design asset removed after cutover")
	}
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(current, legacy) {
		t.Fatalf("error catalog copy differs from %s", legacyPath)
	}
}
