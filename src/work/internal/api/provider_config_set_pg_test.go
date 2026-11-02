package api_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/egressclient"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

// setProviderConfig is the endpoint the contract gates on a pre-save connectivity probe
// ("失败不生效"), so the interesting assertions here are all about what is NOT written.

type fakeProber struct {
	result egressclient.Result
	err    error
	calls  int
	org    string
	grant  string
	token  string
}

func (f *fakeProber) Probe(_ context.Context, orgID, grantID, token string) (egressclient.Result, error) {
	f.calls++
	f.org, f.grant, f.token = orgID, grantID, token
	return f.result, f.err
}

func newProbedServerWithClaims(t *testing.T, pool *pgxpool.Pool, prober api.ProviderProber,
	claims host.Claims) *httptest.Server {
	t.Helper()
	server, err := api.NewServer(pool, &stubVerifier{claims: claims}, testCSRF(t),
		log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	// The same 32-byte key the credential endpoints need: set_provider_config will
	// reference a managed_key credential, and an unset key fails the write closed.
	server.SetProviderMasterKey(providerTestMaster)
	if prober != nil {
		server.SetProviderProber(prober)
	}
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

func newProbedServer(t *testing.T, pool *pgxpool.Pool, prober api.ProviderProber) *httptest.Server {
	t.Helper()
	return newProbedServerWithClaims(t, pool, prober, testClaims())
}

func readAll(response *http.Response) string {
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
	return string(body)
}

func seedManagedCredential(t *testing.T, dbName, provider string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if err := testpg.ExecRaw(ctx, conn, `
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ('org_a', 'sub_a', 'active', 'owner', true)
		ON CONFLICT DO NOTHING;
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
		VALUES ('org_a', 'sub_member', 'active', 'member', true)
		ON CONFLICT DO NOTHING;`); err != nil {
		t.Fatal(err)
	}
	var id string
	err = conn.QueryRow(ctx, `
		INSERT INTO work.provider_credential
		  (id, org_id, provider, mode, secret_ciphertext, secret_fingerprint, created_by)
		VALUES (gen_random_uuid(), 'org_a', $1, 'managed_key', '\x0102'::bytea,
		        'fp-set-00000001', 'sub_a')
		RETURNING id::text`, provider).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func providerConfigBody(credentialID string, revision int64) string {
	return `{"provider":"aliyun","model":"qwen-max","region":"cn-north",` +
		`"endpoint":"https://dashscope.example.test/v1","credential_mode":"managed_key",` +
		`"credential_id":"` + credentialID + `","expected_revision":` + itoa64(revision) + `}`
}

func itoa64(value int64) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	n := value
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}

func activeConfigCount(t *testing.T, dbName string) int {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var count int
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM work.provider_access_config
		WHERE org_id = 'org_a' AND state = 'active'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func openConfigRevisions(t *testing.T, dbName string) []int64 {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	rows, err := conn.Query(ctx, `
		SELECT revision FROM work.provider_access_config
		WHERE org_id = 'org_a' ORDER BY revision`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var revision int64
		if err := rows.Scan(&revision); err != nil {
			t.Fatal(err)
		}
		out = append(out, revision)
	}
	return out
}

func grantDigests(t *testing.T, dbName string) []string {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	rows, err := conn.Query(ctx, `
		SELECT token_hash FROM work.provider_probe_grant WHERE org_id = 'org_a'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var hash string
		if err := rows.Scan(&hash); err != nil {
			t.Fatal(err)
		}
		out = append(out, hash)
	}
	return out
}

func TestSetProviderConfigSavesOnlyAfterASuccessfulProbe(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	credentialID := seedManagedCredential(t, dbName, "aliyun")

	prober := &fakeProber{result: egressclient.Result{Verdict: egressclient.VerdictOK}}
	server := newProbedServer(t, pool, prober)
	csrf := workspaceCSRF(t, server.URL)

	response := taskRequest(t, http.MethodPut, server.URL+api.AdminProviderConfigPath, csrf,
		providerConfigBody(credentialID, 0))
	if response.StatusCode != http.StatusOK {
		payload, _ := json.Marshal(response.Body)
		t.Fatalf("set status = %d body=%s", response.StatusCode, payload)
	}
	var view map[string]any
	if err := json.NewDecoder(response.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if view["revision"] != float64(1) || view["state"] != "active" {
		t.Fatalf("view = %#v", view)
	}
	if credential, ok := view["credential"].(map[string]any); !ok ||
		credential["credential_id"] != credentialID {
		t.Fatalf("view credential = %#v", view["credential"])
	}
	if prober.calls != 1 {
		t.Fatalf("probe calls = %d, want 1", prober.calls)
	}
	// The gateway must be shown the candidate the caller asked about, not the live one.
	if prober.org != "org_a" || prober.grant == "" || len(prober.token) != 64 {
		t.Fatalf("probe args org=%q grant=%q token len=%d", prober.org, prober.grant,
			len(prober.token))
	}
	sum := sha256.Sum256([]byte(prober.token))
	if got := hex.EncodeToString(sum[:]); len(grantDigests(t, dbName)) != 1 ||
		!strings.Contains(strings.Join(grantDigests(t, dbName), ","), got[:16]) {
		t.Fatalf("stored grant digests = %v, want the sha256 of the presented token",
			grantDigests(t, dbName))
	}
	if activeConfigCount(t, dbName) != 1 {
		t.Fatalf("active configs = %d, want 1", activeConfigCount(t, dbName))
	}

	// A second write supersedes the first and the revision moves; the client must send
	// the revision it observed.
	prober.result = egressclient.Result{Verdict: egressclient.VerdictOK}
	response = taskRequest(t, http.MethodPut, server.URL+api.AdminProviderConfigPath, csrf,
		providerConfigBody(credentialID, 1))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("second set status = %d body=%s", response.StatusCode, readAll(response))
	}
	response.Body.Close()
	if revisions := openConfigRevisions(t, dbName); len(revisions) != 2 {
		t.Fatalf("revisions = %v, want two rows", revisions)
	}
	if activeConfigCount(t, dbName) != 1 {
		t.Fatalf("active configs after supersede = %d, want 1", activeConfigCount(t, dbName))
	}
}

// TestSetProviderConfigConflictCarriesTheCurrentRevision is the end-to-end proof for
// migration 0025: without a numeric DETAIL the catalogue's own guard turns this 409 into
// a 503, so the assertion on current_revision is the thing that would break.
func TestSetProviderConfigConflictCarriesTheCurrentRevision(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	credentialID := seedManagedCredential(t, dbName, "aliyun")
	prober := &fakeProber{result: egressclient.Result{Verdict: egressclient.VerdictOK}}
	server := newProbedServer(t, pool, prober)
	csrf := workspaceCSRF(t, server.URL)

	response := taskRequest(t, http.MethodPut, server.URL+api.AdminProviderConfigPath, csrf,
		providerConfigBody(credentialID, 0))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("prime status = %d body=%s", response.StatusCode, readAll(response))
	}
	response.Body.Close()

	// Stale expectation: revision 0 while the live config is at revision 1.
	response = taskRequest(t, http.MethodPut, server.URL+api.AdminProviderConfigPath, csrf,
		providerConfigBody(credentialID, 0))
	defer response.Body.Close()
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("stale write status = %d body=%s, want 409",
			response.StatusCode, readAll(response))
	}
	var payload struct {
		Code            string `json:"code"`
		CurrentRevision *int64 `json:"current_revision"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Code != "version_conflict" {
		t.Fatalf("code = %q, want version_conflict", payload.Code)
	}
	if payload.CurrentRevision == nil || *payload.CurrentRevision != 1 {
		t.Fatalf("current_revision = %v, want 1 (0025's DETAIL)", payload.CurrentRevision)
	}
	// The refused write must not have superseded anything, and must not have probed twice
	// for a config it never intended to keep.
	if activeConfigCount(t, dbName) != 1 {
		t.Fatalf("active configs = %d, want the single primed one", activeConfigCount(t, dbName))
	}
}

func TestSetProviderConfigNeverSavesAnUnprobedConfiguration(t *testing.T) {
	cases := []struct {
		name       string
		result     egressclient.Result
		probeErr   error
		wantStatus int
		wantCode   string
	}{
		{"provider refused", egressclient.Result{Verdict: egressclient.VerdictRejected,
			Code: "provider_rejected"}, nil, http.StatusUnprocessableEntity, "provider_not_configured"},
		{"inconclusive", egressclient.Result{Verdict: egressclient.VerdictUnknown,
			Code: "rate_limited"}, nil, http.StatusServiceUnavailable, "service_degraded"},
		{"gateway declined", egressclient.Result{Verdict: egressclient.VerdictRefused},
			nil, http.StatusServiceUnavailable, "service_degraded"},
		{"gateway unreachable", egressclient.Result{}, egressclient.ErrUnavailable,
			http.StatusServiceUnavailable, "service_degraded"},
		{"grant refused", egressclient.Result{}, egressclient.ErrGrantInvalid,
			http.StatusServiceUnavailable, "service_degraded"},
	}
	for _, item := range cases {
		pool, dbName := newBootstrapDB(t, true, true)
		credentialID := seedManagedCredential(t, dbName, "aliyun")
		prober := &fakeProber{result: item.result, err: item.probeErr}
		server := newProbedServer(t, pool, prober)
		csrf := workspaceCSRF(t, server.URL)

		response := taskRequest(t, http.MethodPut, server.URL+api.AdminProviderConfigPath, csrf,
			providerConfigBody(credentialID, 0))
		assertAPICode(t, response, item.wantStatus, item.wantCode)
		if activeConfigCount(t, dbName) != 0 {
			t.Fatalf("%s: a config was saved after verdict %q/%v",
				item.name, item.result.Verdict, item.probeErr)
		}
	}
}

// TestSetProviderConfigFailsClosedWithoutAGateway is the deployment-ordering guard: work-api
// may boot before WORK_EGRESS_URL exists, but it must refuse the write rather than skip
// the probe the contract requires.
func TestSetProviderConfigFailsClosedWithoutAGateway(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	credentialID := seedManagedCredential(t, dbName, "aliyun")
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)

	response := taskRequest(t, http.MethodPut, server.URL+api.AdminProviderConfigPath, csrf,
		providerConfigBody(credentialID, 0))
	assertAPICode(t, response, http.StatusServiceUnavailable, "service_degraded")
	if activeConfigCount(t, dbName) != 0 {
		t.Fatal("an unprobed provider config was saved")
	}
}

func TestSetProviderConfigRequestShapeAndGuards(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	credentialID := seedManagedCredential(t, dbName, "aliyun")
	prober := &fakeProber{result: egressclient.Result{Verdict: egressclient.VerdictOK}}
	server := newProbedServer(t, pool, prober)
	csrf := workspaceCSRF(t, server.URL)
	url := server.URL + api.AdminProviderConfigPath

	base := providerConfigBody(credentialID, 0)
	invalid := []struct{ name, body string }{
		{"empty", ``},
		{"missing expected_revision", strings.Replace(base, `,"expected_revision":0`, ``, 1)},
		{"negative revision", strings.Replace(base, `"expected_revision":0`, `"expected_revision":-1`, 1)},
		{"unknown field", strings.Replace(base, `}`, `,"org_id":"org_a"}`, 1)},
		{"trailing object", base + ` {}`},
		{"missing region", `{"provider":"aliyun","model":"m","endpoint":"https://x.test/v1",` +
			`"credential_mode":"managed_key","credential_id":"` + credentialID +
			`","expected_revision":0}`},
		{"malformed credential id", strings.Replace(base, credentialID, "not-a-uuid", 1)},
	}
	for _, item := range invalid {
		prober.calls = 0
		response := taskRequest(t, http.MethodPut, url, csrf, item.body)
		assertAPICode(t, response, http.StatusBadRequest, "invalid_request")
		if prober.calls != 0 {
			t.Fatalf("%s: the gateway was dialled for a malformed request", item.name)
		}
	}

	// The CSRF guard precedes the probe and the write.
	request, err := http.NewRequest(http.MethodPut, url, strings.NewReader(base))
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
	request.Header.Set("Content-Type", "application/json")
	untokened, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, untokened, http.StatusForbidden, "csrf_invalid")

	// A non-owner is refused by the domain function, before any dial.
	memberServer := newProbedServerWithClaims(t, pool, prober, host.Claims{
		SubjectID: "sub_member", OrgID: "org_a", SessionRevision: 4,
	})
	response := taskRequest(t, http.MethodPut, memberServer.URL+api.AdminProviderConfigPath,
		workspaceCSRF(t, memberServer.URL), base)
	assertAPICode(t, response, http.StatusForbidden, "admin_access_denied")
}
