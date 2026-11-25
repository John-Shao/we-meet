// Package governance consumes Host governance commands without touching directory projections.
package governance

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"

	"github.com/we-meet/work/internal/host"
)

type Source interface {
	ListGovernanceEvents(
		ctx context.Context,
		orgID string,
		afterEventSeq int64,
		limit int,
		correlationID string,
	) (host.GovernancePage, error)
}

type Config struct {
	Orgs      []string
	PageLimit int
	MaxPages  int
}

type Puller struct {
	source Source
	store  Store
	config Config
	logger *log.Logger
}

type ItemError struct {
	OrgID   string `json:"org_id"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Report struct {
	OrgsTotal      int         `json:"orgs_total"`
	OrgsApplied    int         `json:"orgs_applied"`
	OrgsGapped     int         `json:"orgs_gapped"`
	OrgsFailed     int         `json:"orgs_failed"`
	EventsConsumed int64       `json:"events_consumed"`
	DenysReleased  int64       `json:"denys_released"`
	Errors         []ItemError `json:"errors"`
}

func (r Report) Failed() bool { return r.OrgsGapped > 0 || r.OrgsFailed > 0 }

func New(source Source, store Store, config Config, logger *log.Logger) (*Puller, error) {
	if source == nil || store == nil {
		return nil, errors.New("governance puller requires a Host source and store")
	}
	if len(config.Orgs) == 0 {
		return nil, errors.New("governance organization list is empty")
	}
	seen := make(map[string]bool)
	for _, orgID := range config.Orgs {
		orgID = strings.TrimSpace(orgID)
		if orgID == "" || len(orgID) > 128 || strings.ContainsRune(orgID, '\x00') {
			return nil, fmt.Errorf("invalid governance organization id %q", orgID)
		}
		if seen[orgID] {
			return nil, fmt.Errorf("duplicate governance organization id %q", orgID)
		}
		seen[orgID] = true
	}
	if config.PageLimit <= 0 {
		config.PageLimit = host.GovernancePageLimit
	}
	if config.PageLimit > host.GovernancePageLimit {
		return nil, errors.New("governance page limit exceeds 100")
	}
	if config.MaxPages <= 0 {
		config.MaxPages = 1000
	}
	if logger == nil {
		logger = log.Default()
	}
	return &Puller{source: source, store: store, config: config, logger: logger}, nil
}

func (p *Puller) Pass(ctx context.Context) (Report, error) {
	report := Report{Errors: []ItemError{}}
	for _, orgID := range p.config.Orgs {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		report.OrgsTotal++
		if err := p.syncOrg(ctx, orgID, &report); err != nil {
			if ctx.Err() != nil {
				return report, ctx.Err()
			}
			report.OrgsFailed++
			report.Errors = append(report.Errors, ItemError{
				OrgID: orgID, Code: errorCode(err), Message: err.Error(),
			})
			p.logger.Printf("governance sync failed org=%s code=%s", orgID, errorCode(err))
			continue
		}
		report.OrgsApplied++
	}
	return report, nil
}

func (p *Puller) syncOrg(ctx context.Context, orgID string, report *Report) error {
	cursor, exists, err := p.store.Cursor(ctx, orgID)
	if err != nil {
		return fmt.Errorf("read governance cursor: %w", err)
	}
	if !exists {
		probe, err := p.source.ListGovernanceEvents(ctx, orgID, 0, 1, "")
		if err != nil {
			return fmt.Errorf("probe Host governance watermark: %w", err)
		}
		latest := probe.LatestEventSeq
		cursorResult, err := p.store.Consume(ctx, orgID, nil, nil, &latest)
		if err != nil {
			return fmt.Errorf("initialize governance cursor: %w", err)
		}
		cursor = cursorResult.LastEventSeq
	}
	for pageNo := 0; pageNo < p.config.MaxPages; pageNo++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		page, err := p.source.ListGovernanceEvents(ctx, orgID, cursor, p.config.PageLimit, "")
		if err != nil {
			return fmt.Errorf("list Host governance events: %w", err)
		}
		if page.Gap != nil && page.Gap.Coverage == "lost" {
			report.OrgsGapped++
			p.logger.Printf("governance gap lost org=%s from=%d to=%d", orgID, page.Gap.FromSeq, page.Gap.ToSeqExclusive)
			return &StoreError{
				Code:    "governance_gap_lost",
				Message: fmt.Sprintf("Host cannot prove [%d,%d)", page.Gap.FromSeq, page.Gap.ToSeqExclusive),
			}
		}
		if len(page.Events) == 0 {
			if page.Gap != nil {
				gapResult, err := p.store.RecordGap(ctx, orgID, page.Gap, page.LatestEventSeq)
				if err != nil {
					return fmt.Errorf("record trailing governance gap: %w", err)
				}
				if gapResult.GapReportID == nil {
					return &StoreError{Code: "governance_result_invalid", Message: "gap recorder returned no report id"}
				}
				report.OrgsGapped++
				p.logger.Printf("governance trailing gap recorded org=%s report=%s", orgID, *gapResult.GapReportID)
				return &StoreError{Code: "governance_gap_detected", Message: "trailing governance gap recorded; manual recovery required"}
			}
			return nil
		}
		var gap *host.GovernanceGap
		if page.Gap != nil {
			gap = page.Gap
		}
		result, err := p.store.Consume(ctx, orgID, page.Events, gap, nil)
		if err != nil {
			return fmt.Errorf("consume Host governance events: %w", err)
		}
		report.EventsConsumed += result.Consumed
		report.DenysReleased += result.Released
		if page.Gap != nil {
			report.OrgsGapped++
			p.logger.Printf("governance gap recorded org=%s report=%s", orgID, *result.GapReportID)
			return &StoreError{Code: "governance_gap_detected", Message: "governance gap recorded; manual recovery required"}
		}
		if result.LastEventSeq <= cursor {
			return &StoreError{Code: "governance_cursor_stalled", Message: "consume did not advance the cursor"}
		}
		cursor = result.LastEventSeq
		if cursor >= page.LatestEventSeq {
			return nil
		}
		if len(page.Events) < p.config.PageLimit {
			return &StoreError{Code: "governance_protocol_invalid", Message: "Host page ended before latest_event_seq without a gap"}
		}
	}
	return &StoreError{Code: "governance_page_limit", Message: "governance pagination exceeded the page limit"}
}

func errorCode(err error) string {
	var hostErr *host.Error
	if errors.As(err, &hostErr) {
		return hostErr.Code
	}
	var storeErr *StoreError
	if errors.As(err, &storeErr) {
		return storeErr.Code
	}
	return "governance_failed"
}
