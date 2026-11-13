package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/migrate"
	"github.com/we-meet/work/internal/testpg"
	embedded "github.com/we-meet/work/migrations"
)

// deploy/ecs/work-chain-check.service asks this binary one question before work-api may serve:
// does the chain embedded in it already live in this database? Plain `work-migrate status` answers
// every version of that question with exit code 0, because `"state": "pending"` is a readable
// status and not a failure - correct for rollout step 4, which prints it, fatal for a gate.
// -require-up-to-date is the policy layered on that reading, and these arms pin both directions of
// the mismatch the boot gate exists to refuse: a database behind the binary (pending) and a binary
// behind the database (ledger_version_unknown, which already refuses with no policy at all).
//
// Both sides are built by replaying the real chain against a real PostgreSQL instance. A hand-written
// ledger row or a copied increment list would be a second manifest, and the second one is always the
// stale one - which is the #54 family of failure this file is supposed to catch, not repeat.
func TestStatusRequireUpToDate(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()

	admin, err := pgx.Connect(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(context.Background()) }()
	if err := testpg.EnsureFixtures(ctx, admin); err != nil {
		t.Fatal(err)
	}
	dbName, err := createEmptyDB(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelCleanup()
		conn, err := pgx.Connect(cleanupCtx, testpg.AdminURL())
		if err == nil {
			_ = testpg.DropDatabase(cleanupCtx, conn, dbName)
			_ = conn.Close(cleanupCtx)
		}
	})
	migrator := testpg.MigratorURL(dbName)
	staleDir, dropped := staleChainDir(t)
	if dropped <= 0 {
		t.Fatalf("stale chain dir dropped version %d", dropped)
	}

	t.Run("an unmigrated database is a readable status without the flag", func(t *testing.T) {
		out, err := runCLI(ctx, "status", "-url", migrator)
		if err != nil {
			t.Fatalf("status without the flag must stay exit 0 (rollout step 4 prints it): %v\n%s", err, out)
		}
		if state := decodeState(t, out); state != "empty" {
			t.Fatalf("state = %q, want empty\n%s", state, out)
		}
	})

	t.Run("an unmigrated database refuses once the gate asks for the tail", func(t *testing.T) {
		out, err := runCLI(ctx, "status", "-url", migrator, "-require-up-to-date")
		requireRefusal(t, err, "ledger_pending_increments")
		if !strings.Contains(out, `"state": "empty"`) {
			t.Fatalf("the refusal hid the status reading from the journal:\n%s", out)
		}
	})

	t.Run("the chain minus its tail applies", func(t *testing.T) {
		out, err := runCLI(ctx, "apply", "-url", migrator, "-migrations-dir", staleDir, "-legacy-migrator-disabled")
		if err != nil {
			t.Fatalf("apply of the shortened chain: %v\n%s", err, out)
		}
	})

	t.Run("a behind ledger is still a readable status without the flag", func(t *testing.T) {
		out, err := runCLI(ctx, "status", "-url", migrator)
		if err != nil {
			t.Fatalf("status without the flag: %v\n%s", err, out)
		}
		got := decodeResult(t, out)
		if got.State != "pending" {
			t.Fatalf("state = %q, want pending\n%s", got.State, out)
		}
		// Non-vacuity for the whole file: the fixture has to leave exactly the dropped increment
		// outstanding, or every refusal below could be about something else.
		if len(got.Pending) != 1 || got.Pending[0] != dropped {
			t.Fatalf("pending = %v, want [%d]\n%s", got.Pending, dropped, out)
		}
	})

	t.Run("a behind ledger refuses with the flag and keeps naming the version", func(t *testing.T) {
		out, err := runCLI(ctx, "status", "-url", migrator, "-require-up-to-date")
		requireRefusal(t, err, "ledger_pending_increments")
		if !strings.Contains(err.Error(), fmt.Sprint(dropped)) {
			t.Fatalf("refusal does not name the pending version %d: %v", dropped, err)
		}
		if !strings.Contains(out, `"state": "pending"`) {
			t.Fatalf("the refusal hid the status reading from the journal:\n%s", out)
		}
	})

	t.Run("applying the tail lets the gate pass", func(t *testing.T) {
		out, err := runCLI(ctx, "apply", "-url", migrator, "-legacy-migrator-disabled")
		if err != nil {
			t.Fatalf("apply of the full embedded chain: %v\n%s", err, out)
		}
		out, err = runCLI(ctx, "status", "-url", migrator, "-require-up-to-date")
		if err != nil {
			t.Fatalf("status at the chain tail must pass the gate: %v\n%s", err, out)
		}
		if state := decodeState(t, out); state != "up_to_date" {
			t.Fatalf("state = %q, want up_to_date\n%s", state, out)
		}
	})

	// The other half of the boot gate, and the half that needs no new policy: an installed binary
	// predating an increment already fails. scripts/ecs-migrate.sh greps this exact serialization
	// for its own precheck, so the assertion goes through writeError rather than the Go value.
	t.Run("a binary older than the ledger already refuses without the flag", func(t *testing.T) {
		out, err := runCLI(ctx, "status", "-url", migrator, "-migrations-dir", staleDir)
		requireRefusal(t, err, "ledger_version_unknown")
		serialized := errorJSON(err)
		if !strings.Contains(serialized, `"code": "ledger_version_unknown"`) {
			t.Fatalf("ecs-migrate.sh keys on this exact JSON, got: %s", serialized)
		}
		if !strings.Contains(serialized, fmt.Sprint(dropped)) {
			t.Fatalf("refusal does not name version %d: %s", dropped, serialized)
		}
		// There is no ledger reading on stdout here, unlike the pending arm above: this failure
		// happens while reading, so the only line the journal gets is the refusal on stderr. That
		// is why the wrapper captures `2>&1` - a status-only reader would see an empty success
		// stream and a non-zero exit with no reason.
		if out != "" {
			t.Fatalf("status printed on stdout before failing to read the ledger:\n%s", out)
		}
	})
}

