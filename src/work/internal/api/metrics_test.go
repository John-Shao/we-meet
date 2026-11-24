package api

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	dto "github.com/prometheus/client_model/go"

	"github.com/we-meet/work/internal/host"
)

type metricsVerifier struct {
	claims host.Claims
}

func (v metricsVerifier) VerifySession(context.Context, string, string) (host.Claims, error) {
	return v.claims, nil
}

func (v metricsVerifier) VerifyBearer(context.Context, string, string) (host.Claims, error) {
	return v.claims, nil
}

func TestAPIMetricsUseRouteTemplateAndAuthenticatedOrg(t *testing.T) {
	metrics := newAPIMetrics()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /work/v1/tasks", func(w http.ResponseWriter, r *http.Request) {
		observeRequestOrg(r, "org_a")
		w.WriteHeader(http.StatusCreated)
	})
	handler := metrics.middleware(mux)

	request := httptest.NewRequest(http.MethodPost, "/work/v1/tasks", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d", response.Code)
	}

	families, err := metrics.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	counter := metricFamily(t, families, "work_api_requests_total")
	metric := labeledMetric(t, counter, map[string]string{
		"route": "/work/v1/tasks", "method": "POST", "status_class": "2xx", "org_id": "org_a",
	})
	if metric.GetCounter().GetValue() != 1 {
		t.Fatalf("counter = %v", metric.GetCounter().GetValue())
	}
	histogram := metricFamily(t, families, "work_api_request_duration_seconds")
	labeledMetric(t, histogram, map[string]string{
		"route": "/work/v1/tasks", "method": "POST", "org_id": "org_a",
	})
}

