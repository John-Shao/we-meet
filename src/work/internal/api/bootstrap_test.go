package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

const (
	testOrg     = "org_a"
	testSubject = "sub_a"
)

type stubVerifier struct {
	claims      host.Claims
	err         error
	calls       int
	cookie      string
	correlation string
}

func (s *stubVerifier) VerifySession(_ context.Context, cookie, correlation string) (host.Claims, error) {
	s.calls++
	s.cookie = cookie
	s.correlation = correlation
	return s.claims, s.err
}

func TestMain(m *testing.M) {
	if testpg.AdminURL() == "" {
		os.Exit(m.Run())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err == nil {
		err = testpg.EnsureFixtures(ctx, admin)
		_ = admin.Close(ctx)
	}
	cancel()
	if err != nil {
		fmt.Fprintf(os.Stderr, "prepare api test fixtures: %v\n", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func TestBootstrapReturnsFrozenShape(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	verifier := &stubVerifier{claims: testClaims()}
	csrf := testCSRF(t)
	server := newHTTPServer(t, pool, verifier, csrf)

	response := doBootstrap(t, server.URL, "session-value", "corr-1")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	defer response.Body.Close()

	var raw map[string]json.RawMessage
	if err := json.NewDecoder(response.Body).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"subject_id", "org", "permissions", "phases", "execution_targets",
		"allowed_permission_modes", "limits", "csrf_token",
	} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("missing field %q", key)
		}
	}
	if len(raw) != 8 {
		t.Fatalf("response has %d fields, want 8", len(raw))
	}

	var body api.BootstrapResponse
	bodyBytes, _ := json.Marshal(raw)
	if err := json.Unmarshal(bodyBytes, &body); err != nil {
		t.Fatal(err)
	}
	if body.SubjectID != testSubject || body.Org.ID != testOrg || body.Org.Name != "Acme" ||
		body.Org.Role != "owner" || !body.Org.WorkSeat {
		t.Fatalf("identity = %#v", body)
	}
	if len(body.Permissions) != 2 || body.Permissions[0] != "work.task.create" {
		t.Fatalf("permissions = %#v", body.Permissions)
	}
	if len(body.Phases) != 1 || body.Phases[0] != "R0a" {
		t.Fatalf("phases = %#v", body.Phases)
	}
	if len(body.ExecutionTargets) != 1 || body.ExecutionTargets[0] != (api.Target{Kind: "cloud", Profile: "text-v1"}) {
		t.Fatalf("targets = %#v", body.ExecutionTargets)
	}
	if len(body.AllowedPermissionModes) != 2 || body.AllowedPermissionModes[1] != "auto_readonly" {
		t.Fatalf("modes = %#v", body.AllowedPermissionModes)
	}
	if body.Limits.MaxArtifactBytes != 262144 || body.Limits.MaxActiveRuns != 1 {
		t.Fatalf("limits = %#v", body.Limits)
	}
	if err := csrf.Verify(body.CSRFToken, testSubject, testOrg, 4); err != nil {
		t.Fatalf("csrf token: %v", err)
	}
	cookie := findCookie(t, response, api.CSRFCookieName)
	if cookie.HttpOnly || !cookie.Secure || cookie.Path != "/work" || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("csrf cookie = %#v", cookie)
	}
	if got := response.Header.Get("X-Correlation-ID"); got != "corr-1" {
		t.Fatalf("correlation = %q", got)
	}
	if verifier.calls != 1 || verifier.cookie != "session-value" || verifier.correlation != "corr-1" {
		t.Fatalf("host verifier = %#v", verifier)
	}
	if got := dbName; got == "" {
		t.Fatal("database name is empty")
	}
}

func TestBootstrapOmitsAutoReadonlyWhenPolicyDisallows(t *testing.T) {
	pool, _ := newBootstrapDB(t, false, true)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	response := doBootstrap(t, server.URL, "session-value", "corr-2")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	defer response.Body.Close()
	var body api.BootstrapResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.AllowedPermissionModes) != 1 || body.AllowedPermissionModes[0] != "ask_each" {
		t.Fatalf("modes = %#v", body.AllowedPermissionModes)
	}
}

func TestBootstrapRejectsMissingCookie(t *testing.T) {
	pool, _ := newBootstrapDB(t, false, true)
	verifier := &stubVerifier{claims: testClaims()}
	server := newHTTPServer(t, pool, verifier, testCSRF(t))
	response := doBootstrap(t, server.URL, "", "corr-3")
	assertAPIError(t, response, http.StatusUnauthorized, "unauthorized", "corr-3")
	if verifier.calls != 0 {
		t.Fatal("Host verifier called without a session cookie")
	}
}

