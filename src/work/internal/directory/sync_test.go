package directory_test

import (
	"context"
	"errors"
	"testing"

	"github.com/we-meet/work/internal/directory"
	"github.com/we-meet/work/internal/host"
)

type memberCall struct {
	OrgID         string
	RevisionAfter int64
}

type fakeDiscovery struct {
	orgs       []host.Org
	members    map[string][]host.Member
	listErr    error
	memberErrs map[string]error
	listCalls  []memberCall
}

func (d *fakeDiscovery) ListOrgs(context.Context) ([]host.Org, error) {
	if d.listErr != nil {
		return nil, d.listErr
	}
	return d.orgs, nil
}

func (d *fakeDiscovery) ListMembers(_ context.Context, orgID string, revisionAfter int64) ([]host.Member, error) {
	d.listCalls = append(d.listCalls, memberCall{OrgID: orgID, RevisionAfter: revisionAfter})
	if err := d.memberErrs[orgID]; err != nil {
		return nil, err
	}
	rows := append([]host.Member(nil), d.members[orgID]...)
	filtered := make([]host.Member, 0, len(rows))
	for index := range rows {
		if rows[index].OrgID == "" {
			rows[index].OrgID = orgID
		}
		if rows[index].Revision > revisionAfter {
			filtered = append(filtered, rows[index])
		}
	}
	return filtered, nil
}

type absentCall struct {
	OrgID     string
	Present   []string
	AllowMass bool
}

type fakeWriter struct {
	watermarks  map[string]int64
	orgErr      map[string]error
	memberErr   map[string]error
	markErr     error
	absentCount int
	orgs        []host.Org
	members     []host.Member
	absentCalls []absentCall
}

func (w *fakeWriter) Watermark(_ context.Context, orgID string) (int64, bool, error) {
	value, ok := w.watermarks[orgID]
	return value, ok, nil
}

func (w *fakeWriter) SyncOrg(_ context.Context, org host.Org) error {
	if err := w.orgErr[org.OrgID]; err != nil {
		return err
	}
	w.orgs = append(w.orgs, org)
	if w.watermarks == nil {
		w.watermarks = make(map[string]int64)
	}
	w.watermarks[org.OrgID] = org.Revision
	return nil
}

func (w *fakeWriter) SyncMember(_ context.Context, member host.Member) error {
	if err := w.memberErr[member.SubjectID]; err != nil {
		return err
	}
	w.members = append(w.members, member)
	return nil
}

func (w *fakeWriter) MarkAbsent(_ context.Context, orgID string, present []string, allowMass bool) (int, error) {
	if w.markErr != nil {
		return 0, w.markErr
	}
	w.absentCalls = append(w.absentCalls, absentCall{
		OrgID:     orgID,
		Present:   append([]string(nil), present...),
		AllowMass: allowMass,
	})
	return w.absentCount, nil
}

func healthyOrg(id string, revision int64) host.Org {
	return host.Org{OrgID: id, Name: "Org " + id, Status: "active", HomeRegion: "cn-north", Revision: revision}
}

func TestSyncFirstRunCreatesAtInitialRevisionThenAdvances(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs: []host.Org{healthyOrg("org_1", 5)},
		members: map[string][]host.Member{
			"org_1": {
				{SubjectID: "sub_1", Status: "active", Role: "owner", WorkSeat: true, Revision: 2},
				{SubjectID: "sub_2", Status: "left", Role: "member", Revision: 5},
			},
		},
	}
	writer := &fakeWriter{absentCount: 2}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.Failed() || report.Mode != "incremental" {
		t.Fatalf("report = %#v", report)
	}
	if report.OrgsApplied != 1 || report.MembersApplied != 2 || report.MembersAbsent != 2 {
		t.Fatalf("report = %#v", report)
	}
	if len(writer.orgs) != 2 || writer.orgs[0].Revision != 1 || writer.orgs[1].Revision != 5 {
		t.Fatalf("org writes = %#v", writer.orgs)
	}
	if len(discovery.listCalls) != 1 || discovery.listCalls[0].RevisionAfter != 0 {
		t.Fatalf("member calls = %#v", discovery.listCalls)
	}
	if len(writer.absentCalls) != 1 {
		t.Fatalf("absence calls = %#v", writer.absentCalls)
	}
	call := writer.absentCalls[0]
	if call.AllowMass || len(call.Present) != 2 || call.Present[0] != "sub_1" || call.Present[1] != "sub_2" {
		t.Fatalf("absence call = %#v", call)
	}
}

