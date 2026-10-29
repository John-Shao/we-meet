package migrate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"strings"
)

const checksumPrefix = "sha256:"

type Manifest struct {
	SchemaVersion   int         `json:"schema_version"`
	LedgerTable     string      `json:"ledger_table"`
	Catalog         string      `json:"catalog"`
	CatalogChecksum string      `json:"catalog_checksum"`
	Baseline        []Migration `json:"baseline"`
	Increments      []Migration `json:"increments"`
}

type Migration struct {
	Version               int64    `json:"version"`
	Name                  string   `json:"name"`
	Kind                  string   `json:"kind"`
	File                  string   `json:"file"`
	Checksum              string   `json:"checksum"`
	LegacyChecksums       []string `json:"legacy_checksums,omitempty"`
	Catalog               string   `json:"catalog,omitempty"`
	CatalogChecksum       string   `json:"catalog_checksum,omitempty"`
	Transactional         bool     `json:"transactional"`
	Executable            bool     `json:"executable"`
	NamedRecoveryProtocol string   `json:"named_recovery_protocol,omitempty"`
}

func (m Migration) Key() string {
	return fmt.Sprintf("%d_%s", m.Version, m.Name)
}

func (m *Manifest) All() []Migration {
	out := make([]Migration, 0, len(m.Baseline)+len(m.Increments))
	out = append(out, m.Baseline...)
	out = append(out, m.Increments...)
	return out
}

func LoadManifest(fsys fs.FS, root string) (*Manifest, error) {
	root = cleanRoot(root)
	raw, err := fs.ReadFile(fsys, path.Join(root, "manifest.json"))
	if err != nil {
		return nil, newError("manifest_unreadable", "read manifest: %v", err)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, newError("manifest_invalid", "decode manifest: %v", err)
	}
	if err := m.validate(); err != nil {
		return nil, err
	}
	if err := m.verifyFiles(fsys, root); err != nil {
		return nil, err
	}
	return &m, nil
}

func cleanRoot(root string) string {
	root = strings.TrimSpace(root)
	if root == "" || root == "." {
		return "."
	}
	return path.Clean(root)
}

func (m *Manifest) validate() error {
	if m.SchemaVersion != 1 {
		return newError("manifest_invalid", "unsupported schema_version %d", m.SchemaVersion)
	}
	if m.LedgerTable != "work.schema_migration" {
		return newError("manifest_invalid", "ledger_table must be work.schema_migration")
	}
	if len(m.Baseline) == 0 {
		return newError("manifest_invalid", "baseline is empty")
	}
	seen := make(map[int64]string)
	var previous int64
	for i, migration := range m.All() {
		if migration.Version <= 0 {
			return newError("manifest_invalid", "migration %q has non-positive version", migration.Name)
		}
		if migration.Version <= previous {
			return newError("manifest_invalid", "migration versions must be strictly increasing")
		}
		previous = migration.Version
		if _, ok := seen[migration.Version]; ok {
			return newError("manifest_invalid", "duplicate migration version %d", migration.Version)
		}
		seen[migration.Version] = migration.Name
		if strings.TrimSpace(migration.Name) == "" {
			return newError("manifest_invalid", "migration %d has an empty name", migration.Version)
		}
		if err := validateRelativePath(migration.File); err != nil {
			return newError("manifest_invalid", "migration %q: %v", migration.Name, err)
		}
		if err := validateChecksum(migration.Checksum); err != nil {
			return newError("manifest_invalid", "migration %q: %v", migration.Name, err)
		}
		for _, legacy := range migration.LegacyChecksums {
			if err := validateChecksum(legacy); err != nil {
				return newError("manifest_invalid", "migration %q legacy checksum: %v", migration.Name, err)
			}
		}
		switch migration.Kind {
		case "precondition":
			if i != 0 {
				return newError("manifest_invalid", "precondition must be the first migration")
			}
			if migration.Executable {
				return newError("manifest_invalid", "precondition %q must not be executable", migration.Name)
			}
		case "baseline":
			if i == 0 {
				return newError("manifest_invalid", "baseline %q must follow the role precondition", migration.Name)
			}
			if !migration.Executable {
				return newError("manifest_invalid", "baseline %q must be executable", migration.Name)
			}
		case "increment":
			if !migration.Executable {
				return newError("manifest_invalid", "increment %q must be executable", migration.Name)
			}
			if !migration.Transactional && migration.NamedRecoveryProtocol == "" {
				return newError("manifest_invalid", "non-transactional increment %q needs a named recovery protocol", migration.Name)
			}
			if migration.Catalog == "" {
				return newError("manifest_invalid", "increment %q needs a catalog checkpoint", migration.Name)
			}
			if err := validateRelativePath(migration.Catalog); err != nil {
				return newError("manifest_invalid", "increment %q catalog: %v", migration.Name, err)
			}
			if err := validateChecksum(migration.CatalogChecksum); err != nil {
				return newError("manifest_invalid", "increment %q catalog: %v", migration.Name, err)
			}
		default:
			return newError("manifest_invalid", "migration %q has unknown kind %q", migration.Name, migration.Kind)
		}
	}
	if err := validateRelativePath(m.Catalog); err != nil {
		return newError("manifest_invalid", "catalog: %v", err)
	}
	return nil
}

