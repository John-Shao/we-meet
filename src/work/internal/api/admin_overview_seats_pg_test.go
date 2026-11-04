package api_test

// D2' says pagination totals come from a projection, not from the page
// (pagination.totalsFromProjectionNotPage), and the contract describes seats.total as
// "非 left 成员数；不受列表分页影响". The SQL proves it structurally -
// work.admin_overview aggregates over work.member with no limit parameter at all
// (migrations/baseline/0002_initial_r0a_schema.sql:4012-4015, :4034) - but no test pinned
// the two numbers against each other. The overview endpoint is only ever checked for a
// 200 today (admin_test.go:54, audit_export_gate_pg_test.go:163), so a future refactor
// that derived seats.total from the seats page would not be caught.
//
// This is asserted at the database layer on purpose: the claim is about the projection,
// and going through HTTP would add role and CSRF plumbing without adding coverage.

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/testpg"
)

func TestAdminOverviewSeatTotalsIgnoreTheSeatsPage(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx := context.Background()
	_, dbName := newBootstrapDB(t, true, true)
	conn, err := pgx.Connect(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	// Own the fixture: one owner, two active seat-holders, one invited without a seat,
	// one member who left. Any organization seed from the bootstrap fixtures is removed
	// first so the expected numbers are exact rather than relative.
	seed := `
		SELECT set_config('app.org_id', 'org_a', false);
		SELECT set_config('app.subject_id', 'sub_owner', false);
		DELETE FROM work.member WHERE org_id = 'org_a';
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat) VALUES
		  ('org_a', 'sub_owner',   'active',   'owner',  true),
		  ('org_a', 'sub_seat_two', 'active',  'member', true),
		  ('org_a', 'sub_invited',  'invited', 'member', false),
		  ('org_a', 'sub_left',     'left',    'member', false);
	`
	if _, err := conn.Exec(ctx, seed); err != nil {
		t.Fatal(err)
	}

	var pageRows int
	if err := conn.QueryRow(ctx,
		`SELECT count(*) FROM work.list_seats('org_a', 'sub_owner', NULL, 2)`).Scan(&pageRows); err != nil {
		t.Fatal(err)
	}
	if pageRows != 2 {
		t.Fatalf("list_seats with limit 2 returned %d rows, want 2 - the page is not capped, "+
			"so the totals comparison below would be meaningless", pageRows)
	}

	var total, active int
	err = conn.QueryRow(ctx, `
		SELECT (work.admin_overview('org_a', 'sub_owner')::jsonb #>> '{seats,total}')::int,
		       (work.admin_overview('org_a', 'sub_owner')::jsonb #>> '{seats,active}')::int
	`).Scan(&total, &active)
	if err != nil {
		t.Fatal(err)
	}

	// Three members are not 'left', so the projection reports 3 while the page reports 2.
	// If a refactor ever derives seats.total from the page, this becomes 2 and fails.
	if total != 3 {
		t.Errorf("seats.total = %d, want 3 (non-left members); the page held %d rows, so a "+
			"value of %d would mean the total came from the page", total, pageRows, pageRows)
	}
	// Only active members holding a work seat count as active.
	if active != 2 {
		t.Errorf("seats.active = %d, want 2 (active AND work_seat)", active)
	}

	// The negative half: a left member must not move the total, so removing them changes
	// nothing and the aggregate stays tied to status rather than to row count.
	if _, err := conn.Exec(ctx, `
		SELECT set_config('app.org_id', 'org_a', false);
		DELETE FROM work.member WHERE org_id = 'org_a' AND subject_id = 'sub_invited'`); err != nil {
		t.Fatal(err)
	}
	var totalAfter int
	err = conn.QueryRow(ctx, `
		SELECT (work.admin_overview('org_a', 'sub_owner')::jsonb #>> '{seats,total}')::int
	`).Scan(&totalAfter)
	if err != nil {
		t.Fatal(err)
	}
	if totalAfter != 2 {
		t.Errorf("seats.total after removing an invited member = %d, want 2 - the aggregate must "+
			"follow the data, not a cached or page-derived number", totalAfter)
	}
}
