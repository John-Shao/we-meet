// Package devicesig verifies the Work R0b device signatures on the control plane.
//
// Authority: docs/work/design/work-r0b-device-design-2026-10-30.md §2.1/§3.1 and
// docs/work/design/work-r0b-m1a-device-migration-design-2026-11-12.md §12 (the
// pairing judgment order). The SQL layer only shape-checks and binds signatures
// (plpgsql cannot verify ES256); this package is the Go/gateway layer that MUST
// verify the cryptography before a domain command is called (0040:1135, 0021).
//
// It reproduces the Rust device agent's conventions byte for byte: the closed
// four-member EC P-256 JWK, the domain-separated thumbprint, ES256 as fixed
// 64-byte R||S in base64url without padding (never DER), RFC 8785 JCS for frame
// bodies, and the pipe-delimited pairing covered string. Frame signatures cover
// {schema_version, type, body} with the body's signature field stripped; the
// outer envelope transport fields are unsigned and type+schema_version give
// domain separation (no cross-frame reuse).
package devicesig

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
)

// ThumbprintDomain is the domain prefix of the device key thumbprint preimage
// (device-design §2.1; SQL 0040 work.device_key_thumbprint).
const ThumbprintDomain = "work-device-key-v1"

// Errors returned by JWK parsing. They are deliberately distinct so a caller can
// tell a malformed key from an off-curve point.
var (
	ErrJWKShape      = errors.New("devicesig: JWK is not a closed four-member EC P-256 object")
	ErrJWKPrivate    = errors.New("devicesig: JWK carries a private field")
	ErrJWKCoordinate = errors.New("devicesig: JWK x/y is not a 32-byte base64url value")
	ErrJWKOffCurve   = errors.New("devicesig: JWK point is not on the P-256 curve")
)

// privateFields are the JWK members that must never appear in a public key.
var privateFields = []string{"d", "p", "q", "dp", "dq", "qi", "k"}

// PublicKey is a parsed device public key with its server-matching thumbprint.
type PublicKey struct {
	Key        *ecdsa.PublicKey
	Thumbprint string
	// X and Y are the base64url coordinate strings exactly as they appear in the
	// JWK, retained so the thumbprint preimage is rebuilt from the original text.
	X string
	Y string
}

// ParseJWK parses the closed four-member EC P-256 JWK and validates the point on
// the curve. The SQL device_pubkey_valid only shape-checks; the on-curve check is
// the Go layer's responsibility (a shape-valid but off-curve point is not a key).
func ParseJWK(raw []byte) (*PublicKey, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(raw, &members); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrJWKShape, err)
	}
	if len(members) == 0 {
		return nil, ErrJWKShape
	}
	for _, field := range privateFields {
		if _, present := members[field]; present {
			return nil, ErrJWKPrivate
		}
	}
	if len(members) != 4 {
		return nil, ErrJWKShape
	}
	var kty, crv, x, y string
	if err := unquoteString(members["kty"], &kty); err != nil || kty != "EC" {
		return nil, ErrJWKShape
	}
	if err := unquoteString(members["crv"], &crv); err != nil || crv != "P-256" {
		return nil, ErrJWKShape
	}
	if err := unquoteString(members["x"], &x); err != nil {
		return nil, ErrJWKShape
	}
	if err := unquoteString(members["y"], &y); err != nil {
		return nil, ErrJWKShape
	}
	xb, err := decodeCoordinate(x)
	if err != nil {
		return nil, err
	}
	yb, err := decodeCoordinate(y)
	if err != nil {
		return nil, err
	}
	px := new(big.Int).SetBytes(xb)
	py := new(big.Int).SetBytes(yb)
	curve := elliptic.P256()
	if !curve.IsOnCurve(px, py) {
		return nil, ErrJWKOffCurve
	}
	return &PublicKey{
		Key:        &ecdsa.PublicKey{Curve: curve, X: px, Y: py},
		Thumbprint: Thumbprint(x, y),
		X:          x,
		Y:          y,
	}, nil
}

func unquoteString(raw json.RawMessage, out *string) error {
	if len(raw) == 0 {
		return ErrJWKShape
	}
	return json.Unmarshal(raw, out)
}

// decodeCoordinate decodes a 43-character base64url (no padding) coordinate into
// exactly 32 bytes.
func decodeCoordinate(s string) ([]byte, error) {
	if len(s) != 43 {
		return nil, ErrJWKCoordinate
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != 32 {
		return nil, ErrJWKCoordinate
	}
	return b, nil
}

// Thumbprint computes sha256("work-device-key-v1|EC|P-256|x|y") over the original
// base64url coordinate strings, matching SQL 0040 and the Rust device byte for
// byte. This is the pipe-delimited preimage, NOT the JCS signature form.
func Thumbprint(x, y string) string {
	preimage := ThumbprintDomain + "|EC|P-256|" + x + "|" + y
	sum := sha256.Sum256([]byte(preimage))
	return hex.EncodeToString(sum[:])
}
