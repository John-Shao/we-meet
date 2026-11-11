package migrate

// #87 guard: the baseline hardening survives every CREATE OR REPLACE.
//
// baseline/0002:5163-5177 walks the whole work schema once it is assembled and puts two attributes
// on every function - SECURITY DEFINER and SET search_path = work, pg_catalog. A later
// CREATE OR REPLACE rebuilds the pg_proc row from the statement text alone, and neither attribute
// is inherited from the row being replaced. So the same statement that fixes a predicate can, with
// no error and no drift signal, hand the function back to invoker rights with an unpinned
// search_path - which is how 0031 made work-export log `permission denied for table audit_export
// (SQLSTATE 42501)` on every poll in production for hours, and how 0017 quietly did the same to a
// trigger guard.
//
// Two published facts make this checkable instead of advisory: every increment pins a catalog
// checkpoint that records prosecdef and proconfig, and every increment ships as text. The rule is
// therefore derived from the chain itself - no hand-kept list of functions that "ought" to be
// definers - and it runs without a database, so it fails at review time rather than at rollout.

import (
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"testing"

	embedded "github.com/we-meet/work/migrations"
)

var (
	createOrReplaceRE = regexp.MustCompile(`(?i)CREATE\s+OR\s+REPLACE\s+FUNCTION\s+work\.([a-zA-Z0-9_]+)`)
	securityDefinerRE = regexp.MustCompile(`(?i)\bSECURITY\s+DEFINER\b`)
	searchPathPinRE   = regexp.MustCompile(`(?i)\bSET\s+search_path\s*=\s*[^;]*\bwork\b`)
	sqlLineCommentRE  = regexp.MustCompile(`--([^\n]*)`)
	// hardeningNames pins that this guard still covers the two functions #87 was written about.
	hardeningNames = []string{"list_pending_audit_exports", "artifact_version_immutable_content"}
	// chainBefore0034 is the truncated chain used by the non-vacuity test below.
	chainBefore0034 = int64(33)
)

// checkpoint is one catalog snapshot reduced to the two attributes this rule reads.
type checkpoint struct {
	version  int64
	file     string
	hardened map[string]bool // function name -> SECURITY DEFINER recorded in that snapshot
	pinned   map[string]bool // function name -> configuration names work
	present  map[string]bool // function name -> exists in that snapshot
}

func readCheckpoint(t *testing.T, version int64, file string) checkpoint {
	t.Helper()
	catalog, _, err := LoadCatalog(embedded.FS, ".", file)
	if err != nil {
		t.Fatal(err)
	}
	item := checkpoint{
		version:  version,
		file:     file,
		hardened: map[string]bool{},
		pinned:   map[string]bool{},
		present:  map[string]bool{},
	}
	for _, function := range catalog.Functions {
		item.present[function.Name] = true
		item.hardened[function.Name] = function.SecurityDefiner
		item.pinned[function.Name] = strings.Contains(function.Configuration, "search_path=work")
	}
	return item
}

func publishedCheckpoints(t *testing.T, manifest *Manifest) []checkpoint {
	t.Helper()
	// The baseline checkpoint is the pre-state for the first increment.
	items := []checkpoint{readCheckpoint(t, 2, manifest.Catalog)}
	for _, increment := range manifest.Increments {
		if increment.Catalog == "" {
			t.Fatalf("increment %d (%s) publishes no catalog checkpoint", increment.Version, increment.Name)
		}
		items = append(items, readCheckpoint(t, increment.Version, increment.Catalog))
	}
	return items
}

// rewrite holds, for one function, the clause region of the last CREATE OR REPLACE that touches it.
type rewrite struct {
	version int64
	file    string
	clauses string
}

