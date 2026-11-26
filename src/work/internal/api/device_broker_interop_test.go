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
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
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
//	-> a near-expiry leaf opens the Broker's OWN last-hour window
//	-> (M2b) the process is killed and a fresh one re-delivers the stored chain with the org
//	   declared explicitly, then dials a new session under the SAME journal epoch.
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
	csrf, err := api.NewCSRF([]byte(strings.Repeat("s", 32)), time.Hour, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	apiServer, err := api.NewServer(pool, &stubVerifier{claims: testClaims()}, csrf, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	apiServer.SetBearerVerifier(&stubBearerVerifier{claims: testClaims()})
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
	// Execution-face batch 1b: the Broker owns the journal epoch. The config gives a base directory;
	// the Broker forms <journal_dir>/<device_id>.db once the certificate reveals the device id, and
	// hello carries the journal's own epoch (device_meta). The test reads that epoch back from the
	// session row and asserts it stays stable across a restart (the journal is recovered, not rebuilt).
	journalDir := filepath.Join(dir, "journal")
	config := map[string]any{
		"pipe_name": pipeName,
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
		"journal_dir":        journalDir,
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

	sessionID, journalEpoch := waitForBrokerSession(t, dbName, deviceID, bootID, agentID)
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
	if rowBoot != bootID || rowAgent != agentID || rowState != "active" {
		t.Fatalf("session identity = %q/%q/%q, config gave %q/%q",
			rowBoot, rowAgent, rowState, bootID, agentID)
	}
	// The epoch is the journal's own (device_meta), not a config string: it must be a valid uuid
	// and equal the value read back when the session was first observed.
	if _, err := uuid.Parse(rowEpoch); err != nil || rowEpoch != journalEpoch {
		t.Fatalf("session journal_epoch = %q (discovered %q), want a stable uuid from the journal", rowEpoch, journalEpoch)
	}
	if got := ticketState(t, dbName, ticketRowID); got != "consumed" {
		t.Fatalf("ticket state = %s, want consumed", got)
	}

	// The real shell→Broker→REST grant acquisition chain: prepare binds the actual root and
	// returns its identity plus the Broker's current session; REST issues the grant id; confirm
	// registers that same id against the held root handle. The renderer never supplies a path.
	workspaceRoot := t.TempDir()
	prepared := brokerCall(t, pipe, map[string]any{
		"method": "chooseWorkspace", "request_id": "workspace-prepare",
		"selected_path": workspaceRoot,
	})
	if prepared["result"] != "accepted" {
		t.Fatalf("workspace prepare refused: %#v; broker stderr:\n%s", prepared, stderr.String())
	}
	preparedData := prepared["data"].(map[string]any)
	rootHash, _ := preparedData["root_identity_hash"].(string)
	if !strings.HasPrefix(rootHash, "sha256:") || len(rootHash) != 71 ||
		preparedData["device_id"] != deviceID || preparedData["session_id"] != sessionID {
		t.Fatalf("workspace prepare facts = %#v", preparedData)
	}
	grantBody := fmt.Sprintf(`{"device_id":%q,"session_id":%q,"client_request_id":"gw21-grant","grant":{"root_identity_hash":%q,"allowed_tools":["workspace.list","workspace.read","workspace.search","artifact.write"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}}`,
		deviceID, sessionID, strings.TrimPrefix(rootHash, "sha256:"))
	registered := decodeObject(t, deviceRequest(t, http.MethodPost, rest.URL+api.WorkspaceGrantsPath, grantBody))
	grantID, _ := registered["grant_id"].(string)
	if grantID == "" || registered["state"] != "active" {
		t.Fatalf("workspace grant registration = %#v", registered)
	}
	workspaceConfirmed := brokerCall(t, pipe, map[string]any{
		"method": "confirmWorkspaceRoot", "request_id": "workspace-confirm",
		"confirmation_token": preparedData["confirmation_token"], "grant_id": grantID,
		"artifact_dir": []string{"WeMeet成果"}, "approved": true,
	})
	if workspaceConfirmed["result"] != "accepted" {
		t.Fatalf("workspace confirm refused: %#v; broker stderr:\n%s", workspaceConfirmed, stderr.String())
	}
	confirmedData := workspaceConfirmed["data"].(map[string]any)
	if confirmedData["grant_id"] != grantID || confirmedData["root_identity_hash"] != rootHash {
		t.Fatalf("workspace confirm facts = %#v", confirmedData)
	}
	listed := brokerCall(t, pipe, map[string]any{
		"method": "listWorkspaceGrants", "request_id": "workspace-list",
	})
	listedData := listed["data"].(map[string]any)
	grants, _ := listedData["grants"].([]any)
	if listed["result"] != "accepted" || len(grants) != 1 {
		t.Fatalf("workspace grant list = %#v", listed)
	}
	listedGrant := grants[0].(map[string]any)
	if len(listedGrant) != 3 || listedGrant["grant_id"] != grantID ||
		listedGrant["root_identity_hash"] != rootHash {
		t.Fatalf("workspace grant metadata is not closed: %#v", listedGrant)
	}

	// The real local submission proof path: stage the Composer bytes, approve natively, then let
	// the Broker bind the current session/input/grant/profile facts and sign local_intent over the
	// pipe. Go independently parses and verifies the exact document the device returned.
	staged := brokerCall(t, pipe, map[string]any{
		"method": "stageLocalInput", "request_id": "local-input-stage",
		"text": "local submission body",
	})
	stagedData := staged["data"].(map[string]any)
	inputRef, _ := stagedData["local_input_ref"].(string)
	inputHash, _ := stagedData["content_hash"].(string)
	inputBytes, err := strconv.ParseInt(fmt.Sprint(stagedData["byte_count"]), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if inputRef == "" || !strings.HasPrefix(inputHash, "sha256:") {
		t.Fatalf("staged local input = %#v", stagedData)
	}
	targetSelection := map[string]any{
		"kind": "local", "profile_id": "profile-1", "profile_revision": "0",
		"profile_hash": strings.Repeat("e", 64), "device_id": deviceID, "session_id": sessionID,
		"workspace_grants": []any{map[string]any{"grant_id": grantID, "grant_revision": "1"}},
		"runtime_digest":   strings.Repeat("b", 64), "tool_manifest_hash": strings.Repeat("a", 64),
		"model_version": "deferred",
	}
	previewRequest := map[string]any{
		"client_request_id": "gw21-local-preview",
		"input_ref":         inputRef,
		"input_hash":        strings.TrimPrefix(inputHash, "sha256:"),
		"input_bytes":       inputBytes,
		"target_selection":  targetSelection,
		"template_id":       "summary", "template_version": 1,
		"permission_mode": "ask_each", "output_format": "text/markdown",
	}
	previewBody, err := json.Marshal(previewRequest)
	if err != nil {
		t.Fatal(err)
	}
	preview := decodeObject(t, deviceRequest(t, http.MethodPost, rest.URL+api.LocalTaskPreviewsPath, string(previewBody)))
	previewHash, _ := preview["preview_hash"].(string)
	targetHash, _ := preview["target_selection_hash"].(string)
	if previewHash == "" || len(targetHash) != 64 || preview["input_hash"] != strings.TrimPrefix(inputHash, "sha256:") ||
		preview["input_bytes"] != float64(inputBytes) || preview["output_location"] != "device_local" || preview["permission_mode"] != "ask_each" {
		t.Fatalf("local preview = %#v", preview)
	}
	staleTarget := make(map[string]any, len(targetSelection))
	for key, value := range targetSelection {
		staleTarget[key] = value
	}
	staleTarget["workspace_grants"] = []any{map[string]any{"grant_id": grantID, "grant_revision": "2"}}
	stalePreviewRequest := make(map[string]any, len(previewRequest))
	for key, value := range previewRequest {
		stalePreviewRequest[key] = value
	}
	stalePreviewRequest["target_selection"] = staleTarget
	stalePreviewBody, _ := json.Marshal(stalePreviewRequest)
	stalePreview := deviceRequest(t, http.MethodPost, rest.URL+api.LocalTaskPreviewsPath, string(stalePreviewBody))
	if stalePreview.StatusCode != http.StatusConflict {
		t.Fatalf("stale grant preview status = %d body=%s", stalePreview.StatusCode, readBody(stalePreview))
	}
	var submissionEpoch int64
	if err := brokerDB(t, dbName).QueryRow(context.Background(),
		`SELECT auth_epoch FROM work.device_session WHERE org_id = $1 AND id = $2::uuid`,
		testOrg, sessionID).Scan(&submissionEpoch); err != nil {
		t.Fatal(err)
	}
	submission := brokerCall(t, pipe, map[string]any{
		"method": "confirmLocalSubmission", "request_id": "local-submit-confirm",
		"approved": true, "client_request_id": "gw21-local-submit",
		"input_ref": inputRef, "input_hash": strings.TrimPrefix(inputHash, "sha256:"),
		"preview_hash": previewHash, "target_selection_hash": targetHash,
		"selected_grant_ids": []string{grantID}, "grant_revisions": []string{"1"},
		"profile_id": "profile-1", "profile_revision": "0", "profile_hash": strings.Repeat("e", 64),
		"auth_epoch": strconv.FormatInt(submissionEpoch, 10),
	})
	if submission["result"] != "accepted" {
		t.Fatalf("local submission refused: %#v; broker stderr:\n%s", submission, stderr.String())
	}
	submissionData := submission["data"].(map[string]any)
	if submissionData["status"] != "ready" {
		t.Fatalf("local submission facts = %#v", submissionData)
	}
	intent := submissionData["local_intent"].(map[string]any)
	if len(intent) != 19 || intent["request_id"] != "gw21-local-submit" ||
		intent["device_id"] != deviceID || intent["session_id"] != sessionID ||
		intent["org_id"] != testOrg || intent["subject_id"] != testSubject ||
		intent["input_hash"] != strings.TrimPrefix(inputHash, "sha256:") ||
		intent["auth_epoch"] != strconv.FormatInt(submissionEpoch, 10) {
		t.Fatalf("Broker local_intent = %#v", intent)
	}
	intentJSON, err := json.Marshal(intent)
	if err != nil {
		t.Fatal(err)
	}
	parsedIntent, err := devicesig.ParseLocalIntentProof(intentJSON)
	if err != nil {
		t.Fatalf("ParseLocalIntentProof: %v", err)
	}
	if !devicesig.VerifyLocalIntent(pub, intentJSON) {
		t.Fatal("the real Broker local_intent signature did not verify")
	}
	if parsedIntent.RequestID != "gw21-local-submit" || parsedIntent.SessionID != sessionID {
		t.Fatalf("parsed local_intent = %#v", parsedIntent)
	}
	submitBody, err := json.Marshal(map[string]any{
		"client_request_id": "gw21-local-submit",
		"input_ref":         inputRef, "input_hash": strings.TrimPrefix(inputHash, "sha256:"),
		"input_bytes": inputBytes, "preview_hash": previewHash,
		"target_selection_hash": targetHash, "target_selection": targetSelection,
		"title": "本机提交互操作", "local_intent": intent,
	})
	if err != nil {
		t.Fatal(err)
	}
	submitResponse := deviceRequest(t, http.MethodPost, rest.URL+api.LocalTasksPath, string(submitBody))
	if submitResponse.StatusCode != http.StatusAccepted {
		t.Fatalf("local task submit status = %d body=%s", submitResponse.StatusCode, readBody(submitResponse))
	}
	submitted := decodeObject(t, submitResponse)
	taskID, _ := submitted["task_id"].(string)
	runID, _ := submitted["run_id"].(string)
	if taskID == "" || runID == "" || submitted["binding_revision"] != float64(1) {
		t.Fatalf("local task submit = %#v", submitted)
	}
	var taskState, runState, bindingState, bindingInput string
	if err := brokerDB(t, dbName).QueryRow(context.Background(), `
		SELECT t.state, r.state, b.state, b.input_ref
		FROM work.task t
		JOIN work.run r ON r.task_id = t.id AND r.org_id = t.org_id
		JOIN work.device_run_binding b ON b.run_id = r.id AND b.org_id = r.org_id
		WHERE t.org_id = $1 AND t.id = $2::uuid AND r.id = $3::uuid`,
		testOrg, taskID, runID).Scan(&taskState, &runState, &bindingState, &bindingInput); err != nil {
		t.Fatal(err)
	}
	if taskState != "open" || runState != "queued" || bindingState != "offered" || bindingInput != inputRef {
		t.Fatalf("local submit server truth = task %s run %s binding %s input %s",
			taskState, runState, bindingState, bindingInput)
	}
	var cloudOutbox, intentRows int
	if err := brokerDB(t, dbName).QueryRow(context.Background(), `
		SELECT (SELECT count(*) FROM work.outbox WHERE org_id = $1 AND aggregate_id = $2::uuid
		          AND payload->>'kind' = 'start_workflow'),
		       (SELECT count(*) FROM work.local_submission_intent WHERE org_id = $1 AND task_id = $3::uuid)`,
		testOrg, runID, taskID).Scan(&cloudOutbox, &intentRows); err != nil {
		t.Fatal(err)
	}
	if cloudOutbox != 0 || intentRows != 1 {
		t.Fatalf("local submit outbox/intent rows = %d/%d, want 0/1", cloudOutbox, intentRows)
	}
	replayResponse := deviceRequest(t, http.MethodPost, rest.URL+api.LocalTasksPath, string(submitBody))
	replayed := decodeObject(t, replayResponse)
	if replayResponse.StatusCode != http.StatusAccepted || replayed["task_id"] != taskID ||
		replayed["run_id"] != runID || replayed["binding_revision"] != float64(1) {
		t.Fatalf("local submit replay = status %d body %#v", replayResponse.StatusCode, replayed)
	}
	nonceReplayIntent := make(map[string]any, len(intent))
	for key, value := range intent {
		nonceReplayIntent[key] = value
	}
	nonceReplayIntent["request_id"] = "gw21-local-submit-nonce-replay"
	nonceReplayIntent["input_hash"] = strings.Repeat("9", 64)
	nonceReplayJSON, _ := json.Marshal(nonceReplayIntent)
	nonceReplayTarget, _ := json.Marshal(targetSelection)
	nonceReplayInput := uuid.NewString()
	admin, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	tx, err := admin.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(context.Background(), `SET ROLE work_api`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(context.Background(),
		`SELECT set_config('app.org_id', $1, true), set_config('app.subject_id', $2, true)`,
		testOrg, testSubject); err != nil {
		t.Fatal(err)
	}
	var replayTask, replayRun string
	var replayRevision, replayBinding int64
	nonceReplayErr := tx.QueryRow(context.Background(), `
		SELECT task_id, run_id, revision, binding_revision
		FROM work.submit_local_task($1, $2, $3, $4, $5::uuid, $6, $7, $8, $9::timestamptz,
		  $10, $11, $12, $13::jsonb, $14::text[], $15::jsonb, $16::jsonb, $17::jsonb)`,
		testOrg, testSubject, submissionEpoch, "gw21-local-submit-nonce-replay",
		nonceReplayInput, strings.Repeat("9", 64), int64(1), previewHash, time.Now().Add(time.Hour), targetHash,
		"nonce replay", "ask_each", `{}`, []string{"model_call"},
		`{"provider":"device_local","model":"deferred"}`, string(nonceReplayTarget), string(nonceReplayJSON),
	).Scan(&replayTask, &replayRun, &replayRevision, &replayBinding)
	if nonceReplayErr == nil || !strings.Contains(nonceReplayErr.Error(), "unauthorized") {
		t.Fatalf("nonce replay error = %v, want closed unauthorized rollback", nonceReplayErr)
	}
	var rollbackDedup, rollbackInput, rollbackIntents int
	if err := brokerDB(t, dbName).QueryRow(context.Background(), `
		SELECT (SELECT count(*) FROM work.submission_dedup WHERE org_id = $1
		          AND client_request_id = 'gw21-local-submit-nonce-replay'),
		       (SELECT count(*) FROM work.input_object WHERE org_id = $1 AND id = $2::uuid),
		       (SELECT count(*) FROM work.local_submission_intent WHERE org_id = $1 AND nonce = $3)`,
		testOrg, nonceReplayInput, intent["nonce"]).Scan(&rollbackDedup, &rollbackInput, &rollbackIntents); err != nil {
		t.Fatal(err)
	}
	if rollbackDedup != 0 || rollbackInput != 0 || rollbackIntents != 1 {
		t.Fatalf("nonce replay rollback truth = dedup/input/intents %d/%d/%d, want 0/0/1",
			rollbackDedup, rollbackInput, rollbackIntents)
	}
	intent["target_selection_hash"] = strings.Repeat("f", 64)
	tamperedIntent, _ := json.Marshal(intent)
	if devicesig.VerifyLocalIntent(pub, tamperedIntent) {
		t.Fatal("a tampered target selection verified")
	}
	var tamperedSubmit map[string]any
	if err := json.Unmarshal(submitBody, &tamperedSubmit); err != nil {
		t.Fatal(err)
	}
	tamperedSubmit["local_intent"] = intent
	tamperedSubmitBody, _ := json.Marshal(tamperedSubmit)
	tamperedResponse := deviceRequest(t, http.MethodPost, rest.URL+api.LocalTasksPath, string(tamperedSubmitBody))
	if tamperedResponse.StatusCode != http.StatusUnauthorized {
		t.Fatalf("tampered local submit status = %d body=%s", tamperedResponse.StatusCode, readBody(tamperedResponse))
	}
	canceledSubmission := brokerCall(t, pipe, map[string]any{
		"method": "confirmLocalSubmission", "request_id": "local-submit-cancel",
		"approved": false, "client_request_id": "gw21-local-submit-cancel",
		"input_ref": inputRef, "input_hash": strings.TrimPrefix(inputHash, "sha256:"),
		"preview_hash": previewHash, "target_selection_hash": targetHash,
		"selected_grant_ids": []string{grantID}, "grant_revisions": []string{"1"},
		"profile_id": "profile-1", "profile_revision": "0", "profile_hash": strings.Repeat("e", 64),
		"auth_epoch": strconv.FormatInt(submissionEpoch, 10),
	})
	if canceledSubmission["result"] != "accepted" || canceledSubmission["data"] != nil {
		t.Fatalf("canceled local submission returned proof data: %#v", canceledSubmission)
	}

	// The real device approval chain: the Broker signs the closed decision proof from the
	// current journal session, then REST verifies it and records the owner's decision.
	approvalID, operationID, approvalRunID := seedLocalApproval(t, dbName, deviceID, grantID)
	var approvalEpoch int64
	if err := brokerDB(t, dbName).QueryRow(context.Background(),
		`SELECT auth_epoch FROM work.device_session WHERE org_id = $1 AND id = $2::uuid`,
		testOrg, sessionID).Scan(&approvalEpoch); err != nil {
		t.Fatal(err)
	}
	preparedApproval := brokerCall(t, pipe, map[string]any{
		"method": "prepareLocalApprovalDecision", "request_id": "approval-prepare",
		"approval_id": approvalID, "operation_id": operationID,
		"params_hash": strings.Repeat("c", 64), "expected_revision": "0",
		"decision": "approved", "remember_readonly": false,
		"readonly_scope": nil, "readonly_expires_at": nil,
		"policy_epoch": "0", "access_epoch": "0",
		"auth_epoch": strconv.FormatInt(approvalEpoch, 10),
	})
	if preparedApproval["result"] != "accepted" {
		t.Fatalf("approval prepare refused: %#v; broker stderr:\n%s", preparedApproval, stderr.String())
	}
	preparedApprovalData := preparedApproval["data"].(map[string]any)
	if preparedApprovalData["status"] != "ready" {
		t.Fatalf("approval prepare facts = %#v", preparedApprovalData)
	}
	decisionProof := preparedApprovalData["approval_decision_proof"].(map[string]any)
	if decisionProof["approval_id"] != approvalID || decisionProof["operation_id"] != operationID ||
		decisionProof["device_id"] != deviceID || decisionProof["session_id"] != sessionID ||
		decisionProof["decision"] != "approved" || decisionProof["remember_readonly"] != false {
		t.Fatalf("Broker approval proof = %#v", decisionProof)
	}
	decisionBody, err := json.Marshal(map[string]any{
		"client_request_id": "gw21-approval-decision",
		"decision":          decisionProof,
	})
	if err != nil {
		t.Fatal(err)
	}
	decisionPath := strings.ReplaceAll(api.ApprovalDecisionPath, "{approvalId}", approvalID)
	decisionResponse := deviceRequest(t, http.MethodPost, rest.URL+decisionPath, string(decisionBody))
	if decisionResponse.StatusCode != http.StatusOK {
		t.Fatalf("approval decision status = %d body=%s", decisionResponse.StatusCode, readBody(decisionResponse))
	}
	decision := decodeObject(t, decisionResponse)
	if decision["approval_id"] != approvalID || decision["operation_id"] != operationID ||
		decision["decision"] != "approved" || decision["run_id"] != approvalRunID ||
		decision["replayed"] != false {
		t.Fatalf("approval decision response = %#v", decision)
	}
	var approvalStatus string
	if err := brokerDB(t, dbName).QueryRow(context.Background(),
		`SELECT status FROM work.approval WHERE org_id = $1 AND id = $2::uuid`,
		testOrg, approvalID).Scan(&approvalStatus); err != nil {
		t.Fatal(err)
	}
	if approvalStatus != "approved" {
		t.Fatalf("server approval status = %s, want approved", approvalStatus)
	}

	// Acquire a second server-issued grant over the same held root, then drive the real
	// shell→Broker→REST succession. The proof's session comes from the Broker, not this test.
	preparedSecond := brokerCall(t, pipe, map[string]any{
		"method": "chooseWorkspace", "request_id": "workspace-prepare-2",
		"selected_path": workspaceRoot,
	})
	if preparedSecond["result"] != "accepted" {
		t.Fatalf("second workspace prepare refused: %#v", preparedSecond)
	}
	preparedSecondData := preparedSecond["data"].(map[string]any)
	newGrantID := registerRebindGrant(t, rest.URL, deviceID, sessionID, "gw21-grant-2",
		strings.TrimPrefix(rootHash, "sha256:"))
	confirmedSecond := brokerCall(t, pipe, map[string]any{
		"method": "confirmWorkspaceRoot", "request_id": "workspace-confirm-2",
		"confirmation_token": preparedSecondData["confirmation_token"], "grant_id": newGrantID,
		"artifact_dir": []string{"WeMeet成果"}, "approved": true,
	})
	if confirmedSecond["result"] != "accepted" {
		t.Fatalf("second workspace confirm refused: %#v", confirmedSecond)
	}
	seedRebindGraph(t, dbName, deviceID, sessionID, grantID)
	var authEpoch int64
	if err := brokerDB(t, dbName).QueryRow(context.Background(),
		`SELECT auth_epoch FROM work.device_session WHERE org_id = $1 AND id = $2::uuid`,
		testOrg, sessionID).Scan(&authEpoch); err != nil {
		t.Fatal(err)
	}
	succession := brokerCall(t, pipe, map[string]any{
		"method": "rebindRunWorkspace", "request_id": "workspace-rebind",
		"run_id": rebindRunID, "old_grant_id": grantID, "new_grant_id": newGrantID,
		"auth_epoch": strconv.FormatInt(authEpoch, 10),
	})
	if succession["result"] != "accepted" {
		t.Fatalf("workspace rebind proof refused: %#v; broker stderr:\n%s", succession, stderr.String())
	}
	rebindBody, err := json.Marshal(map[string]any{
		"client_request_id":      "gw21-rebind",
		"old_grant_id":           grantID,
		"new_grant_id":           newGrantID,
		"grant_succession_proof": succession["data"],
	})
	if err != nil {
		t.Fatal(err)
	}
	rebindPath := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
	rebindResponse := deviceRequest(t, http.MethodPost, rest.URL+rebindPath, string(rebindBody))
	if rebindResponse.StatusCode != http.StatusAccepted {
		t.Fatalf("workspace rebind status = %d body=%s", rebindResponse.StatusCode, readBody(rebindResponse))
	}
	rebound := decodeObject(t, rebindResponse)
	if rebound["state"] != "active" || rebound["binding_revision"] != float64(2) ||
		rebound["old_grant_id"] != grantID || rebound["new_grant_id"] != newGrantID {
		t.Fatalf("workspace rebind response = %#v", rebound)
	}
	var bindingRevision int
	var grantSet string
	if err := brokerDB(t, dbName).QueryRow(context.Background(),
		`SELECT binding_revision, grant_set::text FROM work.device_run_binding
		 WHERE org_id = $1 AND run_id = $2 ORDER BY binding_revision DESC LIMIT 1`,
		testOrg, rebindRunID).Scan(&bindingRevision, &grantSet); err != nil {
		t.Fatal(err)
	}
	if bindingRevision != 2 || !strings.Contains(grantSet, newGrantID) || strings.Contains(grantSet, grantID) {
		t.Fatalf("workspace rebind server truth = revision %d grant_set %s", bindingRevision, grantSet)
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

	// Step 9 (M2b): the shell RESTART. Kill the Broker, keep the persisted CNG container, and
	// spawn a fresh process with the same container and journal_dir but a new pipe/boot/agent.
	// The fresh process has no signing history: the signed-org delivery gate must still refuse
	// (no_pairing), while the re-delivery carrier with the org declared explicitly imports the
	// chain the server recorded and dials a new session under the SAME journal epoch (batch 1b:
	// the journal is recovered from <journal_dir>/<device_id>.db, so the epoch is stable).
	_ = pipe.Close()
	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	pipeName2 := `\\.\pipe\work-device-gw21-` + uuid.NewString()
	bootID2 := "boot-" + uuid.NewString()
	agentID2 := uuid.NewString()
	config["pipe_name"] = pipeName2
	config["boot_id"] = bootID2
	config["agent_instance_id"] = agentID2
	raw2, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	configPath2 := filepath.Join(dir, "broker-restart.json")
	if err := os.WriteFile(configPath2, raw2, 0o600); err != nil {
		t.Fatal(err)
	}
	var stderr2 syncBuffer
	cmd2 := exec.Command(bin, configPath2)
	cmd2.Stderr = &stderr2
	if err := cmd2.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd2.Process.Kill()
		_, _ = cmd2.Process.Wait()
	})
	pipe2 := openBrokerPipe(t, pipeName2)
	t.Cleanup(func() { _ = pipe2.Close() })
	hello2 := readBrokerFrame(t, pipe2)
	writeBrokerFrame(t, pipe2, map[string]any{
		"nonce": hello2["nonce"], "protocol_major": 2, "client_kind": "shell",
	})
	// The old carrier keeps its semantics: without a signing history it refuses no_pairing.
	stale := brokerRaw(t, pipe2, map[string]any{
		"method": "deliverDeviceCertificate", "request_id": "cert-r0",
		"device_id": deviceID, "certificate_pem": newPEM,
	})
	if stale["result"] != "refused" || stale["code"] != "no_pairing" {
		t.Fatalf("a fresh Broker accepted a delivery without signing history: %#v", stale)
	}
	// A foreign org declaration fails the CA-signed OU gate and binds nothing.
	foreign := brokerRaw(t, pipe2, map[string]any{
		"method": "redeliverDeviceCertificate", "request_id": "cert-r1",
		"device_id": deviceID, "certificate_pem": newPEM, "org_id": uuid.NewString(), "subject_id": testSubject,
	})
	if foreign["result"] != "refused" || foreign["code"] != "certificate_invalid" {
		t.Fatalf("a re-delivery for another org was not refused: %#v", foreign)
	}
	redelivered := brokerRaw(t, pipe2, map[string]any{
		"method": "redeliverDeviceCertificate", "request_id": "cert-r2",
		"device_id": deviceID, "certificate_pem": newPEM, "org_id": testOrg, "subject_id": testSubject,
	})
	if redelivered["result"] != "accepted" {
		t.Fatalf("restart re-delivery refused: %#v; broker stderr:\n%s", redelivered, stderr2.String())
	}
	if got := redelivered["data"].(map[string]any)["cert_serial"]; got != newSerial {
		t.Fatalf("the re-delivered chain reads serial %v, the server recorded %s", got, newSerial)
	}
	// The re-delivered identity dials: a freshly minted ticket is consumed by a NEW session
	// row carrying the same journal epoch and the restart's boot/agent identity.
	ticketBody2 := fmt.Sprintf(`{"client_request_id":"gw21-ticket-restart","public_key_thumbprint":%q}`, pub.Thumbprint)
	minted2 := decodeObject(t, deviceRequest(t, http.MethodPost, rest.URL+ticketPath, ticketBody2))
	ticket2, _ := minted2["ticket"].(string)
	ticketRowID2, _ := minted2["session_ticket_id"].(string)
	if ticket2 == "" || ticketRowID2 == "" {
		t.Fatalf("restart ticket = %#v", minted2)
	}
	brokerCall(t, pipe2, map[string]any{
		"method": "deliverDeviceSessionTicket", "request_id": "tick-2",
		"device_id": deviceID, "session_ticket_id": ticketRowID2, "ticket": ticket2,
	})
	sessionID2, journalEpoch2 := waitForBrokerSession(t, dbName, deviceID, bootID2, agentID2)
	if sessionID2 == "" {
		t.Fatalf("the restarted Broker never established a session; stderr:\n%s", stderr2.String())
	}
	if sessionID2 == sessionID {
		t.Fatalf("the restart reused the old session row %s", sessionID)
	}
	// Batch 1b: the journal is recovered from <journal_dir>/<device_id>.db, so the epoch is STABLE
	// across the restart even though the session row, boot and agent identity are all new.
	if journalEpoch2 != journalEpoch {
		t.Fatalf("restart changed the journal epoch %q -> %q; the journal must be recovered, not rebuilt", journalEpoch, journalEpoch2)
	}
	if got := ticketState(t, dbName, ticketRowID2); got != "consumed" {
		t.Fatalf("restart ticket state = %s, want consumed", got)
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
	der, err := x509.CreateCertificate(rand.Reader, template, ca.Cert, pub, ca.Signer)
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
		grpc.StreamInterceptor(diagStreamInterceptor(t)),
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

// diagStreamInterceptor logs every received uplink frame type and the terminating stream error when
// WORK_INTEROP_DIAG is set, to locate which frame a real-exe Run uplinks that the gateway refuses.
func diagStreamInterceptor(t *testing.T) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		if os.Getenv("WORK_INTEROP_DIAG") == "" {
			return handler(srv, ss)
		}
		wrapped := &diagStream{ServerStream: ss, t: t}
		err := handler(srv, wrapped)
		t.Logf("DIAG stream %s ended: %v (last recv type=%q body=%s)", info.FullMethod, err, wrapped.lastType, wrapped.lastRaw)
		return err
	}
}

type diagStream struct {
	grpc.ServerStream
	t        *testing.T
	lastType string
	lastRaw  string
}

func (d *diagStream) RecvMsg(m any) error {
	err := d.ServerStream.RecvMsg(m)
	if raw, ok := m.(*[]byte); ok && raw != nil && len(*raw) > 0 {
		var env struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(*raw, &env)
		d.lastType = env.Type
		d.lastRaw = string(*raw)
		d.t.Logf("DIAG recv frame type=%q (%d bytes)", env.Type, len(*raw))
	}
	return err
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

// waitForBrokerSession polls for the active session row this Broker dial created, matched by the
// device and the dial's boot/agent identity. Execution-face batch 1b: the journal epoch is owned by
// the Broker's journal (device_meta), NOT supplied by the config, so it is READ BACK from the row
// here rather than used as a filter — the caller asserts it is a uuid and, across a restart, stable.
func waitForBrokerSession(t *testing.T, dbName, deviceID, bootID, agentID string) (string, string) {
	t.Helper()
	conn := brokerDB(t, dbName)
	deadline := time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		var id, epoch string
		err := conn.QueryRow(context.Background(), `
			SELECT id::text, journal_epoch::text FROM work.device_session
			WHERE org_id = $1 AND device_id = $2::uuid AND state = 'active'
			  AND boot_id = $3 AND agent_instance_id = $4
			ORDER BY created_at DESC LIMIT 1`, testOrg, deviceID, bootID, agentID).Scan(&id, &epoch)
		if err == nil && id != "" {
			return id, epoch
		}
		time.Sleep(200 * time.Millisecond)
	}
	return "", ""
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
