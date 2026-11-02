package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/api"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/testpg"
)

// The export row's lifetime rules (P1-2 in the baseline comments): the download token
// may not outlive the file, a file past its retention refuses both a new ticket and a
// token issued before it expired, and an expired *token* must not waste the job - the
// admin can simply ask for another ticket while the file is still ready.
//
// None of the three codes had a test: grep for audit_export_expired,
// download_token_expired and expire_due_audit_exports across the API and export test
// files returned nothing at all.

func expireReadyExports(t *testing.T, dbName string) int {
	t.Helper()
	ctx := context.Background()
	pool, err := workdb.OpenPool(ctx, testpg.WorkerURL(dbName), "work-export-expire-test")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	swept := -1
	err = workdb.WithWorkerOrgContext(ctx, pool, testOrg, func(tx pgx.Tx) error {
		// The sweep entrypoint takes its clock as a parameter, so "the retention
		// deadline passed" is produced by the production function rather than by
		// editing the row.
		return tx.QueryRow(ctx,
			`SELECT work.expire_due_audit_exports(now() + interval '1 hour')`).Scan(&swept)
	})
	if err != nil {
		t.Fatal(err)
	}
	return swept
}

func backdateDownloadExpiry(t *testing.T, dbName, exportID string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	// The handler hardcodes a 300 second token TTL and redeem takes no clock
	// argument, so the only way to reach a lapsed token is to let time pass. This
	// UPDATE is the elapsed clock, not a state the system cannot produce.
	if _, err := conn.Exec(ctx, `
		UPDATE work.audit_export
		SET download_expires_at = now() - interval '1 second'
		WHERE id = $1 AND org_id = $2 AND status = 'ready'`, exportID, testOrg,
	); err != nil {
		t.Fatal(err)
	}
}

