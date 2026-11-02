package api_test

import (
	"context"
	"testing"

	"github.com/we-meet/work/internal/testpg"
)

// The other half of D3-N02. delete_task_core collects the content references a delete owns
// and then drops any reference that another live object still points at
// (baseline/0002:2965-2975) - one NOT EXISTS over the other tasks' inputs and one over the
// other tasks' published artifact versions. The expiry sweep has the same rule and is now
// covered from both directions (internal/relay/shared_ref_shred_pg_test.go); the delete side
// only had the unique-holder case.
//
// Two facts worth pinning separately from the assertions:
//   - the outbox row is inserted unconditionally (0002:2999-3001), so a fully shared delete
//     still queues a hand-off, just with an empty reference list; the shredder must therefore
//     tolerate "nothing to do" rather than treat an empty list as an error;
//   - whichever holder goes last is the one that finally delivers the reference, so a delete
//     of the other task must produce exactly one delivery for the shared bytes, not zero and
//     not two.

const (
	sharedTaskE  = "11111111-1111-4111-8111-555555555555"
	sharedInputE = "31111111-1111-4111-8111-555555555555"
	sharedDocRef = "content://work/shared-doc"

	sharedArtifactB  = "91111111-1111-4111-8111-111111111111"
	sharedArtifactE  = "91111111-1111-4111-8111-555555555555"
	sharedVersionRef = "content://work/shared-report"
)

