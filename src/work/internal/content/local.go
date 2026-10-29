// Package content stores encrypted task text outside PostgreSQL.
//
// The local backend is an R0a pilot store: it derives a per-organization key
// from a process master key and writes AES-256-GCM objects under a private
// directory. It intentionally exposes no host path to callers.
package content

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	refPrefix = "content://work/"
	keyPrefix = "we-meet-work-content:"
)

type Ref struct {
	ContentRef string
	Hash       string
	Bytes      int64
}

type Store interface {
	Put(ctx context.Context, orgID string, plaintext []byte) (Ref, error)
	Get(ctx context.Context, orgID, contentRef string) ([]byte, error)
	Delete(ctx context.Context, orgID, contentRef string) error
}

type Local struct {
	master     []byte
	directory  string
	keyVersion int
}

func NewLocal(master []byte, directory string, keyVersion int) (*Local, error) {
	if len(master) != 32 {
		return nil, fmt.Errorf("content master key must be 32 bytes")
	}
	if strings.TrimSpace(directory) == "" {
		return nil, fmt.Errorf("content directory is required")
	}
	if keyVersion <= 0 {
		keyVersion = 1
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create content directory: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, fmt.Errorf("secure content directory: %w", err)
	}
	return &Local{master: append([]byte(nil), master...), directory: directory, keyVersion: keyVersion}, nil
}

func (l *Local) Put(ctx context.Context, orgID string, plaintext []byte) (Ref, error) {
	if err := ctx.Err(); err != nil {
		return Ref{}, err
	}
	if strings.TrimSpace(orgID) == "" || len(plaintext) == 0 {
		return Ref{}, fmt.Errorf("content org and plaintext are required")
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return Ref{}, fmt.Errorf("generate content id: %w", err)
	}
	id := hex.EncodeToString(idBytes)
	key := deriveKey(l.master, orgID)
	block, err := aes.NewCipher(key)
	if err != nil {
		return Ref{}, fmt.Errorf("create content cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return Ref{}, fmt.Errorf("create content gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return Ref{}, fmt.Errorf("generate content nonce: %w", err)
	}
	ciphertext := gcm.Seal(nil, nonce, plaintext, []byte(orgID))
	payload := append(nonce, ciphertext...)

	directory := filepath.Join(l.directory, orgHash(orgID))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return Ref{}, fmt.Errorf("create content org directory: %w", err)
	}
	path := filepath.Join(directory, id+".enc")
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		return Ref{}, fmt.Errorf("write content object: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return Ref{}, fmt.Errorf("commit content object: %w", err)
	}
	digest := sha256.Sum256(plaintext)
	return Ref{
		ContentRef: contentRef(orgID, id, l.keyVersion),
		Hash:       "sha256:" + hex.EncodeToString(digest[:]),
		Bytes:      int64(len(plaintext)),
	}, nil
}

func (l *Local) Get(ctx context.Context, orgID, contentRef string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id, version, err := parseRef(orgID, contentRef)
	if err != nil {
		return nil, err
	}
	payload, err := os.ReadFile(filepath.Join(l.directory, orgHash(orgID), id+".enc"))
	if err != nil {
		return nil, fmt.Errorf("read content object: %w", err)
	}
	key := deriveKey(l.master, orgID)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create content cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create content gcm: %w", err)
	}
	if len(payload) < gcm.NonceSize() {
		return nil, errors.New("content object is truncated")
	}
	plaintext, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], []byte(orgID))
	if err != nil {
		return nil, fmt.Errorf("decrypt content object: %w", err)
	}
	if version != l.keyVersion {
		// The object remains readable during a key-version transition; callers
		// decide when to re-encrypt rather than silently rewriting content.
		return plaintext, nil
	}
	return plaintext, nil
}

func (l *Local) Delete(ctx context.Context, orgID, contentRef string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	id, _, err := parseRef(orgID, contentRef)
	if err != nil {
		return err
	}
	path := filepath.Join(l.directory, orgHash(orgID), id+".enc")
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete content object: %w", err)
	}
	return nil
}

func deriveKey(master []byte, orgID string) []byte {
	mac := hmac.New(sha256.New, master)
	_, _ = mac.Write([]byte(keyPrefix + orgID))
	return mac.Sum(nil)
}

func orgHash(orgID string) string {
	digest := sha256.Sum256([]byte(orgID))
	return hex.EncodeToString(digest[:16])
}

func contentRef(orgID, id string, version int) string {
	return refPrefix + url.PathEscape(orgID) + "/" + id + "?v=" + fmt.Sprint(version)
}

func parseRef(orgID, contentRef string) (string, int, error) {
	if !strings.HasPrefix(contentRef, refPrefix) {
		return "", 0, errors.New("invalid content reference")
	}
	rest := strings.TrimPrefix(contentRef, refPrefix)
	parts := strings.SplitN(rest, "?", 2)
	segments := strings.Split(parts[0], "/")
	if len(segments) != 2 || segments[0] != url.PathEscape(orgID) {
		return "", 0, errors.New("content reference does not belong to the organization")
	}
	id, err := hex.DecodeString(segments[1])
	if err != nil || len(id) != 16 {
		return "", 0, errors.New("invalid content object id")
	}
	version := 1
	if len(parts) == 2 {
		if _, err := fmt.Sscanf(parts[1], "v=%d", &version); err != nil || version <= 0 {
			return "", 0, errors.New("invalid content key version")
		}
	}
	return segments[1], version, nil
}

// EncodeMasterKey accepts a 64-character hex key; production stores the key
// only in the process environment, never in the database or repository.
func EncodeMasterKey(value string) ([]byte, error) {
	key, err := base64.RawStdEncoding.DecodeString(strings.TrimSpace(value))
	if err == nil && len(key) == 32 {
		return key, nil
	}
	key, err = hex.DecodeString(strings.TrimSpace(value))
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("content master key must be 32-byte hex or base64")
	}
	return key, nil
}
