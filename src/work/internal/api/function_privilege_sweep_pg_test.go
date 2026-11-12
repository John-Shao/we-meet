package api_test

import (
	"strconv"
	"testing"
)

// The third sweep of this line, and the same reasoning that justified the tenant sweep applies
// here: function privileges are set once, in baseline/0002 and in each increment, and no feature
// test looks at them as a set. Two catalog invariants are worth pinning because each is the kind
// that degrades silently when someone adds a role or a command:
//
//   - EXECUTE must never be reachable through PUBLIC. PostgreSQL grants EXECUTE to PUBLIC on
//     every new function by default, so a migration that creates a domain command and forgets to
//     revoke leaves it callable by any authenticated role in the database - invisible to every
//     per-command grant test, which only checks the roles it knows about.
//   - every SECURITY DEFINER command must pin its own search_path. Without it, the function runs
//     with the owner's privileges against whatever schema the *caller* controls, which turns a
//     carefully granted command into a privilege escalation.

func TestNoWorkFunctionIsCallableThroughPublic(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	open := opsScalar(t, dbName, `
		SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '-')
		FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'work'
		  AND has_function_privilege('public', p.oid, 'EXECUTE')`)
	if open != "-" {
		t.Fatalf("work functions executable through the PUBLIC pseudo-role = [%s]: PostgreSQL grants "+
			"EXECUTE to PUBLIC on every new function, so any command added without a REVOKE lands "+
			"here and no per-command grant test would notice", open)
	}

	// Which roles hold EXECUTE anywhere at all. Whole-string equality: a new workload role, or a
	// command granted to a role that should not have it, changes this list.
	grantees := opsScalar(t, dbName, `
		SELECT coalesce(string_agg(name, ',' ORDER BY name), '-') FROM (
		  SELECT DISTINCT r.rolname AS name
		  FROM pg_proc p
		  JOIN pg_namespace n ON n.oid = p.pronamespace
		  JOIN LATERAL aclexplode(p.proacl) a ON true
		  JOIN pg_roles r ON r.oid = a.grantee
		  WHERE n.nspname = 'work' AND a.privilege_type = 'EXECUTE'
		) g`)
	want := "work_api,work_directory,work_governance_events,work_operator,work_ops,work_owner,work_worker"
	if grantees != want {
		t.Fatalf("roles holding EXECUTE on a work function = [%s], want [%s]: this is the whole "+
			"authority surface of the domain commands, so a new grantee - or a role quietly gaining "+
			"one - has to be a deliberate change, not a side effect of an increment", grantees, want)
	}

	// And the owner-only count, so "no grants at all" is visible as a number rather than a
	// silence: a function that lost every grant line still behaves like an owner-only command.
	t.Logf("functions with an explicit EXECUTE acl = %s, total = %s",
		opsScalar(t, dbName, `
			SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			WHERE n.nspname = 'work' AND p.proacl IS NOT NULL`),
		opsScalar(t, dbName, `
			SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			WHERE n.nspname = 'work'`))
}

func TestEveryDefinerWorkFunctionPinsItsSearchPath(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	loose := opsScalar(t, dbName, `
		SELECT coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '-')
		FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'work' AND p.prosecdef
		  AND (p.proconfig IS NULL
		       OR NOT (array_to_string(p.proconfig, ',') LIKE '%search_path%'))`)
	if loose != "-" {
		t.Fatalf("SECURITY DEFINER functions with no pinned search_path = [%s]: such a command runs "+
			"with the owner's privileges against whatever search path the caller set, so a forgotten "+
			"SET search_path is privilege escalation rather than a style issue", loose)
	}

	// The count gives the assertion above its weight: if no function were a definer the check
	// would pass vacuously, and the schema is full of them by design.
	total := opsScalar(t, dbName, `
		SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'work' AND p.prosecdef`)
	definers, err := strconv.Atoi(total)
	if err != nil {
		t.Fatalf("definer count %q: %v", total, err)
	}
	if definers < 40 {
		t.Fatalf("only %s SECURITY DEFINER work functions found; either the chain changed shape or "+
			"this test is not selecting what it claims to check", total)
	}
	t.Logf("SECURITY DEFINER work functions = %d", definers)
}

