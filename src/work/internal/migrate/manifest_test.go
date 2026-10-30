package migrate

import (
	"encoding/json"
	"errors"
	"testing"
	"testing/fstest"

	embedded "github.com/we-meet/work/migrations"
)

func TestEmbeddedManifestLoads(t *testing.T) {
	manifest, err := LoadManifest(embedded.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Baseline) != 2 {
		t.Fatalf("baseline entries = %d, want 2", len(manifest.Baseline))
	}
	if len(manifest.Increments) != 14 {
		t.Fatalf("increments = %d, want 14", len(manifest.Increments))
	}
	if manifest.Increments[0].Name != "0003_directory_absence" {
		t.Fatalf("increment name = %q", manifest.Increments[0].Name)
	}
	if manifest.Increments[1].Name != "0004_outbox_task_event_kind" {
		t.Fatalf("increment name = %q", manifest.Increments[1].Name)
	}
	if manifest.Increments[2].Name != "0005_run_workflow_id" {
		t.Fatalf("increment name = %q", manifest.Increments[2].Name)
	}
	if manifest.Increments[3].Name != "0006_org_policy_quota_provision" {
		t.Fatalf("increment name = %q", manifest.Increments[3].Name)
	}
	if manifest.Increments[4].Name != "0007_org_provision_backfill" {
		t.Fatalf("increment name = %q", manifest.Increments[4].Name)
	}
	if manifest.Increments[5].Name != "0008_quota_directory_usage_hardening" {
		t.Fatalf("increment name = %q", manifest.Increments[5].Name)
	}
	if manifest.Increments[6].Name != "0009_runtime_execution_dispatch_gate" {
		t.Fatalf("increment name = %q", manifest.Increments[6].Name)
	}
	if manifest.Increments[7].Name != "0010_runtime_capability" {
		t.Fatalf("increment name = %q", manifest.Increments[7].Name)
	}
	if manifest.Increments[8].Name != "0011_content_reference" {
		t.Fatalf("increment name = %q", manifest.Increments[8].Name)
	}
	if manifest.Increments[9].Name != "0012_content_slot" {
		t.Fatalf("increment name = %q", manifest.Increments[9].Name)
	}
	if manifest.Increments[10].Name != "0013_model_request_dispatch_consume" {
		t.Fatalf("increment name = %q", manifest.Increments[10].Name)
	}
	if manifest.Increments[11].Name != "0014_advance_binding_reads" {
		t.Fatalf("increment name = %q", manifest.Increments[11].Name)
	}
	if manifest.Increments[12].Name != "0015_snapshot_revision" {
		t.Fatalf("increment name = %q", manifest.Increments[12].Name)
	}
	if manifest.Increments[13].Name != "0016_reconcile_rejected_receipt" {
		t.Fatalf("increment name = %q", manifest.Increments[13].Name)
	}
	if manifest.Baseline[1].Name != "0002_initial_r0a_schema" {
		t.Fatalf("baseline name = %q", manifest.Baseline[1].Name)
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
