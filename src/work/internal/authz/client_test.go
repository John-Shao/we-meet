package authz_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/authz"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *authz.Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := authz.NewClient(authz.ClientConfig{BaseURL: server.URL, Timeout: 2 * time.Second, Transport: http.DefaultTransport})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestClientRoundTripsCommands(t *testing.T) {
	seen := map[string]map[string]any{}
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("request body: %v", err)
		}
		command := strings.TrimPrefix(r.URL.Path, "/internal/v1/commands/")
		seen[command] = body
		switch command {
		case "claim_runtime_execution":
			_ = json.NewEncoder(w).Encode(authz.ExecutionLease{
				ExecutionID: "exec-1", HolderID: "parent-workload:abc", State: "claimed",
			})
		case "renew_runtime_execution":
			_ = json.NewEncoder(w).Encode(authz.ExecutionLease{
				ExecutionID: "exec-1", HolderID: "parent-workload:abc", State: "active",
			})
		case "issue_capability":
			_ = json.NewEncoder(w).Encode(authz.IssuedCapability{
				Token: "opaque-token-1", Generation: 4,
				ExpiresAt: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC),
			})
		case "consume_dispatch_delivery":
			_ = json.NewEncoder(w).Encode(authz.ConsumeDecision{
				Won: true, GateState: "consumed", ReceiptSlotID: "slot-1",
			})
		case "consume_dispatch_by_execution":
			_ = json.NewEncoder(w).Encode(authz.ConsumeDecision{
				Won: false, GateState: "consumed", ReceiptSlotID: "slot-2",
			})
		case "attach_dispatch_receipt":
			_ = json.NewEncoder(w).Encode(map[string]any{})
		default:
			t.Errorf("unexpected command %q", command)
		}
	})
	ctx := context.Background()

	lease, err := client.Claim(ctx, authz.ExecutionRequest{OrgID: "org_a", ExecutionID: "exec-1"})
	if err != nil || lease.State != "claimed" || lease.HolderID != "parent-workload:abc" {
		t.Fatalf("claim = %#v, %v", lease, err)
	}
	if _, ok := seen["claim_runtime_execution"]["holder_id"]; ok {
		t.Fatal("claim must not send a holder id")
	}
	renewed, err := client.Renew(ctx, authz.ExecutionRequest{
		OrgID: "org_a", ExecutionID: "exec-1", HolderID: "parent-workload:abc", HeartbeatSeq: 2,
	})
	if err != nil || renewed.State != "active" {
		t.Fatalf("renew = %#v, %v", renewed, err)
	}
	issued, err := client.IssueCapability(ctx, authz.IssueCapabilityRequest{
		OrgID: "org_a", ExecutionID: "exec-1", Audience: "work-content",
	})
	if err != nil || issued.Token != "opaque-token-1" || issued.Generation != 4 {
		t.Fatalf("issue capability = %#v, %v", issued, err)
	}
	if issued.ExpiresAt.IsZero() || !issued.ExpiresAt.Equal(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("expires_at = %v", issued.ExpiresAt)
	}
	issueBody := seen["issue_capability"]
	if len(issueBody) != 3 ||
		issueBody["org_id"] != "org_a" ||
		issueBody["execution_id"] != "exec-1" ||
		issueBody["audience"] != "work-content" {
		t.Fatalf("issue body = %#v", issueBody)
	}
	decision, err := client.Consume(ctx, authz.DeliveryRequest{
		OrgID: "org_a", OperationID: "op-1", AttemptID: "attempt-1", ExecutionID: "exec-1",
		RequestHash: "sha256:aa", RunFence: 3, HolderID: "parent-workload:abc",
	})
	if err != nil || !decision.Won || decision.ReceiptSlotID != "slot-1" {
		t.Fatalf("consume = %#v, %v", decision, err)
	}
	if seen["consume_dispatch_delivery"]["run_fence"] != float64(3) {
		t.Fatalf("consume body = %#v", seen["consume_dispatch_delivery"])
	}
	executionDecision, err := client.ConsumeByExecution(ctx, authz.ExecutionConsumeRequest{
		OrgID: "org_a", ExecutionID: "exec-1", RequestHash: "sha256:aa",
	})
	if err != nil || executionDecision.Won || executionDecision.ReceiptSlotID != "slot-2" {
		t.Fatalf("execution consume = %#v, %v", executionDecision, err)
	}
	executionBody := seen["consume_dispatch_by_execution"]
	if len(executionBody) != 3 ||
		executionBody["org_id"] != "org_a" ||
		executionBody["execution_id"] != "exec-1" ||
		executionBody["request_hash"] != "sha256:aa" {
		t.Fatalf("execution consume body = %#v", executionBody)
	}
	if err := client.Attach(ctx, authz.ReceiptRequest{
		OrgID: "org_a", OperationID: "op-1", ExecutionID: "exec-1", AttemptID: "attempt-1",
		ReceiptSlotID: "slot-1", ReceiptRef: "content://work/org_a/x", ReceiptHash: "sha256:bb",
		ReceiptResult: authz.ReceiptSucceeded,
	}); err != nil {
		t.Fatalf("attach: %v", err)
	}
}

func TestClientMapsRemoteErrorCodes(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "gate_already_consumed"})
	})
	_, err := client.Consume(context.Background(), authz.DeliveryRequest{OrgID: "org_a"})
	var remote *authz.RemoteError
	if err == nil || !strings.Contains(err.Error(), "gate_already_consumed") {
		t.Fatalf("error = %v", err)
	}
	if !errors.As(err, &remote) || remote.Status != http.StatusConflict {
		t.Fatalf("remote = %#v, %v", remote, err)
	}
}

func TestClientIssueErrorNeverEchoesResponseBody(t *testing.T) {
	const marker = "opaque-token-must-not-leak-7f3a"
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"code":  "runtime_capability_audience_not_allowed",
			"token": marker,
		})
	})
	_, err := client.IssueCapability(context.Background(), authz.IssueCapabilityRequest{
		OrgID: "org_a", ExecutionID: "exec-1", Audience: "work-egress",
	})
	var remote *authz.RemoteError
	if !errors.As(err, &remote) || remote.Code != "runtime_capability_audience_not_allowed" {
		t.Fatalf("error = %v, remote = %#v", err, remote)
	}
	if strings.Contains(err.Error(), marker) {
		t.Fatal("issuance error echoed the response body")
	}
}

func TestClientRejectsMalformedResponsesAndMissingURL(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<html>gateway</html>"))
	})
	if _, err := client.Claim(context.Background(), authz.ExecutionRequest{OrgID: "org_a"}); err == nil {
		t.Fatal("malformed success body was accepted")
	}
	client = newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>gateway</html>"))
	})
	_, err := client.Claim(context.Background(), authz.ExecutionRequest{OrgID: "org_a"})
	var remote *authz.RemoteError
	if !errors.As(err, &remote) || remote.Code != "internal_error" || remote.Status != http.StatusBadGateway {
		t.Fatalf("error = %v", err)
	}
	if _, err := authz.NewClient(authz.ClientConfig{}); err == nil {
		t.Fatal("empty base URL was accepted")
	}
}

func TestClientHonoursContextCancellation(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := client.Claim(ctx, authz.ExecutionRequest{OrgID: "org_a"}); err == nil {
		t.Fatal("cancelled call returned no error")
	}
}
