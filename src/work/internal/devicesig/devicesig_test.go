package devicesig

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"strings"
	"testing"
)

// generatorKey returns the P-256 base point as a valid but distinct public key,
// used to prove a signature does not verify under a different key.
func generatorKey() *ecdsa.PublicKey {
	p := elliptic.P256().Params()
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: p.Gx, Y: p.Gy}
}

// Cross-language vectors generated from the Rust device agent's deterministic
// SoftwareKey::from_bytes([7;32]) (src/device: pairing::sign and
// frame::sign::sign_frame over the JCS body). They prove the Go verification
// reproduces the device's JWK, thumbprint, pairing covered string and RFC 8785
// JCS frame signing byte for byte.
const (
	vectorJWK = `{"crv":"P-256","kty":"EC","x":"HhhTL9R1TALzBB2cdc6zO4P_2BrHzk_ogsyxyYvFiW4","y":"pGwxHE4v9A3ZajZT5uRURdMt_khuztdcepDGoYiBwKM"}`
	vectorTP  = "dc12c777193b7b5137f5dadc6f09afe581e6b668bb77439c4bdd6a3258fd210b"

	vectorPairingID = "11111111-1111-1111-1111-111111111111"
	vectorOrg       = "org-1"
	vectorSubject   = "sub-1"
	vectorPairSig   = "Ntp1oRy0FpCog-T73AJ6cGLtmR-cGSUOg5_Jd0HbzbBY-UNrLn0a3ampZXPB2uQE1rilLkNYNt5nMbg7IIIvDg"

	vectorFrameBody = `{"operation_id":"op-1","original_execution":{"fence":"1","generation":"2","org_id":"org-1"},"receipt_seq":"1","state":"started"}`
	vectorFrameSig  = "rbilS_8MlQunggcu-m5dMU0dvgMP3HynCfFeZvLHZtJO9olomEA1UFhmMOcow9UPJXXFWVAEKuveHDKHE-aSvw"
)

func vectorChallenge() string { return strings.Repeat("a", 64) }

func mustParse(t *testing.T) *PublicKey {
	t.Helper()
	pub, err := ParseJWK([]byte(vectorJWK))
	if err != nil {
		t.Fatalf("ParseJWK: %v", err)
	}
	return pub
}

func TestParseJWKMatchesDeviceThumbprint(t *testing.T) {
	pub := mustParse(t)
	if pub.Thumbprint != vectorTP {
		t.Fatalf("thumbprint = %s, want %s", pub.Thumbprint, vectorTP)
	}
	if pub.X != "HhhTL9R1TALzBB2cdc6zO4P_2BrHzk_ogsyxyYvFiW4" {
		t.Fatalf("unexpected x coordinate %s", pub.X)
	}
}

func TestVerifyPairingCrossLanguage(t *testing.T) {
	pub := mustParse(t)
	if !VerifyPairing(pub, vectorPairingID, vectorChallenge(), vectorOrg, vectorSubject, vectorPairSig) {
		t.Fatal("device pairing signature did not verify")
	}
	// The covered string must equal the SQL-rebuilt pipe form byte for byte.
	covered := PairingCoveredString(vectorPairingID, vectorChallenge(), pub.Thumbprint, vectorOrg, vectorSubject)
	want := "work-device-pair-v2|" + vectorPairingID + "|" + vectorChallenge() + "|" + vectorTP + "|org-1|sub-1"
	if covered != want {
		t.Fatalf("covered string mismatch:\n got %s\nwant %s", covered, want)
	}
}

func TestVerifyPairingBindsEveryField(t *testing.T) {
	pub := mustParse(t)
	if VerifyPairing(pub, vectorPairingID, vectorChallenge(), vectorOrg, "other-subject", vectorPairSig) {
		t.Fatal("pairing signature verified under a different subject")
	}
	if VerifyPairing(pub, "22222222-2222-2222-2222-222222222222", vectorChallenge(), vectorOrg, vectorSubject, vectorPairSig) {
		t.Fatal("pairing signature verified under a different pairing id")
	}
}

func TestVerifyFrameCrossLanguage(t *testing.T) {
	pub := mustParse(t)
	if !VerifyFrame(pub, "receipt", []byte(vectorFrameBody), vectorFrameSig) {
		t.Fatal("device frame signature did not verify (JCS byte mismatch?)")
	}
}

