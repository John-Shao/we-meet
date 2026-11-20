package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/deviceca"
	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

// TestDeviceFullFixtureRunWritesAnArtifact drives the WHOLE execution-face write spine against the
// SHIPPED work-device binary, the real mTLS gateway and the real PostgreSQL chain (execution-face
// §6, batch 2 ruling 甲/乙): Go plays the desktop shell, pairs and establishes a session, runs the
// §4.2 root + §5.4 model + §1.1 stageLocalInput confirmation gestures, seeds a local_only grant and
// a fixture-digest offer, and lets the Broker drive offer→run_ready→run_start→sidecar. The bundled
// pi-agent-core loop calls the deterministic device_local fixture model, which drives an
// artifact.write tool_call; the Broker proposes action_prepare (A2 write spine), Go decides the
// ask_each approval, the next heartbeat claims the command, the Broker consumes it into the live
// per-Run map and executes the write, and the signed receipt uplinks to a SERVER device_receipt row.
//
// This is the model→artifact.write→completed evidence (DD:138). Windows-only (named pipes + CNG +
// AppContainer sidecar) and the real PG fixture lives in the Linux job, so no CI job spans this seam
// — the same boundary GW18/GW21 registered; a node gate forbids any workflow naming WORK_DEVICE_BIN.
func TestDeviceFullFixtureRunWritesAnArtifact(t *testing.T) {
	bin := requireBrokerBin(t)
	f := startFixtureBroker(t, bin)

	// ---- seed the server-side grant + run + fixture-digest offer ----
	inputHash := strings.Repeat("2", 64)
	runID := seedFixtureRun(t, f.dbName, f.deviceID, f.sessionID, f.bootID, f.grantID, f.rootIdentityHash,
		f.profile.ProfileID, f.profile.RuntimeDigest, f.profile.ToolManifestHash, inputHash)

	// The Broker drives offer→run_ready→run_start→sidecar on its own heartbeat cadence; the sidecar
	// calls the fixture model, which drives artifact.write. The Broker proposes action_prepare and
	// waits for the command; Go decides the ask_each approval, then the next heartbeat dispatches.
	approvalID, operationID, paramsHash, approvalRevision := waitForPendingApproval(t, f.dbName, runID, f.stderr)
	decideFixtureApproval(t, f.dbName, f.sessionID, f.deviceID, runID, approvalID, operationID, paramsHash, approvalRevision)

	// The write executes once the command reaches the live map; the signed receipt lands server-side.
	waitForCompletedReceipt(t, f.dbName, operationID)
	written, err := os.ReadFile(filepath.Join(f.rootDir, "out", "v1.md"))
	if err != nil {
		t.Fatalf("the artifact was not written: %v; broker stderr:\n%s", err, f.stderr.String())
	}
	if string(written) != artifactText {
		t.Fatalf("artifact content = %q, want the staged input %q", written, artifactText)
	}
	// Server-side truth: the receipt is completed/succeeded and bound to the journal epoch.
	var state, outcome, epoch string
	if err := brokerDB(t, f.dbName).QueryRow(context.Background(), `
		SELECT dr.state, dr.outcome, dr.journal_epoch::text
		FROM work.device_receipt dr
		WHERE dr.org_id = $1 AND dr.operation_id = $2::uuid AND dr.state = 'completed'`,
		testOrg, operationID).Scan(&state, &outcome, &epoch); err != nil {
		t.Fatalf("server receipt row: %v", err)
	}
	if state != "completed" || outcome != "succeeded" {
		t.Fatalf("receipt = %s/%s, want completed/succeeded", state, outcome)
	}
	if epoch != f.journalEpoch {
		t.Fatalf("receipt journal_epoch = %s, session epoch = %s", epoch, f.journalEpoch)
	}
}

// artifactText is the fixture artifact正文 the shell stages through stageLocalInput (§1.1); the write
// Run writes it verbatim into out/v1.md and the cancel/lease Runs reuse the same staging.
const artifactText = "the fixture artifact body"

