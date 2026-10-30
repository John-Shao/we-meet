package authz_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/authz"
)

type fakeCommands struct {
	claimed        []authz.ExecutionRequest
	holders        []string
	renewed        []authz.ExecutionRequest
	issued         []authz.IssueCapabilityRequest
	consumed       []authz.DeliveryRequest
	consumedByExec []authz.ExecutionConsumeRequest
	receipts       []authz.ReceiptRequest
	callers        []authz.Caller
	commandErr     error
}

func (f *fakeCommands) ClaimRuntimeExecution(
	_ context.Context, caller authz.Caller, request authz.ExecutionRequest, holderID string,
) (authz.ExecutionLease, error) {
	f.callers = append(f.callers, caller)
	f.claimed = append(f.claimed, request)
	f.holders = append(f.holders, holderID)
	if f.commandErr != nil {
		return authz.ExecutionLease{}, f.commandErr
	}
	return authz.ExecutionLease{ExecutionID: request.ExecutionID, State: "claimed"}, nil
}

func (f *fakeCommands) RenewRuntimeExecution(
	_ context.Context, caller authz.Caller, request authz.ExecutionRequest,
) (authz.ExecutionLease, error) {
	f.callers = append(f.callers, caller)
	f.renewed = append(f.renewed, request)
	return authz.ExecutionLease{
		ExecutionID: request.ExecutionID, HolderID: request.HolderID, State: "active",
	}, nil
}

func (f *fakeCommands) IssueRuntimeCapability(
	_ context.Context, caller authz.Caller, request authz.IssueCapabilityRequest,
) (authz.IssuedCapability, error) {
	f.callers = append(f.callers, caller)
	f.issued = append(f.issued, request)
	if f.commandErr != nil {
		return authz.IssuedCapability{}, f.commandErr
	}
	return authz.IssuedCapability{
		Token: "test-token", Generation: 1, ExpiresAt: time.Unix(1_700_000_000, 0).UTC(),
	}, nil
}

func (f *fakeCommands) ConsumeDispatchDelivery(
	_ context.Context, caller authz.Caller, request authz.DeliveryRequest,
) (authz.ConsumeDecision, error) {
	f.callers = append(f.callers, caller)
	f.consumed = append(f.consumed, request)
	if f.commandErr != nil {
		return authz.ConsumeDecision{}, f.commandErr
	}
	return authz.ConsumeDecision{Won: true, GateState: "consumed", ReceiptSlotID: "slot-1"}, nil
}

func (f *fakeCommands) ConsumeByExecution(
	_ context.Context, caller authz.Caller, request authz.ExecutionConsumeRequest,
) (authz.ConsumeDecision, error) {
	f.callers = append(f.callers, caller)
	f.consumedByExec = append(f.consumedByExec, request)
	if f.commandErr != nil {
		return authz.ConsumeDecision{}, f.commandErr
	}
	return authz.ConsumeDecision{Won: true, GateState: "consumed", ReceiptSlotID: "slot-1"}, nil
}

func (f *fakeCommands) AttachDispatchReceipt(
	_ context.Context, caller authz.Caller, request authz.ReceiptRequest,
) error {
	f.callers = append(f.callers, caller)
	f.receipts = append(f.receipts, request)
	return f.commandErr
}

