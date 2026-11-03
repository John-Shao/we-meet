package api_test

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/egressclient"
	"github.com/we-meet/work/internal/host"
)

// The session/CSRF sweep proves a stranger cannot reach a handler. This one proves the two
// in-app boundaries behind it: an organization *member* must be refused the admin surface, and a
// member *without a Work seat* must be refused every write. Both decisions are made per handler,
// so a route that forgets one stays invisible to the feature tests, which almost all sign in as
// the owner.
//
// Routes are read from the contract, for the reason the previous sweep gives: the drift gate keeps
// the handler set equal to the contract, so the contract is the widest set the handlers can have.
//
// Two honest limits shape the assertions. First, most handlers validate the payload shape before
// the role or seat check, so a bare "{}" probe answers 400 invalid_request rather than the guard's
// code; those routes are probed again with a well-formed body. Second, a few admin routes need
// dependencies this harness does not wire - work.set_provider_config probes the candidate endpoint
// through egress, and work.create_provider_credential encrypts the key with the KMS master - and
// they answer 503 service_degraded for a member whatever the caller's role. So the sweep asserts
// "never served" for every route and requires the exact guard code on a counted number of them,
// which keeps the test honest about what it can and cannot show from here.
//
// CSRF tokens are minted directly, not fetched from /bootstrap: work_seat_required makes bootstrap
// itself refuse a seatless session (internal/api/bootstrap.go:268-272) and the token is bound to
// subject, org and session revision (auth.go:49-51).

