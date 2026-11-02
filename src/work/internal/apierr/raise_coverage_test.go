package apierr

import (
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"testing"

	embedded "github.com/we-meet/work/migrations"
)

// raiseName matches the code a migration raises. PostgreSQL reports everything
// before the first colon, which is exactly what FromDB keys on.
var raiseName = regexp.MustCompile(`RAISE EXCEPTION\s+'([a-z][a-z0-9_]*)`)

// raiseState matches the SQLSTATE that same RAISE asks for, which is what FromDB's
// fallback branch reads when the catalogue has no entry for the code.
var raiseState = regexp.MustCompile(`ERRCODE\s*=\s*'([0-9A-Za-z]{5})'`)

// publishedRaiseByOrigin walks the shipped migration chain - the increments that are
// actually applied, not the design draft the R0a gate scanned - and records for every
// literal RAISE code whether the baseline or a later increment introduced it, plus the
// SQLSTATE each site requests.
type raiseOrigin struct {
	incrementsOnly bool
	sqlStates      map[string]int
}

func publishedRaises(t *testing.T) map[string]*raiseOrigin {
	t.Helper()
	observed := map[string]*raiseOrigin{}

	err := fs.WalkDir(embedded.FS, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".sql") {
			return nil
		}
		body, err := fs.ReadFile(embedded.FS, path)
		if err != nil {
			return err
		}
		fromBaseline := strings.HasPrefix(path, "baseline")
		for _, match := range raiseName.FindAllStringSubmatchIndex(string(body), -1) {
			code := string(body[match[2]:match[3]])
			// The SQLSTATE belongs to this RAISE statement, which ends at the first
			// semicolon. A raise with no USING clause is recorded under "" because
			// PostgreSQL then reports the default P0000, which is not one of the four
			// states FromDB falls back on.
			end := strings.Index(string(body[match[0]:]), ";")
			tail := string(body[match[0] : match[0]+end])
			state := ""
			if found := raiseState.FindStringSubmatch(tail); found != nil {
				state = found[1]
			}
			origin, ok := observed[code]
			if !ok {
				origin = &raiseOrigin{incrementsOnly: true, sqlStates: map[string]int{}}
				observed[code] = origin
			}
			if fromBaseline {
				origin.incrementsOnly = false
			}
			origin.sqlStates[state]++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return observed
}

// TestEveryPublishedRaiseIsRegistered refuses any migration that raises a code with no
// catalogue entry.
//
// This gate used to allow a debt list, because increments 0003-0016 had introduced 66 codes
// the published contract never covered: the R0a scan only looked at the draft SQL, so each
// side looked consistent in isolation while FromDB was quietly deciding client statuses by
// SQLSTATE. Those 66 are now mapped to exactly what the fallback already produced, so the
// exemption is gone and an unmapped raise cannot come back.
func TestEveryPublishedRaiseIsRegistered(t *testing.T) {
	catalog := Default()
	unknown := map[string]string{}

	for code := range publishedRaises(t) {
		if _, ok := catalog.DBExceptionMap[code]; ok {
			continue
		}
		unknown[code] = "raised in the published chain"
	}
	if len(unknown) == 0 {
		return
	}
	var names []string
	for code := range unknown {
		names = append(names, code)
	}
	sort.Strings(names)
	t.Fatalf("RAISE codes with no db_exception_map entry: %s", strings.Join(names, ", "))
}

// TestIncrementGuardsKeepTheirFallbackStatus is the rule that made registering those 66
// codes safe to do in a batch: a code introduced after the baseline may map only to its own
// name (a guard that raises a public code verbatim) or to one of the two codes the SQLSTATE
// fallback already produced. Anything else means somebody assigned a nicer status to a
// shipped guard inside a mapping change, which moves a response on the published surface
// without anyone deciding it - the mistake this catalogue's own rules forbid.
//
// A decided status change is still available, but it has to be made the visible way: add the
// code to public with a message, and say so in the contract's rules. That is exactly how the
// one real divergence in the 66 was closed: increment 0022 split the organization-execution
// guard, raising the new public org_operator_suspended (409, not retryable) for a deliberate
// operator suspension while leaving the provisioning states on the retryable 503 they have
// always produced. The test above is what makes the first version of that split - quietly
// re-mapping a shipped guard to a nicer status - impossible.
func TestIncrementGuardsKeepTheirFallbackStatus(t *testing.T) {
	catalog := Default()
	var drifted []string

	for code, origin := range publishedRaises(t) {
		if !origin.incrementsOnly {
			continue
		}
		target, ok := catalog.DBExceptionMap[code]
		if !ok {
			continue // refused by TestEveryPublishedRaiseIsRegistered
		}
		if target == code || target == "service_degraded" || target == "invalid_request" {
			continue
		}
		drifted = append(drifted, code+" -> "+target)
	}
	if len(drifted) > 0 {
		sort.Strings(drifted)
		t.Fatalf("increment guards mapped to a status other than their own public code or the "+
			"SQLSTATE fallback (this changes a shipped response; decide it in public instead): %s",
			strings.Join(drifted, ", "))
	}
}
