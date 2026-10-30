package directory_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/directory"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

func TestMain(m *testing.M) {
	if testpg.AdminURL() == "" {
		os.Exit(m.Run())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err == nil {
		err = testpg.EnsureFixtures(ctx, admin)
		_ = admin.Close(ctx)
	}
	cancel()
	if err != nil {
		fmt.Fprintf(os.Stderr, "prepare test fixtures: %v\n", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func TestSyncWritesProjectionThroughDirectoryRole(t *testing.T) {
	pool, admin, _ := newDirectoryDB(t)
	ctx := testContext(t)
	discovery := &fakeDiscovery{
		orgs: []host.Org{{
			OrgID: "org_a", Name: "Acme", Status: "active", HomeRegion: "cn-north", Revision: 1,
		}},
		members: map[string][]host.Member{
			"org_a": {
				{SubjectID: "sub_owner", Status: "active", Role: "owner", WorkSeat: true, Revision: 1},
				{SubjectID: "sub_member", Status: "invited", Role: "member", WorkSeat: false, Revision: 1},
			},
		},
	}

	report, err := directory.Sync(ctx, discovery, &directory.PGWriter{Pool: pool}, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.Failed() || report.OrgsApplied != 1 || report.MembersApplied != 2 {
		t.Fatalf("report = %#v", report)
	}

	var name, status, homeRegion string
	var executionEnabled bool
	var revision int64
	if err := admin.QueryRow(ctx,
		`SELECT name, status, execution_enabled, home_region, revision FROM work.org WHERE id = 'org_a'`,
	).Scan(&name, &status, &executionEnabled, &homeRegion, &revision); err != nil {
		t.Fatal(err)
	}
	if name != "Acme" || status != "active" || !executionEnabled || homeRegion != "cn-north" || revision != 1 {
		t.Fatalf("org row = %q/%q/%t/%q/%d", name, status, executionEnabled, homeRegion, revision)
	}

	var memberStatus, memberRole string
	var workSeat bool
	if err := admin.QueryRow(ctx,
		`SELECT status, role, work_seat FROM work.member WHERE org_id = 'org_a' AND subject_id = 'sub_owner'`,
	).Scan(&memberStatus, &memberRole, &workSeat); err != nil {
		t.Fatal(err)
	}
	if memberStatus != "active" || memberRole != "owner" || !workSeat {
		t.Fatalf("member row = %q/%q/%t", memberStatus, memberRole, workSeat)
	}

	var audits int
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM work.audit_event WHERE org_id = 'org_a' AND action IN ('directory.org_synced', 'directory.member_synced')`,
	).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 3 {
		t.Fatalf("audit rows = %d", audits)
	}

	replay, err := directory.Sync(ctx, discovery, &directory.PGWriter{Pool: pool}, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if replay.Failed() || replay.OrgsStale != 1 || replay.MembersStale != 2 || replay.MembersApplied != 0 {
		t.Fatalf("replay report = %#v", replay)
	}
}

func TestSyncSeatRevocationLandsAsEntitlementLoss(t *testing.T) {
	pool, admin, _ := newDirectoryDB(t)
	ctx := testContext(t)
	writer := &directory.PGWriter{Pool: pool}
	org := host.Org{OrgID: "org_b", Name: "Beta", Status: "active", HomeRegion: "cn-east", Revision: 1}
	first := &fakeDiscovery{
		orgs: []host.Org{org},
		members: map[string][]host.Member{
			"org_b": {{SubjectID: "sub_1", Status: "active", Role: "owner", WorkSeat: true, Revision: 1}},
		},
	}
	if report, err := directory.Sync(ctx, first, writer, directory.Options{}); err != nil || report.Failed() {
		t.Fatalf("first sync = %#v, %v", report, err)
	}

	org.Revision = 2
	org.Status = "suspended"
	second := &fakeDiscovery{
		orgs: []host.Org{org},
		members: map[string][]host.Member{
			"org_b": {{SubjectID: "sub_1", Status: "left", Role: "member", WorkSeat: false, Revision: 2}},
		},
	}
	report, err := directory.Sync(ctx, second, writer, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.Failed() || report.MembersApplied != 1 {
		t.Fatalf("second sync = %#v", report)
	}

	var workSeat, executionEnabled bool
	var memberStatus string
	if err := admin.QueryRow(ctx,
		`SELECT work_seat, status FROM work.member WHERE org_id = 'org_b' AND subject_id = 'sub_1'`,
	).Scan(&workSeat, &memberStatus); err != nil {
		t.Fatal(err)
	}
	if workSeat || memberStatus != "left" {
		t.Fatalf("member = %t/%q", workSeat, memberStatus)
	}
	if err := admin.QueryRow(ctx,
		`SELECT execution_enabled FROM work.org WHERE id = 'org_b'`,
	).Scan(&executionEnabled); err != nil {
		t.Fatal(err)
	}
	if executionEnabled {
		t.Fatal("suspended organization still has execution enabled")
	}

	var lost bool
	if err := admin.QueryRow(ctx,
		`SELECT (metadata->>'entitlement_lost')::boolean FROM work.audit_event
		 WHERE org_id = 'org_b' AND action = 'directory.member_synced' AND metadata->>'revision' = '2'`,
	).Scan(&lost); err != nil {
		t.Fatal(err)
	}
	if !lost {
		t.Fatal("entitlement_lost was not recorded")
	}
}

func TestSyncFullMarksAbsentMembersAsLeft(t *testing.T) {
	pool, admin, _ := newDirectoryDB(t)
	ctx := testContext(t)
	writer := &directory.PGWriter{Pool: pool}
	first := &fakeDiscovery{
		orgs: []host.Org{{OrgID: "org_d", Name: "Delta", Status: "active", HomeRegion: "cn-north", Revision: 3}},
		members: map[string][]host.Member{
			"org_d": {
				{SubjectID: "sub_keep", Status: "active", Role: "owner", WorkSeat: true, Revision: 2},
				{SubjectID: "sub_drop", Status: "active", Role: "member", WorkSeat: true, Revision: 3},
			},
		},
	}
	if report, err := directory.Sync(ctx, first, writer, directory.Options{Full: true}); err != nil || report.Failed() {
		t.Fatalf("first sync = %#v, %v", report, err)
	}

	second := &fakeDiscovery{
		orgs: []host.Org{{OrgID: "org_d", Name: "Delta", Status: "active", HomeRegion: "cn-north", Revision: 4}},
		members: map[string][]host.Member{
			"org_d": {{SubjectID: "sub_keep", Status: "active", Role: "owner", WorkSeat: true, Revision: 4}},
		},
	}
	report, err := directory.Sync(ctx, second, writer, directory.Options{Full: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Failed() || report.MembersAbsent != 1 {
		t.Fatalf("second sync = %#v", report)
	}

	var status string
	var seat bool
	var revision int64
	if err := admin.QueryRow(ctx,
		`SELECT status, work_seat, revision FROM work.member WHERE org_id = 'org_d' AND subject_id = 'sub_drop'`,
	).Scan(&status, &seat, &revision); err != nil {
		t.Fatal(err)
	}
	if status != "left" || seat || revision != 4 {
		t.Fatalf("absent member = %q/%t/%d", status, seat, revision)
	}

	var lost, seatRevoked bool
	if err := admin.QueryRow(ctx,
		`SELECT (metadata->>'entitlement_lost')::boolean, (metadata->>'work_seat_revoked')::boolean
		   FROM work.audit_event
		  WHERE org_id = 'org_d' AND action = 'directory.member_absent' AND target_id = 'sub_drop'`,
	).Scan(&lost, &seatRevoked); err != nil {
		t.Fatal(err)
	}
	if !lost || !seatRevoked {
		t.Fatalf("absence audit = lost:%t seat_revoked:%t", lost, seatRevoked)
	}

	watermark, found, err := writer.Watermark(ctx, "org_d")
	if err != nil {
		t.Fatal(err)
	}
	if !found || watermark != 4 {
		t.Fatalf("watermark = %d/%t", watermark, found)
	}

	third := &fakeDiscovery{
		orgs:    []host.Org{{OrgID: "org_d", Name: "Delta", Status: "active", HomeRegion: "cn-north", Revision: 5}},
		members: map[string][]host.Member{"org_d": {}},
	}
	report, err = directory.Sync(ctx, third, writer, directory.Options{Full: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Failed() || report.MembersAbsent != 1 {
		t.Fatalf("empty snapshot = %#v", report)
	}
	if err := admin.QueryRow(ctx,
		`SELECT status, work_seat FROM work.member WHERE org_id = 'org_d' AND subject_id = 'sub_keep'`,
	).Scan(&status, &seat); err != nil {
		t.Fatal(err)
	}
	if status != "left" || seat {
		t.Fatalf("empty snapshot did not narrow sub_keep: %q/%t", status, seat)
	}
}

func TestMarkAbsentDoesNotOverrideNewerRevisions(t *testing.T) {
	pool, admin, _ := newDirectoryDB(t)
	ctx := testContext(t)
	writer := &directory.PGWriter{Pool: pool}
	first := &fakeDiscovery{
		orgs: []host.Org{{OrgID: "org_e", Name: "Epsilon", Status: "active", HomeRegion: "cn-north", Revision: 5}},
		members: map[string][]host.Member{
			"org_e": {{SubjectID: "sub_1", Status: "active", Role: "member", WorkSeat: true, Revision: 5}},
		},
	}
	if report, err := directory.Sync(ctx, first, writer, directory.Options{Full: true}); err != nil || report.Failed() {
		t.Fatalf("first sync = %#v, %v", report, err)
	}

	absent, err := writer.MarkAbsent(ctx, "org_e", []string{}, false, 5)
	if err != nil {
		t.Fatal(err)
	}
	if absent != 0 {
		t.Fatalf("equal-revision absence marked %d members", absent)
	}

	second := &fakeDiscovery{
		orgs: []host.Org{{OrgID: "org_e", Name: "Epsilon", Status: "active", HomeRegion: "cn-north", Revision: 6}},
		members: map[string][]host.Member{
			"org_e": {{SubjectID: "sub_1", Status: "active", Role: "member", WorkSeat: true, Revision: 6}},
		},
	}
	if report, err := directory.Sync(ctx, second, writer, directory.Options{Full: true}); err != nil || report.Failed() {
		t.Fatalf("second sync = %#v, %v", report, err)
	}

	absent, err = writer.MarkAbsent(ctx, "org_e", []string{}, false, 5)
	if err != nil {
		t.Fatal(err)
	}
	if absent != 0 {
		t.Fatalf("stale absence marked %d newer members", absent)
	}
	var status string
	var seat bool
	var revision int64
	if err := admin.QueryRow(ctx,
		`SELECT status, work_seat, revision FROM work.member WHERE org_id = 'org_e' AND subject_id = 'sub_1'`,
	).Scan(&status, &seat, &revision); err != nil {
		t.Fatal(err)
	}
	if status != "active" || !seat || revision != 6 {
		t.Fatalf("newer member was narrowed: %q/%t/%d", status, seat, revision)
	}
}

func TestMarkAbsentUsesSnapshotRevision(t *testing.T) {
	pool, admin, _ := newDirectoryDB(t)
	ctx := testContext(t)
	writer := &directory.PGWriter{Pool: pool}
	if _, err := admin.Exec(ctx, `
		INSERT INTO work.org (id, status, home_region, name, revision)
		VALUES ('org_snap', 'active', 'cn-north', 'Snapshot', 12);
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat, revision)
		VALUES ('org_snap', 'sub_new', 'active', 'member', true, 11);
	`); err != nil {
		t.Fatal(err)
	}

	absent, err := writer.MarkAbsent(ctx, "org_snap", []string{}, false, 11)
	if err != nil || absent != 0 {
		t.Fatalf("snapshot absence = %d, %v", absent, err)
	}
	var status string
	var revision int64
	if err := admin.QueryRow(ctx,
		`SELECT status, revision FROM work.member WHERE org_id = 'org_snap' AND subject_id = 'sub_new'`,
	).Scan(&status, &revision); err != nil {
		t.Fatal(err)
	}
	if status != "active" || revision != 11 {
		t.Fatalf("snapshot absence changed member: %q/%d", status, revision)
	}
}

func TestSyncRejectsRegressedHostRevisionWithoutChangingFacts(t *testing.T) {
	pool, admin, _ := newDirectoryDB(t)
	ctx := testContext(t)
	writer := &directory.PGWriter{Pool: pool}
	org := host.Org{OrgID: "org_c", Name: "Gamma", Status: "active", HomeRegion: "cn-north", Revision: 5}
	discovery := &fakeDiscovery{
		orgs: []host.Org{org},
		members: map[string][]host.Member{
			"org_c": {{SubjectID: "sub_1", Status: "active", Role: "owner", WorkSeat: true, Revision: 5}},
		},
	}
	if report, err := directory.Sync(ctx, discovery, writer, directory.Options{}); err != nil || report.Failed() {
		t.Fatalf("first sync = %#v, %v", report, err)
	}

	org.Status = "archived"
	org.Revision = 4
	member := discovery.members["org_c"][0]
	member.Status = "left"
	member.WorkSeat = false
	member.Revision = 4
	discovery.orgs = []host.Org{org}
	discovery.members["org_c"] = []host.Member{member}

	report, err := directory.Sync(ctx, discovery, writer, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.OrgsFailed != 1 || len(report.Errors) != 1 || report.Errors[0].Code != "host_revision_regressed" {
		t.Fatalf("report = %#v", report)
	}

	var status string
	var seat bool
	if err := admin.QueryRow(ctx, `SELECT status FROM work.org WHERE id = 'org_c'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx,
		`SELECT work_seat FROM work.member WHERE org_id = 'org_c' AND subject_id = 'sub_1'`,
	).Scan(&seat); err != nil {
		t.Fatal(err)
	}
	if status != "active" || !seat {
		t.Fatalf("regressed snapshot changed facts: org=%q seat=%t", status, seat)
	}
}

func TestDirectoryLoginCannotReadTablesDirectly(t *testing.T) {
	pool, _, _ := newDirectoryDB(t)
	ctx := testContext(t)

	var count int
	err := pool.QueryRow(ctx, `SELECT count(*) FROM work.member`).Scan(&count)

	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("error = %v, want insufficient_privilege", err)
	}
}

func TestDirectoryCommandsAreNotGrantedToApplicationRoles(t *testing.T) {
	_, _, dbName := newDirectoryDB(t)
	ctx := testContext(t)
	pool, err := workdb.OpenPool(ctx, testpg.AppURL(dbName), "work-api-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	for _, statement := range []string{
		`SELECT work.directory_watermark('org_a')`,
		`SELECT work.mark_members_absent('org_a', ARRAY[]::text[], false, 1)`,
	} {
		var value any
		err := pool.QueryRow(ctx, statement).Scan(&value)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
			t.Fatalf("%s: error = %v, want insufficient_privilege", statement, err)
		}
	}
}

func TestDirectorySyncHealthGate(t *testing.T) {
	pool, admin, dbName := newDirectoryDB(t)
	ctx := testContext(t)
	if _, err := admin.Exec(ctx, `
		INSERT INTO work.org (id, status, home_region, name)
		VALUES ('org_health', 'active', 'cn-north', 'Health');
	`); err != nil {
		t.Fatal(err)
	}
	writer := &directory.PGWriter{Pool: pool}
	if err := writer.RecordSync(ctx, "org_health", "full", true, 3, ""); err != nil {
		t.Fatal(err)
	}
	appPool, err := workdb.OpenPool(ctx, testpg.AppURL(dbName), "work-api-test")
	if err != nil {
		t.Fatal(err)
	}
	defer appPool.Close()
	fresh := func() bool {
		var value bool
		err := workdb.WithWorkContext(ctx, appPool,
			workdb.Identity{OrgID: "org_health", SubjectID: "sub_owner"}, workdb.RoleAPI,
			workdb.Options{ReadOnly: true}, func(tx pgx.Tx) error {
				return tx.QueryRow(ctx, `SELECT work.directory_sync_fresh('org_health', 900)`).Scan(&value)
			})
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	if !fresh() {
		t.Fatal("successful sync is not fresh")
	}
	if err := writer.RecordSync(ctx, "org_health", "incremental", false, 3, "host_unavailable"); err != nil {
		t.Fatal(err)
	}
	if fresh() {
		t.Fatal("failed sync is still fresh")
	}
	if err := writer.RecordSync(ctx, "org_health", "incremental", true, 4, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		UPDATE work.directory_sync_state
		SET last_success_at = now() - interval '1 hour'
		WHERE org_id = 'org_health'`,
	); err != nil {
		t.Fatal(err)
	}
	if fresh() {
		t.Fatal("aged sync is still fresh")
	}
}

func TestDirectoryHealthRequiresTenantContext(t *testing.T) {
	pool, admin, dbName := newDirectoryDB(t)
	ctx := testContext(t)
	writer := &directory.PGWriter{Pool: pool}
	if err := writer.RecordSync(ctx, "org_health", "full", true, 3, ""); err != nil {
		t.Fatal(err)
	}
	appPool, err := workdb.OpenPool(ctx, testpg.AppURL(dbName), "work-api-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(appPool.Close)
	var fresh bool
	err = appPool.QueryRow(ctx, `SELECT work.directory_sync_fresh('org_health', 900)`).Scan(&fresh)
	assertPgCode(t, err, "P0001", "directory_org_context_mismatch")
	err = workdb.WithWorkContext(ctx, appPool,
		workdb.Identity{OrgID: "org_other", SubjectID: "sub_owner"}, workdb.RoleAPI,
		workdb.Options{ReadOnly: true}, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT work.directory_sync_fresh('org_health', 900)`).Scan(&fresh)
		})
	assertPgCode(t, err, "P0001", "directory_org_context_mismatch")
	err = workdb.WithDirectoryContext(ctx, pool, "org_other", workdb.Options{}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT work.record_directory_sync('org_health', 'full', false, 4, 'failed')`)
		return err
	})
	assertPgCode(t, err, "P0001", "directory_org_context_mismatch")

	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE work_owner; SELECT set_config('app.org_id', 'org_other', true)`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM work.directory_sync_state WHERE org_id = 'org_health'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("owner read %d foreign health rows", count)
	}
	_, err = tx.Exec(ctx, `INSERT INTO work.directory_sync_state (org_id, last_attempt_at, last_mode) VALUES ('org_foreign', now(), 'full')`)
	assertPgCode(t, err, "42501", "row-level security")
}

