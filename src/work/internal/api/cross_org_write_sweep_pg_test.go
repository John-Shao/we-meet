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

// The read-side sweep proved that no workload login sees another organization's rows. This is
// the other half, which the read test cannot speak to: rewriting a row's org_id, and deleting
// rows that belong to someone else. It matters because a policy with USING but no WITH CHECK
// still hides foreign rows on the way out while letting a caller move rows *into* another
// tenant - which is a quieter leak than the one every feature test already guards against.
//
// Per tenant table, run as every workload login that can reach it:
//
//   - UPDATE ... SET org_id = 'org_other' WHERE org_id = 'org_a': the rows are visible, so a
//     table with rows in this tenant must refuse. A refusal is either the policy
//     (new row violates row-level security) or the privilege (no UPDATE granted); both are
//     correct answers, and a silent success is not.
//   - DELETE ... WHERE org_id = 'org_other': the rows are invisible under USING, so the honest
//     expectation is zero rows gone, and any row removed is a hole.
//
// The empty-table case is counted separately instead of being allowed to pass as a refusal, and
// one deliberately legal same-tenant update runs at the end to prove the harness is measuring
// rows that change.

type writeAttempt struct {
	table  string
	login  string
	seen   int
	result string
}

func classifyWrite(t *testing.T, url, org, statement string) (int64, string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, url)
	if err != nil {
		t.Fatalf("open for write sweep: %v", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', $1, false)`, org); err != nil {
		t.Fatalf("set tenant for write sweep: %v", err)
	}
	tag, err := conn.Exec(ctx, statement)
	if err != nil {
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) {
			t.Fatalf("unexpected write error: %v", err)
		}
		if strings.Contains(pgErr.Message, "row-level security") {
			return 0, "policy"
		}
		if pgErr.SQLState() == "42501" {
			return 0, "privilege"
		}
		t.Fatalf("write sweep error %s %q: want a policy or privilege refusal",
			pgErr.SQLState(), pgErr.Message)
	}
	return tag.RowsAffected(), "executed"
}

