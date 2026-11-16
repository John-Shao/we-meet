package devicesig

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
)

// GenerateSigningKey generates a software P-256 signing key. TEST-ONLY: the
// production server signing key belongs to KMS/HSM with rotation and independent
// review (J39), deferred. The gateway holds this key to sign downlink frames
// (operation_resolution/permit/lease/command/finish_ack); the device verifies them
// against the public JWK distributed in hello_ack.
func GenerateSigningKey() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

// SignES256 produces a fixed 64-byte R||S ES256 signature (base64url, no padding)
// over SHA-256(msg) — the exact form VerifyES256 accepts and the Rust device emits
// (device-design §2.1: never DER, no padding). It is the signing inverse of the
// verification path, reproducing the same conventions byte for byte.
func SignES256(priv *ecdsa.PrivateKey, msg []byte) (string, error) {
	digest := sha256.Sum256(msg)
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return base64.RawURLEncoding.EncodeToString(sig), nil
}

// SignFrame signs a frame body over {schema_version, type, body} with the body's
// signature field stripped — the server-side counterpart of VerifyFrame. type +
// schema_version give domain separation, so a resolution signature never verifies
// as a permit or a receipt.
func SignFrame(priv *ecdsa.PrivateKey, frameType string, bodyJSON []byte) (string, error) {
	preimage, err := SignedPayload(frameType, bodyJSON)
	if err != nil {
		return "", err
	}
	return SignES256(priv, preimage)
}

// PublicJWK renders the closed four-member EC P-256 public JWK of a signing key —
// the form the device parses (frame/reconcile, permit/signed.rs EcP256Jwk) to
// verify server-signed downlink frames. The private scalar is never included.
func PublicJWK(priv *ecdsa.PrivateKey) ([]byte, error) {
	x := base64.RawURLEncoding.EncodeToString(priv.PublicKey.X.FillBytes(make([]byte, 32)))
	y := base64.RawURLEncoding.EncodeToString(priv.PublicKey.Y.FillBytes(make([]byte, 32)))
	return json.Marshal(struct {
		Kty string `json:"kty"`
		Crv string `json:"crv"`
		X   string `json:"x"`
		Y   string `json:"y"`
	}{Kty: "EC", Crv: "P-256", X: x, Y: y})
}