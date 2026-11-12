package api_test

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/testpg"
)

// Tenant isolation has been asserted table by table, inside feature tests, for months. This is
// the schema-wide sweep that was missing, and it is the shape the failure actually takes: a new
// table added later without ENABLE/FORCE, or without a policy, or read while the tenant GUC was
// forgotten, is invisible to every per-feature test because none of them looks at the schema.
//
// Two properties, both measured over every ordinary table of the work schema:
//
//   - the catalog shape: RLS enabled AND forced on every table except the named reference
//     dictionaries, each table carrying a policy, and the set of policies that do not bind the
//     tenant staying exactly as small as it is today;
//   - the fail-closed shape: with app.org_id unset, no tenant table returns a row to any
//     workload login. "Unset" is the accident that matters - the login holds SELECT on the
//     table, so the only thing standing between it and another organization's rows is the
//     policy's USING clause, and current_setting(..., true) yields NULL rather than an error.

// tenantTables lists the work tables that carry an org_id column, in catalog order.
func tenantTables(t *testing.T, dbName string) []string {
	t.Helper()
	raw := opsScalar(t, dbName, `
		SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '-')
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'work' AND c.relkind = 'r'
		  AND EXISTS (SELECT 1 FROM pg_attribute a
		              WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0)`)
	if raw == "-" {
		t.Fatal("the work schema has no tenant tables")
	}
	return strings.Split(raw, ",")
}

// workloadLogin is one of the credentials the control plane runs with. Every table is swept
// under each of them, so a table only a queue worker or the governance face may read is covered
// by the credential that actually holds the grant.
type workloadLogin struct {
	name string
	url  string
}

func workloadLogins(dbName string) []workloadLogin {
	return []workloadLogin{
		{"work_app", testpg.AppURL(dbName)},
		{"work_worker", testpg.WorkerURL(dbName)},
		{"work_directory", testpg.DirectoryURL(dbName)},
		{"work_governance", testpg.GovernanceURL(dbName)},
		{"work_operator", testpg.OperatorURL(dbName)},
		{"work_ops", testpg.OpsURL(dbName)},
	}
}

// sweepCounts counts every listed table under one login; guc is nil to leave app.org_id unset.
// A 42501 means this login may not read that table and is skipped - any other error fails the
// test, so a refusal on privileges can never be mistaken for isolation.
func sweepCounts(t *testing.T, dbName string, login workloadLogin, tables []string,
	guc *string) map[string]int {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, login.url)
	if err != nil {
		t.Fatalf("open %s: %v", login.name, err)
	}
	defer conn.Close(ctx)
	if guc != nil {
		if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', $1, false)`, *guc); err != nil {
			t.Fatalf("set tenant under %s: %v", login.name, err)
		}
	}
	counts := map[string]int{}
	for _, table := range tables {
		var count int
		err := conn.QueryRow(ctx, "SELECT count(*)::int FROM work."+table).Scan(&count)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.SQLState() == "42501" {
				continue
			}
			t.Fatalf("count %s under %s: %v", table, login.name, err)
		}
		counts[table] = count
	}
	return counts
}

func sortedJoin(names []string) string {
	sort.Strings(names)
	return strings.Join(names, ",")
}

func TestEveryWorkTableCarriesForcedTenantIsolation(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	// The two reference dictionaries are global by design (no org_id column, read by every
	// tenant), so they are the only tables allowed to skip RLS. Set equality is the point: a
	// table added later without ENABLE, without FORCE, or without a policy lands here instead of
	// quietly widening the unprotected set.
	unprotected := opsScalar(t, dbName, `
		SELECT coalesce(string_agg(name, ',' ORDER BY name), '-') FROM (
		  SELECT DISTINCT c.relname AS name
		  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname = 'work' AND c.relkind = 'r'
		    AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
		         OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
		) u`)
	if want := "resolution_state_map,state_transition"; unprotected != want {
		t.Fatalf("tables without RLS+FORCE+a policy = [%s], want [%s]", unprotected, want)
	}

	// Every policy in the schema would ideally be checked for a tenant binding, but the binding
	// cannot be read out of pg_policy in PostgreSQL 16: the GUC name lives in a Const node as a
	// byte array (`:constvalue 14 [ 56 0 0 0 97 112 112 46 ... ]`, i.e. "app.org_id"), so no
	// pattern match on polqual::text finds it in any policy. The property is asserted
	// behaviourally instead, in the sweep below, which is the stronger form anyway. What can be
	// checked here is the thing that would silently void that sweep: a role with BYPASSRLS is not
	// subject to FORCE either, so no work role may hold it.
	if bypass := opsScalar(t, dbName, `
		SELECT coalesce(string_agg(rolname, ',' ORDER BY rolname), '-')
		FROM pg_roles WHERE rolname LIKE 'work%' AND rolbypassrls`); bypass != "-" {
		t.Fatalf("work roles holding BYPASSRLS = [%s], want none: such a role reads every "+
			"organization's rows regardless of the forced policies", bypass)
	}

	// The same three-way distinction on columns: only the organization row itself and the two
	// global dictionaries have no org_id to bind to.
	noOrg := opsScalar(t, dbName, `
		SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '-')
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'work' AND c.relkind = 'r'
		  AND NOT EXISTS (SELECT 1 FROM pg_attribute a
		                  WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0)`)
	if want := "org,resolution_state_map,state_transition"; noOrg != want {
		t.Fatalf("tables without an org_id column = [%s], want [%s]", noOrg, want)
	}
}

