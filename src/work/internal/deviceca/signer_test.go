package deviceca

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"regexp"
	"testing"
	"time"
)

// TestFileBackendSignsTheSameCertificateTemplate is the spike's invariant check: moving
// the issuing key behind CA.Signer must change where the key comes from and nothing
// else. It signs the same device public key twice - once through the loaded CA (the
// custody seam, a crypto.Signer) and once by handing a concrete key to
// x509.CreateCertificate directly (the shape the code had before the seam) - and
// compares every template-derived field of the two leaves.
func TestFileBackendSignsTheSameCertificateTemplate(t *testing.T) {
	ca, err := NewCA()
	if err != nil {
		t.Fatal(err)
	}
	caKey := generatedCAPECSAKey(t, ca)
	loaded, err := LoadCA(ca.CertPEM, keyPEM(t, caKey))
	if err != nil {
		t.Fatalf("LoadCA: %v", err)
	}
	deviceKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	chain, err := loaded.IssueDeviceCert("device-1", "org-1", &deviceKey.PublicKey)
	if err != nil {
		t.Fatalf("IssueDeviceCert: %v", err)
	}
	if len(chain.Certificate) != 2 {
		t.Fatalf("presented chain has %d elements, want leaf plus CA", len(chain.Certificate))
	}
	if string(chain.Certificate[1]) != string(ca.Cert.Raw) {
		t.Fatal("the second chain element is not the configured CA")
	}
	viaSeam, err := x509.ParseCertificate(chain.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}

	// The contract template, spelled out again here so the comparison is against the
	// requirement rather than against whatever the helper currently does.
	notBefore := time.Now().Add(-time.Minute)
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatal(err)
	}
	directDER, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "device-1", OrganizationalUnit: []string{"org-1"}},
		NotBefore:    notBefore,
		NotAfter:     notBefore.Add(DeviceCertTTL + time.Minute),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}, loaded.Cert, &deviceKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("direct sign with the concrete key: %v", err)
	}
	direct, err := x509.ParseCertificate(directDER)
	if err != nil {
		t.Fatal(err)
	}

	if string(viaSeam.RawSubject) != string(direct.RawSubject) {
		t.Fatalf("subject differs: %q through the seam versus %q signed directly",
			viaSeam.Subject.CommonName, direct.Subject.CommonName)
	}
	if viaSeam.Subject.CommonName != "device-1" || len(viaSeam.Subject.OrganizationalUnit) != 1 ||
		viaSeam.Subject.OrganizationalUnit[0] != "org-1" {
		t.Fatalf("identity is not carried as CN=device plus OU=org: %+v", viaSeam.Subject)
	}
	if viaSeam.Version != direct.Version || viaSeam.SignatureAlgorithm != direct.SignatureAlgorithm {
		t.Fatal("version or signature algorithm differs between the two paths")
	}
	if err := viaSeam.CheckSignatureFrom(loaded.Cert); err != nil {
		t.Fatalf("leaf through the seam does not chain to the CA: %v", err)
	}
	if err := direct.CheckSignatureFrom(loaded.Cert); err != nil {
		t.Fatalf("directly signed leaf does not chain to the CA: %v", err)
	}
	if !publicKeysMatch(viaSeam.PublicKey, direct.PublicKey) ||
		!publicKeysMatch(viaSeam.PublicKey, &deviceKey.PublicKey) {
		t.Fatal("the certificate does not carry the device public key on both paths")
	}
	if len(viaSeam.Extensions) != len(direct.Extensions) {
		t.Fatalf("extension count differs: %d through the seam versus %d signed directly",
			len(viaSeam.Extensions), len(direct.Extensions))
	}
	for i := range viaSeam.Extensions {
		a, b := viaSeam.Extensions[i], direct.Extensions[i]
		if a.Id.String() != b.Id.String() || string(a.Value) != string(b.Value) {
			t.Fatalf("extension %d differs: %v", i, a.Id)
		}
	}
	if viaSeam.KeyUsage != x509.KeyUsageDigitalSignature {
		t.Fatalf("key usage is %v, want digital signature only", viaSeam.KeyUsage)
	}
	if len(viaSeam.ExtKeyUsage) != 1 || viaSeam.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
		t.Fatalf("extended key usage is %v, want client auth only", viaSeam.ExtKeyUsage)
	}
	if viaSeam.BasicConstraintsValid {
		t.Fatal("a device leaf must not assert basic constraints")
	}

	// The 24h lifetime is what §2.1 step 4 pins, and the database bounds it, so the
	// window - not the absolute clock - is what both paths must agree on.
	seedWindow, directWindow := viaSeam.NotAfter.Sub(viaSeam.NotBefore), direct.NotAfter.Sub(direct.NotBefore)
	if diff := seedWindow - directWindow; diff > time.Second || diff < -time.Second {
		t.Fatalf("validity window differs: %v through the seam versus %v signed directly", seedWindow, directWindow)
	}
	if seedWindow < DeviceCertTTL || seedWindow > DeviceCertTTL+2*time.Minute {
		t.Fatalf("validity window is %v, want the 24h contract", seedWindow)
	}

	// 0058 records the serial as text and deliberately does not order it, because the CA
	// mints a random 128-bit value; the same rule has to hold through the seam.
	serialText := viaSeam.SerialNumber.Text(10)
	if !regexp.MustCompile(`^[1-9][0-9]{0,38}$`).MatchString(serialText) {
		t.Fatalf("serial %q is outside the shape 0058 records", serialText)
	}
	if viaSeam.SerialNumber.Cmp(direct.SerialNumber) == 0 {
		t.Fatal("two issuances reused one serial")
	}
}

// TestFileBackendRejectsKeyMaterialItCannotSignWith keeps the file backend's refusals
// reachable on their own, without a certificate in the way.
func TestFileBackendRejectsKeyMaterialItCannotSignWith(t *testing.T) {
	if _, err := fileSignerFromPEM([]byte("not a key")); err == nil {
		t.Fatal("non-PEM key material was accepted")
	}
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	// An Ed25519 key is a valid crypto.Signer but the wrong one here: the device plane
	// verifies P-256 identities, so the backend must not hand it out.
	_, edPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fileSignerFromPEM(keyPEM(t, edPriv)); err == nil {
		t.Fatal("a non-EC key was accepted by the file backend")
	}
	signer, err := fileSignerFromPEM(keyPEM(t, ecKey))
	if err != nil {
		t.Fatalf("an EC key in PKCS#8 was refused: %v", err)
	}
	if !publicKeysMatch(signer.Public(), &ecKey.PublicKey) {
		t.Fatal("the backend returned a different key than it parsed")
	}
}
