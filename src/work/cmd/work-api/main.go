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
	pool, err := workdb.OpenPool(ctx, databaseURL, "work-api")
	if err != nil {
		return err
	}
	defer pool.Close()
	server, err := api.NewServer(pool, hostClient, csrf, log.Default())
	if err != nil {
		return err
	}

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
		timeout, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return httpServer.Shutdown(timeout)
	}
}

func requiredEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}
