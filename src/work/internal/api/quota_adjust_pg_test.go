package api_test

import (
	"context"
	"testing"

	"github.com/we-meet/work/internal/testpg"
)

// work.adjust_quota is the correction entry on the metering ledger (D-08: the platform only
// counts tokens, the bill lives with the cloud vendor), and it has no caller at all - not in
// Go, not inside SQL, not in any test. `grep adjust_quota` in the migration tree hits exactly
// two lines: the CREATE and the GRANT to work_worker. So the four rules its body encodes had
// never been executed: a correction only ever appends an 'adjust' entry instead of rewriting
// the settled amount (baseline/0002:1022), the reservation must already be settled, the
// settlement revision must move forward, and a replay of the same revision with the same
// amount is a silent no-op.
//
// The facts are built through the production chain rather than by inserting ledger rows:
// reserve_quota, then settle_quota, then adjust_quota - all as work_worker. The quota account
// itself is not seeded either: inserting an organization provisions its default account
// through the org trigger (increments/0006:72 inside provision_org_defaults, called by the
// AFTER INSERT trigger at 0006:107-109 - 'default' for the current period, soft, 1,000,000
// tokens), so the tests resolve that row instead of hard-coding a period that would stop
// existing in December.

const (
	quotaOperation = "71111111-1111-4111-8111-222222222222"
	quotaReason    = "metering_correction"

	// quotaAcct resolves the organization's provisioned account in one place, so every
	// statement below reads and writes the same row.
	quotaAcct = `WITH acct AS (
		SELECT id, account_key, period_id FROM work.quota_account
		WHERE org_id = 'org_a' ORDER BY created_at LIMIT 1)`
)

// seedQuotaOperation adds the operation row reserve_quota binds a reservation to; it has to
// be in a reservable state, which is what the run flow leaves behind before dispatch.
func seedQuotaOperation(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, kind, request_hash, state, revision)
		VALUES ('` + quotaOperation + `', 'org_a', '` + runA + `', 'model:adjust', 'model',
		        'sha256:adjust', 'authorized', 0);
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

// workerQuota runs one ledger command as work_worker inside the organization context the
// scheduled jobs use, and returns whatever the function produces.
func workerQuota(t *testing.T, dbName, statement string, args ...any) (string, error) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.WorkerURL(dbName))
	if err != nil {
		return "", err
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', true)`); err != nil {
		return "", err
	}
	var out string
	if err := tx.QueryRow(ctx, statement, args...).Scan(&out); err != nil {
		return "", err
	}
	return out, tx.Commit(ctx)
}

// reserveAndSettle walks the production chain and returns the reservation id, so each test
// starts from a ledger the control plane itself produced.
func reserveAndSettle(t *testing.T, dbName string, reserved, reported, revision int) string {
	t.Helper()
	reservationID, err := workerQuota(t, dbName, quotaAcct+`
		SELECT work.reserve_quota('org_a', acct.account_key, acct.period_id,
			$1::uuid, $2::bigint)::text
		FROM acct`, quotaOperation, reserved)
	if err != nil {
		t.Fatalf("reserve_quota: %v", err)
	}
	if _, err := workerQuota(t, dbName,
		`SELECT work.settle_quota($1::uuid, $2::bigint,
			jsonb_build_object('reported', $2::int), $3::int)::text`,
		reservationID, reported, revision); err != nil {
		t.Fatalf("settle_quota: %v", err)
	}
	return reservationID
}

// ledgerFacts returns "<settled>/<reserved>/<version>|<kind:sum,...>" in one read, so the
// append-only rule is visible as the settle line never changing while adjust lines appear.
func ledgerFacts(t *testing.T, dbName string) string {
	t.Helper()
	return opsScalar(t, dbName, quotaAcct+`
		SELECT q.settled_tokens::text || '/' || q.reserved_tokens::text || '/' ||
		       q.version::text || '|' ||
		       coalesce((SELECT string_agg(e.kind || ':' || e.total::text, ',' ORDER BY e.kind)
		                 FROM (
		                   SELECT kind, sum(amount_tokens) AS total
		                   FROM work.quota_entry WHERE account_id = acct.id
		                   GROUP BY kind
		                 ) e), '-')
		FROM acct JOIN work.quota_account q ON q.id = acct.id`)
}

