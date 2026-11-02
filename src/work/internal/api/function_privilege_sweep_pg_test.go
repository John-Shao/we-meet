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

	// cancellation_intent (0018) and governance_change (0018) are the two: their only referencing
	// commands - queue_run_cancellations, record_member_narrowing, and in the same shape
	// release_restriction - are EXECUTE-granted to work_owner alone and have no caller. Both come
	// from the R0b governance-authority increment, which the 2026-11-02 sequencing decision put on
	// hold, so this is a held R0b surface rather than an R0a gap. Pinning the set is what keeps it
	// honest: the day one of these gets wired, or a new table lands with no writer at all, the
	// string changes.
	unreachable := opsScalar(t, dbName, ownerOnlyReachabilitySQL)
	want := "cancellation_intent,governance_change"
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
			"want at least 19 and 40: below that the exact-two answer above would be measured over "+
			"almost nothing", ownerOnly, definers)
	}
	t.Logf("owner-only tables = %s, SECURITY DEFINER functions = %s", ownerOnly, definers)
}
