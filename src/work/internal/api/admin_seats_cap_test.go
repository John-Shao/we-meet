package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

// TestAdminSeatsCappedPageProbesForMore covers the capped page, where list_seats
// cannot be asked for limit+1: 101 seats and limit=100 must hand back exactly one
// more page, and that final single-row page must not advertise a cursor.
func TestAdminSeatsCappedPageProbesForMore(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	script := `
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		SELECT 'org_a', 'sub_b', 'active', 'member', true
		UNION ALL SELECT 'org_a', 'sub_c', 'active', 'member', true
		UNION ALL SELECT 'org_a', 'sub_d', 'active', 'member', true
		UNION ALL
		SELECT 'org_a', 'm' || lpad(g::text, 4, '0'), 'active', 'member', true
		FROM generate_series(1, 97) g;
	`
	if err := testpg.ExecRaw(ctx, admin, script); err != nil {
		t.Fatal(err)
	}
	admin.Close(ctx)

	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	first := fetchSeatPage(t, server.URL, "limit=100", "")
	if len(first.Items) != 100 || first.NextCursor == nil {
		t.Fatalf("first capped page = %d items cursor %v", len(first.Items), first.NextCursor)
	}
	second := fetchSeatPage(t, server.URL, "limit=100", *first.NextCursor)
	if len(second.Items) != 1 || second.NextCursor != nil {
		t.Fatalf("tail page = %d items cursor %v, want 1 item and no cursor",
			len(second.Items), second.NextCursor)
	}
}

type seatPage struct {
	Items      []api.AdminSeat `json:"items"`
	NextCursor *string         `json:"next_cursor"`
}

func fetchSeatPage(t *testing.T, baseURL, limit, cursor string) seatPage {
	t.Helper()
	url := baseURL + api.AdminSeatsPath + "?" + limit
	if cursor != "" {
		url += "&cursor=" + cursor
	}
	response := taskRequest(t, http.MethodGet, url, workspaceCSRF(t, baseURL), "")
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("seats status = %d", response.StatusCode)
	}
	var page seatPage
	if err := json.NewDecoder(response.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	return page
}
