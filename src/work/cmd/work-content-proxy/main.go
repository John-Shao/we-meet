// Command work-content-proxy runs the F0-R5 content proxy (D4 §6.3).
//
// It listens on its own mTLS port (default 127.0.0.1:8444), separate from the
// 8443 issuance/administration listener, and serves bound reads authenticated
// by a work-content opaque bearer. It holds the object-store credential; the
// runtime child never does.
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/we-meet/work/internal/capability"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentproxy"
	"github.com/we-meet/work/internal/contentref"
	workdb "github.com/we-meet/work/internal/db"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	pool, err := workdb.OpenPool(ctx, requiredEnv("WORK_DATABASE_URL"), "work-content-proxy")
	if err != nil {
		return err
	}
	defer pool.Close()

	key, err := content.EncodeMasterKey(requiredEnv("WORK_CONTENT_MASTER_KEY"))
	if err != nil {
		// Never echo the key or a derived value.
		return errors.New("WORK_CONTENT_MASTER_KEY must be a 32-byte hex or base64 key")
	}
	store, err := content.NewLocal(key, envOrDefault("WORK_CONTENT_DIR", "/var/lib/work/content"), 1)
	if err != nil {
		return errors.New("open content store")
	}

	server, err := contentproxy.New(contentproxy.Config{
		ListenAddr: envOrDefault("WORK_CONTENT_PROXY_LISTEN_ADDR", contentproxy.DefaultListenAddr),
		CertFile:   requiredEnv("WORK_CONTENT_PROXY_CERT"),
		KeyFile:    requiredEnv("WORK_CONTENT_PROXY_KEY"),
	}, capability.NewIssuer(pool), contentref.NewRegistry(pool), store)
	if err != nil {
		return err
	}
	return server.ListenAndServe(ctx)
}

func requiredEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
