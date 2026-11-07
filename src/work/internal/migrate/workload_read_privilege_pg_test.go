package migrate

// #87 guard, live half.
//
// The static rule in function_hardening_test.go says a rewrite must restate the baseline hardening.
// This one says what that hardening is FOR: a function a workload role may execute must be able to
// read the tables its body reads. Either the function is SECURITY DEFINER, or the executing role
// holds SELECT. When 0031 dropped the attribute, work.list_pending_audit_exports fell into the third
// box - executable by work_worker, invoker rights, no SELECT on work.audit_export - and production
// paid for it with `permission denied for table audit_export (SQLSTATE 42501)` on every work-export
// poll from 18:44:12 on 2026-11-06 - 1,713 of them by 21:06:50 - until 0034 is applied.
//
// The predicate is the same one run against the pilot database on 2026-11-06, which returned exactly
// one row there, so this test reads the chain-built database against a known answer rather than
// against a list I could have got wrong twice.

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/we-meet/work/internal/testpg"
)

// workloadReadMatrix is one row per (function, executing workload role, table the body reads).
const workloadReadMatrix = `
WITH tbl AS (
  SELECT c.oid, c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'work' AND c.relkind IN ('r', 'v', 'm', 'p')
),
fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proacl, p.prosrc,
         coalesce(array_to_string(p.proconfig, ','), '') AS config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'work'
),
execs AS (
  SELECT fn.oid AS fn, r.rolname AS role
  FROM fn CROSS JOIN LATERAL aclexplode(fn.proacl) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE a.privilege_type = 'EXECUTE'
    AND r.rolname LIKE 'work%'
    AND r.rolname <> 'work_owner'
  GROUP BY 1, 2
),
refs AS (
  SELECT fn.oid AS fn, t.relname AS tbl
  FROM fn
  CROSS JOIN LATERAL regexp_matches(fn.prosrc,
      '(?:FROM|JOIN|UPDATE|INSERT INTO|DELETE FROM)[[:space:]]+work\.([a-z_][a-z0-9_]*)', 'g') m
  JOIN tbl t ON t.relname = m[1]
  GROUP BY 1, 2
)
SELECT fn.proname, e.role, r.tbl, fn.prosecdef, fn.config,
       has_table_privilege(e.role, 'work.' || r.tbl, 'SELECT') AS readable
FROM fn
JOIN execs e ON e.fn = fn.oid
JOIN refs r ON r.fn = fn.oid
ORDER BY 1, 2, 3`

type readMatrixRow struct {
	function string
	role     string
	table    string
	definer  bool
	config   string
	readable bool
}

