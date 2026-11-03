package apierr

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/contracts"
)

func TestCatalogIsComplete(t *testing.T) {
	catalog := Default()
	if catalog.Version != "r0b-governance-v1" {
		t.Fatalf("version = %q", catalog.Version)
	}
	// Entry counts are deliberately not asserted. A number that every added code must
	// bump is a second ledger that drifts - it is also why the frozen design asset copy
	// had to be hand-edited whenever the live catalogue grew. What the counts were really
	// protecting is the pairing, so assert that relationally instead: every public code
	// needs display text, and no display text may exist for a code the surface cannot
	// return. Load-time validation already refuses a mapped exception without a public
	// code (catalog.go validate()), and TestEveryPublishedRaiseIsRegistered covers the
	// direction that actually matters - a code somebody raises and nobody registered.
	for code := range catalog.Public {
		if catalog.Message(code) == "" {
			t.Fatalf("code %q has no message", code)
		}
	}
	for code := range catalog.Messages {
		if _, ok := catalog.Public[code]; !ok {
			t.Fatalf("message %q has no public code - display text nobody can return", code)
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

// TestServiceDegradedFallbackCarriesRecoveryAction pins #29: the internal fallback
// constructor serviceDegraded() must copy recovery_action from the catalog ("retry"),
// not leave it nil. Before the fix every 503 response carried recovery_action:null even
// though the frozen contract declares retry, so a client told to retry had no action to
// follow. It is the fallback path (New of an unknown code, FromDB of a non-Postgres
// error) — not the catalog-lookup path — that this guards.
func TestServiceDegradedFallbackCarriesRecoveryAction(t *testing.T) {
	entry, _ := Default().Lookup("service_degraded")
	if entry.RecoveryAction == nil || *entry.RecoveryAction != "retry" {
		t.Fatalf("catalog service_degraded recovery_action = %#v, want \"retry\"", entry.RecoveryAction)
	}

	for _, got := range []*Error{
		New("not_a_public_code"),        // New fallback → serviceDegraded
		FromDB(errors.New("boom")),      // non-Postgres → serviceDegraded("database_error")
	} {
		if got.Code != "service_degraded" {
			t.Fatalf("code = %q, want service_degraded", got.Code)
		}
		if got.RecoveryAction == nil || *got.RecoveryAction != "retry" {
			t.Fatalf("fallback recovery_action = %v, want \"retry\" (the #29 regression)",
				(*string)(nil))
		}
	}

	// The wire payload is what the client actually reads: recovery_action must serialize
	// as "retry", not null, on a service_degraded response.
	payload := New("not_a_public_code").Payload("corr-x")
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["recovery_action"] != "retry" {
		t.Fatalf("payload recovery_action = %#v, want \"retry\"; body=%s", decoded["recovery_action"], body)
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
			// Provider credential conflicts raise without a numeric DETAIL, the same
			// shape that used to turn these into 503: they keep their own codes rather
			// than riding on version_conflict, whose detail requirement is deliberate.
			name: "provider credential exists",
			err:  &pgconn.PgError{Code: "P0001", Message: "provider_credential_exists"},
			code: "provider_credential_exists", status: 409, internal: "provider_credential_exists",
		},
		{
			name: "provider credential revoked",
			err:  &pgconn.PgError{Code: "P0001", Message: "provider_credential_revoked"},
			code: "provider_credential_revoked", status: 409, internal: "provider_credential_revoked",
		},
		{
			// The only raisers of these two are state gates, not optimistic-locking
			// checks, so they arrive without a DETAIL. Accepting a detail when one is
			// supplied keeps the read-only case future-proof; requiring one is what
			// used to make a contracted 409 read as a 503.
			name: "artifact read only without detail",
			err:  &pgconn.PgError{Code: "P0001", Message: "artifact_read_only"},
			code: "artifact_read_only", status: 409, internal: "artifact_read_only",
		},
		{
			name: "artifact read only",
			err:  &pgconn.PgError{Code: "P0001", Message: "artifact_read_only", Detail: "9"},
			code: "artifact_read_only", status: 409, revision: revision(9), internal: "artifact_read_only",
		},
		{
			name: "run not quiescent without detail",
			err:  &pgconn.PgError{Code: "P0001", Message: "run_not_quiescent"},
			code: "run_not_quiescent", status: 409, internal: "run_not_quiescent",
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

// TestErrorCatalogPreservesTheFrozenR0aContract checks the design asset copy of the
// catalogue against the live one.
//
// It used to require byte equality, which silently meant "this catalogue may never
// gain a code" - and every R0b increment that raises a new one breaks CI for a
// reason unrelated to R0a. What actually has to hold is that nothing the frozen R0a
// contract promised changed: each of its public codes keeps its status, retryability,
// recovery action and UI token, and each of its SQL exception mappings still resolves
// to the same public code. Additions are expected and are not an error.
// derefString keeps an absent recovery action comparable to a present empty one
// without dereferencing nil in the failure message. Entry.RecoveryAction is a
// *string, so comparing it with != would compare pointers and always differ.
func derefString(value *string) *string {
	if value == nil {
		empty := ""
		return &empty
	}
	return value
}

func TestErrorCatalogPreservesTheFrozenR0aContract(t *testing.T) {
	type frozenCatalog struct {
		Version        string            `json:"version"`
		Public         map[string]Entry  `json:"public"`
		DBExceptionMap map[string]string `json:"db_exception_map"`
	}
	read := func(path string) frozenCatalog {
		var out frozenCatalog
		body, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			// A silent skip here would let the frozen R0a contract stop being checked the
			// moment the asset path moves or the directory is trimmed - the same failure
			// as deleting a test. The asset is part of the shipped design record, so its
			// absence is a defect, not a condition to tolerate.
			t.Fatalf("frozen R0a contract asset missing at %s: the published surface "+
				"would stop being checked without anyone noticing", path)
		}
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	legacyPath := "../../../../docs/plan/assets/work-r0a-design-2026-10-25/error-codes.json"
	asset := read(legacyPath)
	liveBody, err := fs.ReadFile(contracts.FS, "error-codes.json")
	if err != nil {
		t.Fatal(err)
	}
	var live frozenCatalog
	if err := json.Unmarshal(liveBody, &live); err != nil {
		t.Fatal(err)
	}

	for code, entry := range asset.Public {
		got, ok := live.Public[code]
		if !ok {
			t.Fatalf("frozen public code %q (%s) is missing from the live catalogue", code, asset.Version)
		}
		if got.Status != entry.Status || got.Retryable != entry.Retryable ||
			*derefString(got.RecoveryAction) != *derefString(entry.RecoveryAction) ||
			got.UI != entry.UI {
			t.Fatalf("frozen public code %q changed: %+v -> %+v", code, entry, got)
		}
	}
	// Two raw names were re-pointed on 2026-11-02 when the provider credential writes
	// shipped (commit e60ea2062): a collision on an existing credential must not surface
	// as version_conflict, and a revoked one must not surface as provider_not_configured.
	// That commit synced the asset copy's `public` entries but not its two
	// `db_exception_map` lines, so the asset now carries a target that no longer matches
	// the contract it documents. Freezing those two at the asset's value would either fail
	// on every run or require silently editing a signed artifact, so the freeze is
	// restated at the agreed current values instead - still strict: any further change to
	// either mapping fails here. Syncing the asset copy is a separate, deliberate edit.
	repointed := map[string]string{
		"provider_credential_exists":  "provider_credential_exists",
		"provider_credential_revoked": "provider_credential_revoked",
	}
	for raw, code := range asset.DBExceptionMap {
		want := code
		if agreed, ok := repointed[raw]; ok {
			want = agreed
		}
		if got, ok := live.DBExceptionMap[raw]; !ok || got != want {
			t.Fatalf("frozen exception %q changed mapping %q -> %q", raw, want, got)
		}
	}
}
