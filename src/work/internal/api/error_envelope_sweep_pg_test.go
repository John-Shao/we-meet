package api_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/api"
	"github.com/we-meet/work/internal/host"
)

// The catalog promises three things about every failure the control plane returns: the code is
// one of its own entries, the HTTP status and retry flag are the ones that entry declares, and
// `message` is fixed display text that never echoes what the caller sent. Until now each promise
// was only checked statically - the apierr literal scan and the contract gates read source and
// JSON, never a response.
//
// Every registered route is probed from the outside in: no session; a mutating call without the
// double-submit header; a well-credentialled call whose payload cannot be accepted; and a
// malformed path parameter. Whatever error comes back must satisfy all three promises, and the
// canary woven into every submitted value must never appear in the response body.
//
// One route is not driven past the first probe: the task event stream hijacks the connection and
// holds it open by design, which is a transport behaviour and not an error-envelope case.
// Responses that are not errors (status < 400) are counted separately - a 2xx body is allowed to
// carry user content back, because titles are derived from the goal by design.

var errorEnvelopeKeys = []string{
	"code", "correlation_id", "current_revision", "message", "recovery_action", "retryable",
}

// readContract walks upwards from the test's working directory, which is the package directory
// under the module root, and falls back to the container's /repo layout.
func readContract(t *testing.T, relative string) map[string]any {
	t.Helper()
	for _, candidate := range []string{
		filepath.Join("..", "..", relative),
		filepath.Join("..", "..", "..", relative),
		filepath.Join("/repo", "src", "work", relative),
		filepath.Join("/repo", relative),
	} {
		body, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		var out map[string]any
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatalf("parsing %s: %v", candidate, err)
		}
		return out
	}
	t.Fatalf("%s was not readable from the test working directory; an envelope sweep that silently "+
		"skips the catalog checks nothing", relative)
	return nil
}

func envelopeProbe(t *testing.T, serverURL, method, path, body, mode, csrfToken string) (
	int, map[string]any, string) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, err := http.NewRequest(method, serverURL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if mode != "no-session" {
		request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
	}
	if mode == "csrf" {
		request.AddCookie(&http.Cookie{Name: api.CSRFCookieName, Value: csrfToken})
		request.Header.Set(api.CSRFHeaderName, csrfToken)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("%s %s did not return a JSON object: status=%d body=%s",
			method, path, response.StatusCode, firstChars(string(raw)))
	}
	return response.StatusCode, payload, string(raw)
}

func firstChars(value string) string {
	if len(value) > 200 {
		return value[:200] + "..."
	}
	return value
}