// fixtureProfile is the dev fixture profile's closed shape (the REAL computed digests, §6.5).
type fixtureProfile struct {
	ProfileID           string `json:"profile_id"`
	RuntimeDigest       string `json:"runtime_digest"`
	ToolManifestHash    string `json:"tool_manifest_hash"`
	ListenerRequirement struct {
		AllowedSigners      []string `json:"allowed_signers"`
		AllowUserPinnedHash bool     `json:"allow_user_pinned_hash"`
		AllowedServiceSIDs  []string `json:"allowed_service_sids"`
	} `json:"listener_requirement"`
}

// runFixture holds everything a gateway-driven real-exe Run test needs after the shared spine
// (pair→certificate→session→root grant→staged input→confirmed model binding). The Run itself is NOT
// seeded: each test seeds its own run + drives its own scenario (write to completion, cancel, lease loss).
type runFixture struct {
	pipe             *os.File
	dbName           string
	deviceID         string
	sessionID        string
	journalEpoch     string
	bootID           string
	agentID          string
	grantID          string
	rootDir          string
	rootIdentityHash string
	inputRef         string
	contentHash      string
	byteCount        string
	stderr           *syncBuffer
	cmd              *exec.Cmd
	container        string
	dir              string
	exeDir           string
	profile          fixtureProfile
	port             int
}

// requireBrokerBin skips on non-Windows / when the shipped binary env is unset, else returns its path.
func requireBrokerBin(t *testing.T) string {
	t.Helper()
	if runtime.GOOS != "windows" {
		t.Skip("the full Run needs Windows named pipes, CNG and the AppContainer sidecar")
	}
	bin := os.Getenv(brokerBinEnv)
	if bin == "" {
		t.Skipf("%s is not set; the full-Run seam is proven by a local Windows run only", brokerBinEnv)
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("%s points at an unreadable binary: %v", brokerBinEnv, err)
	}
	return bin
}