func TestSyncFullAppliesAndMarksAbsent(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs: []host.Org{healthyOrg("org_1", 5)},
		members: map[string][]host.Member{
			"org_1": {{SubjectID: "sub_1", Status: "active", Role: "member", Revision: 4}},
		},
	}
	writer := &fakeWriter{watermarks: map[string]int64{"org_1": 3}, absentCount: 1}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{Full: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Failed() || report.Mode != "full" || report.OrgsApplied != 1 || report.MembersApplied != 1 {
		t.Fatalf("report = %#v", report)
	}
	if report.MembersAbsent != 1 {
		t.Fatalf("absent = %d", report.MembersAbsent)
	}
	if len(discovery.listCalls) != 1 || discovery.listCalls[0].RevisionAfter != 0 {
		t.Fatalf("member calls = %#v", discovery.listCalls)
	}
	if len(writer.absentCalls) != 1 || writer.absentCalls[0].AllowMass {
		t.Fatalf("absence calls = %#v", writer.absentCalls)
	}
}

func TestSyncIncrementalUsesWatermark(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs: []host.Org{healthyOrg("org_1", 7)},
		members: map[string][]host.Member{
			"org_1": {
				{SubjectID: "sub_1", Status: "active", Role: "member", Revision: 6},
				{SubjectID: "sub_2", Status: "active", Role: "member", Revision: 5},
			},
		},
	}
	writer := &fakeWriter{watermarks: map[string]int64{"org_1": 5}}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.Failed() || report.OrgsApplied != 1 || report.MembersApplied != 1 || report.MembersTotal != 1 {
		t.Fatalf("report = %#v", report)
	}
	if len(discovery.listCalls) != 1 || discovery.listCalls[0].RevisionAfter != 5 {
		t.Fatalf("member calls = %#v", discovery.listCalls)
	}
	if len(writer.absentCalls) != 0 {
		t.Fatalf("incremental run must not narrow absence: %#v", writer.absentCalls)
	}
}

func TestSyncIncrementalNoChangeSkipsMemberListing(t *testing.T) {
	discovery := &fakeDiscovery{orgs: []host.Org{healthyOrg("org_1", 7)}}
	writer := &fakeWriter{watermarks: map[string]int64{"org_1": 7}}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.Failed() || report.OrgsStale != 1 || report.MembersTotal != 0 {
		t.Fatalf("report = %#v", report)
	}
	if len(discovery.listCalls) != 0 {
		t.Fatalf("member calls = %#v", discovery.listCalls)
	}
}

func TestSyncFullTreatsStaleRevisionsAsApplied(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs: []host.Org{healthyOrg("org_1", 7)},
		members: map[string][]host.Member{
			"org_1": {
				{SubjectID: "sub_1", Status: "active", Role: "member", Revision: 7},
				{SubjectID: "sub_2", Status: "active", Role: "member", Revision: 7},
			},
		},
	}
	writer := &fakeWriter{
		watermarks: map[string]int64{"org_1": 7},
		memberErr:  map[string]error{"sub_1": directory.ErrRevisionStale},
	}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{Full: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Failed() || report.OrgsStale != 1 || report.MembersStale != 1 || report.MembersApplied != 1 {
		t.Fatalf("report = %#v", report)
	}
	if len(writer.absentCalls) != 1 {
		t.Fatalf("full run must still reconcile absence: %#v", writer.absentCalls)
	}
}

