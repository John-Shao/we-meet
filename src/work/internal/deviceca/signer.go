package deviceca

// This file is the custody boundary the device CA issues through. It is deliberately
// small: the backend is the configured key file, so the parsed private key is held in
// this process's memory (2026-11-22 P2 = pure file key plane, access control enforced by
// the deployment, not here). Nothing in this file rotates a key, attests to where a key
// lives, or reaches a KMS or PKCS#11 token; those remain the J39 sign-off item.
//
// What it buys is a name. LoadCA no longer hands the issuer's concrete key type to the
// rest of the package, so a future backend replaces fileSignerFromPEM rather than the
// certificate template in ca.go.

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
)

// fileSignerFromPEM is the file backend: it turns the configured CA key material into
// the crypto.Signer a CA signs with. It accepts PKCS#8 ("PRIVATE KEY") and SEC1
// ("EC PRIVATE KEY") encodings, which are what an operator's key file carries, and
// rejects anything that is not an EC key: a non-EC signer would produce certificates
// whose signature algorithm does not match the P-256 identity the device plane verifies.
func fileSignerFromPEM(keyPEM []byte) (crypto.Signer, error) {
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return nil, fmt.Errorf("deviceca: CA key is not a PEM block")
	}
	if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if key, ok := parsed.(*ecdsa.PrivateKey); ok {
			return key, nil
		}
		return nil, fmt.Errorf("deviceca: CA key is not an EC key")
	}
	key, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("deviceca: CA key is neither PKCS#8 nor SEC1 EC: %w", err)
	}
	return key, nil
}

// publicKeysMatch compares two public keys by their marshalled form, which is the
// comparison a crypto.Signer makes possible without naming a key type. Signing with a
// key that does not match the certificate would issue certificates no verifier can chain.
func publicKeysMatch(a, b crypto.PublicKey) bool {
	aDER, err := x509.MarshalPKIXPublicKey(a)
	if err != nil {
		return false
	}
	bDER, err := x509.MarshalPKIXPublicKey(b)
	if err != nil {
		return false
	}
	return bytes.Equal(aDER, bDER)
}
