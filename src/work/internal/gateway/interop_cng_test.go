package gateway_test

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/deviceca"
	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

// cngBinEnv names the prebuilt Rust CNG identity probe. Unlike the GW17/GW18 interops this
// one CANNOT run in CI: the identity is a Windows CNG key, while the real PostgreSQL fixture
// only exists in the Linux go-migrate job, and GitHub Actions services are Linux-only. So the
// seam is proven by one local Windows full-chain run, and a node gate forbids any workflow
// from naming this env or probe.
const cngBinEnv = "WORK_DEVICE_CNG_BIN"

// cngProvider is the KSP the device key lives in. It is passed to the probe rather than
// hardcoded there so the orchestration states which provider the certificate is bound to.
const cngProvider = "Microsoft Software Key Storage Provider"

// TestDeviceCngIdentityInterop proves the §2.1 production identity shape end to end: a
// NON-EXPORTABLE CNG key backs BOTH the mTLS client certificate and the hello signature, and
// the shipped Rust link dials the shipped Go gateway over a real PostgreSQL chain with it.
//
// This is strictly stronger than TestDeviceLinkInterop, which uses an exportable software
// signing key plus a separate PKCS#12 identity. Here no private key bytes exist anywhere:
// the certificate is issued for the CNG public key and linked back to the key by CONTAINER
// NAME, and the probe config has no scalar and no PKCS#12 field at all.
//
// Two phases, because the CA cannot sign for a key it has never seen:
//  1. keygen — a separate probe process creates the persisted key and reports its public JWK.
//  2. dial — a second process reopens that key by name and dials. Running them as separate
//     processes also proves the key survives a restart, which production depends on.
func TestDeviceCngIdentityInterop(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skipf("the CNG identity is Windows-only (GOOS=%s)", runtime.GOOS)
	}
	bin := os.Getenv(cngBinEnv)
	if bin == "" {
		t.Skipf("%s is not set; build the probe with `cargo build --example device_cng_probe`", cngBinEnv)
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("%s = %q is not a readable file: %v", cngBinEnv, bin, err)
	}
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}

	// Phase 1: the device key is created by the device side, never by Go.
	container := "work-cng-interop-" + uuid.NewString()
	keygen := runCngProbe(t, bin, "keygen", container)
	created := cngKeygenReport(t, keygen)
	if created["container"] != container {
		t.Fatalf("keygen container = %#v, want %q", created["container"], container)
	}
	jwkJSON, err := json.Marshal(created["jwk"])
	if err != nil {
		t.Fatal(err)
	}
	pub, err := devicesig.ParseJWK(jwkJSON)
	if err != nil {
		t.Fatalf("the CNG public JWK does not parse as a closed EC P-256 JWK: %v", err)
	}
	thumbprint, _ := created["thumbprint"].(string)
	if thumbprint != pub.Thumbprint {
		t.Fatalf("probe thumbprint = %q, Go recomputation = %q", thumbprint, pub.Thumbprint)
	}
	// The persisted key is a real user-profile artifact, so cleanup is not optional.
	t.Cleanup(func() { runCngProbe(t, bin, "delete", container) })

	f := newCngGatewayFixture(t, jwkJSON, thumbprint)
	addr := f.startServer(t)

	// The CA signs for the CNG PUBLIC key only; it never sees a private scalar.
	deviceCert, err := f.ca.IssueDeviceCert(f.deviceID, gwOrg, pub.Key)
	if err != nil {
		t.Fatal(err)
	}
	f.deviceCert = deviceCert

	probeBoot := "boot-" + uuid.NewString()
	probeAgent := uuid.NewString()
	probeEpoch := uuid.NewString()
	// The real mint shape (0040:1469 sha256_text(uuid||uuid), 64 lowercase hex), not a
	// placeholder: the ticket the link spends is the ticket the cloud would have issued.
	ticket := sha256Hex(uuid.NewString() + uuid.NewString())
	f.seedSecondTicket(t, ticket)

	chain := make([]string, 0, len(deviceCert.Certificate))
	for _, der := range deviceCert.Certificate {
		chain = append(chain, base64.RawURLEncoding.EncodeToString(der))
	}
	config := map[string]any{
		"endpoint":               "https://" + addr,
		"server_name":            "localhost",
		"ca_pem":                 string(f.ca.CertPEM),
		"cert_der_chain_base64":  chain,
		"container":              container,
		"provider":               cngProvider,
		"device_id":              f.deviceID,
		"boot_id":                probeBoot,
		"agent_instance_id":      probeAgent,
		"journal_epoch":          probeEpoch,
		"profile_id":             "profile-cng-interop",
		"tool_manifest_hash":     strings.Repeat("a", 64),
		"runtime_digest":         strings.Repeat("b", 64),
		"last_receipt_seq":       0,
		"ticket":                 ticket,
		"budget_ms":              40000,
	}
	// The config must not carry exported key material: that is the whole point of the batch.
	for _, forbidden := range []string{"device_key_scalar_hex", "client_pkcs12_base64", "pkcs12_password"} {
		if _, present := config[forbidden]; present {
			t.Fatalf("the CNG probe config must not carry %s", forbidden)
		}
	}
	configPath := filepath.Join(t.TempDir(), "cng-probe.json")
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	stdout := runCngProbe(t, bin, "dial", configPath)
	report := probeReport(t, stdout)
	if report["ok"] != true {
		t.Fatalf("probe reported failure: %s", stdout)
	}
	if report["identity"] != "cng_bound" {
		t.Fatalf("probe identity = %#v, want cng_bound", report["identity"])
	}
	if report["container"] != container {
		t.Fatalf("probe container = %#v, want %q", report["container"], container)
	}
	// The certificate and the frame signature are ONE key, and it is the CNG key (§2.1).
	if got := jwkThumbprint(t, report["device_public_jwk"]); got != thumbprint {
		t.Fatalf("probe key thumbprint = %s, CNG keygen = %s", got, thumbprint)
	}
	if got := jwkThumbprint(t, report["server_public_jwk"]); got == "" {
		t.Fatal("the probe provisioned no server key")
	}
	if got := jwkThumbprint(t, report["permit_public_jwk"]); got == "" {
		t.Fatal("the probe provisioned no permit key")
	}
	if jwkThumbprint(t, report["server_public_jwk"]) == jwkThumbprint(t, report["permit_public_jwk"]) {
		t.Fatal("the gateway provisioned one key for both roles; §3.3 requires an independent permit key")
	}
	alive, ok := report["alive_ms"].(float64)
	if !ok || int64(alive) <= 10000 {
		t.Fatalf("probe alive_ms = %#v, want more than one 10s server cadence", report["alive_ms"])
	}

	// Server-side truth: the gateway mapped the mTLS peer to the seeded device, and the session
	// row carries the identity the CNG-backed probe sent.
	session, _ := report["session_id"].(string)
	if session == "" {
		t.Fatalf("probe reported no session: %s", stdout)
	}
	ctx := gwContext(t)
	db, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close(ctx) }()
	var bootID, agentID, journalEpoch, state, deviceID string
	if err := db.QueryRow(ctx, `
		SELECT boot_id, agent_instance_id::text, journal_epoch::text, state, device_id::text
		FROM work.device_session WHERE org_id=$1 AND id=$2::uuid`,
		gwOrg, session).Scan(&bootID, &agentID, &journalEpoch, &state, &deviceID); err != nil {
		t.Fatalf("probe session row: %v", err)
	}
	if bootID != probeBoot || agentID != probeAgent || journalEpoch != probeEpoch {
		t.Fatalf("session identity = %q/%q/%q, probe sent %q/%q/%q",
			bootID, agentID, journalEpoch, probeBoot, probeAgent, probeEpoch)
	}
	if state != "active" {
		t.Fatalf("session state = %q, want active", state)
	}
	if deviceID != f.deviceID {
		t.Fatalf("session device = %q, cert-mapped device = %q", deviceID, f.deviceID)
	}
	var ticketState string
	sum := sha256.Sum256([]byte(ticket))
	if err := db.QueryRow(ctx, `
		SELECT state FROM work.device_session_ticket WHERE org_id=$1 AND ticket_hash=$2`,
		gwOrg, hex.EncodeToString(sum[:])).Scan(&ticketState); err != nil {
		t.Fatal(err)
	}
	if ticketState != "consumed" {
		t.Fatalf("ticket state = %q, want consumed", ticketState)
	}
}

