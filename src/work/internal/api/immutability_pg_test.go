package api_test

import (
	"context"
	"net/url"
	"testing"

	"github.com/we-meet/work/internal/testpg"
)

// The database declares that the audit trail, the timeline, the token ledger and the dedup and
// tombstone records cannot be rewritten or erased: six guard triggers (baseline/0002:841-853)
// raise append_only_table:<name> (23514), and a seventh keeps a published artifact version's
// content bytes fixed (0002:855-872). Nothing tested any of them - `grep prevent_mutation` and
// `grep artifact_version_immutable_content` across the test tree both came back empty, so
// removing one would have left the suite green while silently dropping the invariant that "the
// audit row cannot be edited" and "version 2 means these bytes forever" rest on.
//
// One assumption got corrected by running this: the append-only tables only carry SELECT and
// INSERT policies (0002:5144-5156), which does NOT hide their rows from an UPDATE or DELETE -
// Postgres decides visibility for those commands with the USING clause of the SELECT policy,
// and validates new values with the INSERT policy. So for the role that owns the tables the
// trigger is the operative control, not row-level security, and the test asserts the trigger's
// own message. The refusal is then reproduced from three angles: the owner role, a role that
// walks past row-level security, and the application role, which is stopped earlier by the
// absence of any write grant. Naming all three keeps "this row cannot be rewritten" separate
// from "this role cannot write at all".

const (
	immutableApproval  = "b1111111-1111-4111-8111-111111111111"
	immutableArtifact  = "b1111111-1111-4111-8111-222222222222"
	immutableTombstone = "b1111111-1111-4111-8111-333333333333"
	immutableAccount   = "b1111111-1111-4111-8111-444444444444"
)

