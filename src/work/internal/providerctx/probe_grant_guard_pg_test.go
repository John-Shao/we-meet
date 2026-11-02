package providerctx_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// work.provider_probe_grant is the one-shot claim behind an administration probe: egress dials
// the endpoint named by the row and consume hands back the ciphertext bound to that credential.
// The 0024 comment is blunt about what that implies - "a grant is a single-use nonce whose
// binding columns ARE the authorisation" - so rewriting them would turn an already-spent grant
// into a credential reader pointed at another endpoint.
//
// provider_probe_grant_guard (increments/0024:74-98) is the only thing preventing it, and no
// test had fired it: probe_pg_test.go covers issuing, claiming, replay, expiry and the
// wrong-token path, but grepping provider_probe_grant_binding_immutable and
// provider_probe_grant_consumed_immutable across the test tree returned nothing. The attempts
// below run through testAdmin, which is work_owner - the role that owns the table and can write
// it - so a refusal can only come from the trigger. The one legal write (consumed_at, once) is
// asserted too, so the case cannot be satisfied by a blanket block.

func grantFacts(t *testing.T, grantID string) string {
	t.Helper()
	var facts string
	if err := testAdmin.QueryRow(testContext(t), `
		SELECT org_id || '/' || subject_id || '/' || provider || '/' || model || '/' ||
		       endpoint || '/' || credential_id::text || '/' || token_hash || '/' ||
		       (issued_at IS NOT NULL)::text || '/' || (expires_at > now())::text || '/' ||
		       (consumed_at IS NOT NULL)::text
		FROM work.provider_probe_grant WHERE grant_id = $1::uuid`, grantID,
	).Scan(&facts); err != nil {
		t.Fatal(err)
	}
	return facts
}

func guardRefuses(t *testing.T, label, statement string, args ...any) {
	t.Helper()
	tag, err := testAdmin.Exec(testContext(t), statement, args...)
	if err == nil {
		t.Fatalf("%s touched %d rows, want the guard to refuse", label, tag.RowsAffected())
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("%s: error %#v is not a *pgconn.PgError", label, err)
	}
	if pgErr.SQLState() != "23514" ||
		pgErr.Message != "provider_probe_grant_binding_immutable" {
		t.Fatalf("%s = %s %q, want 23514 provider_probe_grant_binding_immutable",
			label, pgErr.SQLState(), pgErr.Message)
	}
}

func TestProbeGrantBindingColumnsCannotBeRepointed(t *testing.T) {
	requireDB(t)
	org, owner := seedProbeOrg(t)
	credentialID := seedManagedKeyProvider(t, org, []byte(secretMarker))
	// A second live credential cannot exist: work_provider_credential_one_active allows only
	// one per org, so the re-point target is a well-formed id that is not this org's. The
	// guard fires in BEFORE ROW position, i.e. before the foreign key gets a chance to answer
	// with 23503 - if that ever changes, this case tells us by failing.
	foreignCredential := "00000000-0000-4000-8000-0000000000c4"

	token := probeToken("binding-immutable")
	grantID := issueGrant(t, org, owner, "aliyun", "qwen-max",
		"https://dashscope.example.test/v1", credentialID, token, 60)
	before := grantFacts(t, grantID)
	setProbeOrg(t, org, owner)

	cases := []struct {
		label  string
		column string
		value  any
	}{
		{"endpoint", "endpoint", "https://attacker.example.test/v1"},
		{"credential", "credential_id", foreignCredential},
		{"token hash", "token_hash", probeToken("stolen")},
		{"provider", "provider", "openai"},
		{"model", "model", "gpt-4o"},
		{"subject", "subject_id", "sub_intruder"},
		// org_id is also the row-level-security key, so it is included to show the refusal is
		// the guard rather than an invisible row.
		{"org", "org_id", "org_intruder"},
	}
	for _, tc := range cases {
		guardRefuses(t, tc.label,
			`UPDATE work.provider_probe_grant SET `+tc.column+` = $2 WHERE grant_id = $1::uuid`,
			grantID, tc.value)
	}

	// The window is a binding column too: widening it would resurrect a nonce whose holder
	// never claimed, so it is written as an expression rather than a bind parameter.
	guardRefuses(t, "expiry window",
		`UPDATE work.provider_probe_grant SET expires_at = now() + interval '1 day'
		 WHERE grant_id = $1::uuid`, grantID)
	guardRefuses(t, "issue stamp",
		`UPDATE work.provider_probe_grant SET issued_at = now() - interval '1 year'
		 WHERE grant_id = $1::uuid`, grantID)

	if after := grantFacts(t, grantID); after != before {
		t.Fatalf("grant row changed after the tamper attempts:\n before %s\n after  %s", before, after)
	}
	if grantConsumed(t, grantID) {
		t.Fatal("a tamper attempt consumed the grant; refusals must not change its state either")
	}
}

func TestProbeGrantConsumedMarkerIsWriteOnce(t *testing.T) {
	requireDB(t)
	org, owner := seedProbeOrg(t)
	credentialID := seedManagedKeyProvider(t, org, []byte(secretMarker))
	grantID := issueGrant(t, org, owner, "aliyun", "qwen-max",
		"https://dashscope.example.test/v1", credentialID, probeToken("write-once"), 60)
	setProbeOrg(t, org, owner)

	// The legal write: marking the nonce spent.
	if _, err := testAdmin.Exec(testContext(t),
		`UPDATE work.provider_probe_grant SET consumed_at = now() WHERE grant_id = $1::uuid`,
		grantID); err != nil {
		t.Fatalf("consuming the grant: %v", err)
	}
	if !grantConsumed(t, grantID) {
		t.Fatal("grant still unconsumed after the legal write")
	}

	// Un-spending it, or moving the stamp, would make the same nonce claimable a second time.
	for _, tc := range []struct{ label, stmt string }{
		{"un-spend", `UPDATE work.provider_probe_grant SET consumed_at = NULL
			WHERE grant_id = $1::uuid`},
		{"move the stamp", `UPDATE work.provider_probe_grant
			SET consumed_at = now() + interval '1 hour' WHERE grant_id = $1::uuid`},
	} {
		tag, err := testAdmin.Exec(testContext(t), tc.stmt, grantID)
		if err == nil {
			t.Fatalf("%s touched %d rows, want the guard to refuse", tc.label, tag.RowsAffected())
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) {
			t.Fatalf("%s: error %#v is not a *pgconn.PgError", tc.label, err)
		}
		if pgErr.SQLState() != "23514" ||
			pgErr.Message != "provider_probe_grant_consumed_immutable" {
			t.Fatalf("%s = %s %q, want 23514 provider_probe_grant_consumed_immutable",
				tc.label, pgErr.SQLState(), pgErr.Message)
		}
	}

	// A consumed grant still reads as consumed after the refusals: nothing half-applied.
	facts := grantFacts(t, grantID)
	if facts[len(facts)-len("/true"):] != "/true" {
		t.Fatalf("grant facts after the refusals = %s, want the consumed flag still set", facts)
	}
}