// ownerOnlyReachabilitySQL answers, in one read: which work tables may not be SELECTed directly
// by any workload role AND also have no SECURITY DEFINER command that (a) references them and
// (b) is executable by a workload role. Such a table is structure without a writer - it can never
// be filled by shipped code, only by someone connecting as the owner.
//
// The reference is a word-boundary regex (\m/\M), not a substring: a body that mentions
// cancellation_intent_guard or a 'cancellation_intent:' key must not count as writing
// cancellation_intent. A first version used position(), and it reported only governance_change -
// the substring form let some workload-granted body borrow the name. Word boundaries reproduce
// the offline audit exactly: both tables, for the reason recorded under want.
const ownerOnlyReachabilitySQL = `
	WITH workload AS (
	  SELECT unnest(ARRAY['work_api', 'work_worker', 'work_directory',
	                      'work_governance_events', 'work_operator', 'work_ops']) AS rolname),
	owner_only AS (
	  SELECT c.oid, c.relname
	  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
	  WHERE n.nspname = 'work' AND c.relkind = 'r'
	    AND NOT EXISTS (SELECT 1 FROM workload w
	                    WHERE has_table_privilege(w.rolname, c.oid, 'SELECT'))),
	definers AS (
	  SELECT p.oid, p.proacl, p.prosrc
	  FROM pg_proc p WHERE p.pronamespace = 'work'::regnamespace AND p.prosecdef)
	SELECT coalesce(string_agg(DISTINCT oo.relname, ',' ORDER BY oo.relname), '-')
	FROM owner_only oo
	WHERE NOT EXISTS (
	  SELECT 1 FROM definers d
	  WHERE d.prosrc ~ ('\m' || oo.relname || '\M')
	    AND EXISTS (SELECT 1 FROM aclexplode(d.proacl) a
	                JOIN pg_roles r ON r.oid = a.grantee
	                WHERE a.privilege_type = 'EXECUTE'
	                  AND r.rolname IN (SELECT rolname FROM workload)))`

func TestTablesNoWorkloadRoleMayWriteAreNamedExactly(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	// governance_change (0018) is the one left: its only referencing command is EXECUTE-granted to
	// work_owner alone and has no caller, so it is still a held R0b surface rather than an R0a gap.
	//
	// cancellation_intent LEFT this set in 0040: revoke_device and revoke_workspace_grant insert
	// into it and both are EXECUTE-granted to work_api, so it now has a real workload-reachable
	// writer. That is the change this pin exists to force - "a table leaving it should be wired and
	// tested for real" - and the wiring is tested by TestR0bDeviceRevokeWritesCancellationIntent
	// in internal/migrate, which asserts the intent row, its source_event_id binding to the deny,
	// and that a replay does not create a second one.
	//
	// Pinning the set is what keeps it honest: the day one of these gets wired, or a new table lands
	// with no writer at all, the string changes.
	unreachable := opsScalar(t, dbName, ownerOnlyReachabilitySQL)
	want := "governance_change"
	if unreachable != want {
		t.Fatalf("work tables with neither a workload SELECT grant nor a workload-reachable "+
			"definer command = [%s], want [%s]: a table joining this list is structure without a "+
			"writer, and a table leaving it should be wired and tested for real",
			unreachable, want)
	}

	// Anti-vacuity: the query has to be looking at a real population on both sides, otherwise
	// "exactly two" would be trivially true over an empty set.
	ownerOnly := opsScalar(t, dbName, `
		SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'work' AND c.relkind = 'r'
		  AND NOT EXISTS (SELECT 1 FROM pg_roles r
		                  WHERE r.rolname IN ('work_api','work_worker','work_directory',
		                                      'work_governance_events','work_operator','work_ops')
		                    AND has_table_privilege(r.rolname, c.oid, 'SELECT'))`)
	definers := opsScalar(t, dbName, `
		SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'work'::regnamespace AND prosecdef`)
	ownerCount, err := strconv.Atoi(ownerOnly)
	if err != nil {
		t.Fatalf("owner-only table count %q: %v", ownerOnly, err)
	}
	definerCount, err := strconv.Atoi(definers)
	if err != nil {
		t.Fatalf("definer count %q: %v", definers, err)
	}
	if ownerCount < 19 || definerCount < 40 {
		t.Fatalf("population behind the reachability claim = %s owner-only tables and %s definers, "+
			"want at least 19 and 40: below that the exact-one answer above would be measured over "+
			"almost nothing", ownerOnly, definers)
	}
	t.Logf("owner-only tables = %s, SECURITY DEFINER functions = %s", ownerOnly, definers)
}

