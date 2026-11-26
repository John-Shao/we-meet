package host_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/host"
)

const (
	entitlementOrgID     = "10000000-0000-0000-0000-000000000001"
	entitlementCommandID = "20000000-0000-0000-0000-000000000002"
	entitlementPayload   = "sha256:e40e54026813e80055ab4389907f5cefc76dfe4aa918f552e0a11be4ed138556"
)

func entitlementCommand() host.ExecutionEntitlementCommand {
	return host.ExecutionEntitlementCommand{
		CommandID:                   entitlementCommandID,
		OrgID:                       entitlementOrgID,
		ExpectedEntitlementRevision: 0,
		TargetEntitlementRevision:   1,
		Enabled:                     true,
		SeatLimit:                   2,
		OperatorAuthorizationRef:    "OPS-42",
	}
}

func entitlementReceipt(status string) map[string]any {
	return map[string]any{
		"command_id":         entitlementCommandID,
		"org_id":             entitlementOrgID,
		"status":             status,
		"payload_hash":       entitlementPayload,
		"enabled":            true,
		"seat_limit":         2,
		"operator_suspended": false,
		"revision":           1,
		"occupied_seats":     0,
		"applied_at":         "2026-11-25T00:00:00Z",
	}
}

func TestExecutionEntitlementApplyAndGetThroughOperatorIdentity(t *testing.T) {
	pki := newTestPKIWithIdentity(t, "work-operator-adapter")
	server := startHostServerWithPKI(t, pki, func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 ||
			r.TLS.PeerCertificates[0].Subject.CommonName != "work-operator-adapter" {
			t.Errorf("operator client certificate identity = %#v", r.TLS)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/work-host/v3/organizations/"+entitlementOrgID+"/work-entitlement-commands":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if len(body) != 8 || body["payload_hash"] != entitlementPayload ||
				body["expected_entitlement_revision"] != float64(0) ||
				body["target_entitlement_revision"] != float64(1) ||
				body["operator_authorization_ref"] != "OPS-42" {
				t.Errorf("entitlement request = %#v", body)
			}
			_ = json.NewEncoder(w).Encode(entitlementReceipt("applied"))
		case r.Method == http.MethodGet && r.URL.Path == "/work-host/v3/work-entitlement-commands/"+entitlementCommandID:
			_ = json.NewEncoder(w).Encode(entitlementReceipt("applied"))
		default:
			t.Errorf("request = %s %s", r.Method, r.URL.String())
			http.NotFound(w, r)
		}
	})
	client := newClient(t, server.URL, pki, time.Now())
	ctx := context.Background()

	applied, err := client.ApplyExecutionEntitlement(ctx, entitlementCommand(), "corr-apply")
	if err != nil {
		t.Fatal(err)
	}
	if applied.Status != "applied" || applied.Revision != 1 || applied.SeatLimit != 2 || !applied.Enabled {
		t.Fatalf("applied receipt = %#v", applied)
	}
	fetched, err := client.GetExecutionEntitlementCommand(ctx, entitlementCommandID, "corr-get")
	if err != nil {
		t.Fatal(err)
	}
	if fetched.CommandID != entitlementCommandID || fetched.PayloadHash != entitlementPayload {
		t.Fatalf("fetched receipt = %#v", fetched)
	}
}

func TestExecutionEntitlementRejectsMalformedOrMismatchedReceipts(t *testing.T) {
	valid := entitlementReceipt("applied")
	cases := map[string]string{
		"unknown field":  strings.Replace(mustEntitlementJSON(t, valid), `"status":"applied"`, `"status":"applied","extra":true`, 1),
		"duplicate key":  strings.Replace(mustEntitlementJSON(t, valid), `"status":"applied"`, `"status":"applied","status":"replayed"`, 1),
		"wrong revision": strings.Replace(mustEntitlementJSON(t, valid), `"revision":1`, `"revision":2`, 1),
		"wrong payload":  strings.Replace(mustEntitlementJSON(t, valid), entitlementPayload, "sha256:"+strings.Repeat("b", 64), 1),
		"bad status":     strings.Replace(mustEntitlementJSON(t, valid), `"status":"applied"`, `"status":"pending"`, 1),
	}
	for name, response := range cases {
		t.Run(name, func(t *testing.T) {
			server, pki := startHostServer(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(response))
			})
			client := newClient(t, server.URL, pki, time.Now())
			if _, err := client.ApplyExecutionEntitlement(context.Background(), entitlementCommand(), ""); err == nil {
				t.Fatal("malformed receipt was accepted")
			} else if hostErr, ok := err.(*host.Error); !ok || hostErr.Code != "entitlement_protocol_invalid" {
				t.Fatalf("error = %#v", err)
			}
		})
	}
}

func TestExecutionEntitlementPreservesHostConflictCode(t *testing.T) {
	server, pki := startHostServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"idempotency_key_conflict"}`))
	})
	client := newClient(t, server.URL, pki, time.Now())
	_, err := client.ApplyExecutionEntitlement(context.Background(), entitlementCommand(), "")
	hostErr, ok := err.(*host.Error)
	if !ok || hostErr.Code != "idempotency_key_conflict" {
		t.Fatalf("error = %#v", err)
	}
}

func TestExecutionEntitlementValidatesCommandBeforeHTTP(t *testing.T) {
	server, pki := startHostServer(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("invalid command reached Host")
		w.WriteHeader(http.StatusInternalServerError)
	})
	client := newClient(t, server.URL, pki, time.Now())
	command := entitlementCommand()
	command.SeatLimit = 0
	if _, err := client.ApplyExecutionEntitlement(context.Background(), command, ""); err == nil {
		t.Fatal("zero seat_limit was accepted")
	}
}

func mustEntitlementJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestExecutionEntitlementReceiptShapeIsClosed(t *testing.T) {
	raw := mustEntitlementJSON(t, entitlementReceipt("applied"))
	var object map[string]any
	if err := json.Unmarshal([]byte(raw), &object); err != nil {
		t.Fatal(err)
	}
	if len(object) != 10 {
		t.Fatalf("receipt keys = %d, want 10", len(object))
	}
}
