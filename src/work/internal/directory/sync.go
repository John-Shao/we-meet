// Package directory applies the Host directory to the Work projection.
//
// The Host exposes an organization-wide directory sequence: every organization
// or membership change advances Organization.directory_revision and stamps the
// changed member with that value. A full snapshot at revision R is complete for
// all changes up to R, so R doubles as the per-organization watermark:
// incremental cycles request members with revision_after = R, and full cycles
// use R to narrow members missing from the snapshot to "left".
package directory

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/we-meet/work/internal/host"
)

var (
	ErrRevisionStale      = errors.New("projection_revision_stale")
	ErrMassAbsenceBlocked = errors.New("mass_absence_requires_confirmation")
)

type Discovery interface {
	ListOrgs(ctx context.Context) ([]host.Org, error)
	ListMembers(ctx context.Context, orgID string, revisionAfter int64) ([]host.Member, error)
}

type ProjectionWriter interface {
	SyncOrg(ctx context.Context, org host.Org) error
	SyncMember(ctx context.Context, member host.Member) error
	Watermark(ctx context.Context, orgID string) (int64, bool, error)
	MarkAbsent(ctx context.Context, orgID string, present []string, allowMassAbsence bool) (int, error)
}

type Options struct {
	OrgID            string
	Full             bool
	AllowMassAbsence bool
	MaxErrors        int
}

type ItemError struct {
	Scope     string `json:"scope"`
	OrgID     string `json:"org_id"`
	SubjectID string `json:"subject_id,omitempty"`
	Code      string `json:"code"`
	Message   string `json:"message"`
}

type Report struct {
	Mode           string      `json:"mode"`
	OrgsTotal      int         `json:"orgs_total"`
	OrgsApplied    int         `json:"orgs_applied"`
	OrgsStale      int         `json:"orgs_stale"`
	OrgsFailed     int         `json:"orgs_failed"`
	MembersTotal   int         `json:"members_total"`
	MembersApplied int         `json:"members_applied"`
	MembersStale   int         `json:"members_stale"`
	MembersFailed  int         `json:"members_failed"`
	MembersAbsent  int         `json:"members_absent"`
	Errors         []ItemError `json:"errors"`
}

func (r Report) Failed() bool {
	return r.OrgsFailed > 0 || r.MembersFailed > 0
}

func Sync(ctx context.Context, discovery Discovery, writer ProjectionWriter, options Options) (Report, error) {
	mode := "incremental"
	if options.Full {
		mode = "full"
	}
	report := Report{Mode: mode, Errors: []ItemError{}}
	if discovery == nil || writer == nil {
		return report, fmt.Errorf("directory sync requires discovery and writer")
	}
	maxErrors := options.MaxErrors
	if maxErrors <= 0 {
		maxErrors = 50
	}
	record := func(item ItemError) {
		if len(report.Errors) < maxErrors {
			report.Errors = append(report.Errors, item)
		}
	}

	orgs, err := discovery.ListOrgs(ctx)
	if err != nil {
		record(ItemError{
			Scope:   "host",
			Code:    errorCode(err),
			Message: fmt.Sprintf("list Host organizations: %v", err),
		})
		return report, fmt.Errorf("list Host organizations: %w", err)
	}
	for _, org := range orgs {
		if options.OrgID != "" && org.OrgID != options.OrgID {
			continue
		}
		report.OrgsTotal++

		if reason := orgGap(org); reason != "" {
			report.OrgsFailed++
			record(ItemError{Scope: "org", OrgID: org.OrgID, Code: "host_field_gap", Message: reason})
			continue
		}
		if !syncOrganization(ctx, discovery, writer, org, options.Full, options.AllowMassAbsence, &report, record) {
			report.OrgsFailed++
		}
	}
	if options.OrgID != "" && report.OrgsTotal == 0 {
		record(ItemError{
			Scope:   "org",
			OrgID:   options.OrgID,
			Code:    "org_not_found",
			Message: "organization was not returned by Host",
		})
		return report, fmt.Errorf("organization %q was not returned by Host", options.OrgID)
	}
	return report, nil
}

