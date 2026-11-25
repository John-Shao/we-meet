package governance

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
)

type Store interface {
	Cursor(ctx context.Context, orgID string) (int64, bool, error)
	RecordGap(ctx context.Context, orgID string, gap *host.GovernanceGap, hostFetchSeq int64) (Result, error)
	Consume(
		ctx context.Context,
		orgID string,
		events []host.GovernanceEvent,
		gap *host.GovernanceGap,
		initializeFrom *int64,
	) (Result, error)
}

type Result struct {
	Consumed       int64
	Released       int64
	LastEventSeq   int64
	GapReportID    *string
	FromSeq        *int64
	ToSeqExclusive *int64
}

type PGStore struct {
	Pool *pgxpool.Pool
}

func (s *PGStore) Cursor(ctx context.Context, orgID string) (int64, bool, error) {
	if s == nil || s.Pool == nil {
		return 0, false, &StoreError{Code: "store_unconfigured", Message: "governance store pool is required"}
	}
	var cursor sql.NullInt64
	err := workdb.WithGovernanceContext(ctx, s.Pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.governance_event_cursor_current($1)`, orgID).Scan(&cursor)
	})
	if err != nil {
		return 0, false, &StoreError{Code: "governance_cursor_read_failed", Message: err.Error(), Err: err}
	}
	if !cursor.Valid {
		return 0, false, nil
	}
	return cursor.Int64, true, nil
}

func (s *PGStore) RecordGap(ctx context.Context, orgID string, gap *host.GovernanceGap, hostFetchSeq int64) (Result, error) {
	if s == nil || s.Pool == nil {
		return Result{}, &StoreError{Code: "store_unconfigured", Message: "governance store pool is required"}
	}
	if gap == nil {
		return Result{}, &StoreError{Code: "governance_gap_invalid", Message: "gap attestation is required"}
	}
	gapJSON, err := json.Marshal(gap)
	if err != nil {
		return Result{}, &StoreError{Code: "governance_encode_failed", Message: err.Error(), Err: err}
	}
	var result Result
	err = workdb.WithGovernanceContext(ctx, s.Pool, orgID, func(tx pgx.Tx) error {
		var payload []byte
		if err := tx.QueryRow(ctx,
			`SELECT work.record_governance_gap($1, $2::jsonb, $3::bigint)`,
			orgID, gapJSON, hostFetchSeq,
		).Scan(&payload); err != nil {
			return err
		}
		var wire struct {
			GapReportID    *string `json:"gap_report_id"`
			FromSeq        *int64  `json:"from_seq"`
			ToSeqExclusive *int64  `json:"to_seq_exclusive"`
		}
		if err := json.Unmarshal(payload, &wire); err != nil {
			return &StoreError{Code: "governance_result_invalid", Message: err.Error(), Err: err}
		}
		if wire.GapReportID == nil || wire.FromSeq == nil || wire.ToSeqExclusive == nil {
			return &StoreError{Code: "governance_result_invalid", Message: "gap result is missing required fields"}
		}
		result = Result{GapReportID: wire.GapReportID, FromSeq: wire.FromSeq, ToSeqExclusive: wire.ToSeqExclusive}
		return nil
	})
	if err != nil {
		return Result{}, &StoreError{Code: "governance_gap_record_failed", Message: err.Error(), Err: err}
	}
	return result, nil
}

func (s *PGStore) Consume(
	ctx context.Context,
	orgID string,
	events []host.GovernanceEvent,
	gap *host.GovernanceGap,
	initializeFrom *int64,
) (Result, error) {
	if s == nil || s.Pool == nil {
		return Result{}, &StoreError{Code: "store_unconfigured", Message: "governance store pool is required"}
	}
	if events == nil {
		events = []host.GovernanceEvent{}
	}
	eventJSON, err := json.Marshal(events)
	if err != nil {
		return Result{}, &StoreError{Code: "governance_encode_failed", Message: err.Error(), Err: err}
	}
	var gapJSON []byte
	if gap != nil {
		gapJSON, err = json.Marshal(gap)
		if err != nil {
			return Result{}, &StoreError{Code: "governance_encode_failed", Message: err.Error(), Err: err}
		}
	}
	var initialize any
	if initializeFrom != nil {
		initialize = *initializeFrom
	}
	var result Result
	err = workdb.WithGovernanceContext(ctx, s.Pool, orgID, func(tx pgx.Tx) error {
		var payload []byte
		if err := tx.QueryRow(ctx,
			`SELECT work.consume_governance_events($1, $2::jsonb, $3::jsonb, $4::bigint)`,
			orgID, eventJSON, gapJSON, initialize,
		).Scan(&payload); err != nil {
			return err
		}
		var wire struct {
			Consumed       *int64  `json:"consumed"`
			Released       *int64  `json:"released"`
			LastEventSeq   *int64  `json:"last_event_seq"`
			GapReportID    *string `json:"gap_report_id"`
			FromSeq        *int64  `json:"from_seq"`
			ToSeqExclusive *int64  `json:"to_seq_exclusive"`
		}
		if err := json.Unmarshal(payload, &wire); err != nil {
			return &StoreError{Code: "governance_result_invalid", Message: err.Error(), Err: err}
		}
		if wire.Consumed == nil || wire.Released == nil || wire.LastEventSeq == nil {
			return &StoreError{Code: "governance_result_invalid", Message: "consume result is missing required fields"}
		}
		result = Result{
			Consumed:       *wire.Consumed,
			Released:       *wire.Released,
			LastEventSeq:   *wire.LastEventSeq,
			GapReportID:    wire.GapReportID,
			FromSeq:        wire.FromSeq,
			ToSeqExclusive: wire.ToSeqExclusive,
		}
		return nil
	})
	if err != nil {
		return Result{}, &StoreError{Code: "governance_consume_failed", Message: err.Error(), Err: err}
	}
	return result, nil
}

type StoreError struct {
	Code    string
	Message string
	Err     error
}

func (e *StoreError) Error() string {
	if e.Err != nil {
		return e.Code + ": " + e.Message + ": " + e.Err.Error()
	}
	return e.Code + ": " + e.Message
}

func (e *StoreError) Unwrap() error { return e.Err }
