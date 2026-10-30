// Command work-egress runs the F0-R5 trusted model-egress service (D4 §6.3,
// §7).
//
// It listens on its own mTLS port (default 127.0.0.1:8445), separate from the
// 8443 authorization and 8444 content listeners, and serves the signed thin
// wire POST /runtime/v1/model/invoke: {executionId, requestRef, requestHash}.
// Everything else is derived server-side; the body can never name a provider,
// endpoint, credential, operation, attempt or message text. The service holds
// the provider credential boundary: provider context and managed_key plaintext
// are resolved per organization through internal/providerctx and never appear
// in a request, response or log line.
//
// The authorization service is reached with this process's own mTLS client
// certificate; the child's bearer is never used as the gateway identity.
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/we-meet/work/internal/authz"
	"github.com/we-meet/work/internal/capability"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/egressservice"
	"github.com/we-meet/work/internal/providerctx"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	pool, err := workdb.OpenPool(ctx, requiredEnv("WORK_DATABASE_URL"), "work-egress")
	if err != nil {
		return err
	}
	defer pool.Close()

	// The master key derives both the Content Store key and the provider
	// credential key; the two domains are separated inside each derivation. The
	// key or a derived value is never echoed.
	masterKey, err := content.EncodeMasterKey(requiredEnv("WORK_CONTENT_MASTER_KEY"))
	if err != nil {
		return errors.New("WORK_CONTENT_MASTER_KEY must be a 32-byte hex or base64 key")
	}
	store, err := content.NewLocal(masterKey, envOrDefault("WORK_CONTENT_DIR", "/var/lib/work/content"), 1)
	if err != nil {
		return errors.New("open content store")
	}

	gate, err := authz.NewClient(authz.ClientConfig{
		BaseURL:  requiredEnv("WORK_AUTHZ_URL"),
		CertFile: requiredEnv("WORK_AUTHZ_CERT"),
		KeyFile:  requiredEnv("WORK_AUTHZ_KEY"),
		CAFile:   requiredEnv("WORK_AUTHZ_CA"),
	})
	if err != nil {
		return err
	}

	// §8.1: writerGatewayId is the authenticated egress workload identity, not a
	// request field. It is derived from the registered egress service
	// certificate that this process also presents to the authorization service.
	gatewayID, err := egressservice.GatewayIDFromCertificateFile(requiredEnv("WORK_EGRESS_CERT"))
	if err != nil {
		return err
	}

	server, err := egressservice.New(egressservice.Config{
		ListenAddr: envOrDefault("WORK_EGRESS_LISTEN_ADDR", egressservice.DefaultListenAddr),
		CertFile:   requiredEnv("WORK_EGRESS_CERT"),
		KeyFile:    requiredEnv("WORK_EGRESS_KEY"),
		GatewayID:  gatewayID,
	}, egressservice.Dependencies{
		Authorizer: capability.NewIssuer(pool),
		Providers:  &providerctx.Resolver{Pool: pool, Master: masterKey},
		Commands:   gate,
		References: contentref.NewRegistry(pool),
		Executions: &egressservice.PGBindings{Pool: pool},
		Content:    store,
		Factory:    egressservice.HTTPProviderFactory,
	})
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
