package gateway_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/we-meet/work/internal/testpg"
)

// brokerBinEnv names the prebuilt Windows broker probe. Unlike WORK_DEVICE_INTEROP_BIN it is
// deliberately NOT set by any CI job: the named pipe is Windows-only while the PostgreSQL fixture
// only exists in the Linux go-migrate job, so no single runner can carry the whole chain. This test
// is the LOCAL full-chain evidence for GW18 (run it on Windows with both toolchains and
// WORK_TEST_PG_URL), and it skips everywhere else rather than pretending to cover the seam.
const brokerBinEnv = "WORK_DEVICE_BROKER_BIN"

// TestDeviceBrokerInterop drives the whole GW18 ticket path against the real gateway and the real
// PostgreSQL chain: Go plays the desktop shell main process, connects to the Broker's REAL named
// pipe, completes the one-time handshake, delivers a single-use ticket and reads the closed reply;
// the Rust probe runs the SHIPPED pipe service loop, ticket pump and A1 link.
//
// The probe's config has no ticket member at all, so the link cannot dial with a handed-over
// ticket: a session established here proves the ticket travelled pipe → dispatch → pump → slot →
// link → gateway. The ticket is minted in the real `mint_device_session_ticket` output shape
// (sha256_text(uuid||uuid), 64 lowercase hex, 0040:1469), which the Broker's shape gate requires —
// the GW17 link probe used a "ticket-<uuid>" placeholder that never passed through that gate.
func TestDeviceBrokerInterop(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skipf("the Broker named pipe is Windows-only; the Linux interop covers link→gateway (GOOS=%s)", runtime.GOOS)
	}
	bin := os.Getenv(brokerBinEnv)
	if bin == "" {
		t.Skipf("%s is not set; build it with `cargo build --example device_broker_probe`", brokerBinEnv)
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("%s = %q is not a readable file: %v", brokerBinEnv, bin, err)
	}

	f := newGatewayFixture(t)
	addr := f.startServer(t)

	// The real mint shape: sha256 of two concatenated UUIDs, 64 lowercase hex.
	ticket := sha256Hex(uuid.NewString() + uuid.NewString())
	if len(ticket) != 64 {
		t.Fatalf("ticket shape = %d chars, want the 64-hex mint output", len(ticket))
	}
	f.seedSecondTicket(t, ticket)
	// The real row id, so the delivery carries the server's own dedup key rather than a fabricated
	// one: session_ticket_id is what the Broker refuses a replay of.
	ticketRow := ticketRowID(t, f, ticket)

	pfxPassword := "broker-" + uuid.NewString()
	probeBoot := "boot-" + uuid.NewString()
	probeAgent := uuid.NewString()
	probeEpoch := uuid.NewString()
	scalar := make([]byte, 32)
	f.priv.D.FillBytes(scalar)
	pipeName := `\\.\pipe\work-gw18-` + uuid.NewString()
	requestID := "req-" + uuid.NewString()

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
		"profile_id":            "profile-broker-interop",
		"tool_manifest_hash":    strings.Repeat("a", 64),
		"runtime_digest":        strings.Repeat("b", 64),
		"last_receipt_seq":      0,
		"pipe_name":             pipeName,
		// The Go test process IS the shell client here, so its own PID is the predicate.
		"shell_pid":             os.Getpid(),
		"budget_ms":             40000,
	}
	// No "ticket" key: the probe structurally cannot dial without the pipe delivery.
	if _, ok := config["ticket"]; ok {
		t.Fatal("the broker probe config must not carry a ticket")
	}
	configPath := filepath.Join(t.TempDir(), "broker.json")
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, configPath)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	// The shell side: a real pipe client, not a Rust loopback. The probe creates the instance on a
	// spawned thread, so retry until it exists.
	pipe := openShellPipe(t, pipeName)
	defer func() { _ = pipe.Close() }()
	hello := readPipeFrame(t, pipe)
	nonce, _ := hello["nonce"].(string)
	if nonce == "" {
		t.Fatalf("server hello carried no nonce: %#v", hello)
	}
	if major, _ := hello["protocol_major"].(float64); major != 2 {
		t.Fatalf("server hello protocol_major = %#v, want 2", hello["protocol_major"])
	}
	if len(hello) != 2 {
		t.Fatalf("server hello is not the closed two-key shape: %#v", hello)
	}
	writePipeFrame(t, pipe, map[string]any{
		"nonce": nonce, "protocol_major": 2, "client_kind": "shell",
	})

	// An unlanded shell method must be answered explicitly, not ignored and not called unknown.
	writePipeFrame(t, pipe, map[string]any{"method": "chooseWorkspace", "request_id": requestID})
	refusal := readPipeFrame(t, pipe)
	if refusal["result"] != "refused" || refusal["code"] != "method_not_implemented" {
		t.Fatalf("unimplemented method reply = %#v, want refused/method_not_implemented", refusal)
	}
	if refusal["request_id"] != requestID || refusal["method"] != "chooseWorkspace" {
		t.Fatalf("refusal did not echo the caller's correlation: %#v", refusal)
	}
	// An unknown method is a DIFFERENT code, so the shell can tell illegal from unlanded.
	writePipeFrame(t, pipe, map[string]any{"method": "executeArbitrary", "request_id": requestID})
	if got := readPipeFrame(t, pipe); got["code"] != "unknown_method" {
		t.Fatalf("unknown method reply = %#v, want unknown_method", got)
	}

	// The delivery itself, in the closed five-key shape.
	writePipeFrame(t, pipe, map[string]any{
		"method":            "deliverDeviceSessionTicket",
		"request_id":        requestID,
		"ticket":            ticket,
		"device_id":         f.deviceID,
		"session_ticket_id": ticketRow,
	})
	accepted := readPipeFrame(t, pipe)
	if accepted["result"] != "accepted" {
		t.Fatalf("delivery reply = %#v, want accepted", accepted)
	}
	if accepted["request_id"] != requestID || accepted["method"] != "deliverDeviceSessionTicket" {
		t.Fatalf("accepted reply did not echo the caller: %#v", accepted)
	}
	if _, hasCode := accepted["code"]; hasCode {
		t.Fatalf("an accepted reply must carry no code: %#v", accepted)
	}
	if len(accepted) != 3 {
		t.Fatalf("accepted reply is not the closed three-key shape: %#v", accepted)
	}
	// A replay of the spent id is refused: the mint returns null on replay (0040:1429).
	writePipeFrame(t, pipe, map[string]any{
		"method":            "deliverDeviceSessionTicket",
		"request_id":        requestID,
		"ticket":            ticket,
		"device_id":         f.deviceID,
		"session_ticket_id": ticketRow,
	})
	if got := readPipeFrame(t, pipe); got["code"] != "already_consumed" {
		t.Fatalf("re-delivery reply = %#v, want already_consumed", got)
	}

	// Release the single pipe instance before waiting. The service loop blocks in read_frame while
	// a client holds the instance, and the probe joins that thread to prove the teardown; a shell
	// that keeps the pipe open is normal in production but would deadlock the probe's own evidence.
	_ = pipe.Close()
	runErr := cmd.Wait()
	if !strings.Contains(stdout.String(), "PROBE_REPORT ") {
		t.Fatalf("broker probe printed no report (run error: %v)\nstdout: %s\nstderr: %s",
			runErr, stdout.String(), stderr.String())
	}
	report := probeReport(t, stdout.String())
	if runErr != nil {
		t.Fatalf("broker probe failed: %v\nreport: %s\nstderr: %s", runErr, stdout.String(), stderr.String())
	}
	if report["ok"] != true {
		t.Fatalf("broker probe reported failure: %s\nstderr: %s", stdout.String(), stderr.String())
	}
	if got := jwkThumbprint(t, report["device_public_jwk"]); got != f.thumbprint {
		t.Fatalf("probe key thumbprint = %s, seeded device = %s", got, f.thumbprint)
	}
	serverKey := jwkThumbprint(t, report["server_public_jwk"])
	permitKey := jwkThumbprint(t, report["permit_public_jwk"])
	if serverKey == permitKey {
		t.Fatal("the probe provisioned one key for both roles; §3.3 requires an independent permit key")
	}
	probeSession, _ := report["session_id"].(string)
	if probeSession == "" {
		t.Fatalf("the link established no session from a pipe-delivered ticket: %#v", report)
	}
	if alive, ok := report["alive_ms"].(float64); !ok || int64(alive) <= 10000 {
		t.Fatalf("probe alive_ms = %#v, want more than one 10s server cadence", report["alive_ms"])
	}
	if report["pipe_stopped"] != true {
		t.Fatalf("the pipe loop did not stop with the pump: %#v", report["pipe_stopped"])
	}
	if report["bridge_outcome"] != "LinkStopped" {
		t.Fatalf("pump outcome = %#v, want LinkStopped", report["bridge_outcome"])
	}
	if report["pipe_name"] != pipeName {
		t.Fatalf("probe used pipe %#v, test opened %q", report["pipe_name"], pipeName)
	}

	// Server-side truth: the session carries the probe's identity and the pipe-delivered ticket is
	// consumed. Nothing here is inferred from the probe's own report.
	ctx2 := gwContext(t)
	db, err := testpg.Open(ctx2, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close(ctx2) }()
	var bootID, agentID, journalEpoch, state string
	if err := db.QueryRow(ctx2, `
		SELECT boot_id, agent_instance_id::text, journal_epoch::text, state
		FROM work.device_session WHERE org_id=$1 AND id=$2::uuid`,
		gwOrg, probeSession).Scan(&bootID, &agentID, &journalEpoch, &state); err != nil {
		t.Fatalf("probe session row: %v", err)
	}
	if bootID != probeBoot || agentID != probeAgent || journalEpoch != probeEpoch {
		t.Fatalf("session identity = %q/%q/%q, probe sent %q/%q/%q",
			bootID, agentID, journalEpoch, probeBoot, probeAgent, probeEpoch)
	}
	if state != "active" {
		t.Fatalf("session state = %q, want active", state)
	}
	var ticketState string
	sum := sha256.Sum256([]byte(ticket))
	if err := db.QueryRow(ctx2, `
		SELECT state FROM work.device_session_ticket WHERE org_id=$1 AND ticket_hash=$2`,
		gwOrg, hex.EncodeToString(sum[:])).Scan(&ticketState); err != nil {
		t.Fatal(err)
	}
	if ticketState != "consumed" {
		t.Fatalf("the pipe-delivered ticket is %q, want consumed", ticketState)
	}
}

