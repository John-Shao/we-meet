package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/testpg"
)

// localPolicyColumns is §4.1's writable column set for one organization, spelled with the
// column names §1.4 pins the request and response to.
const localPolicyColumns = `"allowed_tools": ["workspace.read"],
	"allowed_destinations": ["device_local"],
	"classification_rules": [{"matcher": {"path_prefix": "docs"},
	  "classification": "local_only", "max_confirmable": "local_only"}],
	"classification_default": "local_only",
	"classification_default_confirmed": true,
	"classification_floor": "local_only",
	"readonly_max_actions": 3,
	"readonly_ttl": "1 hour",
	"input_limit_bytes": 262144,
	"output_limit_bytes": 262144`

func decodeObject(t *testing.T, response *http.Response) map[string]any {
	t.Helper()
	defer response.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(response.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

func TestAdminLocalPolicyRoundTrip(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := workspaceCSRF(t, server.URL)
	path := server.URL + api.AdminLocalPolicyPath

	// The read face answers before anything is configured, and it carries the gate verdict:
	// §1.2, §1.4 and §8.4 all ask the same question of local_policy_gate, so an operator has
	// to be able to see why pairing refuses without reading the row through psql.
	response := taskRequest(t, http.MethodGet, path, "", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d body=%s", response.StatusCode, readBody(response))
	}
	view := decodeObject(t, response)
	if view["configured"] != false || view["gate"] != "local_policy_not_configured" {
		t.Fatalf("unconfigured view = %#v", view)
	}

	write := taskRequest(t, http.MethodPatch, path, csrf, `{`+localPolicyColumns+`,
		"revision": 0, "client_request_id": "req-local-policy-1"}`)
	if write.StatusCode != http.StatusOK {
		t.Fatalf("PATCH status = %d body=%s", write.StatusCode, readBody(write))
	}
	written := decodeObject(t, write)
	if written["configured"] != true || written["gate"] != "ready" {
		t.Fatalf("after write = %#v, want configured with the gate open", written)
	}
	if written["revision"] != float64(1) {
		t.Fatalf("revision after the first write = %v", written["revision"])
	}
	// One name per fact: the response is the row's own columns, so a renamed or
	// re-presented field would show up here as a missing key rather than as a silent
	// difference between the table and the wire.
	for _, column := range []string{"allowed_tools", "allowed_destinations",
		"classification_rules", "classification_default", "classification_default_confirmed",
		"classification_floor", "readonly_ttl", "readonly_max_actions", "input_limit_bytes",
		"output_limit_bytes", "effective_epoch", "revision", "gate", "configured",
		"org_id"} {
		if _, ok := written[column]; !ok {
			t.Fatalf("the local-policy response is missing %q", column)
		}
	}

	// A retried write with the same expected revision is refused by the CAS rather than
	// replayed: the first write landed, and silently bumping the revision again would
	// bury the fact that the policy moved twice.
	conflict := taskRequest(t, http.MethodPatch, path, csrf, `{`+localPolicyColumns+`,
		"revision": 0, "client_request_id": "req-local-policy-2"}`)
	assertAPICode(t, conflict, http.StatusConflict, "governance_revision_conflict")

	// The closed sets and the rule shape stay in SQL: the wire only fixes the key set, so an
	// unknown field is refused here and a bad value is refused there, never both.
	unknown := taskRequest(t, http.MethodPatch, path, csrf, `{`+localPolicyColumns+`,
		"revision": 1, "client_request_id": "req-local-policy-3", "allow_everything": true}`)
	assertAPICode(t, unknown, http.StatusBadRequest, "invalid_request")
	// A looser ceiling than the determination is the direction §4.1 forbids, and it must be
	// refused by the command, not re-derived in Go.
	looser := taskRequest(t, http.MethodPatch, path, csrf, `{
		"allowed_tools": ["workspace.read"],
		"allowed_destinations": ["device_local"],
		"classification_rules": [{"matcher": {"path_prefix": "docs"},
		  "classification": "local_only", "max_confirmable": "remote_excerpt_allowed"}],
		"classification_default": "local_only",
		"classification_default_confirmed": true,
		"classification_floor": "local_only",
		"readonly_max_actions": 3, "readonly_ttl": "1 hour",
		"input_limit_bytes": 262144, "output_limit_bytes": 262144,
		"revision": 1, "client_request_id": "req-local-policy-4"}`)
	assertAPICode(t, looser, http.StatusBadRequest, "invalid_request")

	// A write without the CSRF token is refused before the domain command runs, so the
	// admin gate is not what answers here.
	noToken := taskRequest(t, http.MethodPatch, path, "", `{`+localPolicyColumns+`,
		"revision": 1, "client_request_id": "req-local-policy-5"}`)
	assertAPICode(t, noToken, http.StatusForbidden, "csrf_invalid")

	// And the gate is the org's administrator, bound to the session subject. Without the
	// assert_org_admin inside these two commands the plain owner-shaped session below would
	// still have been able to write the policy that decides whether local actions leave a
	// device, because work_api already held EXECUTE on both.
	admin, err := testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(),
		`UPDATE work.member SET role = 'viewer' WHERE org_id = $1 AND subject_id = $2`,
		testOrg, testSubject); err != nil {
		t.Fatal(err)
	}
	admin.Close(context.Background())

	nonAdminWrite := taskRequest(t, http.MethodPatch, path, csrf, `{`+localPolicyColumns+`,
		"revision": 1, "client_request_id": "req-local-policy-6"}`)
	assertAPICode(t, nonAdminWrite, http.StatusForbidden, "admin_access_denied")
	nonAdminRead := taskRequest(t, http.MethodGet, path, "", "")
	assertAPICode(t, nonAdminRead, http.StatusForbidden, "admin_access_denied")

	// Both refusals left the row exactly where the first write put it: the CAS and the
	// admin gate are the only things that move this policy, and a refused request must not
	// reach the row at all.
	admin, err = testpg.Open(context.Background(), testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	var revision int
	if err := admin.QueryRow(context.Background(),
		`SELECT revision FROM work.local_execution_policy WHERE org_id = $1`, testOrg).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision != 1 {
		t.Fatalf("revision after refused writes = %d, want 1", revision)
	}
}
