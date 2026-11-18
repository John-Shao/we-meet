package api_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	"github.com/we-meet/work/internal/api"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/deviceca"
	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/gateway"
	"github.com/we-meet/work/internal/testpg"
)

// brokerBinEnv points at the SHIPPED work-device binary, not a test-only probe. GW18/GW19a proved
// their seams with examples because no executable Broker entry existed; GW21 landed that entry, so
// the subject here is the real process a desktop install would run.
const brokerBinEnv = "WORK_DEVICE_BIN"

// TestDeviceBrokerEntryPairsAndConsumesARestIssuedCertificate drives the whole §2.1 Broker side
// against the real REST face and the real mTLS gateway:
//
//	getDeviceIdentity -> REST pairings -> signDevicePairing -> REST confirm (CA issues)
//	-> deliverDeviceCertificate -> REST session-tickets -> deliverDeviceSessionTicket
//	-> the Broker dials and the gateway maps the certificate to (device, org)
//	-> the renewal window opens -> REST renewals -> signDeviceCertificateRenewal
//	-> REST renewal confirm -> deliverDeviceCertificate replaces the chain
//	-> a near-expiry leaf opens the Broker's OWN last-hour window.
//
// Every certificate in the chain above comes out of work-api's confirm response, so the chain the
// Broker imports is the one the server recorded; only the last step's near-expiry leaf is minted by
// the test CA, because deviceca issues nothing but the production 24h TTL. Windows-only (named
// pipes + CNG) and the real PostgreSQL fixture lives in the Linux job, so no CI job spans this seam
// — the same boundary GW18/GW19a registered, and a node gate forbids any workflow from naming this
// env.
func TestDeviceBrokerEntryPairsAndConsumesARestIssuedCertificate(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the Broker entry needs Windows named pipes and a CNG container")
	}
	bin := os.Getenv(brokerBinEnv)
	if bin == "" {
		t.Skipf("%s is not set; the Broker entry seam is proven by a local Windows run only", brokerBinEnv)
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("%s points at an unreadable binary: %v", brokerBinEnv, err)
	}

	pool, dbName := newBootstrapDB(t, false, true)
	seedDeviceLocalPolicy(t, dbName)

	ca, err := deviceca.NewCA()
	if err != nil {
		t.Fatal(err)
	}
	apiServer := newDeviceAPIServer(t, pool)
	apiServer.SetDeviceCA(ca)
	rest := httptest.NewServer(apiServer.Handler())
	t.Cleanup(rest.Close)

	gwAddr := startBrokerGateway(t, dbName, ca)

	dir := t.TempDir()
	caPath := filepath.Join(dir, "device-ca.pem")
	if err := os.WriteFile(caPath, ca.CertPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	container := "work-device-gw21-" + uuid.NewString()
	pipeName := `\\.\pipe\work-device-gw21-` + uuid.NewString()
	bootID := "boot-" + uuid.NewString()
	agentID := uuid.NewString()
	// journal_epoch is a uuid column (0040:406), not a counter: the Broker passes the config
	// string straight into the hello, so a non-uuid here surfaces as a server-side cast failure.
	journalEpoch := uuid.NewString()
	config := map[string]any{
		"pipe_name":          pipeName,
		// The Go test process plays the shell and owns the pipe client, so its PID is the
		// shell predicate the Broker's accept() compares every client against.
		"shell_pid":          os.Getpid(),
		"endpoint":           "https://localhost:" + strings.Split(gwAddr, ":")[1],
		"server_name":        "localhost",
		"ca_pem_path":        caPath,
		"container":          container,
		"provider":           "Microsoft Software Key Storage Provider",
		"boot_id":            bootID,
		"agent_instance_id":  agentID,
		"journal_epoch":      journalEpoch,
		"profile_id":         "profile-1",
		"tool_manifest_hash": strings.Repeat("a", 64),
		"runtime_digest":     strings.Repeat("b", 64),
		"last_receipt_seq":   0,
		"connect_timeout_ms": 10000,
		"reconnect_base_ms":  200,
		"reconnect_max_ms":   1000,
	}
	configPath := filepath.Join(dir, "broker.json")
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	var stderr syncBuffer
	cmd := exec.Command(bin, configPath)
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		// A persisted CNG container is a real user-profile artefact: leave nothing behind.
		out, err := exec.Command(bin, "--delete-container", container).CombinedOutput()
		if err != nil {
			t.Logf("CNG container teardown: %v (%s)", err, out)
		}
	})

	pipe := openBrokerPipe(t, pipeName)
	t.Cleanup(func() { _ = pipe.Close() })
	hello := readBrokerFrame(t, pipe)
	writeBrokerFrame(t, pipe, map[string]any{
		"nonce": hello["nonce"], "protocol_major": 2, "client_kind": "shell",
	})

	// Step 1: the Broker reports only public material, and Go recomputes the thumbprint itself.
	identity := brokerCall(t, pipe, map[string]any{
		"method": "getDeviceIdentity", "request_id": "id-1",
	})
	data := identity["data"].(map[string]any)
	jwkRaw, err := json.Marshal(data["public_key_jwk"])
	if err != nil {
		t.Fatal(err)
	}
	pub, err := devicesig.ParseJWK(jwkRaw)
	if err != nil {
		t.Fatalf("the Broker reported a JWK the server cannot parse: %v", err)
	}
	if data["public_key_thumbprint"] != pub.Thumbprint {
		t.Fatalf("thumbprint = %v, want %s", data["public_key_thumbprint"], pub.Thumbprint)
	}
	if data["container"] != container {
		t.Fatalf("container = %v, want %s", data["container"], container)
	}

	// Steps 2-3: the real REST pairing, then the Broker signs the covered string.
	pairBody := fmt.Sprintf(`{"client_request_id":"gw21-pair","device_name":"desk","platform":"windows-x64","public_key_jwk":%s}`, jwkRaw)
	pairing := decodeObject(t, deviceRequest(t, http.MethodPost, rest.URL+api.DevicePairingsPath, pairBody))
	pairingID, _ := pairing["pairing_id"].(string)
	deviceID, _ := pairing["device_id"].(string)
	challenge, _ := pairing["challenge"].(string)
	if pairingID == "" || deviceID == "" || challenge == "" {
		t.Fatalf("pairing = %#v", pairing)
	}
	signed := brokerCall(t, pipe, map[string]any{
		"method": "signDevicePairing", "request_id": "sig-1",
		"pairing_id": pairingID, "challenge": challenge,
		"org_id": testOrg, "subject_id": testSubject,
	})
	signature := signed["data"].(map[string]any)["signature"].(string)
	// Go verifies the signature itself before submitting it: the Broker really signed the
	// server's preimage with the key whose public half it reported.
	if !devicesig.VerifyPairing(pub, pairingID, challenge, testOrg, testSubject, signature) {
		t.Fatal("the Broker's pairing signature does not verify over the server's covered string")
	}
	confirmPath := strings.ReplaceAll(api.DevicePairingConfirmPath, "{pairingId}", pairingID)
	confirmBody := fmt.Sprintf(`{"client_request_id":"gw21-confirm","challenge":%q,"signature":%q}`, challenge, signature)
	confirmed := decodeObject(t, deviceRequest(t, http.MethodPost, rest.URL+confirmPath, confirmBody))
	if confirmed["status"] != "active" {
		t.Fatalf("confirm = %#v", confirmed)
	}
	certPEM, _ := confirmed["certificate_pem"].(string)
	certSerial, _ := confirmed["cert_serial"].(string)
	if certPEM == "" || certSerial == "" {
		t.Fatalf("the REST confirm issued no certificate: %#v", confirmed)
	}

	// Step 4: the Broker imports the chain the server actually issued.
	delivered := brokerRaw(t, pipe, map[string]any{
		"method": "deliverDeviceCertificate", "request_id": "cert-1",
		"device_id": deviceID, "certificate_pem": certPEM,
	})
	if delivered["result"] != "accepted" {
		t.Fatalf("cert delivery refused: %#v; broker stderr:\n%s", delivered, stderr.String())
	}
	if got := delivered["data"].(map[string]any)["cert_serial"]; got != certSerial {
		t.Fatalf("the Broker read serial %v, the server recorded %s", got, certSerial)
	}
	status := brokerCall(t, pipe, map[string]any{"method": "getDeviceCertificateStatus", "request_id": "st-1"})
	facts := status["data"].(map[string]any)
	if facts["has_certificate"] != true || facts["device_id"] != deviceID {
		t.Fatalf("status = %#v", facts)
	}
	if facts["renewal_window_open"] != false {
		t.Fatalf("a fresh 24h certificate must not be in the renewal window: %#v", facts)
	}
	// M2 ruling 甲: the sixth fact is the pump's outstanding-ticket-request flag. Whether the
	// link has already asked at this instant is a startup race, so only its TYPE is pinned here;
	// the deterministic value (false once the session consumed the ticket) is asserted below.
	if _, ok := facts["awaiting_ticket"].(bool); !ok {
		t.Fatalf("awaiting_ticket is not a boolean: %#v", facts)
	}
	// The Broker reads NotAfter out of the DER it imported, through a Windows FILETIME. Comparing
	// it to the certificate work-api actually issued is what discriminates a wrong epoch offset:
	// a dropped zero still yields a plausible date, just 332 years out.
	if got := facts["cert_not_after"]; got != certNotAfter(t, certPEM) {
		t.Fatalf("the Broker read NotAfter %v, the issued certificate says %s", got, certNotAfter(t, certPEM))
	}

	// A refused delivery must not disturb the held certificate: a foreign device id is refused
	// because the CA-signed CN is authoritative, not the shell's claim.
	refused := brokerRaw(t, pipe, map[string]any{
		"method": "deliverDeviceCertificate", "request_id": "cert-bad",
		"device_id": uuid.NewString(), "certificate_pem": certPEM,
	})
	if refused["result"] != "refused" || refused["code"] != "certificate_invalid" {
		t.Fatalf("a certificate for another device was not refused: %#v", refused)
	}

	// Steps 5-6: mint a ticket over REST and hand it over; the Broker dials the real gateway.
	ticketPath := strings.ReplaceAll(api.DeviceSessionTicketsPath, "{deviceId}", deviceID)
	ticketBody := fmt.Sprintf(`{"client_request_id":"gw21-ticket","public_key_thumbprint":%q}`, pub.Thumbprint)
	minted := decodeObject(t, deviceRequest(t, http.MethodPost, rest.URL+ticketPath, ticketBody))
	ticket, _ := minted["ticket"].(string)
	ticketRowID, _ := minted["session_ticket_id"].(string)
	if ticket == "" || ticketRowID == "" {
		t.Fatalf("ticket = %#v", minted)
	}
	brokerCall(t, pipe, map[string]any{
		"method": "deliverDeviceSessionTicket", "request_id": "tick-1",
		"device_id": deviceID, "session_ticket_id": ticketRowID, "ticket": ticket,
	})

	sessionID := waitForBrokerSession(t, dbName, deviceID, bootID, agentID, journalEpoch)
	if sessionID == "" {
		t.Fatalf("the Broker never established a session; stderr:\n%s", stderr.String())
	}
	// The session consumed the delivered ticket, so no request is outstanding: the shell must
	// read false here and NOT mint another ticket against a satisfied link.
	postSession := brokerCall(t, pipe, map[string]any{"method": "getDeviceCertificateStatus", "request_id": "st-session"})
	if postSession["data"].(map[string]any)["awaiting_ticket"] != false {
		t.Fatalf("a consumed ticket left the request outstanding: %#v", postSession["data"])
	}
	// Server-side truth: the row carries the identity the config gave the Broker, not something
	// the Broker reported about itself.
	var rowBoot, rowAgent, rowEpoch, rowState string
	if err := brokerDB(t, dbName).QueryRow(context.Background(), `
		SELECT boot_id, agent_instance_id::text, journal_epoch::text, state
		FROM work.device_session WHERE org_id = $1 AND id = $2::uuid`,
		testOrg, sessionID).Scan(&rowBoot, &rowAgent, &rowEpoch, &rowState); err != nil {
		t.Fatal(err)
	}
	if rowBoot != bootID || rowAgent != agentID || rowEpoch != journalEpoch || rowState != "active" {
		t.Fatalf("session identity = %q/%q/%q/%q, config gave %q/%q/%q",
			rowBoot, rowAgent, rowEpoch, rowState, bootID, agentID, journalEpoch)
	}
	if got := ticketState(t, dbName, ticketRowID); got != "consumed" {
		t.Fatalf("ticket state = %s, want consumed", got)
	}

	// Step 7: open the SERVER's renewal window, then replace the certificate through the renewal
	// face. The two windows have different authorities: the server's eligibility reads the recorded
	// cert_not_after (0058), while the Broker's status reads the NotAfter of the certificate it
	// holds. Moving the row must therefore NOT move the Broker's report — it has no database.
	setBrokerCertExpiry(t, dbName, deviceID, "now() + interval '30 minutes'")
	status = brokerCall(t, pipe, map[string]any{"method": "getDeviceCertificateStatus", "request_id": "st-2"})
	if status["data"].(map[string]any)["renewal_window_open"] != false {
		t.Fatalf("the Broker followed the server row instead of its own certificate: %#v", status["data"])
	}
	renewPath := strings.ReplaceAll(api.DeviceCertificateRenewalsPath, "{deviceId}", deviceID)
	renewal := decodeObject(t, deviceRequest(t, http.MethodPost, rest.URL+renewPath, `{"client_request_id":"gw21-renew"}`))
	renewPairingID, _ := renewal["pairing_id"].(string)
	renewChallenge, _ := renewal["challenge"].(string)
	if renewPairingID == "" || renewChallenge == "" {
		t.Fatalf("renewal = %#v", renewal)
	}
	renewSigned := brokerCall(t, pipe, map[string]any{
		"method": "signDeviceCertificateRenewal", "request_id": "sig-2",
		"pairing_id": renewPairingID, "challenge": renewChallenge,
		"org_id": testOrg, "subject_id": testSubject,
	})
	renewSignature := renewSigned["data"].(map[string]any)["signature"].(string)
	if !devicesig.VerifyCertRenewal(pub, renewPairingID, renewChallenge, testOrg, testSubject, renewSignature) {
		t.Fatal("the Broker's renewal signature does not verify under the renewal domain")
	}
	// The pairing domain must not be reusable for a renewal challenge (§2.1).
	if devicesig.VerifyPairing(pub, renewPairingID, renewChallenge, testOrg, testSubject, renewSignature) {
		t.Fatal("a renewal signature verified under the pairing domain")
	}
	renewConfirmPath := strings.ReplaceAll(api.DeviceCertificateRenewalConfirmPath, "{pairingId}", renewPairingID)
	renewConfirmBody := fmt.Sprintf(`{"client_request_id":"gw21-renew-confirm","challenge":%q,"signature":%q}`, renewChallenge, renewSignature)
	renewConfirmed := decodeObject(t, deviceRequest(t, http.MethodPost, rest.URL+renewConfirmPath, renewConfirmBody))
	newPEM, _ := renewConfirmed["certificate_pem"].(string)
	newSerial, _ := renewConfirmed["cert_serial"].(string)
	if newPEM == "" || newSerial == "" || newSerial == certSerial {
		t.Fatalf("the renewal face issued no replacement: %#v", renewConfirmed)
	}
	brokerCall(t, pipe, map[string]any{
		"method": "deliverDeviceCertificate", "request_id": "cert-2",
		"device_id": deviceID, "certificate_pem": newPEM,
	})
	status = brokerCall(t, pipe, map[string]any{"method": "getDeviceCertificateStatus", "request_id": "st-3"})
	facts = status["data"].(map[string]any)
	if facts["cert_serial"] != newSerial {
		t.Fatalf("the Broker still holds %v, want %s", facts["cert_serial"], newSerial)
	}
	if facts["renewal_window_open"] != false {
		t.Fatalf("the replacement did not close the window: %#v", facts)
	}
	if got := dbCertSerial(t, dbName, deviceID); got != newSerial {
		t.Fatalf("the row holds %s, the Broker holds %s", got, newSerial)
	}

	// Step 8: the DEVICE's own window. Every certificate above came out of work-api with the
	// production 24h TTL, so none of them can open the Broker's last-hour window. This one leaf is
	// minted by the test CA for the same device and the same CNG public key, solely to drive that
	// window: it is the only way to prove the imported NotAfter reaches the status reply. It is
	// deliberately NOT recorded on the server, and no assertion above depends on it.
	shortPEM := shortLivedDeviceCert(t, ca, deviceID, pub.Key)
	brokerCall(t, pipe, map[string]any{
		"method": "deliverDeviceCertificate", "request_id": "cert-3",
		"device_id": deviceID, "certificate_pem": shortPEM,
	})
	status = brokerCall(t, pipe, map[string]any{"method": "getDeviceCertificateStatus", "request_id": "st-4"})
	facts = status["data"].(map[string]any)
	if facts["renewal_window_open"] != true {
		t.Fatalf("a certificate expiring in 30 minutes did not open the window: %#v", facts)
	}
	if got := facts["cert_not_after"]; got != certNotAfter(t, shortPEM) {
		t.Fatalf("the Broker read NotAfter %v, the delivered certificate says %s", got, certNotAfter(t, shortPEM))
	}
}