func runCLI(ctx context.Context, args ...string) (string, error) {
	var out bytes.Buffer
	err := run(ctx, args, &out)
	return out.String(), err
}

// requireRefusal pins both the code and its type: main.go maps *migrate.Error to exit 2 and every
// other error to exit 1, so a plain error here would be a different contract than the one the unit
// gate depends on - and writeError would report it as code "internal".
func requireRefusal(t *testing.T, err error, wantCode string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected code %q, got success", wantCode)
	}
	var migrationError *migrate.Error
	if !errors.As(err, &migrationError) {
		t.Fatalf("expected a *migrate.Error (exit 2), got %T: %v", err, err)
	}
	if migrationError.Code != wantCode {
		t.Fatalf("code = %q, want %q (%v)", migrationError.Code, wantCode, err)
	}
}

type statusResult struct {
	State   string  `json:"state"`
	Pending []int64 `json:"pending"`
}

func decodeResult(t *testing.T, out string) statusResult {
	t.Helper()
	var got statusResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("status did not print one JSON object: %v\n%s", err, out)
	}
	return got
}

func decodeState(t *testing.T, out string) string {
	t.Helper()
	return decodeResult(t, out).State
}

func errorJSON(err error) string {
	var buf bytes.Buffer
	writeError(&buf, err)
	return buf.String()
}

// createEmptyDB makes the database a fresh host would have: owned by work_owner, no work schema,
// no ledger. testpg.CreateBaselineDB is deliberately not used - it applies the chain.
func createEmptyDB(ctx context.Context, admin *pgx.Conn) (string, error) {
	name := fmt.Sprintf("work_uptodate_%d_%d", os.Getpid(), time.Now().UnixNano())
	if len(name) > 63 {
		name = name[:63]
	}
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" OWNER work_owner"); err != nil {
		return "", err
	}
	return name, nil
}

// staleChainDir materialises the published chain without its last increment into a directory,
// which is what an older release directory on a host already is. `-migrations-dir` is the shipped
// override (os.DirFS), so the fixture drives the real load path instead of a test-only view of it.
// It returns the directory and the version that was dropped.
func staleChainDir(t *testing.T) (string, int64) {
	t.Helper()
	body, err := fs.ReadFile(embedded.FS, "manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	increments, ok := raw["increments"].([]any)
	if !ok || len(increments) < 2 {
		t.Fatalf("manifest increments are unreadable or too short to trim: %#v", raw["increments"])
	}
	kept := increments[:len(increments)-1]
	dropped, ok := increments[len(increments)-1].(map[string]any)
	if !ok {
		t.Fatalf("the last manifest increment is not an object: %#v", increments[len(increments)-1])
	}
	// The fixture is only a "chain behind the database" if the entry it drops is one the runner
	// would have applied. A non-increment or non-executable tail would make every pending
	// assertion below describe a chain that never had that step.
	if kind, _ := dropped["kind"].(string); kind != "increment" {
		t.Fatalf("the tail of the manifest is kind %q, not an increment - this trim is not a stale chain", kind)
	}
	if exec, _ := dropped["executable"].(bool); !exec {
		t.Fatalf("the tail of the manifest is not executable - this trim is not a stale chain")
	}
	version, _ := dropped["version"].(float64)

	dir := t.TempDir()
	if catalog, _ := raw["catalog"].(string); catalog != "" {
		copyManifestFile(t, dir, catalog)
	}
	copyListed := func(entries []any) {
		for _, entry := range entries {
			migration, ok := entry.(map[string]any)
			if !ok {
				t.Fatalf("manifest entry is not an object: %#v", entry)
			}
			if file, _ := migration["file"].(string); file != "" {
				copyManifestFile(t, dir, file)
			}
			if catalog, _ := migration["catalog"].(string); catalog != "" {
				copyManifestFile(t, dir, catalog)
			}
		}
	}
	if baseline, _ := raw["baseline"].([]any); len(baseline) > 0 {
		copyListed(baseline)
	}
	copyListed(kept)

	trimmed := map[string]any{}
	for key, value := range raw {
		trimmed[key] = value
	}
	trimmed["increments"] = kept
	encoded, err := json.MarshalIndent(trimmed, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, int64(version)
}

func copyManifestFile(t *testing.T, dir, path string) {
	t.Helper()
	body, err := fs.ReadFile(embedded.FS, path)
	if err != nil {
		t.Fatalf("published chain does not carry %s: %v", path, err)
	}
	dest := filepath.Join(dir, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dest, body, 0o600); err != nil {
		t.Fatal(err)
	}
}