func readWorkloadMatrix(t *testing.T, ctx context.Context, admin *pgx.Conn) []readMatrixRow {
	t.Helper()
	rows, err := admin.Query(ctx, workloadReadMatrix)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []readMatrixRow{}
	for rows.Next() {
		var item readMatrixRow
		if err := rows.Scan(&item.function, &item.role, &item.table, &item.definer, &item.config, &item.readable); err != nil {
			t.Fatal(err)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func unreadable(matrix []readMatrixRow) []string {
	violations := []string{}
	for _, item := range matrix {
		if !item.definer && !item.readable {
			violations = append(violations, fmt.Sprintf("%s executable by %s reads work.%s with "+
				"prosecdef=false and no SELECT (config=%q)", item.function, item.role, item.table, item.config))
		}
	}
	return violations
}

func hasRow(matrix []readMatrixRow, function, role, table string, definer, readable bool) bool {
	for _, item := range matrix {
		if item.function == function && item.role == role && item.table == table &&
			item.definer == definer && item.readable == readable {
			return true
		}
	}
	return false
}

// mustExecAll runs each statement on its own. pgx's Conn.Exec can silently execute nothing
// when one string carries several statements - a trap already documented in this package's
// fixtures - and a mutation that did not take would make the control below pass by doing nothing.
func mustExecAll(t *testing.T, ctx context.Context, conn *pgx.Conn, statements ...string) {
	t.Helper()
	for _, statement := range statements {
		if _, err := conn.Exec(ctx, statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
}

// setHardening puts the two attributes back, for the cleanup path where t.Fatalf is no longer
// available - a database left unhardened would otherwise be reported as a green test.
func setHardening(conn *pgx.Conn) error {
	for _, statement := range []string{
		`ALTER FUNCTION work.list_pending_audit_exports(text) SECURITY DEFINER`,
		`ALTER FUNCTION work.list_pending_audit_exports(text) SET search_path = work, pg_catalog`,
	} {
		if _, err := conn.Exec(context.Background(), statement); err != nil {
			return fmt.Errorf("%s: %w", statement, err)
		}
	}
	return nil
}
func TestWorkloadRolesCanReadWhatTheirFunctionsRead(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	dbName, admin := newGateDB(t)
	matrix := readWorkloadMatrix(t, ctx, admin)
	// Floor: the predicate has to actually cross roles with bodies. An empty matrix here would make
	// the "no violations" assertion below a tautology, which is how #87 got shipped in the first place.
	if len(matrix) < 20 {
		t.Fatalf("read %d (function, role, table) triples, want at least 20 - the matrix is not being built",
			len(matrix))
	}
	if gaps := unreadable(matrix); len(gaps) > 0 {
		t.Fatalf("workload roles cannot read what the functions they may execute read:\n  %s",
			strings.Join(gaps, "\n  "))
	}

	// The load-bearing pair, named: if either side of this ever flips, the predicate above stops
	// being able to see the #87 shape and the test would pass on an empty set.
	if !hasRow(matrix, "list_pending_audit_exports", "work_worker", "audit_export", true, false) {
		t.Fatalf("the export discovery read is not shaped as #87 described; work_worker's EXECUTE, the "+
			"SECURITY DEFINER and the missing SELECT on work.audit_export all have to hold for this guard "+
			"to mean anything: %v", hasList(matrix, "list_pending_audit_exports"))
	}
	// 0029 is the deliberate opposite decision, and it has to stay visible here: invoker rights, and
	// the executing role can read the tables. If that ever stops being true the rule above would have
	// to be re-read rather than assumed.
	if !hasRow(matrix, "release_unreceipted_reservations", "work_worker", "quota_reservation", false, true) {
		t.Fatalf("0029's helper no longer matches the shape #87 left alone (invoker rights, readable "+
			"tables); re-read 0029:38-43 before changing either the increment or this assertion: %v",
			hasList(matrix, "release_unreceipted_reservations"))
	}

	worker := connect(t, testpg.WorkerURL(dbName))
	if _, err := worker.Exec(ctx, `SET app.org_id = 'org_a'`); err != nil {
		t.Fatal(err)
	}
	var count int
	// The call itself is the production symptom: pre-0034 this returned SQLSTATE 42501.
	if err := worker.QueryRow(ctx, `SELECT count(*) FROM work.list_pending_audit_exports('org_a')`).Scan(&count); err != nil {
		t.Fatalf("work_worker calling the export discovery read failed: %v", err)
	}
}

func TestWorkloadReadPrivilegeGuardFiresWhenHardeningIsDropped(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	dbName, admin := newGateDB(t)

	// This is 0031's state, reproduced rather than argued. The mutation commits: permission checks
	// read the catalogue of the calling session, so an uncommitted ALTER would be invisible to the
	// worker connection - and the whole point is what a separate session sees. The gate database is
	// created per test and dropped afterwards, so the only obligation is to leave it readable for the
	// assertions below and for whoever runs this test next.
	t.Cleanup(func() {
		if err := setHardening(admin); err != nil {
			t.Errorf("restore the hardening after the mutation: %v", err)
		}
	})
	mustExecAll(t, ctx, admin,
		`ALTER FUNCTION work.list_pending_audit_exports(text) SECURITY INVOKER`,
		`ALTER FUNCTION work.list_pending_audit_exports(text) RESET search_path`)

	matrix := readWorkloadMatrix(t, ctx, admin)
	gaps := unreadable(matrix)
	if len(gaps) != 1 || !strings.HasPrefix(gaps[0], "list_pending_audit_exports ") {
		t.Fatalf("with the hardening dropped, the matrix reports %v, want exactly the export discovery read", gaps)
	}
	var config string
	var definer bool
	if err := admin.QueryRow(ctx, `SELECT prosecdef, coalesce(array_to_string(proconfig, ','), '')
		FROM pg_proc WHERE oid = 'work.list_pending_audit_exports(text)'::regprocedure`).Scan(&definer, &config); err != nil {
		t.Fatal(err)
	}
	if definer || strings.Contains(config, "search_path=work") {
		t.Fatalf("the mutation did not take: prosecdef=%v config=%q", definer, config)
	}

	worker := connect(t, testpg.WorkerURL(dbName))
	if _, err := worker.Exec(ctx, `SET app.org_id = 'org_a'`); err != nil {
		t.Fatal(err)
	}
	var count int
	err := worker.QueryRow(ctx, `SELECT count(*) FROM work.list_pending_audit_exports('org_a')`).Scan(&count)
	if err == nil {
		t.Fatal("work_worker read audit_export through the invoker-rights function and got no error: " +
			"the grant that makes #87 a permission bug is gone, so re-read the audit_export grants")
	}
	if !strings.Contains(err.Error(), "42501") || !strings.Contains(err.Error(), "audit_export") {
		t.Fatalf("error = %v, want SQLSTATE 42501 on audit_export (the production work-export failure)", err)
	}

	mustExecAll(t, ctx, admin,
		`ALTER FUNCTION work.list_pending_audit_exports(text) SECURITY DEFINER`,
		`ALTER FUNCTION work.list_pending_audit_exports(text) SET search_path = work, pg_catalog`)
	if _, err := worker.Exec(ctx, `SET app.org_id = 'org_a'`); err != nil {
		t.Fatal(err)
	}
	if err := worker.QueryRow(ctx, `SELECT count(*) FROM work.list_pending_audit_exports('org_a')`).Scan(&count); err != nil {
		t.Fatalf("after restoring the hardening the worker call still fails: %v", err)
	}
	if gaps := unreadable(readWorkloadMatrix(t, ctx, admin)); len(gaps) > 0 {
		t.Fatalf("restore did not clear the matrix: %v", gaps)
	}
}

// hasList renders the rows for one function, so the two "shape changed" failures say what the
// database actually looks like instead of only denying it.
func hasList(matrix []readMatrixRow, function string) []string {
	out := []string{}
	for _, item := range matrix {
		if item.function == function {
			out = append(out, fmt.Sprintf("%s/%s/work.%s definer=%v readable=%v config=%q",
				item.function, item.role, item.table, item.definer, item.readable, item.config))
		}
	}
	if len(out) == 0 {
		return []string{"(no rows for this function)"}
	}
	return out
}