// TestDeviceCngIdentityPinsTls13 proves the protocol floor is the CLIENT's, not just the
// server's. The gateway listener already sets MinVersion TLS1.3, so a successful dial there
// says nothing about what the device would accept. Here the peer deliberately offers ONLY
// TLS 1.2 and the probe must refuse: native-tls exposes no minimum-version knob (the second
// boundary registered in tls.rs), while schannel's enabled_protocols does.
func TestDeviceCngIdentityPinsTls13(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skipf("the CNG identity is Windows-only (GOOS=%s)", runtime.GOOS)
	}
	bin := os.Getenv(cngBinEnv)
	if bin == "" {
		t.Skipf("%s is not set", cngBinEnv)
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("%s = %q is not a readable file: %v", cngBinEnv, bin, err)
	}

	container := "work-cng-tls12-" + uuid.NewString()
	created := cngKeygenReport(t, runCngProbe(t, bin, "keygen", container))
	jwkJSON, err := json.Marshal(created["jwk"])
	if err != nil {
		t.Fatal(err)
	}
	pub, err := devicesig.ParseJWK(jwkJSON)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { runCngProbe(t, bin, "delete", container) })

	ca, err := deviceca.NewCA()
	if err != nil {
		t.Fatal(err)
	}
	serverCert, err := ca.IssueServerCert([]string{"localhost", "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	deviceCert, err := ca.IssueDeviceCert(uuid.NewString(), gwOrg, pub.Key)
	if err != nil {
		t.Fatal(err)
	}
	// A peer that will NOT speak TLS 1.3. No PostgreSQL and no gateway are needed: the
	// refusal must happen during the handshake, before any frame is exchanged.
	// NextProtos offers h2 deliberately: without it a broken protocol floor could still be
	// masked by an ALPN failure, and the test would not discriminate. With h2 offered, a
	// client that wrongly negotiated TLS 1.2 would complete the handshake and this test
	// would go red.
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lis.Close() }()
	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{serverCert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    ca.Pool(),
		MinVersion:   tls.VersionTLS12,
		MaxVersion:   tls.VersionTLS12,
		NextProtos:   []string{"h2"},
	}
	// The peer records every COMPLETED handshake and its negotiated version. This is the
	// discriminator: the probe's own error string cannot tell "TLS refused" from "TLS
	// accepted but the application layer failed", and a raw listener that closes after the
	// handshake produces a failure either way. Measured mutation: allowing TLS 1.2 in the
	// connector leaves the probe failing (at gRPC level) while this peer records a successful
	// TLS 1.2 handshake — so only the server-side observation makes the test discriminating.
	handshakes := make(chan uint16, 16)
	go func() {
		for {
			conn, err := lis.Accept()
			if err != nil {
				return
			}
			tlsConn := tls.Server(conn, tlsConfig)
			if err := tlsConn.Handshake(); err == nil {
				handshakes <- tlsConn.ConnectionState().Version
			}
			_ = tlsConn.Close()
		}
	}()

	chain := make([]string, 0, len(deviceCert.Certificate))
	for _, der := range deviceCert.Certificate {
		chain = append(chain, base64.RawURLEncoding.EncodeToString(der))
	}
	config := map[string]any{
		"endpoint":              "https://" + lis.Addr().String(),
		"server_name":           "localhost",
		"ca_pem":                string(ca.CertPEM),
		"cert_der_chain_base64": chain,
		"container":             container,
		"provider":              cngProvider,
		"device_id":             uuid.NewString(),
		"boot_id":               "boot-" + uuid.NewString(),
		"agent_instance_id":     uuid.NewString(),
		"journal_epoch":         uuid.NewString(),
		"profile_id":            "profile-tls12",
		"tool_manifest_hash":    strings.Repeat("a", 64),
		"runtime_digest":        strings.Repeat("b", 64),
		"last_receipt_seq":      0,
		"ticket":                sha256Hex(uuid.NewString() + uuid.NewString()),
		"budget_ms":             6000,
	}
	configPath := filepath.Join(t.TempDir(), "tls12-probe.json")
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	stdout, runErr := runCngProbeOutcome(t, bin, "dial", configPath)
	report := probeReport(t, stdout)
	// Record WHY it refused: a probe that died on a config error would also "pass" the
	// assertions below, so the reason is evidence, not noise.
	t.Logf("TLS 1.2-only peer refusal: %s", stdout)
	if runErr == nil || report["ok"] == true {
		t.Fatalf("the device negotiated TLS 1.2 with a peer that offers nothing else: %s", stdout)
	}
	if _, established := report["session_id"]; established {
		t.Fatalf("a session was established against a TLS 1.2-only peer: %s", stdout)
	}
	reason, _ := report["error"].(string)
	if !strings.Contains(reason, "disconnected") {
		t.Fatalf("the probe did not fail at the transport: %q", reason)
	}
	// The decisive assertion: the peer must never have completed a handshake at all.
	// Drained without closing, because the accept goroutine still owns the channel.
drained:
	for {
		select {
		case version := <-handshakes:
			t.Fatalf("the device completed a TLS handshake with a 1.2-only peer (version %#x); the protocol floor is not the client's", version)
		default:
			break drained
		}
	}
}

