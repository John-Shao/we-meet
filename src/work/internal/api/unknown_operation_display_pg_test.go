package api_test

// D2' promises that an unknown run result displays as "reconciling" and never as a
// success (runtimeExposure.unknownResultDisplayState / unknownResultMayShowSuccess).
// The promise lives in one CASE branch of the task_summary view
// (migrations/baseline/0002_initial_r0a_schema.sql:2780-2783): an active or waiting run
// carrying an operation in 'unknown' or 'unresolved' yields 'reconciling', and that
// branch sits above the catch-all 'running'. Nothing drove the branch through the
// operation state - the existing inbox test names 'reconciling' among its expected
// types but reaches it another way - so this pins it, including the negative half that
// keeps the branch from being unconditional.

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

func TestUnknownOperationMakesTheTaskReconciling(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	pool, dbName := newBootstrapDB(t, true, true)
	// Same task shape and run state in all four rows; only the operation state (and one
	// terminal task state) differs, so a display_state difference can only come from
	// those two things.
	ibxSeedTasks(t, dbName,
		ibxSeed{n: 1, org: "org_a", owner: "sub_a", taskState: "open",
			runState: "active", openRun: true, operation: "unknown"},
		ibxSeed{n: 2, org: "org_a", owner: "sub_a", taskState: "open",
			runState: "active", openRun: true, operation: "unresolved"},
		// The negative half: an ordinary in-flight operation must not read as reconciling.
		ibxSeed{n: 3, org: "org_a", owner: "sub_a", taskState: "open",
			runState: "active", openRun: true, operation: "prepared"},
		// A finished task is the only row allowed to look settled, and it must not be
		// produced by the unknown branch.
		ibxSeed{n: 4, org: "org_a", owner: "sub_a", taskState: "completed"},
	)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	response := ibxSessionGet(t, server.URL+api.InboxPath)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("inbox status = %d body=%s", response.StatusCode, readBody(response))
	}
	_, raw := ibxDecodeInbox(t, response)
	var items []map[string]json.RawMessage
	if err := json.Unmarshal(raw["items"], &items); err != nil {
		t.Fatal(err)
	}
	states := map[string]string{}
	for _, item := range items {
		var taskID, displayState string
		if err := json.Unmarshal(item["task_id"], &taskID); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(item["display_state"], &displayState); err != nil {
			t.Fatal(err)
		}
		states[taskID] = displayState
	}

	for _, n := range []int{1, 2} {
		taskID := ibxUUID("8", n)
		if states[taskID] != "reconciling" {
			t.Errorf("task %d (unknown/unresolved operation) display_state = %q, want "+
				"reconciling; an unfinished run must never be presented as settled", n, states[taskID])
		}
	}
	for _, n := range []int{3, 4} {
		taskID := ibxUUID("8", n)
		if state, listed := states[taskID]; listed {
			t.Errorf("task %d appears in the inbox with display_state %q, want it absent: the "+
				"reconciling branch is firing for rows that have no unknown operation", n, state)
		}
	}
	if settled := states[ibxUUID("8", 4)]; settled != "" {
		t.Errorf("completed task reports %q here, want it absent from this endpoint's rows", settled)
	}
}
