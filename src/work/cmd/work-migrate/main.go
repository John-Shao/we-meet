package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/signal"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/migrate"
	embedded "github.com/we-meet/work/migrations"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if err := run(ctx, os.Args[1:], os.Stdout); err != nil {
		writeError(os.Stderr, err)
		var migrationError *migrate.Error
		if errors.As(err, &migrationError) {
			os.Exit(2)
		}
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: work-migrate <status|plan|apply|snapshot> [flags]")
	}
	command := args[0]
	switch command {
	case "status":
		return runStatus(ctx, args[1:], stdout)
	case "plan":
		return runStatus(ctx, args[1:], stdout)
	case "apply":
		return runApply(ctx, args[1:], stdout)
	case "snapshot":
		return runSnapshot(ctx, args[1:], stdout)
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

type commonFlags struct {
	url                    string
	migrationsDir          string
	legacyMigratorDisabled bool
	lockTimeout            time.Duration
}

func addCommonFlags(fs *flag.FlagSet) *commonFlags {
	flags := &commonFlags{}
	fs.StringVar(&flags.url, "url", os.Getenv("WORK_DATABASE_URL"), "PostgreSQL connection URL")
	fs.StringVar(&flags.migrationsDir, "migrations-dir", "", "override embedded migrations directory")
	fs.BoolVar(&flags.legacyMigratorDisabled, "legacy-migrator-disabled", false, "assert the legacy Django migration runner is disabled")
	fs.DurationVar(&flags.lockTimeout, "lock-timeout", 30*time.Second, "advisory lock wait timeout")
	return flags
}

func (f *commonFlags) migrationFS() (fs.FS, string) {
	if f.migrationsDir == "" {
		return embedded.FS, "."
	}
	return os.DirFS(f.migrationsDir), "."
}

func runStatus(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	flags := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	files, root := flags.migrationFS()
	runner, err := migrate.New(migrate.Config{
		DatabaseURL: flags.url,
		Migrations:  files,
		Root:        root,
		LockTimeout: flags.lockTimeout,
	})
	if err != nil {
		return err
	}
	result, err := runner.Status(ctx)
	if err != nil {
		return err
	}
	return writeJSON(stdout, result)
}

func runApply(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("apply", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	flags := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	files, root := flags.migrationFS()
	runner, err := migrate.New(migrate.Config{
		DatabaseURL:            flags.url,
		Migrations:             files,
		Root:                   root,
		LegacyMigratorDisabled: flags.legacyMigratorDisabled,
		LockTimeout:            flags.lockTimeout,
	})
	if err != nil {
		return err
	}
	result, err := runner.Apply(ctx)
	if err != nil {
		return err
	}
	return writeJSON(stdout, result)
}

func runSnapshot(ctx context.Context, args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("snapshot", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	url := flags.String("url", os.Getenv("WORK_DATABASE_URL"), "PostgreSQL connection URL")
	output := flags.String("output", "-", "output file, or - for stdout")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *url == "" {
		return fmt.Errorf("database URL is required")
	}
	conn, err := pgx.Connect(ctx, *url)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	catalog, err := migrate.ReadCatalog(ctx, conn)
	if err != nil {
		return err
	}
	body, err := catalog.JSON()
	if err != nil {
		return err
	}
	if *output == "-" {
		_, err = stdout.Write(body)
		return err
	}
	return os.WriteFile(*output, body, 0o644)
}

func writeJSON(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func writeError(w io.Writer, err error) {
	var migrationError *migrate.Error
	if errors.As(err, &migrationError) {
		_ = writeJSON(w, map[string]any{"error": migrationError})
		return
	}
	_ = writeJSON(w, map[string]any{"error": map[string]any{
		"code":    "internal",
		"message": err.Error(),
	}})
}
