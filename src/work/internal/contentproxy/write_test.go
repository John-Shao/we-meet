package contentproxy

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
)

const writeSlot = "checkpoint:model:2:candidate"

func checkpointRequest(t *testing.T, body string, headers map[string]string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/checkpoints", strings.NewReader(body))
	request.Header.Set(HeaderAuthorization, "Bearer "+testToken)
	request.Header.Set(HeaderOrg, testOrg)
	request.Header.Set(HeaderExecution, testExecution)
	request.Header.Set(HeaderGeneration, "1")
	request.Header.Set(HeaderRefID, testRefID)
	request.Header.Set(HeaderLogicalSlot, writeSlot)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	return request
}

func digestOf(body string) string {
	sum := sha256.Sum256([]byte(body))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func TestCheckpointReservesWritesAndCommitsInOrder(t *testing.T) {
	body := "candidate checkpoint body"
	hash := digestOf(body)
	references := &fakeReferences{}
	store := &fakeStore{putRef: content.Ref{ContentRef: "content://work/org/candidate", Hash: hash, Bytes: int64(len(body))}}
	handler := newTestHandler(t, &fakeAuthorizer{allowed: true}, references, store)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, checkpointRequest(t, body, map[string]string{HeaderContentHash: hash}))

	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if len(references.reserved) != 1 || len(references.committed) != 1 || store.puts != 1 {
		t.Fatalf("reserved=%v committed=%v puts=%d", references.reserved, references.committed, store.puts)
	}
	if !strings.Contains(references.committed[0], hash) {
		t.Fatalf("commit did not bind the stored hash: %v", references.committed)
	}
	if strings.Contains(response.Body.String(), body) {
		t.Fatal("checkpoint response echoed the body")
	}
}

func TestCheckpointHashMismatchStaysUncommitted(t *testing.T) {
	body := "candidate body"
	declared := digestOf("a different body")
	references := &fakeReferences{}
	store := &fakeStore{putRef: content.Ref{ContentRef: "content://work/org/candidate", Hash: digestOf(body), Bytes: int64(len(body))}}
	handler := newTestHandler(t, &fakeAuthorizer{allowed: true}, references, store)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, checkpointRequest(t, body, map[string]string{HeaderContentHash: declared}))

	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d", response.Code)
	}
	if len(references.reserved) != 1 || len(references.committed) != 0 {
		t.Fatalf("reserved=%v committed=%v", references.reserved, references.committed)
	}
}

func TestCheckpointSlotConflictAndUnauthorized(t *testing.T) {
	body := "candidate body"
	hash := digestOf(body)
	store := &fakeStore{putRef: content.Ref{ContentRef: "content://work/org/candidate", Hash: hash, Bytes: int64(len(body))}}

	conflict := &fakeReferences{reserveErr: contentref.ErrSlotConflict}
	handler := newTestHandler(t, &fakeAuthorizer{allowed: true}, conflict, store)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, checkpointRequest(t, body, map[string]string{HeaderContentHash: hash}))
	if response.Code != http.StatusConflict || store.puts != 0 {
		t.Fatalf("conflict status = %d puts=%d", response.Code, store.puts)
	}

	denied := &fakeReferences{}
	handler = newTestHandler(t, &fakeAuthorizer{allowed: false}, denied, store)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, checkpointRequest(t, body, map[string]string{HeaderContentHash: hash}))
	if response.Code != http.StatusUnauthorized || len(denied.reserved) != 0 {
		t.Fatalf("denied status = %d", response.Code)
	}
}

func TestCheckpointRequiresDeclaredBindingHeaders(t *testing.T) {
	body := "candidate body"
	handler := newTestHandler(t, &fakeAuthorizer{allowed: true}, &fakeReferences{}, &fakeStore{})
	request := checkpointRequest(t, body, map[string]string{HeaderContentHash: digestOf(body)})
	request.Header.Del(HeaderRefID)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d", response.Code)
	}
}
