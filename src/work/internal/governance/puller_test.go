package governance

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"reflect"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/host"
)

type fakeSource struct {
	pages map[int64]host.GovernancePage
	calls []int64
}

func (f *fakeSource) ListGovernanceEvents(
	_ context.Context,
	_ string,
	after int64,
	_ int,
	_ string,
) (host.GovernancePage, error) {
	f.calls = append(f.calls, after)
	page, ok := f.pages[after]
	if !ok {
		return host.GovernancePage{}, errors.New("unexpected cursor")
	}
	return page, nil
}

type consumeCall struct {
	events         []host.GovernanceEvent
	gap            *host.GovernanceGap
	initializeFrom *int64
}

type fakeStore struct {
	calls     []consumeCall
	gapCalls  int
	result    Result
	gapResult Result
	cursor    int64
	hasCursor bool
}

func (f *fakeStore) Cursor(context.Context, string) (int64, bool, error) {
	return f.cursor, f.hasCursor, nil
}

func (f *fakeStore) RecordGap(context.Context, string, *host.GovernanceGap, int64) (Result, error) {
	f.gapCalls++
	return f.gapResult, nil
}

func (f *fakeStore) Consume(
	_ context.Context,
	_ string,
	events []host.GovernanceEvent,
	gap *host.GovernanceGap,
	initializeFrom *int64,
) (Result, error) {
	f.calls = append(f.calls, consumeCall{events: events, gap: gap, initializeFrom: initializeFrom})
	result := f.result
	if initializeFrom != nil && !f.hasCursor {
		result.LastEventSeq = *initializeFrom
	}
	return result, nil
}

func testEvent(seq int64) host.GovernanceEvent {
	subject := "sub_a"
	desired := true
	revision := seq + 10
	return host.GovernanceEvent{
		EventSeq: seq, CommandID: "10000000-0000-0000-0000-000000000001", Kind: "seat",
		TargetSubjectID: &subject, Desired: &desired, PayloadHash: "sha256:" + strings.Repeat("a", 64),
		MemberRevision: &revision, AppliedAt: "2026-11-25T00:00:00Z",
	}
}

