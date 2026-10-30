package advance_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/advance"
	"github.com/we-meet/work/internal/fragment"
)

const (
	testExecutionID = "11111111-1111-4111-8111-111111111111"
	testRunID       = "22222222-2222-4222-8222-222222222222"
	testTaskID      = "33333333-3333-4333-8333-333333333333"
	testSnapshotID  = "44444444-4444-4444-8444-444444444444"
	testOperationID = "55555555-5555-4555-8555-555555555555"
	testAttemptID   = "66666666-6666-4666-8666-666666666666"
	testRefID       = "77777777-7777-4777-8777-777777777777"
	testHash        = "sha256:" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

func executeRequest() fragment.Request {
	return fragment.Request{
		Kind: fragment.KindRequest, Contract: fragment.ContractVersion,
		ExecutionID: testExecutionID, RunID: testRunID, TaskID: testTaskID,
		OrgID: "org_advance", SnapshotID: testSnapshotID,
		RuntimeVersion: "runtime-v1", Fence: "7",
		DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
		Mode:           "execute",
		Checkpoint:     &fragment.Reference{RefID: testRefID, Hash: testHash},
		Intent: &fragment.Intent{
			Request:     fragment.Reference{RefID: testRefID, Hash: testHash},
			RequestHash: testHash,
			LogicalKey:  "model:1",
		},
		Permit: &fragment.Permit{
			OperationID: testOperationID, DispatchAttemptID: testAttemptID, RequestHash: testHash,
		},
	}
}

func writePEM(t *testing.T, path, blockType string, der []byte) {
	t.Helper()
	body := pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der})
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
}

func newCA(t *testing.T) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "work-advance-test-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return certificate, key
}

func newClientCertificate(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "work-go-worker"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
}

// newMutualTLSServer starts an httptest TLS server that requires a client
// certificate signed by a generated CA. It returns a client configured for the
// same CA.
func newMutualTLSServer(t *testing.T, handler http.HandlerFunc) (*advance.Client, *httptest.Server) {
	t.Helper()
	ca, caKey := newCA(t)
	clientCert, clientKey := newClientCertificate(t, ca, caKey)

	dir := t.TempDir()
	certFile := filepath.Join(dir, "client.pem")
	keyFile := filepath.Join(dir, "client-key.pem")
	if err := os.WriteFile(certFile, clientCert, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, clientKey, 0o600); err != nil {
		t.Fatal(err)
	}

	clientCAs := x509.NewCertPool()
	clientCAs.AddCert(ca)
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{
		ClientCAs:  clientCAs,
		ClientAuth: tls.RequireAndVerifyClientCert,
		MinVersion: tls.VersionTLS12,
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	if server.Certificate() == nil {
		t.Fatal("test server has no certificate")
	}
	caFile := filepath.Join(dir, "server-ca.pem")
	writePEM(t, caFile, "CERTIFICATE", server.Certificate().Raw)

	client, err := advance.NewClient(advance.ClientConfig{
		BaseURL:  server.URL,
		CertFile: certFile,
		KeyFile:  keyFile,
		CAFile:   caFile,
		Timeout:  2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client, server
}

func TestAdvanceRoundTripsFragmentOverMutualTLS(t *testing.T) {
	var received fragment.Request
	client, _ := newMutualTLSServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != advance.Path {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
			t.Error("client certificate missing")
		}
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&received); err != nil {
			t.Errorf("request body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(fragment.Result{
			Kind: fragment.KindResult, Contract: fragment.ContractVersion,
			ExecutionID: testExecutionID, State: fragment.StateCheckpointed,
			Checkpoint: &fragment.Reference{RefID: testRefID, Hash: testHash},
			Receipt:    &fragment.Reference{RefID: testRefID, Hash: testHash},
		})
	})

	result, err := client.Advance(context.Background(), executeRequest())
	if err != nil {
		t.Fatalf("advance: %v", err)
	}
	if received.ExecutionID != testExecutionID || received.Mode != "execute" ||
		received.Permit == nil || received.Permit.OperationID != testOperationID {
		t.Fatalf("received request = %#v", received)
	}
	if result.State != fragment.StateCheckpointed || result.Receipt == nil || result.Checkpoint == nil {
		t.Fatalf("result = %#v", result)
	}
	if err := result.Validate(); err != nil {
		t.Fatalf("result validation: %v", err)
	}
}

