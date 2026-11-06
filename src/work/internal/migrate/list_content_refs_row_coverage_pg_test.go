package migrate

// #86, the half 0033 left open: row-level coverage for the three branches it added.
//
// list_content_refs_coverage_test.go pins each (table, column) branch by matching the shipped
// function body, which is what a deleted branch needs - but it cannot answer the question that
// actually matters to the orphan reading: does a content object referenced ONLY from
// runtime_execution.intent_ref (or dispatch_delivery.receipt_ref, or operation.receipt_ref) really
// come back from the function, with its id split correctly? 163 objects were called orphans in
// production because the answer was no, and no amount of body-matching proves the positive case.
//
// So every row here is created through the domain commands a worker uses - reserve_quota,
// claim_dispatch, register_runtime_execution, claim, consume_dispatch_delivery,
// attach_dispatch_receipt, finish_operation - not by hand-inserting into the three tables. A fixture
// built with raw INSERTs would test my ability to satisfy the guards, and 0009's dispatch gate is
// guarded precisely so that nobody can put a receipt on a gate that never consumed anything.
//
// Two assertions per branch, deliberately paired:
//   - the direct predicate (FROM <table> WHERE org_id = ... AND <column> LIKE 'content://work/%')
//     finds >= 1 row, which proves the fixture created a row of the shape the branch selects;
//   - list_content_refs returns that object id, exactly, with no prefix and no ?v suffix.
//
// The first stays green if a branch is dropped, so it is the second that carries the failure - and
// if the fixture ever stops producing the row, the first reds before the second can pass by
// accident. A never-referenced id is asserted absent, and a second tenant's ids are asserted absent
// from the first reading, so neither an over-broad UNION nor a missing org filter reads as OK.

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	migrations "github.com/we-meet/work/migrations"
)

func contentURI(org, object string) string {
	return fmt.Sprintf("content://work/%s/%s?v1", org, object)
}

