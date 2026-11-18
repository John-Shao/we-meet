// Package deviceca issues the clientAuth device certificates and the gateway server
// certificate for the R0b device plane. It has two entry points: NewCA generates a
// self-signed TEST-ONLY CA for tests and local development, and LoadCA (GW20) reads a CA
// from deployment configuration so work-api can issue the certificate device-design §2.1
// step 3 requires at pairing confirm and at renewal.
//
// Loading a configured CA is NOT production custody. Where the key lives, who may read
// it, how it rotates and the enterprise TPM-vs-software-CNG policy are a separate
// sign-off item (device-design §2.1 step 4, §2.1:55 installation matrix; control-design
// §10 lists 设备CA/证书轮换 as a J39 independent-review surface) and remain deferred.
// Nothing here claims production security or hardware attestation.
package deviceca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"time"
)

// DeviceCertTTL is the device certificate lifetime (device-design §2.1 step 4: 24h).
const DeviceCertTTL = 24 * time.Hour

// CA is a self-signed certificate authority used only for tests/local development.
type CA struct {
	Cert    *x509.Certificate
	Key     *ecdsa.PrivateKey
	CertPEM []byte
}

// NewCA creates a self-signed P-256 CA valid for one year.
func NewCA() (*CA, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("deviceca: generate CA key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("deviceca: CA serial: %w", err)
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "work-device-test-ca", Organization: []string{"we-meet-test"}},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("deviceca: self-sign CA: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("deviceca: parse CA: %w", err)
	}
	return &CA{Cert: cert, Key: key, CertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}, nil
}

// Pool returns a cert pool trusting this CA, for mTLS peer verification.
func (c *CA) Pool() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(c.Cert)
	return pool
}

// IssueDeviceCert signs a clientAuth certificate binding the device public key to
// (deviceID, orgID). The device holds the private key (CNG in production, a software
// key in tests); the CA only ever sees the public key. deviceID goes in the CN and
// orgID in the OU so the gateway can map the mTLS peer to a tenant device without
// trusting any client-self-reported role (device-design §2.1 step 4).
func (c *CA) IssueDeviceCert(deviceID, orgID string, pub *ecdsa.PublicKey) (tls.Certificate, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("deviceca: device serial: %w", err)
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: deviceID, OrganizationalUnit: []string{orgID}},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(DeviceCertTTL),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, c.Cert, pub, c.Key)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("deviceca: sign device cert: %w", err)
	}
	// The caller supplies the device private key; here we return the cert chain only.
	return tls.Certificate{Certificate: [][]byte{der, c.Cert.Raw}}, nil
}

// IssueServerCert signs a serverAuth certificate for the gateway TLS listener.
func (c *CA) IssueServerCert(hosts []string) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("deviceca: server key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("deviceca: server serial: %w", err)
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "work-gateway-test"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(DeviceCertTTL),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     hosts,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, c.Cert, &key.PublicKey, c.Key)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("deviceca: sign server cert: %w", err)
	}
	return tls.Certificate{Certificate: [][]byte{der, c.Cert.Raw}, PrivateKey: key}, nil
}

// ServerTLSConfig builds the gateway mTLS listener config: it presents the server
// certificate and requires a client certificate chained to this CA.
func ServerTLSConfig(ca *CA, serverCert tls.Certificate) *tls.Config {
	return &tls.Config{
		Certificates: []tls.Certificate{serverCert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    ca.Pool(),
		MinVersion:   tls.VersionTLS13,
	}
}

// ClientTLSConfig builds the device mTLS dial config: it presents the device
// certificate and verifies the gateway server certificate against this CA.
func ClientTLSConfig(ca *CA, deviceCert tls.Certificate, serverName string) *tls.Config {
	return &tls.Config{
		Certificates: []tls.Certificate{deviceCert},
		RootCAs:      ca.Pool(),
		ServerName:   serverName,
		MinVersion:   tls.VersionTLS13,
	}
}

// DeviceIdentity extracts the (deviceID, orgID) the CA bound into a peer certificate.
// It is the server-side mapping the gateway trusts because the CA signed it; the
// client cannot forge it without the CA key.
func DeviceIdentity(cert *x509.Certificate) (deviceID, orgID string, err error) {
	if cert == nil {
		return "", "", fmt.Errorf("deviceca: no peer certificate")
	}
	deviceID = cert.Subject.CommonName
	if len(cert.Subject.OrganizationalUnit) > 0 {
		orgID = cert.Subject.OrganizationalUnit[0]
	}
	if deviceID == "" || orgID == "" {
		return "", "", fmt.Errorf("deviceca: peer certificate carries no device identity")
	}
	return deviceID, orgID, nil
}
