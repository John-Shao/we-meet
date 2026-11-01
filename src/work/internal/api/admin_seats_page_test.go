package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

// TestAdminSeatsCursorTerminatesOnExactPage pins the seats pagination fix: with
// four seats and limit=2 the last page is exactly full, and the old
// len(items)==limit heuristic advertised a fifth row that does not exist, which
// made a client fetch one extra empty page.
func TestAdminSeatsCursorTerminatesOnExactPage(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	script := `
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES
		  ('org_a', 'sub_b', 'active', 'member', true),
		  ('org_a', 'sub_c', 'active', 'member', true),
		  ('org_a', 'sub_d', 'active', 'admin', true);
	`
	if err := testpg.ExecRaw(ctx, admin, script); err != nil {
		t.Fatal(err)
	}
	admin.Close(ctx)

	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	var (
		seen   []string
		cursor string
		pages  int
	)
	for {
		url := server.URL + api.AdminSeatsPath + "?limit=2"
		if cursor != "" {
			url += "&cursor=" + cursor
		}
		response := taskRequest(t, http.MethodGet, url, workspaceCSRF(t, server.URL), "")
		if response.StatusCode != http.StatusOK {
			t.Fatalf("seats page %d status = %d", pages+1, response.StatusCode)
		}
		var page struct {
			Items      []api.AdminSeat `json:"items"`
			NextCursor *string         `json:"next_cursor"`
		}
		if err := json.NewDecoder(response.Body).Decode(&page); err != nil {
			response.Body.Close()
			t.Fatal(err)
		}
		response.Body.Close()
		if len(page.Items) == 0 {
			t.Fatalf("page %d returned no rows, cursor %q: the client would loop", pages+1, cursor)
		}
		for _, item := range page.Items {
			seen = append(seen, item.SubjectID)
		}
		pages++
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
		if pages > 4 {
			t.Fatalf("seats never terminated: %v", seen)
		}
	}
	if len(seen) != 4 || pages != 2 {
		t.Fatalf("walked %d pages over %v, want 2 pages over 4 seats", pages, seen)
	}
}