// startFixtureBroker drives the shared GW21/M2 spine against the real REST face + mTLS gateway and
// leaves a confirmed grant + staged input + confirmed device_local model binding, with the Broker
// process running and a shell pipe open. The fixture model scenario is a single artifact.write turn
// (which proposes action_prepare and awaits the command) followed by a stop turn — so a Run that never
// decides the approval keeps the sidecar alive awaiting the command (the cancel/lease kill window).
func startFixtureBroker(t *testing.T, bin string) *runFixture {
	t.Helper()
	// The fixture layout: node.exe + work-device-bundle/ next to the executable (main.rs derives the
	// sidecar inputs from current_exe's dir). The profile carries the REAL computed digests.
	exeDir := filepath.Dir(bin)
	profileRaw, err := os.ReadFile(filepath.Join(exeDir, "work-device-bundle", "dev-fixture-profile.json"))
	if err != nil {
		t.Fatalf("the fixture layout has no dev-fixture-profile.json (build:work-device): %v", err)
	}
	var profile fixtureProfile
	if err := json.Unmarshal(profileRaw, &profile); err != nil {
		t.Fatal(err)
	}

	pool, dbName := newBootstrapDB(t, false, true)
	seedDeviceLocalPolicy(t, dbName)
	// ask_each approval needs a positive policy epoch (request_approval refuses epoch <= 0).
	adminExec(t, dbName, fmt.Sprintf(
		`UPDATE work.local_execution_policy SET effective_epoch = 1 WHERE org_id = '%s'`, testOrg))

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
	// The confirmed root the artifact.write writes into; the grant's artifact_dir is "out".
	rootDir := filepath.Join(dir, "workspace")
	if err := os.MkdirAll(filepath.Join(rootDir, "out"), 0o700); err != nil {
		t.Fatal(err)
	}
	container := "work-device-run-" + uuid.NewString()
	pipeName := `\\.\pipe\work-device-run-` + uuid.NewString()
	bootID := "boot-" + uuid.NewString()
	agentID := uuid.NewString()
	journalDir := filepath.Join(dir, "journal")
	config := map[string]any{
		"pipe_name":          pipeName,
		"shell_pid":          os.Getpid(),
		"endpoint":           "https://localhost:" + strings.Split(gwAddr, ":")[1],
		"server_name":        "localhost",
		"ca_pem_path":        caPath,
		"container":          container,
		"provider":           "Microsoft Software Key Storage Provider",
		"boot_id":            bootID,
		"agent_instance_id":  agentID,
		"journal_dir":        journalDir,
		"profile_id":         profile.ProfileID,
		"tool_manifest_hash": profile.ToolManifestHash,
		"runtime_digest":     profile.RuntimeDigest,
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

	stderr := &syncBuffer{}
	cmd := exec.Command(bin, configPath)
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		out, err := exec.Command(bin, "--delete-container", container).CombinedOutput()
		if err != nil {
			t.Logf("CNG container teardown: %v (%s)", err, out)
		}
	})
	t.Cleanup(func() { t.Logf("DIAG broker stderr:\n%s", stderr.String()) })

	pipe := openBrokerPipe(t, pipeName)
	t.Cleanup(func() { _ = pipe.Close() })
	hello := readBrokerFrame(t, pipe)
	writeBrokerFrame(t, pipe, map[string]any{
		"nonce": hello["nonce"], "protocol_major": 2, "client_kind": "shell",
	})

	// ---- §2.1 pair → certificate → session (the GW21 spine, condensed) ----
	identity := brokerCall(t, pipe, map[string]any{"method": "getDeviceIdentity", "request_id": "id-1"})
	data := identity["data"].(map[string]any)
	jwkRaw, err := json.Marshal(data["public_key_jwk"])
	if err != nil {
		t.Fatal(err)
	}
	pub, err := devicesig.ParseJWK(jwkRaw)
	if err != nil {
		t.Fatal(err)
	}
	pairBody := fmt.Sprintf(`{"client_request_id":"run-pair","device_name":"desk","platform":"windows-x64","public_key_jwk":%s}`, jwkRaw)
	pairing := decodeObject(t, deviceRequest(t, http.MethodPost, rest.URL+api.DevicePairingsPath, pairBody))
	pairingID, _ := pairing["pairing_id"].(string)
	deviceID, _ := pairing["device_id"].(string)
	challenge, _ := pairing["challenge"].(string)
	signed := brokerCall(t, pipe, map[string]any{
		"method": "signDevicePairing", "request_id": "sig-1",
		"pairing_id": pairingID, "challenge": challenge, "org_id": testOrg, "subject_id": testSubject,
	})
	signature := signed["data"].(map[string]any)["signature"].(string)
	confirmPath := strings.ReplaceAll(api.DevicePairingConfirmPath, "{pairingId}", pairingID)
	confirmBody := fmt.Sprintf(`{"client_request_id":"run-confirm","challenge":%q,"signature":%q}`, challenge, signature)
	confirmed := decodeObject(t, deviceRequest(t, http.MethodPost, rest.URL+confirmPath, confirmBody))
	certPEM, _ := confirmed["certificate_pem"].(string)
	brokerCall(t, pipe, map[string]any{
		"method": "deliverDeviceCertificate", "request_id": "cert-1",
		"device_id": deviceID, "certificate_pem": certPEM,
	})
	ticketPath := strings.ReplaceAll(api.DeviceSessionTicketsPath, "{deviceId}", deviceID)
	ticketBody := fmt.Sprintf(`{"client_request_id":"run-ticket","public_key_thumbprint":%q}`, pub.Thumbprint)
	minted := decodeObject(t, deviceRequest(t, http.MethodPost, rest.URL+ticketPath, ticketBody))
	ticket, _ := minted["ticket"].(string)
	ticketRowID, _ := minted["session_ticket_id"].(string)
	brokerCall(t, pipe, map[string]any{
		"method": "deliverDeviceSessionTicket", "request_id": "tick-1",
		"device_id": deviceID, "session_ticket_id": ticketRowID, "ticket": ticket,
	})
	sessionID, journalEpoch := waitForBrokerSession(t, dbName, deviceID, bootID, agentID)
	if sessionID == "" {
		t.Fatalf("the Broker never established a session; stderr:\n%s", stderr.String())
	}

	// ---- §4.2 root confirmation: register grant G in the Broker, holding the root handle ----
	grantID := uuid.NewString()
	choose := brokerCall(t, pipe, map[string]any{
		"method": "chooseWorkspace", "request_id": "cw-1", "selected_path": rootDir,
	})
	rootToken := choose["data"].(map[string]any)["confirmation_token"].(string)
	confirmRoot := brokerCall(t, pipe, map[string]any{
		"method": "confirmWorkspaceRoot", "request_id": "cw-2",
		"confirmation_token": rootToken, "grant_id": grantID,
		"artifact_dir": []string{"out"}, "approved": true,
	})
	rootIdentityHash := confirmRoot["data"].(map[string]any)["root_identity_hash"].(string)
	// The Broker reports the sha256:-prefixed form; the workspace_grant column requires bare 64-hex.
	rootIdentityHash = strings.TrimPrefix(rootIdentityHash, "sha256:")

	// ---- §1.1 stageLocalInput: seal the artifact正文, exchange for the ref + hash/size ----
	staged := brokerCall(t, pipe, map[string]any{
		"method": "stageLocalInput", "request_id": "si-1", "text": artifactText,
	})
	stagedData := staged["data"].(map[string]any)
	inputRef := stagedData["local_input_ref"].(string)
	contentHash := stagedData["content_hash"].(string)
	byteCount := stagedData["byte_count"].(string)

	// ---- §5.4 model confirmation: a real loopback fixture process the identity gate reads ----
	port := freeLoopbackPort(t)
	fixtureNode := filepath.Join(exeDir, "node.exe")
	scenarioPath := filepath.Join(dir, "scenario.json")
	writeArgs := map[string]any{
		"grant_id": grantID, "artifact_id": "a", "version_id": "v1", "format": "md",
		"body_ref": inputRef, "content_hash": contentHash, "byte_count": byteCount,
	}
	writeArgsJSON, err := json.Marshal(writeArgs)
	if err != nil {
		t.Fatal(err)
	}
	scenario := []map[string]any{
		{"role": "assistant", "content": "", "tool_calls": []map[string]any{
			{"id": "call-1", "type": "function", "function": map[string]any{
				"name": "artifact.write", "arguments": string(writeArgsJSON),
			}},
		}},
		{"role": "assistant", "content": "Artifact written."},
	}
	scenarioRaw, err := json.Marshal(scenario)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(scenarioPath, scenarioRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	fixtureServer := filepath.Join(exeDir, "work-device-bundle", "fixture-server.mjs")
	fixtureCmd := exec.Command(fixtureNode, fixtureServer, fmt.Sprintf("%d", port), scenarioPath)
	var fixtureErr syncBuffer
	fixtureCmd.Stderr = &fixtureErr
	if err := fixtureCmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fixtureCmd.Process.Kill(); _, _ = fixtureCmd.Process.Wait() })
	waitFixtureListening(t, port)

	probe := brokerCall(t, pipe, map[string]any{
		"method": "probeLocalModel", "request_id": "pm-1", "port": fmt.Sprintf("%d", port),
	})
	modelToken := probe["data"].(map[string]any)["confirmation_token"].(string)
	confirmModel := brokerCall(t, pipe, map[string]any{
		"method": "confirmLocalModel", "request_id": "pm-2",
		"confirmation_token": modelToken, "profile_id": profile.ProfileID,
		"port": fmt.Sprintf("%d", port),
		"listener_requirement": map[string]any{
			"allowed_signers":        profile.ListenerRequirement.AllowedSigners,
			"allow_user_pinned_hash": profile.ListenerRequirement.AllowUserPinnedHash,
			"allowed_service_sids":   profile.ListenerRequirement.AllowedServiceSIDs,
		},
		"approved": true,
	})
	if confirmModel["data"].(map[string]any)["binding_hash"] == "" {
		t.Fatalf("the model binding did not confirm: %#v; stderr:\n%s", confirmModel, stderr.String())
	}

	return &runFixture{
		pipe: pipe, dbName: dbName, deviceID: deviceID, sessionID: sessionID,
		journalEpoch: journalEpoch, bootID: bootID, agentID: agentID, grantID: grantID,
		rootDir: rootDir, rootIdentityHash: rootIdentityHash, inputRef: inputRef,
		contentHash: contentHash, byteCount: byteCount, stderr: stderr, cmd: cmd,
		container: container, dir: dir, exeDir: exeDir, profile: profile, port: port,
	}
}

