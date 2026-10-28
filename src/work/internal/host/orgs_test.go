package host_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/host"
)

func TestListOrgsPaginates(t *testing.T) {
	var cursors []string
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/work-host/v2/orgs" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.URL.Query().Get("limit"); got != "100" {
			t.Errorf("limit = %q", got)
		}
		cursor := r.URL.Query().Get("cursor")
		cursors = append(cursors, cursor)
		w.Header().Set("Content-Type", "application/json")
		switch cursor {
		case "":
			fmt.Fprint(w, `{"items":[{"org_id":"org_1","name":"Acme","status":"active","home_region":"cn-north","revision":1,"gaps":[]}],"next_cursor":"page-2"}`)
		case "page-2":
			fmt.Fprint(w, `{"items":[{"org_id":"org_2","name":"Beta","status":"suspended","home_region":"cn-east","revision":7,"gaps":["name"]}],"next_cursor":null}`)
		default:
			t.Errorf("unexpected cursor %q", cursor)
			w.WriteHeader(http.StatusBadRequest)
		}
	})
	client := newClient(t, server.URL, pki, time.Now())

	orgs, err := client.ListOrgs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(orgs) != 2 {
		t.Fatalf("orgs = %#v", orgs)
	}
	if orgs[0].OrgID != "org_1" || orgs[0].Status != "active" || orgs[0].Revision != 1 {
		t.Fatalf("first org = %#v", orgs[0])
	}
	if orgs[1].OrgID != "org_2" || orgs[1].HomeRegion != "cn-east" || len(orgs[1].Gaps) != 1 || orgs[1].Gaps[0] != "name" {
		t.Fatalf("second org = %#v", orgs[1])
	}
	if len(cursors) != 2 || cursors[0] != "" || cursors[1] != "page-2" {
		t.Fatalf("cursors = %#v", cursors)
	}
}

func TestListMembersUsesOrgPathAndReadsSeat(t *testing.T) {
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/work-host/v2/orgs/org 1/members" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.URL.Query().Get("cursor"); got != "" {
			t.Errorf("cursor = %q, full reconcile must not send a revision cursor", got)
		}
		if got := r.URL.Query().Get("revision_after"); got != "" {
			t.Errorf("revision_after = %q, full reconcile must not send a watermark", got)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"items":[{"subject_id":"sub_1","status":"active","role":"owner","work_seat":true,"revision":3,"gaps":[]}],"next_cursor":null}`)
	})
	client := newClient(t, server.URL, pki, time.Now())

	members, err := client.ListMembers(context.Background(), "org 1", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 1 {
		t.Fatalf("members = %#v", members)
	}
	member := members[0]
	if member.OrgID != "org 1" || member.SubjectID != "sub_1" || member.Role != "owner" ||
		!member.WorkSeat || member.Revision != 3 {
		t.Fatalf("member = %#v", member)
	}
}

func TestListMembersSendsRevisionWatermark(t *testing.T) {
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("revision_after"); got != "42" {
			t.Errorf("revision_after = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"items":[],"next_cursor":null}`)
	})
	client := newClient(t, server.URL, pki, time.Now())

	if _, err := client.ListMembers(context.Background(), "org_1", 42); err != nil {
		t.Fatal(err)
	}
}

func TestListOrgsRejectsProtocolViolations(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		body     string
		wantCode string
	}{
		{"status", http.StatusBadGateway, `{}`, "directory_unavailable"},
		{"missing items", http.StatusOK, `{"next_cursor":null}`, "host_field_gap"},
		{"items not array", http.StatusOK, `{"items":{},"next_cursor":null}`, "directory_protocol_invalid"},
		{"missing cursor", http.StatusOK, `{"items":[]}`, "host_field_gap"},
		{"missing org field", http.StatusOK, `{"items":[{"org_id":"org_1","name":"Acme","status":"active","home_region":"cn-north","revision":1}],"next_cursor":null}`, "host_field_gap"},
		{"extra org field", http.StatusOK, `{"items":[{"org_id":"org_1","name":"Acme","status":"active","home_region":"cn-north","revision":1,"gaps":[],"extra":1}],"next_cursor":null}`, "directory_protocol_invalid"},
		{"bad org status", http.StatusOK, `{"items":[{"org_id":"org_1","name":"Acme","status":"deleted","home_region":"cn-north","revision":1,"gaps":[]}],"next_cursor":null}`, "directory_protocol_invalid"},
		{"unknown gap", http.StatusOK, `{"items":[{"org_id":"org_1","name":"Acme","status":"active","home_region":"cn-north","revision":1,"gaps":["seat"]}],"next_cursor":null}`, "directory_protocol_invalid"},
		{"trailing json", http.StatusOK, `{"items":[],"next_cursor":null}{}`, "directory_protocol_invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			client := newClient(t, server.URL, pki, time.Now())
			_, err := client.ListOrgs(context.Background())
			assertCode(t, err, tc.wantCode)
		})
	}
}

func TestListMembersRejectsProtocolViolations(t *testing.T) {
	cases := []struct {
		name     string
		body     string
		wantCode string
	}{
		{"missing seat", `{"items":[{"subject_id":"sub_1","status":"active","role":"owner","revision":1,"gaps":[]}],"next_cursor":null}`, "host_field_gap"},
		{"bad role", `{"items":[{"subject_id":"sub_1","status":"active","role":"ghost","work_seat":false,"revision":1,"gaps":[]}],"next_cursor":null}`, "directory_protocol_invalid"},
		{"bad status", `{"items":[{"subject_id":"sub_1","status":"deleted","role":"owner","work_seat":false,"revision":1,"gaps":[]}],"next_cursor":null}`, "directory_protocol_invalid"},
		{"negative revision", `{"items":[{"subject_id":"sub_1","status":"active","role":"owner","work_seat":false,"revision":-1,"gaps":[]}],"next_cursor":null}`, "directory_protocol_invalid"},
		{"unknown gap", `{"items":[{"subject_id":"sub_1","status":"active","role":"owner","work_seat":false,"revision":1,"gaps":["home_region"]}],"next_cursor":null}`, "directory_protocol_invalid"},
		{"extra field", `{"items":[{"subject_id":"sub_1","status":"active","role":"owner","work_seat":false,"revision":1,"gaps":[],"org_id":"org_1"}],"next_cursor":null}`, "directory_protocol_invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.body))
			})
			client := newClient(t, server.URL, pki, time.Now())
			_, err := client.ListMembers(context.Background(), "org_1", 0)
			assertCode(t, err, tc.wantCode)
		})
	}
}

func TestListOrgsRejectsCursorLoop(t *testing.T) {
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"items":[],"next_cursor":"same"}`)
	})
	client := newClient(t, server.URL, pki, time.Now())

	_, err := client.ListOrgs(context.Background())

	assertCode(t, err, "directory_protocol_invalid")
	var hostErr *host.Error
	if !errors.As(err, &hostErr) || !strings.Contains(hostErr.Message, "cursor repeated") {
		t.Fatalf("error = %v", err)
	}
}

func TestListMembersRejectsEmptyOrgID(t *testing.T) {
	server, pki := startHostServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("server must not be called without an organization id")
	})
	client := newClient(t, server.URL, pki, time.Now())

	_, err := client.ListMembers(context.Background(), "", 0)

	assertCode(t, err, "host_field_gap")
}
