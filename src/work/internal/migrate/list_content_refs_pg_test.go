package migrate

import (
	"fmt"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/testpg"
	"github.com/we-meet/work/migrations"
)

// refID builds the id part of a content_ref the way the store does; 0032 returns that id, not the
// whole reference, so the assertions compare ids.
func refID(org string, tag string) string {
	return fmt.Sprintf("%s-%s", org, tag)
}

func contentRef(org string, tag string) string {
	return fmt.Sprintf("content://work/%s/%s?v1", org, refID(org, tag))
}

// TestListContentRefsStaysInsideItsOwnOrg covers increment 0032 (#80 second half). The function is
// SECURITY DEFINER, so the tenant boundary is not RLS any more - it is the per-branch
// `WHERE x.org_id = p_org_id` inside the body. A later CREATE OR REPLACE that drops one of those
// four predicates would silently hand one org another org's object ids, and nothing else in the
// suite would notice: the retention scanner only counts, and the report is read-only.
//
// The positive control is part of the test. It re-applies the shipped body with exactly one org
// predicate removed and requires that version to leak, which is what proves this fixture can tell
// the two apart rather than passing because nothing is seeded.
func TestListContentRefsStaysInsideItsOwnOrg(t *testing.T) {
	ctx := testContext(t)
	dbName, admin := newGateDB(t)

	const orgA, orgB = "org_refs_a", "org_refs_b"
	subjectA, subjectB := newUUID(t), newUUID(t)
	script := fmt.Sprintf(`
		SET app.org_id = %[1]s;
		INSERT INTO work.org (id, status, home_region) VALUES (%[1]s, 'active', 'cn-north')
		  ON CONFLICT (id) DO NOTHING;
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES (%[1]s, %[3]s, 'active', 'owner', true)
		  ON CONFLICT (org_id, subject_id) DO NOTHING;
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%[5]s', %[1]s, %[3]s, '%[7]s', repeat('a', 64), 12);
		INSERT INTO work.audit_export
		  (id, org_id, requested_by, client_request_id, request_hash, range_from, range_to,
		   format, status, content_ref, content_hash, bytes)
		VALUES ('%[6]s', %[1]s, %[3]s, 'refs-a', 'sha256:refs-a',
		        now() - interval '2 day', now() - interval '1 day', 'csv', 'expired',
		        '%[8]s', repeat('b', 64), 34);

		SET app.org_id = %[2]s;
		INSERT INTO work.org (id, status, home_region) VALUES (%[2]s, 'active', 'cn-north')
		  ON CONFLICT (id) DO NOTHING;
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES (%[2]s, %[4]s, 'active', 'owner', true)
		  ON CONFLICT (org_id, subject_id) DO NOTHING;
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('%[9]s', %[2]s, %[4]s, '%[10]s', repeat('c', 64), 12);
		INSERT INTO work.audit_export
		  (id, org_id, requested_by, client_request_id, request_hash, range_from, range_to,
		   format, status, content_ref, content_hash, bytes)
		VALUES ('%[11]s', %[2]s, %[4]s, 'refs-b', 'sha256:refs-b',
		        now() - interval '2 day', now() - interval '1 day', 'csv', 'expired',
		        '%[12]s', repeat('d', 64), 34);
	`, quoteLiteral(orgA), quoteLiteral(orgB), quoteLiteral(subjectA), quoteLiteral(subjectB),
		newUUID(t), newUUID(t), contentRef(orgA, "in-a"), contentRef(orgA, "ex-a"),
		newUUID(t), contentRef(orgB, "in-b"), newUUID(t), contentRef(orgB, "ex-b"))
	if err := testpg.ExecRaw(ctx, admin, script); err != nil {
		t.Fatalf("seed refs: %v", err)
	}
	// Lower bound before any assertion about the function: an empty fixture would make every
	// containment check below pass vacuously.
	for _, table := range []string{"work.input_object", "work.audit_export"} {
		var seeded int64
		if err := admin.QueryRow(ctx, fmt.Sprintf(
			`SELECT count(*) FROM %s WHERE org_id IN ($1, $2)`, table),
			orgA, orgB).Scan(&seeded); err != nil {
			t.Fatal(err)
		}
		if seeded != 2 {
			t.Fatalf("%s seeded %d rows, want 2", table, seeded)
		}
	}

	worker := workerConn(t, dbName, "")
	listFor := func(org string) string {
		t.Helper()
		// SECURITY DEFINER changes the role, not the tenant context: those tables are FORCE RLS and
		// their policies read app.org_id, so an unset GUC means "no rows this session may see" -
		// the same trap #53 recorded. run-retention-scan.sh sets it per org; so does this.
		if _, err := worker.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
			t.Fatal(err)
		}
		rows, err := worker.Query(ctx, `SELECT work.list_content_refs($1)`, org)
		if err != nil {
			t.Fatalf("list_content_refs(%s): %v", org, err)
		}
		defer rows.Close()
		var seen []string
		for rows.Next() {
			var ref string
			if err := rows.Scan(&ref); err != nil {
				t.Fatal(err)
			}
			seen = append(seen, ref)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return strings.Join(seen, ",")
	}

	// org A sees both of its own branches and none of B's.
	got := listFor(orgA)
	for _, want := range []string{refID(orgA, "in-a"), refID(orgA, "ex-a")} {
		if !strings.Contains(got, want) {
			t.Fatalf("list_content_refs(%s) = %q, missing %q", orgA, got, want)
		}
	}
	for _, leak := range []string{refID(orgB, "in-b"), refID(orgB, "ex-b")} {
		if strings.Contains(got, leak) {
			t.Fatalf("list_content_refs(%s) = %q leaked another org's id %q", orgA, got, leak)
		}
	}
	// Symmetry: B sees its own, not A's. A one-sided fixture would also pass if the query simply
	// returned nothing for both orgs, which is why the positive contains above are required first.
	gotB := listFor(orgB)
	if !strings.Contains(gotB, refID(orgB, "in-b")) || strings.Contains(gotB, refID(orgA, "in-a")) {
		t.Fatalf("list_content_refs(%s) = %q, want B's own input id and not A's", orgB, gotB)
	}

	// The grant shape is part of the contract: only the worker may call it.
	for role, want := range map[string]bool{"work_worker": true, "work_api": false, "public": false} {
		var can bool
		if err := admin.QueryRow(ctx,
			`SELECT has_function_privilege($1, 'work.list_content_refs(text)', 'execute')`,
			role).Scan(&can); err != nil {
			t.Fatal(err)
		}
		if can != want {
			t.Fatalf("has_function_privilege(%s) = %v, want %v", role, can, want)
		}
	}

	// The argument alone cannot reach another tenant: GUC stays on A while the argument names B.
	if _, err := worker.Exec(ctx, "SET app.org_id = "+quoteLiteral(orgA)); err != nil {
		t.Fatal(err)
	}
	var cross []string
	rows, err := worker.Query(ctx, `SELECT work.list_content_refs($1)`, orgB)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var ref string
		if err := rows.Scan(&ref); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		cross = append(cross, ref)
	}
	rows.Close()
	if len(cross) != 0 {
		t.Fatalf("app.org_id=%s with argument %s returned %v, want nothing", orgA, orgB, cross)
	}

	// What this function's own org predicate is and is not. Both audited tables are
	// relrowsecurity AND relforcerowsecurity, and FORCE RLS binds the table owner too - so the
	// SECURITY DEFINER hop does not step outside the tenant fence, and a body with one org
	// predicate deleted still returns only the session's org. Verified rather than assumed: the
	// shadow definition below is exactly that deletion, and it must NOT leak. The predicate is
	// therefore defence in depth (it also makes the branch honest if a table ever stops forcing
	// RLS), while app.org_id is the control that actually holds today.
	shipped, err := migrations.FS.ReadFile("increments/0032_content_ref_reads_for_orphan_report.sql")
	if err != nil {
		t.Fatalf("read embedded 0032: %v", err)
	}
	orReplace := strings.Replace(string(shipped),
		"CREATE FUNCTION work.list_content_refs(p_org_id text)",
		"CREATE OR REPLACE FUNCTION work.list_content_refs(p_org_id text)", 1)
	if orReplace == string(shipped) {
		t.Fatal("embedded 0032 no longer declares the function with the expected CREATE form")
	}
	shadow := strings.Replace(orReplace,
		"WHERE e.org_id = p_org_id AND e.content_ref IS NOT NULL",
		"WHERE e.content_ref IS NOT NULL", 1)
	if shadow == orReplace {
		t.Fatal("0032 lost the audit_export org predicate this test documents")
	}
	if _, err := admin.Exec(ctx, "SET ROLE work_owner;"+shadow+" RESET ROLE"); err != nil {
		t.Fatalf("apply shadow 0032: %v", err)
	}
	if _, err := worker.Exec(ctx, "SET app.org_id = "+quoteLiteral(orgA)); err != nil {
		t.Fatal(err)
	}
	rows, err = worker.Query(ctx, `SELECT work.list_content_refs($1)`, orgA)
	if err != nil {
		t.Fatal(err)
	}
	var shadowed []string
	for rows.Next() {
		var ref string
		if err := rows.Scan(&ref); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		shadowed = append(shadowed, ref)
	}
	rows.Close()
	for _, leak := range []string{refID(orgB, "in-b"), refID(orgB, "ex-b")} {
		if strings.Contains(strings.Join(shadowed, ","), leak) {
			t.Fatalf("FORCE RLS did not hold with the predicate removed: %v - update this test's conclusion", shadowed)
		}
	}
	if !strings.Contains(strings.Join(shadowed, ","), refID(orgA, "ex-a")) {
		t.Fatalf("shadow definition stopped returning the session's own rows: %v", shadowed)
	}

	// Restore the shipped definition from the embedded asset so this database matches the chain.
	if _, err := admin.Exec(ctx, "SET ROLE work_owner;"+orReplace+" RESET ROLE"); err != nil {
		t.Fatalf("restore shipped 0032: %v", err)
	}
	if got := listFor(orgA); !strings.Contains(got, refID(orgA, "ex-a")) {
		t.Fatalf("restored function no longer returns its own org: %q", got)
	}
}
