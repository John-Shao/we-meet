package content

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalRoundTripAndTenantIsolation(t *testing.T) {
	store, err := NewLocal(bytes.Repeat([]byte{7}, 32), t.TempDir(), 1)
	if err != nil {
		t.Fatal(err)
	}
	plaintext := []byte(`{"goal":"中文目标","background":"背景"}`)
	ref, err := store.Put(context.Background(), "org_a", plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if ref.Bytes != int64(len(plaintext)) || len(ref.Hash) != len("sha256:")+64 {
		t.Fatalf("ref = %#v", ref)
	}
	got, err := store.Get(context.Background(), "org_a", ref.ContentRef)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("plaintext = %q", got)
	}
	if _, err := store.Get(context.Background(), "org_b", ref.ContentRef); err == nil {
		t.Fatal("cross-organization content reference was accepted")
	}
}

func TestLocalRejectsTamperedObjectAndDeletes(t *testing.T) {
	directory := t.TempDir()
	store, err := NewLocal(bytes.Repeat([]byte{9}, 32), directory, 1)
	if err != nil {
		t.Fatal(err)
	}
	ref, err := store.Put(context.Background(), "org_a", []byte("secret text"))
	if err != nil {
		t.Fatal(err)
	}
	var path string
	if err := filepath.Walk(directory, func(candidate string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			path = candidate
		}
		return err
	}); err != nil || path == "" {
		t.Fatalf("content file not found: %v", err)
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	payload[len(payload)-1] ^= 0xff
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(context.Background(), "org_a", ref.ContentRef); err == nil {
		t.Fatal("tampered content was accepted")
	}
	if err := store.Delete(context.Background(), "org_a", ref.ContentRef); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(context.Background(), "org_a", ref.ContentRef); err == nil {
		t.Fatal("deleted content was readable")
	}
}

func TestLocalPersistsAcrossReopen(t *testing.T) {
	directory := t.TempDir()
	master := bytes.Repeat([]byte{11}, 32)
	plaintext := []byte("persistent task body")
	var retained, deleted Ref
	{
		store, err := NewLocal(master, directory, 1)
		if err != nil {
			t.Fatal(err)
		}
		retained, err = store.Put(context.Background(), "org_a", plaintext)
		if err != nil {
			t.Fatal(err)
		}
		deleted, err = store.Put(context.Background(), "org_a", []byte("deleted body"))
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Delete(context.Background(), "org_a", deleted.ContentRef); err != nil {
			t.Fatal(err)
		}
	}

	reopened, err := NewLocal(master, directory, 1)
	if err != nil {
		t.Fatal(err)
	}
	got, err := reopened.Get(context.Background(), "org_a", retained.ContentRef)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("plaintext after reopen = %q", got)
	}
	if _, err := reopened.Get(context.Background(), "org_a", deleted.ContentRef); err == nil {
		t.Fatal("deleted content became readable after reopen")
	}
	if _, err := reopened.Get(context.Background(), "org_b", retained.ContentRef); err == nil {
		t.Fatal("cross-organization content reference was accepted after reopen")
	}
	id, _, err := parseRef("org_a", retained.ContentRef)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(filepath.Join(directory, orgHash("org_a"), id+".enc"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(payload, plaintext) {
		t.Fatal("plaintext was stored in the content object")
	}
}

func TestLocalReopenRejectsWrongMaster(t *testing.T) {
	directory := t.TempDir()
	master := bytes.Repeat([]byte{13}, 32)
	store, err := NewLocal(master, directory, 1)
	if err != nil {
		t.Fatal(err)
	}
	plaintext := []byte("master-bound content")
	ref, err := store.Put(context.Background(), "org_a", plaintext)
	if err != nil {
		t.Fatal(err)
	}

	wrongMaster, err := NewLocal(bytes.Repeat([]byte{14}, 32), directory, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrongMaster.Get(context.Background(), "org_a", ref.ContentRef); err == nil {
		t.Fatal("content decrypted with the wrong master key after reopen")
	}
	got, err := store.Get(context.Background(), "org_a", ref.ContentRef)
	if err != nil || !bytes.Equal(got, plaintext) {
		t.Fatalf("correct-master read after failed unlock = %q, %v", got, err)
	}
}

func TestEncodeMasterKeyAcceptsHexAndBase64(t *testing.T) {
	raw := bytes.Repeat([]byte{3}, 32)
	hexValue := "0303030303030303030303030303030303030303030303030303030303030303"
	if got, err := EncodeMasterKey(hexValue); err != nil || !bytes.Equal(got, raw) {
		t.Fatalf("hex = %x, %v", got, err)
	}
	if got, err := EncodeMasterKey(base64.RawStdEncoding.EncodeToString(raw)); err != nil || !bytes.Equal(got, raw) {
		t.Fatalf("base64 = %x, %v", got, err)
	}
	if _, err := EncodeMasterKey("short"); err == nil {
		t.Fatal("short key accepted")
	}
}
