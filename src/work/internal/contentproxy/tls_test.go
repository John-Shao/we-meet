package contentproxy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type testCertificateAuthority struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
	pem         []byte
}

func newTestCertificateAuthority(t *testing.T) *testCertificateAuthority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "work-content-proxy-test-ca"},
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
	return &testCertificateAuthority{
		certificate: certificate,
		key:         key,
		pem:         pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
	}
}

func (ca *testCertificateAuthority) issue(t *testing.T, commonName string,
	usages []x509.ExtKeyUsage) (tls.Certificate, []byte, []byte) {
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
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return pair, certPEM, keyPEM
}

func writeTestFile(t *testing.T, name string, body []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestListenerUsesServerTLSAndBearer proves the 8444 listener follows D4 §6.3:
// server TLS plus the opaque work-content bearer. The child presents no client
// certificate, and a request without the bearer is still rejected.
func TestListenerUsesServerTLSAndBearer(t *testing.T) {
	ca := newTestCertificateAuthority(t)
	_, serverPEM, serverKeyPEM := ca.issue(t, "work-content-proxy-test",
		[]x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth})

	config := Config{
		ListenAddr: "127.0.0.1:0",
		CertFile:   writeTestFile(t, "server.crt", serverPEM),
		KeyFile:    writeTestFile(t, "server.key", serverKeyPEM),
	}

	reference := boundReference([]byte(testBody))
	server, err := New(config, &fakeAuthorizer{allowed: true},
		&fakeReferences{reference: reference}, &fakeStore{body: []byte(testBody)})
	if err != nil {
		t.Fatal(err)
	}
	tlsConfig, err := server.tlsConfig()
	if err != nil {
		t.Fatalf("tls config: %v", err)
	}
	if tlsConfig.ClientAuth == tls.RequireAndVerifyClientCert {
		t.Fatal("listener requires a client certificate; the signed contract is server TLS plus bearer")
	}

	testingServer := httptest.NewUnstartedServer(server.Handler())
	testingServer.TLS = tlsConfig
	testingServer.StartTLS()
	t.Cleanup(testingServer.Close)

	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca.pem) {
		t.Fatal("append test CA")
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		RootCAs:    roots,
		ServerName: "work-content-proxy-test",
		MinVersion: tls.VersionTLS12,
	}}}
	address := testingServer.Listener.Addr().String()
	newRequest := func() *http.Request {
		request, err := http.NewRequest(http.MethodGet,
			"https://"+address+"/internal/v1/content/"+testRefID, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set(HeaderAuthorization, "Bearer "+testToken)
		request.Header.Set(HeaderOrg, testOrg)
		request.Header.Set(HeaderExecution, testExecution)
		request.Header.Set(HeaderGeneration, "1")
		return request
	}

	response, err := client.Do(newRequest())
	if err != nil {
		t.Fatalf("server-TLS read without a client certificate: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("bound read status = %d, want 200", response.StatusCode)
	}

	missing := newRequest()
	missing.Header.Del(HeaderAuthorization)
	rejected, err := client.Do(missing)
	if err != nil {
		t.Fatalf("bearer-less request: %v", err)
	}
	defer rejected.Body.Close()
	if rejected.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bearer-less status = %d, want 401", rejected.StatusCode)
	}
}

func TestTLSConfigRequiresAllMaterial(t *testing.T) {
	server, err := New(Config{}, &fakeAuthorizer{}, &fakeReferences{}, &fakeStore{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.tlsConfig(); err == nil {
		t.Fatal("tls config without certificate material succeeded")
	}
	if server.config.ListenAddr != DefaultListenAddr {
		t.Fatalf("default listen addr = %q", server.config.ListenAddr)
	}
}

func TestNewRequiresDependencies(t *testing.T) {
	if _, err := New(Config{}, nil, &fakeReferences{}, &fakeStore{}); err == nil {
		t.Fatal("nil authorizer accepted")
	}
	if _, err := New(Config{}, &fakeAuthorizer{}, nil, &fakeStore{}); err == nil {
		t.Fatal("nil references accepted")
	}
	if _, err := New(Config{}, &fakeAuthorizer{}, &fakeReferences{}, nil); err == nil {
		t.Fatal("nil store accepted")
	}
}
