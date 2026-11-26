package migrate

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/testpg"
)

func TestApprovalDecisionProofRequiresES256SignatureShape(t *testing.T) {
	dbName, migratorURL := newTestDB(t)
	if _, err := newRunner(t, migratorURL, true).Apply(testContext(t)); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	proof := map[string]any{
		"v": 1, "org_id": "org", "subject_id": "subject", "auth_plane": "bearer",
		"auth_epoch": "4", "device_id": "11111111-1111-4111-8111-111111111111",
		"session_id":   "22222222-2222-4222-8222-222222222222",
		"approval_id":  "33333333-3333-4333-8333-333333333333",
		"operation_id": "44444444-4444-4444-8444-444444444444",
		"params_hash":  strings.Repeat("a", 64), "expected_revision": "0",
		"decision": "approved", "remember_readonly": false,
		"readonly_scope": nil, "readonly_expires_at": nil,
		"policy_epoch": "0", "access_epoch": "0", "nonce": "nonce-proof-1",
		"expires_at": "2027-01-01T00:00:00Z", "signature": strings.Repeat("A", 86),
	}
	assertValid := func(want bool) {
		t.Helper()
		raw, err := json.Marshal(proof)
		if err != nil {
			t.Fatal(err)
		}
		var got bool
		if err := conn.QueryRow(ctx, `SELECT work.approval_decision_proof_valid($1::jsonb)`, string(raw)).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("proof valid = %v, want %v", got, want)
		}
	}
	assertValid(true)
	proof["signature"] = "sha256:" + strings.Repeat("a", 64)
	assertValid(false)
	proof["signature"] = strings.Repeat("A", 86)
	proof["decision"] = "rejected"
	proof["remember_readonly"] = true
	assertValid(false)
	proof["remember_readonly"] = false
	delete(proof, "operation_id")
	assertValid(false)
}
