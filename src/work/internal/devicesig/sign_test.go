package devicesig

import (
	"crypto/ecdsa"
	"strings"
	"testing"
)

func TestSignES256RoundTrips(t *testing.T) {
	priv, err := GenerateSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	msg := []byte("the canonical signing preimage")
	sig, err := SignES256(priv, msg)
	if err != nil {
		t.Fatal(err)
	}
	if len(sig) != 86 || strings.ContainsAny(sig, "=+/") {
		t.Fatalf("signature = %q, want 86-char base64url no padding", sig)
	}
	if !VerifyES256(&priv.PublicKey, msg, sig) {
		t.Fatal("signature did not verify")
	}
	if VerifyES256(&priv.PublicKey, []byte("tampered"), sig) {
		t.Fatal("tampered message verified")
	}
}

func TestSignFrameRoundTripsAndDomainSeparates(t *testing.T) {
	priv, err := GenerateSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	pub, err := ParseJWK(mustJWK(t, priv))
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"resolve_id":"r1","state":"failed","resolution_revision":"5"}`)
	sig, err := SignFrame(priv, "operation_resolution", body)
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyFrame(pub, "operation_resolution", body, sig) {
		t.Fatal("resolution frame did not verify")
	}
	// A resolution signature must not verify under another frame type.
	if VerifyFrame(pub, "permit", body, sig) {
		t.Fatal("cross-frame signature reuse verified")
	}
	// The body's own signature field is stripped, so adding it does not change the
	// preimage: a body carrying the signature still verifies.
	withSig := []byte(`{"resolve_id":"r1","state":"failed","resolution_revision":"5","signature":"` + sig + `"}`)
	if !VerifyFrame(pub, "operation_resolution", withSig, sig) {
		t.Fatal("body carrying signature did not verify")
	}
}

func TestPublicJWKIsClosedAndParses(t *testing.T) {
	priv, err := GenerateSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	raw := mustJWK(t, priv)
	pub, err := ParseJWK(raw)
	if err != nil {
		t.Fatalf("public JWK did not parse: %v", err)
	}
	if pub.Thumbprint != Thumbprint(pub.X, pub.Y) {
		t.Fatal("thumbprint mismatch")
	}
	// The private scalar must never leak into the public JWK.
	if strings.Contains(string(raw), `"d"`) {
		t.Fatal("public JWK carries a private field")
	}
}

func mustJWK(t *testing.T, priv *ecdsa.PrivateKey) []byte {
	t.Helper()
	raw, err := PublicJWK(priv)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}