func TestSyncRejectsHostRevisionRegression(t *testing.T) {
	discovery := &fakeDiscovery{orgs: []host.Org{healthyOrg("org_1", 8)}}
	writer := &fakeWriter{watermarks: map[string]int64{"org_1": 9}}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.OrgsFailed != 1 || len(report.Errors) != 1 || report.Errors[0].Code != "host_revision_regressed" {
		t.Fatalf("report = %#v", report)
	}
	if len(writer.orgs) != 0 || len(discovery.listCalls) != 0 {
		t.Fatalf("regressed snapshot was applied: orgs=%#v calls=%#v", writer.orgs, discovery.listCalls)
	}
}

func TestSyncMemberFailureDoesNotAdvanceWatermark(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs: []host.Org{healthyOrg("org_1", 5)},
		members: map[string][]host.Member{
			"org_1": {{SubjectID: "sub_1", Status: "active", Role: "member", Revision: 4}},
		},
	}
	writer := &fakeWriter{
		watermarks: map[string]int64{"org_1": 3},
		memberErr:  map[string]error{"sub_1": errors.New("database unavailable")},
	}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.OrgsFailed != 1 || report.MembersFailed != 1 {
		t.Fatalf("report = %#v", report)
	}
	if len(writer.orgs) != 0 || len(writer.absentCalls) != 0 {
		t.Fatalf("failed member advanced the projection: orgs=%#v absent=%#v", writer.orgs, writer.absentCalls)
	}
	if writer.watermarks["org_1"] != 3 {
		t.Fatalf("watermark = %d", writer.watermarks["org_1"])
	}
}

func TestSyncGapRowsFailTheOrganization(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs: []host.Org{healthyOrg("org_1", 5)},
		members: map[string][]host.Member{
			"org_1": {
				{SubjectID: "sub_1", Status: "active", Role: "", Revision: 4, Gaps: []string{"role"}},
				{SubjectID: "sub_2", Status: "active", Role: "member", Revision: 5},
			},
		},
	}
	writer := &fakeWriter{watermarks: map[string]int64{"org_1": 3}}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.OrgsFailed != 1 || report.MembersFailed != 1 || report.MembersApplied != 1 {
		t.Fatalf("report = %#v", report)
	}
	if len(writer.orgs) != 0 || len(writer.absentCalls) != 0 {
		t.Fatalf("gap row advanced the projection: orgs=%#v absent=%#v", writer.orgs, writer.absentCalls)
	}
}

func TestSyncMemberListingFailureKeepsTheInitialWatermark(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs:       []host.Org{healthyOrg("org_1", 5)},
		memberErrs: map[string]error{"org_1": errors.New("host timeout")},
	}
	writer := &fakeWriter{}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.OrgsFailed != 1 || report.MembersTotal != 0 {
		t.Fatalf("report = %#v", report)
	}
	if len(writer.orgs) != 1 || writer.orgs[0].Revision != 1 {
		t.Fatalf("org writes = %#v", writer.orgs)
	}
	if writer.watermarks["org_1"] != 1 {
		t.Fatalf("watermark = %d", writer.watermarks["org_1"])
	}
	if len(report.Errors) != 1 || report.Errors[0].Scope != "members" {
		t.Fatalf("errors = %#v", report.Errors)
	}
}

func TestSyncIsolatesOrganizationFailures(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs: []host.Org{healthyOrg("org_1", 2), healthyOrg("org_2", 2)},
		members: map[string][]host.Member{
			"org_2": {{SubjectID: "sub_2", Status: "active", Role: "member", Revision: 2}},
		},
	}
	writer := &fakeWriter{orgErr: map[string]error{"org_1": errors.New("database unavailable")}}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.OrgsFailed != 1 || report.OrgsApplied != 1 || report.MembersApplied != 1 {
		t.Fatalf("report = %#v", report)
	}
	if len(discovery.listCalls) != 1 || discovery.listCalls[0].OrgID != "org_2" {
		t.Fatalf("member listings = %#v", discovery.listCalls)
	}
}

