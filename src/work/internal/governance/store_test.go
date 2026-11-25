package governance_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/governance"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

func TestPGStoreInitializesAndConsumesWithoutProjectionWrites(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is required")
	}
	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "governance_puller")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = testpg.DropDatabase(ctx, admin, dbName) }()
	dbAdmin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer dbAdmin.Close(ctx)
	const orgID = "org_governance_puller"
	if _, err := dbAdmin.Exec(ctx,
		`INSERT INTO work.org (id, status, home_region) VALUES ($1, 'active', 'cn-north')`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := dbAdmin.Exec(ctx,
		`INSERT INTO work.member (org_id, subject_id, status, role, work_seat, revision)
		 VALUES ($1, 'sub_a', 'active', 'member', false, 0)`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := dbAdmin.Exec(ctx,
		`INSERT INTO work.access_restriction
		   (org_id, scope, subject_id, source, reason, epoch, host_revision, release_floor_revision)
		 VALUES ($1, 'member', 'sub_a', 'host_seat', 'seat_dropped', 1, 0, 0)`, orgID); err != nil {
		t.Fatal(err)
	}
	pool, err := workdb.OpenPool(ctx, testpg.GovernanceURL(dbName), "governance-store-test")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store := &governance.PGStore{Pool: pool}

	if current, exists, err := store.Cursor(ctx, orgID); err != nil || exists || current != 0 {
		t.Fatalf("initial cursor = %d/%v/%v", current, exists, err)
	}
	latest := int64(5)
	initialized, err := store.Consume(ctx, orgID, nil, nil, &latest)
	if err != nil {
		t.Fatal(err)
	}
	if initialized.LastEventSeq != 5 {
		t.Fatalf("initialized = %#v", initialized)
	}
	var cursor int64
	if err := dbAdmin.QueryRow(ctx,
		`SELECT last_event_seq FROM work.governance_event_cursor WHERE org_id = $1`, orgID).Scan(&cursor); err != nil {
		t.Fatal(err)
	}
	if cursor != 5 {
		t.Fatalf("cursor = %d, want 5", cursor)
	}
	if current, exists, err := store.Cursor(ctx, orgID); err != nil || !exists || current != 5 {
		t.Fatalf("initialized cursor = %d/%v/%v", current, exists, err)
	}
	var auditsBefore int
	if err := dbAdmin.QueryRow(ctx,
		`SELECT count(*) FROM work.audit_event WHERE org_id = $1`, orgID).Scan(&auditsBefore); err != nil {
		t.Fatal(err)
	}
	if _, exists, err := store.Cursor(ctx, orgID); err != nil || !exists {
		t.Fatalf("cursor reread = %v/%v", exists, err)
	}
	var auditsAfter int
	if err := dbAdmin.QueryRow(ctx,
		`SELECT count(*) FROM work.audit_event WHERE org_id = $1`, orgID).Scan(&auditsAfter); err != nil {
		t.Fatal(err)
	}
	if auditsAfter != auditsBefore {
		t.Fatalf("cursor getter wrote audit rows: %d -> %d", auditsBefore, auditsAfter)
	}

	subject := "sub_a"
	desired := true
	revision := int64(3)
	event := host.GovernanceEvent{
		EventSeq: 6, CommandID: "10000000-0000-0000-0000-000000000001", Kind: "seat",
		TargetSubjectID: &subject, Desired: &desired,
		PayloadHash: "sha256:" + strings.Repeat("a", 64), MemberRevision: &revision,
		AppliedAt: "2026-11-25T00:00:00Z",
	}
	consumed, err := store.Consume(ctx, orgID, []host.GovernanceEvent{event}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if consumed.Consumed != 1 || consumed.Released != 1 || consumed.LastEventSeq != 6 {
		t.Fatalf("consumed = %#v", consumed)
	}
	replayed, err := store.Consume(ctx, orgID, []host.GovernanceEvent{event}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Consumed != 0 || replayed.Released != 0 || replayed.LastEventSeq != 6 {
		t.Fatalf("replayed = %#v", replayed)
	}
	var state string
	if err := dbAdmin.QueryRow(ctx,
		`SELECT state FROM work.access_restriction WHERE org_id = $1 AND subject_id = 'sub_a'`, orgID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "released" {
		t.Fatalf("deny state = %q, want released", state)
	}
	var seat bool
	if err := dbAdmin.QueryRow(ctx,
		`SELECT work_seat FROM work.member WHERE org_id = $1 AND subject_id = 'sub_a'`, orgID).Scan(&seat); err != nil {
		t.Fatal(err)
	}
	if seat {
		t.Fatal("governance consumer changed the directory projection")
	}

	desired = false
	revision7 := int64(4)
	event7 := event
	event7.EventSeq = 7
	event7.CommandID = "10000000-0000-0000-0000-000000000007"
	event7.Desired = &desired
	event7.MemberRevision = &revision7
	revision9 := int64(5)
	event9 := event7
	event9.EventSeq = 9
	event9.CommandID = "10000000-0000-0000-0000-000000000009"
	event9.MemberRevision = &revision9
	gap := &host.GovernanceGap{
		FromSeq: 8, ToSeqExclusive: 9, SeatEvents: json.RawMessage(`[]`), Coverage: "enumerated",
	}
	gapped, err := store.Consume(ctx, orgID, []host.GovernanceEvent{event7, event9}, gap, nil)
	if err != nil {
		t.Fatal(err)
	}
	if gapped.Consumed != 1 || gapped.LastEventSeq != 7 || gapped.GapReportID == nil {
		t.Fatalf("gapped = %#v", gapped)
	}
	var reports int
	if err := dbAdmin.QueryRow(ctx,
		`SELECT count(*) FROM work.governance_gap_report
		 WHERE org_id = $1 AND from_seq = 8 AND to_seq_exclusive = 9
		   AND seat_event_count = 0`, orgID).Scan(&reports); err != nil {
		t.Fatal(err)
	}
	if reports != 1 {
		t.Fatalf("gap reports = %d, want 1", reports)
	}
	trailing := &host.GovernanceGap{
		FromSeq: 8, ToSeqExclusive: 10, SeatEvents: json.RawMessage(`[]`), Coverage: "enumerated",
	}
	recorded, err := store.RecordGap(ctx, orgID, trailing, 9)
	if err != nil {
		t.Fatal(err)
	}
	if recorded.GapReportID == nil || recorded.FromSeq == nil || *recorded.FromSeq != 8 ||
		recorded.ToSeqExclusive == nil || *recorded.ToSeqExclusive != 10 {
		t.Fatalf("recorded = %#v", recorded)
	}
	if err := dbAdmin.QueryRow(ctx,
		`SELECT count(*) FROM work.governance_gap_report
		 WHERE org_id = $1 AND from_seq = 8 AND to_seq_exclusive = 10
		   AND host_fetch_seq = 9 AND seat_event_count = 0`, orgID).Scan(&reports); err != nil {
		t.Fatal(err)
	}
	if reports != 1 {
		t.Fatalf("trailing gap reports = %d, want 1", reports)
	}
}
