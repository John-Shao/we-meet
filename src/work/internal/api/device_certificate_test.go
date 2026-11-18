package api_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/deviceca"
	"github.com/we-meet/work/internal/testpg"
)

// GW20: the certificate face end to end over HTTP against the landed SQL. These are the
// claims the SQL-level tests cannot make, because the cryptography and the CA live in Go:
// confirm really issues a clientAuth certificate bound to the device's registered key,
// the response and the device row agree, a replay hands back the SAME certificate, the
// face fails closed before any write when no CA is configured, and renewal both replaces
// a certificate inside its last hour and re-issues one for a device that has none.

func newDeviceCertServer(t *testing.T, pool *pgxpool.Pool) (*httptest.Server, *deviceca.CA) {
	t.Helper()
	server := newDeviceAPIServer(t, pool)
	ca, err := deviceca.NewCA()
	if err != nil {
		t.Fatal(err)
	}
	server.SetDeviceCA(ca)
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer, ca
}

// deviceCertFixture pairs a device and returns the ids the certificate faces need.
func deviceCertFixture(t *testing.T, server *httptest.Server, requestID string) (deviceID, pairingID, challenge string) {
	t.Helper()
	pairBody := `{"client_request_id":"` + requestID + `","device_name":"desk","platform":"windows-x64","public_key_jwk":` + deviceTestJWK + `}`
	pairing := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+api.DevicePairingsPath, pairBody))
	deviceID, _ = pairing["device_id"].(string)
	pairingID, _ = pairing["pairing_id"].(string)
	challenge, _ = pairing["challenge"].(string)
	if deviceID == "" || pairingID == "" || challenge == "" {
		t.Fatalf("pairing = %#v", pairing)
	}
	return deviceID, pairingID, challenge
}

func confirmPathFor(pairingID string) string {
	return strings.ReplaceAll(api.DevicePairingConfirmPath, "{pairingId}", pairingID)
}

func renewConfirmPathFor(pairingID string) string {
	return strings.ReplaceAll(api.DeviceCertificateRenewalConfirmPath, "{pairingId}", pairingID)
}

func confirmBody(requestID, challenge, signature string) string {
	return `{"client_request_id":"` + requestID + `","challenge":"` + challenge + `","signature":"` + signature + `"}`
}

// parseIssuedChain splits the response's PEM chain and verifies the leaf against the CA
// the server was configured with. A certificate that does not chain, or that carries the
// wrong identity or the wrong usage, is not the credential §2.1 step 4 describes.
func parseIssuedChain(t *testing.T, response map[string]any, ca *deviceca.CA, deviceID string) *x509.Certificate {
	t.Helper()
	chainPEM, _ := response["certificate_pem"].(string)
	if chainPEM == "" {
		t.Fatalf("confirm issued no certificate: %#v", response)
	}
	leafBlock, rest := pem.Decode([]byte(chainPEM))
	if leafBlock == nil || leafBlock.Type != "CERTIFICATE" {
		t.Fatalf("certificate_pem is not a PEM CERTIFICATE block")
	}
	leaf, err := x509.ParseCertificate(leafBlock.Bytes)
	if err != nil {
		t.Fatalf("leaf parse: %v", err)
	}
	caBlock, _ := pem.Decode(rest)
	if caBlock == nil {
		t.Fatalf("certificate_pem carries no CA certificate, so the device cannot build a chain")
	}
	issuer, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil {
		t.Fatalf("issuer parse: %v", err)
	}
	if err := leaf.CheckSignatureFrom(issuer); err != nil {
		t.Fatalf("leaf is not signed by the configured CA: %v", err)
	}
	if issuer.Raw == nil || string(issuer.Raw) != string(ca.Cert.Raw) {
		t.Fatalf("the chain's CA is not the CA the server was configured with")
	}
	if leaf.Subject.CommonName != deviceID {
		t.Fatalf("leaf CN = %q, want the device id %q", leaf.Subject.CommonName, deviceID)
	}
	if len(leaf.Subject.OrganizationalUnit) != 1 || leaf.Subject.OrganizationalUnit[0] != testOrg {
		t.Fatalf("leaf OU = %#v, want [%s]", leaf.Subject.OrganizationalUnit, testOrg)
	}
	var clientAuth bool
	for _, usage := range leaf.ExtKeyUsage {
		if usage == x509.ExtKeyUsageClientAuth {
			clientAuth = true
		}
	}
	if !clientAuth {
		t.Fatalf("leaf ExtKeyUsage = %#v, want clientAuth", leaf.ExtKeyUsage)
	}
	if !leaf.PublicKey.(*ecdsa.PublicKey).Equal(deviceTestPrivateKey().Public()) {
		t.Fatalf("leaf public key is not the key the device registered")
	}
	serial, _ := response["cert_serial"].(string)
	if serial != leaf.SerialNumber.String() {
		t.Fatalf("cert_serial = %q, leaf serial = %s", serial, leaf.SerialNumber.String())
	}
	return leaf
}

