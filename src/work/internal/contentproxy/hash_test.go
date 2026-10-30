package contentproxy

import (
	"testing"

	"github.com/we-meet/work/internal/contentref"
)

func TestVerifyReferenceBodyUsesTheKindSpecificHash(t *testing.T) {
	body := []byte(`{"kind":"model_receipt"}`)
	plain := hashBytes(body)
	if !verifyReferenceBody(contentref.Reference{Kind: contentref.KindInput, ContentHash: plain, Bytes: int64(len(body))}, body) {
		t.Fatal("plain body hash must verify for non-document kinds")
	}
	if verifyReferenceBody(contentref.Reference{Kind: contentref.KindModelRequest, ContentHash: plain, Bytes: int64(len(body))}, body) {
		t.Fatal("a plain digest must not satisfy a canonical document binding")
	}
	if verifyReferenceBody(contentref.Reference{Kind: contentref.KindInput, ContentHash: plain, Bytes: int64(len(body)) + 1}, body) {
		t.Fatal("byte count mismatch must fail")
	}
}
