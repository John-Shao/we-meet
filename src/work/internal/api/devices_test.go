package api_test

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/host"
	"github.com/we-meet/work/internal/testpg"
)

// stubBearerVerifier stands in for the Host v3 access transport (control-design
// §2.2), which is a separate frozen dependency. It returns the same merged
// (org, subject) as the cookie stub but on the bearer plane, so the device face
// can be exercised end-to-end against the landed SQL without that transport.
type stubBearerVerifier struct {
	claims host.Claims
	err    error
	token  string
}

func (s *stubBearerVerifier) VerifyBearer(_ context.Context, token, _ string) (host.Claims, error) {
	s.token = token
	return s.claims, s.err
}

func newDeviceServer(t *testing.T, pool *pgxpool.Pool) *httptest.Server {
	t.Helper()
	server, err := api.NewServer(pool, &stubVerifier{claims: testClaims()}, testCSRF(t), log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	server.SetBearerVerifier(&stubBearerVerifier{claims: testClaims()})
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

// seedDeviceLocalPolicy configures the organization's directory classification
// mapping so local_policy_gate reads ready; without it pair_device refuses with
// local_policy_not_configured (device-design §2.1, control-design §9).
func seedDeviceLocalPolicy(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SET app.org_id = '` + testOrg + `';
		INSERT INTO work.local_execution_policy
			(org_id, allowed_tools, allowed_destinations, classification_rules,
			 classification_default, classification_default_confirmed, classification_floor,
			 readonly_max_actions, readonly_ttl, input_limit_bytes, output_limit_bytes)
		VALUES ('` + testOrg + `',
			ARRAY['workspace.list','workspace.read','workspace.search','artifact.write'],
			ARRAY['device_local'],
			'[{"matcher":{"path_prefix":"docs"},"classification":"local_only","max_confirmable":"local_only"},
			  {"matcher":{"path_prefix":"public"},"classification":"remote_excerpt_allowed","max_confirmable":"remote_excerpt_allowed"}]'::jsonb,
			'local_only', true, 'remote_excerpt_allowed', 3, interval '1 hour', 262144, 262144);
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

const deviceTestJWK = `{"crv":"P-256","kty":"EC","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}`

func deviceRequest(t *testing.T, method, url, body string) *http.Response {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer desktop-token")
	request.Header.Set("X-Work-Client", "desktop")
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func TestDevicePairingLifecycle(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)

	pairBody := `{"client_request_id":"pair-0001","device_name":"desk","platform":"windows-x64","public_key_jwk":` + deviceTestJWK + `}`
	response := deviceRequest(t, http.MethodPost, server.URL+api.DevicePairingsPath, pairBody)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("pair status = %d body=%s", response.StatusCode, readBody(response))
	}
	pairing := decodeObject(t, response)
	pairingID, _ := pairing["pairing_id"].(string)
	deviceID, _ := pairing["device_id"].(string)
	challenge, _ := pairing["challenge"].(string)
	if pairingID == "" || deviceID == "" || challenge == "" {
		t.Fatalf("pairing missing fields: %#v", pairing)
	}

	confirmBody := `{"client_request_id":"confirm-0001","challenge":"` + challenge + `","signature":"sha256:` + strings.Repeat("a", 64) + `"}`
	confirmPath := strings.ReplaceAll(api.DevicePairingConfirmPath, "{pairingId}", pairingID)
	response = deviceRequest(t, http.MethodPost, server.URL+confirmPath, confirmBody)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("confirm status = %d body=%s", response.StatusCode, readBody(response))
	}
	confirmed := decodeObject(t, response)
	if confirmed["status"] != "active" || confirmed["device_id"] != deviceID {
		t.Fatalf("confirm = %#v", confirmed)
	}

	response = deviceRequest(t, http.MethodGet, server.URL+api.DevicesPath, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d body=%s", response.StatusCode, readBody(response))
	}
	list := decodeObject(t, response)
	items, _ := list["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %#v, want one device", list["items"])
	}
	item, _ := items[0].(map[string]any)
	if item["device_id"] != deviceID || item["status"] != "active" || item["auth_plane"] != "bearer" {
		t.Fatalf("device = %#v", item)
	}

	revokePath := strings.ReplaceAll(api.DeviceRevokePath, "{deviceId}", deviceID)
	response = deviceRequest(t, http.MethodPost, server.URL+revokePath, `{"client_request_id":"revoke-0001","reason":"lost"}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("revoke status = %d body=%s", response.StatusCode, readBody(response))
	}
	revoked := decodeObject(t, response)
	if revoked["status"] != "revoked" || revoked["device_id"] != deviceID {
		t.Fatalf("revoke = %#v", revoked)
	}
}

func TestDeviceFaceRequiresBearerPlane(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)
	url := server.URL + api.DevicePairingsPath
	body := `{"client_request_id":"pair-0002","device_name":"desk","platform":"windows-x64","public_key_jwk":` + deviceTestJWK + `}`

	// A cookie session must not reach the bearer-only device face: even with the
	// shell header, no Authorization credential means unauthorized (§1.1 planes
	// never satisfy each other).
	request, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	request.Header.Set("X-Work-Client", "desktop")
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	cookie, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, cookie, http.StatusUnauthorized, "unauthorized")

	// The shell must identify itself; a bearer request without X-Work-Client is
	// refused with the CSRF code (§1.1 bearer-plane replacement for double-submit).
	request, _ = http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer desktop-token")
	request.Header.Set("Content-Type", "application/json")
	noClient, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, noClient, http.StatusForbidden, "csrf_invalid")

	// A cross-site request is refused even with the shell header.
	request, _ = http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer desktop-token")
	request.Header.Set("X-Work-Client", "desktop")
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	request.Header.Set("Content-Type", "application/json")
	crossSite, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, crossSite, http.StatusForbidden, "csrf_invalid")
}

func TestDevicePairingPolicyGate(t *testing.T) {
	pool, _ := newBootstrapDB(t, false, false)
	server := newDeviceServer(t, pool)
	body := `{"client_request_id":"pair-0003","device_name":"desk","platform":"windows-x64","public_key_jwk":` + deviceTestJWK + `}`
	response := deviceRequest(t, http.MethodPost, server.URL+api.DevicePairingsPath, body)
	assertAPICode(t, response, http.StatusConflict, "local_policy_not_configured")
}

func TestDevicePairingClosedDTOAndIdempotency(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)
	url := server.URL + api.DevicePairingsPath

	// An unlisted field is a refused request, not something the command ignores.
	unknown := `{"client_request_id":"pair-0004","device_name":"desk","platform":"windows-x64","public_key_jwk":` + deviceTestJWK + `,"extra":1}`
	assertAPICode(t, deviceRequest(t, http.MethodPost, url, unknown), http.StatusBadRequest, "invalid_request")

	body := `{"client_request_id":"pair-0005","device_name":"desk","platform":"windows-x64","public_key_jwk":` + deviceTestJWK + `}`
	first := decodeObject(t, deviceRequest(t, http.MethodPost, url, body))
	second := decodeObject(t, deviceRequest(t, http.MethodPost, url, body))
	if second["replayed"] != true || second["pairing_id"] != first["pairing_id"] {
		t.Fatalf("replay = %#v, first = %#v", second, first)
	}
}

func TestDeviceSessionTicketAndCertificateRenewal(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)

	pairBody := `{"client_request_id":"pair-0006","device_name":"desk","platform":"windows-x64","public_key_jwk":` + deviceTestJWK + `}`
	pairing := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+api.DevicePairingsPath, pairBody))
	deviceID, _ := pairing["device_id"].(string)
	thumbprint, _ := pairing["public_key_thumbprint"].(string)
	challenge, _ := pairing["challenge"].(string)
	confirmPath := strings.ReplaceAll(api.DevicePairingConfirmPath, "{pairingId}", pairing["pairing_id"].(string))
	confirmBody := `{"client_request_id":"confirm-0006","challenge":"` + challenge + `","signature":"sha256:` + strings.Repeat("b", 64) + `"}`
	if confirmed := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+confirmPath, confirmBody)); confirmed["status"] != "active" {
		t.Fatalf("confirm = %#v", confirmed)
	}

	// An active device mints a single-use session ticket bound to its key thumbprint.
	ticketPath := strings.ReplaceAll(api.DeviceSessionTicketsPath, "{deviceId}", deviceID)
	ticketBody := `{"client_request_id":"ticket-0006","public_key_thumbprint":"` + thumbprint + `"}`
	response := deviceRequest(t, http.MethodPost, server.URL+ticketPath, ticketBody)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("ticket status = %d body=%s", response.StatusCode, readBody(response))
	}
	ticket := decodeObject(t, response)
	if ticket["device_id"] != deviceID || ticket["ticket"] == nil || ticket["session_ticket_id"] == nil {
		t.Fatalf("ticket = %#v", ticket)
	}
	// A different key is refused: tickets never accept a key other than the device's.
	wrongKey := `{"client_request_id":"ticket-0007","public_key_thumbprint":"` + strings.Repeat("c", 64) + `"}`
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+ticketPath, wrongKey), http.StatusBadRequest, "invalid_request")

	// Renewal is refused until the CA has issued a certificate: confirm leaves
	// cert_not_after null (the CA signs outside the transaction), and renew requires
	// an active certificate within its last hour (device-design §2.1 step 4).
	renewPath := strings.ReplaceAll(api.DeviceCertificateRenewalsPath, "{deviceId}", deviceID)
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+renewPath, `{"client_request_id":"renew-0006"}`),
		http.StatusBadRequest, "invalid_request")
}