// seedQuiescentTaskE adds a second task with no run, so a duty delete is legal for both
// tasks in the pair. Its input is bound to the task, which is what create_task does
// (baseline/0002:1595-1597) and also exempts the row from the active-hash unique index,
// which only covers unbound inputs (0002:83-85).
func seedQuiescentTaskE(t *testing.T, dbName, contentRef string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.input_object (id, org_id, subject_id, content_ref, content_hash, bytes)
		VALUES ('` + sharedInputE + `', 'org_a', 'sub_a', '` + contentRef + `',
		        'sha256:shared-doc', 30);
		INSERT INTO work.task (id, org_id, owner_subject_id, state, permission_mode, title, input_id, revision)
		VALUES ('` + sharedTaskE + `', 'org_a', 'sub_a', 'open', 'ask_each', 'Shared task',
		        '` + sharedInputE + `', 0);
		UPDATE work.input_object SET task_id = '` + sharedTaskE + `' WHERE id = '` + sharedInputE + `';
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

// pointInputBAt moves task B's seeded input onto the same physical object as task E's.
func pointInputBAt(t *testing.T, dbName, contentRef string) {
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
	if _, err := conn.Exec(ctx,
		`UPDATE work.input_object SET content_ref = $2, content_hash = 'sha256:shared-doc'
		 WHERE id = $1::uuid`, opsInputB, contentRef); err != nil {
		t.Fatal(err)
	}
}

// seedTaskArtifact publishes one artifact version for a task on the given reference.
func seedTaskArtifact(t *testing.T, dbName, taskID, artifactID, contentRef string) {
	t.Helper()
	ctx := context.Background()
	conn, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	script := `
		SELECT set_config('app.org_id', 'org_a', false);
		INSERT INTO work.artifact (id, org_id, task_id, logical_name, state, revision)
		VALUES ('` + artifactID + `', 'org_a', '` + taskID + `', 'report.md', 'published', 0);
		INSERT INTO work.artifact_version
		  (artifact_id, org_id, version_no, content_ref, content_hash, bytes,
		   media_type, state, provenance, published_at)
		VALUES ('` + artifactID + `', 'org_a', 1, '` + contentRef + `',
		        'sha256:shared-report', 30, 'text/markdown', 'published', '{}'::jsonb, now());
	`
	if err := testpg.ExecRaw(ctx, conn, script); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteTaskHoldsBackAReferenceAnotherTaskStillShares(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	bindInput(t, dbName, opsInputB, taskB)
	seedQuiescentTaskE(t, dbName, sharedDocRef)
	pointInputBAt(t, dbName, sharedDocRef)

	// Task B goes first. Its own input names the object, but task E's live input names the
	// same one, so nothing may be delivered - while the hand-off row itself is still written
	// with an empty list, which is how the shredder sees "no references to delete".
	refs, err := opsDelete(dbName, opsActor, opsActor, taskB, "OPS-2001", opsReason)
	if err != nil {
		t.Fatalf("duty delete of the first sharer: %v", err)
	}
	if refs != 0 {
		t.Fatalf("references delivered by the first sharer = %d, want 0", refs)
	}
	rows, payload := shredHandoff(t, dbName, taskB)
	if rows != 1 || payload != "[]" {
		t.Fatalf("hand-off for the first sharer = %d rows %s, want one row with []", rows, payload)
	}
	if got := opsScalar(t, dbName,
		`SELECT (deleted_at IS NOT NULL)::text || '/' || title FROM work.task WHERE id = $1::uuid`,
		taskB); got != "true/[deleted]" {
		t.Fatalf("task B tombstone = %q, want deleted with the title redacted", got)
	}

	// Task E is the last holder, so the same reference has to arrive exactly once now.
	secondRefs, err := opsDelete(dbName, opsActor, opsActor, sharedTaskE, "OPS-2002", opsReason)
	if err != nil {
		t.Fatalf("duty delete of the last sharer: %v", err)
	}
	if secondRefs != 1 {
		t.Fatalf("references delivered by the last holder = %d, want 1", secondRefs)
	}
	secondRows, secondPayload := shredHandoff(t, dbName, sharedTaskE)
	if secondRows != 1 || secondPayload != `["`+sharedDocRef+`"]` {
		t.Fatalf("hand-off for the last holder = %d rows %s, want one row carrying %s",
			secondRows, secondPayload, sharedDocRef)
	}
	if firstRows, firstPayload := shredHandoff(t, dbName, taskB); firstRows != 1 || firstPayload != "[]" {
		t.Fatalf("the first sharer's empty hand-off changed to %d rows %s", firstRows, firstPayload)
	}
}

func TestDeleteTaskHoldsBackAReferenceAnotherTaskArtifactStillPublishes(t *testing.T) {
	_, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	bindInput(t, dbName, opsInputB, taskB)
	seedQuiescentTaskE(t, dbName, sharedVersionRef)
	seedTaskArtifact(t, dbName, taskB, sharedArtifactB, sharedVersionRef)
	seedTaskArtifact(t, dbName, sharedTaskE, sharedArtifactE, sharedVersionRef)

	// Both tasks publish a version pointing at one object, while their own inputs stay
	// distinct. Deleting task B therefore has to hold back the artifact reference - the check
	// that reads the other task's artifact rows (baseline/0002:2970-2975), the branch an
	// input-only seed cannot reach - and still deliver its own input reference.
	refs, err := opsDelete(dbName, opsActor, opsActor, taskB, "OPS-2003", opsReason)
	if err != nil {
		t.Fatalf("duty delete with a shared artifact version: %v", err)
	}
	if refs != 1 {
		t.Fatalf("task B delivered %d references, want only its own input", refs)
	}
	_, payload := shredHandoff(t, dbName, taskB)
	if payload != `["content://b"]` {
		t.Fatalf("hand-off for task B = %s, want its own input reference and not the "+
			"artifact version task E still publishes", payload)
	}

	// With task B's artifact tombstoned, task E becomes the only live holder of the shared
	// version object. Its input was seeded on that same reference, so the two collected
	// references collapse to one DISTINCT entry - which is the point of the deduplication.
	secondRefs, err := opsDelete(dbName, opsActor, opsActor, sharedTaskE, "OPS-2004", opsReason)
	if err != nil {
		t.Fatalf("duty delete of the last artifact holder: %v", err)
	}
	if secondRefs != 1 {
		t.Fatalf("last holder delivered %d references, want the one shared object once", secondRefs)
	}
	if _, secondPayload := shredHandoff(t, dbName, sharedTaskE); secondPayload !=
		`["`+sharedVersionRef+`"]` {
		t.Fatalf("last holder hand-off = %s, want the shared reference delivered exactly once",
			secondPayload)
	}
}
