package host_test

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"testing"
	"time"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/governance"
	"github.com/we-meet/work/internal/testpg"
)

func TestGovernanceHTTPPullerConsumesThroughDedicatedIdentity(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is required")
	}
	pki := newTestPKIWithIdentity(t, "work-governance-events")
	server := startHostServerWithPKI(t, pki, func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 ||
			r.TLS.PeerCertificates[0].Subject.CommonName != "work-governance-events" {
			t.Errorf("governance client certificate identity = %#v", r.TLS)
		}
		if r.URL.Path != "/work-host/v3/governance-events" || r.URL.Query().Get("org_id") != "org_gov_http" {
			t.Errorf("request = %s", r.URL.String())
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("after_event_seq") == "0" {
			_, _ = fmt.Fprintf(w, `{"events":[{"event_seq":1,"command_id":"10000000-0000-0000-0000-000000000001","kind":"seat","target_subject_id":"sub_a","desired":true,"payload_hash":"sha256:%s","member_revision":3,"org_revision":null,"permissions_revision":null,"applied_at":"2026-11-25T00:00:00Z"}],"latest_event_seq":1,"gap":null}`, strings.Repeat("a", 64))
			return
		}
		_, _ = w.Write([]byte(`{"events":[],"latest_event_seq":1,"gap":null}`))
	})

	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "governance_http")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = testpg.DropDatabase(ctx, admin, dbName) }()
	dbAdmin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer dbAdmin.Close(ctx)
	const orgID = "org_gov_http"
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
	if _, err := dbAdmin.Exec(ctx,
		`INSERT INTO work.governance_event_cursor (org_id, last_event_seq) VALUES ($1, 0)`, orgID); err != nil {
		t.Fatal(err)
	}
	pool, err := workdb.OpenPool(ctx, testpg.GovernanceURL(dbName), "governance-http-test")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	client := newClient(t, server.URL, pki, time.Now())
	puller, err := governance.New(client, &governance.PGStore{Pool: pool}, governance.Config{
		Orgs: []string{orgID}, PageLimit: 100, MaxPages: 10,
	}, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	report, err := puller.Pass(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if report.Failed() || report.EventsConsumed != 1 || report.DenysReleased != 1 {
		t.Fatalf("report = %#v", report)
	}
	var state string
	if err := dbAdmin.QueryRow(ctx,
		`SELECT state FROM work.access_restriction WHERE org_id = $1 AND subject_id = 'sub_a'`, orgID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "released" {
		t.Fatalf("deny state = %q", state)
	}
	var seat bool
	if err := dbAdmin.QueryRow(ctx,
		`SELECT work_seat FROM work.member WHERE org_id = $1 AND subject_id = 'sub_a'`, orgID).Scan(&seat); err != nil {
		t.Fatal(err)
	}
	if seat {
		t.Fatal("governance puller changed the directory projection")
	}
}