func newTestServer(t *testing.T) (*authz.Server, *fakeCommands, *x509.Certificate, *x509.Certificate) {
	t.Helper()
	parent := newCertificate(t, "runtime-parent-1")
	egress := newCertificate(t, "egress-1")
	verifier, err := authz.NewRegistryVerifier(map[string]authz.Caller{
		fingerprint(parent): {Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"},
		fingerprint(egress): {Kind: authz.KindEgress, WorkloadID: "egress-workload"},
	})
	if err != nil {
		t.Fatal(err)
	}
	commands := &fakeCommands{}
	server, err := authz.NewServer(verifier, commands, commands)
	if err != nil {
		t.Fatal(err)
	}
	return server, commands, parent, egress
}

func TestRegistryVerifierRejectsUnregisteredWorkloads(t *testing.T) {
	_, _, parent, _ := newTestServer(t)
	verifier, err := authz.NewRegistryVerifier(map[string]authz.Caller{
		fingerprint(parent): {Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"},
	})
	if err != nil {
		t.Fatal(err)
	}
	stranger := newCertificate(t, "stranger")
	if _, err := verifier.Verify(context.Background(), stranger); !errors.Is(err, authz.ErrUnknownWorkload) {
		t.Fatalf("error = %v, want ErrUnknownWorkload", err)
	}
	if _, err := verifier.Verify(context.Background(), nil); !errors.Is(err, authz.ErrUnknownWorkload) {
		t.Fatalf("nil certificate error = %v, want ErrUnknownWorkload", err)
	}
	caller, err := verifier.Verify(context.Background(), parent)
	if err != nil || caller.Kind != authz.KindRuntimeParent || caller.WorkloadID != "parent-workload" {
		t.Fatalf("caller = %#v, %v", caller, err)
	}
}

func TestRegistryVerifierValidatesConfiguration(t *testing.T) {
	certificate := newCertificate(t, "x")
	for name, entries := range map[string]map[string]authz.Caller{
		"empty":       {},
		"short hash":  {"abc": {Kind: authz.KindEgress, WorkloadID: "w"}},
		"bad kind":    {fingerprint(certificate): {Kind: authz.Kind("admin"), WorkloadID: "w"}},
		"empty id":    {fingerprint(certificate): {Kind: authz.KindEgress}},
		"oversize id": {fingerprint(certificate): {Kind: authz.KindEgress, WorkloadID: strings.Repeat("a", 129)}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := authz.NewRegistryVerifier(entries); err == nil {
				t.Fatal("expected configuration error")
			}
		})
	}
}

func TestHandlerRequiresClientCertificate(t *testing.T) {
	server, commands, _, _ := newTestServer(t)
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/commands/claim_runtime_execution",
		strings.NewReader(`{"org_id":"org_a","execution_id":"exec-1"}`))
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	assertCode(t, response, http.StatusUnauthorized, "client_certificate_required")

	request = httptest.NewRequest(http.MethodPost, "/internal/v1/commands/claim_runtime_execution",
		strings.NewReader(`{"org_id":"org_a","execution_id":"exec-1"}`))
	request.TLS = peerTLS(newCertificate(t, "stranger"))
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	assertCode(t, response, http.StatusUnauthorized, "unauthorized_caller")

	if len(commands.claimed) != 0 {
		t.Fatal("unauthenticated request reached the command")
	}
}

func TestHandlerEnforcesCallerKind(t *testing.T) {
	server, commands, parent, egress := newTestServer(t)

	response := post(t, server, egress, "claim_runtime_execution",
		`{"org_id":"org_a","execution_id":"exec-1"}`)
	assertCode(t, response, http.StatusForbidden, "caller_not_permitted")

	response = post(t, server, parent, "consume_dispatch_delivery",
		`{"org_id":"org_a","operation_id":"op-1","attempt_id":"a","execution_id":"e","request_hash":"h","run_fence":1,"holder_id":"h"}`)
	assertCode(t, response, http.StatusForbidden, "caller_not_permitted")

	response = post(t, server, parent, "attach_dispatch_receipt",
		`{"org_id":"org_a","operation_id":"op-1","execution_id":"e","attempt_id":"a","receipt_slot_id":"s","receipt_ref":"r","receipt_hash":"h","receipt_result":"succeeded"}`)
	assertCode(t, response, http.StatusForbidden, "caller_not_permitted")

	if len(commands.claimed)+len(commands.consumed)+len(commands.receipts) != 0 {
		t.Fatal("misclassified caller reached a command")
	}
}