func TestAdvanceMapsRemoteEnumerations(t *testing.T) {
	client, _ := newMutualTLSServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": advance.CodeResourceExhausted})
	})
	_, err := client.Advance(context.Background(), executeRequest())
	var remote *advance.RemoteError
	if !errors.As(err, &remote) {
		t.Fatalf("error = %v", err)
	}
	if remote.Status != http.StatusTooManyRequests || remote.Code != advance.CodeResourceExhausted {
		t.Fatalf("remote = %#v", remote)
	}
	if !remote.Retryable() {
		t.Fatal("resource_exhausted must be retryable")
	}
}

func TestAdvanceRejectsMalformedAndUnknownResultFields(t *testing.T) {
	responses := map[string]string{
		"malformed": `<html>gateway</html>`,
		"unknown field": `{"kind":"advance_result","contractVersion":"work-runtime-fragment-v1","executionId":"` +
			testExecutionID + `","state":"FAILED","errorCode":"runtime_fault","secret":"leak"}`,
		"trailing": `{"kind":"advance_result","contractVersion":"work-runtime-fragment-v1","executionId":"` +
			testExecutionID + `","state":"FAILED","errorCode":"runtime_fault"} {}`,
	}
	for name, body := range responses {
		t.Run(name, func(t *testing.T) {
			client, _ := newMutualTLSServer(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(body))
			})
			result, err := client.Advance(context.Background(), executeRequest())
			if err == nil {
				t.Fatalf("result = %#v, want error", result)
			}
			var transport *advance.TransportError
			if !errors.As(err, &transport) || transport.Code != advance.CodeInvalidResponse {
				t.Fatalf("error = %v", err)
			}
			if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "<html>") {
				t.Fatalf("error leaked response text: %v", err)
			}
		})
	}
}

func TestAdvanceRejectsMalformedRemoteErrorBodies(t *testing.T) {
	client, _ := newMutualTLSServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"code":"internal_error","detail":"secret"}`))
	})
	_, err := client.Advance(context.Background(), executeRequest())
	var remote *advance.RemoteError
	if !errors.As(err, &remote) || remote.Code != advance.CodeInvalidResponse {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("error leaked body: %v", err)
	}
}

func TestAdvancePropagatesContextDeadline(t *testing.T) {
	client, _ := newMutualTLSServer(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(500 * time.Millisecond):
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := client.Advance(ctx, executeRequest())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v", err)
	}
	var transport *advance.TransportError
	if !errors.As(err, &transport) || transport.Code != advance.CodeTransportTimeout {
		t.Fatalf("error = %v", err)
	}
}

func TestNewClientRequiresHTTPS(t *testing.T) {
	for _, baseURL := range []string{"", "http://127.0.0.1:8446", "not-a-url"} {
		if _, err := advance.NewClient(advance.ClientConfig{BaseURL: baseURL, Transport: http.DefaultTransport}); err == nil {
			t.Fatalf("base URL %q was accepted", baseURL)
		}
	}
}

func TestAdvanceRefusesOversizedOutboundRequest(t *testing.T) {
	calls := 0
	client, _ := newMutualTLSServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	})
	_, err := client.Advance(context.Background(), fragment.Request{OrgID: strings.Repeat("a", 20_000)})
	var transport *advance.TransportError
	if !errors.As(err, &transport) || transport.Code != advance.CodeBodyTooLarge {
		t.Fatalf("error = %v, want body_too_large", err)
	}
	if calls != 0 {
		t.Fatalf("oversized request reached the server %d times", calls)
	}
}