func TestDirectoryAbsenceLegacySignatureRemoved(t *testing.T) {
	_, admin, _ := newDirectoryDB(t)
	ctx := testContext(t)
	var removed bool
	if err := admin.QueryRow(ctx, `SELECT to_regprocedure('work.mark_members_absent(text,text[],boolean)') IS NULL`).Scan(&removed); err != nil {
		t.Fatal(err)
	}
	if !removed {
		t.Fatal("legacy absence command remains callable")
	}
}

func TestProvisionFunctionsAreNotPublic(t *testing.T) {
	_, _, dbName := newDirectoryDB(t)
	ctx := testContext(t)
	pool, err := workdb.OpenPool(ctx, testpg.AppURL(dbName), "work-api-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	var value any
	err = pool.QueryRow(ctx, `SELECT work.provision_org_defaults('org_a')`).Scan(&value)
	assertPgCode(t, err, "42501", "")
	err = pool.QueryRow(ctx,
		`SELECT work.ensure_quota_account('org_a', 'default', '2026-10', 1000000, 'soft')`,
	).Scan(&value)
	assertPgCode(t, err, "42501", "")
}

func TestSyncPreservesOperatorSuspended(t *testing.T) {
	pool, admin, _ := newDirectoryDB(t)
	ctx := testContext(t)
	writer := &directory.PGWriter{Pool: pool}
	org := host.Org{OrgID: "org_os", Name: "Operator Suspended", Status: "active", HomeRegion: "cn-north", Revision: 1}
	if err := writer.SyncOrg(ctx, org); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx,
		`UPDATE work.org SET operator_suspended = true WHERE id = 'org_os'`,
	); err != nil {
		t.Fatal(err)
	}
	org.Revision = 2
	if err := writer.SyncOrg(ctx, org); err != nil {
		t.Fatal(err)
	}
	var suspended bool
	if err := admin.QueryRow(ctx,
		`SELECT operator_suspended FROM work.org WHERE id = 'org_os'`,
	).Scan(&suspended); err != nil {
		t.Fatal(err)
	}
	if !suspended {
		t.Fatal("directory sync cleared operator_suspended")
	}
}

