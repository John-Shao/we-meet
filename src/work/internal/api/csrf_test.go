package api_test

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/api"
)

func TestCSRFIssueAndVerify(t *testing.T) {
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	csrf, err := api.NewCSRF([]byte(strings.Repeat("s", 32)), time.Hour, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	token, err := csrf.Issue("sub_a", "org_a", 4)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, "v1.") {
		t.Fatalf("token = %q", token)
	}
	if err := csrf.Verify(token, "sub_a", "org_a", 4); err != nil {
		t.Fatalf("verify: %v", err)
	}
	for _, tc := range []struct {
		name  string
		token string
		sub   string
		org   string
		rev   int64
	}{
		{"subject", token, "sub_b", "org_a", 4},
		{"org", token, "sub_a", "org_b", 4},
		{"revision", token, "sub_a", "org_a", 5},
		{"tampered", token + "x", "sub_a", "org_a", 4},
		{"malformed", "not-a-token", "sub_a", "org_a", 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := csrf.Verify(tc.token, tc.sub, tc.org, tc.rev); !errors.Is(err, api.ErrCSRFInvalid) {
				t.Fatalf("error = %v, want csrf invalid", err)
			}
		})
	}
}

func TestCSRFRejectsExpiredToken(t *testing.T) {
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	csrf, err := api.NewCSRF([]byte(strings.Repeat("s", 32)), time.Minute, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	token, err := csrf.Issue("sub_a", "org_a", 4)
	if err != nil {
		t.Fatal(err)
	}
	later := now.Add(2 * time.Minute)
	expired, err := api.NewCSRF([]byte(strings.Repeat("s", 32)), time.Minute, func() time.Time { return later })
	if err != nil {
		t.Fatal(err)
	}
	if err := expired.Verify(token, "sub_a", "org_a", 4); !errors.Is(err, api.ErrCSRFInvalid) {
		t.Fatalf("error = %v, want csrf invalid", err)
	}
}

func TestCSRFCookieAttributes(t *testing.T) {
	csrf, err := api.NewCSRF([]byte(strings.Repeat("s", 32)), time.Hour, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	token, err := csrf.Issue("sub_a", "org_a", 4)
	if err != nil {
		t.Fatal(err)
	}
	cookie := csrf.SetCookie(token)
	if cookie.Name != api.CSRFCookieName || cookie.Value != token {
		t.Fatalf("cookie = %#v", cookie)
	}
	if cookie.Path != "/work" || !cookie.Secure || cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie attributes = %#v", cookie)
	}
	if cookie.MaxAge != 3600 {
		t.Fatalf("max age = %d", cookie.MaxAge)
	}
}

func TestCSRFRequiresStrongSecret(t *testing.T) {
	if _, err := api.NewCSRF([]byte("short"), time.Hour, time.Now); err == nil {
		t.Fatal("short secret accepted")
	}
}
