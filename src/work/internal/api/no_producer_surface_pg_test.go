package api_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/we-meet/work/internal/testpg"
)

// Third group from the error-code audit. These codes have a real RAISE in the shipped schema,
// but the endpoint that would surface them is screened by a stricter check upstream, so a
// client can never receive them. Two of the three are guards that still fail closed for the
// next caller that skips the read path, and the third is a rule the worker - not the API -
// enforces, which is the only reason it is invisible over HTTP.
//
// The reachability claims are asserted, not assumed:
//
//   - version_not_found (baseline/0002:2907) is raised by record_artifact_export, which the
//     content route calls only after readArtifactVersion already required the same
//     v.state='published' plus a.state='published' and an undeleted task
//     (internal/api/artifacts.go:233, :389-391). A draft download therefore answers
//     artifact_not_found, and the export guard is unreachable from HTTP.
//   - scope_unavailable has two SQL producers - submit_task's tool allowlist (0002:1531-1534)
//     and create_operation's kind list (0002:657-659) - and both callers hard-code an allowed
//     value: the submit handler passes ARRAY['model_call'] (internal/api/previews.go:226) and
//     the run flow passes 'model' (internal/runflow/activities.go:232). No request can widen
//     either list, because the submitted body carries only input_ref, template and mode.
//   - quota_exhausted (0002:3440-3443) lives inside reserve_quota, granted to work_worker only
//     (0002:5216) and reached from the run flow, and the provisioned organization is soft
//     (increments/0006:71), which is the customer-brings-its-own-account model.

// surfaceAppScalar runs one statement as work_api inside an organization and session context,
// which is the role the API uses for these commands. It returns the error instead of failing,
// because the refusal is the result under test.
func surfaceAppScalar(t *testing.T, dbName, subject, statement string, args ...any) (string, error) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AppURL(dbName))
	if err != nil {
		return "", err
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', true)`); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.subject_id', $1, true)`, subject); err != nil {
		return "", err
	}
	var out string
	if err := tx.QueryRow(ctx, statement, args...).Scan(&out); err != nil {
		return "", err
	}
	return out, tx.Commit(ctx)
}

func requireRaised(t *testing.T, label string, err error, state, message string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: call succeeded, want %s", label, message)
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("%s: unexpected error %v", label, err)
	}
	if pgErr.SQLState() != state || pgErr.Message != message {
		t.Fatalf("%s = %s %q, want %s %q", label,
			pgErr.SQLState(), pgErr.Message, state, message)
	}
}

// surfaceOperation adds an operation row in a reservable state. reserve_quota holds at most one
// live reservation per operation (0002:3408-3416), so every reserve in the ledger tests needs
// its own row - which is also how the run flow arrives, one operation per model call.
func surfaceOperation(t *testing.T, dbName, operationID, logicalKey string) {
	t.Helper()
	surfaceExec(t, dbName, `
		INSERT INTO work.operation
		  (id, org_id, run_id, logical_key, kind, request_hash, state, revision)
		VALUES ($1::uuid, 'org_a', '`+runA+`', $2, 'model', 'sha256:surface', 'authorized', 0)`,
		operationID, logicalKey)
}

func TestVersionNotFoundGuardSitsBehindTheArtifactReadPath(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	const (
		draftArtifact = "61111111-1111-4111-8111-848484848484"
		// Task C belongs to sub_other, so its artifact is a fact about someone else's work.
		otherOwnersArtifact = "61111111-1111-4111-8111-858585858585"
		otherOwnersTask     = "11111111-1111-4111-8111-333333333333"
	)
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: draftArtifact, orgID: "org_a", taskID: activeTaskID,
		logicalName: "result", content: "# 未发布的草稿版本", versionState: "staged",
	})
	seedArtifact(t, dbName, store, artifactSeed{
		artifactID: otherOwnersArtifact, orgID: "org_a", taskID: otherOwnersTask,
		logicalName: "result", content: "# 别人的正式版", versionState: "published",
	})

	// The guard itself, called the way the endpoint calls it (record_artifact_export is granted
	// to work_api, baseline/0002:5204). A staged version and a version that was never minted
	// both refuse with version_not_found; an artifact the caller does not own refuses one step
	// earlier with artifact_not_found, which is the same answer as an id that does not exist, so
	// the export path is not an ownership oracle either.
	_, err := surfaceAppScalar(t, dbName, testSubject,
		`SELECT count(*)::text FROM work.record_artifact_export('org_a', $1::uuid, 1, $2)`,
		draftArtifact, testSubject)
	requireRaised(t, "staged version export", err, "P0002", "version_not_found")
	_, err = surfaceAppScalar(t, dbName, testSubject,
		`SELECT count(*)::text FROM work.record_artifact_export('org_a', $1::uuid, 7, $2)`,
		draftArtifact, testSubject)
	requireRaised(t, "absent version export", err, "P0002", "version_not_found")
	_, err = surfaceAppScalar(t, dbName, testSubject,
		`SELECT count(*)::text FROM work.record_artifact_export('org_a', $1::uuid, 1, $2)`,
		otherOwnersArtifact, testSubject)
	requireRaised(t, "artifact of another owner", err, "P0002", "artifact_not_found")

	// The same request through the shipped route: the read path refuses first, so the client
	// sees artifact_not_found and never reaches the export guard. That is what makes
	// version_not_found unobservable over HTTP, and it is asserted here rather than assumed.
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)
	download := taskRequest(t, http.MethodGet,
		fmt.Sprintf("%s/work/v1/artifacts/%s/versions/1/content?disposition=attachment",
			server.URL, draftArtifact), token, "")
	assertAPICode(t, download, http.StatusNotFound, "artifact_not_found")

	// And nothing was recorded as exported by the refused attempts.
	if rows := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.audit_event WHERE action = 'artifact.exported'`); rows != "0" {
		t.Fatalf("artifact.exported audit rows = %s, want 0", rows)
	}
}