// seedImmutableRows puts one real row into each guarded table. Audit and timeline rows go
// through the same SECURITY DEFINER helpers the domain commands use, so they look exactly like
// produced rows rather than hand-shaped fixtures.
func seedImmutableRows(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', 'org_a', false);
		SELECT work.append_audit('org_a', 'sub_a', 'guard.test', 'task',
		                         '` + taskA + `', jsonb_build_object('kept', 1));
		SELECT work.append_task_event('org_a', '` + taskA + `'::uuid, 'guard.test',
		                             jsonb_build_object('kept', 1));
		INSERT INTO work.quota_account (id, org_id, account_key, period_id, limit_tokens)
		VALUES ('` + immutableAccount + `', 'org_a', 'guard', '2026-11', 1000);
		INSERT INTO work.quota_entry (org_id, account_id, kind, amount_tokens)
		VALUES ('org_a', '` + immutableAccount + `', 'reserve', 100);
		INSERT INTO work.approval
		  (id, org_id, target_type, plan_version_id, params_hash, scope, risk,
		   expires_at, policy_epoch, status)
		VALUES ('` + immutableApproval + `', 'org_a', 'operation', NULL, 'sha256:guard',
		        '{}'::jsonb, 'low', now() + interval '1 hour', 1, 'pending');
		INSERT INTO work.approval_decision
		  (approval_id, org_id, decision, actor_subject_id, params_hash, policy_epoch)
		VALUES ('` + immutableApproval + `', 'org_a', 'approved', 'sub_a', 'sha256:guard', 1);
		INSERT INTO work.artifact (id, org_id, task_id, logical_name, state, revision)
		VALUES ('` + immutableArtifact + `', 'org_a', '` + taskA + `', 'guard.md',
		        'draft', 0);
		INSERT INTO work.artifact_tombstone (artifact_id, org_id)
		VALUES ('` + immutableTombstone + `', 'org_a');
		INSERT INTO work.submission_dedup
		  (org_id, subject_id, operation_type, client_request_id, request_hash)
		VALUES ('org_a', 'sub_a', 'submitTask', 'guard-dedup-000001', 'sha256:guard');
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

// guardCounts reads one count per guarded table, each scoped to the row this test seeded.
// Scoping matters: provisioning an organization already writes audit rows, so a total count
// would read as "the guard failed" when nothing was touched.
func guardCounts(t *testing.T, dbName string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', false)`); err != nil {
		t.Fatal(err)
	}
	var counts string
	if err := conn.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM work.audit_event
		          WHERE action = 'guard.test' AND metadata->>'kept' = '1')::text || '/' ||
		       (SELECT count(*) FROM work.task_event
		          WHERE type = 'guard.test' AND payload->>'kept' = '1')::text || '/' ||
		       (SELECT count(*) FROM work.quota_entry
		          WHERE account_id = '`+immutableAccount+`')::text || '/' ||
		       (SELECT count(*) FROM work.approval_decision
		          WHERE approval_id = '`+immutableApproval+`')::text || '/' ||
		       (SELECT count(*) FROM work.artifact_tombstone
		          WHERE artifact_id = '`+immutableTombstone+`')::text || '/' ||
		       (SELECT count(*) FROM work.submission_dedup
		          WHERE client_request_id = 'guard-dedup-000001')::text
	`).Scan(&counts); err != nil {
		t.Fatal(err)
	}
	return counts
}

// ownerExec runs a statement as work_owner with the organization set, and reports how many
// rows it touched.
func ownerExec(dbName, statement string, args ...any) (int64, error) {
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		return 0, err
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', false)`); err != nil {
		return 0, err
	}
	tag, err := conn.Exec(ctx, statement, args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// appExec runs a statement through the application role, whose access to these tables is
// read-only by grant.
func appExec(dbName, statement string) (int64, error) {
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AppURL(dbName))
	if err != nil {
		return 0, err
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', false)`); err != nil {
		return 0, err
	}
	tag, err := conn.Exec(ctx, statement)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func assertGuardRefusal(t *testing.T, name string, err error, table string) {
	t.Helper()
	pgErr := opsPgError(t, err)
	want := "append_only_table:" + table
	if pgErr.SQLState() != "23514" || pgErr.Message != want {
		t.Fatalf("%s = %s %q, want 23514 %q", name, pgErr.SQLState(), pgErr.Message, want)
	}
}

// rootURLFor points the maintenance connection (the test superuser, which walks past RLS) at a
// per-test database, so the guard triggers can be reached with the row-level filter disabled.
func rootURLFor(t *testing.T, dbName string) string {
	t.Helper()
	parsed, err := url.Parse(testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + dbName
	return parsed.String()
}

func rootExec(t *testing.T, dbName, statement string) error {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, rootURLFor(t, dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, statement)
	return err
}

func TestAppendOnlyTablesAreHeldByBothRowsAndTriggers(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	seedImmutableRows(t, dbName)

	before := guardCounts(t, dbName)
	if before != "1/1/1/1/1/1" {
		t.Fatalf("guarded rows before the attempts = %s, want one seeded row in each table", before)
	}

	statements := []struct {
		name  string
		table string
		stmt  string
	}{
		// An UPDATE that writes the same value still has to be refused: the control is about
		// the operation, not about whether the row looks different afterwards.
		{"audit update", "audit_event", `UPDATE work.audit_event SET action = 'guard.test'`},
		{"audit delete", "audit_event", `DELETE FROM work.audit_event WHERE action = 'guard.test'`},
		{"event update", "task_event", `UPDATE work.task_event SET payload = '{"kept": 2}'::jsonb`},
		{"event delete", "task_event", `DELETE FROM work.task_event WHERE type = 'guard.test'`},
		{"ledger update", "quota_entry", `UPDATE work.quota_entry SET amount_tokens = 1`},
		{"ledger delete", "quota_entry", `DELETE FROM work.quota_entry WHERE kind = 'reserve'`},
		{"decision update", "approval_decision", `UPDATE work.approval_decision SET decision = 'rejected'`},
		{"decision delete", "approval_decision", `DELETE FROM work.approval_decision`},
		{"tombstone delete", "artifact_tombstone", `DELETE FROM work.artifact_tombstone`},
		{"dedup delete", "submission_dedup", `DELETE FROM work.submission_dedup`},
	}

	// Row-level security does not hide these rows from an UPDATE: a table with only SELECT and
	// INSERT policies still lets the SELECT policy's USING clause decide visibility for UPDATE
	// and DELETE. So the guard trigger - not the policy set - is what holds the invariant for
	// the role that owns the tables, and the assertion has to be made against the trigger.
	for _, tc := range statements {
		rows, err := ownerExec(dbName, tc.stmt)
		if err == nil {
			t.Fatalf("%s as work_owner touched %d rows, want append_only_table:%s",
				tc.name, rows, tc.table)
		}
		assertGuardRefusal(t, tc.name, err, tc.table)
	}
	if after := guardCounts(t, dbName); after != before {
		t.Fatalf("guarded rows after the owner attempts = %s, want unchanged from %s",
			after, before)
	}

	// The same statements are refused for a role that walks past row-level security entirely,
	// which is the part that keeps the invariant true if a policy is ever widened.
	for _, tc := range statements {
		err := rootExec(t, dbName, tc.stmt)
		if err == nil {
			t.Fatalf("%s as the maintenance role succeeded, want the guard trigger to refuse",
				tc.name)
		}
		assertGuardRefusal(t, tc.name, err, tc.table)
	}
	if after := guardCounts(t, dbName); after != before {
		t.Fatalf("guarded rows after the trigger attempts = %s, want unchanged from %s",
			after, before)
	}

	// The third layer is privileges: the application role has SELECT on these tables and no
	// write grant at all, so it is refused before any trigger runs. Asserting the distinct
	// message keeps "the API role cannot write" separate from "the row cannot be rewritten".
	if _, err := appExec(dbName, `UPDATE work.audit_event SET action = 'guard.test'`); err == nil {
		t.Fatal("work_api updated the audit table")
	} else if pgErr := opsPgError(t, err); pgErr.SQLState() != "42501" ||
		pgErr.Message != "permission denied for table audit_event" {
		t.Fatalf("work_api audit update = %s %q, want 42501 permission denied for table audit_event",
			pgErr.SQLState(), pgErr.Message)
	}

	// Appending is still allowed - these tables are append-only, not frozen.
	if _, err := ownerExec(dbName,
		`SELECT work.append_audit('org_a', 'sub_a', 'guard.test2', 'task', $1, '{}'::jsonb)`,
		taskA); err != nil {
		t.Fatalf("append after the refusals: %v", err)
	}
	if got := opsScalar(t, dbName,
		`SELECT count(*)::text FROM work.audit_event WHERE action = 'guard.test2'`); got != "1" {
		t.Fatalf("second audit row count = %s, want 1", got)
	}
}

func TestPublishedArtifactVersionContentCannotBeSwapped(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	seedImmutableRows(t, dbName)

	if _, err := ownerExec(dbName, `
		INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_ref, content_hash, bytes,
		   media_type, state, provenance)
		VALUES ('`+immutableArtifact+`', 'org_a', 1, 'content://work/guard-1',
		        'sha256:guard-1', 40, 'text/markdown', 'staged', '{"kept": 1}'::jsonb)`); err != nil {
		t.Fatal(err)
	}

	// Every field that defines what the version *is* has to be frozen. This is what makes the
	// edit surface honest: saving a draft publishes version N+1 instead of rewriting N.
	// artifact_version is in the all-commands policy group, so the trigger is reached here on
	// the ordinary role rather than only with row-level security bypassed.
	cases := []struct {
		name string
		stmt string
		args []any
	}{
		{"content reference", `UPDATE work.artifact_version SET content_ref = 'content://work/forged'`, nil},
		{"content hash", `UPDATE work.artifact_version SET content_hash = 'sha256:forged'`, nil},
		{"byte count", `UPDATE work.artifact_version SET bytes = 1`, nil},
		{"media type", `UPDATE work.artifact_version SET media_type = 'application/octet-stream'`, nil},
		{"provenance", `UPDATE work.artifact_version SET provenance = '{}'::jsonb`, nil},
		{"version number", `UPDATE work.artifact_version SET version_no = 99`, nil},
		{"owning artifact", `UPDATE work.artifact_version SET artifact_id = $1::uuid`,
			[]any{immutableTombstone}},
		{"owning org", `UPDATE work.artifact_version SET org_id = 'org_other'`, nil},
	}
	for _, tc := range cases {
		rows, err := ownerExec(dbName, tc.stmt, tc.args...)
		if err == nil {
			t.Fatalf("%s: update touched %d rows, want artifact_version_content_immutable",
				tc.name, rows)
		}
		pgErr := opsPgError(t, err)
		if pgErr.SQLState() != "23514" ||
			pgErr.Message != "artifact_version_content_immutable" {
			t.Fatalf("%s = %s %q, want 23514 artifact_version_content_immutable",
				tc.name, pgErr.SQLState(), pgErr.Message)
		}
	}

	// The immutability guard is field-scoped, not a freeze: publishing the staged version is a
	// legal lifecycle write, and the content identity stays exactly as inserted.
	if _, err := ownerExec(dbName, `
		UPDATE work.artifact_version
		SET state = 'published', published_at = now() WHERE version_no = 1`); err != nil {
		t.Fatalf("publishing the staged version: %v", err)
	}
	intact := opsScalar(t, dbName, `
		SELECT state || '/' || content_ref || '/' || content_hash || '/' || bytes::text || '/' ||
		       jsonb_exists(provenance, 'kept')::text || '/' ||
		       (published_at IS NOT NULL)::text
		FROM work.artifact_version WHERE artifact_id = $1::uuid AND version_no = 1`,
		immutableArtifact)
	if intact != "published/content://work/guard-1/sha256:guard-1/40/true/true" {
		t.Fatalf("published version = %s, want the content identity untouched by every "+
			"refused update", intact)
	}

	// A published version is also terminal under the state machine (edges at 0002:538-539,
	// trigger at 0002:589), and that refusal comes from enforce_state_transition rather than
	// from the content guard - the two have to be attributed separately, or a reader would
	// conclude the immutability trigger covers lifecycle too.
	_, err := ownerExec(dbName,
		`UPDATE work.artifact_version SET state = 'quarantined' WHERE version_no = 1`)
	if err == nil {
		t.Fatal("quarantining a published version succeeded, want the transition refused")
	}
	if pgErr := opsPgError(t, err); pgErr.SQLState() != "23514" ||
		pgErr.Message != "invalid_transition:artifact_version:published->quarantined" {
		t.Fatalf("state refusal = %s %q, want 23514 "+
			"invalid_transition:artifact_version:published->quarantined",
			pgErr.SQLState(), pgErr.Message)
	}

	// A column outside both guards still moves, which is what proves neither guard is a
	// blanket write lock.
	if _, err := ownerExec(dbName, `
		UPDATE work.artifact_version
		SET published_at = now() - interval '1 hour' WHERE version_no = 1`); err != nil {
		t.Fatalf("updating published_at: %v", err)
	}

	// Inserting a new version is the supported path, so the guard does not block publishing.
	if _, err := ownerExec(dbName, `
		INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_ref, content_hash, bytes,
		   media_type, state, provenance)
		VALUES ('`+immutableArtifact+`', 'org_a', 2, 'content://work/guard-2',
		        'sha256:guard-2', 60, 'text/markdown', 'published', '{}'::jsonb)`); err != nil {
		t.Fatalf("publishing a second version: %v", err)
	}
	var count int
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT set_config('app.org_id', 'org_a', false)`); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx,
		`SELECT count(*) FROM work.artifact_version WHERE artifact_id = $1::uuid`,
		immutableArtifact).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("versions after publishing the next one = %d, want 2", count)
	}
}
