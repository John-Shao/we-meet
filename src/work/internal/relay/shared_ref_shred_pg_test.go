package relay_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/testpg"
)

// D3-N02: content objects are deduplicated by hash, so two different inputs - or an input
// and an artifact version - can point at the same bytes. The expiry sweep therefore has to
// check for other live holders before it queues a shred (baseline/0002:5026-5047), and
// delete_task_core does its own version of the same test (0002:2965-2975). Getting that
// wrong is not a cosmetic bug: the shredder deletes the object from the content store for
// good, so a missing check destroys data a live task still references.
//
// No test covered either check. The existing shred tests either hand-insert the outbox row
// or seed one reference per input, which is exactly the shape where a dropped guard still
// produces the "right" answer.

const (
	sharedRef      = "content://work/shared-bytes"
	sharedInputA   = "55555555-1111-4111-8111-111111111111" // due immediately
	sharedInputB   = "55555555-1111-4111-8111-222222222222" // due later
	sharedArtfact  = "55555555-1111-4111-8111-333333333333"
	sharedSubjectB = "sub_relay_two"
)

// seedSharedInputs adds two unbound inputs on the same reference: A is already past its
// TTL, B is not. They belong to different subjects because work_input_active_hash
// (baseline/0002:83-85) allows only one active unbound row per
// (org, subject, content_hash, purpose) - which is also exactly the production case being
// guarded here: two members upload identical bytes, the content store deduplicates them by
// hash, and one physical object ends up referenced by both rows.
func seedSharedInputs(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', '` + relayOrg + `', false);
		INSERT INTO work.input_object
		  (id, org_id, subject_id, content_ref, content_hash, bytes, status, expires_at)
		VALUES
		  ('` + sharedInputA + `', '` + relayOrg + `', 'sub_relay', '` + sharedRef + `',
		   'sha256:shared', 20, 'active', now() - interval '1 hour'),
		  ('` + sharedInputB + `', '` + relayOrg + `', '` + sharedSubjectB + `', '` + sharedRef + `',
		   'sha256:shared', 20, 'active', now() + interval '1 hour');
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

// seedSharedArtifact puts a published artifact version on the very same reference, held by
// the relay task, so the bytes have a holder that is neither of the inputs.
func seedSharedArtifact(t *testing.T, dbName string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', '` + relayOrg + `', false);
		INSERT INTO work.artifact (id, org_id, task_id, logical_name, state, revision)
		VALUES ('` + sharedArtfact + `', '` + relayOrg + `', '` + relayTask + `',
		        'shared.md', 'published', 0);
		INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_ref, content_hash, bytes,
		   media_type, state, provenance, published_at)
		VALUES ('` + sharedArtfact + `', '` + relayOrg + `', 1, '` + sharedRef + `',
		        'sha256:shared', 20, 'text/markdown', 'published', '{}'::jsonb, now());
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

// expireInputs runs the production entrypoint as the scheduled job does, with the clock as
// a parameter - no row is edited to fake a deadline.
func expireInputs(t *testing.T, dbName, clock string) int {
	t.Helper()
	ctx := context.Background()
	pool, err := workdb.OpenPool(ctx, testpg.WorkerURL(dbName), "relay-shared-ref")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	swept := -1
	err = workdb.WithWorkerOrgContext(ctx, pool, relayOrg, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, "SELECT work.expire_due_inputs("+clock+")").Scan(&swept)
	})
	if err != nil {
		t.Fatal(err)
	}
	return swept
}

// refHolders reads every content_shred row carrying the shared reference, as
// "<count>/<comma separated aggregate ids>", which is how the test tells "not yet shredded"
// from "shredded by the right row".
func refHolders(t *testing.T, dbName string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.outbox_relay', 'on', false)`); err != nil {
		t.Fatal(err)
	}
	var facts string
	if err := conn.QueryRow(ctx, `
		SELECT count(*)::text || '/' ||
		       coalesce(string_agg(aggregate_id::text, ',' ORDER BY aggregate_id), '-')
		FROM work.outbox
		WHERE payload->>'kind' = 'content_shred'
		  AND payload->'content_refs' @> jsonb_build_array($1::text)`, sharedRef,
	).Scan(&facts); err != nil {
		t.Fatal(err)
	}
	return facts
}

