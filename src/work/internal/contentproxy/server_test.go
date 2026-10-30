package contentproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
)

const (
	testOrg       = "org_content_proxy"
	testExecution = "11111111-1111-4111-8111-111111111111"
	testRefID     = "22222222-2222-4222-8222-222222222222"
	testToken     = "b3BhcXVlLXRva2VuLWZvci10ZXN0aW5n"
	testBody      = "candidate body that must never leak"
)

type fakeAuthorizer struct {
	allowed    bool
	err        error
	calls      int
	org        string
	execution  string
	audience   string
	generation int
	token      string
}

func (f *fakeAuthorizer) Authorize(_ context.Context, orgID, executionID, audience string,
	generation int, token string) (bool, error) {
	f.calls++
	f.org, f.execution, f.audience = orgID, executionID, audience
	f.generation, f.token = generation, token
	return f.allowed, f.err
}

type fakeReferences struct {
	reference  contentref.Reference
	err        error
	reserveErr error
	commitErr  error
	org        string
	refID      string
	reserved   []string
	committed  []string
}

func (f *fakeReferences) Resolve(_ context.Context, orgID, refID string) (contentref.Reference, error) {
	f.org, f.refID = orgID, refID
	return f.reference, f.err
}

func (f *fakeReferences) Reserve(_ context.Context, orgID, refID, executionID string,
	_ contentref.Kind, logicalSlot string,
) error {
	f.reserved = append(f.reserved, orgID+"/"+refID+"/"+executionID+"/"+logicalSlot)
	return f.reserveErr
}

func (f *fakeReferences) Commit(_ context.Context, orgID, refID, contentRef, contentHash string, _ int64) error {
	f.committed = append(f.committed, orgID+"/"+refID+"/"+contentHash)
	return f.commitErr
}

type fakeStore struct {
	body       []byte
	err        error
	putRef     content.Ref
	putErr     error
	org        string
	contentRef string
	puts       int
}

func (f *fakeStore) Get(_ context.Context, orgID, contentRef string) ([]byte, error) {
	f.org, f.contentRef = orgID, contentRef
	return f.body, f.err
}

func (f *fakeStore) Put(_ context.Context, orgID string, plaintext []byte) (content.Ref, error) {
	f.puts++
	f.org = orgID
	return f.putRef, f.putErr
}

func boundReference(body []byte) contentref.Reference {
	return contentref.Reference{
		RefID:         testRefID,
		OrgID:         testOrg,
		TaskID:        "33333333-3333-4333-8333-333333333333",
		RunID:         "44444444-4444-4444-8444-444444444444",
		ExecutionID:   testExecution,
		Kind:          contentref.KindCheckpointCandidate,
		LogicalSlot:   "checkpoint:model:1:candidate",
		ObjectVersion: "v1",
		ContentRef:    "content://work/org_content_proxy/abcdef",
		ContentHash:   hashBytes(body),
		Bytes:         int64(len(body)),
		WriterKind:    contentref.WriterControlPlane,
	}
}

func newTestHandler(t *testing.T, authorizer Authorizer, references References, store Reader) http.Handler {
	t.Helper()
	server, err := New(Config{ListenAddr: "127.0.0.1:0"}, authorizer, references, store)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	return server.Handler()
}

func readRequest(t *testing.T, refID, org, execution, token string, generation string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/content/"+refID, nil)
	request.Header.Set(HeaderAuthorization, "Bearer "+token)
	request.Header.Set(HeaderOrg, org)
	request.Header.Set(HeaderExecution, execution)
	request.Header.Set(HeaderGeneration, generation)
	return request
}

func serve(handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeCode(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var payload map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("error body is not JSON: %q", recorder.Body.String())
	}
	if len(payload) != 1 || payload["code"] == "" {
		t.Fatalf("error body = %q, want exactly one code field", recorder.Body.String())
	}
	return payload["code"]
}

