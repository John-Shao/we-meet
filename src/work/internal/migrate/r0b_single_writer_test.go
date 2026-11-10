package migrate

import (
	"regexp"
	"testing"

	embedded "github.com/we-meet/work/migrations"
)

// J42 (card #50之二): access_restriction.state='released' must have a single writer.
// Before 0035 there were two: release_restriction (non-operator sources) and the batch
// UPDATE inside apply_execution_entitlement's ack branch. The funnel makes
// release_restriction the only UPDATE site; this guard pins that against the EFFECTIVE
// bodies in the tail catalog, not the raw chain text (0027's superseded body still
// contains the old batch UPDATE, so a grep of the files would count a dead writer).
var releasedUpdatePattern = regexp.MustCompile(`UPDATE work\.access_restriction\s+SET state = 'released'`)

func TestReleasedStateHasASingleWriterInCatalog(t *testing.T) {
	manifest, err := LoadManifest(embedded.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	var maxVersion int64
	for _, migration := range manifest.Increments {
		if migration.Version > maxVersion {
			maxVersion = migration.Version
		}
	}
	path, _, err := manifest.CatalogForVersion(maxVersion)
	if err != nil {
		t.Fatal(err)
	}
	catalog, _, err := LoadCatalog(embedded.FS, ".", path)
	if err != nil {
		t.Fatal(err)
	}
	// Anti-empty floor: a truncated or empty catalog must not pass as "one writer".
	if len(catalog.Functions) < 100 {
		t.Fatalf("catalog looks truncated: functions=%d, want >=100", len(catalog.Functions))
	}
	var writers []string
	for _, fn := range catalog.Functions {
		if releasedUpdatePattern.MatchString(fn.Definition) {
			writers = append(writers, fn.Name)
		}
	}
	if len(writers) != 1 || writers[0] != "release_restriction" {
		t.Fatalf("released-state UPDATE writers = %v, want exactly [release_restriction] (J42 single writer)", writers)
	}
}

// TestR0bOperatorReleaseFunnelsThroughSingleWriter pins the behavioral consequences of
// the funnel: the operator path releases through release_restriction (per-row audit keyed
// to the restriction id, no batch released_count carrier), the source gate keeps the
// command/projection path from releasing operator denys, and the callee proves the
// entitlement ack fact itself (host_ack must exceed the release floor, not merely exist).
func TestR0bOperatorReleaseFunnelsThroughSingleWriter(t *testing.T) {
	dbName, admin := newGateDB(t)
	ctx := testContext(t)
	org := "org_r0b_single_writer"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)
	ops := operatorSession(t, dbName, org, "ops_root")
	defer ops.Close(ctx)

	applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		suspended: true, revision: 1, requestID: "req-suspend",
	})
	applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-1",
		suspended: true, revision: 1, ack: int64(1), requestID: "req-ack-suspend",
	})
	rid := scalarString(t, admin, `SELECT id::text FROM work.access_restriction
		WHERE org_id = $1 AND source = 'operator' AND state = 'active'`, org)

	// Source gate: the default (command/projection) source cannot release an operator
	// deny; the operator source cannot either while host_ack (1) has not exceeded the
	// release floor (1). The callee reads the entitlement row itself to prove this.
	if got := scalarString(t, admin, `SELECT work.release_restriction($1,$2,NULL,NULL,$3)`,
		org, rid, "ops_root"); got != "restriction_not_releasable" {
		t.Fatalf("default-source release of operator deny = %q, want restriction_not_releasable", got)
	}
	if got := scalarString(t, admin, `SELECT work.release_restriction($1,$2,NULL,NULL,$3,'operator')`,
		org, rid, "ops_root"); got != "restriction_not_releasable" {
		t.Fatalf("operator-source release before ack exceeds floor = %q, want restriction_not_releasable", got)
	}

	applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-2",
		enabled: true, revision: 2, requestID: "req-restore",
	})
	restored := applyEntitlement(t, ops, entitlementCall{
		org: org, actor: "ops_root", ref: "TICKET-2",
		enabled: true, revision: 2, ack: int64(2), requestID: "req-ack-restore",
	})
	wantStr(t, restored, "outcome", "restored")
	wantInt(t, restored, "released_denials", 1)

	// Per-row audit carrier replaces the batch one: exactly one released audit keyed to
	// the restriction id, and zero audits carrying the old released_count batch key.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND action = 'access_restriction.released' AND target_id = $2
		  AND metadata->>'source' = 'operator' AND metadata->>'released_by_revision' = '2'`,
		org, rid); got != 1 {
		t.Fatalf("per-row released audit for restriction = %d, want 1", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.audit_event
		WHERE org_id = $1 AND action = 'access_restriction.released' AND metadata ? 'released_count'`,
		org); got != 0 {
		t.Fatalf("batch released_count audits = %d, want 0 (J42 removed the batch carrier)", got)
	}
	// Idempotent replay through the single writer (observed revision matches).
	if got := scalarString(t, admin, `SELECT work.release_restriction($1,$2,NULL,2,$3,'operator')`,
		org, rid, "ops_root"); got != "already_released" {
		t.Fatalf("re-release through single writer = %q, want already_released", got)
	}
}