func TestTenantTablesAreEmptyToEveryLoginWhenTheOrgGUCIsUnset(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	tables := tenantTables(t, dbName)

	seen := map[string]bool{}
	var leaks []string
	for _, login := range workloadLogins(dbName) {
		for table, count := range sweepCounts(t, dbName, login, tables, nil) {
			seen[table] = true
			if count != 0 {
				leaks = append(leaks, fmt.Sprintf("%s=%d rows via %s", table, count, login.name))
			}
		}
	}
	// Each tenant table has to be readable by at least one workload credential, or this sweep
	// proves nothing about it - so it says which ones went uncovered instead of passing.
	var unread []string
	for _, table := range tables {
		if !seen[table] {
			unread = append(unread, table)
		}
	}
	// Twenty-eight tenant tables are not readable by any of the six workload logins because their
	// only SELECT grant is work_owner's: no workload role holds direct SELECT there, and the
	// access path is a SECURITY DEFINER command instead. That is the design, not a gap - checked
	// against the migration sources at this head (0002 plus every increment through 0040; 186
	// function bodies parsed, 160 of them definers), where each of the twenty-eight is referenced by
	// at least one definer function. 0040 added nine device-side tables to this set on purpose: they
	// grant no table privilege at all, exactly like 0024's provider_probe_grant. They are named
	// rather than quietly skipped, so this sweep says what
	// it covers. The owning connection cannot stand in for them either: testpg.AdminURLFor is the
	// maintenance superuser (WORK_TEST_PG_URL with only the database swapped), and a superuser is
	// never stopped by a row policy, so a zero read from it would prove nothing either way.
	wantUncovered := "access_restriction,audit_export,cancellation_intent,consumed_governance_command," +
		"content_reference,device,device_pairing,device_run_binding,device_session," +
		"device_session_ticket,directory_sync_state,execution_entitlement,execution_lease," +
		"governance_change,governance_event_cursor,governance_gap_report,local_execution_policy," +
		"operation_resolution,operation_usage_fact,provider_access_config,provider_credential," +
		"provider_probe_grant,readonly_approval_grant,runtime_capability,runtime_checkpoint_head," +
		"usage_daily,workspace_grant,workspace_grant_succession"
	if got := sortedJoin(unread); got != wantUncovered {
		t.Fatalf("tenant tables unreachable by every workload login = [%s], want the documented "+
			"set [%s]: a table joining or leaving this list changes what this sweep actually "+
			"covers, and a new workload login would let it be covered for real", got, wantUncovered)
	}

	if len(leaks) != 0 {
		t.Fatalf("tenant tables visible with app.org_id unset: %s - an unset tenant setting must "+
			"resolve to no rows, not to every row", strings.Join(leaks, ", "))
	}

	// Anti-vacuity: the same credentials do see rows once a tenant is named, so all of those
	// zeros are isolation rather than an empty schema.
	orgA := "org_a"
	withRows := map[string]bool{}
	for _, login := range workloadLogins(dbName) {
		for table, count := range sweepCounts(t, dbName, login, tables, &orgA) {
			if count > 0 {
				withRows[table] = true
			}
		}
	}
	if len(withRows) < 3 {
		t.Fatalf("only %d tenant tables hold rows for org_a across every workload login; the "+
			"fail-closed zeros above would prove nothing", len(withRows))
	}

	// And the policies discriminate instead of collapsing to "everything". The fixture's split is
	// compared against the numbers seedTaskGraph writes (3 tasks and 2 runs in org_a, one of each
	// in org_other) rather than against a total read through the owning connection, because that
	// connection is subject to the same forced policies and would report one tenant's share as
	// though it were the whole.
	app := workloadLogins(dbName)[0]
	other := "org_other"
	for _, tc := range []struct {
		table         string
		orgACount     int
		orgOtherCount int
	}{
		{"task", 3, 1},
		{"run", 2, 1},
	} {
		inA := sweepCounts(t, dbName, app, []string{tc.table}, &orgA)[tc.table]
		inOther := sweepCounts(t, dbName, app, []string{tc.table}, &other)[tc.table]
		if inA != tc.orgACount || inOther != tc.orgOtherCount {
			t.Fatalf("%s visibility = org_a %d / org_other %d, want %d / %d",
				tc.table, inA, inOther, tc.orgACount, tc.orgOtherCount)
		}
	}
	t.Logf("tenant tables holding rows for org_a = [%s]",
		sortedJoin(sweepKeys(withRows)))
}

func sweepKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
	}
	return out
}
