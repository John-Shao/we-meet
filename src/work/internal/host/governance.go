package host

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"github.com/google/uuid"
)

const (
	governanceEventsPath       = "/work-host/v3/governance-events"
	GovernancePageLimit        = 100
	maxGovernanceResponseBytes = 1 << 20
)

var (
	governancePayloadHashRE = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	governancePageKeys      = []string{"events", "latest_event_seq", "gap"}
	governanceEventKeys     = []string{
		"event_seq", "command_id", "kind", "target_subject_id", "desired",
		"payload_hash", "member_revision", "org_revision", "permissions_revision", "applied_at",
	}
	governanceGapKeys = []string{"from_seq", "to_seq_exclusive", "seat_events", "coverage"}
)

type GovernanceEvent struct {
	EventSeq            int64   `json:"event_seq"`
	CommandID           string  `json:"command_id"`
	Kind                string  `json:"kind"`
	TargetSubjectID     *string `json:"target_subject_id"`
	Desired             *bool   `json:"desired"`
	PayloadHash         string  `json:"payload_hash"`
	MemberRevision      *int64  `json:"member_revision"`
	OrgRevision         *int64  `json:"org_revision"`
	PermissionsRevision *int64  `json:"permissions_revision"`
	AppliedAt           string  `json:"applied_at"`
}

type GovernanceGap struct {
	FromSeq        int64           `json:"from_seq"`
	ToSeqExclusive int64           `json:"to_seq_exclusive"`
	SeatEvents     json.RawMessage `json:"seat_events"`
	Coverage       string          `json:"coverage"`
}

type GovernancePage struct {
	Events         []GovernanceEvent
	LatestEventSeq int64
	Gap            *GovernanceGap
}

type governanceEventWire struct {
	EventSeq            *int64  `json:"event_seq"`
	CommandID           *string `json:"command_id"`
	Kind                *string `json:"kind"`
	TargetSubjectID     *string `json:"target_subject_id"`
	Desired             *bool   `json:"desired"`
	PayloadHash         *string `json:"payload_hash"`
	MemberRevision      *int64  `json:"member_revision"`
	OrgRevision         *int64  `json:"org_revision"`
	PermissionsRevision *int64  `json:"permissions_revision"`
	AppliedAt           *string `json:"applied_at"`
}

type governanceGapWire struct {
	FromSeq        *int64           `json:"from_seq"`
	ToSeqExclusive *int64           `json:"to_seq_exclusive"`
	SeatEvents     *json.RawMessage `json:"seat_events"`
	Coverage       *string          `json:"coverage"`
}

type governancePageWire struct {
	Events         *[]json.RawMessage `json:"events"`
	LatestEventSeq *int64             `json:"latest_event_seq"`
	Gap            json.RawMessage    `json:"gap"`
}

