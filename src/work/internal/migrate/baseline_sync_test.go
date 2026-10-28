package migrate

import (
	"bytes"
	"io/fs"
	"os"
	"testing"

	embedded "github.com/we-meet/work/migrations"
)

func TestDirectoryAbsenceIncrementMatchesLegacySource(t *testing.T) {
	current, err := fs.ReadFile(embedded.FS, "increments/0003_directory_absence.sql")
	if err != nil {
		t.Fatal(err)
	}
	legacyPath := "../../../backend/work/sql/directory_absence.sql"
	legacy, err := os.ReadFile(legacyPath)
	if os.IsNotExist(err) {
		t.Skip("legacy source removed after cutover")
	}
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(current, legacy) {
		t.Fatalf("increment copy differs from %s; keep them byte-identical until cutover", legacyPath)
	}
}

func TestBaselineMatchesLegacySource(t *testing.T) {
	current, err := fs.ReadFile(embedded.FS, "baseline/0002_initial_r0a_schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	legacyPath := "../../../backend/work/sql/r0a_schema.sql"
	legacy, err := os.ReadFile(legacyPath)
	if os.IsNotExist(err) {
		t.Skip("legacy source removed after cutover")
	}
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(current, legacy) {
		t.Fatalf("baseline copy differs from %s; keep them byte-identical until cutover", legacyPath)
	}
}