// runCngProbe runs one probe phase and returns its stdout. A failure is fatal with stderr
// attached: a probe that printed nothing is a wiring failure, not a silent skip.
func runCngProbe(t *testing.T, bin string, args ...string) string {
	t.Helper()
	stdout, err := runCngProbeOutcome(t, bin, args...)
	if err != nil {
		t.Fatalf("probe %v failed: %v\nstdout: %s", args, err, stdout)
	}
	return stdout
}

// runCngProbeOutcome is runCngProbe without the fatality, for phases whose EXPECTED outcome
// is a refusal. stderr is still attached to the failure message.
func runCngProbeOutcome(t *testing.T, bin string, args ...string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		t.Logf("probe %v exited with %v\nstderr: %s", args, err, stderr.String())
	}
	return stdout.String(), err
}

// cngKeygenReport parses the single CNG_KEYGEN line the keygen phase prints.
func cngKeygenReport(t *testing.T, stdout string) map[string]any {
	t.Helper()
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "CNG_KEYGEN ") {
			continue
		}
		var report map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "CNG_KEYGEN ")), &report); err != nil {
			t.Fatalf("CNG_KEYGEN is not JSON: %v", err)
		}
		return report
	}
	t.Fatalf("the keygen phase printed no CNG_KEYGEN line: %s", stdout)
	return nil
}