func newTestPuller(t *testing.T, source Source, store Store) *Puller {
	t.Helper()
	puller, err := New(source, store, Config{Orgs: []string{"org_1"}, PageLimit: 100, MaxPages: 10}, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	return puller
}

func TestPassInitializesAtHostMaximumWithoutBackfill(t *testing.T) {
	source := &fakeSource{pages: map[int64]host.GovernancePage{
		0: {LatestEventSeq: 5},
		5: {LatestEventSeq: 5},
	}}
	store := &fakeStore{}
	report, err := newTestPuller(t, source, store).Pass(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(source.calls, []int64{0, 5}) {
		t.Fatalf("Host cursors = %#v", source.calls)
	}
	if len(store.calls) != 1 || store.calls[0].initializeFrom == nil || *store.calls[0].initializeFrom != 5 || len(store.calls[0].events) != 0 {
		t.Fatalf("store calls = %#v", store.calls)
	}
	if report.Failed() || report.OrgsApplied != 1 {
		t.Fatalf("report = %#v", report)
	}
}

func TestPassConsumesContiguousPages(t *testing.T) {
	source := &fakeSource{pages: map[int64]host.GovernancePage{
		0: {LatestEventSeq: 2, Events: []host.GovernanceEvent{testEvent(1), testEvent(2)}},
		2: {LatestEventSeq: 2},
	}}
	store := &fakeStore{hasCursor: true, cursor: 0, result: Result{Consumed: 2, Released: 1, LastEventSeq: 2}}
	report, err := newTestPuller(t, source, store).Pass(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(source.calls, []int64{0}) {
		t.Fatalf("Host cursors = %#v", source.calls)
	}
	if len(store.calls) != 1 || len(store.calls[0].events) != 2 || store.calls[0].gap != nil {
		t.Fatalf("store calls = %#v", store.calls)
	}
	if report.EventsConsumed != 2 || report.DenysReleased != 1 || report.Failed() {
		t.Fatalf("report = %#v", report)
	}
}

func TestPassLostGapDoesNotAdvance(t *testing.T) {
	source := &fakeSource{pages: map[int64]host.GovernancePage{
		0: {LatestEventSeq: 5},
		3: {LatestEventSeq: 5, Gap: &host.GovernanceGap{FromSeq: 4, ToSeqExclusive: 5, Coverage: "lost", SeatEvents: json.RawMessage(`[]`)}},
	}}
	store := &fakeStore{hasCursor: true, cursor: 3, result: Result{LastEventSeq: 3}}
	report, err := newTestPuller(t, source, store).Pass(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Errors) != 1 || report.Errors[0].Code != "governance_gap_lost" {
		t.Fatalf("report = %#v", report)
	}
	if len(store.calls) != 0 {
		t.Fatalf("store calls = %#v", store.calls)
	}
	if report.OrgsGapped != 1 || !report.Failed() {
		t.Fatalf("report = %#v", report)
	}
}

func TestPassEnumeratedGapIsPassedToStoreAndStops(t *testing.T) {
	gap := &host.GovernanceGap{FromSeq: 2, ToSeqExclusive: 3, Coverage: "enumerated", SeatEvents: json.RawMessage(`[]`)}
	reportID := "00000000-0000-0000-0000-000000000001"
	source := &fakeSource{pages: map[int64]host.GovernancePage{
		0: {LatestEventSeq: 3},
		1: {LatestEventSeq: 3, Events: []host.GovernanceEvent{testEvent(1), testEvent(3)}, Gap: gap},
	}}
	store := &fakeStore{hasCursor: true, cursor: 1, result: Result{Consumed: 1, LastEventSeq: 1, GapReportID: &reportID}}
	report, err := newTestPuller(t, source, store).Pass(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Errors) != 1 || report.Errors[0].Code != "governance_gap_detected" {
		t.Fatalf("report = %#v", report)
	}
	if len(store.calls) != 1 || store.calls[0].gap == nil || store.calls[0].gap.Coverage != "enumerated" {
		t.Fatalf("store calls = %#v", store.calls)
	}
	if report.OrgsGapped != 1 || report.EventsConsumed != 1 {
		t.Fatalf("report = %#v", report)
	}
}

func TestPassEnumeratedTrailingGapIsRecordedAndStops(t *testing.T) {
	gap := &host.GovernanceGap{FromSeq: 4, ToSeqExclusive: 5, Coverage: "enumerated", SeatEvents: json.RawMessage(`[]`)}
	reportID := "00000000-0000-0000-0000-000000000004"
	source := &fakeSource{pages: map[int64]host.GovernancePage{
		3: {LatestEventSeq: 5, Gap: gap},
	}}
	store := &fakeStore{
		hasCursor: true, cursor: 3,
		gapResult: Result{GapReportID: &reportID, FromSeq: &gap.FromSeq, ToSeqExclusive: &gap.ToSeqExclusive},
	}
	report, err := newTestPuller(t, source, store).Pass(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Errors) != 1 || report.Errors[0].Code != "governance_gap_detected" || report.OrgsGapped != 1 {
		t.Fatalf("report = %#v", report)
	}
	if store.gapCalls != 1 || len(store.calls) != 0 {
		t.Fatalf("gap calls = %d consume calls = %#v", store.gapCalls, store.calls)
	}
}

func TestPassRejectsStalledCursor(t *testing.T) {
	source := &fakeSource{pages: map[int64]host.GovernancePage{
		0: {LatestEventSeq: 1, Events: []host.GovernanceEvent{testEvent(1)}},
	}}
	store := &fakeStore{hasCursor: true, cursor: 0, result: Result{Consumed: 1, LastEventSeq: 0}}
	report, err := newTestPuller(t, source, store).Pass(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Errors) != 1 || report.Errors[0].Code != "governance_cursor_stalled" {
		t.Fatalf("report = %#v", report)
	}
}
