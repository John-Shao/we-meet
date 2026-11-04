package directory_test

// What actually turns Work execution on for a tenant, pinned at the database layer.
//
// host.Org carries no execution field (internal/host/orgs.go:33-40), so PGWriter.SyncOrg
// supplies the parameter itself - `org.Status == "active"` (internal/directory/writer.go:28-35) -
// which arrives at work.sync_org_projection as the required p_execution_enabled (NULL is
// refused: migrations/baseline/0002_initial_r0a_schema.sql:3850) and is written straight into
// work.org (:3867). So the column default never participates in this path, and an organization
// the Host reports as `active` becomes execution-enabled through the sync alone, with no
// separate granting step; suspending or archiving it takes that away, again via status.
//
// Recorded as a question, not answered here: this is the opposite of how the tenant-access
// switch is often described, and task #46 / C28 carry the decision. The test pins what the
// shipped code does so that changing it has to be an edit someone makes on purpose.
//
// The read-back uses the admin connection rather than the API pool on purpose: work.org grants
// SELECT to no workload role, so reading it as the pool fails with 42501 - that was the first
// version of this test's failure, not a problem with the rule it checks.

import (
	"context"
	"testing"

	"github.com/we-meet/work/internal/directory"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

func TestSyncOrgDerivesExecutionEnabledFromStatus(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	pool, _, dbName := newDirectoryDB(t)
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)

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
		var enabled bool
		if err := admin.QueryRow(ctx,
			`SELECT execution_enabled FROM work.org WHERE id = $1`, orgID).Scan(&enabled); err != nil {
			t.Fatalf("read back %s: %v", item.status, err)
		}
		if enabled != item.wantEnabled {
			t.Errorf("status %q -> execution_enabled = %v, want %v: the sync derives the flag from "+
				"status alone, so this is the rule that decides when a tenant may run (#46)",
				item.status, enabled, item.wantEnabled)
		}
	}
}
