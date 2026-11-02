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

// The audit-export worker row of the fault matrix says the switch stops *new* jobs but
// leaves an already-ready file downloadable once, because that is how an admin reads
// the audit trail of the incident that caused the suspension
// (work-r0a-orchestration-design-2026-10-25.md:508, work-r0a-c03-u3-drills-2026-10-27.md:80).
// Migration 0026 pinned the refusing half; this pins the other half through the
// endpoint, together with the refusal, so the two are asserted as one behaviour rather
// than as two unrelated rules.

func markExportReady(t *testing.T, dbName, exportID string) {
	t.Helper()
	ctx := context.Background()
	pool, err := workdb.OpenPool(ctx, testpg.WorkerURL(dbName), "work-export-ready-test")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	err = workdb.WithWorkerOrgContext(ctx, pool, testOrg, func(tx pgx.Tx) error {
		var claimed []byte
		if err := tx.QueryRow(ctx,
			`SELECT work.claim_audit_export($1::uuid, $2, 600)`, exportID, "worker-ready",
		).Scan(&claimed); err != nil {
			return err
		}
		var completed []byte
		return tx.QueryRow(ctx, `
			SELECT work.complete_audit_export(
			  $1::uuid, $2, 'content://work/audit/gate-1', 'sha256:0123456789abcdef',
			  120, 3, 3600)`, exportID, "worker-ready",
		).Scan(&completed)
	})
	if err != nil {
		t.Fatalf("drive the export to ready: %v", err)
	}
}

func exportStatus(t *testing.T, dbName, exportID string) (string, bool) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var status string
	var downloaded bool
	if err := conn.QueryRow(ctx, `
		SELECT status, downloaded_at IS NOT NULL FROM work.audit_export
		WHERE id = $1 AND org_id = $2`, exportID, testOrg,
	).Scan(&status, &downloaded); err != nil {
		t.Fatal(err)
	}
	return status, downloaded
}

func TestReadyAuditExportStaysDownloadableWhileOrgSuspended(t *testing.T) {
	request, dbName := adminExportHarness(t)

	created := request(http.MethodPost, api.AdminAuditExportsPath,
		adminExportBody("dl-suspended-000001"))
	if created.StatusCode != http.StatusAccepted {
		t.Fatalf("create status = %d body=%s", created.StatusCode, readBody(created))
	}
	exportID := decodeExportID(t, created)
	if exportID == "" {
		t.Fatal("create returned no export id")
	}
	markExportReady(t, dbName, exportID)
	if status, _ := exportStatus(t, dbName, exportID); status != "ready" {
		t.Fatalf("export status after completion = %q, want ready", status)
	}

	setOrgFlags(t, dbName, "operator_suspended = true")

	// Refusing half, asserted in the same breath: the switch does stop a new export.
	blocked := request(http.MethodPost, api.AdminAuditExportsPath,
		adminExportBody("dl-suspended-000002"))
	assertAPICode(t, blocked, http.StatusConflict, "org_operator_suspended")
	if rows := exportRowCount(t, dbName); rows != 1 {
		t.Fatalf("export rows while suspended = %d, want only the pre-switch job", rows)
	}

	// Obligation half: the ready file is still reachable, and the admin read surface
	// stays open so the operator can actually find the job to download.
	ticketResponse := request(http.MethodPost,
		api.AdminAuditExportsPath+"/"+exportID+"/download-ticket", "")
	if ticketResponse.StatusCode != http.StatusOK {
		t.Fatalf("ticket status = %d body=%s",
			ticketResponse.StatusCode, readBody(ticketResponse))
	}
	var ticket struct {
		Token   string `json:"token"`
		Bytes   int64  `json:"bytes"`
		RowCont int64  `json:"row_count"`
	}
	if err := json.NewDecoder(ticketResponse.Body).Decode(&ticket); err != nil {
		t.Fatal(err)
	}
	ticketResponse.Body.Close()
	if ticket.Token == "" {
		t.Fatal("suspension suppressed the download ticket of a ready export")
	}

	download := request(http.MethodGet,
		api.AdminAuditExportsPath+"/"+exportID+"/content", "",
		"X-Download-Token", ticket.Token)
	if download.StatusCode != http.StatusOK {
		t.Fatalf("download status = %d body=%s",
			download.StatusCode, readBody(download))
	}
	download.Body.Close()
	if _, downloadedAt := exportStatus(t, dbName, exportID); !downloadedAt {
		t.Fatal("the download never recorded downloaded_at")
	}

	// One-time, asserted from both ends: a second ticket refuses, and the spent token
	// cannot be redeemed again while the org is still switched off.
	replay := request(http.MethodPost,
		api.AdminAuditExportsPath+"/"+exportID+"/download-ticket", "")
	assertAPICode(t, replay, http.StatusConflict, "audit_export_already_downloaded")
	spent := request(http.MethodGet,
		api.AdminAuditExportsPath+"/"+exportID+"/content", "",
		"X-Download-Token", ticket.Token)
	if spent.StatusCode == http.StatusOK {
		t.Fatal("a spent download token redeemed a second time")
	}
	spent.Body.Close()
}