func (m *Manifest) verifyFiles(fsys fs.FS, root string) error {
	for _, migration := range m.All() {
		body, err := fs.ReadFile(fsys, path.Join(root, migration.File))
		if err != nil {
			return newError("migration_file_unreadable", "read %s: %v", migration.File, err)
		}
		sum := checksumBytes(body)
		if sum != migration.Checksum {
			return newError(
				"published_migration_modified",
				"migration %s has checksum %s, manifest pins %s",
				migration.Name, sum, migration.Checksum,
			)
		}
	}
	for _, migration := range m.Increments {
		if migration.Catalog == "" {
			continue
		}
		body, err := fs.ReadFile(fsys, path.Join(root, migration.Catalog))
		if err != nil {
			return newError("catalog_unreadable", "read %s: %v", migration.Catalog, err)
		}
		sum := checksumBytes(body)
		if sum != migration.CatalogChecksum {
			return newError(
				"published_migration_modified",
				"increment %s catalog has checksum %s, manifest pins %s",
				migration.Name, sum, migration.CatalogChecksum,
			)
		}
	}
	if m.CatalogChecksum != "" {
		if err := validateChecksum(m.CatalogChecksum); err != nil {
			return newError("manifest_invalid", "catalog: %v", err)
		}
		body, err := fs.ReadFile(fsys, path.Join(root, m.Catalog))
		if err != nil {
			return newError("catalog_unreadable", "read %s: %v", m.Catalog, err)
		}
		sum := checksumBytes(body)
		if sum != m.CatalogChecksum {
			return newError(
				"published_migration_modified",
				"baseline catalog has checksum %s, manifest pins %s",
				sum, m.CatalogChecksum,
			)
		}
	}
	return nil
}

func LoadCatalog(fsys fs.FS, root, catalogPath string) (*Catalog, []byte, error) {
	body, err := fs.ReadFile(fsys, path.Join(cleanRoot(root), catalogPath))
	if err != nil {
		return nil, nil, newError("catalog_unreadable", "read %s: %v", catalogPath, err)
	}
	var catalog Catalog
	if err := json.Unmarshal(body, &catalog); err != nil {
		return nil, nil, newError("catalog_invalid", "decode %s: %v", catalogPath, err)
	}
	return &catalog, body, nil
}

func (m *Manifest) CatalogForVersion(version int64) (string, string, error) {
	var maxBaseline int64
	for _, migration := range m.Baseline {
		if migration.Version > maxBaseline {
			maxBaseline = migration.Version
		}
	}
	if version < maxBaseline {
		return "", "", newError("catalog_missing", "no catalog checkpoint covers version %d", version)
	}
	path, checksum := m.Catalog, m.CatalogChecksum
	bestVersion := maxBaseline
	for _, migration := range m.Increments {
		if migration.Version > version {
			continue
		}
		if migration.Catalog == "" {
			return "", "", newError(
				"catalog_missing",
				"applied increment %q has no catalog checkpoint",
				migration.Name,
			)
		}
		if migration.Version >= bestVersion {
			bestVersion = migration.Version
			path = migration.Catalog
			checksum = migration.CatalogChecksum
		}
	}
	if path == "" || checksum == "" {
		return "", "", newError("catalog_missing", "no catalog checkpoint for version %d", version)
	}
	return path, checksum, nil
}

func validateRelativePath(p string) error {
	if strings.TrimSpace(p) == "" {
		return fmt.Errorf("path is empty")
	}
	if path.IsAbs(p) || strings.Contains(p, "\\") {
		return fmt.Errorf("path %q must be relative and use forward slashes", p)
	}
	cleaned := path.Clean(p)
	if cleaned == "." || strings.HasPrefix(cleaned, "../") || cleaned == ".." {
		return fmt.Errorf("path %q escapes the migration root", p)
	}
	return nil
}

func validateChecksum(value string) error {
	if !strings.HasPrefix(value, checksumPrefix) {
		return fmt.Errorf("checksum %q must start with %s", value, checksumPrefix)
	}
	hexPart := strings.TrimPrefix(value, checksumPrefix)
	if len(hexPart) != sha256.Size*2 {
		return fmt.Errorf("checksum %q must contain %d hex characters", value, sha256.Size*2)
	}
	if _, err := hex.DecodeString(hexPart); err != nil {
		return fmt.Errorf("checksum %q is not valid hex", value)
	}
	return nil
}

func checksumBytes(body []byte) string {
	sum := sha256.Sum256(body)
	return checksumPrefix + hex.EncodeToString(sum[:])
}
