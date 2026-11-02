package egressclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	testGrant = "11111111-2222-4333-8444-555555555555"
	testToken = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewClient(Config{BaseURL: server.URL, Transport: server.Client().Transport})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	return client
}

func TestProbeMapsEveryVerdict(t *testing.T) {
	cases := []struct {
		name        string
		status      int
		body        string
		wantVerdict Verdict
		wantErr     error
	}{
		{"ok", http.StatusOK, `{"outcome":"ok","elapsed_ms":12}`, VerdictOK, nil},
		{"rejected", http.StatusOK, `{"outcome":"rejected","code":"provider_rejected"}`, VerdictRejected, nil},
		{"unknown", http.StatusOK, `{"outcome":"unknown","code":"rate_limited"}`, VerdictUnknown, nil},
		{"refused", http.StatusOK, `{"outcome":"refused","code":"provider_context_unsupported"}`, VerdictRefused, nil},
		{"unknown outcome word", http.StatusOK, `{"outcome":"great"}`, "", ErrUnavailable},
		{"malformed body", http.StatusOK, `not json`, "", ErrUnavailable},
		{"grant invalid", http.StatusUnauthorized, `{"code":"probe_grant_invalid"}`, "", ErrGrantInvalid},
		{"unavailable", http.StatusServiceUnavailable, `{"code":"provider_context_unavailable"}`, "", ErrUnavailable},
		{"unexpected status", http.StatusTeapot, `{}`, "", ErrUnavailable},
	}
	for _, item := range cases {
		client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(item.status)
			_, _ = io.WriteString(w, item.body)
		})
		result, err := client.Probe(context.Background(), "org-1", testGrant, testToken)
		if item.wantErr != nil {
			if !errors.Is(err, item.wantErr) {
				t.Fatalf("%s: err = %v, want %v", item.name, err, item.wantErr)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: err = %v", item.name, err)
		}
		if result.Verdict != item.wantVerdict {
			t.Fatalf("%s: verdict = %q, want %q", item.name, result.Verdict, item.wantVerdict)
		}
	}
}

// TestProbeSendsTheBoundTriple checks the request the gateway authorises against, and
// that the single-use token never appears in an error string.
func TestProbeSendsTheBoundTriple(t *testing.T) {
	var seen probeRequest
	var path string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &seen); err != nil {
			t.Errorf("decode server-side: %v", err)
		}
		_, _ = io.WriteString(w, `{"outcome":"ok"}`)
	})
	if _, err := client.Probe(context.Background(), "org-9", testGrant, testToken); err != nil {
		t.Fatal(err)
	}
	if path != ProbePath {
		t.Fatalf("path = %q, want %q", path, ProbePath)
	}
	if seen.OrgID != "org-9" || seen.GrantID != testGrant || seen.Token != testToken {
		t.Fatalf("gateway received %+v", seen)
	}

	failing := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"code":"provider_context_unavailable"}`)
	})
	_, err := failing.Probe(context.Background(), "org-9", testGrant, testToken)
	if err == nil || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if strings.Contains(err.Error(), testToken) || strings.Contains(err.Error(), testGrant) {
		t.Fatalf("error leaked a credential: %v", err)
	}
}

func TestNewClientRequiresURL(t *testing.T) {
	if _, err := NewClient(Config{}); err == nil {
		t.Fatal("empty base URL accepted")
	}
	if _, err := NewClient(Config{BaseURL: "https://x.test/", CAFile: "/nope/ca.pem",
		Transport: nil}); err == nil {
		t.Fatal("unreadable CA accepted")
	}
}
