package gateway_test

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	"github.com/we-meet/work/internal/deviceca"
	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/gateway"
	"github.com/we-meet/work/internal/testpg"
)

// interopBinEnv names the prebuilt Rust probe. The Linux Go CI job builds it with
// `cargo build --example device_link_probe` and sets this, so the interop runs inside the
// serial full suite. Without it the test skips: a developer running `go test ./...` on a
// machine with no Rust toolchain still gets the whole Go suite.
const interopBinEnv = "WORK_DEVICE_INTEROP_BIN"

// TestDeviceLinkInterop drives the SHIPPED Rust device link against the real Go gateway over
// real platform mTLS and a real PostgreSQL chain. It is the cross-language evidence for GW17's
// A1 link: nothing here re-implements the device side, and nothing is a recorded vector.
//
// What it proves, in both directions:
//   - device→server: the probe's JCS-signed hello is verified against the in-DB public key and
//     activates a session row carrying the probe's own boot_id/agent_instance_id/journal_epoch.
//   - server→device: the probe parses hello_ack with its STRICT closed envelope parser — the
//     uint64 decimal-string boundary the server violated before GW17 (recovery_generation:"")
//     would make this fail outright — and provisions both bootstrap keys.
//   - the mTLS client certificate and the frame signature are the SAME key (§2.1): the probe
//     reports its public JWK and the test checks its thumbprint against the seeded device row.
//   - a heartbeat crosses and is accepted: the probe stays alive past one full server cadence,
//     and a refused heartbeat would have ended the stream (Disconnected) instead.
//
// Two tickets are used deliberately. work.activate_device_session has no challenge_response
// parameter and ALWAYS mints a new session (0040:1572-1668), so §2.2's "reconnect resumes the
// same active session" is unreachable server-side: the Go client's session and the probe's
// session are different rows, and the second hello supersedes the first. That is the measured
// behavior, not an assumption.
func TestDeviceLinkInterop(t *testing.T) {
	bin := os.Getenv(interopBinEnv)
	if bin == "" {
		t.Skipf("%s is not set; build the Rust probe with `cargo build --example device_link_probe`", interopBinEnv)
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("%s = %q is not a readable file: %v", interopBinEnv, bin, err)
	}

	f := newGatewayFixture(t)
	addr := f.startServer(t)

	// Phase 1: a Go device client takes the first ticket, so the test can read the gateway's
	// two bootstrap public keys and compare them with what the Rust probe provisions.
	goBoot := "boot-" + uuid.NewString()
	goAgent := uuid.NewString()
	goEpoch := uuid.NewString()
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(credentials.NewTLS(deviceca.ClientTLSConfig(f.ca, f.deviceCert, "localhost"))),
		grpc.WithDefaultCallOptions(grpc.ForceCodec(gateway.FrameCodec())),
	)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := conn.NewStream(gwContext(t),
		&grpc.StreamDesc{StreamName: "Connect", ServerStreams: true, ClientStreams: true},
		"/work.device.v2.DeviceGateway/Connect")
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.SendMsg(f.signHelloIdentity(t, f.ticket, goEpoch, goBoot, goAgent)); err != nil {
		t.Fatal(err)
	}
	ack := recvAck(t, stream)
	goSession, _ := ack["_session_id"].(string)
	if goSession == "" {
		t.Fatalf("hello_ack gave no session: %#v", ack)
	}
	wantServerKey := jwkThumbprint(t, ack["server_public_jwk"])
	wantPermitKey := jwkThumbprint(t, ack["permit_public_jwk"])
	if wantServerKey == wantPermitKey {
		t.Fatal("the gateway provisioned one key for both roles; §3.3 requires an independent permit key")
	}
	_ = conn.Close()

	// Phase 2: a FRESH single-use ticket for the probe. The first one is consumed, and a replay
	// of the same client_request_id would return ticket:null (0040:1429), so a second row is
	// the only honest way to dial again.
	probeTicket := "ticket-" + uuid.NewString()
	f.seedSecondTicket(t, probeTicket)

	// The connector loads a PKCS#12 archive: native-tls's schannel from_pkcs8 is RSA-only
	// (ProviderType::rsa_full + KeySpec::key_exchange), so an EC P-256 device identity cannot
	// be handed over as PEM. Go's standard library has no PKCS#12 encoder, so the fixture uses
	// the openssl CLI rather than taking on a new library dependency for a test.
	pfxPassword := "interop-" + uuid.NewString()
	probeBoot := "boot-" + uuid.NewString()
	probeAgent := uuid.NewString()
	probeEpoch := uuid.NewString()
	scalar := make([]byte, 32)
	f.priv.D.FillBytes(scalar)

	config := map[string]any{
		"endpoint":              "https://" + addr,
		"server_name":           "localhost",
		"ca_pem":                string(f.ca.CertPEM),
		"client_pkcs12_base64":  base64.RawURLEncoding.EncodeToString(f.clientPFX(t, pfxPassword)),
		"pkcs12_password":       pfxPassword,
		"device_key_scalar_hex": hex.EncodeToString(scalar),
		"device_id":             f.deviceID,
		"boot_id":               probeBoot,
		"agent_instance_id":     probeAgent,
		"journal_epoch":         probeEpoch,
		"profile_id":            "profile-interop",
		"tool_manifest_hash":    strings.Repeat("a", 64),
		"runtime_digest":        strings.Repeat("b", 64),
		"last_receipt_seq":      0,
		"ticket":                probeTicket,
		// One server cadence is 10s; the probe exits as soon as it has outlived it.
		"budget_ms": 40000,
	}
	configPath := filepath.Join(t.TempDir(), "probe.json")
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, configPath)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	report := probeReport(t, stdout.String())
	if runErr != nil {
		t.Fatalf("probe failed: %v\nreport: %s\nstderr: %s", runErr, stdout.String(), stderr.String())
	}
	if report["ok"] != true {
		t.Fatalf("probe reported failure: %s\nstderr: %s", stdout.String(), stderr.String())
	}

	// The probe's own key is the key the device row was seeded with, so the certificate and the
	// frame signature are one identity (§2.1).
	probeJWK := report["device_public_jwk"]
	if got := jwkThumbprint(t, probeJWK); got != f.thumbprint {
		t.Fatalf("probe key thumbprint = %s, seeded device = %s", got, f.thumbprint)
	}

	// Both bootstrap keys reached the Rust side byte-identically.
	if got := jwkThumbprint(t, report["server_public_jwk"]); got != wantServerKey {
		t.Fatalf("probe server key thumbprint = %s, gateway = %s", got, wantServerKey)
	}
	if got := jwkThumbprint(t, report["permit_public_jwk"]); got != wantPermitKey {
		t.Fatalf("probe permit key thumbprint = %s, gateway = %s", got, wantPermitKey)
	}

	// The session the probe reports is a NEW row, not the Go client's: every hello mints one.
	probeSession, _ := report["session_id"].(string)
	if probeSession == "" || probeSession == goSession {
		t.Fatalf("probe session = %q, Go client session = %q; every hello must mint a new session",
			probeSession, goSession)
	}
	// generation is the ORG's access_epoch at activation (0040:1640/1666), not the device's
	// auth_epoch; the fixture leaves access_epoch at its default, so the assertion compares
	// against the session row the server actually wrote rather than a guessed constant.
	if _, ok := report["generation"].(float64); !ok {
		t.Fatalf("probe generation = %#v, want the JSON number activate_device_session emits", report["generation"])
	}
	if ttl, ok := report["lease_ttl_ms"].(float64); !ok || ttl != 30000 {
		t.Fatalf("probe lease_ttl_ms = %#v, want 30000", report["lease_ttl_ms"])
	}
	if hb, ok := report["heartbeat_ms"].(float64); !ok || hb != 10000 {
		t.Fatalf("probe heartbeat_ms = %#v, want 10000", report["heartbeat_ms"])
	}
	if resync, ok := report["resync_required"].(bool); !ok || !resync {
		t.Fatalf("probe resync_required = %#v, want true on a fresh session", report["resync_required"])
	}
	// Liveness past one full cadence is the heartbeat evidence: a refused heartbeat fails the
	// whole frame and ends the stream, which the probe would report as Disconnected.
	alive, ok := report["alive_ms"].(float64)
	if !ok || int64(alive) <= 10000 {
		t.Fatalf("probe alive_ms = %#v, want more than one 10s server cadence", report["alive_ms"])
	}

	// Server-side truth: the session row carries the PROBE's identity, and the Go client's
	// session was superseded by it (0040:1645-1648, one active session per device).
	ctx2 := gwContext(t)
	db, err := testpg.Open(ctx2, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close(ctx2) }()
	var bootID, agentID, journalEpoch, state string
	var generation int64
	if err := db.QueryRow(ctx2, `
		SELECT boot_id, agent_instance_id::text, journal_epoch::text, state, generation
		FROM work.device_session WHERE org_id=$1 AND id=$2::uuid`,
		gwOrg, probeSession).Scan(&bootID, &agentID, &journalEpoch, &state, &generation); err != nil {
		t.Fatalf("probe session row: %v", err)
	}
	if bootID != probeBoot || agentID != probeAgent || journalEpoch != probeEpoch {
		t.Fatalf("session identity = %q/%q/%q, probe sent %q/%q/%q",
			bootID, agentID, journalEpoch, probeBoot, probeAgent, probeEpoch)
	}
	if state != "active" {
		t.Fatalf("session state = %q, want active", state)
	}
	if int64(report["generation"].(float64)) != generation {
		t.Fatalf("probe generation = %#v, session row generation = %d", report["generation"], generation)
	}
	var oldState string
	if err := db.QueryRow(ctx2, `
		SELECT state FROM work.device_session WHERE org_id=$1 AND id=$2::uuid`,
		gwOrg, goSession).Scan(&oldState); err != nil {
		t.Fatal(err)
	}
	if oldState != "superseded" {
		t.Fatalf("the first session is %q, want superseded: a new hello terminalizes the old one", oldState)
	}
	// The ticket the probe spent is consumed, and the Go client's ticket is consumed too.
	for _, ticket := range []string{f.ticket, probeTicket} {
		var ticketState string
		sum := sha256.Sum256([]byte(ticket))
		if err := db.QueryRow(ctx2, `
			SELECT state FROM work.device_session_ticket WHERE org_id=$1 AND ticket_hash=$2`,
			gwOrg, hex.EncodeToString(sum[:])).Scan(&ticketState); err != nil {
			t.Fatal(err)
		}
		if ticketState != "consumed" {
			t.Fatalf("ticket state = %q, want consumed", ticketState)
		}
	}
}

