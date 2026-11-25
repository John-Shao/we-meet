package host_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

const governanceSeatEvent = `{"event_seq":1,"command_id":"10000000-0000-0000-0000-000000000001","kind":"seat","target_subject_id":"sub_a","desired":true,"payload_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","member_revision":3,"org_revision":null,"permissions_revision":null,"applied_at":"2026-11-25T00:00:00Z"}`

func TestListGovernanceEventsUsesClosedWireContract(t *testing.T) {
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/work-host/v3/governance-events" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.URL.Query().Get("org_id"); got != "org 1" {
			t.Errorf("org_id = %q", got)
		}
		if got := r.URL.Query().Get("after_event_seq"); got != "0" {
			t.Errorf("after_event_seq = %q", got)
		}
		if got := r.URL.Query().Get("limit"); got != "100" {
			t.Errorf("limit = %q", got)
		}
		if got := r.Header.Get("X-Work-Request-ID"); got != "corr-gov" {
			t.Errorf("correlation = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"events":[%s],"latest_event_seq":1,"gap":null}`, governanceSeatEvent)
	})
	client := newClient(t, server.URL, pki, time.Now())

	page, err := client.ListGovernanceEvents(context.Background(), "org 1", 0, 100, "corr-gov")
	if err != nil {
		t.Fatal(err)
	}
	if page.LatestEventSeq != 1 || page.Gap != nil || len(page.Events) != 1 {
		t.Fatalf("page = %#v", page)
	}
	event := page.Events[0]
	if event.EventSeq != 1 || event.CommandID != "10000000-0000-0000-0000-000000000001" ||
		event.Kind != "seat" || event.TargetSubjectID == nil || *event.TargetSubjectID != "sub_a" ||
		event.Desired == nil || !*event.Desired || event.MemberRevision == nil || *event.MemberRevision != 3 {
		t.Fatalf("event = %#v", event)
	}
}

func TestListGovernanceEventsAcceptsInteriorAndTrailingGaps(t *testing.T) {
	cases := []struct {
		name string
		body string
		from int64
		to   int64
	}{
		{
			name: "interior",
			body: `{"events":[` + governanceSeatEvent + `,{"event_seq":3,"command_id":"10000000-0000-0000-0000-000000000003","kind":"seat","target_subject_id":"sub_a","desired":false,"payload_hash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","member_revision":4,"org_revision":null,"permissions_revision":null,"applied_at":"2026-11-25T00:00:01Z"}],"latest_event_seq":3,"gap":{"from_seq":2,"to_seq_exclusive":3,"seat_events":[],"coverage":"lost"}}`,
			from: 2,
			to:   3,
		},
		{
			name: "trailing",
			body: `{"events":[` + governanceSeatEvent + `],"latest_event_seq":3,"gap":{"from_seq":2,"to_seq_exclusive":4,"seat_events":[],"coverage":"lost"}}`,
			from: 2,
			to:   4,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, pki := startHostServer(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.body))
			})
			client := newClient(t, server.URL, pki, time.Now())
			page, err := client.ListGovernanceEvents(context.Background(), "org_1", 0, 100, "")
			if err != nil {
				t.Fatal(err)
			}
			if page.Gap == nil || page.Gap.FromSeq != tc.from || page.Gap.ToSeqExclusive != tc.to || page.Gap.Coverage != "lost" {
				t.Fatalf("gap = %#v", page.Gap)
			}
		})
	}
}

func TestListGovernanceEventsRejectsProtocolViolations(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		body     string
		wantCode string
	}{
		{"forbidden", http.StatusForbidden, `{}`, "client_identity_invalid"},
		{"unknown org", http.StatusNotFound, `{}`, "org_not_found"},
		{"bad cursor", http.StatusUnprocessableEntity, `{}`, "invalid_cursor"},
		{"unavailable", http.StatusServiceUnavailable, `{}`, "governance_unavailable"},
		{"missing events", http.StatusOK, `{"latest_event_seq":0,"gap":null}`, "host_field_gap"},
		{"missing latest", http.StatusOK, `{"events":[],"gap":null}`, "host_field_gap"},
		{"extra field", http.StatusOK, `{"events":[],"latest_event_seq":0,"gap":null,"extra":1}`, "governance_protocol_invalid"},
		{"duplicate key", http.StatusOK, `{"events":[],"events":[],"latest_event_seq":0,"gap":null}`, "governance_protocol_invalid"},
		{"wrong-case key", http.StatusOK, `{"Events":[],"latest_event_seq":0,"gap":null}`, "governance_protocol_invalid"},
		{"missing gap key", http.StatusOK, `{"events":[],"latest_event_seq":0}`, "host_field_gap"},
		{"trailing json", http.StatusOK, `{"events":[],"latest_event_seq":0,"gap":null}{}`, "governance_protocol_invalid"},
		{"bad uuid", http.StatusOK, strings.Replace(governanceSeatEvent, "10000000-0000-0000-0000-000000000001", "bad", 1), "governance_protocol_invalid"},
		{"bad hash", http.StatusOK, strings.Replace(governanceSeatEvent, "sha256:aaaa", "sha256:zzzz", 1), "governance_protocol_invalid"},
		{"seat without subject", http.StatusOK, strings.Replace(governanceSeatEvent, `"target_subject_id":"sub_a"`, `"target_subject_id":null`, 1), "governance_protocol_invalid"},
		{"seat with irrelevant revision", http.StatusOK, strings.Replace(governanceSeatEvent, `"org_revision":null`, `"org_revision":1`, 1), "governance_protocol_invalid"},
		{"omitted gap", http.StatusOK, `{"events":[` + governanceSeatEvent + `],"latest_event_seq":3,"gap":null}`, "governance_protocol_invalid"},
		{"wrong gap interval", http.StatusOK, `{"events":[` + governanceSeatEvent + `],"latest_event_seq":3,"gap":{"from_seq":2,"to_seq_exclusive":3,"seat_events":[],"coverage":"lost"}}`, "governance_protocol_invalid"},
		{"lost with enumeration", http.StatusOK, `{"events":[` + governanceSeatEvent + `],"latest_event_seq":3,"gap":{"from_seq":2,"to_seq_exclusive":4,"seat_events":[` + governanceSeatEvent + `],"coverage":"lost"}}`, "governance_protocol_invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, pki := startHostServer(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			client := newClient(t, server.URL, pki, time.Now())
			_, err := client.ListGovernanceEvents(context.Background(), "org_1", 0, 100, "")
			assertCode(t, err, tc.wantCode)
		})
	}
}

func TestListGovernanceEventsRejectsInvalidArguments(t *testing.T) {
	server, pki := startHostServer(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("server must not be called for invalid arguments")
	})
	client := newClient(t, server.URL, pki, time.Now())
	for _, tc := range []struct {
		org   string
		after int64
		limit int
		code  string
	}{
		{"", 0, 100, "host_field_gap"},
		{"org_1", -1, 100, "invalid_cursor"},
		{"org_1", 0, 0, "invalid_cursor"},
		{"org_1", 0, 101, "invalid_cursor"},
	} {
		_, err := client.ListGovernanceEvents(context.Background(), tc.org, tc.after, tc.limit, "")
		assertCode(t, err, tc.code)
	}
}