func TestCrossOrgWritesAreRefusedOnEveryTenantTable(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	tables := tenantTables(t, dbName)

	var attempts []writeAttempt
	var moved, deleted []string
	for _, login := range workloadLogins(dbName) {
		for _, table := range tables {
			// How many rows this login can actually see in this tenant: a refusal on an empty
			// table would prove nothing, so the population is measured before the attempt.
			seen := 0
			ctx := context.Background()
			conn, err := testpg.Open(ctx, login.url)
			if err != nil {
				t.Fatalf("open %s: %v", login.name, err)
			}
			if _, err := conn.Exec(ctx,
				`SELECT set_config('app.org_id', 'org_a', false)`); err != nil {
				conn.Close(ctx)
				t.Fatalf("set tenant under %s: %v", login.name, err)
			}
			err = conn.QueryRow(ctx, "SELECT count(*)::int FROM work."+table).Scan(&seen)
			if err != nil {
				var pgErr *pgconn.PgError
				if errors.As(err, &pgErr) && pgErr.SQLState() == "42501" {
					conn.Close(ctx)
					continue
				}
				conn.Close(ctx)
				t.Fatalf("count %s under %s: %v", table, login.name, err)
			}
			conn.Close(ctx)

			rows, kind := classifyWrite(t, login.url, "org_a",
				fmt.Sprintf("UPDATE work.%s SET org_id = 'org_other' WHERE org_id = 'org_a'", table))
			label := kind
			if kind == "executed" {
				label = fmt.Sprintf("executed/%d", rows)
				if rows > 0 {
					moved = append(moved, table+"("+login.name+")")
				}
			}
			attempts = append(attempts, writeAttempt{table, login.name, seen, label})

			rows, kind = classifyWrite(t, login.url, "org_a",
				fmt.Sprintf("DELETE FROM work.%s WHERE org_id = 'org_other'", table))
			if kind == "executed" && rows > 0 {
				deleted = append(deleted, fmt.Sprintf("%s(%s)=%d", table, login.name, rows))
			}
		}
	}

	if len(moved) != 0 {
		t.Fatalf("rows moved into another organization: %s - a policy that filters USING without "+
			"WITH CHECK lets a caller re-point rows across tenants", strings.Join(moved, ", "))
	}
	if len(deleted) != 0 {
		t.Fatalf("foreign-tenant rows deleted from under app.org_id=org_a: %s", strings.Join(deleted, ", "))
	}

	// The classification counts are the substance of this test, so they stay visible: which
	// tables answered with the RLS policy and which with a plain privilege refusal.
	byResult := map[string]int{}
	byTable := map[string]bool{}
	for _, a := range attempts {
		byResult[a.result]++
		byTable[a.table] = true
	}
	keys := make([]string, 0, len(byResult))
	for k := range byResult {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	t.Logf("write attempts = %d over %d tables; outcomes = %s", len(attempts), len(byTable),
		strings.Join(fmtCounts(keys, byResult), ", "))

	// A tenant table nobody even attempted is a coverage hole, and a sweep whose tables were all
	// empty would be a false pass, so both are pinned.
	var unattempted []string
	for _, table := range tables {
		if !byTable[table] {
			unattempted = append(unattempted, table)
		}
	}
	// The same tables as the read sweep: no workload login can reach them, so neither sweep covers
	// them and that limit is named rather than smoothed over. 0040 added nine device-side tables to
	// this set deliberately - like 0024's provider_probe_grant they grant no table privilege at all,
	// so every effect goes through a SECURITY DEFINER command and a direct cross-org UPDATE is
	// refused by privilege before row security is even consulted. 0042 adds four more on the
	// same rule (local_action, device_dispatch, device_receipt, device_run_finish) and 0043 two
	// more (artifact_replica, consumed_possession_nonce), so the named set is thirty-five.
	wantUnattempted := "access_restriction,artifact_replica,audit_export,cancellation_intent," +
		"consumed_governance_command,consumed_possession_nonce," +
		"content_reference,device,device_checkpoint,device_dispatch,device_pairing,device_receipt," +
		"device_run_binding,device_run_finish,device_session,device_session_ticket,directory_sync_state," +
		"execution_entitlement,execution_lease,governance_change,governance_event_cursor," +
		"governance_gap_report,local_action,local_execution_policy," +
		"operation_resolution,operation_usage_fact,provider_access_config,provider_credential," +
		"provider_probe_grant,readonly_approval_grant,runtime_capability,runtime_checkpoint_head," +
		"usage_daily,workspace_grant,workspace_grant_succession"
	if got := strings.Join(unattempted, ","); got != wantUnattempted {
		t.Fatalf("tables the write sweep could not attempt = [%s], want the documented set [%s]: "+
			"the list changing means a workload login gained or lost reach on a tenant table",
			got, wantUnattempted)
	}
	populated := 0
	for _, a := range attempts {
		if a.seen > 0 {
			populated++
		}
	}
	if populated < 5 {
		t.Fatalf("only %d attempt-slots ran against a non-empty table; the refusals above would be "+
			"measured against almost nothing", populated)
	}
	// What this sweep actually measured: the workload roles are refused by privilege on every
	// tenant table, because no workload role holds UPDATE on any of them - writes all go through
	// SECURITY DEFINER commands. That is a real finding, so it is pinned instead of being allowed
	// to hide behind "something refused". The policy itself is exercised below, through the one
	// credential that does hold UPDATE and is still subject to the forced policies.
	if byResult["privilege"] != len(attempts) {
		t.Fatalf("cross-org updates by workload logins = %v, want all %d refused by privilege: "+
			"if a workload role gained UPDATE, the refusal below is no longer the whole story and "+
			"the policy test has to take over that role's cases", byResult, len(attempts))
	}

	// Positive control: the very same statement shape does change rows when it stays inside the
	// tenant, which is what makes every zero above a refusal rather than a no-op.
	owner := testpg.AdminURLFor(dbName)
	ctx := context.Background()
	conn, err := testpg.Open(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', false)`); err != nil {
		t.Fatal(err)
	}
	tag, err := conn.Exec(ctx, `UPDATE work.task SET title = title WHERE org_id = 'org_a'`)
	if err != nil {
		t.Fatalf("same-tenant control update: %v", err)
	}
	if tag.RowsAffected() < 1 {
		t.Fatalf("same-tenant control changed %d rows; want at least one, so the refusals above are "+
			"proof of a real guard and not of a statement that never matches a row", tag.RowsAffected())
	}
	t.Logf("same-tenant control update rows = %d", tag.RowsAffected())

	// WITH CHECK is the clause that stops a row being re-pointed, and it only speaks when the
	// caller actually holds UPDATE. The migration login is a member of the owning role - it is
	// not a superuser, and FORCE ROW LEVEL SECURITY binds it - so it is the credential that lets
	// the policy be tested rather than the grant.
	refusedByPolicy := []string{}
	hiddenByNoUpdatePolicy := []string{}
	for _, table := range []string{"task", "run", "input_object", "audit_event", "quota_account"} {
		rows, kind := classifyWrite(t, testpg.MigratorURL(dbName), "org_a",
			fmt.Sprintf("UPDATE work.%s SET org_id = 'org_other' WHERE org_id = 'org_a'", table))
		switch {
		case kind == "policy":
			refusedByPolicy = append(refusedByPolicy, table)
		case kind == "executed" && rows == 0:
			// No UPDATE policy exists for the append-only tables, so forced RLS hides every row
			// from the command and the statement changes nothing. That is fail-closed, but it is
			// only acceptable because a second control exists: the same trigger that refuses the
			// rewrite outright. Without it, "no policy" would be a hole rather than a wall.
			guarded := opsScalar(t, dbName, "SELECT count(*)::text FROM pg_trigger t "+
				"JOIN pg_proc p ON p.oid = t.tgfoid "+
				"WHERE t.tgrelid = 'work."+table+"'::regclass AND p.proname = 'prevent_mutation'")
			if guarded == "0" {
				t.Fatalf("%s cross-org update changed no rows only because no UPDATE policy exists, "+
					"and the append-only trigger is missing too: nothing on this table would stop a "+
					"caller who found another way in", table)
			}
			hiddenByNoUpdatePolicy = append(hiddenByNoUpdatePolicy, table+"(append-only trigger)")
		default:
			t.Fatalf("%s cross-org update as the owner member = kind %s rows %d, want either a WITH "+
				"CHECK refusal or zero rows behind the append-only trigger", table, kind, rows)
		}
	}
	if len(refusedByPolicy) == 0 {
		t.Fatalf("no table was refused by the row-level security policy: WITH CHECK itself stays "+
			"untested (hidden by no-UPDATE-policy: %v)", hiddenByNoUpdatePolicy)
	}
	t.Logf("cross-org updates as the owner member: refused by WITH CHECK = [%s], zero rows behind "+
		"the append-only trigger = [%s]", strings.Join(refusedByPolicy, ","),
		strings.Join(hiddenByNoUpdatePolicy, ","))
}

func fmtCounts(keys []string, counts map[string]int) []string {
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, fmt.Sprintf("%s=%d", k, counts[k]))
	}
	return out
}

