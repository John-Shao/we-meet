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
		return projectionError(err)
	})
}

func (w *PGWriter) SyncMember(ctx context.Context, member host.Member) error {
	return workdb.WithDirectoryContext(ctx, w.Pool, member.OrgID, workdb.Options{}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`SELECT work.sync_member_projection($1, $2, $3, $4, $5, $6)`,
			member.OrgID,
			member.SubjectID,
			member.Status,
			member.Role,
			member.WorkSeat,
			member.Revision,
		)
		return projectionError(err)
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
) (int, error) {
	if present == nil {
		present = []string{}
	}
	var affected int
	err := workdb.WithDirectoryContext(ctx, w.Pool, orgID, workdb.Options{}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.mark_members_absent($1, $2, $3)`,
			orgID, present, allowMassAbsence,
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