// shredExpiredExports runs the body-shredding sweep as the scheduled job does, after the
// retention sweep has already moved the row to expired.
func shredExpiredExports(t *testing.T, dbName string) int {
	t.Helper()
	ctx := context.Background()
	pool, err := workdb.OpenPool(ctx, testpg.WorkerURL(dbName), "work-export-shred-test")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	swept := -1
	err = workdb.WithWorkerOrgContext(ctx, pool, testOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.shred_due_audit_exports()`).Scan(&swept)
	})
	if err != nil {
		t.Fatal(err)
	}
	return swept
}

// exportShredFacts reads the two halves of the rule in one line: the hand-off the shredder
// consumes, and what is left of the job row. The row is supposed to survive - its metadata
// is an audit fact - with only the content reference withdrawn (baseline/0002:5061).
func exportShredFacts(t *testing.T, dbName, exportID string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var handoff, row string
	if err := conn.QueryRow(ctx, `
		SELECT count(*)::text || '/' ||
		       coalesce(max(payload->>'content_refs'), '-') || '/' ||
		       coalesce(max(payload->>'audit_export_id'), '-')
		FROM work.outbox
		WHERE payload->>'kind' = 'content_shred' AND aggregate_type = 'content'
		  AND aggregate_id = $1::uuid`, exportID,
	).Scan(&handoff); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `
		SELECT status || '/' ||
		       coalesce(content_ref, 'NULL') || '/' ||
		       coalesce(content_hash, 'NULL') || '/' ||
		       bytes::text || '/' || row_count::text
		FROM work.audit_export WHERE id = $1 AND org_id = $2`, exportID, testOrg,
	).Scan(&row); err != nil {
		t.Fatal(err)
	}
	var audit string
	if err := conn.QueryRow(ctx, `
		SELECT count(*)::text || '/' || coalesce(max(metadata->>'count'), '-')
		FROM work.audit_event WHERE action = 'audit_export.shredded'`).Scan(&audit); err != nil {
		t.Fatal(err)
	}
	return handoff + " | " + row + " | " + audit
}

func issuedToken(t *testing.T, request func(string, string, string, ...string) *http.Response, exportID string) string {
	t.Helper()
	response := request(http.MethodPost,
		api.AdminAuditExportsPath+"/"+exportID+"/download-ticket", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("ticket status = %d body=%s",
			response.StatusCode, readBody(response))
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if body.Token == "" {
		t.Fatal("ticket response carried no token")
	}
	return body.Token
}

func TestAuditExportTokenAndFileExpiry(t *testing.T) {
	request, dbName := adminExportHarness(t)

	created := request(http.MethodPost, api.AdminAuditExportsPath,
		adminExportBody("expiry-export-000001"))
	if created.StatusCode != http.StatusAccepted {
		t.Fatalf("create status = %d body=%s", created.StatusCode, readBody(created))
	}
	exportID := decodeExportID(t, created)
	if exportID == "" {
		t.Fatal("create returned no export id")
	}
	markExportReady(t, dbName, exportID)

	// Phase one: the token lapses while the file is still inside its retention.
	token := issuedToken(t, request, exportID)
	backdateDownloadExpiry(t, dbName, exportID)
	stale := request(http.MethodGet, api.AdminAuditExportsPath+"/"+exportID+"/content",
		"", "X-Download-Token", token)
	assertAPICode(t, stale, http.StatusGone, "download_token_expired")

	// A lapsed token is not a lost export: the row is still ready, so a fresh ticket
	// must succeed and the new token must download.
	fresh := issuedToken(t, request, exportID)
	recovered := request(http.MethodGet, api.AdminAuditExportsPath+"/"+exportID+"/content",
		"", "X-Download-Token", fresh)
	if recovered.StatusCode != http.StatusOK {
		t.Fatalf("download after a lapsed token = %d body=%s",
			recovered.StatusCode, readBody(recovered))
	}
	recovered.Body.Close()

	// Phase two: the file itself passes its retention. Expire it by calling the
	// production sweep with a clock past the deadline, then require both entrypoints
	// to refuse - the ticket path and a token that was issued earlier and is still
	// held by the client. The expired branch is checked before the spent-token one,
	// so a download that already happened must not soften the answer.
	if swept := expireReadyExports(t, dbName); swept != 1 {
		t.Fatalf("expiry sweep swept %d exports, want the one ready row", swept)
	}
	if status, _ := exportStatus(t, dbName, exportID); status != "expired" {
		t.Fatalf("export status after the sweep = %q, want expired", status)
	}
	lateTicket := request(http.MethodPost,
		api.AdminAuditExportsPath+"/"+exportID+"/download-ticket", "")
	assertAPICode(t, lateTicket, http.StatusGone, "audit_export_expired")
	lateRedeem := request(http.MethodGet, api.AdminAuditExportsPath+"/"+exportID+"/content",
		"", "X-Download-Token", fresh)
	assertAPICode(t, lateRedeem, http.StatusGone, "audit_export_expired")

	// Phase three: retention has passed, so the shredder's sweep owes the next step - and
	// the two sweeps have never been run in sequence anywhere. The relay test hand-seeds an
	// already-expired row (suspended_obligations_test.go:105), so nothing connected
	// expire_due_audit_exports to shred_due_audit_exports. The rule is asymmetric on
	// purpose: the reference goes, the job row stays, because the row's metadata is itself
	// an audit fact (baseline/0002:5061).
	if swept := shredExpiredExports(t, dbName); swept != 1 {
		t.Fatalf("shred sweep swept %d, want the one expired row", swept)
	}
	want := "1/[\"content://work/audit/gate-1\"]/" + exportID +
		" | expired/NULL/NULL/120/3 | 1/1"
	if got := exportShredFacts(t, dbName, exportID); got != want {
		t.Fatalf("shred facts = %q, want one hand-off carrying only the export's own ref, "+
			"the row kept at expired with 120 bytes / 3 rows withdrawn only by reference, "+
			"and one audit count of 1 (%s)", got, want)
	}

	// A second sweep must not re-deliver a reference the row no longer carries, and a
	// repeat must not double-count the audit either.
	if again := shredExpiredExports(t, dbName); again != 0 {
		t.Fatalf("second shred sweep swept %d, want 0", again)
	}
	if got := exportShredFacts(t, dbName, exportID); got != want {
		t.Fatalf("shred facts after a repeat sweep = %q, want unchanged (%s)", got, want)
	}
}