func TestVerifyFrameDomainSeparated(t *testing.T) {
	pub := mustParse(t)
	// The same body under a different frame type must not verify.
	if VerifyFrame(pub, "hello", []byte(vectorFrameBody), vectorFrameSig) {
		t.Fatal("frame signature verified under a different type")
	}
}

func TestVerifyFrameTamperedBodyFails(t *testing.T) {
	pub := mustParse(t)
	tampered := strings.Replace(vectorFrameBody, `"state":"started"`, `"state":"completed"`, 1)
	if VerifyFrame(pub, "receipt", []byte(tampered), vectorFrameSig) {
		t.Fatal("frame signature verified after body tamper")
	}
}

func TestVerifyFrameSignatureFieldStripped(t *testing.T) {
	pub := mustParse(t)
	// Adding a signature field to the body must not change verification.
	withSig := `{"operation_id":"op-1","original_execution":{"fence":"1","generation":"2","org_id":"org-1"},"receipt_seq":"1","state":"started","signature":"ignored"}`
	if !VerifyFrame(pub, "receipt", []byte(withSig), vectorFrameSig) {
		t.Fatal("frame signature failed when body carries a signature field")
	}
}

func TestVerifyFrameWrongKeyFails(t *testing.T) {
	// A different valid key (flip the x coordinate to another on-curve point is
	// hard; instead use a freshly generated key's JWK via the software path).
	other := &PublicKey{Key: mustParse(t).Key}
	// Mutate the public point so it is a different (still on-curve) key: use the
	// generator point G as a distinct, valid public key.
	other.Key = generatorKey()
	if VerifyFrame(other, "receipt", []byte(vectorFrameBody), vectorFrameSig) {
		t.Fatal("frame signature verified under a different key")
	}
}

func TestParseJWKRejectsPrivateField(t *testing.T) {
	raw := `{"crv":"P-256","kty":"EC","x":"HhhTL9R1TALzBB2cdc6zO4P_2BrHzk_ogsyxyYvFiW4","y":"pGwxHE4v9A3ZajZT5uRURdMt_khuztdcepDGoYiBwKM","d":"AAAA"}`
	if _, err := ParseJWK([]byte(raw)); err != ErrJWKPrivate {
		t.Fatalf("expected ErrJWKPrivate, got %v", err)
	}
}

func TestParseJWKRejectsExtraMember(t *testing.T) {
	raw := `{"crv":"P-256","kty":"EC","x":"HhhTL9R1TALzBB2cdc6zO4P_2BrHzk_ogsyxyYvFiW4","y":"pGwxHE4v9A3ZajZT5uRURdMt_khuztdcepDGoYiBwKM","use":"sig"}`
	if _, err := ParseJWK([]byte(raw)); err != ErrJWKShape {
		t.Fatalf("expected ErrJWKShape, got %v", err)
	}
}

func TestParseJWKRejectsOffCurvePoint(t *testing.T) {
	// x = y = 1 is not on P-256.
	raw := `{"crv":"P-256","kty":"EC","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`
	if _, err := ParseJWK([]byte(raw)); err != ErrJWKOffCurve {
		t.Fatalf("expected ErrJWKOffCurve, got %v", err)
	}
}

func TestParseJWKRejectsBadCoordinate(t *testing.T) {
	raw := `{"crv":"P-256","kty":"EC","x":"short","y":"pGwxHE4v9A3ZajZT5uRURdMt_khuztdcepDGoYiBwKM"}`
	if _, err := ParseJWK([]byte(raw)); err != ErrJWKCoordinate {
		t.Fatalf("expected ErrJWKCoordinate, got %v", err)
	}
}

func TestVerifyES256RejectsMalformed(t *testing.T) {
	pub := mustParse(t)
	msg := []byte("message")
	for _, sig := range []string{
		"",                      // empty
		"not base64 !!!",        // non-alphabet
		vectorPairSig + "=",     // padding
		strings.Repeat("A", 85), // wrong length (decodes to != 64)
	} {
		if VerifyES256(pub.Key, msg, sig) {
			t.Fatalf("malformed signature accepted: %q", sig)
		}
	}
}
