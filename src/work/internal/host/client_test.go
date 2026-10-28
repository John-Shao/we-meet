package host_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/we-meet/work/internal/host"
)

type testPKI struct {
	caFile         string
	clientCertFile string
	clientKeyFile  string
	serverCert     tls.Certificate
	roots          *x509.CertPool
}

func TestVerifySession(t *testing.T) {
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/work-host/v2/sessions/verify" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 ||
			r.TLS.PeerCertificates[0].Subject.CommonName != "work-control-plane" {
			t.Errorf("client certificate missing or wrong identity")
		}
		cookie, err := r.Cookie(host.SessionCookieName)
		if err != nil || cookie.Value != "session-value" {
			t.Errorf("cookie = %v, %v", cookie, err)
		}
		if got := r.Header.Get("X-Work-Request-ID"); got != "corr-1" {
			t.Errorf("correlation = %q", got)
		}
		writeClaims(t, w, now.Add(-5*time.Second))
	})
	client := newClient(t, server.URL, pki, now)
	claims, err := client.VerifySession(context.Background(), "session-value", "corr-1")
	if err != nil {
		t.Fatal(err)
	}
	if claims.SubjectID != "sub_1" || claims.OrgID != "org_1" || claims.SessionRevision != 4 {
		t.Fatalf("claims = %#v", claims)
	}
	if !claims.VerifiedAt.Equal(now.Add(-5 * time.Second)) {
		t.Fatalf("verified_at = %s", claims.VerifiedAt)
	}
}

func TestVerifySessionRejectsHostFailures(t *testing.T) {
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	cases := []struct {
		name     string
		status   int
		body     string
		wantCode string
	}{
		{"unauthorized", http.StatusUnauthorized, `{}`, "session_invalid"},
		{"unavailable", http.StatusServiceUnavailable, `{}`, "session_unverifiable"},
		{"missing field", http.StatusOK, `{"subject_id":"sub_1","org_id":"org_1","session_revision":4}`, "host_field_gap"},
		{"extra field", http.StatusOK, fmt.Sprintf(`{"subject_id":"sub_1","org_id":"org_1","session_revision":4,"verified_at":%q,"extra":1}`, now.UTC().Format(time.RFC3339Nano)), "session_unverifiable"},
		{"stale", http.StatusOK, fmt.Sprintf(`{"subject_id":"sub_1","org_id":"org_1","session_revision":4,"verified_at":%q}`, now.Add(-61*time.Second).UTC().Format(time.RFC3339Nano)), "session_stale"},
		{"future", http.StatusOK, fmt.Sprintf(`{"subject_id":"sub_1","org_id":"org_1","session_revision":4,"verified_at":%q}`, now.Add(6*time.Second).UTC().Format(time.RFC3339Nano)), "session_invalid"},
		{"malformed", http.StatusOK, `{`, "session_unverifiable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			client := newClient(t, server.URL, pki, now)
			_, err := client.VerifySession(context.Background(), "session-value", "corr-1")
			assertCode(t, err, tc.wantCode)
		})
	}
}

func TestVerifySessionRequiresCookie(t *testing.T) {
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("server must not be called without a cookie")
	})
	client := newClient(t, server.URL, pki, time.Now())
	_, err := client.VerifySession(context.Background(), "", "corr")
	assertCode(t, err, "session_invalid")
	_, err = client.VerifySession(context.Background(), "bad\r\ncookie", "corr")
	assertCode(t, err, "session_invalid")
}

func TestVerifySessionTimesOut(t *testing.T) {
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(100 * time.Millisecond)
		writeClaims(t, w, now)
	})
	client, err := host.NewClient(host.Config{
		BaseURL:        server.URL,
		ClientCertFile: pki.clientCertFile,
		ClientKeyFile:  pki.clientKeyFile,
		CAFile:         pki.caFile,
		Timeout:        10 * time.Millisecond,
		Now:            func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.VerifySession(context.Background(), "session-value", "corr-timeout")
	assertCode(t, err, "session_unverifiable")
}

func TestVerifySessionDoesNotCache(t *testing.T) {
	now := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	var calls int32
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeClaims(t, w, now)
	})
	client := newClient(t, server.URL, pki, now)
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := client.VerifySession(context.Background(), "session-value", "corr-cache"); err != nil {
			t.Fatal(err)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("Host calls = %d, want 2 (positive results must not be cached)", got)
	}
}

