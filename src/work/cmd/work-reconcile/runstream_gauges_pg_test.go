package main

// The release ships runstream-gauges.sql as an operator-facing alert source: parked_runs>0
// makes the wrapper exit 2 and the health mail fires. Nothing tested that file, so #60=B's
// exemption for quota-waiting Runs was an unverified edit to a real alerting path. These
// tests execute the shipped statement text (not a copy of it) the way the wrapper does -
// as work_worker, after set_config('app.org_id', ...), so RLS is what scopes the reading.

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/testpg"
)

const gaugeSQLRelPath = "../../scripts/runstream-gauges.sql"

// gaugeStatement returns the SELECT that emits the named reading, verbatim from the shipped
// file. Stopping at the first line that ends the statement keeps the test honest about which
// text it exercised: if the file's shape changes, extraction fails loudly rather than
// silently reading a different query.
func gaugeStatement(t *testing.T, name string) string {
	t.Helper()
	body, err := os.ReadFile(gaugeSQLRelPath)
	if err != nil {
		t.Fatalf("read shipped gauge sql: %v", err)
	}
	marker := fmt.Sprintf("SELECT 'gauge=%s value='", name)
	index := strings.Index(string(body), marker)
	if index < 0 {
		t.Fatalf("no reading named %q in %s", name, gaugeSQLRelPath)
	}
	rest := string(body)[index:]
	end := strings.Index(rest, ";\n")
	if end < 0 {
		t.Fatalf("reading %q has no terminating semicolon", name)
	}
	sql := rest[:end+1]
	if !strings.HasPrefix(sql, marker) {
		t.Fatalf("extracted text does not start at the reading marker")
	}
	return sql
}

func runGaugeReading(t *testing.T, org, name string, staleMinutes int) int64 {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, testpg.WorkerURL(pgDBName))
	if err != nil {
		t.Fatalf("connect as work_worker: %v", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "SELECT set_config('app.org_id', $1, false)", org); err != nil {
		t.Fatal(err)
	}
	sql := strings.NewReplacer(`:'org'`, quoteLiteral(org), `:stale_minutes`,
		fmt.Sprintf("%d", staleMinutes)).Replace(gaugeStatement(t, name))
	// The reading leaves the database as one text line, "gauge=<name> value=<int>", which is
	// exactly what the wrapper parses - so assert on that shape instead of the number alone.
	var line string
	if err := conn.QueryRow(ctx, sql).Scan(&line); err != nil {
		t.Fatalf("reading %s: %v", name, err)
	}
	prefix := fmt.Sprintf("gauge=%s value=", name)
	if !strings.HasPrefix(line, prefix) {
		t.Fatalf("reading %q emitted %q, want the wrapper's %q format", name, line, prefix)
	}
	value, err := strconv.ParseInt(strings.TrimPrefix(line, prefix), 10, 64)
	if err != nil {
		t.Fatalf("reading %q emitted %q: %v", name, line, err)
	}
	return value
}

func quoteLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// quota-waiting Runs are deliberately parked for up to 24h, so they must not raise
// parked_runs; every other open-and-stale Run still must. The row whose wait_reason is NULL
// is the reason the predicate uses COALESCE: with a bare equality, `NOT (waiting AND
// wait_reason='quota')` evaluates to NULL for that row and PostgreSQL drops it from the
// reading - a silent under-count in the very signal that exists to catch parked work.
func TestGaugeParkedRunsExcludesQuotaWaitOnly(t *testing.T) {
	if pgDBName == "" {
		t.Skip("WORK_TEST_PG_URL not set")
	}
	const org = "org_gauge"
	runs := []seedRun{
		{suffix: "d1", org: org, state: "waiting"},
		{suffix: "d2", org: org, state: "waiting"},
		{suffix: "d3", org: org, state: "waiting"},
		{suffix: "d4", org: org, state: "active"},
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, testpg.AdminURLFor(pgDBName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	if err := testpg.ExecRaw(ctx, admin, seedSQL(runs)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	reasonFor := map[string]string{
		uuidFor('r', "d1"): "quota",
		uuidFor('r', "d2"): "reconcile",
		uuidFor('r', "d3"): "", // left NULL on purpose
		uuidFor('r', "d4"): "",
	}
	for run, reason := range reasonFor {
		var predicate string
		if reason == "" {
			predicate = "wait_reason = NULL"
		} else {
			predicate = fmt.Sprintf("wait_reason = %s", quoteLiteral(reason))
		}
		if _, err := admin.Exec(ctx,
			fmt.Sprintf("UPDATE work.run SET %s, updated_at = now() - interval '30 minutes' "+
				"WHERE id = '%s'::uuid", predicate, run)); err != nil {
			t.Fatal(err)
		}
	}
	// d4 is put back to a fresh timestamp so the reading is proven to exclude it by the
	// staleness term, not by the quota exemption - otherwise a single change could satisfy
	// both conditions and the test would not say which one did the work.
	if _, err := admin.Exec(ctx,
		"UPDATE work.run SET updated_at = now() WHERE id = $1::uuid", uuidFor('r', "d4")); err != nil {
		t.Fatal(err)
	}

	if got := runGaugeReading(t, org, "parked_runs", 5); got != 2 {
		t.Fatalf("parked_runs = %d, want 2: quota-waiting excluded, reconcile-waiting and the"+
			" NULL-wait_reason waiting Run counted, the fresh active Run excluded by staleness", got)
	}
	if got := runGaugeReading(t, org, "open_runs", 5); got != 4 {
		t.Fatalf("open_runs = %d, want 4: the quota-waiting Run stays visible in the context reading", got)
	}
}

// The wrapper refuses an incomplete scan, so the reading names in its REQUIRED list must all
// still be produced by the shipped SQL - a renamed or deleted reading would otherwise make the
// scan "succeed" while reporting nothing.
func TestGaugeRequiredReadingsAllResolve(t *testing.T) {
	if pgDBName == "" {
		t.Skip("WORK_TEST_PG_URL not set")
	}
	body, err := os.ReadFile(gaugeSQLRelPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"parked_runs", "held_on_terminal", "unknown_operations",
		"suspended_orgs", "open_runs", "held_tokens"} {
		if !strings.Contains(string(body), fmt.Sprintf("SELECT 'gauge=%s value='", name)) {
			t.Errorf("reading %q is missing from the shipped SQL", name)
		}
		if strings.Contains(name, "parked") || strings.Contains(name, "open") {
			continue // covered by the value-level test above
		}
		gaugeStatement(t, name) // must extract cleanly
	}
}
