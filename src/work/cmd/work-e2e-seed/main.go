// Command work-e2e-seed creates one task/run exactly like POST /work/v1/tasks
// so a staging end-to-end run can start without a browser session. It calls the
// same domain functions and writes the same capability snapshot manifest; it
// does not bypass any database authorization. It is an operator tool for
// staging only and is not part of the release payload.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/modelparams"
	"github.com/we-meet/work/internal/templates"
)

func main() {
	if err := run(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "work-e2e-seed: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	org := flag.String("org", "", "organization id")
	actor := flag.String("actor", "", "active org owner subject id")
	goal := flag.String("goal", "整理一段试点验收说明", "task goal")
	background := flag.String("background", "R0a 预发端到端验收", "task background")
	templateID := flag.String("template", "summary", "template id")
	mode := flag.String("permission-mode", "ask_each", "permission mode")
	clientRequestID := flag.String("client-request-id", "", "idempotency key (default derived from time)")
	contentDir := flag.String("content-dir", "", "content store dir (default WORK_CONTENT_DIR)")
	flag.Parse()

	if *org == "" || *actor == "" || *goal == "" {
		return errors.New("-org, -actor and -goal are required")
	}
	if *clientRequestID == "" {
		*clientRequestID = fmt.Sprintf("e2e-advance-%d", time.Now().Unix())
	}
	if len(*clientRequestID) < 8 || len(*clientRequestID) > 128 ||
		strings.TrimSpace(*clientRequestID) != *clientRequestID {
		return errors.New("-client-request-id must be 8-128 bytes without surrounding spaces")
	}
	if *contentDir == "" {
		*contentDir = os.Getenv("WORK_CONTENT_DIR")
	}
	if *contentDir == "" {
		return errors.New("WORK_CONTENT_DIR is required")
	}
	key, err := content.EncodeMasterKey(os.Getenv("WORK_CONTENT_MASTER_KEY"))
	if err != nil {
		return errors.New("WORK_CONTENT_MASTER_KEY must be a 32-byte hex or base64 key")
	}
	databaseURL := os.Getenv("WORK_DATABASE_URL")
	if databaseURL == "" {
		return errors.New("WORK_DATABASE_URL is required")
	}
	runtimeVersion := os.Getenv("WORK_RUNTIME_VERSION")
	if runtimeVersion == "" {
		return errors.New("WORK_RUNTIME_VERSION is required")
	}

	template, ok := templates.ByID(*templateID)
	if !ok {
		return fmt.Errorf("unknown template %q", *templateID)
	}

	store, err := content.NewLocal(key, *contentDir, 1)
	if err != nil {
		return errors.New("content store unavailable")
	}
	plaintext, err := json.Marshal(map[string]string{"goal": *goal, "background": *background})
	if err != nil {
		return err
	}
	ref, err := store.Put(ctx, *org, plaintext)
	if err != nil {
		return errors.New("content put failed")
	}

	pool, err := workdb.OpenPool(ctx, databaseURL, "work-e2e-seed")
	if err != nil {
		return errors.New("database unavailable")
	}
	defer pool.Close()

	identity := workdb.Identity{OrgID: *org, SubjectID: *actor}
	var inputID, inputHash string
	var inputBytes int64
	err = workdb.WithWorkContext(ctx, pool, identity, workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			if err := tx.QueryRow(ctx, `SELECT work.create_input_idempotent($1,$2,$3,$4,$5,$6,$7)`,
				*org, *actor, *clientRequestID+"-input",
				ref.ContentRef, ref.Hash, ref.Bytes, "application/json",
			).Scan(&inputID); err != nil {
				return err
			}
			return tx.QueryRow(ctx, `
				SELECT content_hash, bytes FROM work.input_object
				WHERE id = $1 AND org_id = $2 AND subject_id = $3 AND status = 'active'`,
				inputID, *org, *actor,
			).Scan(&inputHash, &inputBytes)
		})
	if err != nil {
		return fmt.Errorf("create input: %w", err)
	}
	if inputHash != ref.Hash || inputBytes != ref.Bytes {
		return errors.New("input replay does not match stored content")
	}

	manifest, err := json.Marshal(map[string]any{
		"template": map[string]any{
			"id": template.ID, "version": template.Version, "content_hash": template.ContentHash,
		},
		"input": map[string]any{
			"ref": inputID, "content_hash": inputHash, "bytes": inputBytes,
		},
		"permission_mode":   *mode,
		"token_upper_bound": int64(100000),
		"parameters":        modelparams.Manifest(),
	})
	if err != nil {
		return err
	}
	digest := sha256.Sum256(manifest)
	snapshotHash := "sha256:" + hex.EncodeToString(digest[:])
	title := truncateRunes(strings.TrimSpace(*goal), 20)

	var taskID, runID string
	var revision int64
	err = workdb.WithWorkContext(ctx, pool, identity, workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT task_id, run_id, revision FROM work.submit_task(
					$1::text, $2::text, $3::text, $4::uuid, $5::text, $6::text,
					$7::text, $8::jsonb, $9::text[], $10::jsonb, $11::text, $12::text)`,
				*org, *actor, *clientRequestID, inputID, title, *mode,
				snapshotHash, string(manifest), []string{"model_call"},
				`{"provider":"deferred","model":"deferred"}`, "", runtimeVersion,
			).Scan(&taskID, &runID, &revision)
		})
	if err != nil {
		return fmt.Errorf("submit task: %w", err)
	}
	fmt.Printf("task_id=%s\nrun_id=%s\nrevision=%d\ninput_ref=%s\nsnapshot_hash=%s\n",
		taskID, runID, revision, inputID, snapshotHash)
	return nil
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}
