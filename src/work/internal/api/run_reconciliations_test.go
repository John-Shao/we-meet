package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

const (
	reconcileRunID  = "21111111-1111-4111-8111-111111111111"
	reconcileTaskID = "11111111-1111-4111-8111-111111111111"
	otherOwnerRunID = "21111111-1111-4111-8111-333333333333"
	reconcileOpID   = "61111111-1111-4111-8111-111111111111"
)

// seedWaitingOperation puts one Operation on the fixture Run in the state the read face
// exists for: unknown, with the wait clock stamped by 0017's trigger.
func seedWaitingOperation(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', $1, false)`, testOrg); err != nil {
		t.Fatal(err)
	}
	// Multi-statement seeding goes through ExecRaw, which uses the simple query
	// protocol; the extended protocol refuses a script.
	script := `
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash,
		  state, step_key, reconcile_requested_at)
		VALUES ('` + reconcileOpID + `', '` + testOrg + `', '` + reconcileRunID + `',
		        'tool:3#0', 'tool', repeat('c', 64), 'dispatching', 'tool:3', NULL);
		UPDATE work.operation SET state = 'unknown' WHERE id = '` + reconcileOpID + `';
		UPDATE work.run SET state = 'waiting', wait_reason = 'reconcile'
		WHERE id = '` + reconcileRunID + `';
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

func TestRunReconciliationsReadFace(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	seedWaitingOperation(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	reconciliationsPath := strings.ReplaceAll(api.RunReconciliationsPath, "{runId}", reconcileRunID)
	url := server.URL + reconciliationsPath
	response := taskRequest(t, http.MethodGet, url, "", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.StatusCode, readBody(response))
	}
	out := decodeObject(t, response)
	// Metadata only, and named once: §1.4 lists the fields this has to answer, so a
	// missing key here means the client is back to guessing from an ops job.
	for _, key := range []string{"org_id", "run_id", "task_id", "run_state", "wait_reason",
		"blocking", "items"} {
		if _, ok := out[key]; !ok {
			t.Fatalf("response is missing %q", key)
		}
	}
	items, ok := out["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("items = %#v, want the one unknown step", out["items"])
	}
	item, _ := items[0].(map[string]any)
	if item["operation_id"] != reconcileOpID || item["resolution_state"] != "pending" ||
		item["contact_path"] != "wait_for_reconciliation" ||
		item["has_authoritative_evidence"] != false {
		t.Fatalf("item = %#v", item)
	}
	if item["reconcile_requested_at"] == nil || item["waited_seconds"] == nil {
		t.Fatalf("the wait clock is missing: %#v", item)
	}
	blocking, _ := out["blocking"].(map[string]any)
	if blocking["new_run"] != true || blocking["acceptance"] != true {
		t.Fatalf("blocking = %#v, want both while a step is unknown", blocking)
	}
	if out["run_state"] != "waiting" || out["wait_reason"] != "reconcile" {
		t.Fatalf("run fields = %v/%v", out["run_state"], out["wait_reason"])
	}
	if out["task_id"] != reconcileTaskID || out["org_id"] != testOrg {
		t.Fatalf("envelope ids = %v/%v", out["org_id"], out["task_id"])
	}

	// A Run under somebody else's task answers as not-found rather than forbidden, and an
	// unknown identifier the same way: this view exists for the owner's own wait.
	foreign := taskRequest(t, http.MethodGet,
		server.URL+strings.ReplaceAll(api.RunReconciliationsPath, "{runId}", otherOwnerRunID), "", "")
	assertAPICode(t, foreign, http.StatusNotFound, "task_not_found")
	malformed := taskRequest(t, http.MethodGet,
		server.URL+strings.ReplaceAll(api.RunReconciliationsPath, "{runId}", "not-a-uuid"), "", "")
	assertAPICode(t, malformed, http.StatusNotFound, "run_not_found")

	// §1.4's permission column is owner plus a current seat, so losing the seat closes this
	// face the same way it closes the task reads.
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
