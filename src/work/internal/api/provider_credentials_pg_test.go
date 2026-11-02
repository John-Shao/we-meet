package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/credentials"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

// providerTestMaster is a fixed 32-byte key: the credential endpoints fail closed
// without one, and a fixed value lets the test compare the stored fingerprint with
// credentials.Fingerprint of the same plaintext.
var providerTestMaster = []byte("0123456789abcdef0123456789abcdef")

const (
	providerAPIKey        = "sk-provider-test-key-0001"
	providerAPIKeyRotated = "sk-provider-test-key-0002"
)

func newProviderHTTPServer(t *testing.T, pool *pgxpool.Pool, verifier host.SessionVerifier, csrf *api.CSRF) *httptest.Server {
	t.Helper()
	server, err := api.NewServer(pool, verifier, csrf, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	server.SetProviderMasterKey(providerTestMaster)
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

func providerCredentialURL(base string, credentialID string, suffix string) string {
	return fmt.Sprintf("%s%s/%s/%s", base, api.AdminProviderCredentialsPath, credentialID, suffix)
}

func seedProviderMember(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if err := testpg.ExecRaw(ctx, conn, `
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ('org_a', 'sub_member', 'active', 'member', true);
	`); err != nil {
		t.Fatal(err)
	}
}

// decodeProviderView asserts the response carries exactly the seven required
// ProviderCredentialView members: additionalProperties is false on that schema, and
// api_key is writeOnly, so any extra field would be a contract break.
func decodeProviderView(t *testing.T, response *http.Response) map[string]any {
	t.Helper()
	defer response.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(response.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	want := []string{"credential_id", "provider", "mode", "fingerprint", "key_version", "state", "created_at"}
	if len(out) != len(want) {
		t.Fatalf("view fields = %v, want exactly %v", keysOf(out), want)
	}
	for _, field := range want {
		if _, ok := out[field]; !ok {
			t.Fatalf("view missing %s, got %v", field, keysOf(out))
		}
	}
	return out
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestCreateProviderCredentialWritesSealedSingleLayer(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedProviderMember(t, dbName)
	server := newProviderHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)

	response := taskRequest(t, http.MethodPost, server.URL+api.AdminProviderCredentialsPath, csrf,
		`{"provider":"aliyun","mode":"managed_key","api_key":"`+providerAPIKey+`"}`)
	if response.StatusCode != http.StatusCreated {
		payload, _ := json.Marshal(response.Body)
		t.Fatalf("create status = %d body=%s", response.StatusCode, payload)
	}
	view := decodeProviderView(t, response)
	if view["provider"] != "aliyun" || view["mode"] != "managed_key" || view["state"] != "active" {
		t.Fatalf("view = %#v", view)
	}
	if version, ok := view["key_version"].(float64); !ok || int(version) != 1 {
		t.Fatalf("key_version = %#v, want 1 (create always inserts version 1)", view["key_version"])
	}
	credentialID, _ := view["credential_id"].(string)
	if credentialID == "" {
		t.Fatal("credential_id missing from view")
	}
	fingerprint, _ := view["fingerprint"].(string)
	// The fingerprint the API stores must be the one credentials.Fingerprint derives,
	// otherwise work-provider-setup and the API would write two different forms.
	if want := credentials.Fingerprint([]byte(providerAPIKey)); fingerprint != want {
		t.Fatalf("fingerprint = %q, want %q", fingerprint, want)
	}

	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	var (
		ciphertextLen  int
		roleRefNull    bool
		wrappedNull    bool
		kmsNull        bool
		stored         []byte
		state          string
		audited        int
		plaintextFound bool
	)
	// The stored form is the single layer the resolver accepts: ciphertext present and
	// both envelope columns NULL. providerctx refuses a row where they are set.
	if err := conn.QueryRow(ctx, `
		SELECT octet_length(secret_ciphertext), role_ref IS NULL,
		       wrapped_dek IS NULL, kms_key_ref IS NULL, secret_ciphertext, state
		FROM work.provider_credential WHERE id = $1::uuid`, credentialID,
	).Scan(&ciphertextLen, &roleRefNull, &wrappedNull, &kmsNull, &stored, &state); err != nil {
		t.Fatal(err)
	}
	if state != "active" || ciphertextLen == 0 || !roleRefNull || !wrappedNull || !kmsNull {
		t.Fatalf("stored row = state %s bytes %d role_ref_null %v wrapped_null %v kms_null %v",
			state, ciphertextLen, roleRefNull, wrappedNull, kmsNull)
	}
	// D-08b "write only, never read back": the plaintext must not appear in the
	// ciphertext blob, the audit payload, or anywhere else in the row.
	plaintextFound = strings.Contains(string(stored), providerAPIKey)
	if plaintextFound {
		t.Fatal("stored ciphertext contains the submitted plaintext")
	}
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = 'org_a' AND action = 'provider.credential_created'`).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if audited != 1 {
		t.Fatalf("create audit rows = %d, want 1", audited)
	}
	var auditPayload string
	if err := conn.QueryRow(ctx, `
		SELECT coalesce(metadata::text, '') FROM work.audit_event
		WHERE org_id = 'org_a' AND action = 'provider.credential_created'`).Scan(&auditPayload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(auditPayload, providerAPIKey) {
		t.Fatal("audit payload leaked the submitted plaintext")
	}

	// The domain rule is one active credential per (org, provider); a second aliyun
	// write is the contract's 409, while another provider is a fresh 201.
	response = taskRequest(t, http.MethodPost, server.URL+api.AdminProviderCredentialsPath, csrf,
		`{"provider":"aliyun","mode":"managed_key","api_key":"`+providerAPIKey+`"}`)
	assertAPICode(t, response, http.StatusConflict, "provider_credential_exists")

	response = taskRequest(t, http.MethodPost, server.URL+api.AdminProviderCredentialsPath, csrf,
		`{"provider":"deepseek","mode":"managed_key","api_key":"`+providerAPIKey+`"}`)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("second provider status = %d", response.StatusCode)
	}
	response.Body.Close()

	// A seated member who is not the org owner is refused by assert_org_owner in SQL.
	memberServer := newProviderHTTPServer(t, pool, &stubVerifier{claims: host.Claims{
		SubjectID:       "sub_member",
		OrgID:           "org_a",
		SessionRevision: 4,
		VerifiedAt:      time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC),
	}}, testCSRF(t))
	memberCSRF := workspaceCSRF(t, memberServer.URL)
	response = taskRequest(t, http.MethodPost, memberServer.URL+api.AdminProviderCredentialsPath,
		memberCSRF, `{"provider":"volcengine","mode":"managed_key","api_key":"`+providerAPIKey+`"}`)
	assertAPICode(t, response, http.StatusForbidden, "admin_access_denied")
}

func TestCreateProviderCredentialRejectsInvalidBodies(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	_ = dbName
	server := newProviderHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)
	url := server.URL + api.AdminProviderCredentialsPath

	invalid := []struct {
		name string
		body string
	}{
		{"empty", `{}`},
		{"missing mode", `{"provider":"aliyun"}`},
		{"missing provider", `{"mode":"managed_key"}`},
		{"missing api_key", `{"provider":"aliyun","mode":"managed_key"}`},
		{"short api_key", `{"provider":"aliyun","mode":"managed_key","api_key":"abc123"}`},
		{"blank api_key", `{"provider":"aliyun","mode":"managed_key","api_key":"   "}`},
		{"sts_role has no secret to fingerprint", `{"provider":"aliyun","mode":"sts_role","role_ref":"acs:ram::1:role/work"}`},
		{"unknown mode", `{"provider":"aliyun","mode":"password","api_key":"` + providerAPIKey + `"}`},
		{"role_ref beside api_key", `{"provider":"aliyun","mode":"managed_key","api_key":"` + providerAPIKey + `","role_ref":"x"}`},
		{"extra field", `{"provider":"aliyun","mode":"managed_key","api_key":"` + providerAPIKey + `","org_id":"org_a"}`},
		{"trailing json", `{"provider":"aliyun","mode":"managed_key","api_key":"` + providerAPIKey + `"} {}`},
	}
	for _, item := range invalid {
		response := taskRequest(t, http.MethodPost, url, csrf, item.body)
		assertAPICode(t, response, http.StatusBadRequest, "invalid_request")
	}

	// An unsupported provider is refused by the domain function, which still lands on
	// the contract's 400 rather than leaking a database error.
	response := taskRequest(t, http.MethodPost, url, csrf,
		`{"provider":"openai","mode":"managed_key","api_key":"`+providerAPIKey+`"}`)
	assertAPICode(t, response, http.StatusBadRequest, "invalid_request")

	// The CSRF guard runs before the domain call, so an untokened write gets its own
	// code instead of an owner error.
	request, err := http.NewRequest(http.MethodPost, url,
		strings.NewReader(`{"provider":"aliyun","mode":"managed_key","api_key":"`+providerAPIKey+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
	request.Header.Set("Content-Type", "application/json")
	untokened, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, untokened, http.StatusForbidden, "csrf_invalid")

	// Without a master key the endpoint fails closed rather than writing a value no
	// resolver can decrypt.
	barePool, _ := newBootstrapDB(t, true, true)
	bare, err := api.NewServer(barePool, &stubVerifier{claims: testClaims()}, testCSRF(t), log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	bareServer := httptest.NewServer(bare.Handler())
	t.Cleanup(bareServer.Close)
	response = taskRequest(t, http.MethodPost, bareServer.URL+api.AdminProviderCredentialsPath,
		workspaceCSRF(t, bareServer.URL),
		`{"provider":"aliyun","mode":"managed_key","api_key":"`+providerAPIKey+`"}`)
	assertAPICode(t, response, http.StatusServiceUnavailable, "service_degraded")
}

func TestRotateProviderCredentialVersionsTheKey(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	_ = dbName
	server := newProviderHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)

	created := decodeProviderView(t, taskRequest(t, http.MethodPost,
		server.URL+api.AdminProviderCredentialsPath, csrf,
		`{"provider":"aliyun","mode":"managed_key","api_key":"`+providerAPIKey+`"}`))
	credentialID, _ := created["credential_id"].(string)

	invalid := []string{`{}`, `{"api_key":"abc123"}`, `{"api_key":"   "}`,
		`{"api_key":"` + providerAPIKeyRotated + `","expected_revision":1}`}
	for _, body := range invalid {
		response := taskRequest(t, http.MethodPost,
			providerCredentialURL(server.URL, credentialID, "rotate"), csrf, body)
		assertAPICode(t, response, http.StatusBadRequest, "invalid_request")
	}

	response := taskRequest(t, http.MethodPost,
		providerCredentialURL(server.URL, credentialID, "rotate"), csrf,
		`{"api_key":"`+providerAPIKeyRotated+`"}`)
	if response.StatusCode != http.StatusOK {
		payload, _ := json.Marshal(response.Body)
		t.Fatalf("rotate status = %d body=%s", response.StatusCode, payload)
	}
	view := decodeProviderView(t, response)
	if version, ok := view["key_version"].(float64); !ok || int(version) != 2 {
		t.Fatalf("key_version after rotate = %#v, want 2", view["key_version"])
	}
	if view["fingerprint"] != credentials.Fingerprint([]byte(providerAPIKeyRotated)) {
		t.Fatalf("rotate fingerprint = %#v, want the new key's fingerprint", view["fingerprint"])
	}
	if view["state"] != "active" {
		t.Fatalf("rotate state = %#v", view["state"])
	}

	// A rotated credential is still readable through the provider-config half, which
	// proves the rotate wrote the form the rest of the system resolves.
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var (
		keyVersion int
		rotatedSet bool
		audited    int
	)
	if err := conn.QueryRow(ctx, `
		SELECT key_version, rotated_at IS NOT NULL
		FROM work.provider_credential WHERE id = $1::uuid`, credentialID,
	).Scan(&keyVersion, &rotatedSet); err != nil {
		t.Fatal(err)
	}
	if keyVersion != 2 || !rotatedSet {
		t.Fatalf("stored key_version = %d rotated_at set = %v", keyVersion, rotatedSet)
	}
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = 'org_a' AND action = 'provider.credential_rotated'`).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if audited != 1 {
		t.Fatalf("rotate audit rows = %d, want 1", audited)
	}

	// Unknown credential: the domain function raises not_found.
	response = taskRequest(t, http.MethodPost,
		providerCredentialURL(server.URL, "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a", "rotate"), csrf,
		`{"api_key":"`+providerAPIKeyRotated+`"}`)
	assertAPICode(t, response, http.StatusNotFound, "not_found")

	// A malformed uuid reaches the ::uuid cast and lands on the contract's 400.
	response = taskRequest(t, http.MethodPost,
		providerCredentialURL(server.URL, "not-a-uuid", "rotate"), csrf,
		`{"api_key":"`+providerAPIKeyRotated+`"}`)
	assertAPICode(t, response, http.StatusBadRequest, "invalid_request")

	// Rotating a revoked credential raises provider_credential_revoked, which carries
	// its own public 409 rather than riding on provider_not_configured's 422: the
	// contract declares rotateProviderCredential as 400/401/403/404/409.
	revoke := taskRequest(t, http.MethodPost,
		providerCredentialURL(server.URL, credentialID, "revoke"), csrf, `{"reason":"轮换前置"}`)
	if revoke.StatusCode != http.StatusOK {
		t.Fatalf("prerequisite revoke status = %d", revoke.StatusCode)
	}
	revoke.Body.Close()
	response = taskRequest(t, http.MethodPost,
		providerCredentialURL(server.URL, credentialID, "rotate"), csrf,
		`{"api_key":"`+providerAPIKey+`"}`)
	assertAPICode(t, response, http.StatusConflict, "provider_credential_revoked")
}

func TestRevokeProviderCredentialIsIdempotentAndAudited(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	_ = dbName
	server := newProviderHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)

	created := decodeProviderView(t, taskRequest(t, http.MethodPost,
		server.URL+api.AdminProviderCredentialsPath, csrf,
		`{"provider":"deepseek","mode":"managed_key","api_key":"`+providerAPIKey+`"}`))
	credentialID, _ := created["credential_id"].(string)

	invalid := []string{`{}`, `{"reason":""}`, `{"reason":"   "}`,
		`{"reason":"` + strings.Repeat("a", 201) + `"}`,
		`{"reason":"密钥外泄","credential_id":"` + credentialID + `"}`}
	for _, body := range invalid {
		response := taskRequest(t, http.MethodPost,
			providerCredentialURL(server.URL, credentialID, "revoke"), csrf, body)
		assertAPICode(t, response, http.StatusBadRequest, "invalid_request")
	}

	response := taskRequest(t, http.MethodPost,
		providerCredentialURL(server.URL, credentialID, "revoke"), csrf, `{"reason":"密钥外泄"}`)
	if response.StatusCode != http.StatusOK {
		payload, _ := json.Marshal(response.Body)
		t.Fatalf("revoke status = %d body=%s", response.StatusCode, payload)
	}
	defer response.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(response.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	// ProviderCredentialRevoked allows exactly credential_id and state.
	if len(out) != 2 || out["credential_id"] != credentialID || out["state"] != "revoked" {
		t.Fatalf("revoke body = %#v", out)
	}

	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var (
		state      string
		revokedBy  string
		revokedSet bool
		audited    int
	)
	if err := conn.QueryRow(ctx, `
		SELECT state, revoked_by, revoked_at IS NOT NULL
		FROM work.provider_credential WHERE id = $1::uuid`, credentialID,
	).Scan(&state, &revokedBy, &revokedSet); err != nil {
		t.Fatal(err)
	}
	if state != "revoked" || !revokedSet || revokedBy != "sub_a" {
		t.Fatalf("stored = state %s revoked_by %q revoked_at set %v", state, revokedBy, revokedSet)
	}
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = 'org_a' AND action = 'provider.credential_revoked'`).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if audited != 1 {
		t.Fatalf("revoke audit rows = %d, want 1", audited)
	}

	// work.revoke_provider_credential returns early on an already revoked row, so a
	// repeat is a 200 with still exactly one audit row.
	response = taskRequest(t, http.MethodPost,
		providerCredentialURL(server.URL, credentialID, "revoke"), csrf, `{"reason":"重复吊销"}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("repeat revoke status = %d", response.StatusCode)
	}
	response.Body.Close()
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = 'org_a' AND action = 'provider.credential_revoked'`).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if audited != 1 {
		t.Fatalf("audit rows after repeat revoke = %d, want 1", audited)
	}

	// A credential from another organization is invisible, not forbidden: the lookup is
	// scoped by org_id, so it reads as not_found.
	response = taskRequest(t, http.MethodPost,
		providerCredentialURL(server.URL, "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a", "revoke"), csrf,
		`{"reason":"不属于本组织"}`)
	assertAPICode(t, response, http.StatusNotFound, "not_found")
}
