package api_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/we-meet/work/internal/testpg"
)

// D5 §10 names four funnel metrics and pilot-metrics.json turns them into go/no-go gates, but the
// only thing that ever computed them was the Node evaluator's own unit test: nothing in the tree
// produced the events array it consumes. scripts/pilot-metrics.sql is that producer-side
// definition - read-only SQL over work.task_event and work.task, per organization. The four §10
// metrics plus the two the ops model already had, and the one §10 asks for that no file defined
// before this: continued_after_acceptance.
//
// What makes this more than a query someone eyeballed: every sequence below is built on
// work.task_event.seq, which is unique per task and strictly increasing (0002:449-463), because two
// facts written in one transaction share a clock. The load-bearing case is Task C, where the member
// edits the title *before* accepting: a "there is a later event" rule counts that as continuation
// and reports the org as stickier than it is, so the expected values below only hold if the SQL
// compares seq against the acceptance event's own seq.

func readMetricsSQL(t *testing.T) string {
	t.Helper()
	for _, candidate := range []string{
		filepath.Join("..", "..", "scripts", "pilot-metrics.sql"),
		filepath.Join("/repo", "src", "work", "scripts", "pilot-metrics.sql"),
	} {
		body, err := os.ReadFile(candidate)
		if err == nil {
			return string(body)
		}
	}
	t.Fatal("scripts/pilot-metrics.sql was not readable from the test working directory; a metrics " +
		"check that silently skips its own subject proves nothing")
	return ""
}

// useAppOrg sets the tenant GUC the FORCEd row-level policies read. It is not decoration:
// work.append_task_event is SECURITY DEFINER, so inside it the effective role is the table owner
// and RLS still applies - without this the owner sees no tasks and the call fails as task_not_found.
func useAppOrg(t *testing.T, conn *pgx.Conn, org string) {
	t.Helper()
	if _, err := conn.Exec(context.Background(),
		`SELECT set_config('app.org_id', $1, false)`, org); err != nil {
		t.Fatalf("setting app.org_id to %s: %v", org, err)
	}
}

func appendEvent(t *testing.T, conn *pgx.Conn, org, task, eventType, payload string) {
	t.Helper()
	useAppOrg(t, conn, org)
	var out string
	if err := conn.QueryRow(context.Background(),
		`SELECT work.append_task_event($1::text, $2::uuid, $3::text, $4::jsonb)`,
		org, task, eventType, payload).Scan(&out); err != nil {
		t.Fatalf("append_task_event(%s, %s): %v", eventType, task, err)
	}
}

