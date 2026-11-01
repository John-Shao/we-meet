package api_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

func usageRequest(t *testing.T, serverURL string, path string) (*http.Response, map[string]any) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, serverURL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body map[string]any
	payload, _ := io.ReadAll(response.Body)
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &body); err != nil {
			t.Fatalf("decode %s: %v body=%s", path, err, payload)
		}
	}
	return response, body
}

func seedUsage(t *testing.T, dbName string) {
	t.Helper()
	admin, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	for _, statement := range []string{
		`INSERT INTO work.usage_daily (org_id, subject_id, provider, model, usage_date,
		     input_tokens, output_tokens, cached_input_tokens, run_count)
		  VALUES ('org_a', 'sub_a', 'aliyun', 'qwen3.8-flash', DATE '2026-10-30', 100, 40, 10, 2)`,
		`INSERT INTO work.usage_daily (org_id, subject_id, provider, model, usage_date,
		     input_tokens, output_tokens, cached_input_tokens, run_count)
		  VALUES ('org_a', 'sub_peer', 'aliyun', 'qwen3.8-flash', DATE '2026-10-30', 7, 3, 0, 1)`,
	} {
		if _, err := admin.Exec(context.Background(), statement); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUsageReadEndpoints(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, false)
	seedUsage(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	me, meBody := usageRequest(t, server.URL,
		api.MeUsagePath+"?from=2026-10-29&to=2026-10-31")
	if me.StatusCode != http.StatusOK {
		t.Fatalf("me/usage status = %d body=%#v", me.StatusCode, meBody)
	}
	items, ok := meBody["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("me/usage items = %#v", meBody["items"])
	}
	row := items[0].(map[string]any)
	if row["provider"] != "aliyun" || row["model"] != "qwen3.8-flash" ||
		row["usage_date"] != "2026-10-30" || row["input_tokens"] != float64(100) ||
		row["output_tokens"] != float64(40) || row["cached_input_tokens"] != float64(10) ||
		row["run_count"] != float64(2) {
		t.Fatalf("me/usage row = %#v", row)
	}
	if meBody["from"] != "2026-10-29" || meBody["to"] != "2026-10-31" ||
		meBody["note"] == "" || meBody["note"] == nil {
		t.Fatalf("me/usage envelope = %#v", meBody)
	}

	org, orgBody := usageRequest(t, server.URL,
		api.AdminUsagePath+"?from=2026-10-29&to=2026-10-31")
	if org.StatusCode != http.StatusOK {
		t.Fatalf("admin/usage status = %d body=%#v", org.StatusCode, orgBody)
	}
	orgItems, ok := orgBody["items"].([]any)
	if !ok || len(orgItems) != 1 {
		t.Fatalf("admin/usage items = %#v", orgBody["items"])
	}
	aggregate := orgItems[0].(map[string]any)
	if aggregate["input_tokens"] != float64(107) || aggregate["output_tokens"] != float64(43) ||
		aggregate["run_count"] != float64(3) {
		t.Fatalf("admin/usage aggregate = %#v", aggregate)
	}

	missing, _ := usageRequest(t, server.URL, api.MeUsagePath+"?from=2026-10-29")
	if missing.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing range status = %d", missing.StatusCode)
	}
	reversed, reversedBody := usageRequest(t, server.URL,
		api.MeUsagePath+"?from=2026-10-31&to=2026-10-29")
	if reversed.StatusCode != http.StatusBadRequest || reversedBody["code"] != "invalid_request" {
		t.Fatalf("reversed range = %d %#v", reversed.StatusCode, reversedBody)
	}

	// The endpoint takes no subject parameter: the only readable subject is the
	// session subject, which the SQL re-asserts.
	if strings.Contains(mustJSON(t, meBody), "sub_peer") {
		t.Fatalf("me/usage echoed a foreign subject: %#v", meBody)
	}
}

func TestUsageEndpointsRejectNonAdmin(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, false)
	seedUsage(t, dbName)
	admin, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(),
		`UPDATE work.member SET role = 'viewer' WHERE org_id = 'org_a' AND subject_id = 'sub_a'`); err != nil {
		t.Fatal(err)
	}
	admin.Close(context.Background())

	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	denied, deniedBody := usageRequest(t, server.URL,
		api.AdminUsagePath+"?from=2026-10-29&to=2026-10-31")
	if denied.StatusCode != http.StatusForbidden || deniedBody["code"] != "admin_access_denied" {
		t.Fatalf("non-admin org usage = %d %#v", denied.StatusCode, deniedBody)
	}
	own, ownBody := usageRequest(t, server.URL,
		api.MeUsagePath+"?from=2026-10-29&to=2026-10-31")
	if own.StatusCode != http.StatusOK {
		t.Fatalf("viewer own usage = %d %#v", own.StatusCode, ownBody)
	}
	config, configBody := usageRequest(t, server.URL, api.AdminProviderConfigPath)
	if config.StatusCode != http.StatusForbidden || configBody["code"] != "admin_access_denied" {
		t.Fatalf("non-admin provider config = %d %#v", config.StatusCode, configBody)
	}
}

func TestAdminProviderConfigNotFoundWhenUnset(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, false)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	response, body := usageRequest(t, server.URL, api.AdminProviderConfigPath)
	if response.StatusCode != http.StatusNotFound || body["code"] != "not_found" {
		t.Fatalf("provider config = %d %#v", response.StatusCode, body)
	}
	for _, forbidden := range []string{"api_key", "secret", "plaintext"} {
		if strings.Contains(strings.ToLower(mustJSON(t, body)), forbidden) {
			t.Fatalf("provider config response mentions %q", forbidden)
		}
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(payload)
}
