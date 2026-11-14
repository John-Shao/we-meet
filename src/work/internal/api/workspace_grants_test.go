package api_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

// activateDeviceSession plays the device hello (device-design §2.2) directly over
// the work_worker connection: it consumes the single-use ticket minted by the
// owner Bearer face and returns the active session_id the grant face requires.
// The hello itself is the device wire protocol, not a §1.4 REST endpoint.
func activateDeviceSession(t *testing.T, dbName, deviceID, ticket string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.WorkerURL(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', $1, false)`, testOrg); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(ticket))
	ticketHash := hex.EncodeToString(sum[:])
	hello := `{"boot_id":"boot-1","agent_instance_id":"` + guardFixtureUUID +
		`","journal_epoch":"` + guardFixtureUUID + `","runtime_digest":"` +
		strings.Repeat("a", 64) + `","protocol_major":1,"protocol_minor":0}`
	var raw []byte
	if err := conn.QueryRow(ctx,
		`SELECT work.activate_device_session($1, $2::uuid, $3, $4::jsonb)`,
		testOrg, deviceID, ticketHash, hello).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var session map[string]any
	if err := json.Unmarshal(raw, &session); err != nil {
		t.Fatal(err)
	}
	sessionID, _ := session["session_id"].(string)
	if sessionID == "" {
		t.Fatalf("hello returned no session_id: %s", raw)
	}
	return sessionID
}

// pairConfirmMint walks the batch-one device face over HTTP and returns the active
// device id plus a fresh single-use session ticket.
func pairConfirmMint(t *testing.T, serverURL, suffix string) (string, string) {
	t.Helper()
	pairBody := `{"client_request_id":"pair-` + suffix + `","device_name":"desk","platform":"windows-x64","public_key_jwk":` + deviceTestJWK + `}`
	pairing := decodeObject(t, deviceRequest(t, http.MethodPost, serverURL+api.DevicePairingsPath, pairBody))
	deviceID, _ := pairing["device_id"].(string)
	challenge, _ := pairing["challenge"].(string)
	confirmPath := strings.ReplaceAll(api.DevicePairingConfirmPath, "{pairingId}", pairing["pairing_id"].(string))
	confirmBody := `{"client_request_id":"confirm-` + suffix + `","challenge":"` + challenge + `","signature":"sha256:` + strings.Repeat("a", 64) + `"}`
	deviceRequest(t, http.MethodPost, serverURL+confirmPath, confirmBody)
	ticketPath := strings.ReplaceAll(api.DeviceSessionTicketsPath, "{deviceId}", deviceID)
	ticketBody := `{"client_request_id":"ticket-` + suffix + `","public_key_thumbprint":"` + pairing["public_key_thumbprint"].(string) + `"}`
	ticket := decodeObject(t, deviceRequest(t, http.MethodPost, serverURL+ticketPath, ticketBody))
	return deviceID, ticket["ticket"].(string)
}

func TestWorkspaceGrantLifecycle(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)

	deviceID, ticket := pairConfirmMint(t, server.URL, "g1")
	sessionID := activateDeviceSession(t, dbName, deviceID, ticket)

	grantBody := `{"device_id":"` + deviceID + `","session_id":"` + sessionID +
		`","client_request_id":"grant-0001","grant":{"root_identity_hash":"` + strings.Repeat("d", 64) +
		`","allowed_tools":["workspace.list","workspace.read"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}}`
	response := deviceRequest(t, http.MethodPost, server.URL+api.WorkspaceGrantsPath, grantBody)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("register status = %d body=%s", response.StatusCode, readBody(response))
	}
	grant := decodeObject(t, response)
	grantID, _ := grant["grant_id"].(string)
	// The classification comes from the organization's mapping (rule 0 is local_only),
	// not from anything the device claimed.
	if grant["classification"] != "local_only" || grant["state"] != "active" || grantID == "" {
		t.Fatalf("grant = %#v", grant)
	}

	response = deviceRequest(t, http.MethodGet, server.URL+api.WorkspaceGrantsPath+"?device_id="+deviceID, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d body=%s", response.StatusCode, readBody(response))
	}
	items, _ := decodeObject(t, response)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %#v, want one grant", items)
	}

	revokePath := strings.ReplaceAll(api.WorkspaceGrantRevokePath, "{grantId}", grantID)
	response = deviceRequest(t, http.MethodPost, server.URL+revokePath, `{"client_request_id":"revoke-grant-0001","reason":"rotated"}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("revoke status = %d body=%s", response.StatusCode, readBody(response))
	}
	if revoked := decodeObject(t, response); revoked["state"] != "revoked" || revoked["grant_id"] != grantID {
		t.Fatalf("revoke = %#v", revoked)
	}
}

func TestWorkspaceGrantClassificationFloor(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)

	deviceID, ticket := pairConfirmMint(t, server.URL, "g2")
	sessionID := activateDeviceSession(t, dbName, deviceID, ticket)

	// Rule 0 is local_only; claiming the looser remote_excerpt_allowed is below the
	// server's determination and must be refused with the public 409 floor code.
	grantBody := `{"device_id":"` + deviceID + `","session_id":"` + sessionID +
		`","client_request_id":"grant-0002","grant":{"root_identity_hash":"` + strings.Repeat("e", 64) +
		`","allowed_tools":["workspace.list"],"matched_rule_index":0,"classification_claimed":"remote_excerpt_allowed"}}`
	response := deviceRequest(t, http.MethodPost, server.URL+api.WorkspaceGrantsPath, grantBody)
	assertAPICode(t, response, http.StatusConflict, "classification_floor_required")
}

func TestWorkspaceGrantRequiresActiveSession(t *testing.T) {
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)

	deviceID, _ := pairConfirmMint(t, server.URL, "g3")
	// No hello: a random session id is not an active session of this device, so the
	// SQL refuses before any grant is written.
	grantBody := `{"device_id":"` + deviceID + `","session_id":"` + guardFixtureUUID +
		`","client_request_id":"grant-0003","grant":{"root_identity_hash":"` + strings.Repeat("f", 64) +
		`","allowed_tools":["workspace.list"],"matched_rule_index":0}}`
	response := deviceRequest(t, http.MethodPost, server.URL+api.WorkspaceGrantsPath, grantBody)
	assertAPICode(t, response, http.StatusUnauthorized, "unauthorized")
}