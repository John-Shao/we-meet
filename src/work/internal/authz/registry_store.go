package authz

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"os"
	"sync/atomic"
	"time"
)

// DefaultRegistryWatchInterval is how quickly an edited workload registry takes
// effect. Revocation has to be usable during an incident, so the delay is
// seconds, not "at the next restart".
const DefaultRegistryWatchInterval = 5 * time.Second

type registrySnapshot struct {
	verifier  *RegistryVerifier
	digest    string
	workloads int
}

// RegistryStore serves workload identities out of a JSON registry file that may
// be replaced while the process runs.
//
// It exists because the fingerprint list is the only revocation surface this
// deployment has (no CRL, no OCSP): without a reload, removing a compromised
// workload's certificate meant restarting work-authz, and the restart window is
// exactly when an operator will not touch a shared service. Editing the file is
// now the revoke operation, so "listed" and "accepted" cannot drift.
type RegistryStore struct {
	path    string
	current atomic.Pointer[registrySnapshot]
}

// LoadRegistryStore reads the registry once and refuses to start on a file that
// does not describe at least one workload: a service that comes up accepting
// nobody looks healthy while denying every caller.
func LoadRegistryStore(path string) (*RegistryStore, error) {
	store := &RegistryStore{path: path}
	snapshot, err := readRegistry(path)
	if err != nil {
		return nil, err
	}
	store.current.Store(snapshot)
	return store, nil
}

func (s *RegistryStore) Verify(ctx context.Context, certificate *x509.Certificate) (Caller, error) {
	return s.current.Load().verifier.Verify(ctx, certificate)
}

// State reports the digest of the registry bytes currently in force and how many
// workloads it lists. The digest is what makes a reload auditable: it can be
// compared with the digest of the file on disk without parsing either one.
func (s *RegistryStore) State() (digest string, workloads int) {
	snapshot := s.current.Load()
	return snapshot.digest, snapshot.workloads
}

// Reload replaces the registry when the file changed. A file that fails to parse,
// lists no workload or repeats a fingerprint is refused and the last accepted
// registry stays in force: the registry is the authentication path, so a typo
// must not turn into an outage.
func (s *RegistryStore) Reload() (changed bool, err error) {
	snapshot, err := readRegistry(s.path)
	if err != nil {
		return false, err
	}
	current := s.current.Load()
	if current.digest == snapshot.digest {
		return false, nil
	}
	s.current.Store(snapshot)
	return true, nil
}

// Watch reloads on an interval until ctx is done and reports only the events
// worth a log line: an accepted swap, or the first refusal of a given file
// content. Repeating the same refusal every tick would bury the journal in
// identical warnings and, if the warning ever feeds an alert rule, page on a
// static condition.
func (s *RegistryStore) Watch(ctx context.Context, interval time.Duration, report func(changed bool, err error)) {
	if report == nil {
		report = func(bool, error) {}
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var refused string
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			changed, err := s.Reload()
			if changed {
				refused = ""
				report(true, nil)
				continue
			}
			if err == nil {
				continue
			}
			if key := err.Error(); key != refused {
				refused = key
				report(false, err)
			}
		}
	}
}

func readRegistry(path string) (*registrySnapshot, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("read workload registry")
	}
	verifier, err := LoadRegistry(body)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(body)
	return &registrySnapshot{
		verifier:  verifier,
		digest:    hex.EncodeToString(digest[:]),
		workloads: len(verifier.entries),
	}, nil
}
