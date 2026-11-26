package migrate

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func validSuccessionProofMap(t *testing.T) map[string]any {
	t.Helper()
	return map[string]any{
		"old_grant_id":       "11111111-1111-4111-8111-111111111111",
		"new_grant_id":       "22222222-2222-4222-8222-222222222222",
		"root_identity_hash": strings.Repeat("3", 64),
		"run_id":             "44444444-4444-4444-8444-444444444444",
		"session_id":         "55555555-5555-4555-8555-555555555555",
		"auth_plane":         "bearer",
		"auth_epoch":         "7",
		"nonce":              "nonce-succession-valid",
		"expires_at":         "2027-01-01T00:00:00Z",
		"signature":          strings.Repeat("e", 86),
	}
}

func successionProofJSON(t *testing.T, proof map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestR0bGrantSuccessionProofClosedShape(t *testing.T) {
	a := newActionFixture(t, "org_r0b_succession_shape")
	conn := a.admin
	valid := validSuccessionProofMap(t)
	var ok bool
	if err := conn.QueryRow(testContext(t),
		`SELECT work.grant_succession_proof_valid($1::jsonb)`, successionProofJSON(t, valid)).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("valid proof shape was refused")
	}

	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"extra key", func(p map[string]any) { p["extra"] = "no" }},
		{"missing session", func(p map[string]any) { delete(p, "session_id") }},
		{"numeric auth epoch", func(p map[string]any) { p["auth_epoch"] = 7 }},
		{"short nonce", func(p map[string]any) { p["nonce"] = "short" }},
		{"placeholder signature", func(p map[string]any) { p["signature"] = "sha256:" + strings.Repeat("e", 64) }},
		{"bad root", func(p map[string]any) { p["root_identity_hash"] = "not-a-root" }},
		{"bad uuid", func(p map[string]any) { p["old_grant_id"] = "not-a-uuid" }},
		{"bad expiry", func(p map[string]any) { p["expires_at"] = "tomorrow" }},
		{"cookie plane", func(p map[string]any) { p["auth_plane"] = "cookie" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proof := validSuccessionProofMap(t)
			tc.mutate(proof)
			if err := conn.QueryRow(testContext(t),
				`SELECT work.grant_succession_proof_valid($1::jsonb)`, successionProofJSON(t, proof)).Scan(&ok); err != nil {
				t.Fatal(err)
			}
			if ok {
				t.Fatalf("invalid proof shape accepted: %#v", proof)
			}
		})
	}
}

