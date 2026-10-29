package migrate

import (
	"strings"
	"testing"
)

func TestVerifyLedgerAcceptsPinnedLegacyChecksum(t *testing.T) {
	current := "sha256:" + strings.Repeat("a", 64)
	legacy := "sha256:" + strings.Repeat("b", 64)
	manifest := &Manifest{
		Baseline: []Migration{
			{Version: 1, Name: "0001_create_work_roles", Kind: "precondition", Checksum: current},
			{Version: 2, Name: "0002_initial_r0a_schema", Kind: "baseline", Checksum: current},
		},
		Increments: []Migration{{
			Version: 3, Name: "0003_directory_absence", Kind: "increment",
			Checksum: current, LegacyChecksums: []string{legacy},
		}},
	}
	state := &State{Ledger: []LedgerRow{
		{Version: 1, Name: "0001_create_work_roles", Kind: "precondition", Checksum: current},
		{Version: 2, Name: "0002_initial_r0a_schema", Kind: "baseline", Checksum: current},
		{Version: 3, Name: "0003_directory_absence", Kind: "increment", Checksum: legacy},
	}}
	if err := verifyLedgerAgainstManifest(state, manifest); err != nil {
		t.Fatalf("legacy checksum rejected: %v", err)
	}

	state.Ledger[2].Checksum = "sha256:" + strings.Repeat("c", 64)
	if err := verifyLedgerAgainstManifest(state, manifest); err == nil {
		t.Fatal("unknown checksum was accepted")
	}
}

func TestManifestRejectsMalformedLegacyChecksum(t *testing.T) {
	manifest := &Manifest{
		SchemaVersion: 1,
		LedgerTable:   "work.schema_migration",
		Catalog:       "baseline/catalog.json",
		Baseline: []Migration{
			{Version: 1, Name: "0001_create_work_roles", Kind: "precondition", File: "a.sql", Checksum: "sha256:" + strings.Repeat("a", 64)},
			{Version: 2, Name: "0002_initial_r0a_schema", Kind: "baseline", File: "b.sql", Checksum: "sha256:" + strings.Repeat("a", 64), Executable: true},
		},
		Increments: []Migration{{
			Version: 3, Name: "0003_directory_absence", Kind: "increment", File: "c.sql",
			Checksum: "sha256:" + strings.Repeat("a", 64), Executable: true,
			Catalog: "baseline/catalog.json", CatalogChecksum: "sha256:" + strings.Repeat("a", 64),
			LegacyChecksums: []string{"not-a-checksum"},
		}},
	}
	if err := manifest.validate(); err == nil {
		t.Fatal("malformed legacy checksum was accepted")
	}
}
