package migrate

// 0033 (#86) coverage pin.
//
// What actually went wrong with 0032 was not a wrong predicate - it was a short list. Four tables
// were scanned because those were the four names I recognised, and the first production run called
// 163 referenced objects orphans (178 reported, 15 real). So the failure mode worth defending
// against is "a branch disappears from the body", and a guard that only exercises the branches that
// already existed cannot see that: seeding intent/dispatch/operation rows needs the full
// FK-and-guard dance (dispatch_delivery is protected by a binding trigger, runtime_execution is
// registered through a function), and faking it with a hand-inserted row would test my fixture,
// not the shipped channel.
//
// This file therefore pins the body against the live catalog by (table, column) pair, with a count
// floor, and re-checks the two invariants that made the definer path legitimate at all. The
// row-level half - an object referenced only by intent_ref must disappear from the orphan set - is
// recorded as unfinished in the plan rather than approximated here.

import (
	"context"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/testpg"
)

func TestListContentRefsCoversEveryContentURIColumn(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	dbName, admin := newGateDB(t)
	defer func() { _ = admin.Close(context.Background()) }()

	var body string
	if err := admin.QueryRow(ctx, `
		SELECT p.prosrc
		FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'work' AND p.proname = 'list_content_refs'`).Scan(&body); err != nil {
		t.Fatal(err)
	}

	want := [][2]string{
		{"audit_export", "content_ref"},
		{"input_object", "content_ref"},
		{"artifact_version", "content_ref"},
		{"content_reference", "content_ref"},
		{"runtime_execution", "intent_ref"},
		{"dispatch_delivery", "receipt_ref"},
		{"operation", "receipt_ref"},
	}
	for _, pair := range want {
		table, column := pair[0], pair[1]
		// Anchor on the branch itself: a FROM of that table whose org-scoped predicate names that
		// column. Matching the column name alone would also be satisfied by a comment.
		re := regexp.MustCompile(`(?s)FROM work\.` + table + `\s+\w+\s+WHERE \w+\.org_id = p_org_id AND \w+\.` +
			column + ` (IS NOT NULL|LIKE)`)
		if !re.MatchString(body) {
			t.Fatalf("list_content_refs lost the %s.%s branch; that column stores content URIs in production"+
				" and dropping it turns referenced objects into reported orphans", table, column)
		}
	}

	// Floor, so a gutted body cannot pass by having nothing left to mismatch.
	if n := strings.Count(body, "UNION ALL"); n < len(want)-1 {
		t.Fatalf("body carries %d UNION ALL branches, want at least %d", n, len(want)-1)
	}

	// The columns that carry NO content URIs must stay out, and their exclusion has to be re-derived
	// rather than trusted: this asserts against the live catalog, not against 2026-11-06 row counts.
	for _, absent := range []string{"local_ref", "payload_ref", "result_ref", "checkpoint_ref", "input_checkpoint_ref", "ref_id"} {
		if regexp.MustCompile(`(?s)FROM work\.\w+\s+\w+\s+WHERE \w+\.org_id = p_org_id AND \w+\.` + absent).MatchString(body) {
			t.Fatalf("body now scans %s; re-read which columns actually store content://work/ before keeping it", absent)
		}
	}

	var definer bool
	var config []string
	if err := admin.QueryRow(ctx, `
		SELECT p.prosecdef, p.proconfig FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname='work' AND p.proname='list_content_refs'`).Scan(&definer, &config); err != nil {
		t.Fatal(err)
	}
	if !definer {
		t.Fatal("list_content_refs is no longer SECURITY DEFINER - work_worker cannot read the audited tables")
	}
	joined := strings.Join(config, ",")
	if !strings.Contains(joined, "search_path=work") {
		t.Fatalf("search_path unpinned: %q", joined)
	}

	worker := connect(t, testpg.WorkerURL(dbName))
	for role, wantExec := range map[string]bool{"work_worker": true, "work_api": false, "public": false} {
		var can bool
		if err := worker.QueryRow(ctx,
			`SELECT has_function_privilege($1, 'work.list_content_refs(text)', 'execute')`, role).Scan(&can); err != nil {
			t.Fatal(err)
		}
		if can != wantExec {
			t.Fatalf("has_function_privilege(%s) = %v, want %v", role, can, wantExec)
		}
	}
}