func TestBoundReadReturnsVerifiedBytes(t *testing.T) {
	reference := boundReference([]byte(testBody))
	authorizer := &fakeAuthorizer{allowed: true}
	references := &fakeReferences{reference: reference}
	store := &fakeStore{body: []byte(testBody)}
	handler := newTestHandler(t, authorizer, references, store)

	recorder := serve(handler, readRequest(t, testRefID, testOrg, testExecution, testToken, "7"))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.String() != testBody {
		t.Fatalf("body = %q, want the exact stored bytes", recorder.Body.String())
	}
	if authorizer.calls != 1 || authorizer.org != testOrg ||
		authorizer.execution != testExecution || authorizer.audience != "work-content" ||
		authorizer.generation != 7 || authorizer.token != testToken {
		t.Fatalf("authorization call = %#v", authorizer)
	}
	if references.org != testOrg || references.refID != testRefID {
		t.Fatalf("resolve call = %#v", references)
	}
	if store.org != testOrg || store.contentRef != reference.ContentRef {
		t.Fatalf("store call = %#v", store)
	}
	if got := recorder.Header().Get(headerContentHash); got != reference.ContentHash {
		t.Fatalf("hash header = %q", got)
	}
	if got := recorder.Header().Get(headerContentKind); got != string(contentref.KindCheckpointCandidate) {
		t.Fatalf("kind header = %q", got)
	}
	if got := recorder.Header().Get(headerContentBytes); got != fmt.Sprint(len(testBody)) {
		t.Fatalf("bytes header = %q", got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache-control = %q", got)
	}
}

// TestEveryCredentialFailureIsUnauthorized covers the four credential headers
// and a denied capability. None of these may reach the reference registry.
func TestEveryCredentialFailureIsUnauthorized(t *testing.T) {
	reference := boundReference([]byte(testBody))
	cases := []struct {
		name    string
		mutate  func(*http.Request)
		allowed bool
		calls   int
	}{
		{name: "missing authorization", mutate: func(r *http.Request) {
			r.Header.Del(HeaderAuthorization)
		}},
		{name: "wrong scheme", mutate: func(r *http.Request) {
			r.Header.Set(HeaderAuthorization, "Basic "+testToken)
		}},
		{name: "duplicate authorization", mutate: func(r *http.Request) {
			r.Header.Add(HeaderAuthorization, "Bearer "+testToken+"second")
		}},
		{name: "missing org", mutate: func(r *http.Request) { r.Header.Del(HeaderOrg) }},
		{name: "malformed execution", mutate: func(r *http.Request) {
			r.Header.Set(HeaderExecution, "not-a-uuid")
		}},
		{name: "zero generation", mutate: func(r *http.Request) {
			r.Header.Set(HeaderGeneration, "0")
		}},
		{name: "malformed generation", mutate: func(r *http.Request) {
			r.Header.Set(HeaderGeneration, "2x")
		}},
		{name: "denied capability", allowed: false, calls: 1, mutate: func(*http.Request) {}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			authorizer := &fakeAuthorizer{allowed: testCase.allowed}
			references := &fakeReferences{reference: reference}
			store := &fakeStore{body: []byte(testBody)}
			handler := newTestHandler(t, authorizer, references, store)

			request := readRequest(t, testRefID, testOrg, testExecution, testToken, "1")
			testCase.mutate(request)
			recorder := serve(handler, request)

			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (body %q)", recorder.Code, recorder.Body.String())
			}
			if code := decodeCode(t, recorder); code != codeCapabilityInvalid {
				t.Fatalf("code = %q", code)
			}
			if authorizer.calls != testCase.calls {
				t.Fatalf("authorize calls = %d, want %d", authorizer.calls, testCase.calls)
			}
			if references.refID != "" || store.contentRef != "" {
				t.Fatalf("denied request reached the registry/store")
			}
			assertNoLeak(t, recorder, testToken, testBody)
		})
	}
}

// TestAuthorizationAndReferenceFailures proves the enumeration mapping and the
// fail-closed behaviour when a backend is unavailable.
func TestAuthorizationAndReferenceFailures(t *testing.T) {
	cases := []struct {
		name       string
		authorizer *fakeAuthorizer
		references *fakeReferences
		store      *fakeStore
		status     int
		code       string
	}{
		{
			name:       "authorization backend down",
			authorizer: &fakeAuthorizer{err: errors.New("connect failed: postgres://secret")},
			references: &fakeReferences{},
			store:      &fakeStore{},
			status:     http.StatusServiceUnavailable,
			code:       codeAuthorizationUnavailable,
		},
		{
			name:       "reference missing or tombstoned",
			authorizer: &fakeAuthorizer{allowed: true},
			references: &fakeReferences{err: contentref.ErrNotFound},
			store:      &fakeStore{},
			status:     http.StatusNotFound,
			code:       codeContentReferenceNotFound,
		},
		{
			name:       "reference malformed",
			authorizer: &fakeAuthorizer{allowed: true},
			references: &fakeReferences{err: &contentref.Error{Code: "invalid_request"}},
			store:      &fakeStore{},
			status:     http.StatusUnprocessableEntity,
			code:       codeInvalidRequest,
		},
		{
			name:       "reference backend down",
			authorizer: &fakeAuthorizer{allowed: true},
			references: &fakeReferences{err: &contentref.Error{Code: "content_reference_unavailable"}},
			store:      &fakeStore{},
			status:     http.StatusServiceUnavailable,
			code:       codeContentReferenceUnavailable,
		},
		{
			name:       "reference bound to another execution",
			authorizer: &fakeAuthorizer{allowed: true},
			references: &fakeReferences{reference: func() contentref.Reference {
				other := boundReference([]byte(testBody))
				other.ExecutionID = "55555555-5555-4555-8555-555555555555"
				return other
			}()},
			store:  &fakeStore{body: []byte(testBody)},
			status: http.StatusForbidden,
			code:   codeContentAccessDenied,
		},
		{
			name:       "reference not bound to any execution",
			authorizer: &fakeAuthorizer{allowed: true},
			references: &fakeReferences{reference: func() contentref.Reference {
				unbound := boundReference([]byte(testBody))
				unbound.ExecutionID = ""
				return unbound
			}()},
			store:  &fakeStore{body: []byte(testBody)},
			status: http.StatusForbidden,
			code:   codeContentAccessDenied,
		},
		{
			name:       "content store down",
			authorizer: &fakeAuthorizer{allowed: true},
			references: &fakeReferences{reference: boundReference([]byte(testBody))},
			store:      &fakeStore{err: errors.New("read content object: open /secret/path")},
			status:     http.StatusServiceUnavailable,
			code:       codeContentUnavailable,
		},
		{
			name:       "stored bytes do not match the hash",
			authorizer: &fakeAuthorizer{allowed: true},
			references: &fakeReferences{reference: boundReference([]byte(testBody))},
			store:      &fakeStore{body: []byte("different body")},
			status:     http.StatusInternalServerError,
			code:       codeContentIntegrityFailed,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler := newTestHandler(t, testCase.authorizer, testCase.references, testCase.store)
			recorder := serve(handler, readRequest(t, testRefID, testOrg, testExecution, testToken, "1"))
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, want %d (body %q)", recorder.Code, testCase.status, recorder.Body.String())
			}
			if code := decodeCode(t, recorder); code != testCase.code {
				t.Fatalf("code = %q, want %q", code, testCase.code)
			}
			assertNoLeak(t, recorder, testToken, testBody)
			if bytes.Contains(recorder.Body.Bytes(), []byte(testRefID)) {
				t.Fatalf("error body echoed the reference id: %q", recorder.Body.String())
			}
		})
	}
}

