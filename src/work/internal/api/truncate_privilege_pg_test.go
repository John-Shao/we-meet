package api_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/testpg"
)

// Task #24, made executable instead of argued. The append-only invariant is enforced by a row
// trigger - `prevent_mutation` is BEFORE UPDATE OR DELETE - and TRUNCATE fires no row trigger at
// all. So either the invariant is also privilege-protected, or any role that can truncate can
// empty the audit trail in one statement while the guard stays silent. Running the question
// against the live catalog gives a bounded answer worth pinning: exactly two roles hold TRUNCATE
// on anything in work - the owning role and the migration login - and neither of them is a
// workload credential. The migration login holds it because it is a member of the owner, which
// is what lets it run ALTER TABLE at all; TRUNCATE by an owner cannot be revoked, so no trigger
// could close this and the compensating control is provisioning (D-04): the application never
// holds that credential, only the rollout step does.

// truncateHolders lists every work_% role that holds TRUNCATE on at least one table in the work
// schema, in one read of the catalog, so the assertion is about privileges rather than a copy of
// the grant list.
func truncateHolders(t *testing.T, dbName string) string {
	t.Helper()
	return opsScalar(t, dbName, `
		SELECT coalesce(string_agg(rolname, ',' ORDER BY rolname), '-')
		FROM (
		  SELECT DISTINCT r.rolname
		  FROM pg_roles r
		  JOIN pg_class c ON has_table_privilege(r.rolname, c.oid, 'TRUNCATE')
		  JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname = 'work' AND c.relkind = 'r' AND r.rolname LIKE 'work%'
		) holders`)
}

// truncateAs runs TRUNCATE over the given login and returns the SQLSTATE and message, or two
// empty strings if it went through. Only literal table names are passed, never a request value.
func truncateAs(t *testing.T, url, table string) (string, string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, url)
	if err != nil {
		t.Fatalf("open for truncate %s: %v", table, err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "TRUNCATE TABLE work."+table); err == nil {
		return "", ""
	} else {
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) {
			t.Fatalf("truncate %s: unexpected error %v", table, err)
		}
		return pgErr.SQLState(), pgErr.Message
	}
}

func TestAppendOnlyTablesAreProtectedAgainstTruncateByPrivilege(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	// A couple of rows in the trail, so "the refusal left the data alone" is a fact rather than
	// an assumption about an empty table.
	auditBefore := opsScalar(t, dbName, `SELECT count(*)::text FROM work.audit_event`)
	if auditBefore == "0" {
		t.Fatal("fixture produced no audit rows to protect")
	}

	if got := truncateHolders(t, dbName); got != "work_migrator_login,work_owner" {
		t.Fatalf("TRUNCATE holders = %s, want only the owning role and the migration login; "+
			"a workload role gaining TRUNCATE means an append-only table can be emptied without "+
			"any guard noticing", got)
	}

	// Every credential the control plane actually runs with, refused on the privilege - not on
	// arguments - and each on a different append-only table so the boundary is not proved once
	// and generalized. These are the logins, which is the stronger form: neither the login nor
	// any role behind it holds TRUNCATE, which is why they are absent from the holder list.
	logins := []struct {
		name  string
		url   string
		table string
	}{
		{"work_app_test_login", testpg.AppURL(dbName), "audit_event"},
		{"work_worker_test_login", testpg.WorkerURL(dbName), "task_event"},
		{"work_directory_test_login", testpg.DirectoryURL(dbName), "quota_entry"},
		{"work_governance_test_login", testpg.GovernanceURL(dbName), "submission_dedup"},
		{"work_ops_test_login", testpg.OpsURL(dbName), "artifact_tombstone"},
		{"work_operator_test_login", testpg.OperatorURL(dbName), "approval_decision"},
	}
	for _, login := range logins {
		state, message := truncateAs(t, login.url, login.table)
		if state != "42501" || message != "permission denied for table "+login.table {
			t.Fatalf("%s truncate %s = %s %q, want 42501 permission denied for table %s",
				login.name, login.table, state, message, login.table)
		}
	}
	if got := opsScalar(t, dbName, `SELECT count(*)::text FROM work.audit_event`); got != auditBefore {
		t.Fatalf("audit rows after the refused attempts = %s, want the seeded %s", got, auditBefore)
	}

	// Why the migration login passes: role membership in the owner, not an extra grant. Pinned
	// because it is the difference between "a privilege someone added" and "the price of being
	// able to migrate", and only the first of those is fixable with a revoke.
	if member := opsScalar(t, dbName,
		`SELECT pg_has_role('work_migrator_login', 'work_owner', 'MEMBER')::text`); member != "true" {
		t.Fatalf("work_migrator_login is not a member of work_owner (%s); if that changed, the "+
			"holder set above needs re-reading rather than re-pinning", member)
	}

	// The residual, asserted rather than described: as the owner the statement goes straight
	// through, the trigger never fires, and the rows are gone. This is the boundary D-04 has to
	// hold - it is not covered by any guard trigger.
	if state, message := truncateAs(t, testpg.AdminURLFor(dbName), "audit_event"); state != "" {
		t.Fatalf("owner truncate = %s %q, want it to go through (TRUNCATE bypasses row triggers)",
			state, message)
	}
	if got := opsScalar(t, dbName, `SELECT count(*)::text FROM work.audit_event`); got != "0" {
		t.Fatalf("audit rows after an owner truncate = %s, want 0 - the guard trigger did not fire, "+
			"which is exactly the point", got)
	}
}
