package api_test

import (
	"io"
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/host"
)

// Session and CSRF are enforced per handler, and the feature tests each check the one route they
// happen to exercise. A route added later that forgets authenticate() - or a mutating route that
// forgets verifyCSRF() - is reachable and unguarded, and nothing in the suite would notice,
// because the drift gate only compares the route list against the contract.
//
// So this drives the contract itself: every operation in r0a-openapi-v1.yaml must answer
//
//   - 401 unauthorized with no session cookie at all, and
//   - 403 csrf_invalid for a safe method that carries the session but not the double-submit
//     header, even when the CSRF cookie is present (the cookie alone proves nothing),
//
// before any of them reaches the database. Reading the operations from the contract rather than
// from a list in this file is deliberate: the gate keeps the handler set equal to the contract, so
// the contract is the widest set the handlers can have.

const guardFixtureUUID = "11111111-1111-4111-8111-111111111111"

func guardURL(path string) string {
	return guardURLFor(path)
}

func guardRequest(t *testing.T, serverURL, method, path, cookie string, header string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(method, serverURL+path, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: cookie})
	}
	if header != "" {
		request.Header.Set("X-CSRF-Token", header)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if !strings.Contains(string(body), "\"code\"") {
		t.Fatalf("%s %s: response carries no public error code: status=%d body=%s",
			method, path, response.StatusCode, string(body))
	}
	return response
}

func TestEveryContractOperationEnforcesSessionAndCSRF(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, false)
	server := newHTTPServer(t, pool, &stubVerifier{claims: testClaims()}, testCSRF(t))
	csrf := bootstrapCSRF(t, server.URL)
	ops := registeredRoutes(t)

	var noSession, noCSRF, checked []string
	mutating := 0
	for _, op := range ops {
		path := guardURL(op.path)
		checked = append(checked, op.method+" "+path)

		// 1. No session at all: the route must refuse before anything else, including before it
		// touches the database or parses the body.
		response := guardRequest(t, server.URL, op.method, path, "", "")
		if response.StatusCode != http.StatusUnauthorized {
			noSession = append(noSession, op.method+" "+path+"="+http.StatusText(response.StatusCode))
		}

		// 2. Session present, double-submit missing. The CSRF cookie alone must not be enough.
		if op.method == http.MethodGet {
			continue
		}
		mutating++
		request, err := http.NewRequest(op.method, server.URL+path, strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
		request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: csrf})
		response, err = http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusForbidden ||
			!strings.Contains(string(body), `"csrf_invalid"`) {
			noCSRF = append(noCSRF, op.method+" "+path+"="+
				http.StatusText(response.StatusCode)+" "+string(body))
		}
	}

	// Positive control, and the reason the two assertions above are worth anything: with the
	// session cookie and the double-submit header both present, the very same routes must get
	// past the guards. A broken handler that answered 401 to everything would otherwise sail
	// through "no session gives 401" while guarding nothing.
	type probe struct {
		method   string
		path     string
		requires bool
	}
	for _, item := range []probe{
		{http.MethodGet, "/work/v1/bootstrap", false},
		{http.MethodGet, guardURL("/work/v1/tasks/{taskId}"), false},
		{http.MethodPost, "/work/v1/inputs", true},
		{http.MethodPost, "/work/v1/admin/audit-exports", true},
	} {
		request, err := http.NewRequest(item.method, server.URL+item.path, strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
		if item.requires {
			request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: csrf})
			request.Header.Set("X-CSRF-Token", csrf)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode == http.StatusUnauthorized {
			t.Fatalf("%s %s answered 401 with a valid session: the sweep above would then be "+
				"passing on a handler that rejects everyone", item.method, item.path)
		}
		if item.requires && response.StatusCode == http.StatusForbidden &&
			strings.Contains(string(body), `"`+"csrf_invalid"+`"`) {
			t.Fatalf("%s %s still claims the CSRF is missing while the cookie and header agree",
				item.method, item.path)
		}
	}

	sort.Strings(checked)
	if len(noSession) != 0 {
		t.Fatalf("operations that did not answer 401 without a session: %s - a route that skips "+
			"authenticate() is reachable by anyone, and no feature test would notice",
			strings.Join(noSession, ", "))
	}
	if len(noCSRF) != 0 {
		t.Fatalf("mutating operations that accepted a request without the CSRF header: %s - the "+
			"cookie alone is not the double submit, so these routes are exploitable from any "+
			"origin the member's browser visits", strings.Join(noCSRF, ", "))
	}
	if mutating < 10 {
		t.Fatalf("only %d mutating operations swept; the contract has more, so this test matched "+
			"too little to mean anything", mutating)
	}
	t.Logf("swept %d operations (%d mutating): %s", len(checked), mutating, strings.Join(checked, ", "))
}