// submitCallSQL spells out the twelve positional arguments of work.submit_task in the order the
// handler passes them (internal/api/previews.go:214-228), with a legal value in every slot
// except the allowlist under test.
func submitCallSQL(allowlist string) string {
	return `SELECT count(*)::text FROM work.submit_task(` +
		`'org_a', 'sub_a', 'surface-scope-0001',` +
		`'31111111-1111-4111-8111-333333333333', '纪要标题', 'ask_each',` +
		`'sha256:snapshot', '{}'::jsonb, ` + allowlist + `, '{}'::jsonb,` +
		`'wf-surface', 'test')`
}

func TestScopeUnavailableGuardsFireButNoRouteCanReachThem(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)

	// The allowlist guard (0002:1531) rejects an unknown tool, an empty list, a list without
	// model_call and a missing list: a snapshot the run flow could not execute must never
	// become a task.
	cases := []struct {
		label     string
		allowlist string
	}{
		{"unknown tool", `ARRAY['shell_exec']::text[]`},
		{"empty list", `ARRAY[]::text[]`},
		{"no model_call", `ARRAY['read_builtin_template']::text[]`},
		{"null list", `NULL::text[]`},
	}
	for _, tc := range cases {
		_, err := surfaceAppScalar(t, dbName, testSubject, submitCallSQL(tc.allowlist))
		requireRaised(t, tc.label, err, "P0001", "scope_unavailable:tool_allowlist")
	}

	// Differential: the identical call with the allowlist the handler actually sends passes
	// this guard and fails one step later, on the input owned by another subject. Without this
	// row the four refusals above could be an argument-shape failure of some other guard.
	_, err := surfaceAppScalar(t, dbName, testSubject, submitCallSQL(`ARRAY['model_call']::text[]`))
	requireRaised(t, "legal allowlist reaches the input guard", err, "P0002", "input_not_found")

	// The other producer is create_operation's kind list (0002:657), granted to work_worker
	// (0002:5212). Run A is active, so the kind check is what answers.
	_, err = workerQuota(t, dbName,
		`SELECT count(*)::text FROM work.create_operation($1::uuid, 'org_a',`+
			`'browser:take', 'browser', 'sha256:browser')`, runA)
	requireRaised(t, "operation kind", err, "P0001", "scope_unavailable:operation_kind")
	// Control: 'model' - the only kind the run flow ever asks for - is accepted.
	if created, err := workerQuota(t, dbName,
		`SELECT count(*)::text FROM work.create_operation($1::uuid, 'org_a',`+
			`'model:surface', 'model', 'sha256:model')`, runA); err != nil {
		t.Fatalf("create_operation with kind=model: %v", err)
	} else if created != "1" {
		t.Fatalf("create_operation rows = %s, want 1", created)
	}
}

