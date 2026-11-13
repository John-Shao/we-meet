package authz_test

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/we-meet/work/internal/authz"
)

func registryJSON(entries ...string) string {
	body := `{"workloads":[`
	for i, entry := range entries {
		if i > 0 {
			body += ","
		}
		body += entry
	}
	return body + `]}`
}

func entry(certificate *x509.Certificate, kind, workloadID string) string {
	return `{"fingerprint":"` + fingerprint(certificate) + `","kind":"` + kind +
		`","workload_id":"` + workloadID + `"}`
}

func writeRegistry(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "workloads.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func replaceRegistry(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func digestOf(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

// TestRegistryStoreRefusesToStartAcceptingNobody pins the startup half of the
// revocation surface: a registry file that lists nothing, parses badly or is
// missing must stop work-authz at boot. A service that comes up with an empty
// list reports healthy while denying every caller, which is the failure mode a
// reload guard is supposed to prevent rather than cause.
func TestRegistryStoreRefusesToStartAcceptingNobody(t *testing.T) {
	parent := newCertificate(t, "runtime-parent-1")
	valid := registryJSON(entry(parent, "runtime_parent", "parent-workload"))

	for name, body := range map[string]string{
		"empty list":    `{"workloads":[]}`,
		"broken json":   `{"workloads":[`,
		"unknown field": `{"workloads":[],"extra":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := authz.LoadRegistryStore(writeRegistry(t, body)); err == nil {
				t.Fatalf("registry %q was accepted at startup", body)
			}
		})
	}
	t.Run("missing file", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "workloads.json")
		if _, err := authz.LoadRegistryStore(missing); err == nil {
			t.Fatal("absent registry was accepted at startup")
		}
	})

	store, err := authz.LoadRegistryStore(writeRegistry(t, valid))
	if err != nil {
		t.Fatal(err)
	}
	if digest, workloads := store.State(); digest != digestOf(valid) || workloads != 1 {
		t.Fatalf("state = %s/%d, want %s/1", digest, workloads, digestOf(valid))
	}
}

// TestRegistryStoreRevocationIsOneIdentity is the negative test the 丙 ruling
// demands: dropping a fingerprint from workloads.json must make that one caller
// refuse at the next load while every other listed workload keeps resolving. A
// reload that revokes the whole list is not a revocation surface, it is an
// outage, and it would pass a test that only checks "the removed one fails".
func TestRegistryStoreRevocationIsOneIdentity(t *testing.T) {
	parent := newCertificate(t, "runtime-parent-1")
	egress := newCertificate(t, "egress-1")
	path := writeRegistry(t, registryJSON(
		entry(parent, "runtime_parent", "parent-workload"),
		entry(egress, "egress", "egress-workload"),
	))
	store, err := authz.LoadRegistryStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Verify(context.Background(), parent); err != nil {
		t.Fatalf("parent before revocation: %v", err)
	}

	replaceRegistry(t, path, registryJSON(entry(egress, "egress", "egress-workload")))
	changed, err := store.Reload()
	if err != nil || !changed {
		t.Fatalf("reload after revocation = %v, %v", changed, err)
	}
	if _, err := store.Verify(context.Background(), parent); !errors.Is(err, authz.ErrUnknownWorkload) {
		t.Fatalf("revoked parent error = %v, want ErrUnknownWorkload", err)
	}
	caller, err := store.Verify(context.Background(), egress)
	if err != nil {
		t.Fatalf("listed egress caller refused: %v", err)
	}
	if caller.WorkloadID != "egress-workload" {
		t.Fatalf("caller = %#v, want egress-workload", caller)
	}
	if _, workloads := store.State(); workloads != 1 {
		t.Fatalf("workload count after revocation = %d, want 1", workloads)
	}
}

// TestRegistryStoreReloadSurvivesHandler pins that the revoked identity is
// refused on the request path, not only in the verifier: the handler reports
// unauthorized_caller for the removed certificate while a still-listed one gets
// past authentication and is refused (if at all) for a different reason.
func TestRegistryStoreReloadSurvivesHandler(t *testing.T) {
	parent := newCertificate(t, "runtime-parent-1")
	egress := newCertificate(t, "egress-1")
	path := writeRegistry(t, registryJSON(
		entry(parent, "runtime_parent", "parent-workload"),
		entry(egress, "egress", "egress-workload"),
	))
	store, err := authz.LoadRegistryStore(path)
	if err != nil {
		t.Fatal(err)
	}
	commands := &fakeCommands{}
	server, err := authz.NewServer(store, commands, commands)
	if err != nil {
		t.Fatal(err)
	}
	body := `{"org_id":"org_a","execution_id":"exec-1"}`

	before := post(t, server, parent, "claim_runtime_execution", body)
	if before.Code == http.StatusUnauthorized {
		t.Fatalf("parent refused before revocation: %s", before.Body.String())
	}

	replaceRegistry(t, path, registryJSON(entry(egress, "egress", "egress-workload")))
	if _, err := store.Reload(); err != nil {
		t.Fatal(err)
	}
	revoked := post(t, server, parent, "claim_runtime_execution", body)
	assertCode(t, revoked, http.StatusUnauthorized, "unauthorized_caller")

	other := post(t, server, egress, "claim_runtime_execution", body)
	if other.Code == http.StatusUnauthorized {
		t.Fatalf("listed workload refused as unknown caller: %s", other.Body.String())
	}
}

// TestRegistryStoreKeepsLastGoodRegistry is the half that makes editing the file
// safe enough to be the revoke operation: a malformed, empty or duplicate-keyed
// rewrite is refused and the previously accepted list stays in force, so a typo
// in the middle of an incident cannot darken the authentication path.
func TestRegistryStoreKeepsLastGoodRegistry(t *testing.T) {
	parent := newCertificate(t, "runtime-parent-1")
	egress := newCertificate(t, "egress-1")
	good := registryJSON(
		entry(parent, "runtime_parent", "parent-workload"),
		entry(egress, "egress", "egress-workload"),
	)
	path := writeRegistry(t, good)
	store, err := authz.LoadRegistryStore(path)
	if err != nil {
		t.Fatal(err)
	}

	for name, broken := range map[string]string{
		"broken json":   `{"workloads":[`,
		"empty list":    `{"workloads":[]}`,
		"unknown field": `{"workloads":[],"extra":1}`,
		"repeat cert": `{"workloads":[` + entry(parent, "egress", "a") + `,` +
			entry(parent, "egress", "b") + `]}`,
		"reused id": `{"workloads":[` + entry(parent, "egress", "same") + `,` +
			entry(egress, "egress", "same") + `]}`,
		"absent file": "",
	} {
		t.Run(name, func(t *testing.T) {
			if name == "absent file" {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			} else {
				replaceRegistry(t, path, broken)
			}
			changed, err := store.Reload()
			if err == nil {
				t.Fatalf("reload of %q reported no error", name)
			}
			if changed {
				t.Fatal("reload swapped in a registry it also refused")
			}
			if digest, workloads := store.State(); digest != digestOf(good) || workloads != 2 {
				t.Fatalf("state = %s/%d, want %s/2", digest, workloads, digestOf(good))
			}
			for _, certificate := range []*x509.Certificate{parent, egress} {
				if _, err := store.Verify(context.Background(), certificate); err != nil {
					t.Fatalf("last-good registry lost a workload: %v", err)
				}
			}
			replaceRegistry(t, path, good)
		})
	}
}

// TestRegistryStoreReloadOnlyCountsByteChanges separates "the file moved" from
// "the accepted list moved": re-writing identical bytes must not report a change,
// otherwise every watch tick of a config manager that rewrites unchanged files
// would log a revocation that never happened.
func TestRegistryStoreReloadOnlyCountsByteChanges(t *testing.T) {
	parent := newCertificate(t, "runtime-parent-1")
	body := registryJSON(entry(parent, "runtime_parent", "parent-workload"))
	path := writeRegistry(t, body)
	store, err := authz.LoadRegistryStore(path)
	if err != nil {
		t.Fatal(err)
	}
	replaceRegistry(t, path, body)
	if changed, err := store.Reload(); err != nil || changed {
		t.Fatalf("reload of identical bytes = %v, %v", changed, err)
	}
	reordered := registryJSON(entry(parent, "runtime_parent", "parent-workload")) + " "
	replaceRegistry(t, path, reordered)
	if changed, err := store.Reload(); err != nil || !changed {
		t.Fatalf("reload of changed bytes = %v, %v", changed, err)
	}
	if _, workloads := store.State(); workloads != 1 {
		t.Fatalf("workload count = %d, want 1", workloads)
	}
}

type watchEvent struct {
	changed bool
	err     string
}

// TestRegistryStoreWatchReportsOncePerEvent covers the journal half: an accepted
// swap is reported once, an unchanged file reports nothing, and a bad file logs
// one refusal for that content rather than one line per tick. Then cancel must
// actually stop the watcher, because a leaked reload loop keeps swapping the
// registry after the process thinks it shut down.
func TestRegistryStoreWatchReportsOncePerEvent(t *testing.T) {
	parent := newCertificate(t, "runtime-parent-1")
	egress := newCertificate(t, "egress-1")
	path := writeRegistry(t, registryJSON(entry(parent, "runtime_parent", "parent-workload")))
	store, err := authz.LoadRegistryStore(path)
	if err != nil {
		t.Fatal(err)
	}

	events := make(chan watchEvent, 32)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go store.Watch(ctx, 5*time.Millisecond, func(changed bool, err error) {
		message := ""
		if err != nil {
			message = err.Error()
		}
		events <- watchEvent{changed: changed, err: message}
	})

	replaceRegistry(t, path, registryJSON(
		entry(parent, "runtime_parent", "parent-workload"),
		entry(egress, "egress", "egress-workload"),
	))
	waitForEvent(t, events, watchEvent{changed: true})
	requireNoEvent(t, events, 100*time.Millisecond)

	const broken = `{"workloads":[`
	replaceRegistry(t, path, broken)
	waitForEvent(t, events, watchEvent{err: "workload registry is invalid"})
	requireNoEvent(t, events, 100*time.Millisecond)

	replaceRegistry(t, path, registryJSON(entry(egress, "egress", "egress-workload")))
	waitForEvent(t, events, watchEvent{changed: true})

	cancel()
	replaceRegistry(t, path, registryJSON(
		entry(egress, "egress", "egress-workload"),
		entry(parent, "runtime_parent", "parent-workload"),
	))
	requireNoEvent(t, events, 100*time.Millisecond)
}

func waitForEvent(t *testing.T, events <-chan watchEvent, want watchEvent) {
	t.Helper()
	select {
	case got := <-events:
		if got != want {
			t.Fatalf("watch event = %+v, want %+v", got, want)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("no watch event within deadline, want %+v", want)
	}
}

func requireNoEvent(t *testing.T, events <-chan watchEvent, window time.Duration) {
	t.Helper()
	select {
	case got := <-events:
		t.Fatalf("unexpected watch event %+v within %s", got, window)
	case <-time.After(window):
	}
}
