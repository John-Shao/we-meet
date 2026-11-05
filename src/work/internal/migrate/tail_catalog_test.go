package migrate

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	embedded "github.com/we-meet/work/migrations"

	"github.com/we-meet/work/internal/testpg"
)

// One catalog checkpoint is pinned per increment and the runner compares a live database
// against it while applying. Nothing in the suite otherwise catches a checkpoint that went
// stale: testpg applies the raw SQL and ignores every pin, and the runner's own drift test
// feeds synthetic increments, so a chain whose tail checkpoint disagrees with the real
// database passes locally and fails only on the host, during a rollout.
//
// This is that replay: build the published chain against a real PostgreSQL instance and
// compare the live schema against the tail checkpoint that the manifest pins for it.
func TestTailCatalogCheckpointMatchesLiveChain(t *testing.T) {
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	manifest, err := LoadManifest(embedded.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	var maxVersion int64
	var maxName string
	for _, migration := range manifest.Increments {
		if migration.Version > maxVersion {
			maxVersion, maxName = migration.Version, migration.Name
		}
	}
	// The anchor is the tail, not a hard-coded number: an increment that is not registered in
	// the manifest is one nothing will ever apply, and this test would then compare a stale
	// checkpoint instead of naming the gap.
	if maxVersion < 28 {
		t.Fatalf("tail increment is version %d (%s); expected at least 0028", maxVersion, maxName)
	}
	path, pinned, err := manifest.CatalogForVersion(maxVersion)
	if err != nil {
		t.Fatal(err)
	}
	expected, body, err := LoadCatalog(embedded.FS, ".", path)
	if err != nil {
		t.Fatal(err)
	}
	if checksumBytes(body) != pinned {
		t.Fatalf("catalog %s does not match the checksum pinned for version %d", path, maxVersion)
	}
	// Non-vacuity: the checkpoint has to carry the real object set, or an empty comparison
	// would pass. The published tail checkpoint currently samples 159 functions over 48
	// relations; these floors sit well under that and above any partial read, so a truncated
	// or empty catalog file cannot slip through as a green.
	if len(expected.Functions) < 100 || len(expected.Relations) < 40 {
		t.Fatalf("catalog %s looks truncated: functions=%d relations=%d",
			path, len(expected.Functions), len(expected.Relations))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	root, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	if err := testpg.EnsureFixtures(ctx, root); err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, root, "work_tail_catalog")
	_ = root.Close(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelCleanup()
		admin, err := testpg.Open(cleanupCtx, testpg.AdminURL())
		if err == nil {
			_ = testpg.DropDatabase(cleanupCtx, admin, dbName)
			_ = admin.Close(cleanupCtx)
		}
	})

	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	actual, err := ReadCatalog(ctx, conn)
	if err != nil {
		t.Fatal(err)
	}
	diff, err := expected.Diff(actual)
	if err != nil {
		t.Fatalf("compare live chain against %s: %v", path, err)
	}
	if !diff.Empty() || diff.ExpectedSHA256 != diff.ActualSHA256 {
		t.Fatalf("live chain at version %d disagrees with its pinned checkpoint %s: expected %s actual %s, sections=[%s]",
			maxVersion, path, diff.ExpectedSHA256, diff.ActualSHA256,
			strings.Join(describeSections(diff), ", "))
	}
}

// describeSections names the parts of the schema that moved, so a red here says which object
// set was re-sampled rather than only that hashes differ.
func describeSections(diff *Diff) []string {
	sections := []string{}
	add := func(name string, section *SectionDiff) {
		if section == nil {
			return
		}
		sections = append(sections, name+
			"(missing="+strconv.Itoa(len(section.Missing))+
			", extra="+strconv.Itoa(len(section.Extra))+
			", changed="+strconv.Itoa(len(section.Changed))+")")
	}
	add("relations", diff.Relations)
	add("columns", diff.Columns)
	add("constraints", diff.Constraints)
	add("indexes", diff.Indexes)
	add("functions", diff.Functions)
	add("views", diff.Views)
	add("triggers", diff.Triggers)
	add("policies", diff.Policies)
	add("grants", diff.Grants)
	if len(sections) == 0 {
		sections = append(sections, "schema_owner")
	}
	return sections
}
