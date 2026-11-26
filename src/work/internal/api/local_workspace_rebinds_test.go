package api_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/testpg"
)

const (
	rebindRunID  = "88888888-8888-4888-8888-888888888888"
	rebindTaskID = "99999999-9999-4999-8999-999999999999"
	rebindRoot   = "8888888888888888888888888888888888888888888888888888888888888888"
)

// registerRebindGrant registers a workspace grant over the Bearer face on the given root.
// Two grants on the same root/device/owner are the precondition a rebind succession needs.
func registerRebindGrant(t *testing.T, serverURL, deviceID, sessionID, requestID, root string) string {
	t.Helper()
	body := `{"device_id":"` + deviceID + `","session_id":"` + sessionID +
		`","client_request_id":"` + requestID + `","grant":{"root_identity_hash":"` + root +
		`","allowed_tools":["workspace.read"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}}`
	grant := decodeObject(t, deviceRequest(t, http.MethodPost, serverURL+api.WorkspaceGrantsPath, body))
	id, _ := grant["grant_id"].(string)
	if id == "" {
		t.Fatalf("grant %s not registered: %#v", requestID, grant)
	}
	return id
}

func pairForeignRebindDevice(t *testing.T, serverURL, dbName string) (string, string, *ecdsa.PrivateKey) {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	jwk := fmt.Sprintf(`{"crv":"P-256","kty":"EC","x":%q,"y":%q}`,
		base64.RawURLEncoding.EncodeToString(privateKey.X.FillBytes(make([]byte, 32))),
		base64.RawURLEncoding.EncodeToString(privateKey.Y.FillBytes(make([]byte, 32))))
	publicKey, err := devicesig.ParseJWK([]byte(jwk))
	if err != nil {
		t.Fatal(err)
	}
	pairing := decodeObject(t, deviceRequest(t, http.MethodPost, serverURL+api.DevicePairingsPath,
		`{"client_request_id":"pair-rb-foreign","device_name":"desk","platform":"windows-x64","public_key_jwk":`+jwk+`}`))
	pairingID, _ := pairing["pairing_id"].(string)
	challenge, _ := pairing["challenge"].(string)
	covered := devicesig.PairingCoveredString(pairingID, challenge, publicKey.Thumbprint, testOrg, testSubject)
	digest := sha256.Sum256([]byte(covered))
	r, s, err := ecdsa.Sign(rand.Reader, privateKey, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	confirmPath := strings.ReplaceAll(api.DevicePairingConfirmPath, "{pairingId}", pairingID)
	deviceRequest(t, http.MethodPost, serverURL+confirmPath,
		`{"client_request_id":"confirm-rb-foreign","challenge":"`+challenge+
			`","signature":"`+base64.RawURLEncoding.EncodeToString(signature)+`"}`)
	deviceID, _ := pairing["device_id"].(string)
	ticketPath := strings.ReplaceAll(api.DeviceSessionTicketsPath, "{deviceId}", deviceID)
	ticket := decodeObject(t, deviceRequest(t, http.MethodPost, serverURL+ticketPath,
		`{"client_request_id":"ticket-rb-foreign","public_key_thumbprint":"`+publicKey.Thumbprint+`"}`))
	return deviceID, activateDeviceSession(t, dbName, deviceID, ticket["ticket"].(string)), privateKey
}

// seedRebindGraph puts a Run in waiting(input) with a device_run_binding whose grant_set
// references the old grant — the state §1.4 row 65 requires before a rebind. The binding is
// inserted directly (it has no BEFORE INSERT guard); the grants come from the HTTP face.
func seedRebindGraph(t *testing.T, dbName, deviceID, sessionID, oldGrantID string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	const (
		snapshotID = "aaaaaaaa-1111-4111-8111-111111111111"
		inputID    = "bbbbbbbb-1111-4111-8111-111111111111"
	)
	script := `
		SET app.org_id = '` + testOrg + `';
		SET app.subject_id = '` + testSubject + `';
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes, media_type, status)
		VALUES ('` + inputID + `', '` + testOrg + `', '` + testSubject + `', 'ref', '` + strings.Repeat("a", 64) + `', 1, 'text/plain', 'active');
		INSERT INTO work.capability_snapshot (id, org_id, task_id, resolver_version, snapshot_hash, tool_allowlist, model_route, scope_caps, manifest)
		VALUES ('` + snapshotID + `', '` + testOrg + `', '` + rebindTaskID + `', 'v1', '` + strings.Repeat("d", 64) + `', ARRAY['workspace.read'], '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, input_id, title)
		VALUES ('` + rebindTaskID + `', '` + testOrg + `', '` + testSubject + `', 'open', '` + snapshotID + `', '` + inputID + `', 'rebind');
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, wait_reason, snapshot_id, workflow_id, runtime_version)
		VALUES ('` + rebindRunID + `', '` + testOrg + `', '` + rebindTaskID + `', 1, 'waiting', 'input', '` + snapshotID + `', 'wf-rebind', 'v1');
		UPDATE work.task SET active_run_id = '` + rebindRunID + `', latest_run_id = '` + rebindRunID + `' WHERE id = '` + rebindTaskID + `';
		INSERT INTO work.device_run_binding
			(org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref, input_hash,
			 snapshot_hash, profile_id, profile_revision, runtime_digest, tool_manifest_hash, model_version,
			 grant_set, start_nonce, offer_expiry, state)
		VALUES ('` + testOrg + `', '` + rebindRunID + `', 1, '` + rebindTaskID + `', '` + deviceID + `', '` + sessionID + `',
			'ref', '` + strings.Repeat("a", 64) + `', '` + strings.Repeat("d", 64) + `', 'p1', 1,
			'` + strings.Repeat("e", 64) + `', '` + strings.Repeat("f", 64) + `', 'm1',
			'[{"grant_id":"` + oldGrantID + `","grant_revision":1}]'::jsonb, gen_random_uuid(), now() + interval '1 hour', 'offered');
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

// grantSuccessionProof signs the closed proof body with the device key.
func grantSuccessionProof(t *testing.T, key *ecdsa.PrivateKey, sessionID, oldGrant, newGrant, root, nonce string) string {
	t.Helper()
	return grantSuccessionProofExpiry(t, key, sessionID, oldGrant, newGrant, root, nonce,
		time.Now().Add(4*time.Minute))
}

func grantSuccessionProofExpiry(t *testing.T, key *ecdsa.PrivateKey, sessionID, oldGrant, newGrant, root, nonce string, expiresAt time.Time) string {
	t.Helper()
	proof := map[string]any{
		"old_grant_id":       oldGrant,
		"new_grant_id":       newGrant,
		"run_id":             rebindRunID,
		"root_identity_hash": root,
		"session_id":         sessionID,
		"auth_plane":         "bearer",
		"auth_epoch":         "4",
		"nonce":              nonce,
		"expires_at":         expiresAt.UTC().Format(time.RFC3339),
	}
	raw, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	preimage, err := devicesig.SignedPayload(devicesig.GrantSuccessionProofType, raw)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := devicesig.SignES256(key, preimage)
	if err != nil {
		t.Fatal(err)
	}
	proof["signature"] = signature
	signed, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	return string(signed)
}

func setupRebind(t *testing.T) (*httptest.Server, string, string, string, string) {
	t.Helper()
	server, deviceID, sessionID, oldGrant, newGrant, _ := setupRebindWithDB(t)
	return server, deviceID, sessionID, oldGrant, newGrant
}

func setupRebindWithDB(t *testing.T) (*httptest.Server, string, string, string, string, string) {
	t.Helper()
	pool, dbName := newBootstrapDB(t, false, false)
	seedDeviceLocalPolicy(t, dbName)
	server := newDeviceServer(t, pool)
	deviceID, ticket := pairConfirmMint(t, server.URL, "rb1")
	sessionID := activateDeviceSession(t, dbName, deviceID, ticket)
	oldGrant := registerRebindGrant(t, server.URL, deviceID, sessionID, "rb-grant-old", rebindRoot)
	newGrant := registerRebindGrant(t, server.URL, deviceID, sessionID, "rb-grant-new", rebindRoot)
	seedRebindGraph(t, dbName, deviceID, sessionID, oldGrant)
	return server, deviceID, sessionID, oldGrant, newGrant, dbName
}

func rebindBody(oldGrant, newGrant, proof, requestID string) string {
	return fmt.Sprintf(`{"client_request_id":%q,"old_grant_id":%q,"new_grant_id":%q,"grant_succession_proof":%s}`,
		requestID, oldGrant, newGrant, proof)
}

func TestWorkspaceRebindCreateAndReplay(t *testing.T) {
	server, _, sessionID, oldGrant, newGrant := setupRebind(t)
	path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
	proof := grantSuccessionProof(t, deviceTestPrivateKey(), sessionID, oldGrant, newGrant, rebindRoot, "nonce-rebind-1")

	response := deviceRequest(t, http.MethodPost, server.URL+path, rebindBody(oldGrant, newGrant, proof, "rebind-0001"))
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("rebind status = %d body=%s", response.StatusCode, readBody(response))
	}
	rebound := decodeObject(t, response)
	if rebound["binding_revision"] != float64(2) || rebound["state"] != "active" ||
		rebound["checkpoint_seq"] != float64(0) ||
		rebound["old_grant_id"] != oldGrant || rebound["new_grant_id"] != newGrant || rebound["replayed"] != false {
		t.Fatalf("rebound = %#v", rebound)
	}

	replay := decodeObject(t, deviceRequest(t, http.MethodPost, server.URL+path, rebindBody(oldGrant, newGrant, proof, "rebind-0001")))
	if replay["replayed"] != true || replay["binding_revision"] != float64(2) {
		t.Fatalf("replay = %#v", replay)
	}
}

func TestWorkspaceRebindIdentityChanged(t *testing.T) {
	server, _, sessionID, oldGrant, newGrant := setupRebind(t)
	path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
	// The proof names a root the new grant does not have: a different directory, so the
	// rebind is refused with the public 409 and the Run can only end.
	proof := grantSuccessionProof(t, deviceTestPrivateKey(), sessionID, oldGrant, newGrant, strings.Repeat("1", 64), "nonce-rebind-2")
	assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path, rebindBody(oldGrant, newGrant, proof, "rebind-0002")),
		http.StatusConflict, "workspace_identity_changed")
}

func TestWorkspaceRebindRejectsForeignRootAndForeignDeviceProof(t *testing.T) {
	assertNoWrites := func(t *testing.T, dbName, oldGrant, newGrant, nonce string) {
		t.Helper()
		ctx := context.Background()
		conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close(ctx)
		var successions, nonces int
		if err := conn.QueryRow(ctx, `
			SELECT (SELECT count(*) FROM work.workspace_grant_succession WHERE org_id = $1 AND run_id = $2),
			       (SELECT count(*) FROM work.consumed_possession_nonce WHERE org_id = $1 AND nonce = $3)`,
			testOrg, rebindRunID, nonce).Scan(&successions, &nonces); err != nil {
			t.Fatal(err)
		}
		if successions != 0 || nonces != 0 {
			t.Fatalf("refused rebind wrote succession=%d nonce=%d", successions, nonces)
		}
		var bindingRevision int
		var grantSet string
		if err := conn.QueryRow(ctx, `
			SELECT binding_revision, grant_set::text FROM work.device_run_binding
			 WHERE org_id = $1 AND run_id = $2 ORDER BY binding_revision DESC LIMIT 1`,
			testOrg, rebindRunID).Scan(&bindingRevision, &grantSet); err != nil {
			t.Fatal(err)
		}
		if bindingRevision != 1 || !strings.Contains(grantSet, oldGrant) || strings.Contains(grantSet, newGrant) {
			t.Fatalf("refused rebind changed binding revision=%d grant_set=%s", bindingRevision, grantSet)
		}
		for _, grantID := range []string{oldGrant, newGrant} {
			var state string
			var revision int
			if err := conn.QueryRow(ctx, `
				SELECT state, revision FROM work.workspace_grant WHERE org_id = $1 AND id = $2`,
				testOrg, grantID).Scan(&state, &revision); err != nil {
				t.Fatal(err)
			}
			if state != "active" || revision != 0 {
				t.Fatalf("refused rebind changed grant %s to %s/%d", grantID, state, revision)
			}
		}
	}

	t.Run("different root", func(t *testing.T) {
		server, deviceID, sessionID, oldGrant, _, dbName := setupRebindWithDB(t)
		otherRoot := strings.Repeat("1", 64)
		newGrant := registerRebindGrant(t, server.URL, deviceID, sessionID, "rb-grant-other-root", otherRoot)
		path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
		nonce := "nonce-rebind-other-root"
		proof := grantSuccessionProof(t, deviceTestPrivateKey(), sessionID, oldGrant, newGrant, otherRoot, nonce)
		assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path,
			rebindBody(oldGrant, newGrant, proof, "rebind-other-root")),
			http.StatusConflict, "workspace_identity_changed")
		assertNoWrites(t, dbName, oldGrant, newGrant, nonce)
	})

	t.Run("foreign device", func(t *testing.T) {
		server, _, _, oldGrant, _, dbName := setupRebindWithDB(t)
		otherDevice, otherSession, otherKey := pairForeignRebindDevice(t, server.URL, dbName)
		newGrant := registerRebindGrant(t, server.URL, otherDevice, otherSession, "rb-grant-other-device", rebindRoot)
		path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
		nonce := "nonce-rebind-other-device"
		proof := grantSuccessionProof(t, otherKey, otherSession, oldGrant, newGrant, rebindRoot, nonce)
		assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path,
			rebindBody(oldGrant, newGrant, proof, "rebind-other-device")),
			http.StatusConflict, "workspace_identity_changed")
		assertNoWrites(t, dbName, oldGrant, newGrant, nonce)
	})
}

func TestWorkspaceRebindRejectsTamperedExpiredAndWrongKeyProofs(t *testing.T) {
	assertNoWrites := func(t *testing.T, dbName, nonce string) {
		t.Helper()
		ctx := context.Background()
		conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close(ctx)
		var successions, nonces int
		if err := conn.QueryRow(ctx, `
			SELECT (SELECT count(*) FROM work.workspace_grant_succession WHERE org_id = $1 AND run_id = $2),
			       (SELECT count(*) FROM work.consumed_possession_nonce WHERE org_id = $1 AND nonce = $3)`,
			testOrg, rebindRunID, nonce).Scan(&successions, &nonces); err != nil {
			t.Fatal(err)
		}
		if successions != 0 || nonces != 0 {
			t.Fatalf("refused proof wrote succession=%d nonce=%d", successions, nonces)
		}
	}

	for _, field := range []string{"session_id", "expires_at"} {
		t.Run(field, func(t *testing.T) {
			server, _, sessionID, oldGrant, newGrant, dbName := setupRebindWithDB(t)
			nonce := "nonce-rebind-tamper-" + field
			proof := grantSuccessionProof(t, deviceTestPrivateKey(), sessionID, oldGrant, newGrant, rebindRoot, nonce)
			var body map[string]any
			if err := json.Unmarshal([]byte(proof), &body); err != nil {
				t.Fatal(err)
			}
			if field == "session_id" {
				body[field] = guardFixtureUUID
			} else {
				body[field] = time.Now().Add(3 * time.Minute).UTC().Format(time.RFC3339)
			}
			tampered, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
			assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path,
				rebindBody(oldGrant, newGrant, string(tampered), "rebind-tamper-"+field)),
				http.StatusUnauthorized, "unauthorized")
			assertNoWrites(t, dbName, nonce)
		})
	}

	t.Run("wrong key", func(t *testing.T) {
		server, _, sessionID, oldGrant, newGrant, dbName := setupRebindWithDB(t)
		otherKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		nonce := "nonce-rebind-wrong-key"
		proof := grantSuccessionProof(t, otherKey, sessionID, oldGrant, newGrant, rebindRoot, nonce)
		path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
		assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path,
			rebindBody(oldGrant, newGrant, proof, "rebind-wrong-key")),
			http.StatusUnauthorized, "unauthorized")
		assertNoWrites(t, dbName, nonce)
	})

	for _, tc := range []struct {
		name      string
		expiresAt time.Time
	}{
		{name: "expired", expiresAt: time.Now().Add(-time.Minute)},
		{name: "too far future", expiresAt: time.Now().Add(6 * time.Minute)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server, _, sessionID, oldGrant, newGrant, dbName := setupRebindWithDB(t)
			nonce := "nonce-rebind-" + strings.ReplaceAll(tc.name, " ", "-")
			proof := grantSuccessionProofExpiry(t, deviceTestPrivateKey(), sessionID, oldGrant, newGrant,
				rebindRoot, nonce, tc.expiresAt)
			path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
			assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path,
				rebindBody(oldGrant, newGrant, proof, "rebind-"+strings.ReplaceAll(tc.name, " ", "-"))),
				http.StatusBadRequest, "invalid_request")
			assertNoWrites(t, dbName, nonce)
		})
	}

	t.Run("unknown field", func(t *testing.T) {
		server, _, sessionID, oldGrant, newGrant, dbName := setupRebindWithDB(t)
		nonce := "nonce-rebind-unknown-field"
		proof := grantSuccessionProof(t, deviceTestPrivateKey(), sessionID, oldGrant, newGrant, rebindRoot, nonce)
		var body map[string]any
		if err := json.Unmarshal([]byte(proof), &body); err != nil {
			t.Fatal(err)
		}
		body["extra"] = "not-in-the-closed-set"
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
		assertAPICode(t, deviceRequest(t, http.MethodPost, server.URL+path,
			rebindBody(oldGrant, newGrant, string(raw), "rebind-unknown-field")),
			http.StatusBadRequest, "invalid_request")
		assertNoWrites(t, dbName, nonce)
	})
}

func TestWorkspaceRebindRequiresBearer(t *testing.T) {
	server, _, _, _, _ := setupRebind(t)
	path := strings.ReplaceAll(api.WorkspaceRebindsPath, "{runId}", rebindRunID)
	csrf := bootstrapCSRF(t, server.URL)
	response := taskRequest(t, http.MethodPost, server.URL+path, csrf, `{"client_request_id":"rebind-0003"}`)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("cookie-plane status = %d, want 401", response.StatusCode)
	}
}
