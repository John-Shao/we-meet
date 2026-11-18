package devicesig

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

// signCovered produces a real ES256 R||S signature in the wire encoding over an arbitrary
// covered string, so the renewal tests can prove domain separation with actual cryptography
// rather than with a shape-valid placeholder.
func signCovered(t *testing.T, priv *ecdsa.PrivateKey, covered string) string {
	t.Helper()
	digest := sha256.Sum256([]byte(covered))
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return base64.RawURLEncoding.EncodeToString(sig)
}

func renewalKey(t *testing.T) (*ecdsa.PrivateKey, *PublicKey) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	jwk, err := PublicJWK(priv)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := ParseJWK(jwk)
	if err != nil {
		t.Fatal(err)
	}
	return priv, pub
}

// TestCertRenewalCoveredStringMatchesSQL pins the preimage to the string 0058's
// confirm_device_certificate_renewal rebuilds, byte for byte. The design names only the
// pairing domain, so this domain is the implementation's choice and the two sides have to
// agree on it explicitly rather than by coincidence.
func TestCertRenewalCoveredStringMatchesSQL(t *testing.T) {
	pub := mustParse(t)
	covered := CertRenewalCoveredString(vectorPairingID, vectorChallenge(), pub.Thumbprint, vectorOrg, vectorSubject)
	want := "work-device-cert-renew-v2|" + vectorPairingID + "|" + vectorChallenge() + "|" + vectorTP + "|org-1|sub-1"
	if covered != want {
		t.Fatalf("covered string mismatch:\n got %s\nwant %s", covered, want)
	}
	if CertRenewalDomain == PairingDomain {
		t.Fatal("renewal reuses the pairing domain; §2.1 forbids cross-purpose signature reuse")
	}
}

func TestVerifyCertRenewalSeparatesTheDomainAndBindsEveryField(t *testing.T) {
	priv, pub := renewalKey(t)
	renewalSig := signCovered(t, priv,
		CertRenewalCoveredString(vectorPairingID, vectorChallenge(), pub.Thumbprint, vectorOrg, vectorSubject))
	if !VerifyCertRenewal(pub, vectorPairingID, vectorChallenge(), vectorOrg, vectorSubject, renewalSig) {
		t.Fatal("a real renewal signature did not verify")
	}

	// The same key, the same fields, the PAIRING domain: neither verifier may accept the
	// other's signature, which is what stops a pairing signature being replayed as a
	// renewal (and vice versa).
	pairingSig := signCovered(t, priv,
		PairingCoveredString(vectorPairingID, vectorChallenge(), pub.Thumbprint, vectorOrg, vectorSubject))
	if VerifyCertRenewal(pub, vectorPairingID, vectorChallenge(), vectorOrg, vectorSubject, pairingSig) {
		t.Fatal("a pairing-domain signature verified as a renewal")
	}
	if VerifyPairing(pub, vectorPairingID, vectorChallenge(), vectorOrg, vectorSubject, renewalSig) {
		t.Fatal("a renewal-domain signature verified as a pairing")
	}

	for _, mutant := range []struct{ pairingID, challenge, org, subject string }{
		{"22222222-2222-2222-2222-222222222222", vectorChallenge(), vectorOrg, vectorSubject},
		{vectorPairingID, strings.Repeat("b", 64), vectorOrg, vectorSubject},
		{vectorPairingID, vectorChallenge(), "org-2", vectorSubject},
		{vectorPairingID, vectorChallenge(), vectorOrg, "sub-2"},
	} {
		if VerifyCertRenewal(pub, mutant.pairingID, mutant.challenge, mutant.org, mutant.subject, renewalSig) {
			t.Fatalf("renewal signature verified under mutated fields %#v", mutant)
		}
	}

	// A different key does not verify, and the shipped cross-language pairing vector is
	// not a renewal signature either.
	if VerifyCertRenewal(mustParse(t), vectorPairingID, vectorChallenge(), vectorOrg, vectorSubject, renewalSig) {
		t.Fatal("renewal signature verified under a different key")
	}
	if VerifyCertRenewal(mustParse(t), vectorPairingID, vectorChallenge(), vectorOrg, vectorSubject, vectorPairSig) {
		t.Fatal("the pairing vector verified as a renewal")
	}
}