func TestMemberAndSeatlessSessionsAreRefusedAcrossTheRouteTable(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	// The content store has to exist here, or POST /work/v1/inputs stops at service_degraded
	// inside the store dependency instead of reaching the seat gate.
	store := newTestContentStore(t)
	// sub_target is an active member with a seat and no admin role; sub_noseat is active with
	// work_seat = false. Both come from the ownership-transfer fixture.
	seedTransferMembers(t, dbName)

	type route struct {
		method string
		path   string
		body   string
	}
	var adminOps, memberWrites []route
	for _, entry := range registeredRoutes(t) {
		op := route{entry.method, entry.path, ""}
		if strings.Contains(op.path, "/admin/") {
			adminOps = append(adminOps, op)
			continue
		}
		if op.method != "GET" {
			memberWrites = append(memberWrites, op)
		}
	}
	if len(adminOps) < 10 || len(memberWrites) < 8 {
		t.Fatalf("split the contract into %d admin operations and %d member writes; either count is "+
			"too small for this sweep to say anything", len(adminOps), len(memberWrites))
	}

	csrf := testCSRF(t)
	verifier := &stubVerifier{claims: claimsFor(transferTarget)}
	httpAPIServer, err := api.NewServerWithContent(pool, verifier, csrf, store,
		log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	// The three admin routes that previously stopped at service_degraded need the two real
	// dependencies of the provider write path: the KMS master key that seals a submitted api_key,
	// and the egress prober that work.set_provider_config consults before it commits. Both exist
	// for the provider tests already, so wiring them here turns "never served" into the exact
	// role-guard assertion.
	httpAPIServer.SetProviderMasterKey(providerTestMaster)
	httpAPIServer.SetProviderProber(&fakeProber{
		result: egressclient.Result{Verdict: egressclient.VerdictOK}})
	server := httptest.NewServer(httpAPIServer.Handler())
	t.Cleanup(server.Close)
	memberToken := mustIssue(t, csrf, transferTarget)
	seatlessToken := mustIssue(t, csrf, transferNoSeat)
	ownerToken := mustIssue(t, csrf, testSubject)

	// Well-formed bodies for the routes that reject a bare "{}" before they reach any check, so
	// the guard - not the decoder - is what answers.
	overrides := map[string]string{
		"GET /work/v1/admin/usage":                                       "?from=2026-10-01&to=2026-10-02",
		"POST /work/v1/admin/provider-config/revoke":                     `{"reason":"rotating_vendor"}`,
		"POST /work/v1/admin/provider-credentials/{credentialId}/rotate": `{"api_key":"an-enough-length-key"}`,
		"POST /work/v1/admin/provider-credentials/{credentialId}/revoke": `{"reason":"seat_revoked"}`,
		"POST /work/v1/admin/provider-credentials":                       `{"provider":"deepseek","mode":"managed_key","api_key":"an-enough-length-key"}`,
		"POST /work/v1/inputs":                                           `{"client_request_id":"sweep-seat-input","goal":"sweep","background":""}`,
		"DELETE /work/v1/tasks/{taskId}":                                 `{"client_request_id":"sweep-seat-delete","expected_revision":0}`,
		"POST /work/v1/tasks/{taskId}/runs":                              `{"client_request_id":"sweep-seat-retry","expected_revision":0,"target":{"kind":"cloud","profile":"text-v1"}}`,
		"POST /work/v1/runs/{runId}/cancel":                              `{"client_request_id":"sweep-seat-cancel","reason":"operator_request"}`,
		"PUT /work/v1/admin/provider-config": `{"provider":"deepseek","model":"m","region":"r",` +
			`"endpoint":"https://x.example/v1","credential_mode":"managed_key","credential_id":"` +
			guardFixtureUUID + `","expected_revision":0}`,
	}

	probe := func(login, token string, routes []route, wantCode string) (exact int, gated, served []string) {
		verifier.claims = claimsFor(login)
		for _, op := range routes {
			path, body := op.path, op.body
			if override, ok := overrides[op.method+" "+op.path]; ok {
				if strings.HasPrefix(override, "?") {
					path += override
				} else {
					body = override
				}
			}
			response := signedRequest(t, server, op.method, path, "session-value", token, body)
			status, code := guardBodyCode(t, response)
			switch {
			case status < http.StatusBadRequest:
				served = append(served, op.method+" "+op.path+"="+http.StatusText(status))
			case code == wantCode:
				exact++
			default:
				gated = append(gated, op.method+" "+op.path+"="+
					http.StatusText(status)+"/"+code)
			}
		}
		return exact, gated, served
	}

	// 1. The admin surface as a plain member: nothing may be served, and most routes must answer
	// with the role guard's own code. The download route is expected to refuse with
	// download_token_invalid, since its handler inspects X-Download-Token before any SQL runs
	// (admin.go:283-287) - refused for a different reason, still refused.
	exact, gated, served := probe(transferTarget, memberToken, adminOps, "admin_access_denied")
	if len(served) != 0 {
		t.Fatalf("admin operations that *served* a plain member: %s - those routes are readable or "+
			"writable without the admin role", strings.Join(served, ", "))
	}
	t.Logf("admin surface as a member: %d of %d answered admin_access_denied; the rest refused for "+
		"another reason: %s", exact, len(adminOps), strings.Join(gated, ", "))
	// 13 of 16 once the egress prober and the KMS master key are wired: the three provider write
	// routes then reach the role guard instead of stopping at service_degraded. The remaining
	// three are accounted for in the line above - the download route keys on the token, and the
	// two /work/v2 faces validate their payloads first.
	if exact < 13 {
		t.Fatalf("only %d admin operations reached work.assert_org_admin; want at least 6, or this "+
			"sweep is not testing the role guard", exact)
	}

	// 2. Writes as a seatless member: nothing may be served, and most must answer with the seat
	// guard's code (0002 via requireSeat, tasks.go:426).
	seatExact, seatGated, seatServed := probe(transferNoSeat, seatlessToken, memberWrites,
		"work_seat_required")
	if len(seatServed) != 0 {
		t.Fatalf("write operations that *served* a seatless member: %s - the seat gate is missing on "+
			"those routes", strings.Join(seatServed, ", "))
	}
	t.Logf("member writes as a seatless member: %d of %d answered work_seat_required; the rest: %s",
		seatExact, len(memberWrites), strings.Join(seatGated, ", "))
	// 7 of the 9 reach requireSeat. The other two are refused before it - DELETE on payload shape,
	// retry on the non-owner task lookup - and both stay visible in the line above instead of
	// being counted as passes.
	if seatExact < 7 {
		t.Fatalf("only %d write operations reached requireSeat; want 7 of %d, or this sweep is not "+
			"testing the seat guard", seatExact, len(memberWrites))
	}

	// 3. Positive control, without which 1 and 2 could both be passing on a server that refuses
	// everyone: the owner reads the admin surface and is not seat- or role-blocked on a write.
	verifier.claims = claimsFor(testSubject)
	overview := signedRequest(t, server, http.MethodGet, "/work/v1/admin/overview",
		"session-value", ownerToken, "")
	if status, code := guardBodyCode(t, overview); status != http.StatusOK || code != "" {
		t.Fatalf("owner reading /work/v1/admin/overview = %d/%s, want 200 with no error code",
			status, code)
	}
	input := signedRequest(t, server, http.MethodPost, "/work/v1/inputs", "session-value", ownerToken,
		`{"client_request_id":"sweep-owner-input-1","goal":"sweep","background":""}`)
	if status, code := guardBodyCode(t, input); status == http.StatusForbidden &&
		(code == "work_seat_required" || code == "admin_access_denied") {
		t.Fatalf("owner writing /work/v1/inputs refused with %s: the seatless sweep above would then "+
			"be refusing everyone, not the seatless member", code)
	}
	t.Logf("swept %d admin operations as a member and %d writes as a seatless member; the owner "+
		"passes both guards", len(adminOps), len(memberWrites))
}

func signedRequest(t *testing.T, server *httptest.Server, method, path, cookie, csrfToken,
	body string) *http.Response {
	t.Helper()
	if body == "" {
		body = "{}"
	}
	request, err := http.NewRequest(method, server.URL+guardURL(path), strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: cookie})
	request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: csrfToken})
	request.Header.Set(api.CSRFHeaderName, csrfToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func mustIssue(t *testing.T, csrf *api.CSRF, subject string) string {
	t.Helper()
	token, err := csrf.Issue(subject, testOrg, 4)
	if err != nil {
		t.Fatalf("issuing a CSRF token for %s: %v", subject, err)
	}
	return token
}

func guardBodyCode(t *testing.T, response *http.Response) (int, string) {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("response is not the public error envelope: status=%d body=%s",
			response.StatusCode, string(body))
	}
	return response.StatusCode, payload.Code
}