// prepareExecuteWithIntent is prepareExecuteFragment with one difference: the intent_ref is the
// caller's, because that column is the subject of two of the three branches under test.
func prepareExecuteWithIntent(t *testing.T, worker *pgx.Conn, run *gateRun, intentRef string) {
	t.Helper()
	ctx := testContext(t)
	var reservation string
	if err := worker.QueryRow(ctx,
		`SELECT work.reserve_quota($1, 'default', to_char(now(), 'YYYY-MM'), $2, 1000)::text`,
		run.org, run.opID,
	).Scan(&reservation); err != nil {
		t.Fatalf("reserve_quota: %v", err)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_dispatch($1, $2, 'consumer-1', 1)::text`,
		run.opID, run.org,
	).Scan(&run.attempt); err != nil {
		t.Fatalf("claim_dispatch: %v", err)
	}
	var state string
	if err := worker.QueryRow(ctx, `
		SELECT work.register_runtime_execution(
			$1, $2, $3, 'execute', 1, 'pi-1', now() + interval '10 minutes',
			$4, $5, $6, $7, repeat('c', 64), $8, $9)`,
		run.org, run.execExec, run.runID, run.headRef, run.headHash,
		intentRef, docHash(t, "2"), run.opID, run.attempt,
	).Scan(&state); err != nil {
		t.Fatalf("register_runtime_execution with intent_ref %q: %v", intentRef, err)
	}
	if state != "registered" {
		t.Fatalf("execute register state = %q, want registered", state)
	}
	if err := worker.QueryRow(ctx,
		`SELECT work.claim_runtime_execution($1, $2, $3)`,
		run.org, run.execExec, run.holder,
	).Scan(&state); err != nil {
		t.Fatalf("claim execute fragment: %v", err)
	}
	if state != "claimed" {
		t.Fatalf("execute claim state = %q, want claimed", state)
	}
}

// plantedRefs are the object ids one Run now references, each from a different column.
type plantedRefs struct {
	intent    string
	delivery  string
	operation string
}

// seedReferencedRun drives one Run far enough to put a content URI into each of the three columns
// 0033 added. It returns the ids it planted; the caller keeps its own never-referenced id separate.
func seedReferencedRun(t *testing.T, admin *pgx.Conn, dbName, org string) plantedRefs {
	t.Helper()
	ctx := testContext(t)
	run := seedRun(t, admin, org)
	worker := workerConn(t, dbName, org)

	planted := plantedRefs{intent: newUUID(t), delivery: newUUID(t), operation: newUUID(t)}
	commitFirstHead(t, worker, run)
	prepareExecuteWithIntent(t, worker, run, contentURI(org, planted.intent))

	slot := newUUID(t)
	if _, err := consume(ctx, worker, run, "inv-"+newUUID(t), slot); err != nil {
		t.Fatalf("consume_dispatch_delivery: %v", err)
	}
	out, err := attachReceipt(ctx, worker, run, slot,
		contentURI(org, planted.delivery), docHash(t, "a"), "success")
	if err != nil {
		t.Fatalf("attach_dispatch_receipt: %v", err)
	}
	if out["gate_state"] != "receipt_recorded" {
		t.Fatalf("gate_state after attaching a receipt = %v, want receipt_recorded", out["gate_state"])
	}
	if _, err := worker.Exec(ctx,
		`SELECT work.finish_operation($1, $2, 'succeeded', 'prov-1', $3)`,
		org, run.opID, contentURI(org, planted.operation),
	); err != nil {
		t.Fatalf("finish_operation with receipt_ref: %v", err)
	}
	return planted
}

func TestListContentRefsReturnsRowsCreatedByTheirOnlyReference(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	dbName, admin := newGateDB(t)

	org := "org_row_refs"
	stray := newUUID(t)
	planted := seedReferencedRun(t, admin, dbName, org)

	listFor := func(readOrg string) map[string]bool {
		t.Helper()
		session := workerConn(t, dbName, readOrg)
		rows, err := session.Query(ctx, `SELECT work.list_content_refs($1)`, readOrg)
		if err != nil {
			t.Fatalf("list_content_refs(%s): %v", readOrg, err)
		}
		defer rows.Close()
		seen := map[string]bool{}
		for rows.Next() {
			var ref string
			if err := rows.Scan(&ref); err != nil {
				t.Fatal(err)
			}
			seen[ref] = true
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return seen
	}

	branches := []struct {
		table  string
		column string
		object string
	}{
		{"runtime_execution", "intent_ref", planted.intent},
		{"dispatch_delivery", "receipt_ref", planted.delivery},
		{"operation", "receipt_ref", planted.operation},
	}

	// First half of each pair: the fixture really wrote a row of the shape the branch selects.
	for _, branch := range branches {
		var rows int
		if err := admin.QueryRow(ctx, fmt.Sprintf(
			"SELECT count(*) FROM work.%s x WHERE x.org_id = $1 AND x.%s LIKE 'content://work/%%'",
			branch.table, branch.column), org).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		if rows < 1 {
			t.Fatalf("fixture produced no %s.%s row carrying a content URI, so the branch under test has "+
				"nothing to find and the next assertion would prove nothing", branch.table, branch.column)
		}
	}

	seen := listFor(org)
	if len(seen) < len(branches) {
		t.Fatalf("list_content_refs(%s) returned %d ids (%v), want at least %d",
			org, len(seen), sortedKeys(seen), len(branches))
	}
	for raw := range seen {
		if strings.HasPrefix(raw, "content://") || strings.Contains(raw, "?") {
			t.Fatalf("list_content_refs returned %q instead of a bare object id; the scan compares ids with "+
				"on-disk names, so the prefix and the ?v suffix have to be stripped", raw)
		}
	}
	// Second half of each pair: the shipped function reads that column.
	for _, branch := range branches {
		if !seen[branch.object] {
			t.Fatalf("%s.%s references object %s, but list_content_refs did not return it (it returned %v); "+
				"that is exactly the shape that made 163 referenced objects look like orphans",
				branch.table, branch.column, branch.object, sortedKeys(seen))
		}
	}
	if seen[stray] {
		t.Fatalf("the never-referenced object %s came back; nothing in the fixture writes it, so a branch "+
			"matching too much is being read as a reference", stray)
	}

	// Per-branch org isolation: the same three columns filled in a second tenant must stay out of the
	// first reading and must appear in its own. A single-org set assertion cannot see a missing
	// `WHERE x.org_id = p_org_id` on a UNION branch.
	other := "org_row_refs_b"
	strayB := newUUID(t)
	plantedB := seedReferencedRun(t, admin, dbName, other)
	seenA := listFor(org)
	seenB := listFor(other)
	for _, pair := range []struct {
		reading map[string]bool
		own     string
		here    plantedRefs
		foreign plantedRefs
		other   string
		stray   string
	}{
		{seenA, org, planted, plantedB, other, stray},
		{seenB, other, plantedB, planted, org, strayB},
	} {
		for _, object := range []string{pair.here.intent, pair.here.delivery, pair.here.operation} {
			if !pair.reading[object] {
				t.Fatalf("%s did not report its own object %s (%v)", pair.own, object, sortedKeys(pair.reading))
			}
		}
		for _, object := range []string{pair.foreign.intent, pair.foreign.delivery, pair.foreign.operation} {
			if pair.reading[object] {
				t.Fatalf("%s leaked %s's object %s", pair.own, pair.other, object)
			}
		}
		if pair.reading[pair.stray] {
			t.Fatalf("%s reported the never-referenced object %s", pair.own, pair.stray)
		}
	}
}

func sortedKeys(seen map[string]bool) []string {
	out := make([]string, 0, len(seen))
	for key := range seen {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

// TestRowCoverageAssertionsFailAgainstThe0032Body is the teeth of the test above, and the mutation
// is historical rather than invented: 0032 is the published body that produced the wrong production
// reading, so swapping it in must remove all three ids and swapping 0033 back must restore them.
// Without this, "the function returns my objects" could still be true of a function that returns
// everything, and the failure mode #86 is about would be invisible.
func TestRowCoverageAssertionsFailAgainstThe0032Body(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	dbName, admin := newGateDB(t)
	org := "org_row_refs_0032"
	planted := seedReferencedRun(t, admin, dbName, org)
	objects := []string{planted.intent, planted.delivery, planted.operation}

	listFor := func(readOrg string) []string {
		t.Helper()
		session := workerConn(t, dbName, readOrg)
		rows, err := session.Query(ctx, `SELECT work.list_content_refs($1)`, readOrg)
		if err != nil {
			t.Fatalf("list_content_refs(%s): %v", readOrg, err)
		}
		defer rows.Close()
		out := []string{}
		for rows.Next() {
			var ref string
			if err := rows.Scan(&ref); err != nil {
				t.Fatal(err)
			}
			out = append(out, ref)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		sort.Strings(out)
		return out
	}
	includes := func(haystack []string, needle string) bool {
		for _, item := range haystack {
			if item == needle {
				return true
			}
		}
		return false
	}

	apply := func(file, marker string) {
		t.Helper()
		raw, err := migrations.FS.ReadFile(file)
		if err != nil {
			t.Fatalf("read embedded %s: %v", file, err)
		}
		text := string(raw)
		statement := text
		if marker != "" {
			statement = strings.Replace(text, marker, strings.Replace(marker, "CREATE ", "CREATE OR REPLACE ", 1), 1)
			if statement == text {
				t.Fatalf("%s no longer declares the function with %q", file, marker)
			}
		}
		if _, err := admin.Exec(ctx, "SET ROLE work_owner;"+statement+" RESET ROLE"); err != nil {
			t.Fatalf("apply %s: %v", file, err)
		}
	}

	missing := []string{}
	for _, object := range objects {
		if !includes(listFor(org), object) {
			missing = append(missing, object)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("tip body no longer returns %v, so the comparison below cannot show what 0032 lost", missing)
	}

	apply("increments/0032_content_ref_reads_for_orphan_report.sql",
		"CREATE FUNCTION work.list_content_refs(p_org_id text)")
	lost := []string{}
	before := len(listFor(org))
	for _, object := range objects {
		if !includes(listFor(org), object) {
			lost = append(lost, object)
		}
	}
	if len(lost) != len(objects) {
		t.Fatalf("against the 0032 body only %d of %d branch objects disappear (function returned %d ids); "+
			"the row-level assertions above are not the ones deciding coverage, or 0033 changed shape",
			len(objects)-len(lost), len(objects), before)
	}

	apply("increments/0033_list_content_refs_full_ref_coverage.sql", "")
	returned := []string{}
	for _, object := range objects {
		if includes(listFor(org), object) {
			returned = append(returned, object)
		}
	}
	if len(returned) != len(objects) {
		t.Fatalf("after restoring the 0033 body the function returns %v of %v objects",
			returned, objects)
	}
}
