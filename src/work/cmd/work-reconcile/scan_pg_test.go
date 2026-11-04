package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/testpg"
)

// seedRun is one run plus the task/input/snapshot its FKs require.
type seedRun struct {
	suffix string // 2-hex discriminator used across the four related ids
	org    string
	state  string
}

func uuidFor(kind byte, suffix string) string {
	// kind: t=task r=run i=input s=snapshot. The base digit makes the leading group
	// differ per table so the four related ids never collide; suffix is 2 hex chars.
	base := map[byte]byte{'t': '1', 'r': '2', 'i': '3', 's': '4'}[kind]
	prefix := strings.Repeat(string(base), 8)
	return fmt.Sprintf("%s-1111-4111-8111-0000000000%s", prefix, suffix)
}

func seedSQL(runs []seedRun) string {
	var b strings.Builder
	// Group rows by org. The run-insert org-execution gate is a SECURITY DEFINER
	// function owned by work_owner, so its read of work.org is subject to FORCE RLS
	// and only sees the row matching the session's app.org_id. Set that per org block
	// (as the api tests' seedTaskGraph does) or the gate sees no org and refuses every
	// run. The org seed states execution_enabled explicitly because this test's whole
	// subject is the enabled branch; the schema default is already true
	// (baseline/0002:12, and no increment changes it), so this is intent made
	// legible rather than a workaround for a default-off switch.
	orgOrder := make([]string, 0)
	for _, r := range runs {
		seen := false
		for _, o := range orgOrder {
			if o == r.org {
				seen = true
				break
			}
		}
		if !seen {
			orgOrder = append(orgOrder, r.org)
		}
	}
	for _, org := range orgOrder {
		fmt.Fprintf(&b, "SELECT set_config('app.org_id', '%s', false);\n", org)
		fmt.Fprintf(&b,
			"INSERT INTO work.org (id, status, home_region, name, execution_enabled, operator_suspended) "+
				"VALUES ('%s', 'active', 'cn-north', '%s', true, false);\n",
			org, org)
		for _, r := range runs {
			if r.org != org {
				continue
			}
			t := uuidFor('t', r.suffix)
			i := uuidFor('i', r.suffix)
			s := uuidFor('s', r.suffix)
			run := uuidFor('r', r.suffix)
			fmt.Fprintf(&b,
				"INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes) "+
					"VALUES ('%s', '%s', 'sub_%s', 'content://%s', 'sha256:%s', 10);\n", i, r.org, r.org, r.suffix, r.suffix)
			fmt.Fprintf(&b,
				"INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode, title, input_id, revision) "+
					"VALUES ('%s', '%s', 'sub_%s', 'open', 'ask_each', 'Task %s', '%s', 0);\n", t, r.org, r.org, r.suffix, i)
			fmt.Fprintf(&b,
				"INSERT INTO work.capability_snapshot "+
					"(id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest) "+
					"VALUES ('%s', '%s', '%s', 'test', 'sha256:%s', ARRAY['model_call']::text[], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);\n",
				s, r.org, t, r.suffix)
			fmt.Fprintf(&b,
				"INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id, workflow_id, runtime_version) "+
					"VALUES ('%s', '%s', '%s', 1, '%s', '%s', 'wf-%s', 'test');\n",
				run, r.org, t, r.state, s, r.suffix)
		}
	}
	return b.String()
}