func TestHandlerConsumeByExecutionIsEgressOnlyAndThin(t *testing.T) {
	server, commands, parent, egress := newTestServer(t)

	response := post(t, server, parent, "consume_dispatch_by_execution",
		`{"org_id":"org_a","execution_id":"exec-1","request_hash":"sha256:aa"}`)
	assertCode(t, response, http.StatusForbidden, "caller_not_permitted")
	if len(commands.consumedByExec) != 0 {
		t.Fatal("parent reached the egress-only command")
	}

	response = post(t, server, egress, "consume_dispatch_by_execution",
		`{"org_id":"org_a","execution_id":"exec-1","request_hash":"sha256:aa"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var decision authz.ConsumeDecision
	if err := json.NewDecoder(response.Body).Decode(&decision); err != nil {
		t.Fatal(err)
	}
	if !decision.Won || decision.ReceiptSlotID != "slot-1" {
		t.Fatalf("decision = %#v", decision)
	}
	if len(commands.consumedByExec) != 1 {
		t.Fatalf("execution consumes = %#v", commands.consumedByExec)
	}
	if got := commands.consumedByExec[0]; got != (authz.ExecutionConsumeRequest{
		OrgID: "org_a", ExecutionID: "exec-1", RequestHash: "sha256:aa",
	}) {
		t.Fatalf("request = %#v", got)
	}

	// The wire is signed: operation/attempt/run_fence/holder are derived from
	// the locked execution, never accepted from the body.
	for _, body := range []string{
		`{"org_id":"org_a","execution_id":"exec-1","request_hash":"sha256:aa","operation_id":"op-1"}`,
		`{"org_id":"org_a","execution_id":"exec-1","request_hash":"sha256:aa","attempt_id":"attempt-1"}`,
		`{"org_id":"org_a","execution_id":"exec-1","request_hash":"sha256:aa","run_fence":1}`,
		`{"org_id":"org_a","execution_id":"exec-1","request_hash":"sha256:aa","holder_id":"parent-workload:x"}`,
		`{"org_id":"org_a","execution_id":"exec-1","request_hash":"sha256:aa","mode":"execute"}`,
	} {
		body := body
		t.Run(body, func(t *testing.T) {
			response := post(t, server, egress, "consume_dispatch_by_execution", body)
			assertCode(t, response, http.StatusConflict, "invalid_request")
		})
	}

	for _, body := range []string{
		`{"org_id":"org_a","execution_id":"exec-1"}`,
		`{"org_id":"","execution_id":"exec-1","request_hash":"sha256:aa"}`,
		`{"org_id":"org_a","request_hash":"sha256:aa"}`,
		`{"org_id":"org_a","execution_id":"exec-1","request_hash":""}`,
		`{"org_id":"org_a","execution_id":"exec-1","request_hash":"sha256:aa"}{}`,
		`{"org_id":"org_a","execution_id":"exec-1","execution_id":"exec-2","request_hash":"sha256:aa"}`,
	} {
		body := body
		t.Run(body, func(t *testing.T) {
			response := post(t, server, egress, "consume_dispatch_by_execution", body)
			assertCode(t, response, http.StatusConflict, "invalid_request")
		})
	}
	if len(commands.consumedByExec) != 1 {
		t.Fatalf("malformed requests reached the command: %#v", commands.consumedByExec)
	}

	commands.commandErr = authz.Fail("runtime_request_hash_mismatch")
	response = post(t, server, egress, "consume_dispatch_by_execution",
		`{"org_id":"org_a","execution_id":"exec-1","request_hash":"sha256:bb"}`)
	assertCode(t, response, http.StatusConflict, "runtime_request_hash_mismatch")
}

func TestHandlerIssueCapabilityIsParentOnlyAndStrict(t *testing.T) {
	server, commands, parent, egress := newTestServer(t)

	response := post(t, server, egress, "issue_capability",
		`{"org_id":"org_a","execution_id":"exec-1","audience":"work-content"}`)
	assertCode(t, response, http.StatusForbidden, "caller_not_permitted")
	response = post(t, server, egress, "issue_capability",
		`{"org_id":"org_a","execution_id":"exec-1","audience":"work-egress"}`)
	assertCode(t, response, http.StatusForbidden, "caller_not_permitted")
	if len(commands.issued) != 0 {
		t.Fatalf("egress reached issuance: %#v", commands.issued)
	}

	for name, body := range map[string]string{
		"missing audience": `{"org_id":"org_a","execution_id":"exec-1"}`,
		"unknown audience": `{"org_id":"org_a","execution_id":"exec-1","audience":"work-admin"}`,
		"missing org":      `{"execution_id":"exec-1","audience":"work-content"}`,
		"missing id":       `{"org_id":"org_a","audience":"work-content"}`,
		"holder in body":   `{"org_id":"org_a","execution_id":"exec-1","audience":"work-content","holder_id":"parent-workload:forged"}`,
		"duplicate key":    `{"org_id":"org_a","execution_id":"exec-1","audience":"work-content","audience":"work-egress"}`,
		"trailing data":    `{"org_id":"org_a","execution_id":"exec-1","audience":"work-content"}{}`,
	} {
		t.Run(name, func(t *testing.T) {
			response := post(t, server, parent, "issue_capability", body)
			assertCode(t, response, http.StatusConflict, "invalid_request")
		})
	}
	if len(commands.issued) != 0 {
		t.Fatalf("malformed requests reached issuance: %#v", commands.issued)
	}

	response = post(t, server, parent, "issue_capability",
		`{"org_id":"org_a","execution_id":"exec-1","audience":"work-content"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("issue status = %d body=%s", response.Code, response.Body.String())
	}
	var issued authz.IssuedCapability
	if err := json.NewDecoder(response.Body).Decode(&issued); err != nil {
		t.Fatal(err)
	}
	if issued.Token != "test-token" || issued.Generation != 1 {
		t.Fatalf("issued = %#v", issued)
	}
	if got := commands.issued[0]; got != (authz.IssueCapabilityRequest{
		OrgID: "org_a", ExecutionID: "exec-1", Audience: "work-content",
	}) {
		t.Fatalf("request = %#v", got)
	}

	commands.commandErr = authz.Fail("runtime_capability_audience_not_allowed")
	response = post(t, server, parent, "issue_capability",
		`{"org_id":"org_a","execution_id":"exec-1","audience":"work-egress"}`)
	assertCode(t, response, http.StatusConflict, "runtime_capability_audience_not_allowed")
}

func TestHandlerRejectsUnknownCommand(t *testing.T) {
	server, _, parent, _ := newTestServer(t)
	response := post(t, server, parent, "reconcile_operation", `{}`)
	assertCode(t, response, http.StatusNotFound, "unknown_command")
	response = post(t, server, parent, "revoke_runtime_execution", `{}`)
	assertCode(t, response, http.StatusNotFound, "unknown_command")
}

func TestHandlerPassesAuthenticatedCallerAndIdentifiers(t *testing.T) {
	server, commands, parent, egress := newTestServer(t)

	response := post(t, server, parent, "claim_runtime_execution",
		`{"org_id":"org_a","execution_id":"exec-1"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("claim status = %d body=%s", response.Code, response.Body.String())
	}
	var lease authz.ExecutionLease
	if err := json.NewDecoder(response.Body).Decode(&lease); err != nil {
		t.Fatal(err)
	}
	if lease.HolderID != commands.holders[0] || lease.State == "" {
		t.Fatalf("lease = %#v holder=%q", lease, commands.holders[0])
	}
	if !strings.HasPrefix(lease.HolderID, "parent-workload:") {
		t.Fatalf("holder must be bound to the authenticated workload: %q", lease.HolderID)
	}

	post(t, server, parent, "renew_runtime_execution",
		`{"org_id":"org_a","execution_id":"exec-1","holder_id":"`+lease.HolderID+`","heartbeat_seq":2}`)
	response = post(t, server, egress, "consume_dispatch_delivery",
		`{"org_id":"org_a","operation_id":"op-1","attempt_id":"attempt-1","execution_id":"exec-1","request_hash":"sha256:aa","run_fence":1,"holder_id":"parent-workload:x"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("consume status = %d", response.Code)
	}
	var decision authz.ConsumeDecision
	if err := json.NewDecoder(response.Body).Decode(&decision); err != nil {
		t.Fatal(err)
	}
	if !decision.Won || decision.ReceiptSlotID != "slot-1" {
		t.Fatalf("decision = %#v", decision)
	}
	post(t, server, egress, "attach_dispatch_receipt",
		`{"org_id":"org_a","operation_id":"op-1","execution_id":"exec-1","attempt_id":"attempt-1","receipt_slot_id":"slot-1","receipt_ref":"receipt-1","receipt_hash":"sha256:bb","receipt_result":"succeeded"}`)

	if len(commands.callers) != 4 {
		t.Fatalf("callers = %#v", commands.callers)
	}
	if commands.callers[0] != (authz.Caller{Kind: authz.KindRuntimeParent, WorkloadID: "parent-workload"}) {
		t.Fatalf("parent caller = %#v", commands.callers[0])
	}
	if commands.callers[2] != (authz.Caller{Kind: authz.KindEgress, WorkloadID: "egress-workload"}) {
		t.Fatalf("egress caller = %#v", commands.callers[2])
	}
	if commands.renewed[0].HolderID != lease.HolderID || commands.renewed[0].HeartbeatSeq != 2 {
		t.Fatalf("renew = %#v", commands.renewed[0])
	}
	if commands.consumed[0].RequestHash != "sha256:aa" || commands.consumed[0].AttemptID != "attempt-1" {
		t.Fatalf("consume = %#v", commands.consumed[0])
	}
	if commands.receipts[0].ReceiptRef != "receipt-1" {
		t.Fatalf("receipt = %#v", commands.receipts[0])
	}
}

func TestHolderIsMintedAndBoundToCallerWorkload(t *testing.T) {
	server, commands, parent, _ := newTestServer(t)

	forged := post(t, server, parent, "claim_runtime_execution",
		`{"org_id":"org_a","execution_id":"exec-1","holder_id":"parent-workload:forged"}`)
	assertCode(t, forged, http.StatusConflict, "invalid_request")

	first := post(t, server, parent, "claim_runtime_execution",
		`{"org_id":"org_a","execution_id":"exec-1"}`)
	second := post(t, server, parent, "claim_runtime_execution",
		`{"org_id":"org_a","execution_id":"exec-1"}`)
	var firstLease, secondLease authz.ExecutionLease
	_ = json.NewDecoder(first.Body).Decode(&firstLease)
	_ = json.NewDecoder(second.Body).Decode(&secondLease)
	if firstLease.HolderID == secondLease.HolderID {
		t.Fatalf("each claim must mint a fresh holder: %q", firstLease.HolderID)
	}

	foreign := post(t, server, parent, "renew_runtime_execution",
		`{"org_id":"org_a","execution_id":"exec-1","holder_id":"egress-workload:stolen","heartbeat_seq":3}`)
	assertCode(t, foreign, http.StatusConflict, "holder_not_owned")
	if len(commands.renewed) != 0 {
		t.Fatalf("foreign holder reached renew: %#v", commands.renewed)
	}

	owned := post(t, server, parent, "renew_runtime_execution",
		`{"org_id":"org_a","execution_id":"exec-1","holder_id":"`+firstLease.HolderID+`","heartbeat_seq":3}`)
	if owned.Code != http.StatusOK {
		t.Fatalf("owned holder renew status = %d body=%s", owned.Code, owned.Body.String())
	}
}

func TestLoadRegistry(t *testing.T) {
	parent := newCertificate(t, "parent")
	registry := `{"workloads":[{"fingerprint":"` + fingerprint(parent) +
		`","kind":"runtime_parent","workload_id":"parent-workload"}]}`
	verifier, err := authz.LoadRegistry([]byte(registry))
	if err != nil {
		t.Fatal(err)
	}
	caller, err := verifier.Verify(context.Background(), parent)
	if err != nil || caller.WorkloadID != "parent-workload" {
		t.Fatalf("caller = %#v, %v", caller, err)
	}

	for name, body := range map[string]string{
		"empty":              `{"workloads":[]}`,
		"unknown field":      `{"workloads":[],"extra":1}`,
		"duplicate":          `{"workloads":[{"fingerprint":"` + fingerprint(parent) + `","kind":"egress","workload_id":"a"},{"fingerprint":"` + fingerprint(parent) + `","kind":"egress","workload_id":"b"}]}`,
		"bad kind":           `{"workloads":[{"fingerprint":"` + fingerprint(parent) + `","kind":"admin","workload_id":"a"}]}`,
		"self-declared role": `{"workloads":[{"fingerprint":"` + fingerprint(parent) + `","kind":"egress","workload_id":"a","role":"admin"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := authz.LoadRegistry([]byte(body)); err == nil {
				t.Fatal("invalid registry was accepted")
			}
		})
	}
}

func TestHandlerRejectsBodySuppliedIdentityAndBadShapes(t *testing.T) {
	server, commands, parent, _ := newTestServer(t)
	for name, body := range map[string]string{
		"caller kind":   `{"org_id":"org_a","execution_id":"exec-1","kind":"egress"}`,
		"workload id":   `{"org_id":"org_a","execution_id":"exec-1","workload_id":"forged"}`,
		"missing org":   `{"execution_id":"exec-1"}`,
		"missing id":    `{"org_id":"org_a"}`,
		"wrong type":    `{"org_id":7,"execution_id":"exec-1"}`,
		"trailing data": `{"org_id":"org_a","execution_id":"exec-1"}{"org_id":"org_b"}`,
		"duplicate key": `{"org_id":"org_a","execution_id":"exec-1","execution_id":"exec-2"}`,
	} {
		t.Run(name, func(t *testing.T) {
			response := post(t, server, parent, "claim_runtime_execution", body)
			if response.Code != http.StatusConflict && response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
			}
		})
	}
	if len(commands.claimed) != 0 {
		t.Fatalf("malformed requests reached the command: %#v", commands.claimed)
	}
}

func TestHandlerRejectsOversizedRequest(t *testing.T) {
	server, commands, parent, _ := newTestServer(t)
	body := `{"org_id":"org_a","execution_id":"` + strings.Repeat("a", 70<<10) + `"}`
	response := post(t, server, parent, "claim_runtime_execution", body)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d", response.Code)
	}
	if len(commands.claimed) != 0 {
		t.Fatal("oversized request reached the command")
	}
}

func TestHandlerReturnsEnumCodesWithoutLeakingDetails(t *testing.T) {
	server, commands, parent, egress := newTestServer(t)

	commands.commandErr = authz.Fail("gate_already_consumed")
	response := post(t, server, egress, "consume_dispatch_delivery",
		`{"org_id":"org_a","operation_id":"op-1","attempt_id":"a","execution_id":"e","request_hash":"h","run_fence":1,"holder_id":"h"}`)
	assertCode(t, response, http.StatusConflict, "gate_already_consumed")

	commands.commandErr = errors.New("goal text 机密内容 token opaque-token-9c1e and SQL detail")
	response = post(t, server, parent, "claim_runtime_execution",
		`{"org_id":"org_a","execution_id":"exec-1"}`)
	assertCode(t, response, http.StatusInternalServerError, "internal_error")
	for _, marker := range []string{"机密内容", "SQL", "goal text", "opaque-token-9c1e"} {
		if strings.Contains(response.Body.String(), marker) {
			t.Fatalf("error body leaked %q: %s", marker, response.Body.String())
		}
	}

	commands.commandErr = authz.Fail("")
	response = post(t, server, parent, "claim_runtime_execution",
		`{"org_id":"org_a","execution_id":"exec-1"}`)
	assertCode(t, response, http.StatusInternalServerError, "internal_error")
}

func TestHandlerRejectsNonPostAndEmptyCommands(t *testing.T) {
	server, _, parent, _ := newTestServer(t)
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/commands/claim_runtime_execution", nil)
	request.TLS = peerTLS(parent)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed && response.Code != http.StatusNotFound {
		t.Fatalf("GET status = %d", response.Code)
	}
}

func peerTLS(certificate *x509.Certificate) *tls.ConnectionState {
	return &tls.ConnectionState{PeerCertificates: []*x509.Certificate{certificate}}
}

func post(t *testing.T, server *authz.Server, certificate *x509.Certificate, command, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/commands/"+command, strings.NewReader(body))
	request.TLS = peerTLS(certificate)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	return response
}

func assertCode(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d (body=%s)", response.Code, status, response.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Code != code {
		t.Fatalf("code = %q, want %q", body.Code, code)
	}
}

func fingerprint(certificate *x509.Certificate) string {
	digest := sha256.Sum256(certificate.Raw)
	return hex.EncodeToString(digest[:])
}

func newCertificate(t *testing.T, commonName string) *x509.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}
