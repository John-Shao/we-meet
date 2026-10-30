package templates

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestSourceLookupMatchesBuiltinHash(t *testing.T) {
	for _, template := range Builtin() {
		body, hash, ok := (Source{}).Lookup(template.ID, template.Version)
		if !ok {
			t.Fatalf("lookup %s v%d failed", template.ID, template.Version)
		}
		digest := sha256.Sum256(body)
		if want := "sha256:" + hex.EncodeToString(digest[:]); hash != want {
			t.Fatalf("%s hash = %q, want %q", template.ID, hash, want)
		}
		if hash != template.ContentHash {
			t.Fatalf("%s source hash %q does not match listed %q", template.ID, hash, template.ContentHash)
		}
	}
}

func TestSourceLookupRejectsUnknownVersion(t *testing.T) {
	if _, _, ok := (Source{}).Lookup("summary", 2); ok {
		t.Fatal("lookup of an unlisted version must fail")
	}
	if _, _, ok := (Source{}).Lookup("missing", 1); ok {
		t.Fatal("lookup of an unknown template must fail")
	}
}
