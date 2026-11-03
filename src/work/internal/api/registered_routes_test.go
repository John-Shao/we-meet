package api_test

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The guard sweeps need the list of routes that actually exist. Reading it out of the OpenAPI file
// was the wrong source of truth: the asset is not at a predictable relative path when the test
// binary runs from its package directory in CI, so the sweep failed to find its own input and
// reported a false red (the first run did exactly that). What a guard test should sweep is the
// router's own registrations, and those are right here in the package source.
//
// So this parses internal/api itself: every mux.HandleFunc("METHOD " + Path) line, with the path
// constants resolved through their string-concatenation chain (ArtifactContentPath is
// ArtifactVersionPath + "/content"). The set is a superset of the R0a contract - it includes the
// /work/v2 faces registered in the same router - which is the correct scope for a session and
// CSRF guard: every entry point must hold the line, not only the ones already signed off.

type registeredRoute struct {
	method string
	path   string
}

var (
	// A path constant may sit in a const block or carry its own const keyword on one line.
	constPattern   = regexp.MustCompile(`(?m)^\s*(?:const\s+)?([A-Za-z][A-Za-z0-9]*Path)\s*=\s*([^#\n]+?)(?:\s*//.*)?$`)
	handlerPattern = regexp.MustCompile(`mux\.HandleFunc\("(GET|POST|PATCH|PUT|DELETE) ?([^"]*)"(?:\s*\+\s*([A-Za-z][A-Za-z0-9]*))?`)
)

// packageStrings resolves every *Path constant in the non-test sources of this package, repeating
// until nothing changes so chained definitions settle.
func packageStrings(t *testing.T) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package directory: %v", err)
	}
	raw := map[string]string{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		for _, match := range constPattern.FindAllStringSubmatch(string(body), -1) {
			raw[match[1]] = match[2]
		}
	}
	resolved := map[string]string{}
	for pass := 0; pass < 6 && len(resolved) < len(raw); pass++ {
		for name, expression := range raw {
			if _, done := resolved[name]; done {
				continue
			}
			if value, ok := evaluateConcat(expression, resolved); ok {
				resolved[name] = value
			}
		}
	}
	if len(resolved) != len(raw) {
		var missing []string
		for name := range raw {
			if _, ok := resolved[name]; !ok {
				missing = append(missing, name)
			}
		}
		sort.Strings(missing)
		t.Fatalf("could not resolve the path constants %s; a guard sweep that silently misses a "+
			"route is worse than one that stops", strings.Join(missing, ", "))
	}
	return resolved
}

func evaluateConcat(expression string, known map[string]string) (string, bool) {
	out := strings.Builder{}
	for _, part := range strings.Split(expression, "+") {
		part = strings.TrimSpace(part)
		switch {
		case strings.HasPrefix(part, `"`) && strings.HasSuffix(part, `"`):
			out.WriteString(strings.Trim(part, `"`))
		default:
			value, ok := known[part]
			if !ok {
				return "", false
			}
			out.WriteString(value)
		}
	}
	return out.String(), true
}

func registeredRoutes(t *testing.T) []registeredRoute {
	t.Helper()
	constants := packageStrings(t)
	body, err := os.ReadFile("bootstrap.go")
	if err != nil {
		t.Fatalf("reading the router registrations: %v", err)
	}
	var routes []registeredRoute
	for _, match := range handlerPattern.FindAllStringSubmatch(string(body), -1) {
		path := match[2]
		if match[3] != "" {
			value, ok := constants[match[3]]
			if !ok {
				t.Fatalf("registration references %s, which the constant scan did not resolve", match[3])
			}
			path += value
		}
		if path == "/healthz" {
			// The liveness probe is deliberately public; everything else on this router is a
			// member-facing surface.
			continue
		}
		routes = append(routes, registeredRoute{match[1], path})
	}
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].path != routes[j].path {
			return routes[i].path < routes[j].path
		}
		return routes[i].method < routes[j].method
	})
	if len(routes) < 33 {
		t.Fatalf("parsed only %d routes from bootstrap.go; the parser has stopped matching, and a "+
			"guard sweep that misses routes still reports green", len(routes))
	}
	return routes
}

// guardURL fills path parameters so the request reaches the guards; the guard runs before any
// lookup, so a well-formed id is enough.
func guardURLFor(path string) string {
	return regexp.MustCompile(`\{[^}]+\}`).ReplaceAllString(path, guardFixtureUUID)
}
