package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/we-meet/work/internal/api"
)

// The error-code audit found public codes that the control plane can produce and that no
// test anywhere asserted: grep over every *_test.go for audit_export_not_found,
// audit_export_range_invalid and download_token_invalid came back empty while all three are
// reachable through a shipped admin endpoint. A client that special-cases one of them had no
// guard against the answer silently degrading into service_degraded or into a different code.
//
// This file covers the admin-export half; the task and artifact half lives in
// request_error_surface_pg_test.go. The range rules are the interesting ones because four
// distinct conditions share one code (baseline/0002:4606-4624): an inverted window, an end
// time in the future, a start older than the organization's retention, and a window wider
// than 92 days. Each refusal below is picked so that exactly one rule can explain it, and the
// legal windows in between still have to be accepted, or an over-eager validator would pass.

func exportBody(clientRequestID, from, to, format string) string {
	return `{"client_request_id":"` + clientRequestID + `","range_from":"` + from +
		`","range_to":"` + to + `","format":"` + format + `"}`
}

func TestAuditExportRangeRulesRefuseEachConditionAlone(t *testing.T) {
	request, _ := adminExportHarness(t)
	now := time.Now().UTC()
	fmtNow := func(d time.Duration) string { return now.Add(d).Format(time.RFC3339) }

	cases := []struct {
		tag    string
		from   string
		to     string
		format string
		status int
		code   string
	}{
		// range_from >= range_to (0002:4606).
		{"inverted", fmtNow(-time.Hour), fmtNow(-2 * time.Hour), "csv",
			http.StatusUnprocessableEntity, "audit_export_range_invalid"},
		{"equal", fmtNow(-time.Hour), fmtNow(-time.Hour), "csv",
			http.StatusUnprocessableEntity, "audit_export_range_invalid"},
		// range_to in the future, with an otherwise well-ordered window (0002:4609).
		{"future", fmtNow(-2 * time.Hour), fmtNow(time.Hour), "csv",
			http.StatusUnprocessableEntity, "audit_export_range_invalid"},
		// One-day window, so only the retention rule can explain this one (0002:4619).
		{"beyond-retention", fmtNow(-400 * 24 * time.Hour), fmtNow(-399 * 24 * time.Hour), "csv",
			http.StatusUnprocessableEntity, "audit_export_range_invalid"},
		// Start sits comfortably inside the 365-day policy, so only the 92-day cap is left
		// (0002:4622). Without this row the retention case above and the cap would be
		// indistinguishable, and a validator that simply rejected wide-old windows would pass.
		{"wider-than-92-days", fmtNow(-300 * 24 * time.Hour), fmtNow(-200 * 24 * time.Hour), "csv",
			http.StatusUnprocessableEntity, "audit_export_range_invalid"},
		// Format is a shape rule, not a window rule: the SQL raises the qualified
		// invalid_request:export_format (0002:4603) and apierr.rawCode truncates at the colon.
		{"format", fmtNow(-2 * time.Hour), fmtNow(-time.Hour), "parquet",
			http.StatusBadRequest, "invalid_request"},
	}
	for _, tc := range cases {
		response := request(http.MethodPost, api.AdminAuditExportsPath,
			exportBody("range-"+tc.tag+"-000001", tc.from, tc.to, tc.format))
		assertAPICode(t, response, tc.status, tc.code)
	}

	// Just under the 92-day cap, so the wide refusal above is the cap and not a coincidence.
	ninety := request(http.MethodPost, api.AdminAuditExportsPath,
		exportBody("range-legal-90-days-001", fmtNow(-90*24*time.Hour), fmtNow(-time.Hour), "csv"))
	if ninety.StatusCode != http.StatusAccepted {
		t.Fatalf("90-day window status = %d body=%s", ninety.StatusCode, readBody(ninety))
	}
	ninety.Body.Close()

	// Just inside the default 365-day retention, with a short window: this is the probe that
	// proves the retention rule is a policy floor and not a general dislike of old data. The
	// companion refusal ("beyond-retention") is the same shape one day further back.
	boundary := request(http.MethodPost, api.AdminAuditExportsPath,
		exportBody("range-legal-retention-01", fmtNow(-364*24*time.Hour),
			fmtNow(-364*24*time.Hour+time.Hour), "json"))
	if boundary.StatusCode != http.StatusAccepted {
		t.Fatalf("window inside retention status = %d body=%s",
			boundary.StatusCode, readBody(boundary))
	}
	boundary.Body.Close()
}

