package contentproxy

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"time"
)

const (
	readHeaderTimeout = 5 * time.Second
	readTimeout       = 30 * time.Second
	writeTimeout      = 60 * time.Second
	idleTimeout       = 60 * time.Second
	shutdownTimeout   = 15 * time.Second
	maxHeaderBytes    = 32 << 10
)

// Handler returns the 8444 route table: bound reads and child checkpoint
// candidate writes. Issuance/administration routes live on 8443.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/v1/content/{refId}", s.logged("read", s.handleRead))
	mux.HandleFunc("POST /internal/v1/checkpoints", s.logged("checkpoint", s.handleCheckpoint))
	return s.limitBody(mux)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(body []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(body)
}

// logged emits one line per request: route, status and duration only. It never
// logs a reference id, a token or a body.
func (s *Server) logged(route string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w}
		next(recorder, r)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		log.Printf("work content proxy route=%s status=%d elapsed_ms=%d",
			route, status, time.Since(started).Milliseconds())
	}
}

// ListenAndServe binds the server-TLS listener and serves until ctx is canceled.
// D4 §6.3 gives this listener server TLS plus the opaque work-content bearer:
// the child authenticates with its capability, not with a workload client
// certificate. The listener is bound to loopback and every route still checks
// the bearer online.
func (s *Server) ListenAndServe(ctx context.Context) error {
	tlsConfig, err := s.tlsConfig()
	if err != nil {
		return err
	}
	listener, err := tls.Listen("tcp", s.config.ListenAddr, tlsConfig)
	if err != nil {
		return errors.New("contentproxy: bind listener")
	}
	server := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
	}

	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()

	log.Printf("work content proxy listening addr=%s", listener.Addr())

	select {
	case err := <-served:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
		stopCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		_ = server.Shutdown(stopCtx)
		if err := <-served; err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

// tlsConfig loads the listener identity. The client verifies this certificate
// chain and the loopback SAN; the caller itself is authorised by the bearer.
func (s *Server) tlsConfig() (*tls.Config, error) {
	if s.config.CertFile == "" || s.config.KeyFile == "" {
		return nil, errors.New("contentproxy: server certificate and key are required")
	}
	certificate, err := tls.LoadX509KeyPair(s.config.CertFile, s.config.KeyFile)
	if err != nil {
		return nil, errors.New("contentproxy: load server certificate")
	}
	return &tls.Config{
		Certificates: []tls.Certificate{certificate},
		MinVersion:   tls.VersionTLS12,
	}, nil
}

// limitBody refuses an over-limit body before any handler runs and bounds
// every body the listener will read. A request body is never part of a bound
// read; the limit exists for the signed candidate ceiling and as a listener
// guard.
func (s *Server) limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > MaxRequestBodyBytes {
			writeError(w, http.StatusRequestEntityTooLarge, codeRequestTooLarge)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBodyBytes)
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			// No read route takes a body; drain it under the same limit so a
			// chunked oversized body is still refused instead of ignored.
			if _, err := io.Copy(io.Discard, r.Body); err != nil {
				var tooLarge *http.MaxBytesError
				if errors.As(err, &tooLarge) {
					writeError(w, http.StatusRequestEntityTooLarge, codeRequestTooLarge)
					return
				}
				writeError(w, http.StatusUnprocessableEntity, codeInvalidRequest)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// writeError emits {"code":"..."} and nothing else. The code is an internal
// constant; no caller-supplied or database text can reach the response.
func writeError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code})
}
