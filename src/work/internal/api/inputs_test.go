package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"

	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/testpg"
)

type inputReply struct {
	InputRef    string `json:"input_ref"`
	ContentHash string `json:"content_hash"`
	Bytes       int64  `json:"bytes"`
	ExpiresAt   string `json:"expires_at"`
}

func TestCreateInputStoresEncryptedTextAndDeduplicates(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	store := newTestContentStore(t)
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)
	body := `{"client_request_id":"input-request-0001","goal":"目标文本","background":"背景文本"}`

	first := postInput(t, server.URL, token, body)
	if first.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d", first.StatusCode)
	}
	var reply inputReply
	if err := json.NewDecoder(first.Body).Decode(&reply); err != nil {
		t.Fatal(err)
	}
	first.Body.Close()
	if reply.InputRef == "" || reply.ContentHash == "" || reply.Bytes <= 0 || reply.ExpiresAt == "" {
		t.Fatalf("reply = %#v", reply)
	}
	contentRef, storedHash, storedBytes := inputRow(t, dbName, reply.InputRef)
	if storedHash != reply.ContentHash || storedBytes != reply.Bytes {
		t.Fatalf("db row = %s %s %d", contentRef, storedHash, storedBytes)
	}
	plaintext, err := store.Get(context.Background(), "org_a", contentRef)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(plaintext, []byte("目标文本")) || !bytes.Contains(plaintext, []byte("背景文本")) {
		t.Fatalf("plaintext = %s", plaintext)
	}

	replay := postInput(t, server.URL, token, body)
	if replay.StatusCode != http.StatusCreated {
		t.Fatalf("replay status = %d", replay.StatusCode)
	}
	var replayed inputReply
	_ = json.NewDecoder(replay.Body).Decode(&replayed)
	replay.Body.Close()
	if replayed.InputRef != reply.InputRef {
		t.Fatalf("replay input = %q, want %q", replayed.InputRef, reply.InputRef)
	}

	conflict := postInput(t, server.URL, token,
		`{"client_request_id":"input-request-0001","goal":"different"}`)
	assertAPICode(t, conflict, http.StatusConflict, "idempotency_key_conflict")
}

func TestCreateInputRequiresCSRFWriterAndLimits(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	store := newTestContentStore(t)
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)

	missing := postInput(t, server.URL, "", `{"client_request_id":"input-request-0002","goal":"x"}`)
	assertAPICode(t, missing, http.StatusForbidden, "csrf_invalid")

	longGoal := strings.Repeat("a", 2001)
	oversized := postInput(t, server.URL, token,
		fmt.Sprintf(`{"client_request_id":"input-request-0003","goal":%q}`, longGoal))
	assertAPICode(t, oversized, http.StatusBadRequest, "invalid_request")

	admin, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	_, err = admin.Exec(context.Background(),
		`UPDATE work.member SET role = 'viewer' WHERE org_id = 'org_a' AND subject_id = 'sub_a'`)
	_ = admin.Close(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	viewer := postInput(t, server.URL, token, `{"client_request_id":"input-request-0004","goal":"x"}`)
	assertAPICode(t, viewer, http.StatusForbidden, "forbidden")
}

func newTestContentStore(t *testing.T) *content.Local {
	t.Helper()
	store, err := content.NewLocal(bytes.Repeat([]byte{11}, 32), t.TempDir(), 1)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func newHTTPServerWithContent(t *testing.T, pool *pgxpool.Pool, store content.Store) *httptest.Server {
	t.Helper()
	server, err := api.NewServerWithContent(pool, &stubVerifier{claims: testClaims()}, testCSRF(t), store, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

func postInput(t *testing.T, baseURL, token, body string) *http.Response {
	t.Helper()
	request, _ := http.NewRequest(http.MethodPost, baseURL+api.InputsPath, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	if token != "" {
		request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: token})
		request.Header.Set(api.CSRFHeaderName, token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func inputRow(t *testing.T, dbName, inputID string) (string, string, int64) {
	t.Helper()
	conn, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var ref, hash string
	var bytes int64
	if err := conn.QueryRow(context.Background(),
		`SELECT content_ref, content_hash, bytes FROM work.input_object WHERE id = $1`, inputID,
	).Scan(&ref, &hash, &bytes); err != nil {
		t.Fatal(err)
	}
	return ref, hash, bytes
}
