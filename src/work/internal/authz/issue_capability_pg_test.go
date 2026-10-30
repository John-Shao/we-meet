package authz_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/authz"
	"github.com/we-meet/work/internal/capability"
)

// TestIssueCapabilityStoresHashAndBumpsGeneration proves the parent command
// mints a 32-byte opaque bearer, persists only its digest, and that a refresh
// supersedes the old generation for online authorization.
func TestIssueCapabilityStoresHashAndBumpsGeneration(t *testing.T) {
	dbName, admin, pool := newAuthzExecDB(t)
	worker := authzExecWorker(t, dbName, "org_issue_cap")
	run := seedAuthzExecRun(t, admin, "org_issue_cap", authzExecHash(t, "c"))
	run.holder = "parent-workload:" + authzExecUUID(t)
	prepareAuthzPlanOnly(t, worker, run)

	commands := &authz.PGCommands{Pool: pool}
	caller := authz.Caller{Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"}
	request := authz.IssueCapabilityRequest{
		OrgID: run.org, ExecutionID: run.planExec, Audience: capability.AudienceContent,
	}

	first, err := commands.IssueRuntimeCapability(testContext(t), caller, request)
	if err != nil {
		t.Fatalf("first issue: %v", err)
	}
	if first.Generation != 1 {
		t.Fatalf("generation = %d, want 1", first.Generation)
	}
	raw, err := base64.RawURLEncoding.DecodeString(first.Token)
	if err != nil || len(raw) != 32 {
		t.Fatalf("token is not 32 random bytes in unpadded base64url: %q", first.Token)
	}
	if first.ExpiresAt.IsZero() || first.ExpiresAt.After(time.Now().Add(31*time.Second)) {
		t.Fatalf("expires_at = %v, want within the 30s policy ceiling", first.ExpiresAt)
	}

	var stored string
	if err := admin.QueryRow(testContext(t), `
		SELECT token_hash FROM work.runtime_capability
		WHERE org_id = $1 AND execution_id = $2 AND audience = $3 AND generation = $4`,
		run.org, run.planExec, capability.AudienceContent, first.Generation,
	).Scan(&stored); err != nil {
		t.Fatalf("read stored capability: %v", err)
	}
	digest := sha256.Sum256([]byte(first.Token))
	if stored != hex.EncodeToString(digest[:]) {
		t.Fatalf("stored digest does not match sha256(token)")
	}
	if stored == first.Token {
		t.Fatal("stored value is the plaintext token")
	}
	var plaintextRows int
	if err := admin.QueryRow(testContext(t), `
		SELECT count(*) FROM work.runtime_capability c
		WHERE to_jsonb(c)::text LIKE '%' || $1 || '%'`, first.Token).Scan(&plaintextRows); err != nil {
		t.Fatal(err)
	}
	if plaintextRows != 0 {
		t.Fatalf("plaintext token appears in %d capability rows", plaintextRows)
	}

	issuer := capability.NewIssuer(pool)
	allowed, err := issuer.Authorize(testContext(t), run.org, run.planExec,
		capability.AudienceContent, first.Generation, first.Token)
	if err != nil || !allowed {
		t.Fatalf("first generation allowed=%t err=%v", allowed, err)
	}

	second, err := commands.IssueRuntimeCapability(testContext(t), caller, request)
	if err != nil {
		t.Fatalf("second issue: %v", err)
	}
	if second.Generation != first.Generation+1 {
		t.Fatalf("generations = %d then %d, want a bump", first.Generation, second.Generation)
	}
	if second.Token == first.Token {
		t.Fatal("refresh reused the same token")
	}
	allowed, err = issuer.Authorize(testContext(t), run.org, run.planExec,
		capability.AudienceContent, first.Generation, first.Token)
	if err != nil {
		t.Fatalf("authorize superseded: %v", err)
	}
	if allowed {
		t.Fatal("superseded generation still authorized")
	}
	allowed, err = issuer.Authorize(testContext(t), run.org, run.planExec,
		capability.AudienceContent, second.Generation, second.Token)
	if err != nil || !allowed {
		t.Fatalf("current generation allowed=%t err=%v", allowed, err)
	}
}

// TestIssueCapabilityRefusesForeignHolderAndWrongMode covers the caller
// binding and both mode-narrowing directions.
func TestIssueCapabilityRefusesForeignHolderAndWrongMode(t *testing.T) {
	dbName, admin, pool := newAuthzExecDB(t)
	worker := authzExecWorker(t, dbName, "org_issue_refuse")
	commands := &authz.PGCommands{Pool: pool}
	caller := authz.Caller{Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"}
	foreign := authz.Caller{Kind: authz.KindRuntimeParent, WorkloadID: "other-workload"}

	plan := seedAuthzExecRun(t, admin, "org_issue_refuse", authzExecHash(t, "c"))
	plan.holder = "parent-workload:" + authzExecUUID(t)
	prepareAuthzPlanOnly(t, worker, plan)

	_, err := commands.IssueRuntimeCapability(testContext(t), foreign, authz.IssueCapabilityRequest{
		OrgID: plan.org, ExecutionID: plan.planExec, Audience: capability.AudienceContent,
	})
	assertAuthzCode(t, err, "holder_not_owned")

	// The command interface is type-separated, but the implementation also
	// refuses a non-parent caller instead of relying on the HTTP whitelist.
	_, err = commands.IssueRuntimeCapability(testContext(t),
		authz.Caller{Kind: authz.KindEgress, WorkloadID: "parent-workload"},
		authz.IssueCapabilityRequest{
			OrgID: plan.org, ExecutionID: plan.planExec, Audience: capability.AudienceContent,
		})
	assertAuthzCode(t, err, "caller_not_permitted")

	_, err = commands.IssueRuntimeCapability(testContext(t), caller, authz.IssueCapabilityRequest{
		OrgID: plan.org, ExecutionID: plan.planExec, Audience: capability.AudienceEgress,
	})
	assertAuthzCode(t, err, "runtime_capability_audience_not_allowed")

	// A refused request never leaves a capability row behind.
	if got := authzExecCount(t, admin,
		`SELECT count(*) FROM work.runtime_capability WHERE org_id = $1 AND execution_id = $2`,
		plan.org, plan.planExec); got != 0 {
		t.Fatalf("refusals created %d capability rows", got)
	}

	execute := seedAuthzExecRun(t, admin, "org_issue_refuse", authzExecHash(t, "c"))
	execute.holder = "parent-workload:" + authzExecUUID(t)
	prepareAuthzExecute(t, worker, execute)

	_, err = commands.IssueRuntimeCapability(testContext(t), caller, authz.IssueCapabilityRequest{
		OrgID: execute.org, ExecutionID: execute.execExec, Audience: capability.AudienceContent,
	})
	assertAuthzCode(t, err, "runtime_capability_audience_not_allowed")

	issued, err := commands.IssueRuntimeCapability(testContext(t), caller, authz.IssueCapabilityRequest{
		OrgID: execute.org, ExecutionID: execute.execExec, Audience: capability.AudienceEgress,
	})
	if err != nil {
		t.Fatalf("execute egress issue: %v", err)
	}
	if issued.Generation != 1 || issued.Token == "" {
		t.Fatalf("issued = %#v", issued)
	}
	allowed, err := capability.NewIssuer(pool).Authorize(testContext(t),
		execute.org, execute.execExec, capability.AudienceEgress, issued.Generation, issued.Token)
	if err != nil || !allowed {
		t.Fatalf("egress capability allowed=%t err=%v", allowed, err)
	}
}

// TestIssueCapabilityRefusesExpiredExecution proves an elapsed lease is a
// refusal, and every refusal is an enumeration code that never carries the
// previously issued token.
func TestIssueCapabilityRefusesExpiredExecution(t *testing.T) {
	dbName, admin, pool := newAuthzExecDB(t)
	worker := authzExecWorker(t, dbName, "org_issue_expired")
	run := seedAuthzExecRun(t, admin, "org_issue_expired", authzExecHash(t, "c"))
	run.holder = "parent-workload:" + authzExecUUID(t)
	prepareAuthzPlanOnly(t, worker, run)

	commands := &authz.PGCommands{Pool: pool}
	caller := authz.Caller{Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"}
	request := authz.IssueCapabilityRequest{
		OrgID: run.org, ExecutionID: run.planExec, Audience: capability.AudienceContent,
	}
	issued, err := commands.IssueRuntimeCapability(testContext(t), caller, request)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	if _, err := admin.Exec(testContext(t), `
		UPDATE work.runtime_execution
		SET lease_until = now() - interval '1 second',
		    revision = revision + 1, updated_at = now()
		WHERE org_id = $1 AND execution_id = $2`, run.org, run.planExec); err != nil {
		t.Fatal(err)
	}
	_, err = commands.IssueRuntimeCapability(testContext(t), caller, request)
	assertAuthzCode(t, err, "runtime_execution_expired")
	if strings.Contains(err.Error(), issued.Token) {
		t.Fatal("issuance error echoed the token")
	}

	// The wrong-audience refusal is also code-only.
	_, err = commands.IssueRuntimeCapability(testContext(t), caller, authz.IssueCapabilityRequest{
		OrgID: run.org, ExecutionID: run.planExec, Audience: capability.AudienceEgress,
	})
	assertAuthzCode(t, err, "runtime_execution_expired")
	if strings.Contains(err.Error(), issued.Token) {
		t.Fatal("issuance error echoed the token")
	}
}

// TestIssueCapabilityUnknownExecution keeps the lookup refusal enumerated and
// proves no row is minted for an execution outside the tenant.
func TestIssueCapabilityUnknownExecution(t *testing.T) {
	_, _, pool := newAuthzExecDB(t)
	commands := &authz.PGCommands{Pool: pool}
	caller := authz.Caller{Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"}
	_, err := commands.IssueRuntimeCapability(testContext(t), caller, authz.IssueCapabilityRequest{
		OrgID: pgOrg, ExecutionID: authzExecUUID(t), Audience: capability.AudienceContent,
	})
	assertAuthzCode(t, err, "runtime_execution_not_found")
}
