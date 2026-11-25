package api_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/deviceca"
	"github.com/we-meet/work/internal/devicesig"
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
	server := newDeviceAPIServer(t, pool)
	ca, err := deviceca.NewCA()
	if err != nil {
		t.Fatal(err)
	}
	server.SetDeviceCA(ca)
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

// newDeviceAPIServer builds the same server WITHOUT a device CA, so a test can prove the
// certificate face fails closed when the deployment has not wired one (GW20).
func newDeviceAPIServer(t *testing.T, pool *pgxpool.Pool) *api.Server {
	t.Helper()
	server, err := api.NewServer(pool, &stubVerifier{claims: testClaims()}, testCSRF(t), log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	server.SetBearerVerifier(&stubBearerVerifier{claims: testClaims()})
	return server
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

// deviceTestJWK is a real on-curve P-256 key (the deterministic software key
// from_bytes([7;32]) shared with the Rust device cross-language vectors). The
// pairing confirm handler now verifies a real ES256 signature, so the test key
// must be a valid curve point with a known private scalar (deviceTestPrivateKey).
const deviceTestJWK = `{"crv":"P-256","kty":"EC","x":"HhhTL9R1TALzBB2cdc6zO4P_2BrHzk_ogsyxyYvFiW4","y":"pGwxHE4v9A3ZajZT5uRURdMt_khuztdcepDGoYiBwKM"}`

// deviceTestPrivateKey is the private scalar matching deviceTestJWK.
func deviceTestPrivateKey() *ecdsa.PrivateKey {
	d := bytes.Repeat([]byte{7}, 32)
	priv := new(ecdsa.PrivateKey)
	priv.PublicKey.Curve = elliptic.P256()
	priv.D = new(big.Int).SetBytes(d)
	priv.X, priv.Y = priv.Curve.ScalarBaseMult(d)
	return priv
}

// signDevicePairing produces the real ES256 R||S signature (base64url, no padding)
// over the pairing covered string for the test claims, exactly as the device agent
// does. The thumbprint is derived from the test JWK so it matches the in-DB value.
func signDevicePairing(t *testing.T, pairingID, challenge string) string {
	t.Helper()
	pub, err := devicesig.ParseJWK([]byte(deviceTestJWK))
	if err != nil {
		t.Fatalf("parse test JWK: %v", err)
	}
	covered := devicesig.PairingCoveredString(pairingID, challenge, pub.Thumbprint, testOrg, testSubject)
	digest := sha256.Sum256([]byte(covered))
	r, s, err := ecdsa.Sign(rand.Reader, deviceTestPrivateKey(), digest[:])
	if err != nil {
		t.Fatalf("sign pairing: %v", err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return base64.RawURLEncoding.EncodeToString(sig)
}

// signDeviceRenewal signs the renewal covered string, which uses a DIFFERENT domain from
// pairing (§2.1 forbids reusing a signature domain across purposes).
func signDeviceRenewal(t *testing.T, pairingID, challenge string) string {
	t.Helper()
	pub, err := devicesig.ParseJWK([]byte(deviceTestJWK))
	if err != nil {
		t.Fatalf("parse test JWK: %v", err)
	}
	covered := devicesig.CertRenewalCoveredString(pairingID, challenge, pub.Thumbprint, testOrg, testSubject)
	digest := sha256.Sum256([]byte(covered))
	r, s, err := ecdsa.Sign(rand.Reader, deviceTestPrivateKey(), digest[:])
	if err != nil {
		t.Fatalf("sign renewal: %v", err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return base64.RawURLEncoding.EncodeToString(sig)
}

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
	if len(response.Cookies()) != 0 {
		t.Fatalf("Bearer pairing response set cookies: %#v", response.Cookies())
	}

	confirmBody := `{"client_request_id":"confirm-0001","challenge":"` + challenge + `","signature":"` + signDevicePairing(t, pairingID, challenge) + `"}`
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

	ctx := context.Background()
	admin, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	rows, err := admin.Query(ctx, `SELECT COALESCE(metadata ->> 'auth_plane', metadata -> 'response' ->> 'auth_plane')
		FROM work.audit_event
		WHERE org_id = $1 AND action IN ('device.pairing_created', 'device.pair.confirm')
		ORDER BY created_at`, testOrg)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	audited := 0
	for rows.Next() {
		var plane string
		if err := rows.Scan(&plane); err != nil {
			t.Fatal(err)
		}
		if plane != "bearer" {
			t.Fatalf("device audit auth_plane = %q, want bearer", plane)
		}
		audited++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if audited != 2 {
		t.Fatalf("Bearer device audit rows = %d, want pairing and confirmation", audited)
	}
}

func TestDevicePairingConfirmRejectsBadSignature(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)

	pairBody := `{"client_request_id":"pair-badsig","device_name":"desk","platform":"windows-x64","public_key_jwk":` + deviceTestJWK + `}`
	pairing := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+api.DevicePairingsPath, pairBody))
	pairingID, _ := pairing["pairing_id"].(string)
	challenge, _ := pairing["challenge"].(string)
	confirmPath := strings.ReplaceAll(api.DevicePairingConfirmPath, "{pairingId}", pairingID)

	// A valid-shape but cryptographically wrong signature (86 base64url chars) is
	// refused by the Go verification BEFORE the domain command: the device stays
	// pending. This proves the wiring verifies, not just shape-checks.
	wrongSig := strings.Repeat("A", 86)
	badBody := `{"client_request_id":"confirm-badsig","challenge":"` + challenge + `","signature":"` + wrongSig + `"}`
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+confirmPath, badBody), http.StatusUnauthorized, "unauthorized")

	// The real signature still confirms afterwards (the bad attempt consumed nothing).
	goodBody := `{"client_request_id":"confirm-badsig-ok","challenge":"` + challenge + `","signature":"` + signDevicePairing(t, pairingID, challenge) + `"}`
	if confirmed := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+confirmPath, goodBody)); confirmed["status"] != "active" {
		t.Fatalf("confirm after bad signature = %#v", confirmed)
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

// The identity face (M2 ruling 乙) returns exactly the verified claims' (org, subject)
// pair: the shell builds its §2.1 signing preimage from these two values, so the face
// must hold the same Bearer-plane invariants as the device face and leak nothing else.
func TestDeviceIdentityFace(t *testing.T) {
	pool, _ := newBootstrapDB(t, false, false)
	server := newDeviceServer(t, pool)
	url := server.URL + api.DeviceIdentityPath

	response := deviceRequest(t, http.MethodGet, url, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("identity status = %d body=%s", response.StatusCode, readBody(response))
	}
	identity := decodeObject(t, response)
	if len(identity) != 2 || identity["org_id"] != testOrg || identity["subject_id"] != testSubject {
		t.Fatalf("identity = %#v, want exactly {org_id:%s subject_id:%s}", identity, testOrg, testSubject)
	}

	// A cookie session must not satisfy the Bearer plane, even with the shell header.
	request, _ := http.NewRequest(http.MethodGet, url, nil)
	request.Header.Set("X-Work-Client", "desktop")
	request.AddCookie(&http.Cookie{Name: "sessionid", Value: "session-value"})
	cookie, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, cookie, http.StatusUnauthorized, "unauthorized")

	// No credential at all.
	noToken, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, noToken, http.StatusUnauthorized, "unauthorized")

	// A bearer credential without the shell identity is the CSRF-code refusal.
	request, _ = http.NewRequest(http.MethodGet, url, nil)
	request.Header.Set("Authorization", "Bearer desktop-token")
	noClient, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, noClient, http.StatusForbidden, "csrf_invalid")

	// Cross-site is refused even with the shell header.
	request, _ = http.NewRequest(http.MethodGet, url, nil)
	request.Header.Set("Authorization", "Bearer desktop-token")
	request.Header.Set("X-Work-Client", "desktop")
	request.Header.Set("Sec-Fetch-Site", "cross-site")
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
	pairingID, _ := pairing["pairing_id"].(string)
	confirmPath := strings.ReplaceAll(api.DevicePairingConfirmPath, "{pairingId}", pairingID)
	confirmBody := `{"client_request_id":"confirm-0006","challenge":"` + challenge + `","signature":"` + signDevicePairing(t, pairingID, challenge) + `"}`
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

	// Renewal is refused outside the certificate's last hour (device-design §2.1 step 4).
	// GW20 made confirm actually issue the certificate, so this refusal is now the
	// 24h-vs-1h window rather than the old cert_not_after IS NULL dead end; that NULL
	// branch became the re-issuance path (0058) and has its own test.
	renewPath := strings.ReplaceAll(api.DeviceCertificateRenewalsPath, "{deviceId}", deviceID)
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+renewPath, `{"client_request_id":"renew-0006"}`),
		http.StatusBadRequest, "invalid_request")
}
