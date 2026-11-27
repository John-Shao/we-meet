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

func TestUpgradeFrom62PreservesSchemaContracts(t *testing.T) {
	manifest, err := LoadManifest(embedded.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	var oldPath, tailPath string
	var oldChecksum, tailChecksum string
	var tailVersion int64
	for _, migration := range manifest.Increments {
		switch migration.Version {
		case 62:
			oldPath, oldChecksum = migration.Catalog, migration.CatalogChecksum
		}
		if migration.Version > tailVersion {
			tailVersion = migration.Version
			tailPath, tailChecksum = migration.Catalog, migration.CatalogChecksum
		}
	}
	if oldPath == "" || tailPath == "" || tailVersion <= 62 {
		t.Fatalf("catalog pair unavailable: old=%q tail=%q version=%d", oldPath, tailPath, tailVersion)
	}
	oldCatalog, oldBody, err := LoadCatalog(embedded.FS, ".", oldPath)
	if err != nil {
		t.Fatal(err)
	}
	tailCatalog, tailBody, err := LoadCatalog(embedded.FS, ".", tailPath)
	if err != nil {
		t.Fatal(err)
	}
	if checksumBytes(oldBody) != oldChecksum || checksumBytes(tailBody) != tailChecksum {
		t.Fatal("upgrade catalog checksum does not match the manifest")
	}
	if len(oldCatalog.Functions) < 100 || len(tailCatalog.Functions) < 100 {
		t.Fatalf("catalog function set looks truncated: old=%d tail=%d", len(oldCatalog.Functions), len(tailCatalog.Functions))
	}

	functionKey := func(fn Function) string { return fn.Name + "(" + fn.IdentityArguments + ")" }
	tailFunctions := make(map[string]Function, len(tailCatalog.Functions))
	for _, fn := range tailCatalog.Functions {
		tailFunctions[functionKey(fn)] = fn
	}
	var missing, changed []string
	for _, fn := range oldCatalog.Functions {
		key := functionKey(fn)
		next, ok := tailFunctions[key]
		if !ok {
			missing = append(missing, key)
			continue
		}
		// Implementation language and volatility may change without breaking callers; the
		// signature, result and privilege boundary are the hot-upgrade compatibility contract.
		if fn.Result != next.Result || fn.SecurityDefiner != next.SecurityDefiner ||
			fn.Strict != next.Strict || fn.Owner != next.Owner ||
			fn.Configuration != next.Configuration {
			changed = append(changed, key)
		}
	}
	if len(missing) != 0 || len(changed) != 0 {
		t.Fatalf("tip62 function contracts changed at tail: missing=%v changed=%v", missing, changed)
	}

	tailRelations := make(map[string]struct{}, len(tailCatalog.Relations))
	for _, relation := range tailCatalog.Relations {
		tailRelations[relation.Name] = struct{}{}
	}
	var removedRelations []string
	for _, relation := range oldCatalog.Relations {
		if _, ok := tailRelations[relation.Name]; !ok {
			removedRelations = append(removedRelations, relation.Name)
		}
	}
	if len(removedRelations) != 0 {
		t.Fatalf("tip62 relations removed at tail: %v", removedRelations)
	}

	tailColumns := make(map[string]Column, len(tailCatalog.Columns))
	for _, column := range tailCatalog.Columns {
		tailColumns[column.Table+"."+column.Name] = column
	}
	missingColumns, changedColumns := []string{}, []string{}
	for _, column := range oldCatalog.Columns {
		key := column.Table + "." + column.Name
		next, ok := tailColumns[key]
		if !ok {
			missingColumns = append(missingColumns, key)
			continue
		}
		if column.DataType != next.DataType || column.Nullable != next.Nullable {
			changedColumns = append(changedColumns, key)
		}
	}
	if len(missingColumns) != 0 || len(changedColumns) != 0 {
		t.Fatalf("tip62 columns changed at tail: missing=%v changed=%v", missingColumns, changedColumns)
	}

	tailConstraints := make(map[string]struct{}, len(tailCatalog.Constraints))
	for _, constraint := range tailCatalog.Constraints {
		tailConstraints[constraint.Table+"."+constraint.Name] = struct{}{}
	}
	var removedConstraints []string
	for _, constraint := range oldCatalog.Constraints {
		key := constraint.Table + "." + constraint.Name
		if _, ok := tailConstraints[key]; !ok {
			removedConstraints = append(removedConstraints, key)
		}
	}
	if len(removedConstraints) != 0 {
		t.Fatalf("tip62 constraints removed at tail: %v", removedConstraints)
	}

	grantKey := func(g Grant) string {
		return strings.Join([]string{g.ObjectType, g.Schema, g.Object, g.Grantee, g.Privilege, strconv.FormatBool(g.Grantable)}, "\x00")
	}
	tailGrants := make(map[string]struct{}, len(tailCatalog.Grants))
	for _, grant := range tailCatalog.Grants {
		if grant.ObjectType == "function" {
			tailGrants[grantKey(grant)] = struct{}{}
		}
	}
	var revoked []string
	for _, grant := range oldCatalog.Grants {
		if grant.ObjectType != "function" {
			continue
		}
		if _, ok := tailGrants[grantKey(grant)]; !ok {
			revoked = append(revoked, grantKey(grant))
		}
	}
	if len(revoked) != 0 {
		t.Fatalf("tip62 function grants removed at tail: %v", revoked)
	}
}