func reservationFacts(t *testing.T, dbName, reservationID string) string {
	t.Helper()
	return opsScalar(t, dbName, `
		SELECT state || '/' || settlement_revision::text
		FROM work.quota_reservation WHERE id = $1::uuid`, reservationID)
}

func TestAdjustQuotaAppendsWithoutRewritingSettledAmount(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	seedQuotaOperation(t, dbName)

	// 1000 reserved, 900 reported and settled: the ledger carries reserve:1000 and
	// settle:900, and the account sits at 900 settled. From here a correction must show up as
	// a new line, never as an edit of the settlement.
	reservationID := reserveAndSettle(t, dbName, 1000, 900, 1)
	if got := ledgerFacts(t, dbName); got != "900/0/2|reserve:1000,settle:900" {
		t.Fatalf("ledger before the correction = %s, want 900 settled at version 2 with one "+
			"reserve and one settle line", got)
	}
	if got := reservationFacts(t, dbName, reservationID); got != "settled/1" {
		t.Fatalf("reservation before the correction = %s, want settled at revision 1", got)
	}

	if _, err := workerQuota(t, dbName,
		`SELECT work.adjust_quota($1::uuid, $2::bigint, $3::text, $4::int)::text`,
		reservationID, -100, quotaReason, 2); err != nil {
		t.Fatalf("adjust_quota: %v", err)
	}
	if got := ledgerFacts(t, dbName); got != "800/0/3|adjust:-100,reserve:1000,settle:900" {
		t.Fatalf("ledger after the correction = %s, want the account at 800 and the settle "+
			"line still reading 900", got)
	}
	if got := reservationFacts(t, dbName, reservationID); got != "settled/2" {
		t.Fatalf("reservation after the correction = %s, want the cursor moved to 2", got)
	}
	usage := opsScalar(t, dbName, `
		SELECT amount_tokens::text || '/' || settlement_revision::text || '/' ||
		       coalesce(usage->>'reason', '-') || '/' ||
		       coalesce(reservation_id = $1::uuid, false)::text || '/' ||
		       coalesce(operation_id = $2::uuid, false)::text
		FROM work.quota_entry WHERE kind = 'adjust'`, reservationID, quotaOperation)
	if usage != "-100/2/"+quotaReason+"/true/true" {
		t.Fatalf("adjust entry = %s, want amount, revision, reason and both foreign keys "+
			"pointing at the reservation it corrects", usage)
	}

	// Replaying the same correction (same revision, same amount) is the retry a worker sends
	// when its first answer was lost. It must not double-count against the customer.
	if _, err := workerQuota(t, dbName,
		`SELECT work.adjust_quota($1::uuid, $2::bigint, $3::text, $4::int)::text`,
		reservationID, -100, quotaReason, 2); err != nil {
		t.Fatalf("replayed correction: %v", err)
	}
	if got := ledgerFacts(t, dbName); got != "800/0/3|adjust:-100,reserve:1000,settle:900" {
		t.Fatalf("ledger after a replay = %s, want nothing added", got)
	}
	if count := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.quota_entry WHERE kind = 'adjust'`); count != "1" {
		t.Fatalf("adjust entries after a replay = %s, want 1", count)
	}

	// A second correction at a newer revision is allowed and keeps appending.
	if _, err := workerQuota(t, dbName,
		`SELECT work.adjust_quota($1::uuid, $2::bigint, $3::text, $4::int)::text`,
		reservationID, -50, quotaReason, 3); err != nil {
		t.Fatalf("second correction: %v", err)
	}
	if got := ledgerFacts(t, dbName); got != "750/0/4|adjust:-150,reserve:1000,settle:900" {
		t.Fatalf("ledger after a second correction = %s, want 750 with both corrections "+
			"visible as one summed adjust line", got)
	}
}

func TestAdjustQuotaRefusesStaleRevisionsAndUnsettledReservations(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	seedQuotaOperation(t, dbName)
	settled := reserveAndSettle(t, dbName, 1000, 900, 1)

	// A held reservation is not correctable: the figure it holds is a reservation, not a
	// settlement, so an adjust against it would count twice against the vendor bill.
	heldID, err := workerQuota(t, dbName, quotaAcct+`
		SELECT work.reserve_quota('org_a', acct.account_key, acct.period_id,
			$1::uuid, $2::bigint)::text
		FROM acct`, quotaOperation, 500)
	if err != nil {
		t.Fatalf("second reserve for the held case: %v", err)
	}

	cases := []struct {
		name          string
		reservationID string
		delta         int
		revision      int
		state         string
		msg           string
	}{
		{"held reservation", heldID, -10, 1, "P0001", "reservation_not_settled"},
		{"unknown reservation", "71111111-1111-4111-8111-999999999999", -10, 1,
			"P0002", "reservation_not_found"},
		// Same revision, different amount: the shape of two corrections that disagree. The
		// ledger has to refuse rather than pick a winner.
		{"same revision other amount", settled, -200, 1, "P0001",
			"settlement_revision_not_monotonic"},
		{"stale revision", settled, -20, 0, "P0001", "settlement_revision_not_monotonic"},
	}
	for _, tc := range cases {
		if _, err := workerQuota(t, dbName,
			`SELECT work.adjust_quota($1::uuid, $2::bigint, $3::text, $4::int)::text`,
			tc.reservationID, tc.delta, quotaReason, tc.revision); err == nil {
			t.Fatalf("%s: call succeeded, want %s", tc.name, tc.msg)
		} else if pgErr := opsPgError(t, err); pgErr.SQLState() != tc.state ||
			pgErr.Message != tc.msg {
			t.Fatalf("%s = %s %q, want %s %q", tc.name,
				pgErr.SQLState(), pgErr.Message, tc.state, tc.msg)
		}
	}

	if got := ledgerFacts(t, dbName); got != "900/500/3|reserve:1500,settle:900" {
		t.Fatalf("ledger after refusals = %s, want 900 settled with 500 still held and no "+
			"adjust line", got)
	}
	if got := reservationFacts(t, dbName, settled); got != "settled/1" {
		t.Fatalf("settled reservation after refusals = %s, want still revision 1", got)
	}
	if got := reservationFacts(t, dbName, heldID); got != "held/0" {
		t.Fatalf("held reservation after refusals = %s, want held at revision 0", got)
	}
}

func TestAdjustQuotaRefusesWithoutTheWorkerGrant(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	seedQuotaOperation(t, dbName)
	reservationID := reserveAndSettle(t, dbName, 1000, 900, 1)

	// EXECUTE goes to work_worker only (baseline/0002:5219). An application-role caller that
	// could adjust the ledger could move a customer's counted usage at will.
	err := func() error {
		ctx := context.Background()
		conn, openErr := testpg.Open(ctx, testpg.AppURL(dbName))
		if openErr != nil {
			return openErr
		}
		defer conn.Close(ctx)
		tx, beginErr := conn.Begin(ctx)
		if beginErr != nil {
			return beginErr
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, e := tx.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', true)`); e != nil {
			return e
		}
		var out string
		return tx.QueryRow(ctx,
			`SELECT work.adjust_quota($1::uuid, $2::bigint, $3::text, $4::int)::text`,
			reservationID, -100, quotaReason, 2).Scan(&out)
	}()
	if err == nil {
		t.Fatal("work_api adjusted the ledger; only work_worker is granted")
	}
	pgErr := opsPgError(t, err)
	if pgErr.SQLState() != "42501" ||
		pgErr.Message != "permission denied for function adjust_quota" {
		t.Fatalf("app-role refusal = %s %q, want permission denied for function adjust_quota",
			pgErr.SQLState(), pgErr.Message)
	}
	if got := ledgerFacts(t, dbName); got != "900/0/2|reserve:1000,settle:900" {
		t.Fatalf("ledger after the refused call = %s, want untouched", got)
	}
}
