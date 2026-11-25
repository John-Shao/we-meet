package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

func TestRunSupersedeBudgetsReadFace(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	url := server.URL + strings.ReplaceAll(api.RunSupersedeBudgetsPath, "{runId}", reconcileRunID)

	response := taskRequest(t, http.MethodGet, url, "", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.StatusCode, readBody(response))
	}
	doc := decodeObject(t, response)
	if len(doc) != 2 || doc["run_id"] != reconcileRunID {
		t.Fatalf("document = %#v, want exactly run_id and steps", doc)
	}
	steps, ok := doc["steps"].([]any)
	if !ok || len(steps) != 0 {
		t.Fatalf("steps = %#v, want an empty array", doc["steps"])
	}

	malformed := taskRequest(t, http.MethodGet,
		server.URL+strings.ReplaceAll(api.RunSupersedeBudgetsPath, "{runId}", "not-a-uuid"), "", "")
	assertAPICode(t, malformed, http.StatusNotFound, "run_not_found")
	foreign := taskRequest(t, http.MethodGet,
		server.URL+strings.ReplaceAll(api.RunSupersedeBudgetsPath, "{runId}", otherOwnerRunID), "", "")
	assertAPICode(t, foreign, http.StatusNotFound, "task_not_found")
	anonymous, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, anonymous, http.StatusUnauthorized, "unauthorized")

	admin, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(),
		`UPDATE work.member SET work_seat = false WHERE org_id = $1 AND subject_id = $2`,
		testOrg, testSubject); err != nil {
		t.Fatal(err)
	}
	admin.Close(context.Background())
	noSeat := taskRequest(t, http.MethodGet, url, "", "")
	assertAPICode(t, noSeat, http.StatusForbidden, "work_seat_required")
}
