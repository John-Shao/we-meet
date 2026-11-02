package migrate

import (
	"fmt"
	"testing"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for increment 0022: the organization-execution guard reports *why* an
// organization cannot run.
//
// 0009 raised one code for three situations, and because that code was not in the error
// catalogue it surfaced as a retryable 503 - "call again" - including when the reason was an
// operator's deliberate suspension. The split is about being able to tell those apart; the
// retry behaviour itself is decided elsewhere (Temporal's per-activity policy for the worker,
// the HTTP status for anything client-facing), which is why this test checks names rather
// than claiming an outage now stops.

func TestOrgExecutionGuardSplitsByTriggerCondition(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_exec_split"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)
	ctx := testContext(t)

	guard := func() error {
		_, err := admin.Exec(ctx, `SELECT work.assert_org_execution_enabled($1)`, org)
		return err
	}
	guardCode := func(want string) {
		t.Helper()
		_, err := admin.Exec(ctx, `SELECT work.assert_org_execution_enabled($1)`, org)
		if err == nil {
			if want == "" {
				return
			}
			t.Fatalf("guard passed, want %q", want)
		}
		if want != "" {
			assertPgMessage(t, err, want)
		}
	}

	// The runnable baseline, so the test below cannot be passing because the org row is
	// missing or the guard is unreachable.
	guardCode("")

	// A deliberate operator suspension is its own answer now.
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.org SET operator_suspended = true WHERE id = '%s'", org))
	guardCode("org_operator_suspended")

	// Suspension wins when the organization is also archived-ish: the human decision is
	// the one somebody has to act on, and reporting the state instead would send the caller
	// off to check provisioning.
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.org SET status = 'suspended' WHERE id = '%s'", org))
	guardCode("org_operator_suspended")

	// Lift the suspension and the remaining conditions keep the code they have always
	// produced: those can change without anyone acting on the organization.
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.org SET operator_suspended = false, execution_enabled = false WHERE id = '%s'",
		org))
	guardCode("org_execution_disabled")
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.org SET execution_enabled = true WHERE id = '%s'", org))
	guardCode("org_execution_disabled")

	// And the same split is what a worker actually sees through a real gate, not only when
	// the assertion is called directly: the four runtime gates reach it the same way.
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.org SET status = 'active', execution_enabled = true, operator_suspended = true WHERE id = '%s'",
		org))
	worker := connect(t, testpg.WorkerURL(dbName))
	defer worker.Close(ctx)
	if _, err := worker.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.Exec(ctx, `SELECT work.register_runtime_execution(
		$1, $2::uuid, $3::uuid, 'plan', 1, 'pi-1', now() + interval '10 minutes')`,
		org, newUUID(t), run.runID); err == nil {
		t.Fatal("register_runtime_execution admitted work for an operator-suspended organization")
	} else {
		assertPgMessage(t, err, "org_operator_suspended")
	}

	if err := guard(); err == nil {
		t.Fatal("the guard stopped reporting")
	}
}
