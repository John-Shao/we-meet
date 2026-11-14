package api_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
)

// possessionProof renders a shape-valid 15-key PossessionProof(purpose=accept) (0045
// possession_proof_valid, control §1.3). Like the other local frames the signature is in
// the HTTP header, not the payload; real verification belongs to M3/M5.
func possessionProof(deviceID, sessionID, taskID, artifactID, versionID, contentHash, requestID, nonce string) string {
	return fmt.Sprintf(`{
		"v":1,"org_id":%q,"subject_id":%q,"auth_plane":"bearer","auth_epoch":4,
		"device_id":%q,"session_id":%q,"task_id":%q,"artifact_id":%q,"version_id":%q,
		"content_hash":%q,"purpose":"accept","request_id":%q,"nonce":%q,
		"expires_at":"2027-01-01T00:00:00Z"}`,
		testOrg, testSubject, deviceID, sessionID, taskID, artifactID, versionID,
		contentHash, requestID, nonce)
}

func setupLocalAcceptance(t *testing.T) (*httptest.Server, string, string, string, string, string, string) {
	t.Helper()
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)
	deviceID, ticket := pairConfirmMint(t, server.URL, "ac1")
	sessionID := activateDeviceSession(t, dbName, deviceID, ticket)
	taskID, artifactID, baseID, baseHash := seedLocalArtifactTask(t, dbName, deviceID, "awaiting_acceptance")
	return server, deviceID, sessionID, taskID, artifactID, baseID, baseHash
}

func acceptanceBody(deviceID, sessionID, artifactID, proof, requestID string, revision int) string {
	return fmt.Sprintf(`{"client_request_id":%q,"revision":%d,"device_id":%q,"session_id":%q,`+
		`"artifact_id":%q,"possession_proof":%s}`, requestID, revision, deviceID, sessionID, artifactID, proof)
}

func TestLocalAcceptanceCreateAndReplay(t *testing.T) {
	server, deviceID, sessionID, taskID, artifactID, baseID, baseHash := setupLocalAcceptance(t)
	path := strings.ReplaceAll(api.LocalTaskAcceptancesPath, "{taskId}", taskID)
	proof := possessionProof(deviceID, sessionID, taskID, artifactID, baseID, baseHash, "accept-0001", "nonce-accept-1")

	response := deviceRequest(t, http.MethodPost, server.URL+path,
		acceptanceBody(deviceID, sessionID, artifactID, proof, "accept-0001", 0))
	if response.StatusCode != http.StatusOK {
		t.Fatalf("accept status = %d body=%s", response.StatusCode, readBody(response))
	}
	accepted := decodeObject(t, response)
	if accepted["revision"] != float64(1) || accepted["version_no"] != float64(1) ||
		accepted["artifact_id"] != artifactID || accepted["replayed"] != false {
		t.Fatalf("accepted = %#v", accepted)
	}

	replay := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+path,
		acceptanceBody(deviceID, sessionID, artifactID, proof, "accept-0001", 0)))
	if replay["replayed"] != true || replay["acceptance_id"] != accepted["acceptance_id"] {
		t.Fatalf("replay = %#v", replay)
	}
}

func TestLocalAcceptanceNonceReuse(t *testing.T) {
	server, deviceID, sessionID, taskID, artifactID, baseID, baseHash := setupLocalAcceptance(t)
	path := strings.ReplaceAll(api.LocalTaskAcceptancesPath, "{taskId}", taskID)
	proof := possessionProof(deviceID, sessionID, taskID, artifactID, baseID, baseHash, "accept-0001", "nonce-accept-1")
	if response := deviceRequest(t, http.MethodPost, server.URL+path,
		acceptanceBody(deviceID, sessionID, artifactID, proof, "accept-0001", 0)); response.StatusCode != http.StatusOK {
		t.Fatalf("first accept status = %d body=%s", response.StatusCode, readBody(response))
	}
	// A different request id reusing the same nonce is refused before the Task gate: the
	// nonce is single-use across the whole organization (0045, control §1.3).
	proof2 := possessionProof(deviceID, sessionID, taskID, artifactID, baseID, baseHash, "accept-0002", "nonce-accept-1")
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path,
		acceptanceBody(deviceID, sessionID, artifactID, proof2, "accept-0002", 0)),
		http.StatusUnauthorized, "unauthorized")
}

func TestLocalAcceptanceWrongHash(t *testing.T) {
	server, deviceID, sessionID, taskID, artifactID, baseID, _ := setupLocalAcceptance(t)
	path := strings.ReplaceAll(api.LocalTaskAcceptancesPath, "{taskId}", taskID)
	// The proof's content_hash disagrees with the published version: the proof does not
	// bind this version, so it is unauthorized rather than accepted.
	proof := possessionProof(deviceID, sessionID, taskID, artifactID, baseID, strings.Repeat("9", 64), "accept-0001", "nonce-accept-1")
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path,
		acceptanceBody(deviceID, sessionID, artifactID, proof, "accept-0001", 0)),
		http.StatusUnauthorized, "unauthorized")
}

func TestLocalAcceptanceRequiresBearer(t *testing.T) {
	server, _, _, taskID, _, _, _ := setupLocalAcceptance(t)
	path := strings.ReplaceAll(api.LocalTaskAcceptancesPath, "{taskId}", taskID)
	csrf := bootstrapCSRF(t, server.URL)
	response := taskRequest(t, http.MethodPost, server.URL+path, csrf, `{"revision":0}`)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("cookie-plane status = %d, want 401", response.StatusCode)
	}
}