func (c *Client) ListGovernanceEvents(
	ctx context.Context,
	orgID string,
	afterEventSeq int64,
	limit int,
	correlationID string,
) (GovernancePage, error) {
	if err := validatePathID("org_id", orgID); err != nil {
		return GovernancePage{}, err
	}
	if afterEventSeq < 0 {
		return GovernancePage{}, newError("invalid_cursor", "after_event_seq must be non-negative", nil)
	}
	if limit < 1 || limit > GovernancePageLimit {
		return GovernancePage{}, newError("invalid_cursor", "limit must be between 1 and 100", nil)
	}
	query := url.Values{
		"org_id":          {orgID},
		"after_event_seq": {strconv.FormatInt(afterEventSeq, 10)},
		"limit":           {strconv.Itoa(limit)},
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodGet, c.baseURL+governanceEventsPath+"?"+query.Encode(), nil,
	)
	if err != nil {
		return GovernancePage{}, newError("governance_unavailable", "build Host governance request", err)
	}
	request.Header.Set("Accept", "application/json")
	if correlationID != "" {
		request.Header.Set("X-Work-Request-ID", correlationID)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return GovernancePage{}, newError("governance_unavailable", "call Host governance events", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return GovernancePage{}, governanceStatusError(response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxGovernanceResponseBytes+1))
	if err != nil {
		return GovernancePage{}, newError("governance_protocol_invalid", "read Host governance response", err)
	}
	if len(body) > maxGovernanceResponseBytes {
		return GovernancePage{}, newError("governance_protocol_invalid", "Host governance response exceeds the size limit", nil)
	}
	if err := validateGovernanceObject(body, governancePageKeys); err != nil {
		return GovernancePage{}, err
	}
	var wire governancePageWire
	if err := json.Unmarshal(body, &wire); err != nil {
		return GovernancePage{}, newError("governance_protocol_invalid", "decode Host governance response", err)
	}
	if wire.Events == nil || wire.LatestEventSeq == nil {
		return GovernancePage{}, newError("host_field_gap", "Host governance page is missing a required field", nil)
	}
	page := GovernancePage{LatestEventSeq: *wire.LatestEventSeq, Events: make([]GovernanceEvent, 0, len(*wire.Events))}
	if page.LatestEventSeq < afterEventSeq {
		return GovernancePage{}, newError("invalid_cursor", "Host governance cursor is ahead of the latest event", nil)
	}
	for _, raw := range *wire.Events {
		event, err := decodeGovernanceEvent(raw)
		if err != nil {
			return GovernancePage{}, err
		}
		page.Events = append(page.Events, event)
	}
	if len(wire.Gap) > 0 && string(wire.Gap) != "null" {
		gap, err := decodeGovernanceGap(wire.Gap)
		if err != nil {
			return GovernancePage{}, err
		}
		page.Gap = &gap
	}
	if err := validateGovernancePage(page, afterEventSeq, limit); err != nil {
		return GovernancePage{}, err
	}
	return page, nil
}

func governanceStatusError(status int) error {
	switch status {
	case http.StatusForbidden:
		return newError("client_identity_invalid", "Host rejected the governance client identity", nil)
	case http.StatusNotFound:
		return newError("org_not_found", "Host governance organization was not found", nil)
	case http.StatusUnprocessableEntity:
		return newError("invalid_cursor", "Host rejected the governance cursor", nil)
	default:
		return newError("governance_unavailable", fmt.Sprintf("Host governance returned status %d", status), nil)
	}
}

func decodeGovernanceEvent(raw json.RawMessage) (GovernanceEvent, error) {
	if err := validateGovernanceObject(raw, governanceEventKeys); err != nil {
		return GovernanceEvent{}, err
	}
	var wire governanceEventWire
	if err := json.Unmarshal(raw, &wire); err != nil {
		return GovernanceEvent{}, newError("governance_protocol_invalid", "decode Host governance event", err)
	}
	if wire.EventSeq == nil || wire.CommandID == nil || wire.Kind == nil || wire.Desired == nil ||
		wire.PayloadHash == nil || wire.AppliedAt == nil {
		return GovernanceEvent{}, newError("host_field_gap", "Host governance event is missing a required field", nil)
	}
	if *wire.EventSeq <= 0 {
		return GovernanceEvent{}, newError("governance_protocol_invalid", "Host governance event sequence is not positive", nil)
	}
	if _, err := uuid.Parse(*wire.CommandID); err != nil {
		return GovernanceEvent{}, newError("governance_protocol_invalid", "Host governance command_id is not a UUID", err)
	}
	if !governancePayloadHashRE.MatchString(*wire.PayloadHash) {
		return GovernanceEvent{}, newError("governance_protocol_invalid", "Host governance payload_hash is invalid", nil)
	}
	if _, err := time.Parse(time.RFC3339Nano, *wire.AppliedAt); err != nil {
		return GovernanceEvent{}, newError("governance_protocol_invalid", "Host governance applied_at is not RFC3339", err)
	}
	event := GovernanceEvent{
		EventSeq:            *wire.EventSeq,
		CommandID:           *wire.CommandID,
		Kind:                *wire.Kind,
		TargetSubjectID:     wire.TargetSubjectID,
		Desired:             wire.Desired,
		PayloadHash:         *wire.PayloadHash,
		MemberRevision:      wire.MemberRevision,
		OrgRevision:         wire.OrgRevision,
		PermissionsRevision: wire.PermissionsRevision,
		AppliedAt:           *wire.AppliedAt,
	}
	if err := validateGovernanceEventShape(event); err != nil {
		return GovernanceEvent{}, err
	}
	return event, nil
}

func validateGovernanceEventShape(event GovernanceEvent) error {
	switch event.Kind {
	case "seat":
		if event.TargetSubjectID == nil || !subjectIDRE.MatchString(*event.TargetSubjectID) ||
			event.MemberRevision == nil || *event.MemberRevision <= 0 ||
			event.OrgRevision != nil || event.PermissionsRevision != nil {
			return newError("governance_protocol_invalid", "Host seat event has an invalid shape", nil)
		}
	case "assignment":
		if event.TargetSubjectID == nil || !subjectIDRE.MatchString(*event.TargetSubjectID) ||
			event.MemberRevision != nil || event.PermissionsRevision == nil || *event.PermissionsRevision <= 0 ||
			event.OrgRevision != nil {
			return newError("governance_protocol_invalid", "Host assignment event has an invalid shape", nil)
		}
	case "entitlement":
		if event.TargetSubjectID != nil || event.MemberRevision != nil ||
			event.OrgRevision == nil || *event.OrgRevision <= 0 || event.PermissionsRevision != nil {
			return newError("governance_protocol_invalid", "Host entitlement event has an invalid shape", nil)
		}
	default:
		return newError("governance_protocol_invalid", "Host governance event kind is not allowed", nil)
	}
	return nil
}

func decodeGovernanceGap(raw json.RawMessage) (GovernanceGap, error) {
	if err := validateGovernanceObject(raw, governanceGapKeys); err != nil {
		return GovernanceGap{}, err
	}
	var wire governanceGapWire
	if err := json.Unmarshal(raw, &wire); err != nil {
		return GovernanceGap{}, newError("governance_protocol_invalid", "decode Host governance gap", err)
	}
	if wire.FromSeq == nil || wire.ToSeqExclusive == nil || wire.SeatEvents == nil || wire.Coverage == nil {
		return GovernanceGap{}, newError("host_field_gap", "Host governance gap is missing a required field", nil)
	}
	if *wire.FromSeq <= 0 || *wire.ToSeqExclusive <= *wire.FromSeq {
		return GovernanceGap{}, newError("governance_protocol_invalid", "Host governance gap interval is invalid", nil)
	}
	if *wire.Coverage != "enumerated" && *wire.Coverage != "lost" {
		return GovernanceGap{}, newError("governance_protocol_invalid", "Host governance gap coverage is invalid", nil)
	}
	var seatEvents []json.RawMessage
	if err := json.Unmarshal(*wire.SeatEvents, &seatEvents); err != nil || seatEvents == nil {
		return GovernanceGap{}, newError("governance_protocol_invalid", "Host governance seat_events is not an array", err)
	}
	if *wire.Coverage == "lost" && len(seatEvents) != 0 {
		return GovernanceGap{}, newError("governance_protocol_invalid", "Host lost gap cannot enumerate seat events", nil)
	}
	for _, raw := range seatEvents {
		event, err := decodeGovernanceEvent(raw)
		if err != nil {
			return GovernanceGap{}, err
		}
		if event.Kind != "seat" || event.EventSeq < *wire.FromSeq || event.EventSeq >= *wire.ToSeqExclusive {
			return GovernanceGap{}, newError("governance_protocol_invalid", "Host gap seat event is outside the interval", nil)
		}
	}
	return GovernanceGap{
		FromSeq:        *wire.FromSeq,
		ToSeqExclusive: *wire.ToSeqExclusive,
		SeatEvents:     append(json.RawMessage(nil), (*wire.SeatEvents)...),
		Coverage:       *wire.Coverage,
	}, nil
}

func validateGovernanceObject(raw json.RawMessage, required []string) error {
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return newError("governance_protocol_invalid", "Host governance JSON has duplicate keys", err)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return newError("governance_protocol_invalid", "Host governance JSON value is not an object", err)
	}
	allowed := make(map[string]bool, len(required))
	for _, key := range required {
		allowed[key] = true
	}
	for key := range object {
		if !allowed[key] {
			return newError("governance_protocol_invalid", "Host governance JSON has an unknown field", nil)
		}
	}
	for _, key := range required {
		if _, ok := object[key]; !ok {
			return newError("host_field_gap", "Host governance JSON is missing a required field", nil)
		}
	}
	return nil
}

func rejectDuplicateJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var walk func() error
	walk = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := make(map[string]bool)
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok || seen[key] {
					return fmt.Errorf("invalid or duplicate object key")
				}
				seen[key] = true
				if err := walk(); err != nil {
					return err
				}
			}
			_, err = decoder.Token()
			return err
		case '[':
			for decoder.More() {
				if err := walk(); err != nil {
					return err
				}
			}
			_, err = decoder.Token()
			return err
		default:
			return fmt.Errorf("unexpected JSON delimiter")
		}
	}
	if err := walk(); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return fmt.Errorf("trailing JSON value")
	}
	return nil
}

func validateGovernancePage(page GovernancePage, after int64, limit int) error {
	expected := after + 1
	gapFrom := int64(0)
	gapTo := int64(0)
	for index, event := range page.Events {
		if event.EventSeq > page.LatestEventSeq {
			return newError("governance_protocol_invalid", "Host event is ahead of latest_event_seq", nil)
		}
		if index > 0 && event.EventSeq <= page.Events[index-1].EventSeq {
			return newError("governance_protocol_invalid", "Host governance events are not strictly increasing", nil)
		}
		if gapFrom == 0 && event.EventSeq != expected {
			gapFrom = expected
			gapTo = event.EventSeq
		}
		expected = event.EventSeq + 1
	}
	if gapFrom == 0 && expected <= page.LatestEventSeq && len(page.Events) < limit {
		gapFrom = expected
		gapTo = page.LatestEventSeq + 1
	}
	if gapFrom == 0 {
		if page.Gap != nil {
			return newError("governance_protocol_invalid", "Host reported a gap that is not present", nil)
		}
		return nil
	}
	if page.Gap == nil {
		return newError("governance_protocol_invalid", "Host omitted a governance gap", nil)
	}
	if page.Gap.FromSeq != gapFrom || page.Gap.ToSeqExclusive != gapTo || gapTo > page.LatestEventSeq+1 {
		return newError("governance_protocol_invalid", "Host governance gap does not match the event page", nil)
	}
	return nil
}
