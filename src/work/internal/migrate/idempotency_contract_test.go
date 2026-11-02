package migrate

import (
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"testing"

	embedded "github.com/we-meet/work/migrations"
)

// client_request_id is the contract's replay protection: retrying a submission whose response was
// lost must return the original outcome, and a *different* payload under the same key must be
// refused rather than quietly executed. Every domain command that accepts the parameter has to
// implement that, and nothing in the suite checked that accepting the parameter buys the
// behaviour.
//
// Three legitimate mechanisms exist in this schema - work.lock_request_key with
// work.submission_dedup for the task-shaped commands, a request_hash column on the row itself
// (work.create_audit_export), and a request_hash written into the audit receipt (the R0b
// governance commands) - so the assertion is not "everyone uses dedup", it is "no one uses
// nothing". A command that takes the key and implements neither advertises idempotency while
// executing the same request twice, and that is what this test turns red on.

var keyCommandPattern = regexp.MustCompile(`(?m)^CREATE (?:OR REPLACE )?FUNCTION work\.(\w+)\(`)

type definition struct {
	signature string
	whole     string
}

// TestEveryClientRequestKeyCommandIsIdempotent reads the whole migration chain in apply order and
// keeps the last definition of each function, the way the runner would.
func TestEveryClientRequestKeyCommandIsIdempotent(t *testing.T) {
	paths := []string{"baseline/0002_initial_r0a_schema.sql"}
	increments, err := fs.Glob(embedded.FS, "increments/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(increments)
	paths = append(paths, increments...)

	latest := map[string]definition{}
	origin := map[string]string{}
	for _, path := range paths {
		body, err := fs.ReadFile(embedded.FS, path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		locations := keyCommandPattern.FindAllStringSubmatchIndex(text, -1)
		for i, location := range locations {
			name := text[location[2]:location[3]]
			start := location[0]
			end := len(text)
			if i+1 < len(locations) {
				end = locations[i+1][0]
			}
			// The signature is what says whether the command takes the key at all, while the
			// mechanisms live in the body, so the two are kept apart instead of being guessed at.
			head := strings.Index(text[start:], "AS $$")
			if head < 0 {
				continue
			}
			latest[name] = definition{
				signature: text[start : start+head],
				whole:     text[start:end],
			}
			origin[name] = path
		}
	}

	var found []string
	var unguarded []string
	for name, def := range latest {
		// Two naming families carry the same promise: the R0a commands take p_client_request_id,
		// the R0b governance commands take p_request_id. Matching only the first would leave a
		// whole family of replay-sensitive commands unexamined, which is how this test was wrong
		// on its first run.
		if !strings.Contains(def.signature, "p_client_request_id") &&
			!strings.Contains(def.signature, "p_request_id") {
			continue
		}
		if name == "lock_request_key" {
			// This is the mechanism itself; its signature carries the column name by definition.
			continue
		}
		dedup := strings.Contains(def.whole, "work.lock_request_key") ||
			strings.Contains(def.whole, "work.submission_dedup") ||
			strings.Contains(def.whole, "consumed_governance_command")
		hashed := strings.Contains(def.whole, "idempotency_key_conflict")
		// The third accepted mechanism is optimistic concurrency. work.set_local_policy takes
		// p_request_id only as an audit label and gates the write on p_expected_revision, so a
		// resend cannot apply twice - but it also does not return the original answer, it answers
		// 409. That difference is why this family is listed separately instead of being counted
		// as idempotent: a client must not treat a retried PATCH as transparently safe.
		revision := strings.Contains(def.signature, "p_expected_revision")
		switch {
		case dedup && hashed:
			found = append(found, name+"=dedup+conflict")
		case dedup:
			found = append(found, name+"=dedup")
		case hashed && revision:
			found = append(found, name+"=own_request_hash+revision")
		case hashed:
			found = append(found, name+"=own_request_hash")
		case revision:
			found = append(found, name+"=revision_only")
		default:
			found = append(found, name+"=NONE")
			unguarded = append(unguarded, name+"@"+origin[name])
		}
	}
	sort.Strings(found)

	if len(unguarded) != 0 {
		t.Fatalf("commands accepting p_client_request_id with no replay protection: [%s] - the "+
			"contract promises a retry is safe, and without a dedup lookup or a request-hash "+
			"comparison a retry runs the command a second time", strings.Join(unguarded, ", "))
	}
	// The exact inventory, so a new key-taking command - or an existing one losing its protection
	// to a rewrite - changes this string and lands here, instead of the sweep quietly passing on
	// "everything I happened to match is covered".
	want := []string{
		"accept_task=dedup+conflict",
		"advance_governance_event_cursor=dedup+conflict",
		"apply_execution_entitlement=own_request_hash",
		"create_audit_export=own_request_hash",
		"create_input_idempotent=dedup+conflict",
		"create_user_artifact_version=dedup+conflict",
		"retry_task=dedup+conflict",
		"set_local_policy=revision_only",
		"submit_task=dedup+conflict",
		"update_task_title=dedup+conflict",
	}
	if strings.Join(found, ",") != strings.Join(want, ",") {
		t.Fatalf("key-taking command inventory =\n  [%s]\nwant\n  [%s]",
			strings.Join(found, ", "), strings.Join(want, ", "))
	}
	if len(found) < len(want) {
		t.Fatalf("only %d key-taking commands were matched; the parser probably stopped working, "+
			"which would make the coverage above meaningless", len(found))
	}
	t.Logf("key-taking commands (%d): %s", len(found), strings.Join(found, ", "))
}