func TestR0bRebindProofFreshnessAndSessionBinding(t *testing.T) {
	foreignSession := newUUID(t)
	for _, tc := range []struct {
		name      string
		expiresAt time.Time
		session   string
		authEpoch string
		revoke    bool
		wantCode  string
	}{
		{name: "expired", expiresAt: time.Now().Add(-time.Minute), authEpoch: "7", wantCode: "invalid_request"},
		{name: "too far future", expiresAt: time.Now().Add(6 * time.Minute), authEpoch: "7", wantCode: "invalid_request"},
		{name: "foreign session", expiresAt: time.Now().Add(4 * time.Minute), session: foreignSession, authEpoch: "7", wantCode: "unauthorized"},
		{name: "wrong auth epoch", expiresAt: time.Now().Add(4 * time.Minute), authEpoch: "8", wantCode: "invalid_request"},
		{name: "revoked session", expiresAt: time.Now().Add(4 * time.Minute), authEpoch: "7", revoke: true, wantCode: "unauthorized"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := newActionFixture(t, "org_r0b_rebind_proof_"+strings.ReplaceAll(tc.name, " ", "_"))
			api := a.apiConn(t)
			oldGrant := a.grantID
			root := a.scalar(t, "SELECT root_identity_hash FROM work.workspace_grant WHERE id = "+quoteLiteral(oldGrant))
			registered := callJSON(t, api,
				`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
				a.org, a.subject, a.deviceID, a.sessionID, "req-proof-new-"+newUUID(t),
				`{"root_identity_hash":"`+root+`","allowed_tools":["workspace.read"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}`)
			newGrant := idOf(t, registered, "grant_id")
			if tc.revoke {
				mustExec(t, a.admin, "UPDATE work.device_session SET state = 'revoked' WHERE id = "+quoteLiteral(a.sessionID))
			}
			mustExec(t, a.admin, "UPDATE work.run SET state = 'waiting', wait_reason = 'input' WHERE id = "+quoteLiteral(a.runID))
			session := tc.session
			if session == "" {
				session = a.sessionID
			}
			nonce := "nonce-proof-" + strings.ReplaceAll(tc.name, " ", "-")
			proof := fmt.Sprintf(`{"old_grant_id":%q,"new_grant_id":%q,"run_id":%q,"root_identity_hash":%q,"session_id":%q,"auth_plane":"bearer","auth_epoch":%q,"nonce":%q,"expires_at":%q,"signature":%q}`,
				oldGrant, newGrant, a.runID, root, session, tc.authEpoch, nonce,
				tc.expiresAt.UTC().Format(time.RFC3339), strings.Repeat("e", 86))
			expectRefused(t, api, tc.wantCode, map[string]string{"invalid_request": "22023", "unauthorized": "42501"}[tc.wantCode],
				`SELECT work.rebind_run_workspace($1,$2,'bearer',7,$3::uuid,$4,$5::uuid,$6::uuid,$7::jsonb)`,
				a.org, a.subject, a.runID, "req-proof-rebind-"+newUUID(t), oldGrant, newGrant, proof)
			if got := a.scalarInt(t, "SELECT count(*) FROM work.consumed_possession_nonce WHERE org_id = "+
				quoteLiteral(a.org)+" AND nonce = "+quoteLiteral(nonce)); got != 0 {
				t.Fatalf("refused proof consumed nonce %d times", got)
			}
			if got := a.scalarInt(t, "SELECT count(*) FROM work.workspace_grant_succession WHERE org_id = "+
				quoteLiteral(a.org)+" AND run_id = "+quoteLiteral(a.runID)); got != 0 {
				t.Fatalf("refused proof wrote %d successions", got)
			}
		})
	}
}

func TestR0bRebindReplayReturnsBeforeProofExpiry(t *testing.T) {
	a := newActionFixture(t, "org_r0b_rebind_proof_replay")
	api := a.apiConn(t)
	oldGrant := a.grantID
	root := a.scalar(t, "SELECT root_identity_hash FROM work.workspace_grant WHERE id = "+quoteLiteral(oldGrant))
	registered := callJSON(t, api,
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		a.org, a.subject, a.deviceID, a.sessionID, "req-replay-new-"+newUUID(t),
		`{"root_identity_hash":"`+root+`","allowed_tools":["workspace.read"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}`)
	newGrant := idOf(t, registered, "grant_id")
	mustExec(t, a.admin, "UPDATE work.run SET state = 'waiting', wait_reason = 'input' WHERE id = "+quoteLiteral(a.runID))
	proof := fmt.Sprintf(`{"old_grant_id":%q,"new_grant_id":%q,"run_id":%q,"root_identity_hash":%q,"session_id":%q,"auth_plane":"bearer","auth_epoch":"7","nonce":%q,"expires_at":%q,"signature":%q}`,
		oldGrant, newGrant, a.runID, root, a.sessionID, "nonce-proof-replay",
		time.Now().Add(5*time.Second).UTC().Format(time.RFC3339), strings.Repeat("e", 86))
	query := `SELECT work.rebind_run_workspace($1,$2,'bearer',7,$3::uuid,$4,$5::uuid,$6::uuid,$7::jsonb)`
	first := callJSON(t, api, query, a.org, a.subject, a.runID, "req-proof-replay", oldGrant, newGrant, proof)
	if first["replayed"] != false {
		t.Fatalf("first rebind = %#v", first)
	}
	time.Sleep(6 * time.Second)
	replay := callJSON(t, api, query, a.org, a.subject, a.runID, "req-proof-replay", oldGrant, newGrant, proof)
	if replay["replayed"] != true || replay["binding_revision"] != float64(2) {
		t.Fatalf("expired-proof replay = %#v", replay)
	}
}
