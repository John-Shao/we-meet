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
	if len(manifest.Increments) != 1 {
		t.Fatalf("increments = %d, want 1", len(manifest.Increments))
	}
	if manifest.Increments[0].Name != "0003_directory_absence" {
		t.Fatalf("increment name = %q", manifest.Increments[0].Name)
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