func inputStatus(t *testing.T, dbName, inputID string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.org_id', $1, false)`, relayOrg); err != nil {
		t.Fatal(err)
	}
	var facts string
	if err := conn.QueryRow(ctx, `
		SELECT status || '/' || (deleted_at IS NOT NULL)::text || '/' ||
		       coalesce(task_id::text, 'unbound')
		FROM work.input_object WHERE id = $1::uuid`, inputID).Scan(&facts); err != nil {
		t.Fatal(err)
	}
	return facts
}

func TestExpiringOneInputKeepsBytesTheOtherInputStillHolds(t *testing.T) {
	_, dbName := newRelayDB(t)
	seedRun(t, dbName)
	seedSharedInputs(t, dbName)

	if swept := expireInputs(t, dbName, "now()"); swept != 1 {
		t.Fatalf("first sweep swept %d, want the one due input", swept)
	}
	if got := inputStatus(t, dbName, sharedInputA); got != "expired/true/unbound" {
		t.Fatalf("due input = %q, want expired with deleted_at and no task", got)
	}
	if got := inputStatus(t, dbName, sharedInputB); got != "active/false/unbound" {
		t.Fatalf("not-yet-due input = %q, want untouched", got)
	}
	// The half that matters: A is gone, but B still points at the same bytes, so nothing
	// may have been handed to the shredder.
	if got := refHolders(t, dbName); got != "0/-" {
		t.Fatalf("shred rows while B still holds the ref = %s, want none", got)
	}

	// When the last holder passes, the reference has to be delivered exactly once, by that
	// row. Expired A no longer counts as a holder (its deleted_at is set), which is what
	// makes this the second half of the same rule rather than a permanent skip.
	if swept := expireInputs(t, dbName, "now() + interval '2 hours'"); swept != 1 {
		t.Fatalf("second sweep swept %d, want the second due input", swept)
	}
	if got := refHolders(t, dbName); got != "1/"+sharedInputB {
		t.Fatalf("shred rows after the last holder expired = %s, want one row keyed by %s",
			got, sharedInputB)
	}
	if got := inputStatus(t, dbName, sharedInputB); got != "expired/true/unbound" {
		t.Fatalf("second input = %q, want expired", got)
	}

	// A third run must find nothing due and must not re-deliver the reference.
	if swept := expireInputs(t, dbName, "now() + interval '2 hours'"); swept != 0 {
		t.Fatalf("third sweep swept %d, want 0", swept)
	}
	if got := refHolders(t, dbName); got != "1/"+sharedInputB {
		t.Fatalf("shred rows after a repeat sweep = %s, want still one", got)
	}
}

func TestExpiringInputKeepsBytesAnArtifactVersionStillHolds(t *testing.T) {
	_, dbName := newRelayDB(t)
	seedRun(t, dbName)
	seedSharedInputs(t, dbName)
	seedSharedArtifact(t, dbName)

	if swept := expireInputs(t, dbName, "now() + interval '2 hours'"); swept != 2 {
		t.Fatalf("sweep swept %d, want both inputs past their TTL", swept)
	}
	// Both inputs are gone and still the bytes live, because a published artifact version
	// of the relay task references them. The holder check reads artifact rows, not just
	// inputs, which is the part a single-table test cannot see.
	if got := refHolders(t, dbName); got != "0/-" {
		t.Fatalf("shred rows while the artifact holds the ref = %s, want none", got)
	}
	for _, inputID := range []string{sharedInputA, sharedInputB} {
		if got := inputStatus(t, dbName, inputID); got != "expired/true/unbound" {
			t.Fatalf("input %s = %q, want expired", inputID, got)
		}
	}
}