// seedSecondTicket inserts another pending single-use ticket for the same device/key/epoch.
func (f *gwFixture) seedSecondTicket(t *testing.T, ticket string) {
	t.Helper()
	ctx := gwContext(t)
	db, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close(ctx) }()
	sum := sha256.Sum256([]byte(ticket))
	requestID := "tick-" + uuid.NewString()
	statement := fmt.Sprintf(`
		INSERT INTO work.device_session_ticket
			(org_id, device_id, owner_subject_id, auth_plane, auth_epoch,
			 public_key_thumbprint, ticket_hash, client_request_id, request_hash, expires_at, state)
		VALUES ('%s','%s','%s','bearer',%d,'%s','%s','%s','%s', now() + interval '60 seconds','pending');
	`, gwOrg, f.deviceID, gwSubject, gwEpoch, f.thumbprint,
		hex.EncodeToString(sum[:]), requestID, sha256Hex("req-"+requestID))
	if err := testpg.ExecRaw(ctx, db, statement); err != nil {
		t.Fatal(err)
	}
}

// clientPFX builds the device's PKCS#12 client identity from the test CA's certificate chain
// and the device private key, using the openssl CLI. Go's standard library encodes PKCS#8 but
// has no PKCS#12 encoder, and the Rust connector needs PKCS#12 because schannel's from_pkcs8
// path is RSA-only while the device identity is EC P-256.
//
// The archive is TEST-ONLY and ephemeral: it wraps a test CA key for one loopback connection
// and is written into t.TempDir(). Production never builds one — §2.1 keeps the device key
// non-exportable in CNG, which is the registered J39 gap.
func (f *gwFixture) clientPFX(t *testing.T, password string) []byte {
	t.Helper()
	openssl, err := exec.LookPath("openssl")
	if err != nil {
		t.Fatalf("the interop fixture needs the openssl CLI to encode a PKCS#12 identity: %v", err)
	}
	dir := t.TempDir()
	leaf := filepath.Join(dir, "leaf.pem")
	chain := filepath.Join(dir, "chain.pem")
	key := filepath.Join(dir, "key.pem")
	out := filepath.Join(dir, "device.pfx")
	writePEM(t, leaf, "CERTIFICATE", f.deviceCert.Certificate[0])
	if len(f.deviceCert.Certificate) > 1 {
		writePEM(t, chain, "CERTIFICATE", f.deviceCert.Certificate[1])
	}
	der, err := x509.MarshalPKCS8PrivateKey(f.priv)
	if err != nil {
		t.Fatal(err)
	}
	writePEM(t, key, "PRIVATE KEY", der)

	args := []string{"pkcs12", "-export", "-out", out, "-inkey", key, "-in", leaf,
		"-passout", "pass:" + password}
	if len(f.deviceCert.Certificate) > 1 {
		args = append(args, "-certfile", chain)
	}
	// PBE-SHA1-3DES is the classic PFX protection Windows schannel imports reliably; OpenSSL
	// 3.x's default AES-256-CBC/PBKDF2 archive is not importable on every Windows build. This
	// is a test-only archive over a test CA key, never a production credential.
	args = append(args, "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1")
	cmd := exec.Command(openssl, args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("openssl pkcs12 -export: %v; stderr: %s", err, stderr.String())
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func writePEM(t *testing.T, path, blockType string, der []byte) {
	t.Helper()
	raw := pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der})
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

// jwkThumbprint parses a JWK through the closed four-member parser and returns its thumbprint,
// the canonical key identity. Comparing thumbprints rather than JSON text makes the comparison
// independent of member order, and it refuses a JWK the device would also refuse.
func jwkThumbprint(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := devicesig.ParseJWK(raw)
	if err != nil {
		t.Fatalf("JWK does not parse: %v (%s)", err, raw)
	}
	return pub.Thumbprint
}

// probeReport extracts the single PROBE_REPORT line the example prints.
func probeReport(t *testing.T, stdout string) map[string]any {
	t.Helper()
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "PROBE_REPORT ") {
			continue
		}
		var report map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "PROBE_REPORT ")), &report); err != nil {
			t.Fatalf("probe report is not JSON: %v (%s)", err, line)
		}
		return report
	}
	t.Fatalf("probe printed no PROBE_REPORT line:\n%s", stdout)
	return nil
}
