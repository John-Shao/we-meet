package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
)

const exportTTLSeconds = 86400

type exportView struct {
	ID        string    `json:"id"`
	Status    string    `json:"status"`
	Format    string    `json:"format"`
	RangeFrom time.Time `json:"range_from"`
	RangeTo   time.Time `json:"range_to"`
}

type auditRow struct {
	ID             string          `json:"id"`
	ActorSubjectID *string         `json:"actor_subject_id"`
	Action         string          `json:"action"`
	TargetType     string          `json:"target_type"`
	TargetID       string          `json:"target_id"`
	Metadata       json.RawMessage `json:"metadata"`
	CreatedAt      time.Time       `json:"created_at"`
}

func main() {
	org := flag.String("org", os.Getenv("WORK_EXPORT_ORG"), "organization id")
	once := flag.Bool("once", false, "process pending exports once and exit")
	interval := flag.Duration("interval", 5*time.Second, "poll interval")
	flag.Parse()
	if *org == "" {
		log.Fatal("work-export requires -org or WORK_EXPORT_ORG")
	}
	databaseURL := os.Getenv("WORK_DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("WORK_DATABASE_URL is required")
	}
	key, err := content.EncodeMasterKey(os.Getenv("WORK_CONTENT_MASTER_KEY"))
	if err != nil {
		log.Fatalf("WORK_CONTENT_MASTER_KEY must be a 32-byte hex or base64 key: %v", err)
	}
	store, err := content.NewLocal(key, envOrDefault("WORK_CONTENT_DIR", "/var/lib/work/content"), 1)
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	pool, err := workdb.OpenPool(ctx, databaseURL, "work-export")
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	workerID := envOrDefault("WORK_EXPORT_ID", "work-export-1")

	process := func() {
		if err := processPending(ctx, pool, store, *org, workerID); err != nil {
			log.Printf("work-export poll failure: %v", err)
		}
	}
	process()
	if *once {
		return
	}
	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			process()
		}
	}
}

func processPending(ctx context.Context, pool *pgxpool.Pool, store content.Store, orgID, workerID string) error {
	var ids []string
	err := workdb.WithWorkerOrgContext(ctx, pool, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT export_id FROM work.list_pending_audit_exports($1)`, orgID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
		}
		return rows.Err()
	})
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := processExport(ctx, pool, store, orgID, workerID, id); err != nil {
			log.Printf("work-export export=%s failure: %v", id, err)
		}
	}
	return nil
}

func processExport(ctx context.Context, pool *pgxpool.Pool, store content.Store, orgID, workerID, exportID string) error {
	var raw []byte
	err := workdb.WithWorkerOrgContext(ctx, pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT work.claim_audit_export($1, $2, 600)`, exportID, workerID).Scan(&raw)
	})
	if err != nil {
		return err
	}
	var view exportView
	if err := json.Unmarshal(raw, &view); err != nil {
		return fmt.Errorf("decode claimed export: %w", err)
	}
	data, mediaType, rowCount, failCode, err := streamExport(ctx, pool, orgID, view.RangeFrom, view.RangeTo, view.Format)
	if err != nil {
		// The export has already been claimed; a silent failure would leave it
		// leased until expiry, so surface a failure to record the reason.
		if failErr := failExport(ctx, pool, orgID, workerID, exportID, failCode); failErr != nil {
			log.Printf("work-export export=%s fail_export write failed: %v", exportID, failErr)
		}
		return err
	}
	ref, err := store.Put(ctx, orgID, data)
	if err != nil {
		if failErr := failExport(ctx, pool, orgID, workerID, exportID, "export_store_failed"); failErr != nil {
			log.Printf("work-export export=%s fail_export write failed: %v", exportID, failErr)
		}
		return err
	}
	err = workdb.WithWorkerOrgContext(ctx, pool, orgID, func(tx pgx.Tx) error {
		var completed []byte
		return tx.QueryRow(ctx, `
			SELECT work.complete_audit_export($1, $2, $3, $4, $5, $6, $7)`,
			exportID, workerID, ref.ContentRef, ref.Hash, int64(len(data)), rowCount, exportTTLSeconds,
		).Scan(&completed)
	})
	if err != nil {
		return err
	}
	log.Printf("work-export export=%s ready format=%s rows=%d bytes=%d type=%s",
		exportID, view.Format, rowCount, len(data), mediaType)
	return nil
}

// encodeError marks a failure that happened while serialising a row, so the
// export is not blamed on the database read.
type encodeError struct{ err error }