// certNotAfter reads the leaf NotAfter as the strict whole-second UTC form the status reply uses.
func certNotAfter(t *testing.T, certPEM string) string {
	t.Helper()
	block, _ := pem.Decode([]byte(certPEM))
	if block == nil {
		t.Fatalf("no PEM block in %q", certPEM)
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return leaf.NotAfter.UTC().Format(time.RFC3339)
}

// shortLivedDeviceCert mints a clientAuth leaf expiring in 30 minutes for the same (device, org,
// public key) the real chain binds. deviceca only issues the production 24h TTL, and the Broker's
// renewal window is driven by the certificate it holds, not by the server row.
func shortLivedDeviceCert(t *testing.T, ca *deviceca.CA, deviceID string, pub *ecdsa.PublicKey) string {
	t.Helper()
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: deviceID, OrganizationalUnit: []string{testOrg}},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(30 * time.Minute),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.Cert, pub, ca.Key)
	if err != nil {
		t.Fatal(err)
	}
	chain := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	return string(append(chain, ca.CertPEM...))
}

// startBrokerGateway stands up the real mTLS gRPC gateway on the SAME database the REST face
// uses, so the certificate work-api issued is the one the gateway trusts. It needs its own
// worker pool: the REST face runs as the API role, which may not SET ROLE work_worker (0024
// grants no table privileges and the gateway's domain commands run as work_worker).
func startBrokerGateway(t *testing.T, dbName string, ca *deviceca.CA) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	pool, err := workdb.OpenPool(ctx, testpg.WorkerURL(dbName), "work-gateway-broker-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	serverCert, err := ca.IssueServerCert([]string{"localhost", "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer(
		grpc.Creds(credentials.NewTLS(deviceca.ServerTLSConfig(ca, serverCert))),
		grpc.ForceServerCodec(gateway.FrameCodec()),
	)
	gw, err := gateway.NewServer(pool)
	if err != nil {
		t.Fatal(err)
	}
	gw.Register(srv)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	return lis.Addr().String()
}

