package main

import (
	"context"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

// stuckStream is one served request that ends only when the client hangs up or release
// is closed, which is how the task event stream behaves. Headers are flushed first so
// the client's Do returns while the handler stays attached.
type stuckStream struct {
	server  *http.Server
	url     string
	started chan struct{}
	release chan struct{}
}

func newStuckStream(t *testing.T) *stuckStream {
	t.Helper()
	stream := &stuckStream{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	var once sync.Once
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() {
			w.WriteHeader(http.StatusOK)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			close(stream.started)
		})
		select {
		case <-stream.release:
		case <-r.Context().Done():
		}
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stream.server = &http.Server{Handler: handler}
	stream.url = "http://" + listener.Addr().String()
	go func() { _ = stream.server.Serve(listener) }()
	// Release before Close: http.Server.Close would otherwise wait on the attached
	// request that this test deliberately leaves running.
	t.Cleanup(func() {
		select {
		case <-stream.release:
		default:
			close(stream.release)
		}
		_ = stream.server.Close()
	})
	return stream
}

// attach holds a stream open for the rest of the test.
func (s *stuckStream) attach(t *testing.T) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, s.url+"/work/v1/tasks/x/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	<-s.started
}

// TestStreamOutlivesBareShutdown is the hazard this fix removes: Shutdown closes the
// listener first and then waits for active requests, so one attached stream makes the
// grace window expire with the API already unreachable. The error reached main as a
// fatal exit, which left a Failed unit record on every such restart.
func TestStreamOutlivesBareShutdown(t *testing.T) {
	stream := newStuckStream(t)
	stream.attach(t)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := stream.server.Shutdown(ctx); err == nil {
		t.Fatal("an attached stream should outlive the drain window")
	}
}

// TestDrainUntilSucceedsWhenAStreamOutlivesGrace pins the repaired path: the same
// situation ends with a nil error and with the sockets actually closed, instead of a
// non-zero exit that records a unit failure.
func TestDrainUntilSucceedsWhenAStreamOutlivesGrace(t *testing.T) {
	stream := newStuckStream(t)
	stream.attach(t)

	drained := make(chan error, 1)
	go func() { drained <- drainUntil(stream.server, 100*time.Millisecond) }()
	select {
	case err := <-drained:
		if err != nil {
			t.Fatalf("drainUntil returned %v; a restart must not fail because a client held a stream", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("drainUntil did not force-close the attached stream")
	}

	if response, err := http.Get(stream.url + "/healthz"); err == nil {
		response.Body.Close()
		t.Fatal("the listener should be gone after a forced drain")
	}
}
