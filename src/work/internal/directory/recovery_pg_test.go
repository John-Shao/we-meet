package directory_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/directory"
	"github.com/we-meet/work/internal/host"
)

// Recovery is the half of control §3.4 that R0a never had: after a service provider
// reactivates an organization, or a user returns, the sync must release the denies the
// projection itself created - and nothing else. This runs through the real writer and
// the real directory role, so it also proves the grant on apply_directory_recovery is
// held by the identity that actually calls it.

func syncOnce(t *testing.T, pool *pgxpool.Pool, org host.Org, members []host.Member) directory.Report {
	t.Helper()
	discovery := &fakeDiscovery{orgs: []host.Org{org}}
	key := org.OrgID
	if members == nil {
		members = []host.Member{}
	}
	discovery.members = map[string][]host.Member{key: members}
	report, err := directory.Sync(testContext(t), discovery, &directory.PGWriter{Pool: pool}, directory.Options{})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if report.Failed() {
		t.Fatalf("sync report = %#v", report)
	}
	return report
}

func TestSyncRecoveryReleasesOnlyProjectionDenys(t *testing.T) {
	pool, admin, _ := newDirectoryDB(t)
	ctx := testContext(t)

	syncOnce(t, pool,
		host.Org{OrgID: "org_r", Name: "Recovery", Status: "active", HomeRegion: "cn-north", Revision: 1},
		[]host.Member{{SubjectID: "sub_a", Status: "active", Role: "member", WorkSeat: true, Revision: 1}})

	if got := denyCount(t, admin, ctx, "org_r", "host_org", "active"); got != 0 {
		t.Fatalf("active org denys = %d, want 0", got)
	}

	// Suspension and member removal, observed together the way sync actually sees
	// them: three denys, one per source.
	syncOnce(t, pool,
		host.Org{OrgID: "org_r", Name: "Recovery", Status: "suspended", HomeRegion: "cn-north", Revision: 2},
		[]host.Member{{SubjectID: "sub_a", Status: "suspended", Role: "member", WorkSeat: false, Revision: 2}})
	for source, want := range map[string]int{"host_org": 1, "host_member": 1, "host_seat": 1} {
		if got := denyCount(t, admin, ctx, "org_r", source, "active"); got != want {
			t.Fatalf("%s denys = %d, want %d", source, got, want)
		}
	}
	if got := counter(t, admin, ctx, `SELECT access_epoch FROM work.org WHERE id = 'org_r'`); got < 3 {
		t.Fatalf("access_epoch = %d, want at least 3 (one bump per deny)", got)
	}

	// The organization and the person come back, but the seat does not. Only the two
	// projection denys may be released: a seat deny survives until a granting command
	// event arrives, or Host row edits would silently restore access Work revoked.
	syncOnce(t, pool,
		host.Org{OrgID: "org_r", Name: "Recovery", Status: "active", HomeRegion: "cn-north", Revision: 3},
		[]host.Member{{SubjectID: "sub_a", Status: "active", Role: "member", WorkSeat: false, Revision: 4}})

	for source, want := range map[string]int{"host_org": 0, "host_member": 0, "host_seat": 1} {
		if got := denyCount(t, admin, ctx, "org_r", source, "active"); got != want {
			t.Fatalf("%s active denys after recovery = %d, want %d", source, got, want)
		}
	}
	if got := counter(t, admin, ctx, `SELECT count(*) FROM work.audit_event
		WHERE org_id = 'org_r' AND action = 'access_restriction.released'
		  AND actor_subject_id = 'work_directory_sync'`); got != 2 {
		t.Fatalf("release audit rows = %d, want 2", got)
	}
	// The released rows must say which observation released them, so an auditor can
	// re-derive the decision instead of trusting the current state.
	if got := counter(t, admin, ctx, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = 'org_r' AND source IN ('host_org','host_member')
		  AND state = 'released' AND released_by_revision IS NOT NULL`); got != 2 {
		t.Fatalf("released rows with a releasing revision = %d, want 2", got)
	}

	// A replay of the same active snapshot must not release the seat deny either.
	syncOnce(t, pool,
		host.Org{OrgID: "org_r", Name: "Recovery", Status: "active", HomeRegion: "cn-north", Revision: 3},
		[]host.Member{{SubjectID: "sub_a", Status: "active", Role: "member", WorkSeat: false, Revision: 4}})
	if got := denyCount(t, admin, ctx, "org_r", "host_seat", "active"); got != 1 {
		t.Fatalf("seat denys after a replay = %d, want still 1", got)
	}
}

func denyCount(t *testing.T, admin *pgx.Conn, ctx context.Context, org, source, state string) int {
	t.Helper()
	var count int
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM work.access_restriction
		  WHERE org_id = $1 AND source = $2 AND state = $3`,
		org, source, state).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func counter(t *testing.T, admin *pgx.Conn, ctx context.Context, sql string) int64 {
	t.Helper()
	var value int64
	if err := admin.QueryRow(ctx, sql).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
