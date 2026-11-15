package deviceca_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"testing"

	"github.com/we-meet/work/internal/deviceca"
)

// The CA is test-only (see package doc); these checks pin the identity binding the
// gateway relies on: a device certificate carries (deviceID, orgID) the gateway can
// map, is clientAuth-only, and chains to the CA pool that verifies it.
func TestDeviceCertCarriesIdentityAndChainsToCA(t *testing.T) {
	ca, err := deviceca.NewCA()
	if err != nil {
		t.Fatal(err)
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := ca.IssueDeviceCert("device-123", "org-abc", &priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(cert.Certificate) == 0 {
		t.Fatal("device certificate has no DER chain")
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	deviceID, orgID, err := deviceca.DeviceIdentity(leaf)
	if err != nil {
		t.Fatal(err)
	}
	if deviceID != "device-123" || orgID != "org-abc" {
		t.Fatalf("identity = (%q,%q)", deviceID, orgID)
	}
	if len(leaf.ExtKeyUsage) != 1 || leaf.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
		t.Fatalf("device cert ExtKeyUsage = %v, want clientAuth only", leaf.ExtKeyUsage)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:     ca.Pool(),
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		t.Fatalf("device cert does not chain to CA: %v", err)
	}
}

func TestDeviceIdentityRefusesEmptyCert(t *testing.T) {
	if _, _, err := deviceca.DeviceIdentity(nil); err == nil {
		t.Fatal("expected refusal for nil certificate")
	}
}

func TestServerTLSRequiresClientCert(t *testing.T) {
	ca, err := deviceca.NewCA()
	if err != nil {
		t.Fatal(err)
	}
	serverCert, err := ca.IssueServerCert([]string{"localhost"})
	if err != nil {
		t.Fatal(err)
	}
	cfg := deviceca.ServerTLSConfig(ca, serverCert)
	if cfg.ClientAuth != tls.RequireAndVerifyClientCert {
		t.Fatalf("ClientAuth = %v, want RequireAndVerifyClientCert", cfg.ClientAuth)
	}
	if cfg.MinVersion != tls.VersionTLS13 {
		t.Fatalf("MinVersion = %v, want TLS1.3", cfg.MinVersion)
	}
}
