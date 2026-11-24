package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type apiMetrics struct {
	registry        *prometheus.Registry
	requests        *prometheus.CounterVec
	requestDuration *prometheus.HistogramVec
	sseEvents       *prometheus.CounterVec
}

func newAPIMetrics() *apiMetrics {
	registry := prometheus.NewRegistry()
	metrics := &apiMetrics{
		registry: registry,
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "work_api_requests_total",
			Help: "Work API requests by route template, method, status class and organization.",
		}, []string{"route", "method", "status_class", "org_id"}),
		requestDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "work_api_request_duration_seconds",
			Help:    "Work API request duration by route template, method and organization.",
			Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10},
		}, []string{"route", "method", "org_id"}),
		sseEvents: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "work_sse_events_total",
			Help: "Work task event stream deliveries and resync requirements by organization.",
		}, []string{"kind", "org_id"}),
	}
	registry.MustRegister(metrics.requests, metrics.requestDuration, metrics.sseEvents)
	return metrics
}

func (m *apiMetrics) handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

func (m *apiMetrics) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observation := &requestObservation{orgID: "unknown"}
		r = r.WithContext(context.WithValue(r.Context(), requestObservationKey{}, observation))
		started := time.Now()
		writer := &metricsResponseWriter{ResponseWriter: w}
		next.ServeHTTP(writer, r)
		status := writer.status
		if status == 0 {
			status = http.StatusOK
		}
		route := routePattern(r)
		orgID := strings.TrimSpace(observation.orgID)
		if orgID == "" {
			orgID = "unknown"
		}
		m.requests.WithLabelValues(route, methodLabel(r.Method), statusClass(status), orgID).Inc()
		m.requestDuration.WithLabelValues(route, methodLabel(r.Method), orgID).Observe(time.Since(started).Seconds())
	})
}

func (m *apiMetrics) observeSSE(orgID, kind string) {
	if strings.TrimSpace(orgID) == "" {
		orgID = "unknown"
	}
	m.sseEvents.WithLabelValues(kind, orgID).Inc()
}

func (m *apiMetrics) addSSE(orgID, kind string, count int) {
	if count <= 0 {
		return
	}
	if strings.TrimSpace(orgID) == "" {
		orgID = "unknown"
	}
	m.sseEvents.WithLabelValues(kind, orgID).Add(float64(count))
}

type requestObservationKey struct{}

type requestObservation struct {
	orgID string
}

func observeRequestOrg(r *http.Request, orgID string) {
	observation, ok := r.Context().Value(requestObservationKey{}).(*requestObservation)
	if !ok {
		return
	}
	if value := strings.TrimSpace(orgID); value != "" {
		observation.orgID = value
	}
}

type metricsResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *metricsResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *metricsResponseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *metricsResponseWriter) Flush() {
	_ = w.FlushError()
}

func (w *metricsResponseWriter) FlushError() error {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if flusher, ok := w.ResponseWriter.(interface{ FlushError() error }); ok {
		return flusher.FlushError()
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
		return nil
	}
	return http.ErrNotSupported
}

func (w *metricsResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func routePattern(r *http.Request) string {
	route := strings.TrimSpace(r.Pattern)
	if route == "" {
		return "unmatched"
	}
	if fields := strings.Fields(route); len(fields) == 2 && methodLabel(fields[0]) != "OTHER" {
		return fields[1]
	}
	return route
}

func methodLabel(method string) string {
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodPut,
		http.MethodDelete, http.MethodHead, http.MethodOptions:
		return method
	default:
		return "OTHER"
	}
}

func statusClass(status int) string {
	if status < 100 || status > 599 {
		return "unknown"
	}
	return strconv.Itoa(status/100) + "xx"
}
