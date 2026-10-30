package credentials

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"testing"
)

func testMaster(fill byte) []byte {
	return bytes.Repeat([]byte{fill}, masterKeySize)
}

func TestSealOpenRoundTrip(t *testing.T) {
	master := testMaster(0x42)
	orgID := "org_a"
	plaintext := []byte(`{"api_key":"sk-live-中文","endpoint":"https://example.test"}`)

	sealed, fingerprint, err := Seal(master, orgID, plaintext)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if len(sealed) != nonceSize+len(plaintext)+16 {
		t.Fatalf("sealed length = %d, want %d", len(sealed), nonceSize+len(plaintext)+16)
	}
	if fingerprint != Fingerprint(plaintext) {
		t.Fatalf("Seal fingerprint = %q, Fingerprint = %q", fingerprint, Fingerprint(plaintext))
	}

	got, err := Open(master, orgID, sealed)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("opened plaintext = %q, want %q", got, plaintext)
	}
}

func TestOpenWrongOrgFails(t *testing.T) {
	master := testMaster(0x21)
	sealed, _, err := Seal(master, "org_a", []byte("secret"))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	got, err := Open(master, "org_b", sealed)
	if !errors.Is(err, ErrDecrypt) {
		t.Fatalf("Open wrong org error = %v, want ErrDecrypt", err)
	}
	if got != nil {
		t.Fatalf("Open wrong org returned plaintext %q", got)
	}
}

func TestOpenTamperedCiphertextFails(t *testing.T) {
	master := testMaster(0x99)
	plaintext := []byte("provider secret")
	sealed, _, err := Seal(master, "org_a", plaintext)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	tampered := append([]byte(nil), sealed...)
	tampered[len(tampered)-1] ^= 0xff
	if got, err := Open(master, "org_a", tampered); !errors.Is(err, ErrDecrypt) || got != nil {
		t.Fatalf("Open tampered body = (%q, %v), want (nil, ErrDecrypt)", got, err)
	}

	tamperedNonce := append([]byte(nil), sealed...)
	tamperedNonce[0] ^= 0xff
	if got, err := Open(master, "org_a", tamperedNonce); !errors.Is(err, ErrDecrypt) || got != nil {
		t.Fatalf("Open tampered nonce = (%q, %v), want (nil, ErrDecrypt)", got, err)
	}
}

func TestOpenShortInputFails(t *testing.T) {
	master := testMaster(0x17)
	for _, length := range []int{0, 1, nonceSize - 1, nonceSize, nonceSize + 15} {
		input := make([]byte, length)
		got, err := Open(master, "org_a", input)
		if !errors.Is(err, ErrDecrypt) {
			t.Fatalf("Open(%d bytes) error = %v, want ErrDecrypt", length, err)
		}
		if got != nil {
			t.Fatalf("Open(%d bytes) returned plaintext %q", length, got)
		}
	}
	if got, err := Open(master, "org_a", nil); !errors.Is(err, ErrDecrypt) || got != nil {
		t.Fatalf("Open(nil) = (%q, %v), want (nil, ErrDecrypt)", got, err)
	}
}

func TestSealUsesFreshNonce(t *testing.T) {
	master := testMaster(0x55)
	plaintext := []byte("same plaintext")
	first, _, err := Seal(master, "org_a", plaintext)
	if err != nil {
		t.Fatalf("first Seal: %v", err)
	}
	second, _, err := Seal(master, "org_a", plaintext)
	if err != nil {
		t.Fatalf("second Seal: %v", err)
	}
	if bytes.Equal(first[:nonceSize], second[:nonceSize]) {
		t.Fatal("two seals reused the same nonce")
	}
	if bytes.Equal(first, second) {
		t.Fatal("two seals of the same plaintext produced identical ciphertext")
	}
}

