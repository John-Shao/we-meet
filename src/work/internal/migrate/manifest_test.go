package migrate

import (
	"encoding/json"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"

	embedded "github.com/we-meet/work/migrations"
)

// publishedIncrements is the chain as published. The list is the assertion: a
// new increment adds exactly one line here, instead of leaving a count and a
// per-index name list that drift apart the moment either side is forgotten.
var publishedIncrements = []string{
	"0003_directory_absence",
	"0004_outbox_task_event_kind",
	"0005_run_workflow_id",
	"0006_org_policy_quota_provision",
	"0007_org_provision_backfill",
	"0008_quota_directory_usage_hardening",
	"0009_runtime_execution_dispatch_gate",
	"0010_runtime_capability",
	"0011_content_reference",
	"0012_content_slot",
	"0013_model_request_dispatch_consume",
	"0014_advance_binding_reads",
	"0015_snapshot_revision",
	"0016_reconcile_rejected_receipt",
	"0017_r0b_transition_authority",
	"0018_r0b_governance_authority",
	"0019_r0b_deny_lifecycle",
	"0020_r0b_local_execution_policy",
	"0021_r0b_operation_resolution",
	"0022_org_execution_reason_split",
	"0023_operator_entitlement_and_intents",
	"0024_provider_probe_grant",
	"0025_provider_config_conflict_detail",
	"0026_audit_export_org_gate",
	"0027_governance_receipt_payload_binding",
	"0028_runtime_execution_lease_takeover",
	"0029_terminal_reservation_release",
	"0030_durable_receipt_head_commit",
	"0031_audit_export_stale_lease_discovery",
	"0032_content_ref_reads_for_orphan_report",
}

func TestEmbeddedManifestLoads(t *testing.T) {
	manifest, err := LoadManifest(embedded.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Baseline) != 2 {
		t.Fatalf("baseline entries = %d, want 2", len(manifest.Baseline))
	}
	if manifest.Baseline[1].Name != "0002_initial_r0a_schema" {
		t.Fatalf("baseline name = %q", manifest.Baseline[1].Name)
	}
	if len(manifest.Increments) != len(publishedIncrements) {
		var names []string
		for _, migration := range manifest.Increments {
			names = append(names, migration.Name)
		}
		t.Fatalf("increments = %d, want %d: %v", len(manifest.Increments),
			len(publishedIncrements), names)
	}
	for i, name := range publishedIncrements {
		if manifest.Increments[i].Name != name {
			t.Fatalf("increment %d name = %q, want %q", i, manifest.Increments[i].Name, name)
		}
	}
}

// TestManifestCoversEveryIncrementFile closes the direction the list above cannot see.
// publishedIncrements asserts the manifest carries what it names; it says nothing about a
// .sql file that was dropped into increments/ and never registered. Such a file is not
// "not yet applied" - nothing applies it, because both the runner and testpg take their
// order of operations from manifest.json, so the schema it describes exists only in the
// head of whoever wrote it.
func TestManifestCoversEveryIncrementFile(t *testing.T) {
	manifest, err := LoadManifest(embedded.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, migration := range manifest.Increments {
		listed[migration.File] = true
	}
	entries, err := fs.ReadDir(embedded.FS, "increments")
	if err != nil {
		t.Fatal(err)
	}
	var unlisted []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		if path := "increments/" + entry.Name(); !listed[path] {
			unlisted = append(unlisted, path)
		}
	}
	if len(unlisted) > 0 {
		t.Fatalf("increment files with no manifest entry, so nothing would ever apply them: %s",
			strings.Join(unlisted, ", "))
	}
}

func TestManifestRejectsModifiedPublishedBody(t *testing.T) {
	files, manifest := testManifest(t)
	files["baseline/schema.sql"] = &fstest.MapFile{Data: []byte("SELECT 2;")}
	writeManifest(t, files, manifest)
	_, err := LoadManifest(files, ".")
	assertCode(t, err, "published_migration_modified")
}