// lastRewrites reads every published increment and keeps, per function, the clause region of its
// highest-numbered rewrite. The clause region is the text between CREATE OR REPLACE FUNCTION and the
// "AS $$" that opens the body, which is where SECURITY DEFINER and SET search_path can appear and
// nowhere else - matching there is what keeps a comment or a neighbouring statement from satisfying
// the rule, so comments are stripped first.
func lastRewrites(t *testing.T, manifest *Manifest, maxVersion int64) map[string]rewrite {
	t.Helper()
	out := map[string]rewrite{}
	for _, increment := range manifest.Increments {
		if increment.Version > maxVersion {
			continue
		}
		raw, err := fs.ReadFile(embedded.FS, increment.File)
		if err != nil {
			t.Fatal(err)
		}
		text := string(raw)
		for _, match := range createOrReplaceRE.FindAllStringSubmatchIndex(text, -1) {
			name := text[match[2]:match[3]]
			rest := text[match[1]:]
			body := strings.Index(rest, "AS $")
			if body < 0 {
				t.Fatalf("%s work.%s: CREATE OR REPLACE with no \"AS $\" body marker - this guard cannot see "+
					"which clauses the statement carries, so teach it the new shape instead of letting it skip",
					increment.Name, name)
			}
			clauses := sqlLineCommentRE.ReplaceAllString(rest[:body], "")
			if existing, seen := out[name]; !seen || increment.Version >= existing.version {
				out[name] = rewrite{version: increment.Version, file: increment.Name, clauses: clauses}
			}
		}
	}
	return out
}

// everHardenedAndTail reduces a checkpoint window to the two facts this rule reads: which names the
// chain ever recorded as SECURITY DEFINER, and the last checkpoint at or below maxVersion. Both the
// gap walk and the coverage count are computed from this one reduction, so the gate that decides
// which names are checked cannot drift away from the count that proves the gate is not emptying the
// guard.
func everHardenedAndTail(checkpoints []checkpoint, maxVersion int64) (map[string]bool, checkpoint) {
	ever := map[string]bool{}
	tail := checkpoint{hardened: map[string]bool{}, pinned: map[string]bool{}, present: map[string]bool{}}
	for _, item := range checkpoints {
		if item.version > maxVersion {
			continue
		}
		tail = item
		for name, definer := range item.hardened {
			if definer {
				ever[name] = true
			}
		}
	}
	return ever, tail
}

// hardeningCoverage counts, for one window, the names whose last rewrite the clause check actually
// reads and the names it skips because the chain dropped them before that window's tail.
func hardeningCoverage(checkpoints []checkpoint, rewrites map[string]rewrite, maxVersion int64) (checked int, dropped int) {
	ever, tail := everHardenedAndTail(checkpoints, maxVersion)
	for name := range ever {
		if _, rewritten := rewrites[name]; !rewritten {
			continue
		}
		if tail.present[name] {
			checked++
			continue
		}
		dropped++
	}
	return checked, dropped
}

// hardeningGaps returns the names the chain once hardened and no longer has, given a checkpoint
// window and a rewrite map computed over the same window.
//
// Ruling G1 (2026-11-11) puts the tail-presence gate ahead of the clause check. The rule is about
// functions that exist in the chain: a name the chain dropped (0038 dropped the 0037 overloads, and
// createOrReplaceRE keys bare names, so a same-name overload that survives in the rewrite map is not
// evidence the function is still there) has no live pg_proc row to leave unpinned, and requiring its
// clauses anyway turned a revert into a permanent red with nothing left to fix. A rewrite that drops
// the clauses on a function that is still present at the tail stays red, and hardeningCoverage is the
// assertion that this gate has not quietly emptied the check.
func hardeningGaps(checkpoints []checkpoint, rewrites map[string]rewrite, maxVersion int64) []string {
	ever, tail := everHardenedAndTail(checkpoints, maxVersion)
	gaps := []string{}
	for name := range ever {
		fresh, rewritten := rewrites[name]
		if !rewritten {
			continue
		}
		if !tail.present[name] {
			continue
		}
		missing := []string{}
		if !securityDefinerRE.MatchString(fresh.clauses) {
			missing = append(missing, "SECURITY DEFINER")
		}
		if !searchPathPinRE.MatchString(fresh.clauses) {
			missing = append(missing, "SET search_path = work, pg_catalog")
		}
		if len(missing) > 0 {
			gaps = append(gaps, fmt.Sprintf("%s: %s drops %s", name, fresh.file, strings.Join(missing, " + ")))
			continue
		}
		if !tail.hardened[name] {
			gaps = append(gaps, fmt.Sprintf("%s: checkpoint %s records security_definer=false", name, tail.file))
		}
		if !tail.pinned[name] {
			gaps = append(gaps, fmt.Sprintf("%s: checkpoint %s lost the search_path pin", name, tail.file))
		}
	}
	sort.Strings(gaps)
	return gaps
}