func TestPilotMetricsSQLCountsTheFunnelAndHonoursEventOrder(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	const (
		taskA = "11111111-1111-4111-8111-111111111111" // accepted, then edited  -> continued
		taskB = "11111111-1111-4111-8111-222222222222" // accepted, nothing after -> not continued
		taskC = "11111111-1111-4111-8111-333333333333" // edited BEFORE accepting -> must not count
		taskD = "11111111-1111-4111-8111-444444444444" // org_other -> must be filtered out
	)

	// Task A: submit, one succeeded run, publish, accept by version, then a rename.
	appendEvent(t, conn, "org_a", taskA, "task.submitted", `{}`)
	appendEvent(t, conn, "org_a", taskA, "run.succeeded", `{"run_id":"21111111-1111-4111-8111-111111111111"}`)
	appendEvent(t, conn, "org_a", taskA, "task.awaiting_acceptance", `{}`)
	appendEvent(t, conn, "org_a", taskA, "artifact.published", `{"version_no":1}`)
	appendEvent(t, conn, "org_a", taskA, "task.completed", `{"basis":"version","version_no":1}`)
	appendEvent(t, conn, "org_a", taskA, "task.title_update", `{"title":"renamed"}`)

	// Task B: same shape, one failed run, and no activity after the acceptance.
	appendEvent(t, conn, "org_a", taskB, "task.submitted", `{}`)
	appendEvent(t, conn, "org_a", taskB, "run.failed", `{"terminal_reason":"model_error"}`)
	appendEvent(t, conn, "org_a", taskB, "task.awaiting_acceptance", `{}`)
	appendEvent(t, conn, "org_a", taskB, "artifact.published", `{"version_no":1}`)
	appendEvent(t, conn, "org_a", taskB, "task.completed", `{"basis":"version","version_no":1}`)

	// Task C: the trap. The rename happens two events before the acceptance, and the task is
	// closed with a reason rather than a version, so it belongs to the awaiting denominator and to
	// no numerator.
	appendEvent(t, conn, "org_a", taskC, "task.submitted", `{}`)
	appendEvent(t, conn, "org_a", taskC, "task.title_update", `{"title":"edited first"}`)
	appendEvent(t, conn, "org_a", taskC, "task.awaiting_acceptance", `{}`)
	appendEvent(t, conn, "org_a", taskC, "task.completed", `{"basis":"reason","completion_reason":"not useful"}`)

	// Task D: the whole life cycle in the other organization.
	appendEvent(t, conn, "org_other", taskD, "task.submitted", `{}`)
	appendEvent(t, conn, "org_other", taskD, "task.awaiting_acceptance", `{}`)
	appendEvent(t, conn, "org_other", taskD, "artifact.published", `{"version_no":1}`)
	appendEvent(t, conn, "org_other", taskD, "task.completed", `{"basis":"version","version_no":1}`)

	sqlText := readMetricsSQL(t)
	query := func(org string, threshold string) map[string][3]*float64 {
		t.Helper()
		useAppOrg(t, conn, org)
		if _, err := conn.Exec(ctx, `SELECT set_config('work.org_id', $1, false)`, org); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx,
			`SELECT set_config('work.pilot_enabled_at', $1, false)`,
			time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, `SELECT set_config('work.activation_threshold', $1, false)`,
			threshold); err != nil {
			t.Fatal(err)
		}
		rows, err := conn.Query(ctx, sqlText)
		if err != nil {
			t.Fatalf("running pilot-metrics.sql: %v", err)
		}
		defer rows.Close()
		out := map[string][3]*float64{}
		for rows.Next() {
			var metric string
			var num, den, val *float64
			if err := rows.Scan(&metric, &num, &den, &val); err != nil {
				t.Fatal(err)
			}
			out[metric] = [3]*float64{num, den, val}
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return out
	}

	num := func(m map[string][3]*float64, metric string) float64 {
		t.Helper()
		row, ok := m[metric]
		if !ok {
			t.Fatalf("pilot-metrics.sql returned no row for %q, only %v", metric, keys(m))
		}
		if row[0] == nil {
			t.Fatalf("%s numerator is NULL", metric)
		}
		return *row[0]
	}
	value := func(m map[string][3]*float64, metric string) *float64 {
		t.Helper()
		row, ok := m[metric]
		if !ok {
			t.Fatalf("pilot-metrics.sql returned no row for %q, only %v", metric, keys(m))
		}
		return row[2]
	}

	orgA := query("org_a", "3")
	if got := num(orgA, "activation"); got != 2 {
		t.Fatalf("activation numerator = %v, want 2 distinct submitters (sub_a and sub_other) in "+
			"the window; task D belongs to org_other and must not join", got)
	}
	if v := value(orgA, "activation"); v == nil || *v != 0 {
		t.Fatalf("activation gate = %v, want 0: two submitters is below the threshold of 3", v)
	}
	orgAThresholdTwo := query("org_a", "2")
	if v := value(orgAThresholdTwo, "activation"); v == nil || *v != 1 {
		t.Fatalf("activation gate at threshold 2 = %v, want 1 - the same facts must flip, or the "+
			"threshold is being ignored and the gate always reads the same way", v)
	}

	type ratio struct {
		metric           string
		numerator, denom float64
		value            float64
		why              string
	}
	for _, want := range []ratio{
		{"technical_success_rate", 1, 2, 0.5,
			"one succeeded run and one failed run; user-canceled runs are excluded by definition"},
		{"artifact_success_rate", 2, 3, 0.6667,
			"D5 §10 defines technical success as \"has a published result\": task C never published"},
		{"acceptance_rate", 2, 3, 0.6667,
			"three tasks reached awaiting_acceptance, two were accepted by version"},
		{"reason_completion_share", 1, 3, 0.3333,
			"one completion closed with a reason instead of a version"},
		{"continued_after_acceptance", 1, 2, 0.5,
			"only task A shows activity after its own acceptance event; task C's edit predates it " +
				"and task B has nothing after it"},
	} {
		row, ok := orgA[want.metric]
		if !ok {
			t.Fatalf("pilot-metrics.sql returned no row for %q, only %v", want.metric, keys(orgA))
		}
		if row[0] == nil || *row[0] != want.numerator {
			t.Fatalf("%s numerator = %v, want %v (%s)", want.metric, deref(row[0]), want.numerator, want.why)
		}
		if row[1] == nil || *row[1] != want.denom {
			t.Fatalf("%s denominator = %v, want %v (%s)", want.metric, deref(row[1]), want.denom, want.why)
		}
		if row[2] == nil {
			t.Fatalf("%s value is NULL, want %v (%s)", want.metric, want.value, want.why)
		}
		if *row[2] < want.value-0.0002 || *row[2] > want.value+0.0002 {
			t.Fatalf("%s value = %v, want %v (%s)", want.metric, *row[2], want.value, want.why)
		}
	}

	// The window is real: pushing the enable date into the future must empty the denominators,
	// otherwise "activated" would be a property of the data rather than of the pilot window.
	if _, err := conn.Exec(ctx, `SELECT set_config('work.org_id', 'org_a', false)`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('work.pilot_enabled_at', $1, false)`,
		time.Now().UTC().Add(24*time.Hour).Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('work.activation_threshold', '3', false)`); err != nil {
		t.Fatal(err)
	}
	rows, err := conn.Query(ctx, sqlText)
	if err != nil {
		t.Fatal(err)
	}
	later := map[string][3]*float64{}
	for rows.Next() {
		var metric string
		var n, d, v *float64
		if err := rows.Scan(&metric, &n, &d, &v); err != nil {
			t.Fatal(err)
		}
		later[metric] = [3]*float64{n, d, v}
	}
	rows.Close()
	if got := num(later, "activation"); got != 0 {
		t.Fatalf("activation numerator with the window starting tomorrow = %v, want 0", got)
	}
	if v := value(later, "artifact_success_rate"); v != nil {
		t.Fatalf("artifact_success_rate with an empty submit window = %v, want NULL", *v)
	}
	// #32 (adjudicated A, 2026-11-03): the two ratio go_gates are now window-scoped on the same basis
	// as activation and artifact_success_rate. Emptying the submit window must therefore empty their
	// denominators too - the opposite of the previous full-history behaviour, which this assertion
	// used to pin. A NULL here is a live proof the window governs the gates: if the SQL regressed to
	// full history, these would return their in-window values (0.6667 / 0.5) instead of NULL.
	if v := value(later, "acceptance_rate"); v != nil {
		t.Fatalf("acceptance_rate with an empty submit window = %v, want NULL: #32 A windows this gate to "+
			"tasks submitted in the pilot window, so an empty window must empty the denominator", *v)
	}
	if v := value(later, "technical_success_rate"); v != nil {
		t.Fatalf("technical_success_rate with an empty submit window = %v, want NULL (same windowed basis "+
			"as acceptance_rate)", *v)
	}

	// Same file, other organization: task D's full life cycle must be the only thing visible, and
	// nothing from org_a may leak in.
	orgOther := query("org_other", "3")
	if got := num(orgOther, "activation"); got != 1 {
		t.Fatalf("org_other activation numerator = %v, want 1 (sub_a owns the only org_other task)", got)
	}
	if got := num(orgOther, "acceptance_rate"); got != 1 || *orgOther["acceptance_rate"][1] != 1 {
		t.Fatalf("org_other acceptance = %v/%v, want 1/1: task D is accepted there and org_a's "+
			"three tasks must not appear", orgOther["acceptance_rate"][0], orgOther["acceptance_rate"][1])
	}
	if got := num(orgOther, "continued_after_acceptance"); got != 0 {
		t.Fatalf("org_other continued_after_acceptance = %v, want 0: task D has no post-acceptance "+
			"event, so the ratio must be 0 and not borrowed from org_a", got)
	}

	// The time-to-first-artifact column is deliberately not asserted numerically here: every seeded
	// event shares one transaction clock, so its median is 0 in this fixture and 0 would also be the
	// answer for a broken percentile clause. It has to exist and be non-NULL.
	if v := value(orgA, "time_to_first_artifact_p50_seconds"); v == nil {
		t.Fatalf("time_to_first_artifact_p50_seconds = NULL, want a number for two published tasks")
	}

	// Forgetting SET work.org_id must be loud. A silent zero here would read as "nobody activated"
	// on the dashboard that decides whether the pilot continues.
	if _, err := conn.Exec(ctx, `SELECT set_config('work.org_id', '', false)`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, sqlText); err == nil {
		t.Fatal("pilot-metrics.sql ran with an empty work.org_id; it must refuse rather than report " +
			"zeros for an organization nobody selected")
	}
	t.Logf("metrics per org captured: activation=%v technical=%v artifact=%v acceptance=%v "+
		"reason=%v continued=%v", num(orgA, "activation"), *value(orgA, "technical_success_rate"),
		*value(orgA, "artifact_success_rate"), *value(orgA, "acceptance_rate"),
		*value(orgA, "reason_completion_share"), *value(orgA, "continued_after_acceptance"))
}