func TestAPIMetricsRecordRefusalsWithoutAnOrg(t *testing.T) {
	metrics := newAPIMetrics()
	server := &Server{verifier: metricsVerifier{}, logger: log.New(io.Discard, "", 0)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /work/v1/bootstrap", func(w http.ResponseWriter, r *http.Request) {
		_, _, ok := server.authenticate(w, r)
		if !ok {
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	response := httptest.NewRecorder()
	metrics.middleware(mux).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/work/v1/bootstrap", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.Code)
	}

	families, err := metrics.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	metricFamily(t, families, "work_api_requests_total")
	labeledMetric(t, metricFamily(t, families, "work_api_requests_total"), map[string]string{
		"route": "/work/v1/bootstrap", "method": "GET", "status_class": "4xx", "org_id": "unknown",
	})
}

func TestAPIMetricsBearerAuthRecordsOrg(t *testing.T) {
	metrics := newAPIMetrics()
	server := &Server{
		verifier: metricsVerifier{},
		bearer:   metricsVerifier{claims: host.Claims{OrgID: "org_b", SubjectID: "sub_b"}},
		logger:   log.New(io.Discard, "", 0),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /work/v2/identity", func(w http.ResponseWriter, r *http.Request) {
		_, _, ok := server.authenticateBearer(w, r)
		if !ok {
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	request := httptest.NewRequest(http.MethodGet, "/work/v2/identity", nil)
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("X-Work-Client", "desktop")
	response := httptest.NewRecorder()
	metrics.middleware(mux).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}

	families, err := metrics.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	labeledMetric(t, metricFamily(t, families, "work_api_requests_total"), map[string]string{
		"route": "/work/v2/identity", "method": "GET", "status_class": "2xx", "org_id": "org_b",
	})
}

func TestAPIMetricsSSECounterUsesClosedKinds(t *testing.T) {
	metrics := newAPIMetrics()
	metrics.observeSSE("org_a", "delivered")
	metrics.observeSSE("org_a", "delivered")
	metrics.addSSE("org_a", "delivered", 3)
	metrics.addSSE("org_a", "delivered", 0)
	metrics.observeSSE("org_a", "resync_required")
	metrics.observeSSE("", "delivered")

	families, err := metrics.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	counter := metricFamily(t, families, "work_sse_events_total")
	if value := labeledMetric(t, counter, map[string]string{"kind": "delivered", "org_id": "org_a"}).GetCounter().GetValue(); value != 5 {
		t.Fatalf("delivered = %v", value)
	}
	if value := labeledMetric(t, counter, map[string]string{"kind": "resync_required", "org_id": "org_a"}).GetCounter().GetValue(); value != 1 {
		t.Fatalf("resync = %v", value)
	}
	labeledMetric(t, counter, map[string]string{"kind": "delivered", "org_id": "unknown"})
}

func TestMetricsResponseWriterPreservesFlushAndUnwrap(t *testing.T) {
	recorder := httptest.NewRecorder()
	writer := &metricsResponseWriter{ResponseWriter: recorder}
	if err := http.NewResponseController(writer).Flush(); err != nil {
		t.Fatal(err)
	}
	if !recorder.Flushed || writer.status != http.StatusOK {
		t.Fatalf("flushed=%v status=%d", recorder.Flushed, writer.status)
	}
	if writer.Unwrap() != recorder {
		t.Fatal("Unwrap did not return the underlying writer")
	}
	unsupported := &metricsResponseWriter{ResponseWriter: noFlushWriter{header: make(http.Header)}}
	if err := http.NewResponseController(unsupported).Flush(); err == nil {
		t.Fatal("flush should fail when the underlying writer does not support it")
	}
}

type noFlushWriter struct {
	header http.Header
}

func (w noFlushWriter) Header() http.Header            { return w.header }
func (w noFlushWriter) WriteHeader(int)                {}
func (w noFlushWriter) Write(body []byte) (int, error) { return len(body), nil }

func TestRoutePatternDropsMethodButKeepsTemplates(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/work/v1/tasks/raw-id", nil)
	request.Pattern = "POST /work/v1/tasks/{taskId}"
	if got := routePattern(request); got != "/work/v1/tasks/{taskId}" {
		t.Fatalf("route = %q", got)
	}
	request = httptest.NewRequest(http.MethodHead, "/healthz", nil)
	request.Pattern = "GET /healthz"
	if got := routePattern(request); got != "/healthz" {
		t.Fatalf("HEAD route = %q", got)
	}
	request.Pattern = ""
	if got := routePattern(request); got != "unmatched" {
		t.Fatalf("unmatched route = %q", got)
	}
}

func TestMethodLabelUsesAClosedSet(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete, http.MethodHead, http.MethodOptions} {
		if got := methodLabel(method); got != method {
			t.Fatalf("method %q = %q", method, got)
		}
	}
	if got := methodLabel("TRACE"); got != "OTHER" {
		t.Fatalf("unlisted method = %q", got)
	}
}

func TestMetricsHandlerDoesNotExposeRawURL(t *testing.T) {
	metrics := newAPIMetrics()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /work/v1/tasks/{taskId}", func(w http.ResponseWriter, r *http.Request) {
		observeRequestOrg(r, "org_a")
		w.WriteHeader(http.StatusOK)
	})
	handler := metrics.middleware(mux)
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/work/v1/tasks/raw-secret-id?goal=private", nil))

	response := httptest.NewRecorder()
	metrics.handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := response.Body.String()
	for _, forbidden := range []string{"raw-secret-id", "goal=private", "private"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("metrics exposed %q", forbidden)
		}
	}
	for _, required := range []string{"work_api_requests_total", "work_api_request_duration_seconds_bucket"} {
		if !strings.Contains(body, required) {
			t.Fatalf("metrics missing %q", required)
		}
	}
}

func metricFamily(t *testing.T, families []*dto.MetricFamily, name string) *dto.MetricFamily {
	t.Helper()
	for _, family := range families {
		if family.GetName() == name {
			return family
		}
	}
	t.Fatalf("missing metric family %q", name)
	return nil
}

func labeledMetric(t *testing.T, family *dto.MetricFamily, labels map[string]string) *dto.Metric {
	t.Helper()
	for _, metric := range family.Metric {
		matched := true
		for key, value := range labels {
			found := false
			for _, pair := range metric.Label {
				if pair.GetName() == key && pair.GetValue() == value {
					found = true
					break
				}
			}
			if !found {
				matched = false
				break
			}
		}
		if matched {
			return metric
		}
	}
	t.Fatalf("metric %s has no sample with labels %v", family.GetName(), labels)
	return nil
}