func TestQuotaExhaustedFiresOnlyUnderHardEnforcement(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	const (
		firstOp  = "71111111-1111-4111-8111-505050505050"
		secondOp = "71111111-1111-4111-8111-606060606060"
		thirdOp  = "71111111-1111-4111-8111-707070707070"
	)
	for _, op := range []struct{ id, key string }{
		{firstOp, "model:surface-1"},
		{secondOp, "model:surface-2"},
		{thirdOp, "model:surface-3"},
	} {
		surfaceOperation(t, dbName, op.id, op.key)
	}
	// quotaAcct resolves the provisioned account, so nothing here hard-codes a period that
	// stops existing in December.
	reserve := func(operationID string, amount int) (string, error) {
		return workerQuota(t, dbName, quotaAcct+
			`SELECT work.reserve_quota('org_a', acct.account_key, acct.period_id,`+
			` $1::uuid, $2::bigint)::text FROM acct`, operationID, amount)
	}

	// Flipping the same provisioned row to hard with a small limit is the platform-pays
	// configuration; the enforcement flag is the only thing that makes the arithmetic refuse.
	surfaceExec(t, dbName, quotaAcct+`
		UPDATE work.quota_account ba SET enforcement = 'hard', limit_tokens = 100
		FROM acct WHERE ba.id = acct.id`)

	if _, err := reserve(firstOp, 50); err != nil {
		t.Fatalf("reserve inside the hard limit: %v", err)
	}
	// 50 of 100 is now held, so a 60-token request is refused with its own public code instead
	// of quietly over-committing the account.
	_, err := reserve(secondOp, 60)
	requireRaised(t, "reserve over a hard limit", err, "P0001", "quota_exhausted")
	// A request that still fits is accepted under the same hard flag: the refusal above is the
	// remaining balance, not a blanket block.
	if _, err := reserve(thirdOp, 40); err != nil {
		t.Fatalf("reserve that still fits under hard enforcement: %v", err)
	}
	if facts := ledgerFacts(t, dbName); facts != "0/90/2|reserve:90" {
		t.Fatalf("ledger under hard enforcement = %s, want 90 held and nothing settled", facts)
	}

	// Back to soft: the very amount that was refused is counted rather than blocked, because a
	// customer-brings-its-own-account organization is metered, not capped (D-08).
	surfaceExec(t, dbName, quotaAcct+`
		UPDATE work.quota_account ba SET enforcement = 'soft' FROM acct WHERE ba.id = acct.id`)
	if _, err := workerQuota(t, dbName, quotaAcct+
		`SELECT work.reserve_quota('org_a', acct.account_key, acct.period_id,`+
		` $1::uuid, 500::bigint)::text FROM acct`, secondOp); err != nil {
		t.Fatalf("the same operation under soft enforcement: %v", err)
	}
	if facts := ledgerFacts(t, dbName); facts != "0/590/3|reserve:590" {
		t.Fatalf("ledger after the soft reserve = %s, want 590 held and nothing settled", facts)
	}
}