func syncOrganization(
	ctx context.Context,
	discovery Discovery,
	writer ProjectionWriter,
	org host.Org,
	full bool,
	allowMassAbsence bool,
	report *Report,
	record func(ItemError),
) bool {
	watermark, exists, err := writer.Watermark(ctx, org.OrgID)
	if err != nil {
		record(ItemError{Scope: "org", OrgID: org.OrgID, Code: errorCode(err), Message: err.Error()})
		return false
	}
	if exists && org.Revision < watermark {
		record(ItemError{
			Scope:   "org",
			OrgID:   org.OrgID,
			Code:    "host_revision_regressed",
			Message: fmt.Sprintf("Host revision %d is behind the applied watermark %d", org.Revision, watermark),
		})
		return false
	}
	full = full || !exists || watermark <= 1

	initialApplied := false
	if !exists {
		initial := org
		initial.Revision = 1
		switch err := writer.SyncOrg(ctx, initial); {
		case errors.Is(err, ErrRevisionStale):
		case err != nil:
			record(ItemError{Scope: "org", OrgID: org.OrgID, Code: errorCode(err), Message: err.Error()})
			return false
		default:
			initialApplied = true
		}
		watermark = 1
	}
	if !full && org.Revision == watermark {
		report.OrgsStale++
		return true
	}

	revisionAfter := int64(0)
	if !full {
		revisionAfter = watermark
	}
	members, err := discovery.ListMembers(ctx, org.OrgID, revisionAfter)
	if err != nil {
		record(ItemError{
			Scope:   "members",
			OrgID:   org.OrgID,
			Code:    errorCode(err),
			Message: fmt.Sprintf("list Host members: %v", err),
		})
		return false
	}

	present := make([]string, 0, len(members))
	seen := make(map[string]bool, len(members))
	membersOK := true
	for _, member := range members {
		report.MembersTotal++
		if member.OrgID != org.OrgID {
			report.MembersFailed++
			membersOK = false
			record(ItemError{
				Scope:     "member",
				OrgID:     org.OrgID,
				SubjectID: member.SubjectID,
				Code:      "directory_protocol_invalid",
				Message:   "Host returned a member for a different organization",
			})
			continue
		}
		if member.SubjectID != "" && !seen[member.SubjectID] {
			seen[member.SubjectID] = true
			present = append(present, member.SubjectID)
		}
		if reason := memberGap(member); reason != "" {
			report.MembersFailed++
			membersOK = false
			record(ItemError{
				Scope:     "member",
				OrgID:     org.OrgID,
				SubjectID: member.SubjectID,
				Code:      "host_field_gap",
				Message:   reason,
			})
			continue
		}
		switch err := writer.SyncMember(ctx, member); {
		case errors.Is(err, ErrRevisionStale):
			report.MembersStale++
		case err != nil:
			report.MembersFailed++
			membersOK = false
			record(ItemError{
				Scope:     "member",
				OrgID:     org.OrgID,
				SubjectID: member.SubjectID,
				Code:      errorCode(err),
				Message:   err.Error(),
			})
		default:
			report.MembersApplied++
		}
	}

	if !membersOK {
		// Keep the previous watermark so the next cycle retries the same
		// revision window; never narrow absence from a partial apply.
		return false
	}

	if org.Revision > watermark {
		switch err := writer.SyncOrg(ctx, org); {
		case errors.Is(err, ErrRevisionStale):
			report.OrgsStale++
		case err != nil:
			record(ItemError{Scope: "org", OrgID: org.OrgID, Code: errorCode(err), Message: err.Error()})
			return false
		default:
			report.OrgsApplied++
		}
	} else if initialApplied {
		report.OrgsApplied++
	} else {
		report.OrgsStale++
	}

	if full {
		absent, err := writer.MarkAbsent(ctx, org.OrgID, present, allowMassAbsence)
		if err != nil {
			record(ItemError{Scope: "absence", OrgID: org.OrgID, Code: errorCode(err), Message: err.Error()})
			return false
		}
		report.MembersAbsent += absent
	}
	return true
}

func orgGap(org host.Org) string {
	if len(org.Gaps) > 0 {
		return "Host organization gaps: " + strings.Join(org.Gaps, ", ")
	}
	if org.Revision <= 0 {
		return "Host organization revision is not positive"
	}
	return ""
}

func memberGap(member host.Member) string {
	if len(member.Gaps) > 0 {
		return "Host member gaps: " + strings.Join(member.Gaps, ", ")
	}
	if member.Revision <= 0 {
		return "Host member revision is not positive"
	}
	return ""
}

func errorCode(err error) string {
	if errors.Is(err, ErrMassAbsenceBlocked) {
		return "mass_absence_requires_confirmation"
	}
	var hostErr *host.Error
	if errors.As(err, &hostErr) {
		return hostErr.Code
	}
	return "directory_sync_failed"
}