func TestServerRequiresClientCertificate(t *testing.T) {
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler must not run without client certificate")
	})
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		RootCAs:    pki.roots,
		ServerName: "127.0.0.1",
		MinVersion: tls.VersionTLS12,
	}}}
	_, err := client.Post(server.URL+"/work-host/v2/sessions/verify", "application/json", nil)
	if err == nil {
		t.Fatal("mTLS server accepted a client without a certificate")
	}
}

func TestNewClientRequiresHTTPS(t *testing.T) {
	_, err := host.NewClient(host.Config{BaseURL: "http://localhost:8080"})
	if err == nil {
		t.Fatal("http base URL accepted")
	}
	var hostErr *host.Error
	if !errors.As(err, &hostErr) || hostErr.Code != "host_config_invalid" {
		t.Fatalf("error = %v", err)
	}
}

func startHostServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, testPKI) {
	t.Helper()
	pki := newTestPKI(t)
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{
		Certificates: []tls.Certificate{pki.serverCert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pki.roots,
		MinVersion:   tls.VersionTLS12,
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server, pki
}

func newClient(t *testing.T, baseURL string, pki testPKI, now time.Time) *host.Client {
	t.Helper()
	client, err := host.NewClient(host.Config{
		BaseURL:        baseURL,
		ClientCertFile: pki.clientCertFile,
		ClientKeyFile:  pki.clientKeyFile,
		CAFile:         pki.caFile,
		Timeout:        2 * time.Second,
		Now:            func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func writeClaims(t *testing.T, w http.ResponseWriter, verifiedAt time.Time) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w,
		`{"subject_id":"sub_1","org_id":"org_1","session_revision":4,"verified_at":%q}`,
		verifiedAt.UTC().Format(time.RFC3339Nano),
	)
}

func assertCode(t *testing.T, err error, code string) {
	t.Helper()
	var hostErr *host.Error
	if !errors.As(err, &hostErr) {
		t.Fatalf("error = %v, want host error %s", err, code)
	}
	if hostErr.Code != code {
		t.Fatalf("code = %q, want %q (%v)", hostErr.Code, code, err)
	}
}

func newTestPKI(t *testing.T) testPKI {
	t.Helper()
	now := time.Now()
	caKey := mustKey(t)
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(now.UnixNano()),
		Subject:               pkix.Name{CommonName: "work-host-test-ca"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}

	serverKey := mustKey(t)
	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(now.UnixNano() + 1),
		Subject:      pkix.Name{CommonName: "work-host-test-server"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caCert, &serverKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}

	clientKey := mustKey(t)
	clientTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(now.UnixNano() + 2),
		Subject:      pkix.Name{CommonName: "work-control-plane"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	clientDER, err := x509.CreateCertificate(rand.Reader, clientTemplate, caCert, &clientKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	caFile := filepath.Join(dir, "ca.pem")
	clientCertFile := filepath.Join(dir, "client.pem")
	clientKeyFile := filepath.Join(dir, "client-key.pem")
	writePEM(t, caFile, "CERTIFICATE", caDER, 0o600)
	writePEM(t, clientCertFile, "CERTIFICATE", clientDER, 0o600)
	writePEM(t, clientKeyFile, "EC PRIVATE KEY", mustMarshalKey(t, clientKey), 0o600)
	serverCert, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: mustMarshalKey(t, serverKey)}),
	)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	return testPKI{
		caFile:         caFile,
		clientCertFile: clientCertFile,
		clientKeyFile:  clientKeyFile,
		serverCert:     serverCert,
		roots:          roots,
	}
}

func mustKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func mustMarshalKey(t *testing.T, key *ecdsa.PrivateKey) []byte {
	t.Helper()
	body, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func writePEM(t *testing.T, path, kind string, body []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: body}), mode); err != nil {
		t.Fatal(err)
	}
}