func TestQueryOpenRunsSelectionAndOrgIsolation(t *testing.T) {
	if pgDBName == "" {
		t.Skip("WORK_TEST_PG_URL not set")
	}
	ctx := context.Background()

	// org_a: four open runs (one per state) + three terminal runs.
	// org_b: one open run that must never appear when scanning org_a.
	runs := []seedRun{
		{suffix: "a1", org: "org_a", state: "queued"},
		{suffix: "a2", org: "org_a", state: "active"},
		{suffix: "a3", org: "org_a", state: "waiting"},
		{suffix: "a4", org: "org_a", state: "cancel_requested"},
		{suffix: "a5", org: "org_a", state: "succeeded"},
		{suffix: "a6", org: "org_a", state: "failed"},
		{suffix: "a7", org: "org_a", state: "canceled"},
		{suffix: "b1", org: "org_b", state: "active"},
	}

	admin, err := pgx.Connect(ctx, testpg.AdminURLFor(pgDBName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	if err := testpg.ExecRaw(ctx, admin, seedSQL(runs)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_ = admin.Close(ctx)

	pool, err := db.OpenPool(ctx, testpg.WorkerURL(pgDBName), "work-reconcile-scan-test")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	got, err := queryOpenRuns(ctx, pool, "org_a")
	if err != nil {
		t.Fatalf("queryOpenRuns: %v", err)
	}

	var states []string
	for _, r := range got {
		if !strings.HasPrefix(r.WorkflowID, "wf-a") {
			t.Errorf("org_a scan returned a foreign run: %#v", r)
		}
		states = append(states, r.RunState)
		// No operation/dispatch/reservation seeded, so the LEFT JOINs must yield empties.
		if r.OperationID != "" || r.GateState != "" || r.ReservationState != "" || r.SettledTokens != 0 {
			t.Errorf("unexpected joined payload on %s: %#v", r.WorkflowID, r)
		}
	}
	sort.Strings(states)
	want := []string{"active", "cancel_requested", "queued", "waiting"}
	if strings.Join(states, ",") != strings.Join(want, ",") {
		t.Fatalf("org_a open states = %v, want %v (terminal a5/a6/a7 must be excluded)", states, want)
	}

	// Scanning org_b returns only its own open run — org scoping holds via the
	// worker role's FORCE RLS, not just the explicit WHERE clause.
	gotB, err := queryOpenRuns(ctx, pool, "org_b")
	if err != nil {
		t.Fatalf("queryOpenRuns(org_b): %v", err)
	}
	if len(gotB) != 1 || gotB[0].WorkflowID != "wf-b1" {
		t.Fatalf("org_b scan = %#v, want exactly wf-b1", gotB)
	}
}

// TestQueryOpenRunsJoinsLatestReservation pins the LEFT JOIN to operation and the
// quota_reservation LATERAL's `ORDER BY reservation_seq DESC LIMIT 1` — the join that
// shows an operator the operation state and the reservation actually governing the run.
// Two reservations differ so "latest seq wins" is observable.
//
// Note: seeding an org's runs auto-provisions that org's default quota_account (a run/task
// trigger), so the account is referenced by subselect rather than inserted — a manual
// INSERT collides with the provisioned ('default','<current period>') row.
func TestQueryOpenRunsJoinsLatestReservation(t *testing.T) {
	if pgDBName == "" {
		t.Skip("WORK_TEST_PG_URL not set")
	}
	ctx := context.Background()

	runs := []seedRun{
		{suffix: "c1", org: "org_c", state: "active"},
		{suffix: "c2", org: "org_c", state: "waiting"},
	}

	admin, err := pgx.Connect(ctx, testpg.AdminURLFor(pgDBName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)

	opID := "55555555-5555-4555-8555-0000000000c1"
	runC1 := uuidFor('r', "c1")
	taskC1 := uuidFor('t', "c1")
	accountSub := `(SELECT id FROM work.quota_account
	                    WHERE org_id='org_c' AND account_key='default'
	                      AND period_id=to_char(now(),'YYYY-MM') LIMIT 1)`
	// The operation-insert guard requires its run to be the task's active, non-terminal run,
	// so point task c1 at run c1 first (state 'active' already qualifies it).
	extra := fmt.Sprintf(`
		SELECT set_config('app.org_id', 'org_c', false);
		UPDATE work.task SET active_run_id = '%s' WHERE id = '%s' AND org_id = 'org_c';
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state)
		  VALUES ('%s', 'org_c', '%s', 'model:1', 'model', 'sha256:req', 'dispatching');
		INSERT INTO work.quota_reservation (org_id, account_id, operation_id, reservation_seq, amount_tokens, settled_tokens, state)
		  VALUES ('org_c', %s, '%s', 1, 100, 10, 'settled');
		INSERT INTO work.quota_reservation (org_id, account_id, operation_id, reservation_seq, amount_tokens, settled_tokens, state)
		  VALUES ('org_c', %s, '%s', 2, 100, 30, 'held');
	`, runC1, taskC1, opID, runC1, accountSub, opID, accountSub, opID)

	if err := testpg.ExecRaw(ctx, admin, seedSQL(runs)+extra); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_ = admin.Close(ctx)

	pool, err := db.OpenPool(ctx, testpg.WorkerURL(pgDBName), "work-reconcile-join-test")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	got, err := queryOpenRuns(ctx, pool, "org_c")
	if err != nil {
		t.Fatalf("queryOpenRuns: %v", err)
	}
	byWf := map[string]scanRun{}
	for _, r := range got {
		byWf[r.WorkflowID] = r
	}

	c1, ok := byWf["wf-c1"]
	if !ok {
		t.Fatalf("wf-c1 missing from scan: %#v", got)
	}
	if c1.OperationID != opID || c1.OperationState != "dispatching" {
		t.Errorf("wf-c1 operation = (%q,%q), want (%q,dispatching)", c1.OperationID, c1.OperationState, opID)
	}
	// reservation_seq DESC must pick seq 2 (held, settled 30), not seq 1 (settled, 10).
	if c1.ReservationState != "held" || c1.SettledTokens != 30 {
		t.Errorf("wf-c1 latest reservation = (%q,%d), want (held,30) — seq DESC pick regressed",
			c1.ReservationState, c1.SettledTokens)
	}

	c2, ok := byWf["wf-c2"]
	if !ok {
		t.Fatalf("wf-c2 missing from scan: %#v", got)
	}
	if c2.OperationID != "" || c2.ReservationState != "" || c2.SettledTokens != 0 {
		t.Errorf("wf-c2 (no operation) must join empty, got %#v", c2)
	}
}
