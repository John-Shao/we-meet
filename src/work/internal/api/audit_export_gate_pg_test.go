package api_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

// Migration 0026 gives POST /work/v1/admin/audit-exports the organization gate the
// D3-N06 row promises: with the switch on, new submissions *and new exports* are 0,
// while reads and the obligation jobs keep working. The two halves that make this
// more than "it returns an error" are the replay that must still succeed and the
// row count that must not move.

// exportWindow is computed once for the whole test binary, not once per call. 0026 binds an
// export's receipt to a hash of its payload, and TestCreateAuditExportGateKeepsReadsAndReplaysAlive
// exists to prove that a replay under the same key returns the original job - so the replay must
// carry the *same* payload. Deriving the window from a fresh time.Now() at each call made the two
// bodies differ whenever the calls straddled a boundary, and the replay then correctly answered
// idempotency_key_conflict: an intermittent red that looks exactly like a product defect. Truncating
// to the minute only lowers the odds; one shared value removes the race, and an hour-old range
// still satisfies both the retention floor and the range_to <= now rule.
var exportWindow = time.Now().UTC().Truncate(time.Minute)

func adminExportBody(clientRequestID string) string {
	return `{"client_request_id":"` + clientRequestID + `","range_from":"` +
		exportWindow.Add(-2*time.Hour).Format(time.RFC3339) + `","range_to":"` +
		exportWindow.Add(-time.Hour).Format(time.RFC3339) + `","format":"csv"}`
}

func adminExportHarness(
	t *testing.T,
) (func(string, string, string, ...string) *http.Response, string) {
	t.Helper()
	pool, dbName := newBootstrapDB(t, true, false)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	bootstrap := doBootstrap(t, server.URL, "session-value", "corr-gate")
	if bootstrap.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap status = %d", bootstrap.StatusCode)
	}
	var boot api.BootstrapResponse
	if err := json.NewDecoder(bootstrap.Body).Decode(&boot); err != nil {
		t.Fatal(err)
	}
	bootstrap.Body.Close()
	csrfCookie := findCookie(t, bootstrap, api.CSRFCookieName)
	request := func(method, path, body string, headers ...string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
		req.AddCookie(csrfCookie)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		// The double-submit pair is required by the method, not by the presence of a
		// body: issuing a download ticket is a POST that carries no payload.
		if method != http.MethodGet {
			req.Header.Set("X-CSRF-Token", boot.CSRFToken)
		}
		// Download tokens ride on a header, not on the session, so the shared
		// request helper has to carry them without every caller re-implementing it.
		for index := 0; index+1 < len(headers); index += 2 {
			req.Header.Set(headers[index], headers[index+1])
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	return request, dbName
}

func setOrgFlags(t *testing.T, dbName, set string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "UPDATE work.org SET "+set+" WHERE id = 'org_a'"); err != nil {
		t.Fatal(err)
	}
}

func exportRowCount(t *testing.T, dbName string) int {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var count int
	if err := conn.QueryRow(ctx,
		`SELECT count(*) FROM work.audit_export WHERE org_id = 'org_a'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func decodeExportID(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	id, _ := body["id"].(string)
	return id
}

func TestCreateAuditExportGateKeepsReadsAndReplaysAlive(t *testing.T) {
	request, dbName := adminExportHarness(t)

	first := request(http.MethodPost, api.AdminAuditExportsPath, adminExportBody("gate-export-000001"))
	if first.StatusCode != http.StatusAccepted {
		t.Fatalf("baseline create status = %d body=%s", first.StatusCode, readBody(first))
	}
	firstID := decodeExportID(t, first)
	if firstID == "" {
		t.Fatal("baseline create returned no export id")
	}
	if got := exportRowCount(t, dbName); got != 1 {
		t.Fatalf("export rows after baseline create = %d, want 1", got)
	}

	setOrgFlags(t, dbName, "operator_suspended = true")

	// A new request while switched off is a conflict that names the human decision,
	// not a 503: org_operator_suspended is public, 409, recovery contact_operator.
	blocked := request(http.MethodPost, api.AdminAuditExportsPath, adminExportBody("gate-export-000002"))
	assertAPICode(t, blocked, http.StatusConflict, "org_operator_suspended")
	if got := exportRowCount(t, dbName); got != 1 {
		t.Fatalf("export rows while suspended = %d, want the single pre-switch job", got)
	}

	// The idempotency promise outlives the switch: the same key with the same
	// parameters still returns the original job. Refusing this would let a retry
	// after a lost ACK claim the work never happened.
	replay := request(http.MethodPost, api.AdminAuditExportsPath, adminExportBody("gate-export-000001"))
	if replay.StatusCode != http.StatusAccepted {
		t.Fatalf("suspended replay status = %d body=%s", replay.StatusCode, readBody(replay))
	}
	if replayID := decodeExportID(t, replay); replayID != firstID {
		t.Fatalf("suspended replay = %s, want the original %s", replayID, firstID)
	}

	// "可读" is the other half of the same row: reads are not switched off, so an
	// operator can still see seats and usage while the organization is paused.
	overview := request(http.MethodGet, api.AdminOverviewPath, "")
	assertStatusOpen(t, overview, http.StatusOK)
	seats := request(http.MethodGet, api.AdminSeatsPath+"?limit=1", "")
	assertStatusOpen(t, seats, http.StatusOK)

	// Recovering the switch accepts new work again and does not replay the job the
	// blocked request never created.
	setOrgFlags(t, dbName, "operator_suspended = false")
	resumed := request(http.MethodPost, api.AdminAuditExportsPath, adminExportBody("gate-export-000002"))
	if resumed.StatusCode != http.StatusAccepted {
		t.Fatalf("resumed create status = %d body=%s", resumed.StatusCode, readBody(resumed))
	}
	resumedID := decodeExportID(t, resumed)
	if resumedID == "" || resumedID == firstID {
		t.Fatalf("resumed create = %q, want a new job", resumedID)
	}
	if got := exportRowCount(t, dbName); got != 2 {
		t.Fatalf("export rows after resume = %d, want 2", got)
	}

	// A disabled-but-not-suspended organization reports the policy answer with its
	// own status, and archived is the same case: neither is a 503.
	setOrgFlags(t, dbName, "execution_enabled = false")
	disabled := request(http.MethodPost, api.AdminAuditExportsPath, adminExportBody("gate-export-000003"))
	assertAPICode(t, disabled, http.StatusForbidden, "org_execution_unavailable")
	setOrgFlags(t, dbName, "execution_enabled = true, status = 'archived'")
	archived := request(http.MethodPost, api.AdminAuditExportsPath, adminExportBody("gate-export-000004"))
	assertAPICode(t, archived, http.StatusForbidden, "org_execution_unavailable")
	if got := exportRowCount(t, dbName); got != 2 {
		t.Fatalf("export rows after disabled and archived attempts = %d, want 2", got)
	}
}

func assertStatusOpen(t *testing.T, response *http.Response, status int) {
	t.Helper()
	defer response.Body.Close()
	if response.StatusCode != status {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
		t.Fatalf("status = %d, want %d body=%s", response.StatusCode, status, body)
	}
}