func TestAuditExportNotFoundOnEveryIdAddressedRoute(t *testing.T) {
	request, _ := adminExportHarness(t)
	missing := "00000000-0000-4000-8000-0000000000ee"

	// The same unknown id is addressed by three routes. The two that resolve the row answer
	// with the export's own code, and none may leak whether the id exists in another
	// organization - the answer is the same 404 either way.
	detail := request(http.MethodGet, api.AdminAuditExportsPath+"/"+missing, "")
	assertAPICode(t, detail, http.StatusNotFound, "audit_export_not_found")
	ticket := request(http.MethodPost, api.AdminAuditExportsPath+"/"+missing+"/download-ticket", "")
	assertAPICode(t, ticket, http.StatusNotFound, "audit_export_not_found")

	// The content route is keyed on the token alone: work.redeem_audit_export_download
	// selects by download_token_hash and never looks at the path id
	// (baseline/0002:4932-4939, internal/api/admin.go:291-299). An unknown token therefore
	// answers 403 rather than 404 - and because a foreign organization's *valid* token gives
	// the identical 403, the route is not an existence oracle either way.
	unrelated := request(http.MethodGet, api.AdminAuditExportsPath+"/"+missing+"/content",
		"", "X-Download-Token", "00000000000000000000000000000000000000000000000000000000000000ff")
	assertAPICode(t, unrelated, http.StatusForbidden, "download_token_invalid")

	// Id shape is checked before the token: a malformed segment is a 404 even with no header
	// at all, which is the guard at admin.go:279-282 and not the database.
	malformed := request(http.MethodGet, api.AdminAuditExportsPath+"/not-a-uuid/content", "")
	assertAPICode(t, malformed, http.StatusNotFound, "audit_export_not_found")
}

func TestDownloadTokenWrongValueIsRefusedWithoutBurningTheGrant(t *testing.T) {
	request, dbName := adminExportHarness(t)

	created := request(http.MethodPost, api.AdminAuditExportsPath,
		adminExportBody("token-invalid-00001"))
	if created.StatusCode != http.StatusAccepted {
		t.Fatalf("create status = %d body=%s", created.StatusCode, readBody(created))
	}
	exportID := decodeExportID(t, created)
	if exportID == "" {
		t.Fatal("create returned no export id")
	}
	markExportReady(t, dbName, exportID)

	// A real, unspent ticket now exists; each request below presents something else. The
	// grant must survive the failed guesses, which is the same fail-closed property the probe
	// nonce has (provider_probe_grant_guard) and here it is the admin's own download.
	token := issuedToken(t, request, exportID)
	guesses := []struct {
		tag    string
		header []string
	}{
		{"absent", nil},
		{"empty", []string{"X-Download-Token", "   "}},
		{"wrong-value", []string{"X-Download-Token", "f" + token[1:]}},
	}
	for _, guess := range guesses {
		response := request(http.MethodGet,
			api.AdminAuditExportsPath+"/"+exportID+"/content", "", guess.header...)
		assertAPICode(t, response, http.StatusForbidden, "download_token_invalid")
	}

	if _, spent := exportStatus(t, dbName, exportID); spent {
		t.Fatal("a refused token marked the export as downloaded")
	}
	// The legitimate holder can still download, once.
	good := request(http.MethodGet, api.AdminAuditExportsPath+"/"+exportID+"/content",
		"", "X-Download-Token", token)
	if good.StatusCode != http.StatusOK {
		t.Fatalf("holder download = %d body=%s, want 200", good.StatusCode, readBody(good))
	}
	good.Body.Close()
	if _, spentNow := exportStatus(t, dbName, exportID); !spentNow {
		t.Fatal("successful download did not mark the export as spent")
	}
}