func TestAuthorizationIsNeverCached(t *testing.T) {
	reference := boundReference([]byte(testBody))
	authorizer := &fakeAuthorizer{allowed: true}
	handler := newTestHandler(t, authorizer, &fakeReferences{reference: reference},
		&fakeStore{body: []byte(testBody)})

	if recorder := serve(handler, readRequest(t, testRefID, testOrg, testExecution, testToken, "1")); recorder.Code != http.StatusOK {
		t.Fatalf("first read status = %d", recorder.Code)
	}
	authorizer.allowed = false
	recorder := serve(handler, readRequest(t, testRefID, testOrg, testExecution, testToken, "1"))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("second read status = %d, want a fresh 401", recorder.Code)
	}
	if authorizer.calls != 2 {
		t.Fatalf("authorize calls = %d, want 2", authorizer.calls)
	}
}

func TestOversizedBodyIsRejected(t *testing.T) {
	authorizer := &fakeAuthorizer{allowed: true}
	handler := newTestHandler(t, authorizer, &fakeReferences{}, &fakeStore{})
	oversized := bytes.Repeat([]byte("x"), int(MaxRequestBodyBytes)+1)

	declared := httptest.NewRequest(http.MethodGet, "/internal/v1/content/"+testRefID,
		bytes.NewReader(oversized))
	request := readRequest(t, testRefID, testOrg, testExecution, testToken, "1")
	request.Body = declared.Body
	request.ContentLength = int64(len(oversized))
	recorder := serve(handler, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("declared oversized body status = %d (body %q)", recorder.Code, recorder.Body.String())
	}
	if code := decodeCode(t, recorder); code != codeRequestTooLarge {
		t.Fatalf("code = %q", code)
	}

	chunked := readRequest(t, testRefID, testOrg, testExecution, testToken, "1")
	chunked.Body = io.NopCloser(bytes.NewReader(oversized))
	chunked.ContentLength = -1
	recorder = serve(handler, chunked)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunked oversized body status = %d (body %q)", recorder.Code, recorder.Body.String())
	}
	if authorizer.calls != 0 {
		t.Fatalf("oversized body reached authorization %d times", authorizer.calls)
	}
}

func TestOnlyTheReadRouteExists(t *testing.T) {
	handler := newTestHandler(t, &fakeAuthorizer{allowed: true}, &fakeReferences{}, &fakeStore{})

	unknown := serve(handler, httptest.NewRequest(http.MethodGet, "/internal/v1/guess", nil))
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown path status = %d", unknown.Code)
	}
	post := httptest.NewRequest(http.MethodPost, "/internal/v1/content/"+testRefID, nil)
	post.Header.Set(HeaderAuthorization, "Bearer "+testToken)
	post.Header.Set(HeaderOrg, testOrg)
	post.Header.Set(HeaderExecution, testExecution)
	post.Header.Set(HeaderGeneration, "1")
	if recorder := serve(handler, post); recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST read path status = %d", recorder.Code)
	}
	checkpoint := httptest.NewRequest(http.MethodPost, "/internal/v1/checkpoints", nil)
	if recorder := serve(handler, checkpoint); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated checkpoint status = %d, want 401", recorder.Code)
	}
	issuanceRequest := httptest.NewRequest(http.MethodPost, "/internal/v1/issuance", nil)
	if recorder := serve(handler, issuanceRequest); recorder.Code != http.StatusNotFound {
		t.Fatalf("issuance path status = %d, want 404 on the content listener", recorder.Code)
	}
}

func assertNoLeak(t *testing.T, recorder *httptest.ResponseRecorder, secrets ...string) {
	t.Helper()
	body := recorder.Body.String()
	for _, secret := range secrets {
		if strings.Contains(body, secret) {
			t.Fatalf("response leaked %q: %q", secret, body)
		}
	}
}