func (e *encodeError) Error() string { return e.err.Error() }
func (e *encodeError) Unwrap() error { return e.err }

// streamAuditRows iterates the audit window without materialising it. The
// export has to fit in memory once encoded (content.Store.Put takes bytes), but
// there is no reason to hold every row as a struct at the same time.
func streamAuditRows(ctx context.Context, pool *pgxpool.Pool, orgID string, from, to time.Time, fn func(auditRow) error) error {
	return workdb.WithWorkerOrgContext(ctx, pool, orgID, func(tx pgx.Tx) error {
		result, err := tx.Query(ctx, `
			SELECT id::text, actor_subject_id, action, target_type, target_id, metadata, created_at
			FROM work.audit_event
			WHERE org_id = $1 AND created_at >= $2 AND created_at < $3
			ORDER BY created_at, id`, orgID, from, to)
		if err != nil {
			return err
		}
		defer result.Close()
		for result.Next() {
			var row auditRow
			var metadata []byte
			if err := result.Scan(&row.ID, &row.ActorSubjectID, &row.Action, &row.TargetType,
				&row.TargetID, &metadata, &row.CreatedAt); err != nil {
				return err
			}
			row.Metadata = json.RawMessage(metadata)
			if err := fn(row); err != nil {
				return err
			}
		}
		return result.Err()
	})
}

// streamExport reads and encodes in one pass. failCode names the stage that
// failed ("export_read_failed" or "export_encode_failed") so the recorded
// failure reason stays specific.
func streamExport(ctx context.Context, pool *pgxpool.Pool, orgID string, from, to time.Time, format string) (data []byte, mediaType string, rowCount int64, failCode string, err error) {
	readStage := func(err error) ([]byte, string, int64, string, error) {
		var enc *encodeError
		if errors.As(err, &enc) {
			return nil, "", 0, "export_encode_failed", err
		}
		return nil, "", 0, "export_read_failed", err
	}
	switch format {
	case "csv":
		var out []byte
		var count int64
		writer := csv.NewWriter(&byteWriter{buf: &out})
		if wErr := writer.Write([]string{"id", "actor_subject_id", "action", "target_type", "target_id", "metadata", "created_at"}); wErr != nil {
			return nil, "", 0, "export_encode_failed", wErr
		}
		readErr := streamAuditRows(ctx, pool, orgID, from, to, func(row auditRow) error {
			count++
			actor := ""
			if row.ActorSubjectID != nil {
				actor = *row.ActorSubjectID
			}
			if wErr := writer.Write([]string{
				row.ID, actor, row.Action, row.TargetType, row.TargetID,
				string(row.Metadata), row.CreatedAt.UTC().Format(time.RFC3339Nano),
			}); wErr != nil {
				return &encodeError{err: wErr}
			}
			return nil
		})
		if readErr != nil {
			return readStage(readErr)
		}
		writer.Flush()
		if wErr := writer.Error(); wErr != nil {
			return nil, "", 0, "export_encode_failed", wErr
		}
		return out, "text/csv; charset=utf-8", count, "", nil
	case "json":
		out := []byte("[\n")
		var count int64
		first := true
		readErr := streamAuditRows(ctx, pool, orgID, from, to, func(row auditRow) error {
			chunk, mErr := json.MarshalIndent(row, "  ", "  ")
			if mErr != nil {
				return &encodeError{err: mErr}
			}
			count++
			if !first {
				out = append(out, ",\n"...)
			}
			first = false
			out = append(out, "  "...)
			out = append(out, chunk...)
			return nil
		})
		if readErr != nil {
			return readStage(readErr)
		}
		out = append(out, "\n]\n"...)
		return out, "application/json", count, "", nil
	default:
		return nil, "", 0, "export_encode_failed", errors.New("unsupported export format")
	}
}

type byteWriter struct {
	buf *[]byte
}

func (w *byteWriter) Write(p []byte) (int, error) {
	*w.buf = append(*w.buf, p...)
	return len(p), nil
}

func failExport(ctx context.Context, pool *pgxpool.Pool, orgID, workerID, exportID, code string) error {
	return workdb.WithWorkerOrgContext(ctx, pool, orgID, func(tx pgx.Tx) error {
		var ignored []byte
		return tx.QueryRow(ctx, `SELECT work.fail_audit_export($1, $2, $3)`, exportID, workerID, code).Scan(&ignored)
	})
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
