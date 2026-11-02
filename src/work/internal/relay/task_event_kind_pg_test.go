package relay_test

import (
	"context"
	"testing"
)

// relay.go:277-286 recognizes a task-event row two ways: the payload's kind tag, and a
// fallback to aggregate_type == 'task' when the row carries no kind at all. The fallback is
// the shape the original producer wrote - baseline/0002:1346-1351 inserted the event body
// straight into the payload, and increment 0004 only added the tag by appending
// jsonb_build_object('kind','task_event') to that same statement.
//
// That makes the fallback the load-bearing half, not a curiosity: if the kind suffix ever
// disappears from append_task_event, every task-event row would fall through to
// unknown_outbox_kind and be dead-lettered, and because claim_outbox only lets the oldest
// undelivered row of an aggregate be claimed (0002:2482-2488), the refused head also decides
// when the rest of that task's queue becomes claimable. Neither existing case sees this:
// relay_test.go:56 hand-inserts a row that already carries the tag, and relay_test.go:261
// asserts the opposite direction (an unknown kind must be refused).

const (
	kindlessHeadEvent = "bbbbbbbb-1111-4111-8111-111111111111"
	kindlessNextEvent = "bbbbbbbb-1111-4111-8111-222222222222"
)

func TestRelayAcknowledgesTaskEventRowWithoutAKindTag(t *testing.T) {
	pool, dbName := newRelayDB(t)
	seedRun(t, dbName)

	// Deliberately no "kind" key: only the event body, as the pre-0004 producer wrote it.
	insertOutbox(t, dbName, kindlessHeadEvent, relayOrg, "task", relayTask,
		`{"task_id":"`+relayTask+`","type":"run.failed"}`)
	insertOutbox(t, dbName, kindlessNextEvent, relayOrg, "task", relayTask,
		`{"kind":"task_event","type":"task.deleted"}`)
	service := newRelay(t, pool, &fakeDispatcher{}, &fakeStore{})
	ctx := context.Background()

	// One pass claims exactly one row, because the second one of the same aggregate is not
	// yet claimable - so this also proves the kind-less head was accepted rather than
	// parked: a refused head would leave this row unclaimed with a dead-lettered twin.
	n, err := service.Once(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("first pass claimed %d events, want the kind-less head only", n)
	}
	assertDelivered(t, dbName, kindlessHeadEvent)
	assertOutboxFields(t, dbName, kindlessNextEvent, false, false, 0, "", false)

	if n, err := service.Once(ctx); err != nil || n != 1 {
		t.Fatalf("second pass claimed %d events (err %v), want the row behind the head", n, err)
	}
	assertDelivered(t, dbName, kindlessNextEvent)
	if n, _ := service.Once(ctx); n != 0 {
		t.Fatalf("third pass claimed %d events, want nothing left", n)
	}
}