// TestAuditExportPermissionMatrix pins the three-part invariant for audit export access:
// work_api may not SELECT the table directly, must EXECUTE the prefetch function, and that
// function must be SECURITY DEFINER. This is the fix for the 503 regression introduced by
// aedeb2e71 (direct table query) and resolved by 0036 (SECURITY DEFINER prefetch).
func TestAuditExportPermissionMatrix(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	// Part 1: work_api must NOT have direct SELECT on audit_export table.
	// This is the design invariant from baseline 0002:5186.
	canSelect := opsScalar(t, dbName, `
		SELECT CASE WHEN has_table_privilege('work_api', 'work.audit_export'::regclass, 'SELECT')
		       THEN 'true' ELSE 'false' END`)
	if canSelect != "false" {
		t.Fatalf("work_api has direct SELECT on work.audit_export = %s, want false: "+
			"baseline 0002:5186 revokes this to enforce 'only through domain functions' rule", canSelect)
	}

	// Part 2: prefetch_audit_export_content must be SECURITY DEFINER.
	// Without this, the function executes as work_api and hits the same permission denied.
	isDefiner := opsScalar(t, dbName, `
		SELECT p.prosecdef::text
		FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'work' AND p.proname = 'prefetch_audit_export_content'`)
	if isDefiner != "true" {
		t.Fatalf("prefetch_audit_export_content.prosecdef = %s, want true: "+
			"0036 migration must create this as SECURITY DEFINER", isDefiner)
	}

	// Part 3: work_api must have EXECUTE on the prefetch function.
	canExec := opsScalar(t, dbName, `
		SELECT CASE WHEN has_function_privilege('work_api', 'work.prefetch_audit_export_content(text, text, text)', 'EXECUTE')
		       THEN 'true' ELSE 'false' END`)
	if canExec != "true" {
		t.Fatalf("work_api has EXECUTE on prefetch_audit_export_content = %s, want true: "+
			"0036 migration must grant this", canExec)
	}

	// Part 4: the function must pin its search_path (like all SECURITY DEFINER functions).
	pinnedPath := opsScalar(t, dbName, `
		SELECT CASE WHEN COALESCE(
		         (SELECT bool_or(cfg::text LIKE '%%search_path%%')
		          FROM unnest(p.proconfig) AS cfg),
		         false)
		       THEN 'true' ELSE 'false' END
		FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'work' AND p.proname = 'prefetch_audit_export_content'`)
	if pinnedPath != "true" {
		t.Fatalf("prefetch_audit_export_content pins search_path = %s, want true: "+
			"SECURITY DEFINER without pinned search_path is privilege escalation", pinnedPath)
	}

	t.Logf("audit_export permission matrix verified: work_api no direct SELECT, prefetch is SECURITY DEFINER with pinned search_path and EXECUTE grant")
}