func TestSyncMassAbsenceBlockIsReported(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs: []host.Org{healthyOrg("org_1", 5)},
		members: map[string][]host.Member{
			"org_1": {{SubjectID: "sub_1", Status: "active", Role: "member", Revision: 4}},
		},
	}
	writer := &fakeWriter{
		watermarks: map[string]int64{"org_1": 3},
		markErr:    directory.ErrMassAbsenceBlocked,
	}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{Full: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.OrgsFailed != 1 || len(report.Errors) != 1 || report.Errors[0].Code != "mass_absence_requires_confirmation" {
		t.Fatalf("report = %#v", report)
	}
}

func TestSyncMarkAbsentFailureFailsTheOrganization(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs: []host.Org{healthyOrg("org_1", 5)},
		members: map[string][]host.Member{
			"org_1": {{SubjectID: "sub_1", Status: "active", Role: "member", Revision: 4}},
		},
	}
	writer := &fakeWriter{
		watermarks: map[string]int64{"org_1": 3},
		markErr:    errors.New("database unavailable"),
	}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{Full: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.OrgsFailed != 1 || len(report.Errors) != 1 || report.Errors[0].Scope != "absence" {
		t.Fatalf("report = %#v", report)
	}
}

func TestSyncRejectsMemberFromAnotherOrganization(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs: []host.Org{healthyOrg("org_1", 5)},
		members: map[string][]host.Member{
			"org_1": {{OrgID: "org_other", SubjectID: "sub_1", Status: "active", Role: "member", Revision: 4}},
		},
	}
	writer := &fakeWriter{watermarks: map[string]int64{"org_1": 3}}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if report.OrgsFailed != 1 || report.MembersFailed != 1 || report.MembersApplied != 0 {
		t.Fatalf("report = %#v", report)
	}
	if len(writer.absentCalls) != 0 {
		t.Fatalf("absence calls = %#v", writer.absentCalls)
	}
}

func TestSyncFiltersToOneOrganization(t *testing.T) {
	discovery := &fakeDiscovery{
		orgs: []host.Org{healthyOrg("org_1", 2), healthyOrg("org_2", 2)},
		members: map[string][]host.Member{
			"org_2": {{SubjectID: "sub_2", Status: "active", Role: "member", Revision: 2}},
		},
	}
	writer := &fakeWriter{}

	report, err := directory.Sync(context.Background(), discovery, writer, directory.Options{OrgID: "org_2"})
	if err != nil {
		t.Fatal(err)
	}
	if report.OrgsTotal != 1 || report.MembersApplied != 1 {
		t.Fatalf("report = %#v", report)
	}
	if len(writer.orgs) != 2 || writer.orgs[0].OrgID != "org_2" {
		t.Fatalf("orgs = %#v", writer.orgs)
	}

	_, err = directory.Sync(context.Background(), discovery, writer, directory.Options{OrgID: "org_missing"})
	if err == nil {
		t.Fatal("missing organization was accepted")
	}
}

func TestSyncFailsWhenOrganizationsCannotBeListed(t *testing.T) {
	discovery := &fakeDiscovery{listErr: errors.New("host unavailable")}

	report, err := directory.Sync(context.Background(), discovery, &fakeWriter{}, directory.Options{})

	if err == nil {
		t.Fatal("listing failure was swallowed")
	}
	if report.OrgsTotal != 0 || report.Failed() {
		t.Fatalf("report = %#v", report)
	}
}

func TestSyncRejectsNonPositiveRevision(t *testing.T) {
	org := healthyOrg("org_1", 0)
	discovery := &fakeDiscovery{orgs: []host.Org{org}}

	report, err := directory.Sync(context.Background(), discovery, &fakeWriter{}, directory.Options{})

	if err != nil {
		t.Fatal(err)
	}
	if report.OrgsFailed != 1 || len(report.Errors) != 1 || report.Errors[0].Code != "host_field_gap" {
		t.Fatalf("report = %#v", report)
	}
}