// ticketRowID reads the seeded ticket's own row id.
func ticketRowID(t *testing.T, f *gwFixture, ticket string) string {
	t.Helper()
	ctx := gwContext(t)
	db, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close(ctx) }()
	sum := sha256.Sum256([]byte(ticket))
	var id string
	if err := db.QueryRow(ctx, `
		SELECT id::text FROM work.device_session_ticket WHERE org_id=$1 AND ticket_hash=$2`,
		gwOrg, hex.EncodeToString(sum[:])).Scan(&id); err != nil {
		t.Fatalf("seeded ticket row: %v", err)
	}
	return id
}

// openShellPipe opens the Broker's pipe as the desktop shell would, retrying while the probe's
// server thread is still creating the instance.
func openShellPipe(t *testing.T, name string) *os.File {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
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

// readPipeFrame reads one 4-byte-big-endian length-prefixed message and decodes it as JSON.
func readPipeFrame(t *testing.T, pipe *os.File) map[string]any {
	t.Helper()
	var prefix [4]byte
	if _, err := io.ReadFull(pipe, prefix[:]); err != nil {
		t.Fatalf("read frame prefix: %v", err)
	}
	size := binary.BigEndian.Uint32(prefix[:])
	if size > 64*1024 {
		t.Fatalf("frame claims %d bytes, above the 64KiB single-frame cap", size)
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

func writePipeFrame(t *testing.T, pipe *os.File, value map[string]any) {
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