func TestCreateOrReplaceRestatesFunctionHardening(t *testing.T) {
	manifest, err := LoadManifest(embedded.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	checkpoints := publishedCheckpoints(t, manifest)
	if len(checkpoints) < 30 {
		t.Fatalf("read %d checkpoints, want the whole published chain", len(checkpoints))
	}
	tailVersion := checkpoints[len(checkpoints)-1].version
	rewrites := lastRewrites(t, manifest, tailVersion)

	ever := map[string]bool{}
	for _, item := range checkpoints {
		for name, definer := range item.hardened {
			if definer {
				ever[name] = true
			}
		}
	}
	if len(ever) < 80 {
		t.Fatalf("only %d functions ever recorded as SECURITY DEFINER - the checkpoints are not being read",
			len(ever))
	}
	if len(rewrites) < 20 {
		t.Fatalf("only %d CREATE OR REPLACE statements parsed across the published increments", len(rewrites))
	}
	for _, name := range hardeningNames {
		if !ever[name] {
			t.Fatalf("%s is not recorded as SECURITY DEFINER in any checkpoint, so this guard stopped "+
				"covering the pair #87 is about", name)
		}
		if _, rewritten := rewrites[name]; !rewritten {
			t.Fatalf("%s is not rewritten by any increment, so the restatement half of this guard is "+
				"no longer watching it", name)
		}
	}

	// Ruling G1's cost has to be paid in the open: the tail-presence gate is only safe while it still
	// lets a lot of names through. Reading on 2026-11-11, over the whole published chain at tail 39,
	// this is 27 checked against 1 dropped - recount with
	// `go test ./internal/migrate -run TestCreateOrReplaceRestatesFunctionHardening -v`.
	checked, dropped := hardeningCoverage(checkpoints, rewrites, tailVersion)
	if checked < 20 {
		t.Fatalf("only %d functions the chain ever hardened are still present at the tail and rewritten (%d skipped "+
			"as dropped) - the clause check has been narrowed to near nothing, so the tail-presence gate needs a new "+
			"non-vacuity argument rather than a lower floor (#87, ruling G1)", checked, dropped)
	}

	if gaps := hardeningGaps(checkpoints, rewrites, tailVersion); len(gaps) > 0 {
		t.Fatalf("functions the chain hardened once and lost again:\n  %s\n"+
			"CREATE OR REPLACE does not inherit SECURITY DEFINER or SET search_path from the function it "+
			"replaces, so a rewrite must restate both - or restore them in a later increment (#87).",
			strings.Join(gaps, "\n  "))
	}
}

// TestCreateOrReplaceHardeningGuardFiresOnThe0033Chain is the non-vacuity half: the same predicate
// read over the published chain truncated at 0033 must name exactly the two functions 0034 restores.
// The historical state is the fixture, so this reds if the matcher loses its teeth, if 0034 is
// dropped, or if the published history is ever rewritten.
func TestCreateOrReplaceHardeningGuardFiresOnThe0033Chain(t *testing.T) {
	manifest, err := LoadManifest(embedded.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	gaps := hardeningGaps(
		publishedCheckpoints(t, manifest), lastRewrites(t, manifest, chainBefore0034), chainBefore0034)
	names := []string{}
	for _, gap := range gaps {
		names = append(names, strings.SplitN(gap, ":", 2)[0])
	}
	want := []string{"artifact_version_immutable_content", "list_pending_audit_exports"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("the rule over the chain up to 0033 flags %v, want exactly %v - the two downgrades 0034 "+
			"restores are the whole reason this guard exists", names, want)
	}
	if len(gaps) != 2 {
		t.Fatalf("got %d gap lines, want one per downgrade: %v", len(gaps), gaps)
	}
}

// TestHardeningGapsGateOnlyExcusesDroppedFunctions is the non-vacuity half of the G1 ordering itself,
// on a synthesized window rather than the published chain: dropping both clauses on a function the
// tail still has must stay red, losing the pin in the tail catalog must stay red through the catalog
// half, and a name the tail no longer has must be the only thing the new gate excuses. Without the
// first two the gate excuses everything; without the third it does nothing, and the coverage floor in
// the main test reads the same two counters this test pins.
func TestHardeningGapsGateOnlyExcusesDroppedFunctions(t *testing.T) {
	restated := " RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = work, pg_catalog "
	downgraded := " RETURNS trigger LANGUAGE plpgsql "
	early := checkpoint{
		version: 39, file: "0039_early.json",
		hardened: map[string]bool{"kept_fn": true, "dropped_fn": true, "unpinned_fn": true},
		pinned:   map[string]bool{"kept_fn": true, "dropped_fn": true, "unpinned_fn": true},
		present:  map[string]bool{"kept_fn": true, "dropped_fn": true, "unpinned_fn": true},
	}
	tail := checkpoint{
		version: 40, file: "0040_tail.json",
		hardened: map[string]bool{"kept_fn": true, "unpinned_fn": false},
		pinned:   map[string]bool{"kept_fn": true, "unpinned_fn": true},
		present:  map[string]bool{"kept_fn": true, "unpinned_fn": true},
	}
	window := []checkpoint{early, tail}
	rewrites := map[string]rewrite{
		"kept_fn":     {version: 40, file: "0040_kept.sql", clauses: downgraded},
		"dropped_fn":  {version: 39, file: "0039_dropped.sql", clauses: downgraded},
		"unpinned_fn": {version: 40, file: "0040_unpinned.sql", clauses: restated},
	}

	gaps := hardeningGaps(window, rewrites, 40)
	names := []string{}
	for _, gap := range gaps {
		names = append(names, strings.SplitN(gap, ":", 2)[0])
	}
	if strings.Join(names, ",") != "kept_fn,unpinned_fn" {
		t.Fatalf("gaps = %v, want exactly kept_fn and unpinned_fn - the clause half and the catalog half both have "+
			"to stay in force for functions the tail still has, and dropped_fn is the only excusable name", names)
	}
	if len(gaps) != 2 {
		t.Fatalf("got %d gap lines, want one per failing function: %v", len(gaps), gaps)
	}
	checked, dropped := hardeningCoverage(window, rewrites, 40)
	if checked != 2 || dropped != 1 {
		t.Fatalf("coverage = %d checked / %d dropped, want 2 / 1", checked, dropped)
	}
}

// TestHardeningGateExcusesOnlyNamesTheChainDropped is the real-history half of the G1 argument: the
// published chain frozen at 0037 must name both record_member_narrowing overloads (that is when the
// pin was genuinely lost), the chain at 0038 must keep naming the zero-arg function while stopping on
// the overload 0038 dropped, and 0039 must be clean. Unlike a coverage count these windows are frozen
// history, so they cannot drift - they pin the exact boundary of what the new gate is allowed to
// excuse.
func TestHardeningGateExcusesOnlyNamesTheChainDropped(t *testing.T) {
	manifest, err := LoadManifest(embedded.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	checkpoints := publishedCheckpoints(t, manifest)
	cases := []struct {
		max  int64
		want []string
	}{
		{37, []string{"record_member_narrowing", "record_member_narrowing_with_intents"}},
		{38, []string{"record_member_narrowing"}},
		{39, []string{}},
	}
	for _, item := range cases {
		gaps := hardeningGaps(checkpoints, lastRewrites(t, manifest, item.max), item.max)
		names := []string{}
		for _, gap := range gaps {
			names = append(names, strings.SplitN(gap, ":", 2)[0])
		}
		if strings.Join(names, ",") != strings.Join(item.want, ",") {
			t.Errorf("the rule over the chain up to %d flags %v, want exactly %v", item.max, names, item.want)
		}
	}
}