// adminExec runs one statement on an admin connection with the org context set.
func adminExec(t *testing.T, dbName, sql string) {
	t.Helper()
	conn := brokerDB(t, dbName)
	if err := testpg.ExecRaw(context.Background(), conn,
		fmt.Sprintf(`SET app.org_id = '%s'; %s`, testOrg, sql)); err != nil {
		t.Fatal(err)
	}
}

// freeLoopbackPort asks the OS for an unused loopback port (the fixture binds literal 127.0.0.1).
func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := lis.Addr().(*net.TCPAddr).Port
	_ = lis.Close()
	return port
}

// waitFixtureListening polls the fixture's own HTTP answer (a published port is not readiness).
func waitFixtureListening(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("the fixture model never listened on port %d", port)
}

// seedFixtureRun seeds the input/snapshot/task/active-run/offered-binding/grant the offer spine needs,
// adapted from the gateway fixtures to the api_test org/subject. The lease + seq=0 checkpoint are NOT
// seeded: acquire_device_lease writes them when the device answers run_ready.
func seedFixtureRun(t *testing.T, dbName, deviceID, sessionID, bootID, grantID, rootIdentityHash,
	profileID, runtimeDigest, toolManifestHash, inputHash string) string {
	t.Helper()
	runID := uuid.NewString()
	taskID := uuid.NewString()
	snapshotID := uuid.NewString()
	inputID := uuid.NewString()
	nonce := uuid.NewString()
	conn := brokerDB(t, dbName)
	script := fmt.Sprintf(`
		SET app.org_id = '%s';
		SET app.subject_id = '%s';
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status)
		VALUES ('%s','%s','%s','ref','%s',1,'text/plain','active');
		INSERT INTO work.capability_snapshot (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		VALUES ('%s','%s','%s','v1','%s',ARRAY['artifact.write'],'{}'::jsonb,'{}'::jsonb,'{}'::jsonb);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, input_id, title)
		VALUES ('%s','%s','%s','open','%s','%s','run');
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, wait_reason, snapshot_id, workflow_id, runtime_version, admission_access_epoch)
		VALUES ('%s','%s','%s',1,'active',NULL,'%s','%s','v1',0);
		UPDATE work.task SET active_run_id = '%s' WHERE id = '%s';
		INSERT INTO work.workspace_grant
			(org_id, id, device_id, session_id, owner_subject_id, boot_id, root_identity_hash,
			 allowed_tools, classification, matched_rule_index, grant_revision, expires_at,
			 state, client_request_id, request_hash)
		VALUES ('%s','%s','%s','%s','%s','%s','%s',
			ARRAY['workspace.list','workspace.read','workspace.search','artifact.write'],
			'local_only',0,1, now() + interval '1 hour','active','req-run-grant','%s');
		INSERT INTO work.device_run_binding
			(org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
			 input_hash, snapshot_hash, profile_id, profile_revision, runtime_digest,
			 tool_manifest_hash, model_version, grant_set, start_nonce, offer_expiry, state)
		VALUES ('%s','%s',1,'%s','%s','%s','ref','%s','%s','%s',1,'%s','%s','m1',
			'[{"grant_id":"%s","grant_revision":1}]'::jsonb,'%s', now() + interval '5 minutes','offered');
	`,
		testOrg, testSubject,
		inputID, testOrg, testSubject, inputHash,
		snapshotID, testOrg, taskID, strings.Repeat("3", 64),
		taskID, testOrg, testSubject, snapshotID, inputID,
		runID, testOrg, taskID, snapshotID, "wf-run-"+runID[:8],
		runID, taskID,
		testOrg, grantID, deviceID, sessionID, testSubject, bootID, rootIdentityHash, strings.Repeat("9", 64),
		testOrg, runID, taskID, deviceID, sessionID, inputHash, strings.Repeat("3", 64),
		profileID, runtimeDigest, toolManifestHash, grantID, nonce)
	if err := testpg.ExecRaw(context.Background(), conn, script); err != nil {
		t.Fatalf("seed fixture run: %v", err)
	}
	return runID
}

