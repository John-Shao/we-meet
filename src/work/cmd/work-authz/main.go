package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/we-meet/work/internal/authz"
	workdb "github.com/we-meet/work/internal/db"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	pool, err := workdb.OpenPool(ctx, requiredEnv("WORK_DATABASE_URL"), "work-authz")
	if err != nil {
		return err
	}
	defer pool.Close()

	registryBody, err := os.ReadFile(requiredEnv("WORK_AUTHZ_WORKLOADS"))
	if err != nil {
		return errors.New("read workload registry")
	}
	verifier, err := authz.LoadRegistry(registryBody)
	if err != nil {
		return err
	}
	commands := &authz.PGCommands{Pool: pool}
	server, err := authz.NewServer(verifier, commands, commands)
	if err != nil {
		return err
	}

	certificate, err := tls.LoadX509KeyPair(requiredEnv("WORK_AUTHZ_CERT"), requiredEnv("WORK_AUTHZ_KEY"))
	if err != nil {
		return errors.New("load authz server certificate")
	}
	caBody, err := os.ReadFile(requiredEnv("WORK_AUTHZ_CA"))
	if err != nil {
		return errors.New("read authz client CA")
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(caBody) {
		return errors.New("authz client CA has no certificates")
	}

	listener, err := tls.Listen("tcp", envOrDefault("WORK_AUTHZ_LISTEN_ADDR", "127.0.0.1:8443"), &tls.Config{
		Certificates: []tls.Certificate{certificate},
		ClientCAs:    clientCAs,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS12,
	})
	if err != nil {
		return err
	}
	httpServer := &http.Server{
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	shutdown := make(chan struct{})
	go func() {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
		select {
		case <-ctx.Done():
		case <-signals:
		}
		stopCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(stopCtx)
		close(shutdown)
	}()

	log.Printf("work authz listening addr=%s", listener.Addr())
	if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-shutdown
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
