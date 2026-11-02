package migrate

import (
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for increment 0020: local_execution_policy, set_local_policy and the gate
// that decides whether an organization may open a local face at all.
//
// These cover the J20 precondition (a configured mapping, or nothing is offered),
// the J37 second branch (a mapping that leaves no destination reachable), the
// revision CAS behind EV123, and the closed sets in control §4.1 that every local
// gate reads.

// policyDoc builds the closed document set_local_policy demands. Overrides change
// exactly one field and leave the rest valid, so a rejection can only have come from
// the field under test; a nil override removes the field entirely.
func policyDoc(overrides map[string]any) string {
	base := map[string]any{
		"allowed_tools":                    []string{"workspace.read"},
		"allowed_destinations":             []string{"device_local"},
		"classification_rules":             []any{ruleDoc("docs", "local_only", "local_only")},
		"classification_default":           "local_only",
		"classification_default_confirmed": true,
		"classification_floor":             "local_only",
		"readonly_max_actions":             3,
		"readonly_ttl":                     "1 hour",
		"input_limit_bytes":                262144,
		"output_limit_bytes":               262144,
	}
	for key, value := range overrides {
		if value == nil {
			delete(base, key)
			continue
		}
		base[key] = value
	}
	body, err := json.Marshal(base)
	if err != nil {
		panic(err)
	}
	return string(body)
}

func ruleDoc(prefix, classification, ceiling string) map[string]any {
	return map[string]any{
		"matcher":         map[string]any{"path_prefix": prefix},
		"classification":  classification,
		"max_confirmable": ceiling,
	}
}

func setPolicy(t *testing.T, admin *pgx.Conn, org string, expectedRevision int, doc string, requestID string) (int, int) {
	t.Helper()
	var body []byte
	if err := admin.QueryRow(testContext(t),
		`SELECT work.set_local_policy($1, $2, $3::jsonb, $4, $5)`,
		org, expectedRevision, doc, r0bAdminSubject(org), requestID).Scan(&body); err != nil {
		t.Fatalf("set_local_policy: %v", err)
	}
	var payload struct {
		Revision       int `json:"revision"`
		EffectiveEpoch int `json:"effective_epoch"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Revision, payload.EffectiveEpoch
}

func policyGate(t *testing.T, admin *pgx.Conn, org string) string {
	t.Helper()
	var gate string
	if err := admin.QueryRow(testContext(t),
		`SELECT work.local_policy_gate($1)`, org).Scan(&gate); err != nil {
		t.Fatal(err)
	}
	return gate
}

func TestR0bLocalPolicyGateHasTwoDistinctBranches(t *testing.T) {
	_, admin := newGateDB(t)
	org := "org_r0b_policy_gate"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	// No row at all: §1.4's pairing and grant endpoints answer local_policy_not_configured
	// instead of opening a face that cannot work.
	if got := policyGate(t, admin, org); got != "local_policy_not_configured" {
		t.Fatalf("gate without a policy row = %q", got)
	}

	// A row nobody finished. A NOT NULL DEFAULT cannot tell "the administrator chose
	// local_only" from "nobody ever looked", so confirmation is its own fact.
	revision, epoch := setPolicy(t, admin, org, 0, policyDoc(map[string]any{
		"classification_rules":             []any{},
		"classification_default_confirmed": false,
	}), "req-unconfirmed")
	if revision != 1 || epoch != 1 {
		t.Fatalf("first write revision/epoch = %d/%d, want 1/1", revision, epoch)
	}
	if got := policyGate(t, admin, org); got != "local_policy_not_configured" {
		t.Fatalf("gate with no rules and an unconfirmed default = %q", got)
	}

	// J37's second branch: one rule plus a confirmed default satisfies "configured",
	// yet with no destination allowed the organization is unusable, and the answer has
	// to be the other code rather than a silently broken ready.
	revision, _ = setPolicy(t, admin, org, revision,
		policyDoc(map[string]any{"allowed_destinations": []string{}}), "req-no-destination")
	if got := policyGate(t, admin, org); got != "local_policy_incomplete" {
		t.Fatalf("gate with no reachable destination = %q, want local_policy_incomplete", got)
	}

	// device_local alone is enough: §8.4 gates org_private/org_remote elsewhere, and
	// J14/J15 do not require any remote destination this period.
	revision, epoch = setPolicy(t, admin, org, revision, policyDoc(map[string]any{
		"allowed_destinations": []string{"device_local"},
	}), "req-ready")
	if got := policyGate(t, admin, org); got != "ready" {
		t.Fatalf("gate after a usable configuration = %q, want ready", got)
	}
	// This row is also the increment's known divergence, pinned here on purpose: every
	// rule classifies `local_only`, which is the first term of §9's
	// local_policy_incomplete conjunction - and the answer is still `ready`, because the
	// second term ("no published device_local/org_private profile") has no table until
	// ModelProfile lands with I4/I5. A conjunction cannot be enforced on whichever term
	// happens to be checkable. When I4 adds the profile read it must also turn this
	// assertion into the refusal §9 describes; that edit is the close-out, and this
	// comment is where the debt is registered.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.local_execution_policy p,
		jsonb_array_elements(p.classification_rules) rule_row
		WHERE p.org_id = $1 AND rule_row ->> 'classification' = 'remote_excerpt_allowed'`,
		org); got != 0 {
		t.Fatalf("rules producing a remote-eligible classification = %d, want 0: this test pins the unenforced J37 term", got)
	}
	if epoch != 3 || revision != 3 {
		t.Fatalf("revision/epoch after three writes = %d/%d, want 3/3", revision, epoch)
	}
	// The epoch, not the revision, is what remembered readonly grants compare against
	// (§4.1 readonly_approval_grant.access_epoch / policy_epoch).
	if got := scalarCount(t, admin,
		`SELECT effective_epoch FROM work.local_execution_policy WHERE org_id = $1`, org); got != 3 {
		t.Fatalf("effective_epoch = %d, want 3", got)
	}
}

func TestR0bSetLocalPolicyClosesTheRoundTrips(t *testing.T) {
	_, admin := newGateDB(t)
	org := "org_r0b_policy_cas"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	revision, _ := setPolicy(t, admin, org, 0, policyDoc(nil), "req-first")

	// A stale revision is refused with the code §9 defines, and the row is unchanged.
	if _, err := admin.Exec(testContext(t),
		`SELECT work.set_local_policy($1, $2, $3::jsonb, $4, $5)`,
		org, revision-1, policyDoc(nil), r0bAdminSubject(org), "req-stale"); err == nil {
		t.Fatal("a stale revision was accepted")
	} else {
		assertPgMessage(t, err, "governance_revision_conflict")
	}
	if got := policyGate(t, admin, org); got != "ready" {
		t.Fatalf("gate after a refused write = %q", got)
	}
	if got := scalarCount(t, admin,
		`SELECT revision FROM work.local_execution_policy WHERE org_id = $1`, org); got != revision {
		t.Fatalf("revision moved by a refused write: %d", got)
	}

	// Confirmation is one-way: un-confirming would reopen the very check the gate
	// depends on by editing the field it reads.
	if _, err := admin.Exec(testContext(t),
		`SELECT work.set_local_policy($1, $2, $3::jsonb, $4, $5)`, org, revision,
		policyDoc(map[string]any{"classification_default_confirmed": false}),
		r0bAdminSubject(org), "req-unconfirm"); err == nil {
		t.Fatal("an explicit confirmation was revoked")
	}

	// Closed sets are enforced at the row, not only in the command: the same values
	// could arrive from a restored dump or a future migration.
	duplicate := []string{"workspace.read", "workspace.read"}
	for name, doc := range map[string]string{
		"unknown tool":        policyDoc(map[string]any{"allowed_tools": []string{"shell.exec"}}),
		"unknown destination": policyDoc(map[string]any{"allowed_destinations": []string{"external_sandbox"}}),
		"duplicate member":    policyDoc(map[string]any{"allowed_tools": duplicate}),
		"empty matcher": policyDoc(map[string]any{"classification_rules": []any{map[string]any{
			"matcher": map[string]any{}, "classification": "local_only",
			"max_confirmable": "local_only"}}}),
		// The ceiling may be stricter than the determination, never looser: users
		// confirm stricter and cannot relax (§4.1 classification row).
		"ceiling relaxes": policyDoc(map[string]any{"classification_rules": []any{
			ruleDoc("docs", "local_only", "remote_excerpt_allowed")}}),
		// A rule may not determine a class looser than the organization floor.
		"rule undercuts floor": policyDoc(map[string]any{
			"classification_rules": []any{ruleDoc("docs", "remote_excerpt_allowed", "remote_excerpt_allowed")}}),
		// A missing bound is a rejection, not a default: "absent" must never mean
		// "most permissive".
		"missing bound": policyDoc(map[string]any{"input_limit_bytes": nil}),
	} {
		if _, err := admin.Exec(testContext(t),
			`SELECT work.set_local_policy($1, $2, $3::jsonb, $4, $5)`,
			org, revision, doc, r0bAdminSubject(org), "req-"+name); err == nil {
			t.Fatalf("rejected case accepted (%s): %s", name, doc)
		}
	}

	// The write is auditable on its own: the row carries the whole after-image plus
	// the verdict it produced, which is what answers "why could this organization open
	// a device face at this moment".
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND action = 'local_policy.set'
		  AND metadata ? 'after' AND metadata ->> 'gate' = 'ready'`, org); got != 1 {
		t.Fatalf("local_policy.set audit rows = %d, want 1", got)
	}
}

func TestR0bLocalPolicyGrantsAreExactlyTheTwoFaces(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_policy_grants"
	seedRun(t, admin, org)
	ctx := testContext(t)

	api := connect(t, appURL(dbName))
	defer api.Close(ctx)
	adminSubject := r0bAdminSubject(org)
	if _, err := api.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)+
		"; SET app.subject_id = "+quoteLiteral(adminSubject)); err != nil {
		t.Fatal(err)
	}
	// The administrator face writes and reads...
	if _, err := api.Exec(ctx,
		`SELECT work.set_local_policy($1, 0, $2::jsonb, $3, $4)`,
		org, policyDoc(nil), adminSubject, "req-api"); err != nil {
		t.Fatalf("the administrator face cannot write the local policy: %v", err)
	}
	var view []byte
	if err := api.QueryRow(ctx, `SELECT work.get_local_policy($1, $2)`,
		org, adminSubject).Scan(&view); err != nil {
		t.Fatalf("the administrator face cannot read the local policy: %v", err)
	}
	// ...and neither face is open to a member who is not an administrator. This is the
	// assertion the endpoint needs before it exists: work_api already held EXECUTE on
	// both commands, so without the admin gate inside the command any active member of
	// the organization could rewrite the policy that decides whether local actions leave
	// their device, and name whichever actor they liked in the audit.
	member := "sub_plain_member"
	if _, err := admin.Exec(ctx, `INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ($1, $2, 'active', 'member', false)`, org, member); err != nil {
		t.Fatal(err)
	}
	if _, err := api.Exec(ctx, "SET app.subject_id = "+quoteLiteral(member)+
		"; SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}
	if _, err := api.Exec(ctx,
		`SELECT work.set_local_policy($1, 1, $2::jsonb, $3, $4)`,
		org, policyDoc(nil), member, "req-nonadmin"); err == nil {
		t.Fatal("a plain member wrote the local policy")
	} else {
		assertPgMessage(t, err, "admin_access_denied")
	}
	// The other half of the same guard: an administrator's *session* cannot act as somebody
	// else. assert_session_subject compares the command's actor against app.subject_id, so
	// the audit names the caller rather than a free-text name chosen at call time.
	if _, err := api.Exec(ctx,
		"SET app.subject_id = "+quoteLiteral(adminSubject)); err != nil {
		t.Fatal(err)
	}
	if err := api.QueryRow(ctx, `SELECT work.get_local_policy($1, $2)`,
		org, member).Scan(&view); err == nil {
		t.Fatal("a plain member read the local policy through the admin face")
	} else {
		assertPgMessage(t, err, "actor_mismatch")
	}
	// ...and §1.4's response shape is this table's columns, so the TTL field must be
	// named exactly as §4.1 spells it rather than a second name for one thing.
	if !json.Valid(view) || len(view) == 0 {
		t.Fatalf("get_local_policy returned an unreadable document: %q", view)
	}
	var doc map[string]any
	if err := json.Unmarshal(view, &doc); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"readonly_ttl", "readonly_max_actions", "allowed_tools",
		"allowed_destinations", "classification_rules", "classification_default",
		"classification_default_confirmed", "classification_floor", "input_limit_bytes",
		"output_limit_bytes", "effective_epoch", "revision", "gate", "configured"} {
		if _, ok := doc[column]; !ok {
			t.Fatalf("the local-policy response is missing %q; §1.4 pins it to the column names", column)
		}
	}
	if _, err := api.Exec(ctx, `INSERT INTO work.local_execution_policy (org_id, readonly_max_actions, readonly_ttl, input_limit_bytes, output_limit_bytes) VALUES ($1, 1, '1 hour', 10, 10)`, org); err == nil {
		t.Fatal("the administrator face has direct DML on the policy table")
	}

	// The worker may evaluate the gate because prepare_local_operation and
	// consume_device_permit must agree with the pairing endpoints, but it may not write
	// the policy it reads.
	worker := connect(t, testpg.WorkerURL(dbName))
	defer worker.Close(ctx)
	if _, err := worker.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}
	var gate string
	if err := worker.QueryRow(ctx, `SELECT work.local_policy_gate($1)`, org).Scan(&gate); err != nil {
		t.Fatalf("the worker cannot evaluate the gate: %v", err)
	}
	if _, err := worker.Exec(ctx,
		`SELECT work.set_local_policy($1, 9, $2::jsonb, $3, $4)`,
		org, policyDoc(nil), "worker", "req-worker"); err == nil {
		t.Fatal("the worker can write the local policy")
	}

	// The governance puller has no business with either face.
	puller := connect(t, testpg.GovernanceURL(dbName))
	defer puller.Close(ctx)
	if _, err := puller.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}
	_, err := puller.Exec(ctx, `SELECT work.local_policy_gate($1)`, org)
	assertPermissionDenied(t, err)

	var count int
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM work.local_execution_policy`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("policy rows = %d, want exactly one current row per organization", count)
	}
}
