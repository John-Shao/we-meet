package authz_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/we-meet/work/internal/authz"
)

type testCA struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
	pem         []byte
}

func newTestCA(t *testing.T) *testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "work-test-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &testCA{
		certificate: certificate, key: key,
		pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
	}
}

func (ca *testCA) issue(t *testing.T, commonName string, usages []x509.ExtKeyUsage) (tls.Certificate, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: commonName},
		DNSNames:     []string{commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  usages,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.certificate, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return pair, certPEM
}

func writeFile(t *testing.T, name string, body []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestMutualTLSRoundTrip proves the deployed shape: a certificate-authenticated
// caller reaches the authorization handler and an unauthenticated one is
// rejected during the handshake, not by the handler.
func TestMutualTLSRoundTrip(t *testing.T) {
	ca := newTestCA(t)
	serverPair, _ := ca.issue(t, "work-authz", []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth})
	clientPair, clientPEM := ca.issue(t, "parent", []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth})
	_ = clientPair

	clientRoots := x509.NewCertPool()
	clientRoots.AppendCertsFromPEM(ca.pem)
	serverPool := x509.NewCertPool()
	serverPool.AppendCertsFromPEM(ca.pem)
	serverPool.AppendCertsFromPEM(clientPEM)

	commands := &fakeCommands{}

	// Derive the real fingerprint from the issued leaf.
	leaf, err := x509.ParseCertificate(clientPair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	realVerifier, err := authz.NewRegistryVerifier(map[string]authz.Caller{
		fingerprint(leaf): {Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"},
	})
	if err != nil {
		t.Fatal(err)
	}
	server, err := authz.NewServer(realVerifier, commands, commands)
	if err != nil {
		t.Fatal(err)
	}

	httptestServer := httptest.NewUnstartedServer(server.Handler())
	httptestServer.TLS = &tls.Config{
		Certificates: []tls.Certificate{serverPair},
		ClientCAs:    serverPool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS12,
	}
	httptestServer.StartTLS()
	t.Cleanup(httptestServer.Close)

	_, port, err := net.SplitHostPort(httptestServer.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(clientPair.PrivateKey.(*ecdsa.PrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	certPath := writeFile(t, "client.crt", clientPEM)
	keyPath := writeFile(t, "client.key", keyPEM)
	caPath := writeFile(t, "ca.crt", ca.pem)

	client, err := authz.NewClient(authz.ClientConfig{
		BaseURL:  "https://127.0.0.1:" + port,
		CertFile: certPath, KeyFile: keyPath, CAFile: caPath,
		ServerName: "work-authz", Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := client.Claim(context.Background(), authz.ExecutionRequest{OrgID: "org_a", ExecutionID: "exec-1"})
	if err != nil {
		t.Fatalf("mTLS claim: %v", err)
	}
	if lease.State != "claimed" || lease.HolderID == "" {
		t.Fatalf("lease = %#v", lease)
	}
	if commands.callers[0].WorkloadID != "parent-workload" {
		t.Fatalf("caller = %#v", commands.callers[0])
	}

	// A client without a certificate must fail the handshake.
	anonymous := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		RootCAs: clientRoots, ServerName: "work-authz", MinVersion: tls.VersionTLS12,
	}}}
	request, err := http.NewRequest(http.MethodPost,
		"https://127.0.0.1:"+port+"/internal/v1/commands/claim_runtime_execution", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := anonymous.Do(request); err == nil {
		t.Fatal("request without a client certificate was accepted")
	}
}