func TestEveryWritePolicyCarriesAWithCheckClause(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	// USING without WITH CHECK is exactly the hole the sweep above hunts: reads stay filtered
	// while writes go anywhere. Commands that cannot write (SELECT-only policies) are excluded by
	// polcmd, so the answer is about the write policies only.
	loose := opsScalar(t, dbName, `
		SELECT coalesce(string_agg(DISTINCT name, ',' ORDER BY name), '-') FROM (
		  SELECT c.relname || '/' || p.polname AS name
		  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
		  JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE n.nspname = 'work'
		    AND p.polcmd IN ('*', 'a', 'w', 'd')
		    AND p.polwithcheck IS NULL
		) bad`)
	if loose != "-" {
		t.Fatalf("write policies without a WITH CHECK clause = [%s]: rows could be inserted or "+
			"rewritten into another tenant while the same policy still hides foreign rows on read",
			loose)
	}

	// Anti-vacuity: the filter has to select real policies, or "-" is just an empty result.
	t.Logf("write policies = %s, read policies = %s",
		opsScalar(t, dbName, `
			SELECT count(*)::text FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'work' AND p.polcmd IN ('*', 'a', 'w', 'd')`),
		opsScalar(t, dbName, `
			SELECT count(*)::text FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'work' AND p.polcmd = 'r'`))
}