func TestFingerprintStableAndHex(t *testing.T) {
	plaintext := []byte("stable fingerprint input")
	first := Fingerprint(plaintext)
	second := Fingerprint(plaintext)
	if first != second {
		t.Fatalf("fingerprint not stable: %q != %q", first, second)
	}
	if len(first) != 16 {
		t.Fatalf("fingerprint length = %d, want 16", len(first))
	}
	if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(first) {
		t.Fatalf("fingerprint %q is not lowercase hex", first)
	}
	digest := sha256.Sum256(plaintext)
	if want := hex.EncodeToString(digest[:8]); first != want {
		t.Fatalf("fingerprint = %q, want %q", first, want)
	}
}

func TestDeriveKeyRejectsBadMasterAndOrg(t *testing.T) {
	for _, length := range []int{0, 1, 16, masterKeySize - 1, masterKeySize + 1, 64} {
		master := make([]byte, length)
		if key, err := DeriveKey(master, "org_a"); err == nil {
			t.Fatalf("DeriveKey accepted a %d-byte master: %x", length, key)
		}
	}
	if _, err := DeriveKey(nil, "org_a"); err == nil {
		t.Fatal("DeriveKey accepted a nil master")
	}
	for _, orgID := range []string{"", "   "} {
		if key, err := DeriveKey(testMaster(0x01), orgID); err == nil {
			t.Fatalf("DeriveKey accepted org %q: %x", orgID, key)
		}
	}
}

func TestDeriveKeyDomainSeparation(t *testing.T) {
	master := testMaster(0x24)
	keyA, err := DeriveKey(master, "org_a")
	if err != nil {
		t.Fatalf("DeriveKey(org_a): %v", err)
	}
	keyB, err := DeriveKey(master, "org_b")
	if err != nil {
		t.Fatalf("DeriveKey(org_b): %v", err)
	}
	if bytes.Equal(keyA, keyB) {
		t.Fatal("derived keys are identical across organizations")
	}
	if len(keyA) != 32 || len(keyB) != 32 {
		t.Fatalf("derived key lengths = %d and %d, want 32", len(keyA), len(keyB))
	}

	// Reproduce the Content Store derivation independently: a key derived
	// under "we-meet-work-content:" must never equal the provider key.
	contentMAC := hmac.New(sha256.New, master)
	_, _ = contentMAC.Write([]byte("we-meet-work-content:" + "org_a"))
	contentKey := contentMAC.Sum(nil)
	if bytes.Equal(keyA, contentKey) {
		t.Fatal("provider and Content Store derivations collided; domain separation is broken")
	}
}

func TestSealRejectsEmptyPlaintext(t *testing.T) {
	for _, plaintext := range [][]byte{nil, {}} {
		ciphertext, fingerprint, err := Seal(testMaster(0x31), "org_a", plaintext)
		if err == nil {
			t.Fatalf("Seal accepted empty plaintext: %x", ciphertext)
		}
		if ciphertext != nil || fingerprint != "" {
			t.Fatalf("Seal returned (%x, %q) with error", ciphertext, fingerprint)
		}
	}
}

func TestErrorsDoNotEchoPlaintext(t *testing.T) {
	master := testMaster(0x0d)
	marker := "MARKER-8c1f-provider-secret-value"
	plaintext := []byte("token=" + marker)
	sealed, _, err := Seal(master, "org_a", plaintext)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	tampered := append([]byte(nil), sealed...)
	tampered[len(tampered)-1] ^= 0xff
	cases := []struct {
		name string
		err  error
	}{
		{"wrong org", func() error {
			_, err := Open(master, "org_b", sealed)
			return err
		}()},
		{"tampered", func() error {
			_, err := Open(master, "org_a", tampered)
			return err
		}()},
		{"short", func() error {
			_, err := Open(master, "org_a", sealed[:nonceSize])
			return err
		}()},
		{"bad master", func() error {
			_, _, err := Seal([]byte(marker), "org_a", []byte("value"))
			return err
		}()},
		{"bad org", func() error {
			_, _, err := Seal(master, "", plaintext)
			return err
		}()},
	}
	for _, tc := range cases {
		if tc.err == nil {
			t.Fatalf("%s: expected an error", tc.name)
		}
		if strings.Contains(tc.err.Error(), marker) {
			t.Fatalf("%s: error echoes plaintext marker: %q", tc.name, tc.err)
		}
	}
}
