// Package credentials seals provider secrets for storage in PostgreSQL.
//
// The signed profile is:
//   - key = HMAC-SHA256(master_key, "we-meet-work-provider:" + org_id);
//   - AES-256-GCM with a random 12-byte nonce, org_id as the AAD;
//   - the stored bytea is nonce || ciphertext;
//   - key_version is monotonic, and rotation is an offline re-encrypt;
//   - fingerprint is HMAC-SHA256 under a master-derived key, first 8 bytes,
//     lowercase hex (keyed so a DB dump cannot confirm a guessed API key).
//
// The master key comes only from the process environment and is never
// persisted. The "we-meet-work-provider:" prefix keeps this keying separate
// from the Content Store key, which is derived under
// "we-meet-work-content:".
package credentials

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const (
	// keyPrefix domain-separates provider-credential keys from Content Store
	// keys, which use "we-meet-work-content:".
	keyPrefix = "we-meet-work-provider:"
	// masterKeySize is the required AES-256 master key length.
	masterKeySize = 32
	// nonceSize is the AES-GCM nonce length in bytes.
	nonceSize = 12
)

// ErrDecrypt is the single enumeration error returned by Open for short input,
// a wrong organization (AAD mismatch), or tampered bytes. It deliberately
// carries no plaintext or key material.
var ErrDecrypt = errors.New("provider credential decryption failed")

// DeriveKey derives the 32-byte per-organization key for the provider
// credential profile.
func DeriveKey(master []byte, orgID string) ([]byte, error) {
	if len(master) != masterKeySize {
		return nil, fmt.Errorf("provider credential master key must be %d bytes", masterKeySize)
	}
	if strings.TrimSpace(orgID) == "" {
		return nil, errors.New("provider credential organization is required")
	}
	mac := hmac.New(sha256.New, master)
	_, _ = mac.Write([]byte(keyPrefix + orgID))
	return mac.Sum(nil), nil
}

// Seal encrypts plaintext for orgID and returns nonce || ciphertext together
// with the plaintext fingerprint. Empty plaintext is refused.
func Seal(master []byte, orgID string, plaintext []byte) (ciphertext []byte, fingerprint string, err error) {
	if len(plaintext) == 0 {
		return nil, "", errors.New("provider credential plaintext is required")
	}
	key, err := DeriveKey(master, orgID)
	if err != nil {
		return nil, "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, "", fmt.Errorf("create provider credential cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, "", fmt.Errorf("create provider credential gcm: %w", err)
	}
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, "", fmt.Errorf("generate provider credential nonce: %w", err)
	}
	sealed := gcm.Seal(nil, nonce, plaintext, []byte(orgID))
	payload := make([]byte, 0, nonceSize+len(sealed))
	payload = append(payload, nonce...)
	payload = append(payload, sealed...)
	return payload, Fingerprint(master, plaintext), nil
}

// Open decrypts a stored nonce || ciphertext value for orgID. Short input, a
// wrong organization, and tampered bytes all return ErrDecrypt so callers
// cannot distinguish them.
func Open(master []byte, orgID string, ciphertext []byte) ([]byte, error) {
	key, err := DeriveKey(master, orgID)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrDecrypt
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrDecrypt
	}
	if len(ciphertext) < nonceSize+gcm.Overhead() {
		return nil, ErrDecrypt
	}
	plaintext, err := gcm.Open(nil, ciphertext[:nonceSize], ciphertext[nonceSize:], []byte(orgID))
	if err != nil {
		return nil, ErrDecrypt
	}
	return plaintext, nil
}

// Fingerprint returns a keyed fingerprint of the plaintext as 16 lowercase
// hexadecimal characters.
//
// The digest is HMAC-SHA256 under a master-derived key rather than a bare
// SHA-256: a stolen database row alone must not let an attacker confirm a
// guessed API key offline, and identical keys in two orgs must not produce the
// same fingerprint. The value is display/record only; nothing compares
// fingerprints across rows or versions.
func Fingerprint(master []byte, plaintext []byte) string {
	derived := sha256.Sum256(append(append([]byte(nil), master...), []byte("work-credential-fingerprint")...))
	mac := hmac.New(sha256.New, derived[:])
	mac.Write(plaintext)
	return hex.EncodeToString(mac.Sum(nil)[:8])
}
