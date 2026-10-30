package egressservice

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
	// invokeTimeout is the signed total model-call budget (§7.2). It is also
	// the handler deadline, so a provider call can never outlive it.
	invokeTimeout   = 15 * time.Minute
	writeTimeout    = invokeTimeout + time.Minute
	idleTimeout     = 60 * time.Second
	shutdownTimeout = 15 * time.Second
	maxHeaderBytes  = 32 << 10
)

// Handler returns the 8445 route table. Only the signed bound model invoke
// route exists on this listener; issuance and administration routes live on
// 8443.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+InvokePath, s.handleInvoke)
	return s.limitBody(mux)
}

// ListenAndServe binds the mTLS listener and serves until ctx is canceled. It
// requires a server certificate, its key and the client CA; a client without a
// verified certificate fails the handshake and never reaches a handler.
func (s *Server) ListenAndServe(ctx context.Context) error {
	tlsConfig, err := s.tlsConfig()
	if err != nil {
		return err
	}
	listener, err := tls.Listen("tcp", s.config.ListenAddr, tlsConfig)
	if err != nil {
		return errors.New("egressservice: bind listener")
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

	log.Printf("work egress listening addr=%s", listener.Addr())

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
// chain and the loopback SAN; the caller itself is authorised by the bearer
// (D4 §6.3).
func (s *Server) tlsConfig() (*tls.Config, error) {
	if s.config.CertFile == "" || s.config.KeyFile == "" {
		return nil, errors.New("egressservice: server certificate and key are required")
	}
	certificate, err := tls.LoadX509KeyPair(s.config.CertFile, s.config.KeyFile)
	if err != nil {
		return nil, errors.New("egressservice: load server certificate")
	}
	return &tls.Config{
		Certificates: []tls.Certificate{certificate},
		MinVersion:   tls.VersionTLS12,
	}, nil
}

// limitBody refuses an over-limit body before any handler runs and bounds every
// body the listener will read.
func (s *Server) limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > MaxRequestBodyBytes {
			writeError(w, http.StatusRequestEntityTooLarge, codeRequestTooLarge)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBodyBytes)
		next.ServeHTTP(w, r)
	})
}

// writeError emits {"code":"..."} and nothing else. The code is an internal
// constant; no caller-supplied or database text can reach the response.
func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"code": code})
}

// writeJSON writes one closed JSON object with no-store and nosniff. It never
// receives message text, tokens or provider bodies.
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

var errBodyTooLarge = errors.New("request body too large")

// readBody reads at most MaxRequestBodyBytes and maps the limit error to a 413.
func readBody(r *http.Request) ([]byte, error) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, errBodyTooLarge
		}
		return nil, err
	}
	if int64(len(body)) > MaxRequestBodyBytes {
		return nil, errBodyTooLarge
	}
	return body, nil
}
