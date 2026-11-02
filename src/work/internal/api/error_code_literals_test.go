package api_test

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/apierr"
)

// apiErrLiteral matches the handler-side entry point into the error catalogue. The codes
// reach the wire as string literals, so nothing else checks them.
var apiErrLiteral = regexp.MustCompile(`apierr\.New\("([a-z_][a-z0-9_]*)"\)`)

// TestEveryHandlerErrorCodeIsRegistered is the closed-set guard for the Go side of the
// contract, mirroring what TestEveryPublishedRaiseIsRegistered does for the SQL side.
//
// apierr.New does not refuse an unknown code: it falls back to 503 service_degraded, so a
// typo in a handler is not a compile error, not a failing test, and not even an obviously
// wrong response - it is a retryable 503 for a request the server meant to answer with a
// 400 or a 409, and the client is told to try again. TestNewFallsBackToServiceDegraded
// proves that fallback exists; this proves no handler depends on it.
func TestEveryHandlerErrorCodeIsRegistered(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("this guard reads the package's own source: %v", err)
	}
	catalog := apierr.Default()
	sites := 0
	unregistered := map[string]string{}

	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") ||
			strings.HasSuffix(name, "_test.go") {
			continue
		}
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range apiErrLiteral.FindAllStringSubmatch(string(body), -1) {
			sites++
			code := match[1]
			if _, ok := catalog.Public[code]; !ok {
				unregistered[code] = name
			}
		}
	}

	// A guard that stopped matching anything is worse than no guard, because it reports
	// the surface as checked.
	if sites == 0 {
		t.Fatal("no apierr.New literal found: the pattern no longer matches the handlers")
	}
	if len(unregistered) > 0 {
		var codes []string
		for code := range unregistered {
			codes = append(codes, code+" ("+unregistered[code]+")")
		}
		sort.Strings(codes)
		t.Fatalf("handler error codes with no public entry, each silently served as 503: %s",
			strings.Join(codes, ", "))
	}
}