// newCngGatewayFixture is newGatewayFixture with the device key supplied from OUTSIDE: the
// CNG key the probe created, not a Go software key. The CA, the server certificate and the
// ticket seeding are identical; only the device's public key differs, which is the point.
func newCngGatewayFixture(t *testing.T, jwk []byte, thumbprint string) *gwFixture {
	t.Helper()
	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_gw_cng_test")
	_ = admin.Close(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		a, err := testpg.Open(cctx, testpg.AdminURL())
		if err == nil {
			_ = testpg.DropDatabase(cctx, a, dbName)
			_ = a.Close(cctx)
		}
	})

	deviceID := uuid.NewString()
	ticket := "ticket-" + uuid.NewString()
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	statement := fmt.Sprintf(`
		INSERT INTO work.org (id, status, home_region, name) VALUES ('%s','active','cn-north','GW');
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
			VALUES ('%s','%s','active','owner',true);
		INSERT INTO work.device
			(org_id, id, owner_subject_id, device_name, platform, public_key_jwk,
			 public_key_thumbprint, auth_plane, auth_epoch, status)
			VALUES ('%s','%s','%s','desk','windows-x64','%s'::jsonb,'%s','bearer',%d,'active');
		INSERT INTO work.device_session_ticket
			(org_id, device_id, owner_subject_id, auth_plane, auth_epoch,
			 public_key_thumbprint, ticket_hash, client_request_id, request_hash, expires_at, state)
			VALUES ('%s','%s','%s','bearer',%d,'%s','%s','tick-1','%s', now() + interval '60 seconds','pending');
	`, gwOrg, gwOrg, gwSubject, gwOrg, deviceID, gwSubject, string(jwk), thumbprint, gwEpoch,
		gwOrg, deviceID, gwSubject, gwEpoch, thumbprint, sha256Hex(ticket), sha256Hex("req"))
	if err := testpg.ExecRaw(ctx, seed, statement); err != nil {
		_ = seed.Close(ctx)
		t.Fatal(err)
	}
	_ = seed.Close(ctx)

	pool, err := workdb.OpenPool(ctx, testpg.WorkerURL(dbName), "work-gateway-cng-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	ca, err := deviceca.NewCA()
	if err != nil {
		t.Fatal(err)
	}
	serverCert, err := ca.IssueServerCert([]string{"localhost", "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	// priv stays nil: no Go client signs a hello here, the CNG-backed probe does.
	return &gwFixture{
		pool: pool, dbName: dbName, deviceID: deviceID, ticket: ticket,
		thumbprint: thumbprint, ca: ca, serverCert: serverCert,
	}
}