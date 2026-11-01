package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
	"time"
)

const (
	revokeCredentialID = "51111111-1111-4111-8111-111111111111"
	revokeConfigID     = "52222222-2222-4222-8222-222222222222"
)

func seedProviderConfig(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ('org_a', 'sub_member', 'active', 'member', true);
		INSERT INTO work.provider_credential
		  (id, org_id, provider, mode, role_ref, secret_fingerprint, created_by)
		VALUES ('` + revokeCredentialID + `', 'org_a', 'aliyun', 'sts_role',
		        'acs:ram::1:role/work', 'fp-1', 'sub_a');
		INSERT INTO work.provider_access_config
		  (id, org_id, revision, provider, model, region, endpoint,
		   credential_mode, credential_id, created_by)
		VALUES ('` + revokeConfigID + `', 'org_a', 1, 'aliyun', 'qwen-max', 'cn-north',
		        'https://dashscope.example.test/v1', 'sts_role',
		        '` + revokeCredentialID + `', 'sub_a');
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

func TestRevokeAdminProviderConfig(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedProviderConfig(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)
	url := server.URL + api.AdminProviderConfigRevokePath

	// ProviderRevokeRequest is additionalProperties:false with one required
	// field, so every malformed body has to be refused before the domain call.
	invalid := []string{
		`{}`,
		`{"reason":""}`,
		`{"reason":"   "}`,
		`{"reason":"切换供应商","expected_revision":1}`,
		`{"reason":"` + strings.Repeat("a", 201) + `"}`,
	}
	for _, body := range invalid {
		response := taskRequest(t, http.MethodPost, url, csrf, body)
		assertAPICode(t, response, http.StatusBadRequest, "invalid_request")
	}

	request, err := http.NewRequest(http.MethodPost, url,
		strings.NewReader(`{"reason":"切换供应商"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	// The CSRF guard runs before the domain function, so an untokened write is
	// refused with its own code rather than reaching the owner check.
	assertAPICode(t, response, http.StatusForbidden, "csrf_invalid")

	response = taskRequest(t, http.MethodPost, url, csrf, `{"reason":"切换供应商"}`)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		payload, _ := json.Marshal(response.Body)
		t.Fatalf("revoke status = %d body=%s", response.StatusCode, payload)
	}
	var out map[string]any
	if err := json.NewDecoder(response.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	// ProviderConfigRevoked allows exactly org_id and state.
	if len(out) != 2 || out["org_id"] != "org_a" || out["state"] != "revoked" {
		t.Fatalf("revoke body = %#v", out)
	}

	ctx := context.Background()
	read, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close(ctx)
	var (
		state      string
		revokedSet bool
		active     int
		audited    int
	)
	if err := read.QueryRow(ctx, `
		SELECT state, revoked_at IS NOT NULL
		FROM work.provider_access_config WHERE id = $1`, revokeConfigID,
	).Scan(&state, &revokedSet); err != nil {
		t.Fatal(err)
	}
	if state != "revoked" || !revokedSet {
		t.Fatalf("config state = %s revoked_at set = %v", state, revokedSet)
	}
	if err := read.QueryRow(ctx, `
		SELECT count(*) FROM work.provider_access_config
		WHERE org_id = 'org_a' AND state = 'active'`).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 0 {
		t.Fatalf("active configs after revoke = %d, want 0", active)
	}
	// D-08b requires strong audit on revoke.
	if err := read.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = 'org_a' AND action = 'provider.config_revoked'`).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if audited != 1 {
		t.Fatalf("revoke audit rows = %d, want 1", audited)
	}

	// Revoking again is a no-op on the SQL side: still a 200, still one audit row.
	response = taskRequest(t, http.MethodPost, url, csrf, `{"reason":"重复吊销"}`)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("second revoke status = %d", response.StatusCode)
	}
	if err := read.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = 'org_a' AND action = 'provider.config_revoked'`).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if audited != 1 {
		t.Fatalf("audit rows after repeat revoke = %d, want 1", audited)
	}

	// The observable consequence for the read endpoint: no active config, 404.
	response = taskRequest(t, http.MethodGet,
		server.URL+api.AdminProviderConfigPath, csrf, "")
	assertAPICode(t, response, http.StatusNotFound, "not_found")

	// A seat that is not the org owner must be refused by assert_org_owner in SQL
	// (owner_access_denied -> admin_access_denied), even with a valid CSRF token.
	memberServer := newHTTPServer(t, pool, &stubVerifier{claims: host.Claims{
		SubjectID:       "sub_member",
		OrgID:           "org_a",
		SessionRevision: 4,
		VerifiedAt:      time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC),
	}}, testCSRF(t))
	memberCSRF := workspaceCSRF(t, memberServer.URL)
	response = taskRequest(t, http.MethodPost, memberServer.URL+api.AdminProviderConfigRevokePath,
		memberCSRF, `{"reason":"非属主"}`)
	assertAPICode(t, response, http.StatusForbidden, "admin_access_denied")
}