// #32 (adjudicated A, 2026-11-03): independent proof that the windowed go_gates exclude out-of-window
// tasks SELECTIVELY, not just when the whole window is empty. The main test checks all-in and all-out;
// here an in-window task and an out-of-window task coexist in the same org, so the exclusion has to be
// per-task. It also pins that continued_after_acceptance (go_gate=false) still sees the out-of-window
// task's acceptance on full history - the contrast with acceptance_rate, which drops it.
func TestPilotMetricsSQLWindowSelectivelyExcludesOutOfWindowTasks(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	const (
		taskA = "11111111-1111-4111-8111-111111111111" // stays in window (created now)
		taskB = "11111111-1111-4111-8111-222222222222" // pushed before the window
	)

	// taskA: a succeeded run, awaiting acceptance, never accepted - in window.
	appendEvent(t, conn, "org_a", taskA, "run.succeeded", `{"run_id":"21111111-1111-4111-8111-111111111111"}`)
	appendEvent(t, conn, "org_a", taskA, "task.awaiting_acceptance", `{}`)
	// taskB: a failed run, awaiting, accepted by version - all its events exist, but the task row is
	// then pushed out of the window, so the windowed gates must drop it while a full-history metric
	// keeps counting it.
	appendEvent(t, conn, "org_a", taskB, "run.failed", `{"terminal_reason":"model_error"}`)
	appendEvent(t, conn, "org_a", taskB, "task.awaiting_acceptance", `{}`)
	appendEvent(t, conn, "org_a", taskB, "task.completed", `{"basis":"version","version_no":1}`)

	useAppOrg(t, conn, "org_a")
	if _, err := conn.Exec(ctx,
		`UPDATE work.task SET created_at = now() - interval '30 days' WHERE id = $1`, taskB); err != nil {
		t.Fatalf("pushing taskB out of window: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('work.org_id', 'org_a', false)`); err != nil {
		t.Fatal(err)
	}
	enabledAt := time.Now().UTC().Add(-time.Hour)
	if _, err := conn.Exec(ctx, `SELECT set_config('work.pilot_enabled_at', $1, false)`,
		enabledAt.Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('work.activation_threshold', '3', false)`); err != nil {
		t.Fatal(err)
	}

	rows, err := conn.Query(ctx, readMetricsSQL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string][3]*float64{}
	for rows.Next() {
		var metric string
		var n, d, v *float64
		if err := rows.Scan(&metric, &n, &d, &v); err != nil {
			t.Fatal(err)
		}
		got[metric] = [3]*float64{n, d, v}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	den := func(m string) float64 {
		t.Helper()
		row, ok := got[m]
		if !ok || row[1] == nil {
			t.Fatalf("%s has no denominator (got %v)", m, keys(got))
		}
		return *row[1]
	}
	val := func(m string) *float64 {
		t.Helper()
		row, ok := got[m]
		if !ok {
			t.Fatalf("%s missing from result (got %v)", m, keys(got))
		}
		return row[2]
	}

	// Only the in-window taskA succeeded survives -> 1/1 = 1.0; full history would be 0.5.
	if v := val("technical_success_rate"); v == nil || *v != 1 {
		t.Fatalf("technical_success_rate = %v, want 1.0: the out-of-window taskB failed run must drop "+
			"out of the gate (full history would give 0.5)", v)
	}
	// taskB's acceptance is out of window (numerator 0) but taskA still awaits (denominator 1) -> 0.0;
	// full history would be 0.5 (accepted 1 / awaiting 2).
	if v := val("acceptance_rate"); v == nil || *v != 0 {
		t.Fatalf("acceptance_rate = %v, want 0.0: out-of-window taskB is excluded from the numerator "+
			"while in-window taskA holds the denominator", v)
	}
	if d := den("acceptance_rate"); d != 1 {
		t.Fatalf("acceptance_rate denominator = %v, want 1 (only in-window taskA awaits)", d)
	}
	// The full-history metric still counts taskB's acceptance, proving the gate/window separation
	// is per-metric, not a blanket event filter.
	if d := den("continued_after_acceptance"); d != 1 {
		t.Fatalf("continued_after_acceptance denominator = %v, want 1: it counts the full-history "+
			"accepted set, so it must still see out-of-window taskB unlike acceptance_rate", d)
	}
}

func keys(m map[string][3]*float64) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func deref(v *float64) any {
	if v == nil {
		return "NULL"
	}
	return *v
}
