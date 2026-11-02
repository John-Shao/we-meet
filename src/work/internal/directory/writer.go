package directory

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
)

type PGWriter struct {
	Pool *pgxpool.Pool
}

// directorySyncActor is what the release audit names as the releaser. It is a
// machine identity, not a person: control design §3.4 lets only the sync writer call
// apply_directory_recovery, and an auditor reading the row has to be able to tell
// that no human released anything.
const directorySyncActor = "work_directory_sync"

func (w *PGWriter) SyncOrg(ctx context.Context, org host.Org) error {
	return workdb.WithDirectoryContext(ctx, w.Pool, org.OrgID, workdb.Options{}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`SELECT work.sync_org_projection($1, $2, $3, $4, $5, $6)`,
			org.OrgID,
			org.Name,
			org.Status,
			org.Status == "active",
			org.HomeRegion,
			org.Revision,
		)
		if err != nil {
			return projectionError(err)
		}
		// Same transaction as the projection: Host has observed the organization
		// active again, which is the only fact that can release a host_org deny
		// (§3.4). Recovery is attempted for every active observation because the
		// release predicate compares release_floor_revision and no-ops otherwise.
		if org.Status == "active" {
			if _, err := tx.Exec(ctx,
				`SELECT work.apply_directory_recovery($1, NULL, $2, $3)`,
				org.OrgID, org.Revision, directorySyncActor); err != nil {
				return projectionError(err)
			}
		}
		return nil
	})
}

func (w *PGWriter) SyncMember(ctx context.Context, member host.Member) error {
	return workdb.WithDirectoryContext(ctx, w.Pool, member.OrgID, workdb.Options{}, func(tx pgx.Tx) error {
		// The wrapped entry, not sync_member_projection: since 0019 a member narrowing
		// writes a deny and bumps work.org.access_epoch from inside an AFTER trigger, so
		// the transaction must already hold the org lock when it locks the member row.
		// §4.3 states that direction, and mark_members_absent is the writer that would
		// otherwise deadlock against it (org first at 0008:309-312, then members).
		_, err := tx.Exec(ctx,
			`SELECT work.sync_member_with_org_context($1, $2, $3, $4, $5, $6)`,
			member.OrgID,
			member.SubjectID,
			member.Status,
			member.Role,
			member.WorkSeat,
			member.Revision,
		)
		if err != nil {
			return projectionError(err)
		}
		// A member coming back active releases only that person's host_member deny.
		// Seat denies are deliberately untouched here: only a consumed command event
		// may release those (§3.4 rule 6), otherwise a row edit in Host would restore
		// access that Work revoked on purpose.
		if member.Status == "active" {
			if _, err := tx.Exec(ctx,
				`SELECT work.apply_directory_recovery($1, $2, $3, $4)`,
				member.OrgID, member.SubjectID, member.Revision, directorySyncActor); err != nil {
				return projectionError(err)
			}
		}
		return nil
	})
}

func (w *PGWriter) Watermark(ctx context.Context, orgID string) (int64, bool, error) {
	var revision *int64
	err := workdb.WithDirectoryContext(ctx, w.Pool, orgID, workdb.Options{}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.directory_watermark($1)`, orgID).Scan(&revision)
	})
	if err != nil {
		return 0, false, err
	}
	if revision == nil {
		return 0, false, nil
	}
	return *revision, true, nil
}

func (w *PGWriter) MarkAbsent(
	ctx context.Context,
	orgID string,
	present []string,
	allowMassAbsence bool,
	snapshotRevision int64,
) (int, error) {
	if present == nil {
		present = []string{}
	}
	var affected int
	err := workdb.WithDirectoryContext(ctx, w.Pool, orgID, workdb.Options{}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.mark_members_absent($1, $2, $3, $4)`,
			orgID, present, allowMassAbsence, snapshotRevision,
		).Scan(&affected)
	})
	if err != nil {
		return 0, err
	}
	if affected < 0 {
		return 0, ErrMassAbsenceBlocked
	}
	return affected, nil
}

func (w *PGWriter) RecordSync(
	ctx context.Context,
	orgID, mode string,
	success bool,
	revision int64,
	errorText string,
) error {
	return workdb.WithDirectoryContext(ctx, w.Pool, orgID, workdb.Options{}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`SELECT work.record_directory_sync($1, $2, $3, $4, $5)`,
			orgID, mode, success, revision, errorText,
		)
		return err
	})
}

func projectionError(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "P0001" && pgErr.Message == "projection_revision_stale" {
		return ErrRevisionStale
	}
	return err
}