type syncBuffer struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func openBrokerPipe(t *testing.T, name string) *os.File {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		pipe, err := os.OpenFile(name, os.O_RDWR, 0)
		if err == nil {
			return pipe
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the shell could not open the Broker pipe %q", name)
	return nil
}

func readBrokerFrame(t *testing.T, pipe *os.File) map[string]any {
	t.Helper()
	var prefix [4]byte
	if _, err := io.ReadFull(pipe, prefix[:]); err != nil {
		t.Fatalf("read frame prefix: %v", err)
	}
	size := binary.BigEndian.Uint32(prefix[:])
	if size > 64*1024 {
		t.Fatalf("frame claims %d bytes, above the 64KiB cap", size)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(pipe, payload); err != nil {
		t.Fatalf("read frame payload: %v", err)
	}
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("frame is not JSON: %v (%s)", err, payload)
	}
	return value
}

func writeBrokerFrame(t *testing.T, pipe *os.File, value map[string]any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > 64*1024 {
		t.Fatalf("frame of %d bytes exceeds the 64KiB cap", len(raw))
	}
	frame := make([]byte, 4+len(raw))
	binary.BigEndian.PutUint32(frame[:4], uint32(len(raw)))
	copy(frame[4:], raw)
	if _, err := pipe.Write(frame); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

// brokerRaw sends one message and returns the closed reply without asserting the result.
func brokerRaw(t *testing.T, pipe *os.File, message map[string]any) map[string]any {
	t.Helper()
	writeBrokerFrame(t, pipe, message)
	return readBrokerFrame(t, pipe)
}

// brokerCall sends one message and requires an accepted reply, returning it.
func brokerCall(t *testing.T, pipe *os.File, message map[string]any) map[string]any {
	t.Helper()
	reply := brokerRaw(t, pipe, message)
	if reply["result"] != "accepted" {
		t.Fatalf("%v was refused: %#v", message["method"], reply)
	}
	if reply["method"] != message["method"] || reply["request_id"] != message["request_id"] {
		t.Fatalf("the reply lost the correlation fields: %#v", reply)
	}
	return reply
}

func brokerDB(t *testing.T, dbName string) *pgx.Conn {
	t.Helper()
	conn, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func waitForBrokerSession(t *testing.T, dbName, deviceID, bootID, agentID, journalEpoch string) string {
	t.Helper()
	conn := brokerDB(t, dbName)
	deadline := time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		var id string
		err := conn.QueryRow(context.Background(), `
			SELECT id::text FROM work.device_session
			WHERE org_id = $1 AND device_id = $2::uuid AND state = 'active'
			  AND boot_id = $3 AND agent_instance_id = $4 AND journal_epoch = $5::uuid
			ORDER BY created_at DESC LIMIT 1`, testOrg, deviceID, bootID, agentID, journalEpoch).Scan(&id)
		if err == nil && id != "" {
			return id
		}
		time.Sleep(200 * time.Millisecond)
	}
	return ""
}

func ticketState(t *testing.T, dbName, rowID string) string {
	t.Helper()
	conn := brokerDB(t, dbName)
	var state string
	if err := conn.QueryRow(context.Background(),
		`SELECT state FROM work.device_session_ticket WHERE org_id = $1 AND id = $2::uuid`,
		testOrg, rowID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func dbCertSerial(t *testing.T, dbName, deviceID string) string {
	t.Helper()
	conn := brokerDB(t, dbName)
	var serial string
	if err := conn.QueryRow(context.Background(),
		`SELECT cert_serial FROM work.device WHERE org_id = $1 AND id = $2::uuid`,
		testOrg, deviceID).Scan(&serial); err != nil {
		t.Fatal(err)
	}
	return serial
}

func setBrokerCertExpiry(t *testing.T, dbName, deviceID, expr string) {
	t.Helper()
	conn := brokerDB(t, dbName)
	if err := testpg.ExecRaw(context.Background(), conn, fmt.Sprintf(
		`UPDATE work.device SET cert_not_after = %s WHERE org_id = '%s' AND id = '%s'::uuid`,
		expr, testOrg, deviceID)); err != nil {
		t.Fatal(err)
	}
}