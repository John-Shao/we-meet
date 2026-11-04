package migrate_test

// work.org.execution_enabled is the gate the run-insert path consults
// (`OR NOT org_row.execution_enabled`), so its column default decides what a newly created
// organization can do before anyone sets a flag. It defaults to true, and a test comment in
// cmd/work-reconcile claimed the opposite ("defaults OFF in the current schema, tenant-access
// switch not pre-provisioned") - which is the kind of sentence that makes someone believe new
// tenants are inert when they are not. Nothing pinned the default: the catalogs record
// privileges and functions, not column defaults, so an increment flipping it would have been
// silent.
//
// This asserts the current fact and refuses a quiet change. Flipping the default is allowed -
// it is a decision with pilot-wide consequences - but it has to edit this file, not only SQL.
//
// Scope, so this is not read as the tenant enablement control: the production path never
// consults the default. PGWriter.SyncOrg passes work.sync_org_projection an explicit
// p_execution_enabled derived from status (internal/directory/writer.go:28-35), and that
// function refuses NULL (baseline/0002:3850), so a synced organization's flag comes from
// internal/directory's rule - pinned by TestSyncOrgDerivesExecutionEnabledFromStatus and
// tracked as task #46 - not from this column default. What this guard covers is rows created
// without the column (ops/manual INSERTs and test fixtures), which inherit it.

import (
	"io/fs"
	"regexp"
	"strings"
	"testing"

	embedded "github.com/we-meet/work/migrations"
)

func TestOrgExecutionEnabledDefaultIsPinned(t *testing.T) {
	baseline, err := fs.ReadFile(embedded.FS, "baseline/0002_initial_r0a_schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	text := string(baseline)

	// The column block has to be there before the assertion means anything.
	if !strings.Contains(text, "CREATE TABLE work.org (") {
		t.Fatal("baseline no longer creates work.org; this test is checking the wrong file")
	}
	column := regexp.MustCompile(`(?m)^\s*execution_enabled\s+boolean\s+NOT\s+NULL\s+DEFAULT\s+(\w+)\s*,`)
	match := column.FindStringSubmatch(text)
	if match == nil {
		t.Fatal("could not find the work.org execution_enabled column definition; the shape " +
			"changed and this guard needs rewriting, not deleting")
	}
	if match[1] != "true" {
		t.Fatalf("work.org.execution_enabled DEFAULT = %s, want true: this default decides "+
			"whether a brand-new organization may execute before any tenant-access decision, so "+
			"changing it is a pilot-wide decision - update this assertion deliberately.", match[1])
	}

	// No increment may quietly re-set it.
	increments, err := fs.Glob(embedded.FS, "increments/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	if len(increments) < 16 {
		t.Fatalf("found %d increments under the embedded FS, want at least 16 - the glob path "+
			"changed, so the drift check below would pass on nothing", len(increments))
	}
	reset := regexp.MustCompile(`(?i)ALTER\s+COLUMN\s+execution_enabled\s+(SET|DROP)\s+DEFAULT`)
	for _, path := range increments {
		body, err := fs.ReadFile(embedded.FS, path)
		if err != nil {
			t.Fatal(err)
		}
		if reset.FindString(string(body)) != "" {
			t.Errorf("%s changes the default of work.org.execution_enabled; that has to be an "+
				"explicit, reviewed decision (see docs/plan/work-r0a-ops-2026-10-25 C28)", path)
		}
	}
}