func TestDirectoryCommandsRejectCrossTenantContext(t *testing.T) {
	pool, _, _ := newDirectoryDB(t)
	ctx := testContext(t)

	err := workdb.WithDirectoryContext(ctx, pool, "org_a", workdb.Options{}, func(tx pgx.Tx) error {
		var watermark *int64
		return tx.QueryRow(ctx, `SELECT work.directory_watermark('org_b')`).Scan(&watermark)
	})
	assertPgCode(t, err, "P0001", "directory_org_context_mismatch")

	err = workdb.WithDirectoryContext(ctx, pool, "org_a", workdb.Options{}, func(tx pgx.Tx) error {
		var affected int
		return tx.QueryRow(ctx, `SELECT work.mark_members_absent('org_b', ARRAY[]::text[], false, 1)`).Scan(&affected)
	})
	assertPgCode(t, err, "P0001", "directory_org_context_mismatch")
}

func TestMarkAbsentRejectsOversizedSnapshot(t *testing.T) {
	pool, _, _ := newDirectoryDB(t)
	ctx := testContext(t)
	present := make([]string, 10001)
	for index := range present {
		present[index] = fmt.Sprintf("sub_%d", index)
	}

	err := workdb.WithDirectoryContext(ctx, pool, "org_cap", workdb.Options{}, func(tx pgx.Tx) error {
		var affected int
		return tx.QueryRow(ctx,
			`SELECT work.mark_members_absent($1, $2, false, 1)`, "org_cap", present,
		).Scan(&affected)
	})
	assertPgCode(t, err, "22023", "invalid_request:present_subjects")
}

