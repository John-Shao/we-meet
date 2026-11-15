package devicesig

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"math/big"
)

// ErrSignature is returned for any malformed ES256 signature: wrong length,
// padding, non-alphabet characters, or out-of-range R/S. DER is never accepted.
var ErrSignature = errors.New("devicesig: signature is not a 64-byte base64url R||S")

// VerifyES256 verifies a fixed 64-byte R||S ES256 signature (base64url, no
// padding) over SHA-256(msg). It rejects DER, padded base64, wrong lengths and
// out-of-range scalars rather than attempting to coerce them (device-design §2.1:
// "禁止两种 DER/raw 编码混用").
func VerifyES256(pub *ecdsa.PublicKey, msg []byte, signatureB64 string) bool {
	sig, err := decodeSignature(signatureB64)
	if err != nil {
		return false
	}
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	digest := sha256.Sum256(msg)
	return ecdsa.Verify(pub, digest[:], r, s)
}

// decodeSignature decodes the base64url-no-padding signature into exactly 64
// bytes with both scalars in [1, n-1].
func decodeSignature(signatureB64 string) ([]byte, error) {
	// RawURLEncoding rejects '=' padding and non-alphabet bytes.
	sig, err := base64.RawURLEncoding.DecodeString(signatureB64)
	if err != nil || len(sig) != 64 {
		return nil, ErrSignature
	}
	n := ellipticP256N()
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	if r.Sign() == 0 || s.Sign() == 0 || r.Cmp(n) >= 0 || s.Cmp(n) >= 0 {
		return nil, ErrSignature
	}
	return sig, nil
}

// ellipticP256N is the order of the P-256 base point.
func ellipticP256N() *big.Int { return elliptic.P256().Params().N }