func TestEveryEmittedErrorMatchesTheCatalogAndEchoesNothing(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, true)
	server := newHTTPServerWithContent(t, pool, newTestContentStore(t))
	csrf := bootstrapCSRF(t, server.URL)

	catalog := readContract(t, "contracts/error-codes.json")
	dbMap, _ := catalog["db_exception_map"].(map[string]any)
	public, _ := catalog["public"].(map[string]any)
	messages := readContract(t, "contracts/error-messages.json")
	if len(public) < 50 || len(dbMap) < 150 || len(messages) < 50 {
		t.Fatalf("catalog loaded with %d public codes / %d db mappings / %d messages; the shape of "+
			"one of the two files has changed and the checks below would be vacuous",
			len(public), len(dbMap), len(messages))
	}

	canary := "CNRY7F4dEadBeef"
	const malformedPath = "not-a-uuid"

	var errors, successes, codesHit []string
	seenCodes := map[string]int{}
	for _, route := range registeredRoutes(t) {
		stream := strings.HasSuffix(route.path, "/events")
		parameterised := strings.Contains(route.path, "{")
		body := `{"client_request_id":"` + strings.ToLower(canary) + `-id","goal":"` + canary +
			`","background":"` + canary + `","title":"` + canary + `","reason":"` + canary +
			`","expected_revision":-1,"revision":-1,"to_seq":-1,"from_seq":-1,` +
			`"gap_report_id":"` + canary + `","ticket_id":"` + canary + `","api_key":"` + canary +
			`","role_ref":"` + canary + `","format":"` + canary + `","target":{},"permission_mode":"` +
			canary + `","input_ref":"` + guardFixtureUUID + `"}`

		probes := []struct {
			label  string
			mode   string
			body   string
			path   string
			skipIf bool
		}{
			{"no-session", "no-session", "", guardURL(route.path), false},
			{"no-csrf-header", "session", body, guardURL(route.path), route.method == http.MethodGet},
			{"bad-payload", "csrf", body, guardURL(route.path), stream},
			{"bad-path-id", "csrf", "", regexp.MustCompile(`\{[^}]+\}`).
				ReplaceAllString(route.path, malformedPath), !parameterised || stream},
		}
		for _, probe := range probes {
			if probe.skipIf {
				continue
			}
			status, payload, raw := envelopeProbe(t, server.URL, route.method, probe.path,
				probe.body, probe.mode, csrf)
			if status < http.StatusBadRequest {
				successes = append(successes, route.method+" "+route.path+"/"+probe.label)
				continue
			}
			keys := make([]string, 0, len(payload))
			for key := range payload {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			if strings.Join(keys, ",") != strings.Join(errorEnvelopeKeys, ",") {
				t.Fatalf("%s %s (%s): envelope keys = [%s], want [%s] - the published shape is six "+
					"keys, and an extra or missing one breaks every client that parses it",
					route.method, route.path, probe.label, strings.Join(keys, ","),
					strings.Join(errorEnvelopeKeys, ","))
			}
			// Case-insensitive: the sweep sends a lower-cased variant of the canary too, and a
			// handler that normalises before echoing it back would survive a plain match.
			if lower := strings.ToLower(canary); strings.Contains(strings.ToLower(raw), lower) {
				t.Fatalf("%s %s (%s): the response echoes submitted content (%s). The catalog rule "+
					"is that message is safe display text and never carries goal, background or "+
					"artifact content", route.method, route.path, probe.label, canary)
			}

			code, _ := payload["code"].(string)
			entry, registered := public[code].(map[string]any)
			if !registered {
				t.Fatalf("%s %s (%s): code %q is not in the public catalog; clients would branch or "+
					"retry on something undocumented", route.method, route.path, probe.label, code)
			}
			declared, _ := entry["status"].(float64)
			if int(declared) != status {
				t.Fatalf("%s %s (%s): %s answered %d, the catalog declares %d",
					route.method, route.path, probe.label, code, status, int(declared))
			}
			retryable, _ := entry["retryable"].(bool)
			if payload["retryable"] != retryable {
				t.Fatalf("%s %s (%s): %s sent retryable=%v, catalog says %v",
					route.method, route.path, probe.label, code, payload["retryable"], retryable)
			}
			// Mandatory, not "if present": the catalog ships a fixed string for all 60 public
			// codes, so a code whose text is missing here is a catalog gap, and a conditional
			// check would quietly stop checking anything the day the file is edited.
			text, hasText := messages[code].(string)
			if !hasText || text == "" {
				t.Fatalf("%s %s (%s): code %q is public but contracts/error-messages.json has no "+
					"fixed display text for it, so the client has nothing to show",
					route.method, route.path, probe.label, code)
			}
			if payload["message"] != text {
				t.Fatalf("%s %s (%s): %s message = %q, want the catalog's fixed text %q - a dynamic "+
					"message is exactly how request content leaks", route.method, route.path,
					probe.label, code, payload["message"], text)
			}
			errors = append(errors, route.method+" "+route.path)
			codesHit = append(codesHit, code)
			seenCodes[code]++
		}
	}

	if len(errors) < 60 {
		t.Fatalf("only %d error responses inspected; the probes are not reaching the routes",
			len(errors))
	}
	distinct := make([]string, 0, len(seenCodes))
	for code := range seenCodes {
		distinct = append(distinct, code)
	}
	sort.Strings(distinct)
	if len(distinct) < 6 {
		t.Fatalf("the sweep exercised only %d distinct codes (%v); too narrow to call this a check "+
			"of the catalog contract", len(distinct), distinct)
	}

	// The floor that keeps the sweep honest. Most of its 110 responses are produced by the two
	// guards in front of every handler, and a build where the authenticated probes all died at
	// the door would still satisfy everything above. These codes come from inside the handlers,
	// so their presence proves the payload and path probes actually reached one.
	guardCodes := map[string]bool{"unauthorized": true, "csrf_invalid": true}
	reached := 0
	for _, code := range distinct {
		if !guardCodes[code] {
			reached++
		}
	}
	if reached < 5 {
		t.Fatalf("only %d handler-produced codes were seen (%v); the authenticated probes never got "+
			"past the session and CSRF guards, so the request-shape checks below the guards are not "+
			"being swept", reached, distinct)
	}
	counts := make([]string, 0, len(seenCodes))
	for _, code := range distinct {
		counts = append(counts, fmt.Sprintf("%s=%d", code, seenCodes[code]))
	}
	t.Logf("inspected %d error responses (%d non-error probes), %d distinct codes: %s",
		len(errors), len(successes), len(distinct), strings.Join(counts, ", "))
}
