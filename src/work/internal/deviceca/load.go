package deviceca

import (
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"time"
)

// LoadCA reads a certificate authority from configuration: the CA certificate PEM and
// its EC private key PEM (PKCS#8 "PRIVATE KEY" or SEC1 "EC PRIVATE KEY"). work-api uses
// it to issue the clientAuth device certificate §2.1 step 3 requires, so the key comes
// from the deployment's configuration rather than being generated in process. The key
// material becomes a CA through the file backend in signer.go; the checks here are the
// certificate's own preconditions (it is a cert-signing CA, unexpired) plus the
// key/certificate match.
//
// This is the injection point, NOT production custody. Where the key lives, who may read
// it, how it rotates and the TPM-vs-software-CNG enterprise policy remain the J39
// sign-off item; nothing here claims them.
func LoadCA(certPEM, keyPEM []byte) (*CA, error) {
	if len(certPEM) == 0 || len(keyPEM) == 0 {
		return nil, fmt.Errorf("deviceca: CA certificate and key are both required")
	}
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, fmt.Errorf("deviceca: CA certificate is not a PEM CERTIFICATE block")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("deviceca: parse CA certificate: %w", err)
	}
	if !cert.IsCA || cert.KeyUsage&x509.KeyUsageCertSign == 0 {
		return nil, fmt.Errorf("deviceca: configured certificate is not a cert-signing CA")
	}
	if !time.Now().Before(cert.NotAfter) {
		return nil, fmt.Errorf("deviceca: configured CA certificate has expired")
	}
	signer, err := fileSignerFromPEM(keyPEM)
	if err != nil {
		return nil, err
	}
	if !publicKeysMatch(signer.Public(), cert.PublicKey) {
		return nil, fmt.Errorf("deviceca: CA key does not match the CA certificate")
	}
	return &CA{
		Cert:    cert,
		Signer:  signer,
		CertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}),
	}, nil
}