func TestBootstrapRejectsWrongOrDuplicateCookie(t *testing.T) {
	pool, _ := newBootstrapDB(t, false, true)
	cases := []struct {
		name    string
		cookies []*http.Cookie
	}{
		{"wrong name", []*http.Cookie{{Name: "other", Value: "value"}}},
		{"duplicate", []*http.Cookie{
			{Name: host.SessionCookieName, Value: "a"},
			{Name: host.SessionCookieName, Value: "b"},
		}},
		{"empty", []*http.Cookie{{Name: host.SessionCookieName, Value: "  "}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			verifier := &stubVerifier{claims: testClaims()}
			server := newHTTPServer(t, pool, verifier, testCSRF(t))
			request, err := http.NewRequest(http.MethodGet, server.URL+api.BootstrapPath, nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, cookie := range tc.cookies {
				request.AddCookie(cookie)
			}
			request.Header.Set("X-Correlation-ID", "corr-cookie")
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			assertAPIError(t, response, http.StatusUnauthorized, "unauthorized", "corr-cookie")
			if verifier.calls != 0 {
				t.Fatal("Host verifier called for an invalid cookie set")
			}
		})
	}
}

func TestBootstrapMapsHostFailures(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"invalid", &host.Error{Code: "session_invalid"}, http.StatusUnauthorized, "unauthorized"},
		{"stale", &host.Error{Code: "session_stale"}, http.StatusUnauthorized, "unauthorized"},
		{"unavailable", &host.Error{Code: "session_unverifiable"}, http.StatusServiceUnavailable, "service_degraded"},
		{"field gap", &host.Error{Code: "host_field_gap"}, http.StatusServiceUnavailable, "service_degraded"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pool, _ := newBootstrapDB(t, false, true)
			server := newHTTPServer(t, pool, &stubVerifier{err: tc.err}, testCSRF(t))
			response := doBootstrap(t, server.URL, "session-value", "corr")
			assertAPIError(t, response, tc.status, tc.code, "corr")
		})
	}
}

func TestBootstrapRequiresSeatAndMembership(t *testing.T) {
	cases := []struct {
		name   string
		member bool
		seat   bool
	}{
		{"no member", false, false},
		{"no seat", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pool, _ := newBootstrapDB(t, false, false, tc.member, tc.seat)
			server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
			response := doBootstrap(t, server.URL, "session-value", "corr")
			assertAPIError(t, response, http.StatusForbidden, "work_seat_required", "corr")
		})
	}
}

func newBootstrapDB(t *testing.T, allowAuto bool, withOrg bool, memberSeat ...bool) (*pgxpool.Pool, string) {
	t.Helper()
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	member := true
	seat := true
	if len(memberSeat) == 2 {
		member = memberSeat[0]
		seat = memberSeat[1]
	}
	ctx := testContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_api_test")
	_ = admin.Close(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cleanupAdmin, err := testpg.Open(cleanupCtx, testpg.AdminURL())
		if err == nil {
			_ = testpg.DropDatabase(cleanupCtx, cleanupAdmin, dbName)
			_ = cleanupAdmin.Close(cleanupCtx)
		}
	})

	seedConn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	statement := fmt.Sprintf(`
		INSERT INTO work.org (id, status, home_region, name)
		VALUES ('%s', 'active', 'cn-north', 'Acme');
		INSERT INTO work.org_policy (org_id, allow_auto_readonly)
		VALUES ('%s', %t);
	`, testOrg, testOrg, allowAuto)
	if withOrg {
		statement += fmt.Sprintf(`
		INSERT INTO work.org (id, status, home_region, name)
		VALUES ('org_other', 'active', 'cn-east', 'Other');
		`)
	}
	if member {
		statement += fmt.Sprintf(`
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ('%s', '%s', 'active', 'owner', %t);
		`, testOrg, testSubject, seat)
	}
	if err := testpg.ExecRaw(ctx, seedConn, statement); err != nil {
		_ = seedConn.Close(ctx)
		t.Fatal(err)
	}
	_ = seedConn.Close(ctx)

	pool, err := workdb.OpenPool(ctx, testpg.AppURL(dbName), "work-api-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, dbName
}

func newHTTPServer(t *testing.T, pool *pgxpool.Pool, verifier host.SessionVerifier, csrf *api.CSRF) *httptest.Server {
	t.Helper()
	server, err := api.NewServer(pool, verifier, csrf, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

func doBootstrap(t *testing.T, baseURL, cookie, correlation string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, baseURL+api.BootstrapPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cookie != "" {
		request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: cookie})
	}
	if correlation != "" {
		request.Header.Set("X-Correlation-ID", correlation)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func assertAPIError(t *testing.T, response *http.Response, status int, code, correlation string) {
	t.Helper()
	defer response.Body.Close()
	if response.StatusCode != status {
		t.Fatalf("status = %d, want %d", response.StatusCode, status)
	}
	var payload apierr.Payload
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Code != code || payload.CorrelationID != correlation {
		t.Fatalf("payload = %#v", payload)
	}
	if payload.CurrentRevision != nil {
		t.Fatalf("unexpected revision: %#v", payload)
	}
}

func findCookie(t *testing.T, response *http.Response, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range response.Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("cookie %q not found", name)
	return nil
}

func testClaims() host.Claims {
	return host.Claims{
		SubjectID:       testSubject,
		OrgID:           testOrg,
		SessionRevision: 4,
		VerifiedAt:      time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC),
	}
}

func testCSRF(t *testing.T) *api.CSRF {
	t.Helper()
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	csrf, err := api.NewCSRF([]byte(strings.Repeat("s", 32)), time.Hour, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	return csrf
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}
