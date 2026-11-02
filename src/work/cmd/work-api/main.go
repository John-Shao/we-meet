package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	databaseURL := requiredEnv("WORK_DATABASE_URL")
	csrfSecret := requiredEnv("WORK_CSRF_SECRET")
	hostClient, err := host.NewClient(host.Config{
		BaseURL:        requiredEnv("WORK_HOST_BASE_URL"),
		ClientCertFile: requiredEnv("WORK_HOST_CLIENT_CERT"),
		ClientKeyFile:  requiredEnv("WORK_HOST_CLIENT_KEY"),
		CAFile:         requiredEnv("WORK_HOST_CA"),
		Timeout:        5 * time.Second,
	})
	if err != nil {
		return err
	}
	csrf, err := api.NewCSRF([]byte(csrfSecret), time.Hour, time.Now)
	if err != nil {
		return err
	}
	contentKey, err := content.EncodeMasterKey(requiredEnv("WORK_CONTENT_MASTER_KEY"))
	if err != nil {
		return err
	}
	contentStore, err := content.NewLocal(contentKey, envOrDefault("WORK_CONTENT_DIR", "/var/lib/work/content"), 1)
	if err != nil {
		return err
	}
	pool, err := workdb.OpenPool(ctx, databaseURL, "work-api")
	if err != nil {
		return err
	}
	defer pool.Close()
	server, err := api.NewServerWithContent(pool, hostClient, csrf, contentStore, log.Default())
	if err != nil {
		return err
	}
	server.SetRuntimeVersion(requiredEnv("WORK_RUNTIME_VERSION"))
	server.SetProviderMasterKey(contentKey)

	listenAddr := os.Getenv("WORK_LISTEN_ADDR")
	if listenAddr == "" {
		listenAddr = "127.0.0.1:8080"
	}
	httpServer := &http.Server{
		Addr:              listenAddr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	shutdownCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.ListenAndServe()
	}()
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-shutdownCtx.Done():
		server.BeginShutdown()
		return drainUntil(httpServer, shutdownGrace)
	}
}

// shutdownGrace bounds how long an orderly drain waits for in-flight requests.
const shutdownGrace = 10 * time.Second

// drainUntil closes the listener and lets in-flight requests finish within the grace
// window, then force-closes whatever is still attached. Outliving the window means a
// handler that only ends when the client hangs up, which is an expected restart
// outcome rather than a failure: returning Shutdown's error here would make main exit
// non-zero and leave a Failed unit record for every such restart.
func drainUntil(httpServer *http.Server, grace time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		return httpServer.Close()
	}
	return nil
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