func TestMassAbsenceRequiresExplicitAllow(t *testing.T) {
	pool, admin, _ := newDirectoryDB(t)
	ctx := testContext(t)
	writer := &directory.PGWriter{Pool: pool}
	members := make([]host.Member, 0, 11)
	for revision := 2; revision <= 12; revision++ {
		members = append(members, host.Member{
			SubjectID: fmt.Sprintf("sub_%d", revision),
			Status:    "active",
			Role:      "member",
			Revision:  int64(revision),
		})
	}
	discovery := &fakeDiscovery{
		orgs:    []host.Org{{OrgID: "org_mass", Name: "Mass", Status: "active", HomeRegion: "cn-north", Revision: 13}},
		members: map[string][]host.Member{"org_mass": members},
	}
	if report, err := directory.Sync(ctx, discovery, writer, directory.Options{Full: true}); err != nil || report.Failed() {
		t.Fatalf("initial sync = %#v, %v", report, err)
	}

	absent, err := writer.MarkAbsent(ctx, "org_mass", []string{}, false, 13)
	if !errors.Is(err, directory.ErrMassAbsenceBlocked) || absent != 0 {
		t.Fatalf("blocked absence = %d, %v", absent, err)
	}
	var active int
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM work.member WHERE org_id = 'org_mass' AND status = 'active'`,
	).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 11 {
		t.Fatalf("blocked absence changed %d members", 11-active)
	}
	var blocked int
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM work.audit_event
		  WHERE org_id = 'org_mass' AND action = 'directory.member_absence_blocked'`,
	).Scan(&blocked); err != nil {
		t.Fatal(err)
	}
	if blocked != 1 {
		t.Fatalf("blocked audits = %d", blocked)
	}

	absent, err = writer.MarkAbsent(ctx, "org_mass", []string{}, true, 13)
	if err != nil || absent != 11 {
		t.Fatalf("allowed absence = %d, %v", absent, err)
	}
	var left int
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM work.member WHERE org_id = 'org_mass' AND status = 'left'`,
	).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 11 {
		t.Fatalf("left members = %d", left)
	}
	var allowed bool
	if err := admin.QueryRow(ctx,
		`SELECT (metadata->>'allow_mass_absence')::boolean FROM work.audit_event
		  WHERE org_id = 'org_mass' AND action = 'directory.member_absence_applied'`,
	).Scan(&allowed); err != nil {
		t.Fatal(err)
	}
	if !allowed {
		t.Fatal("allowed absence was not audited as such")
	}
}

func assertPgCode(t *testing.T, err error, code, message string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != code || !strings.Contains(pgErr.Message, message) {
		t.Fatalf("error = %v, want %s/%s", err, code, message)
	}
}

func newDirectoryDB(t *testing.T) (*pgxpool.Pool, *pgx.Conn, string) {

	t.Helper()
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx := testContext(t)
	root, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, root, "work_directory_test")
	_ = root.Close(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cleanupAdmin, err := testpg.Open(cleanupCtx, testpg.AdminURL())
		if err == nil {
			_ = testpg.DropDatabase(cleanupCtx, cleanupAdmin, dbName)
			_ = cleanupAdmin.Close(cleanupCtx)
		}
	})

	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })

	pool, err := workdb.OpenPool(ctx, testpg.DirectoryURL(dbName), "work-directory-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, admin, dbName
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}