func TestDevicePairingConfirmIssuesARealCertificateAndReplaysIt(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server, ca := newDeviceCertServer(t, pool)
	deviceID, pairingID, challenge := deviceCertFixture(t, server, "pair-cert-1")

	path := confirmPathFor(pairingID)
	body := confirmBody("confirm-cert-1", challenge, signDevicePairing(t, pairingID, challenge))
	response := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+path, body))
	if response["status"] != "active" || response["replayed"] != false {
		t.Fatalf("confirm = %#v", response)
	}
	leaf := parseIssuedChain(t, response, ca, deviceID)

	// §2.1 step 4 fixes the lifetime at 24h; the CA backdates NotBefore by one minute.
	if ttl := leaf.NotAfter.Sub(leaf.NotBefore); ttl < 24*time.Hour || ttl > 24*time.Hour+2*time.Minute {
		t.Fatalf("certificate lifetime = %s, want 24h (plus the CA's backdate)", ttl)
	}
	notAfterText, _ := response["cert_not_after"].(string)
	notAfter, err := time.Parse(time.RFC3339Nano, notAfterText)
	if err != nil {
		t.Fatalf("cert_not_after = %q does not parse: %v", notAfterText, err)
	}
	if !notAfter.Equal(leaf.NotAfter) {
		t.Fatalf("cert_not_after = %s, leaf NotAfter = %s", notAfter, leaf.NotAfter)
	}

	// The row and the response must agree: the record call is what writes the pair.
	ctx := context.Background()
	db, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)
	var serial string
	var storedNotAfter time.Time
	if err := db.QueryRow(ctx, `SELECT cert_serial, cert_not_after FROM work.device
		WHERE org_id=$1 AND id=$2::uuid`, testOrg, deviceID).Scan(&serial, &storedNotAfter); err != nil {
		t.Fatalf("device row: %v", err)
	}
	if serial != leaf.SerialNumber.String() || !storedNotAfter.Equal(leaf.NotAfter) {
		t.Fatalf("device row = %s/%s, response = %s/%s", serial, storedNotAfter,
			leaf.SerialNumber.String(), leaf.NotAfter)
	}

	// A replay re-signs (a fresh random serial) but must hand back the certificate the
	// row already holds, byte for byte, rather than a second credential or a conflict.
	replay := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+path, body))
	if replay["replayed"] != true {
		t.Fatalf("replay = %#v, want replayed=true", replay)
	}
	if replay["certificate_pem"] != response["certificate_pem"] || replay["cert_serial"] != response["cert_serial"] {
		t.Fatalf("replay returned a different certificate: %#v vs %#v", replay, response)
	}
	var count int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM work.audit_event
		WHERE org_id=$1 AND action='device.cert.recorded'`, testOrg).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("device.cert.recorded rows = %d, want 1: a replay must not issue twice", count)
	}
}

func TestDeviceCertificateFaceFailsClosedWithoutACA(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceAPIServer(t, pool) // deliberately no SetDeviceCA
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)

	deviceID, pairingID, challenge := deviceCertFixture(t, httpServer, "pair-noca")
	body := confirmBody("confirm-noca", challenge, signDevicePairing(t, pairingID, challenge))
	assertAPICode(t, deviceRequest(t, http.MethodPost, httpServer.URL+confirmPathFor(pairingID), body),
		http.StatusServiceUnavailable, "service_degraded")
	assertAPICode(t, deviceRequest(t, http.MethodPost,
		httpServer.URL+renewConfirmPathFor(pairingID), body),
		http.StatusServiceUnavailable, "service_degraded")

	// The refusal must leave ZERO rows behind: activating first would leave a device
	// that cannot connect and cannot be re-paired, which is the dead end 0058 closes.
	ctx := context.Background()
	db, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)
	var status, pairingState string
	var serial *string
	if err := db.QueryRow(ctx, `SELECT status, cert_serial FROM work.device
		WHERE org_id=$1 AND id=$2::uuid`, testOrg, deviceID).Scan(&status, &serial); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || serial != nil {
		t.Fatalf("device after a refused confirm = %q/%v, want pending with no certificate", status, serial)
	}
	if err := db.QueryRow(ctx, `SELECT state FROM work.device_pairing
		WHERE org_id=$1 AND id=$2::uuid`, testOrg, pairingID).Scan(&pairingState); err != nil {
		t.Fatal(err)
	}
	if pairingState != "pending" {
		t.Fatalf("pairing after a refused confirm = %q, want pending (the challenge is unspent)", pairingState)
	}
}

func TestDeviceCertificateRenewalReplacesInsideTheLastHour(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server, ca := newDeviceCertServer(t, pool)
	deviceID, pairingID, challenge := deviceCertFixture(t, server, "pair-renew-1")
	first := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+confirmPathFor(pairingID),
		confirmBody("confirm-renew-1", challenge, signDevicePairing(t, pairingID, challenge))))
	firstLeaf := parseIssuedChain(t, first, ca, deviceID)

	// Move the recorded expiry inside the renewal window without waiting 23 hours. The
	// serial stays the real one, so the advance guard is exercised against a live row.
	ctx := context.Background()
	db, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)
	if _, err := db.Exec(ctx, `UPDATE work.device SET cert_not_after = now() + interval '30 minutes'
		WHERE org_id=$1 AND id=$2::uuid`, testOrg, deviceID); err != nil {
		t.Fatal(err)
	}
	var windowExpiry time.Time
	if err := db.QueryRow(ctx, `SELECT cert_not_after FROM work.device WHERE org_id=$1 AND id=$2::uuid`,
		testOrg, deviceID).Scan(&windowExpiry); err != nil {
		t.Fatal(err)
	}

	renewPath := strings.ReplaceAll(api.DeviceCertificateRenewalsPath, "{deviceId}", deviceID)
	renew := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+renewPath,
		`{"client_request_id":"renew-req-1"}`))
	if renew["purpose"] != "renew" {
		t.Fatalf("renew request = %#v", renew)
	}
	renewPairing, _ := renew["pairing_id"].(string)
	renewChallenge, _ := renew["challenge"].(string)
	if renewPairing == "" || renewChallenge == "" {
		t.Fatalf("renew request gave no challenge: %#v", renew)
	}

	// §2.1 forbids reusing a signature domain: a PAIRING-domain signature over the very
	// same renewal challenge must be refused, not accepted as a renewal.
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+renewConfirmPathFor(renewPairing),
		confirmBody("renew-confirm-wrong-domain", renewChallenge, signDevicePairing(t, renewPairing, renewChallenge))),
		http.StatusUnauthorized, "unauthorized")

	replaced := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+renewConfirmPathFor(renewPairing),
		confirmBody("renew-confirm-1", renewChallenge, signDeviceRenewal(t, renewPairing, renewChallenge))))
	secondLeaf := parseIssuedChain(t, replaced, ca, deviceID)
	if secondLeaf.SerialNumber.Cmp(firstLeaf.SerialNumber) == 0 {
		t.Fatalf("renewal reissued the same serial %s", secondLeaf.SerialNumber)
	}
	// The advance is measured against the RECORDED expiry, not the first leaf's: x509
	// stamps NotAfter at second precision, so two certificates issued inside the same
	// second are indistinguishable by expiry and comparing them would prove nothing.
	if !secondLeaf.NotAfter.After(windowExpiry) {
		t.Fatalf("renewal did not extend the recorded expiry: %s then %s", windowExpiry, secondLeaf.NotAfter)
	}
	if ttl := secondLeaf.NotAfter.Sub(time.Now()); ttl < 23*time.Hour || ttl > 24*time.Hour+time.Minute {
		t.Fatalf("replacement lifetime = %s, want a fresh 24h", ttl)
	}
	var serial string
	if err := db.QueryRow(ctx, `SELECT cert_serial FROM work.device WHERE org_id=$1 AND id=$2::uuid`,
		testOrg, deviceID).Scan(&serial); err != nil {
		t.Fatal(err)
	}
	if serial != secondLeaf.SerialNumber.String() {
		t.Fatalf("device row serial = %q, replacement = %s", serial, secondLeaf.SerialNumber)
	}
	// The replacement is a fresh 24h certificate, so the window closes again.
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+renewPath,
		`{"client_request_id":"renew-req-2"}`), http.StatusBadRequest, "invalid_request")
}

// TestDeviceCertificateRenewalReissuesForACertificatelessDevice is the HTTP half of the
// dead-end closure: an active device whose issuance never landed can still obtain a
// certificate through the renewal face, without an operator revoke and without re-pairing.
func TestDeviceCertificateRenewalReissuesForACertificatelessDevice(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server, ca := newDeviceCertServer(t, pool)
	deviceID, _, _ := deviceCertFixture(t, server, "pair-reissue")

	ctx := context.Background()
	db, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)
	// The state an issuance failure leaves behind: active, no certificate.
	if _, err := db.Exec(ctx, `UPDATE work.device SET status='active'
		WHERE org_id=$1 AND id=$2::uuid`, testOrg, deviceID); err != nil {
		t.Fatal(err)
	}

	renewPath := strings.ReplaceAll(api.DeviceCertificateRenewalsPath, "{deviceId}", deviceID)
	renew := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+renewPath,
		`{"client_request_id":"reissue-req-1"}`))
	renewPairing, _ := renew["pairing_id"].(string)
	renewChallenge, _ := renew["challenge"].(string)
	if renewPairing == "" || renewChallenge == "" {
		t.Fatalf("a certificate-less active device must still get a challenge: %#v", renew)
	}
	issued := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+renewConfirmPathFor(renewPairing),
		confirmBody("reissue-confirm-1", renewChallenge, signDeviceRenewal(t, renewPairing, renewChallenge))))
	parseIssuedChain(t, issued, ca, deviceID)

	var serial string
	if err := db.QueryRow(ctx, `SELECT cert_serial FROM work.device WHERE org_id=$1 AND id=$2::uuid`,
		testOrg, deviceID).Scan(&serial); err != nil {
		t.Fatal(err)
	}
	if serial == "" {
		t.Fatal("re-issuance left the device without a certificate")
	}
}