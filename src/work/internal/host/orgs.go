package host

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	orgListPath              = "/work-host/v2/orgs"
	directoryPageLimit       = 100
	maxDirectoryPages        = 1000
	maxDirectoryResponseSize = 1 << 20
)

var (
	orgStatuses    = map[string]bool{"active": true, "suspended": true, "archived": true}
	memberStatuses = map[string]bool{"invited": true, "active": true, "suspended": true, "left": true}
	memberRoles    = map[string]bool{"owner": true, "admin": true, "member": true, "viewer": true}
	orgGaps        = map[string]bool{"name": true, "home_region": true, "revision": true}
	memberGaps     = map[string]bool{"subject_id": true, "role": true, "revision": true}
)

type Org struct {
	OrgID      string
	Name       string
	Status     string
	HomeRegion string
	Revision   int64
	Gaps       []string
}

type Member struct {
	OrgID     string
	SubjectID string
	Status    string
	Role      string
	WorkSeat  bool
	Revision  int64
	Gaps      []string
}

type directoryPage struct {
	Items      json.RawMessage `json:"items"`
	NextCursor json.RawMessage `json:"next_cursor"`
}

func (c *Client) ListOrgs(ctx context.Context) ([]Org, error) {
	var orgs []Org
	err := c.listPages(ctx, orgListPath, nil, func(raw json.RawMessage) error {
		org, err := decodeOrg(raw)
		if err != nil {
			return err
		}
		orgs = append(orgs, org)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return orgs, nil
}

func (c *Client) ListMembers(ctx context.Context, orgID string, revisionAfter int64) ([]Member, error) {
	if err := validatePathID("org_id", orgID); err != nil {
		return nil, err
	}
	if revisionAfter < 0 {
		return nil, newError("invalid_request", "revision_after must be non-negative", nil)
	}
	query := url.Values{}
	if revisionAfter > 0 {
		query.Set("revision_after", strconv.FormatInt(revisionAfter, 10))
	}
	var members []Member
	path := orgListPath + "/" + url.PathEscape(orgID) + "/members"
	err := c.listPages(ctx, path, query, func(raw json.RawMessage) error {
		member, err := decodeMember(raw)
		if err != nil {
			return err
		}
		member.OrgID = orgID
		members = append(members, member)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return members, nil
}

func (c *Client) listPages(
	ctx context.Context,
	path string,
	query url.Values,
	collect func(json.RawMessage) error,
) error {
	cursor := ""
	seen := make(map[string]bool)
	for page := 0; page < maxDirectoryPages; page++ {
		values := url.Values{"limit": []string{strconv.Itoa(directoryPageLimit)}}
		for key, entries := range query {
			values[key] = entries
		}
		if cursor != "" {
			values.Set("cursor", cursor)
		}
		body, err := c.getDirectoryPage(ctx, path+"?"+values.Encode())
		if err != nil {
			return err
		}
		if len(body.Items) == 0 {
			return newError("host_field_gap", "Host directory page is missing items", nil)
		}
		var items []json.RawMessage
		if err := json.Unmarshal(body.Items, &items); err != nil || items == nil {
			return newError("directory_protocol_invalid", "Host directory items is not an array", err)
		}
		for _, raw := range items {
			if err := collect(raw); err != nil {
				return err
			}
		}
		next, err := parseCursor(body.NextCursor)
		if err != nil {
			return err
		}
		if next == nil {
			return nil
		}
		if seen[*next] {
			return newError("directory_protocol_invalid", "Host directory cursor repeated", nil)
		}
		seen[*next] = true
		cursor = *next
	}
	return newError("directory_protocol_invalid", "Host directory pagination exceeded the page limit", nil)
}

func (c *Client) getDirectoryPage(ctx context.Context, pathAndQuery string) (directoryPage, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+pathAndQuery, nil)
	if err != nil {
		return directoryPage{}, newError("directory_unavailable", "build Host directory request", err)
	}
	request.Header.Set("Accept", "application/json")

	response, err := c.httpClient.Do(request)
	if err != nil {
		return directoryPage{}, newError("directory_unavailable", "call Host directory", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return directoryPage{}, newError(
			"directory_unavailable",
			fmt.Sprintf("Host directory returned status %d", response.StatusCode),
			nil,
		)
	}

	var page directoryPage
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxDirectoryResponseSize))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&page); err != nil {
		return directoryPage{}, newError("directory_protocol_invalid", "decode Host directory response", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return directoryPage{}, newError("directory_protocol_invalid", "Host directory response has trailing JSON", err)
	}
	return page, nil
}

func parseCursor(raw json.RawMessage) (*string, error) {
	if len(raw) == 0 {
		return nil, newError("host_field_gap", "Host directory page is missing next_cursor", nil)
	}
	if string(raw) == "null" {
		return nil, nil
	}
	var cursor string
	if err := json.Unmarshal(raw, &cursor); err != nil || cursor == "" {
		return nil, newError("directory_protocol_invalid", "Host directory cursor is not a non-empty string", err)
	}
	return &cursor, nil
}

func decodeOrg(raw json.RawMessage) (Org, error) {
	var wire struct {
		OrgID      *string   `json:"org_id"`
		Name       *string   `json:"name"`
		Status     *string   `json:"status"`
		HomeRegion *string   `json:"home_region"`
		Revision   *int64    `json:"revision"`
		Gaps       *[]string `json:"gaps"`
	}
	if err := decodeStrict(raw, &wire); err != nil {
		return Org{}, err
	}
	if wire.OrgID == nil || wire.Name == nil || wire.Status == nil ||
		wire.HomeRegion == nil || wire.Revision == nil || wire.Gaps == nil {
		return Org{}, newError("host_field_gap", "Host organization row is missing a required field", nil)
	}
	if err := validatePathID("org_id", *wire.OrgID); err != nil {
		return Org{}, err
	}
	if err := validateGaps(*wire.Gaps, orgGaps); err != nil {
		return Org{}, err
	}
	if !orgStatuses[*wire.Status] {
		return Org{}, newError("directory_protocol_invalid", "Host organization status is not allowed", nil)
	}
	if *wire.Revision < 0 {
		return Org{}, newError("directory_protocol_invalid", "Host organization revision is negative", nil)
	}
	if len(*wire.Name) > 255 {
		return Org{}, newError("directory_protocol_invalid", "Host organization name exceeds 255 bytes", nil)
	}
	return Org{
		OrgID:      *wire.OrgID,
		Name:       *wire.Name,
		Status:     *wire.Status,
		HomeRegion: *wire.HomeRegion,
		Revision:   *wire.Revision,
		Gaps:       *wire.Gaps,
	}, nil
}

func decodeMember(raw json.RawMessage) (Member, error) {
	var wire struct {
		SubjectID *string   `json:"subject_id"`
		Status    *string   `json:"status"`
		Role      *string   `json:"role"`
		WorkSeat  *bool     `json:"work_seat"`
		Revision  *int64    `json:"revision"`
		Gaps      *[]string `json:"gaps"`
	}
	if err := decodeStrict(raw, &wire); err != nil {
		return Member{}, err
	}
	if wire.SubjectID == nil || wire.Status == nil || wire.Role == nil ||
		wire.WorkSeat == nil || wire.Revision == nil || wire.Gaps == nil {
		return Member{}, newError("host_field_gap", "Host member row is missing a required field", nil)
	}
	if err := validateGaps(*wire.Gaps, memberGaps); err != nil {
		return Member{}, err
	}
	if !memberStatuses[*wire.Status] {
		return Member{}, newError("directory_protocol_invalid", "Host member status is not allowed", nil)
	}
	if !memberRoles[*wire.Role] {
		return Member{}, newError("directory_protocol_invalid", "Host member role is not allowed", nil)
	}
	if *wire.Revision < 0 {
		return Member{}, newError("directory_protocol_invalid", "Host member revision is negative", nil)
	}
	return Member{
		SubjectID: *wire.SubjectID,
		Status:    *wire.Status,
		Role:      *wire.Role,
		WorkSeat:  *wire.WorkSeat,
		Revision:  *wire.Revision,
		Gaps:      *wire.Gaps,
	}, nil
}

func decodeStrict(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return newError("directory_protocol_invalid", "decode Host directory row", err)
	}
	return nil
}

func validateGaps(gaps []string, allowed map[string]bool) error {
	if len(gaps) > len(allowed) {
		return newError("directory_protocol_invalid", "Host row reports too many gaps", nil)
	}
	for _, gap := range gaps {
		if !allowed[gap] {
			return newError("directory_protocol_invalid", "Host row reports an unknown gap", nil)
		}
	}
	return nil
}

func validatePathID(name, value string) error {
	if strings.TrimSpace(value) == "" {
		return newError("host_field_gap", name+" is empty", nil)
	}
	if len(value) > 128 || strings.ContainsRune(value, '\x00') {
		return newError("directory_protocol_invalid", name+" is not a valid path identifier", nil)
	}
	return nil
}
