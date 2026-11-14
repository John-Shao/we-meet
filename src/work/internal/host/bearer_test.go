package host_test

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/we-meet/work/internal/host"
)

func TestVerifyBearer(t *testing.T) {
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/work-host/v3/sessions/verify" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 ||
			r.TLS.PeerCertificates[0].Subject.CommonName != "work-control-plane" {
			t.Errorf("client certificate missing or wrong identity")
		}
		if got := r.Header.Get("Authorization"); got != "Bearer native-token" {
			t.Errorf("authorization = %q", got)
		}
		if got := r.Header.Get("X-Work-Request-ID"); got != "corr-b" {
			t.Errorf("correlation = %q", got)
		}
		// The bearer port must not receive a session cookie.
		if _, err := r.Cookie(host.SessionCookieName); err == nil {
			t.Errorf("bearer request carried a session cookie")
		}
		writeClaims(t, w, now.Add(-5*time.Second))
	})
	client := newClient(t, server.URL, pki, now)
	claims, err := client.VerifyBearer(context.Background(), "native-token", "corr-b")
	if err != nil {
		t.Fatal(err)
	}
	if claims.SubjectID != "sub_1" || claims.OrgID != "org_1" || claims.SessionRevision != 4 {
		t.Fatalf("claims = %#v", claims)
	}
	if claims.AuthPlane != "bearer" {
		t.Fatalf("auth plane = %q, want bearer", claims.AuthPlane)
	}
	if !claims.VerifiedAt.Equal(now.Add(-5 * time.Second)) {
		t.Fatalf("verified_at = %s", claims.VerifiedAt)
	}
}

func TestVerifyBearerRejectsHostFailures(t *testing.T) {
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	cases := []struct {
		name     string
		status   int
		body     string
		wantCode string
	}{
		{"unauthorized", http.StatusUnauthorized, `{}`, "session_invalid"},
		{"forbidden", http.StatusForbidden, `{}`, "session_unverifiable"},
		{"unavailable", http.StatusServiceUnavailable, `{}`, "session_unverifiable"},
		{"missing field", http.StatusOK, `{"subject_id":"sub_1","org_id":"org_1","session_revision":4}`, "host_field_gap"},
		{"extra field", http.StatusOK, fmt.Sprintf(`{"subject_id":"sub_1","org_id":"org_1","session_revision":4,"verified_at":%q,"extra":1}`, now.UTC().Format(time.RFC3339Nano)), "session_unverifiable"},
		{"stale", http.StatusOK, fmt.Sprintf(`{"subject_id":"sub_1","org_id":"org_1","session_revision":4,"verified_at":%q}`, now.Add(-61*time.Second).UTC().Format(time.RFC3339Nano)), "session_stale"},
		{"future", http.StatusOK, fmt.Sprintf(`{"subject_id":"sub_1","org_id":"org_1","session_revision":4,"verified_at":%q}`, now.Add(6*time.Second).UTC().Format(time.RFC3339Nano)), "session_invalid"},
		{"negative revision", http.StatusOK, fmt.Sprintf(`{"subject_id":"sub_1","org_id":"org_1","session_revision":-1,"verified_at":%q}`, now.UTC().Format(time.RFC3339Nano)), "session_invalid"},
		{"malformed", http.StatusOK, `{`, "session_unverifiable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			client := newClient(t, server.URL, pki, now)
			_, err := client.VerifyBearer(context.Background(), "native-token", "corr-b")
			assertCode(t, err, tc.wantCode)
		})
	}
}

func TestVerifyBearerRequiresToken(t *testing.T) {
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("server must not be called without a token")
	})
	client := newClient(t, server.URL, pki, time.Now())
	for _, token := range []string{"", "   ", "bad\r\ntoken"} {
		_, err := client.VerifyBearer(context.Background(), token, "corr")
		assertCode(t, err, "session_invalid")
	}
}

func TestVerifyBearerDoesNotCache(t *testing.T) {
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	var calls int32
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeClaims(t, w, now)
	})
	client := newClient(t, server.URL, pki, now)
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := client.VerifyBearer(context.Background(), "native-token", "corr-cache"); err != nil {
			t.Fatal(err)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("Host calls = %d, want 2 (positive results must not be cached)", got)
	}
}

func TestVerifyPlanesAreNamespaced(t *testing.T) {
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeClaims(t, w, now)
	})
	client := newClient(t, server.URL, pki, now)

	cookie, err := client.VerifySession(context.Background(), "session-value", "corr")
	if err != nil {
		t.Fatal(err)
	}
	bearer, err := client.VerifyBearer(context.Background(), "native-token", "corr")
	if err != nil {
		t.Fatal(err)
	}
	if cookie.AuthPlane != "cookie" || bearer.AuthPlane != "bearer" {
		t.Fatalf("planes = %q / %q", cookie.AuthPlane, bearer.AuthPlane)
	}
}