func TestManifestRejectsNonMonotonicVersions(t *testing.T) {
	files, manifest := testManifest(t)
	manifest.Increments = []Migration{{
		Version: 2, Name: "duplicate", Kind: "increment", File: "increment.sql",
		Checksum: checksumBytes([]byte("SELECT 1;")), Transactional: true, Executable: true,
		Catalog: "baseline/catalog.json", CatalogChecksum: checksumBytes([]byte("{}")),
	}}
	files["increment.sql"] = &fstest.MapFile{Data: []byte("SELECT 1;")}
	writeManifest(t, files, manifest)
	_, err := LoadManifest(files, ".")
	assertCode(t, err, "manifest_invalid")
}

func TestManifestRequiresIncrementCatalog(t *testing.T) {
	files, manifest := testManifest(t)
	manifest.Increments = []Migration{{
		Version: 3, Name: "no-catalog", Kind: "increment", File: "increment.sql",
		Checksum: checksumBytes([]byte("SELECT 1;")), Transactional: true, Executable: true,
	}}
	files["increment.sql"] = &fstest.MapFile{Data: []byte("SELECT 1;")}
	writeManifest(t, files, manifest)
	_, err := LoadManifest(files, ".")
	assertCode(t, err, "manifest_invalid")
}

func TestManifestRequiresNamedProtocolForNonTransactionalIncrement(t *testing.T) {
	files, manifest := testManifest(t)
	manifest.Increments = []Migration{{
		Version: 3, Name: "concurrent-index", Kind: "increment", File: "increment.sql",
		Checksum: checksumBytes([]byte("SELECT 1;")), Transactional: false, Executable: true,
		Catalog: "baseline/catalog.json", CatalogChecksum: checksumBytes([]byte("{}")),
	}}
	files["increment.sql"] = &fstest.MapFile{Data: []byte("SELECT 1;")}
	writeManifest(t, files, manifest)
	_, err := LoadManifest(files, ".")
	assertCode(t, err, "manifest_invalid")
}

func TestCatalogForVersionUsesAppliedCheckpoint(t *testing.T) {
	files, manifest := testManifest(t)
	manifest.Increments = []Migration{{
		Version: 3, Name: "third", Kind: "increment", File: "increment.sql",
		Checksum: checksumBytes([]byte("SELECT 1;")), Transactional: true, Executable: true,
		Catalog: "baseline/catalog.json", CatalogChecksum: checksumBytes([]byte("{}")),
	}}
	files["increment.sql"] = &fstest.MapFile{Data: []byte("SELECT 1;")}
	writeManifest(t, files, manifest)
	loaded, err := LoadManifest(files, ".")
	if err != nil {
		t.Fatal(err)
	}
	path, _, err := loaded.CatalogForVersion(3)
	if err != nil {
		t.Fatal(err)
	}
	if path != "baseline/catalog.json" {
		t.Fatalf("catalog path = %q", path)
	}
}

func testManifest(t *testing.T) (fstest.MapFS, Manifest) {
	t.Helper()
	roles := []byte("SELECT 1;")
	schema := []byte("SELECT 1;")
	catalog := []byte("{}")
	files := fstest.MapFS{
		"baseline/roles.sql":    &fstest.MapFile{Data: roles},
		"baseline/schema.sql":   &fstest.MapFile{Data: schema},
		"baseline/catalog.json": &fstest.MapFile{Data: catalog},
	}
	manifest := Manifest{
		SchemaVersion:   1,
		LedgerTable:     "work.schema_migration",
		Catalog:         "baseline/catalog.json",
		CatalogChecksum: checksumBytes(catalog),
		Baseline: []Migration{
			{
				Version: 1, Name: "0001_roles", Kind: "precondition", File: "baseline/roles.sql",
				Checksum: checksumBytes(roles), Transactional: true, Executable: false,
			},
			{
				Version: 2, Name: "0002_schema", Kind: "baseline", File: "baseline/schema.sql",
				Checksum: checksumBytes(schema), Transactional: true, Executable: true,
			},
		},
	}
	writeManifest(t, files, manifest)
	return files, manifest
}

func writeManifest(t *testing.T, files fstest.MapFS, manifest Manifest) {
	t.Helper()
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	files["manifest.json"] = &fstest.MapFile{Data: body}
}

func assertCode(t *testing.T, err error, code string) {
	t.Helper()
	var migrationError *Error
	if !errors.As(err, &migrationError) {
		t.Fatalf("error = %v, want *Error %s", err, code)
	}
	if migrationError.Code != code {
		t.Fatalf("error code = %q, want %q", migrationError.Code, code)
	}
}
