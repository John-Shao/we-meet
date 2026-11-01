package main

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/testpg"
)

// TestExportLeaseSurvivesWorkerCrash runs the D3-N03 shape of the orchestration
// fault matrix at the database layer: an export worker claims a job and then
// disappears without calling complete or fail, so a second worker must take over
// only after the lease expires, the dead worker must stay unable to write, and
// the takeover must produce exactly one completed export.
//
// The crash is modelled by letting the lease age out, which is what a killed
// process produces on the server side; no check is shortened to make this pass.
func TestExportLeaseSurvivesWorkerCrash(t *testing.T) {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, testpg.AdminURLFor(pgDBName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	seed := `
		SELECT set_config('app.org_id', 'org_a', false);
		SELECT set_config('app.subject_id', 'sub_owner', false);
		DELETE FROM work.audit_export WHERE org_id = 'org_a';
		DELETE FROM work.provider_access_config WHERE org_id = 'org_a';
		DELETE FROM work.provider_credential WHERE org_id = 'org_a';
		DELETE FROM work.member WHERE org_id = 'org_a';
		DELETE FROM work.org WHERE id = 'org_a';
		INSERT INTO work.org (id, status, home_region, name)
		VALUES ('org_a', 'active', 'cn-north', 'Acme');
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ('org_a', 'sub_owner', 'active', 'owner', true);
	`
	if _, err := conn.Exec(ctx, seed); err != nil {
		t.Fatal(err)
	}

	var exportID string
	if err := conn.QueryRow(ctx, `
		SELECT work.create_audit_export('org_a', 'sub_owner',
		  'export-crash-0001', now() - interval '3 day', now() - interval '1 day', 'csv')
		->> 'id'`).Scan(&exportID); err != nil {
		t.Fatal(err)
	}

	// Worker A takes the lease; a second claim while it is held must be refused.
	if _, err := claim(ctx, conn, exportID, "worker-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := claim(ctx, conn, exportID, "worker-b"); !errors.Is(err, errNotClaimable) {
		t.Fatalf("claim while A holds the lease = %v, want audit_export_not_claimable", err)
	}

	// A crashes: the lease ages out on its own.
	if _, err := conn.Exec(ctx, `
		UPDATE work.audit_export
		SET lease_until = now() - interval '1 second'
		WHERE id = $1::uuid`, exportID); err != nil {
		t.Fatal(err)
	}
	if _, err := claim(ctx, conn, exportID, "worker-b"); err != nil {
		t.Fatalf("takeover after lease expiry failed: %v", err)
	}

	// The stale worker can neither complete nor fail the job.
	if _, err := complete(ctx, conn, exportID, "worker-a", 11); !errors.Is(err, errLeaseLost) {
		t.Fatalf("stale worker complete = %v, want audit_export_lease_lost", err)
	}
	if _, err := fail(ctx, conn, exportID, "worker-a"); !errors.Is(err, errLeaseLost) {
		t.Fatalf("stale worker fail = %v, want audit_export_lease_lost", err)
	}
	var owner, status string
	if err := conn.QueryRow(ctx, `
		SELECT lease_owner, status FROM work.audit_export WHERE id = $1::uuid`, exportID,
	).Scan(&owner, &status); err != nil {
		t.Fatal(err)
	}
	if owner != "worker-b" || status != "running" {
		t.Fatalf("job after stale writes = owner %q status %q", owner, status)
	}

	// B completes once; a repeat completion cannot write a second object.
	if _, err := complete(ctx, conn, exportID, "worker-b", 42); err != nil {
		t.Fatal(err)
	}
	if _, err := complete(ctx, conn, exportID, "worker-b", 42); !errors.Is(err, errLeaseLost) {
		t.Fatalf("repeat complete = %v, want audit_export_lease_lost", err)
	}

	var (
		contentRef  string
		rowCount    int
		completed   int
		claimedRows int
		ticketed    int
	)
	if err := conn.QueryRow(ctx, `
		SELECT content_ref, row_count
		FROM work.audit_export WHERE id = $1::uuid`, exportID,
	).Scan(&contentRef, &rowCount); err != nil {
		t.Fatal(err)
	}
	if rowCount != 42 || contentRef == "" {
		t.Fatalf("export = rows %d ref %q", rowCount, contentRef)
	}
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = 'org_a' AND action = 'audit_export.completed'`).Scan(&completed); err != nil {
		t.Fatal(err)
	}
	if completed != 1 {
		t.Fatalf("completed audit rows = %d, want 1", completed)
	}
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = 'org_a' AND action = 'audit_export.claimed'`).Scan(&claimedRows); err != nil {
		t.Fatal(err)
	}
	if claimedRows != 2 {
		t.Fatalf("claimed audit rows = %d, want 2 (A then B)", claimedRows)
	}
	// The crashed attempt must not have produced a download ticket.
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM work.audit_event
		WHERE org_id = 'org_a' AND action LIKE 'audit_export.%ticket%'`).Scan(&ticketed); err != nil {
		t.Fatal(err)
	}
	if ticketed != 0 {
		t.Fatalf("download tickets issued = %d, want 0", ticketed)
	}
}

var (
	errNotClaimable = errors.New("audit_export_not_claimable")
	errLeaseLost    = errors.New("audit_export_lease_lost")
)

func raiseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Message {
		case "audit_export_not_claimable":
			return errNotClaimable
		case "audit_export_lease_lost":
			return errLeaseLost
		}
		return fmt.Errorf("%s (%s): %w", pgErr.Message, pgErr.Code, err)
	}
	return err
}

func claim(ctx context.Context, conn *pgx.Conn, exportID, worker string) (string, error) {
	var raw string
	if err := conn.QueryRow(ctx,
		`SELECT work.claim_audit_export($1::uuid, $2, 30)`, exportID, worker).Scan(&raw); err != nil {
		return "", raiseError(err)
	}
	return raw, nil
}

func complete(ctx context.Context, conn *pgx.Conn, exportID, worker string, rows int) (string, error) {
	var raw string
	err := conn.QueryRow(ctx, `
		SELECT work.complete_audit_export(
		  $1::uuid, $2, 'content://export/' || $1, 'sha256:' || repeat('a', 16),
		  1024, $3::bigint, 3600)`, exportID, worker, rows).Scan(&raw)
	if err != nil {
		return "", raiseError(err)
	}
	return raw, nil
}

func fail(ctx context.Context, conn *pgx.Conn, exportID, worker string) (string, error) {
	var raw string
	err := conn.QueryRow(ctx,
		`SELECT work.fail_audit_export($1::uuid, $2, 'worker_crashed')`, exportID, worker).Scan(&raw)
	if err != nil {
		return "", raiseError(err)
	}
	return raw, nil
}
