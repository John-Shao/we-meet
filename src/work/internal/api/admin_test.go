package api_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/host"
)

func TestAdminReadEndpoints(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, false)
	verifier := &stubVerifier{claims: testClaims()}
	server := newHTTPServer(t, pool, verifier, testCSRF(t))

	bootstrap := doBootstrap(t, server.URL, "session-value", "corr-bootstrap")
	if bootstrap.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap status = %d", bootstrap.StatusCode)
	}
	var boot api.BootstrapResponse
	if err := json.NewDecoder(bootstrap.Body).Decode(&boot); err != nil {
		t.Fatal(err)
	}
	bootstrap.Body.Close()
	csrfCookie := findCookie(t, bootstrap, api.CSRFCookieName)

	request := func(method, path, body, csrf string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
		req.AddCookie(csrfCookie)
		if csrf != "" {
			req.Header.Set("X-CSRF-Token", csrf)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}

	overview := request(http.MethodGet, api.AdminOverviewPath, "", "")
	if overview.StatusCode != http.StatusOK {
		payload, _ := io.ReadAll(overview.Body)
		t.Fatalf("overview status = %d body=%s", overview.StatusCode, payload)
	}
	var overviewBody map[string]any
	if err := json.NewDecoder(overview.Body).Decode(&overviewBody); err != nil {
		t.Fatal(err)
	}
	overview.Body.Close()
	if overviewBody["org_id"] != testOrg {
		t.Fatalf("overview = %#v", overviewBody)
	}

	seats := request(http.MethodGet, api.AdminSeatsPath+"?limit=1", "", "")
	if seats.StatusCode != http.StatusOK {
		t.Fatalf("seats status = %d", seats.StatusCode)
	}
	var seatsBody struct {
		Items []api.AdminSeat `json:"items"`
	}
	if err := json.NewDecoder(seats.Body).Decode(&seatsBody); err != nil {
		t.Fatal(err)
	}
	seats.Body.Close()
	if len(seatsBody.Items) != 1 || seatsBody.Items[0].SubjectID != testSubject ||
		seatsBody.Items[0].Role != "owner" || !seatsBody.Items[0].WorkSeat {
		t.Fatalf("seats = %#v", seatsBody.Items)
	}

	now := time.Now().UTC()
	exportBody := `{"client_request_id":"admin-test-export-1","range_from":"` +
		now.Add(-2*time.Hour).Format(time.RFC3339) + `","range_to":"` +
		now.Add(-time.Hour).Format(time.RFC3339) + `","format":"csv"}`
	created := request(http.MethodPost, api.AdminAuditExportsPath, exportBody, boot.CSRFToken)
	if created.StatusCode != http.StatusAccepted {
		t.Fatalf("create export status = %d", created.StatusCode)
	}
	var export map[string]any
	if err := json.NewDecoder(created.Body).Decode(&export); err != nil {
		t.Fatal(err)
	}
	created.Body.Close()
	exportID, _ := export["id"].(string)
	if exportID == "" || export["status"] != "queued" {
		t.Fatalf("export = %#v", export)
	}

	got := request(http.MethodGet, api.AdminAuditExportsPath+"/"+exportID, "", "")
	if got.StatusCode != http.StatusOK {
		t.Fatalf("get export status = %d", got.StatusCode)
	}
	got.Body.Close()

	ticket := request(http.MethodPost, api.AdminAuditExportsPath+"/"+exportID+"/download-ticket", "", boot.CSRFToken)
	if ticket.StatusCode != http.StatusConflict {
		t.Fatalf("ticket status = %d", ticket.StatusCode)
	}
	var ticketError struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(ticket.Body).Decode(&ticketError); err != nil {
		t.Fatal(err)
	}
	ticket.Body.Close()
	if ticketError.Code != "audit_export_not_ready" {
		t.Fatalf("ticket code = %q", ticketError.Code)
	}

	content := request(http.MethodGet, api.AdminAuditExportsPath+"/"+exportID+"/content", "", "")
	if content.StatusCode != http.StatusForbidden {
		t.Fatalf("content without token status = %d", content.StatusCode)
	}
	content.Body.Close()
}
