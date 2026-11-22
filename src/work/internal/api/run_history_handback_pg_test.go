package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

// Tests for the 0062 read face (execution-face batch 7): the HTTP half of device-design §3.3's
// promise that a run handing its history back reads as "正在交回历史并收尾" and not as a stuck task.
//
// The migrate-side cases (r0b_history_handback_test.go) pin what the projection READS. These pin
// what the browser's Work UI actually gets: the face answers on the cookie-session plane like the
// reconciliations face it sits beside, the document is the function's two keys and nothing else,
// and every refusal keeps §1.4's confidentiality idiom - a malformed id, somebody else's run, and
// a lost seat each answer without confirming anything about the run in question.

const (
	handbackDeviceID  = "23333333-3333-4333-8333-333333333333"
	handbackSessionID = "24444444-4444-4444-8444-444444444444"
	handbackLeaseID   = "25555555-5555-4555-8555-555555555555"
)

// seedHandbackLease puts the run 0062 reads into the state a reconnecting device produces: the
// hand-back lease live on the run. It is seeded rather than minted through the gateway because this
// is the REST-side contract test - the mint's own behaviour is batch 6's evidence and 0061's cases.
// The device and session rows exist because execution_lease FKs both (0040:831-834), and the lease
// row carries start_nonce NULL, which is what purpose='reconcile_finish' requires (0040:822-823).
func seedHandbackLease(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', $1, false)`, testOrg); err != nil {
		t.Fatal(err)
	}
	script := `
		INSERT INTO work.device
		  (org_id, id, owner_subject_id, device_name, platform, public_key_jwk,
		   public_key_thumbprint, auth_plane, auth_epoch, status)
		VALUES ('` + testOrg + "', '" + handbackDeviceID + `', '` + testSubject + `',
		        'fixture desk', 'windows-x64',
		        '{"crv":"P-256","kty":"EC","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}'::jsonb,
		        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		        'bearer', 0, 'active');
		INSERT INTO work.device_session
		  (org_id, id, device_id, owner_subject_id, boot_id, agent_instance_id, auth_plane,
		   auth_epoch, protocol_major, protocol_minor, runtime_digest, journal_epoch, generation,
		   state, expires_at)
		VALUES ('` + testOrg + "', '" + handbackSessionID + "', '" + handbackDeviceID + `',
		        '` + testSubject + `', 'boot-handback', '26666666-6666-4666-8666-666666666666',
		        'bearer', 0, 2, 0, '` + strings.Repeat("6", 64) + `',
		        '27777777-7777-4777-8777-777777777777', 0, 'active', now() + interval '1 hour');
		INSERT INTO work.execution_lease
		  (org_id, id, run_id, device_id, session_id, binding_revision, fence, generation,
		   purpose, expires_at, state)
		VALUES ('` + testOrg + "', '" + handbackLeaseID + "', '" + reconcileRunID + "', '" +
		handbackDeviceID + "', '" + handbackSessionID + `', 1, 1, 0,
		        'reconcile_finish', ` + "now() + interval '30 seconds'" + `, 'active');
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatalf("seeding the hand-back lease failed: %v", err)
	}
}

func handbackURL(serverURL, runID string) string {
	return serverURL + strings.ReplaceAll(api.RunHistoryHandbackPath, "{runId}", runID)
}

func TestRunHistoryHandbackReadFace(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))

	// The ordinary case first: a run with no hand-back lease must read false, because the §3.3
	// sentence replacing "进行中" for every run would be worse than not showing it at all.
	calm := taskRequest(t, http.MethodGet, handbackURL(server.URL, reconcileRunID), "", "")
	if calm.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", calm.StatusCode, readBody(calm))
	}
	doc := decodeObject(t, calm)
	if len(doc) != 2 || doc["run_id"] != reconcileRunID || doc["history_handback"] != false {
		t.Fatalf("document with no hand-back lease = %#v, want exactly {run_id, history_handback:false}", doc)
	}

	// §3.3's sentence must stop the moment the hand-back ends or the lease's window elapses. That
	// second clause - active state, past window - is 0062's own migrate case, where the row can be
	// aged honestly; asserting it again here would only re-test SQL that this layer does not own, so
	// what the HTTP layer pins is the document, the gates and the refusals.
	seedHandbackLease(t, dbName)
	live := taskRequest(t, http.MethodGet, handbackURL(server.URL, reconcileRunID), "", "")
	if live.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body=%s", live.StatusCode, readBody(live))
	}
	doc = decodeObject(t, live)
	if doc["history_handback"] != true {
		t.Fatalf("history_handback = %#v with a live reconcile_finish lease, want true: %#v",
			doc["history_handback"], doc)
	}

	// Refusals, all three in §1.4's shape: an id that is not a UUID, a run under somebody else's
	// task, and no session at all.
	malformed := taskRequest(t, http.MethodGet, handbackURL(server.URL, "not-a-uuid"), "", "")
	assertAPICode(t, malformed, http.StatusNotFound, "run_not_found")
	foreign := taskRequest(t, http.MethodGet, handbackURL(server.URL, otherOwnerRunID), "", "")
	assertAPICode(t, foreign, http.StatusNotFound, "task_not_found")
	anonymous, err := http.Get(handbackURL(server.URL, reconcileRunID))
	if err != nil {
		t.Fatal(err)
	}
	assertAPICode(t, anonymous, http.StatusUnauthorized, "unauthorized")

	// Losing the seat closes this face exactly like the reconciliations face beside it: §1.4's
	// permission column for both rows is owner plus a current seat.
	admin, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(),
		`UPDATE work.member SET work_seat = false WHERE org_id = $1 AND subject_id = $2`,
		testOrg, testSubject); err != nil {
		t.Fatal(err)
	}
	admin.Close(context.Background())
	noSeat := taskRequest(t, http.MethodGet, handbackURL(server.URL, reconcileRunID), "", "")
	assertAPICode(t, noSeat, http.StatusForbidden, "work_seat_required")
}
