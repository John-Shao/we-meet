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
	t.Logf("EXECUTE grantees = [%s]", grantees)

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