// waitForPendingApproval polls for the ask_each approval the device's action_prepare created.
func waitForPendingApproval(t *testing.T, dbName, runID string, stderr *syncBuffer) (approvalID, operationID, paramsHash string, revision int64) {
	t.Helper()
	conn := brokerDB(t, dbName)
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		err := conn.QueryRow(context.Background(), `
			SELECT a.id::text, o.id::text, a.params_hash, a.revision
			FROM work.approval a
			JOIN work.approval_operation ao ON ao.approval_id = a.id AND ao.org_id = a.org_id
			JOIN work.operation o ON o.id = ao.operation_id AND o.org_id = ao.org_id
			WHERE a.org_id = $1 AND o.run_id = $2::uuid AND a.status = 'pending'
			ORDER BY a.created_at LIMIT 1`, testOrg, runID).
			Scan(&approvalID, &operationID, &paramsHash, &revision)
		if err == nil && approvalID != "" {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	dumpRunDiagnostics(t, dbName, runID, stderr)
	t.Fatalf("no pending approval appeared for run %s (the write spine never proposed)", runID)
	return
}

// dumpRunDiagnostics prints the server-side Run state and the Broker stderr to locate a stall.
func dumpRunDiagnostics(t *testing.T, dbName, runID string, stderr *syncBuffer) {
	t.Helper()
	ctx := context.Background()
	conn := brokerDB(t, dbName)
	rows, err := conn.Query(ctx, `
		SELECT 'binding', binding_revision::text, state, runtime_digest FROM work.device_run_binding WHERE org_id=$1 AND run_id=$2::uuid
		UNION ALL SELECT 'lease', fence::text, state, purpose FROM work.execution_lease WHERE org_id=$1 AND run_id=$2::uuid
		UNION ALL SELECT 'checkpoint', checkpoint_seq::text, state, checkpoint_hash FROM work.device_checkpoint WHERE org_id=$1 AND run_id=$2::uuid
		UNION ALL SELECT 'operation', logical_key, state, kind FROM work.operation WHERE org_id=$1 AND run_id=$2::uuid
		UNION ALL SELECT 'run', fence::text, state, COALESCE(wait_reason,'') FROM work.run WHERE org_id=$1 AND id=$2::uuid`,
		testOrg, runID)
	if err == nil {
		for rows.Next() {
			var a, b, c, d string
			_ = rows.Scan(&a, &b, &c, &d)
			t.Logf("DIAG %s: %s / %s / %s", a, b, c, d)
		}
		rows.Close()
	}
	audit, err := conn.Query(ctx, `
		SELECT action, metadata->>'response' FROM work.audit_event
		WHERE org_id=$1 AND metadata->>'run_id'=$2 ORDER BY created_at DESC LIMIT 12`, testOrg, runID)
	if err == nil {
		for audit.Next() {
			var a, r string
			_ = audit.Scan(&a, &r)
			t.Logf("DIAG audit %s: %s", a, r)
		}
		audit.Close()
	}
	t.Logf("DIAG broker stderr:\n%s", stderr.String())
}

// decideFixtureApproval approves the ask_each write through decide_local_approval (the same function
// the REST decision face wraps). The proof's plane/epoch are read from the LIVE device session so they
// match the execution authority the gate checks (0042:2389), not a fabricated Bearer claim.
func decideFixtureApproval(t *testing.T, dbName, sessionID, deviceID, runID, approvalID, operationID, paramsHash string, revision int64) {
	t.Helper()
	ctx := context.Background()
	conn := brokerDB(t, dbName)
	var authPlane string
	var authEpoch int64
	if err := conn.QueryRow(ctx, `
		SELECT auth_plane, auth_epoch FROM work.device_session WHERE org_id = $1 AND id = $2::uuid`,
		testOrg, sessionID).Scan(&authPlane, &authEpoch); err != nil {
		t.Fatalf("read session authority: %v", err)
	}
	var policyEpoch, accessEpoch int64
	if err := conn.QueryRow(ctx, `SELECT effective_epoch FROM work.local_execution_policy WHERE org_id = $1`,
		testOrg).Scan(&policyEpoch); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `SELECT admission_access_epoch FROM work.run WHERE org_id = $1 AND id = $2::uuid`,
		testOrg, runID).Scan(&accessEpoch); err != nil {
		t.Fatal(err)
	}
	proof := fmt.Sprintf(`{"v":1,"org_id":"%s","subject_id":"%s","auth_plane":"%s",
		"auth_epoch":%d,"device_id":"%s","session_id":"%s","approval_id":"%s","operation_id":"%s",
		"params_hash":"%s","expected_revision":%d,"decision":"approved","remember_readonly":false,
		"readonly_scope":null,"readonly_expires_at":null,"policy_epoch":%d,"access_epoch":%d,
		"nonce":"%s","expires_at":"%s","signature":"sha256:%s"}`,
		testOrg, testSubject, authPlane, authEpoch, deviceID, sessionID, approvalID, operationID,
		paramsHash, revision, policyEpoch, accessEpoch,
		"nonce-run-"+uuid.NewString(),
		time.Now().UTC().Add(10*time.Minute).Format(time.RFC3339),
		strings.Repeat("5", 64))
	app, err := testpg.Open(ctx, testpg.AppURL(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = app.Close(ctx) }()
	if err := testpg.ExecRaw(ctx, app,
		fmt.Sprintf(`SET app.org_id = '%s'; SET app.subject_id = '%s'`, testOrg, testSubject)); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err := app.QueryRow(ctx,
		`SELECT work.decide_local_approval($1,$2,$3,$4,$5::uuid,$6,$7::jsonb)`,
		testOrg, testSubject, authPlane, authEpoch, approvalID, "req-run-decide-"+uuid.NewString(), proof,
	).Scan(&raw); err != nil {
		t.Fatalf("decide_local_approval: %v", err)
	}
	var decided map[string]any
	if err := json.Unmarshal(raw, &decided); err != nil {
		t.Fatal(err)
	}
	if decided["decision"] != "approved" {
		t.Fatalf("decision = %#v, want approved", decided)
	}
}

// waitForCompletedReceipt polls for the server-side completed receipt the write uplinked.
func waitForCompletedReceipt(t *testing.T, dbName, operationID string) {
	t.Helper()
	conn := brokerDB(t, dbName)
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		var state string
		err := conn.QueryRow(context.Background(), `
			SELECT state FROM work.device_receipt
			WHERE org_id = $1 AND operation_id = $2::uuid AND state = 'completed'`,
			testOrg, operationID).Scan(&state)
		if err == nil && state == "completed" {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("no completed receipt for operation %s (the command never executed)", operationID)
}

// TestDeviceFixtureRunCancelStopsSidecarAndAcks is the ruling-④ cancel evidence (闭合批1 延后取证):
// a gateway-driven real exe receives a cancel downlink, kills the sidecar Job tree and uplinks a
// signed cancel_ack stop fact the server records (acknowledge_device_cancel). The write approval is
// left UNDECIDED so the sidecar stays alive awaiting the command — the cancel window.
func TestDeviceFixtureRunCancelStopsSidecarAndAcks(t *testing.T) {
	bin := requireBrokerBin(t)
	f := startFixtureBroker(t, bin)
	runID := seedFixtureRun(t, f.dbName, f.deviceID, f.sessionID, f.bootID, f.grantID, f.rootIdentityHash,
		f.profile.ProfileID, f.profile.RuntimeDigest, f.profile.ToolManifestHash, strings.Repeat("2", 64))
	_, operationID, _, _ := waitForPendingApproval(t, f.dbName, runID, f.stderr)
	pid := sidecarPid(t, f.stderr)

	// request_cancel's durable fact: run.state=cancel_requested + a control_revision bump. The 0056
	// getter lists it and the gateway re-pushes the cancel on the next heartbeat (≤10s cadence).
	adminExec(t, f.dbName, fmt.Sprintf(
		`UPDATE work.run SET state='cancel_requested', control_revision=control_revision+1 WHERE org_id='%s' AND id='%s'::uuid`,
		testOrg, runID))

	// The device kills the sidecar then signs the stop fact; the server records the acknowledgement.
	waitForCancelAck(t, f.dbName, runID)
	waitForProcessDead(t, pid)
	// The in-flight write operation is settled by the stop fact (never left dispatching).
	var opState string
	if err := brokerDB(t, f.dbName).QueryRow(context.Background(),
		`SELECT state FROM work.operation WHERE org_id=$1 AND id=$2::uuid`, testOrg, operationID).Scan(&opState); err != nil {
		t.Fatalf("read canceled operation: %v", err)
	}
	if opState != "canceled" {
		t.Fatalf("canceled operation state = %s, want canceled; stderr:\n%s", opState, f.stderr.String())
	}
}

// TestDeviceFixtureRunLeaseLossKillsSidecar is the ruling-④ lease evidence (闭合批1 延后取证): when the
// lease becomes unrenewable the link invalidates every lease the session owned (SessionLost) and the
// sync core kills the sidecar Job tree (E7 甲). Revoking the device makes the next heartbeat renewal
// refuse (device_revoked), ending the session — the lease-loss trigger.
func TestDeviceFixtureRunLeaseLossKillsSidecar(t *testing.T) {
	bin := requireBrokerBin(t)
	f := startFixtureBroker(t, bin)
	runID := seedFixtureRun(t, f.dbName, f.deviceID, f.sessionID, f.bootID, f.grantID, f.rootIdentityHash,
		f.profile.ProfileID, f.profile.RuntimeDigest, f.profile.ToolManifestHash, strings.Repeat("2", 64))
	waitForPendingApproval(t, f.dbName, runID, f.stderr)
	pid := sidecarPid(t, f.stderr)

	// A revoked device's renewal refuses; the session ends and the link invalidates its leases.
	adminExec(t, f.dbName, fmt.Sprintf(
		`UPDATE work.device SET status='revoked', revoked_at=now() WHERE org_id='%s' AND id='%s'::uuid`, testOrg, f.deviceID))

	waitForLeaseKill(t, f.stderr)
	waitForProcessDead(t, pid)
}

// sidecarPid parses the Broker's operational "sidecar spawned pid=N" line (polling until the sidecar
// starts). The pid is the Job kill-on-close target the cancel/lease evidence checks for death.
func sidecarPid(t *testing.T, stderr *syncBuffer) int {
	t.Helper()
	const marker = "sidecar spawned pid="
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		s := stderr.String()
		if idx := strings.Index(s, marker); idx >= 0 {
			rest := s[idx+len(marker):]
			end := strings.IndexAny(rest, " \r\n")
			if end < 0 {
				end = len(rest)
			}
			if pid, err := strconv.Atoi(rest[:end]); err == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("the Broker never spawned a sidecar; stderr:\n%s", stderr.String())
	return 0
}

// waitForProcessDead polls until the sidecar pid is gone (the Job Object kill-on-close terminated it).
func waitForProcessDead(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		out, _ := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/NH", "/FO", "CSV").CombinedOutput()
		if !strings.Contains(string(out), fmt.Sprintf("\"%d\"", pid)) {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("sidecar pid %d is still alive (the Job kill-on-close never terminated it)", pid)
}

// waitForCancelAck polls for the server-side cancel acknowledgement stop fact (acknowledge_device_cancel
// writes the device_cancel.acknowledged audit with stopped_or_unknown). The device reads 'stopped' from
// the lifecycle state AFTER killing the sidecar, so a recorded 'stopped' is the kill+ack proof.
func waitForCancelAck(t *testing.T, dbName, runID string) {
	t.Helper()
	conn := brokerDB(t, dbName)
	deadline := time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		var stopped string
		err := conn.QueryRow(context.Background(), `
			SELECT metadata->>'stopped_or_unknown' FROM work.audit_event
			WHERE org_id=$1 AND action='device_cancel.acknowledged' AND target_type='run' AND target_id=$2
			ORDER BY created_at DESC LIMIT 1`, testOrg, runID).Scan(&stopped)
		if err == nil && stopped == "stopped" {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("no recorded cancel_ack stop fact for run %s (the device never killed+acked)", runID)
}

// waitForLeaseKill polls the Broker stderr for the lease-invalidation kill line (the sync core's
// LeasesInvalidated handler logs "sidecar killed" after closing the Job Object).
func waitForLeaseKill(t *testing.T, stderr *syncBuffer) {
	t.Helper()
	deadline := time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		s := stderr.String()
		if strings.Contains(s, "leases invalidated") && strings.Contains(s, "sidecar killed") {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("the Broker never invalidated leases / killed the sidecar; stderr:\n%s", stderr.String())
}
