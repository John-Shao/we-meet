package directory_test

// What actually turns Work execution on for a tenant, pinned at the database layer.
//
// host.Org carries no execution field (internal/host/orgs.go:33-40), so PGWriter.SyncOrg
// supplies the SQL parameter itself: `org.Status == "active"` (internal/directory/writer.go:28-35)
// -> work.sync_org_projection's p_execution_enabled, which refuses NULL and writes the value
// straight into work.org (baseline/0002:3850, :3867). The consequence is worth stating plainly
// because it is the opposite of how the tenant-access switch is sometimes described: the
// column default never participates in this path, and an organization the Host reports as
// `active` becomes execution-enabled by the sync alone, with no separate granting step.
// Suspending or archiving it revokes that, also via status.
//
// This test does not decide whether that rule is right for the pilot - it is recorded as a
// question in docs/plan/work-r0a-d2-prime-freeze-divergences-2026-11-04.md and C28 - it pins
// what the shipped code does today, so a change to it is an edit someone has to make on purpose.

import (
	"testing"

	"github.com/we-meet/work/internal/directory"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

func TestSyncOrgDerivesExecutionEnabledFromStatus(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	pool, _, _ := newDirectoryDB(t)
	ctx := testContext(t)
	writer := &directory.PGWriter{Pool: pool}

	cases := []struct {
		status      string
		suffix      string
		wantEnabled bool
	}{
		{status: "active", suffix: "act", wantEnabled: true},
		{status: "suspended", suffix: "sus", wantEnabled: false},
		{status: "archived", suffix: "arc", wantEnabled: false},
	}
	for _, item := range cases {
		orgID := "org_exec_" + item.suffix
		if err := writer.SyncOrg(ctx, host.Org{
			OrgID: orgID, Name: "Exec " + item.suffix, Status: item.status,
			HomeRegion: "cn-north", Revision: 1,
		}); err != nil {
			t.Fatalf("sync %s: %v", item.status, err)
		}
		// One connection for both statements: a pooled query pair can land on different
		// sessions, and then the second one would read work.org under no app.org_id.
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatalf("acquire for %s: %v", item.status, err)
		}
		var ignored string
		if err := conn.QueryRow(ctx,
			`SELECT set_config('app.org_id', $1, false)`, orgID).Scan(&ignored); err != nil {
			conn.Release()
			t.Fatalf("set app.org_id for %s: %v", item.status, err)
		}
		var enabled bool
		err = conn.QueryRow(ctx,
			`SELECT execution_enabled FROM work.org WHERE id = $1`, orgID).Scan(&enabled)
		conn.Release()
		if err != nil {
			t.Fatalf("read back %s: %v", item.status, err)
		}
		if enabled != item.wantEnabled {
			t.Errorf("status %q -> execution_enabled = %v, want %v; the sync derives the flag "+
				"from status alone, so this is the rule that decides when a tenant may run",
				item.status, enabled, item.wantEnabled)
		}
	}
}
