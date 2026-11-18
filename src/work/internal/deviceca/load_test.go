package deviceca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"testing"
	"time"
)

func keyPEM(t *testing.T, key any) []byte {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

// expiredCAPEM self-signs a CA whose validity is already over, so the loader's expiry
// refusal is exercised against a real certificate rather than a mutated struct.
func expiredCAPEM(t *testing.T) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "expired-ca"},
		NotBefore:             time.Now().Add(-48 * time.Hour),
		NotAfter:              time.Now().Add(-24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), keyPEM(t, key)
}

func TestLoadCARoundTripsAConfiguredCA(t *testing.T) {
	ca, err := NewCA()
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadCA(ca.CertPEM, keyPEM(t, ca.Key))
	if err != nil {
		t.Fatalf("LoadCA: %v", err)
	}
	if string(loaded.Cert.Raw) != string(ca.Cert.Raw) {
		t.Fatal("loaded CA certificate differs from the configured one")
	}
	if !loaded.Key.Equal(ca.Key) {
		t.Fatal("loaded CA key differs from the configured one")
	}
	// The loaded CA must still issue a device certificate that chains to it: loading is
	// not a parse-only exercise, it is the production issuance path.
	deviceKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	chain, err := loaded.IssueDeviceCert("device-1", "org-1", &deviceKey.PublicKey)
	if err != nil {
		t.Fatalf("IssueDeviceCert from a loaded CA: %v", err)
	}
	leaf, err := x509.ParseCertificate(chain.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := leaf.CheckSignatureFrom(loaded.Cert); err != nil {
		t.Fatalf("issued leaf does not chain to the loaded CA: %v", err)
	}

	// SEC1 is the other encoding an operator's key file may carry.
	sec1, err := x509.MarshalECPrivateKey(ca.Key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCA(ca.CertPEM, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: sec1})); err != nil {
		t.Fatalf("LoadCA with a SEC1 key: %v", err)
	}
}

func TestLoadCARefusesUnusableMaterial(t *testing.T) {
	ca, err := NewCA()
	if err != nil {
		t.Fatal(err)
	}
	good := keyPEM(t, ca.Key)

	for _, tc := range []struct {
		name     string
		cert, key []byte
	}{
		{"empty cert", nil, good},
		{"empty key", ca.CertPEM, nil},
		{"cert not PEM", []byte("not a certificate"), good},
		{"key not PEM", ca.CertPEM, []byte("not a key")},
	} {
		if _, err := LoadCA(tc.cert, tc.key); err == nil {
			t.Fatalf("%s was accepted", tc.name)
		}
	}

	// A clientAuth leaf is not a CA: loading it would let the API sign with a certificate
	// that cannot issue, and every device cert would fail chain verification.
	deviceKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafChain, err := ca.IssueDeviceCert("device-1", "org-1", &deviceKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	leafPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafChain.Certificate[0]})
	if _, err := LoadCA(leafPEM, good); err == nil {
		t.Fatal("a non-CA leaf was accepted as a CA")
	}

	// A key that does not match the certificate would sign certificates nobody can verify.
	otherKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCA(ca.CertPEM, keyPEM(t, otherKey)); err == nil {
		t.Fatal("a mismatched CA key was accepted")
	}

	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCA(ca.CertPEM, keyPEM(t, rsaKey)); err == nil {
		t.Fatal("a non-EC CA key was accepted")
	}

	expiredCert, expiredKey := expiredCAPEM(t)
	if _, err := LoadCA(expiredCert, expiredKey); err == nil {
		t.Fatal("an expired CA was accepted")
	}
}