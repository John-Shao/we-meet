package migrate

import (
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for increment 0018: the governance authority tables and the rules that
// must hold regardless of which command writes them.
//
// These cover control §3.4 (one deny, one source, one release predicate), §4.1's
// cursor and gap-report CAS requirements, §6.1's frozen admission epoch, and the
// EV84/EV107/EV117 state chains at the database level.

func TestR0bAdmissionEpochIsStamped(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_epoch"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	snapshotID := scalarString(t, admin,
		`SELECT snapshot_id FROM work.task WHERE id = $1 AND org_id = $2`, run.taskID, org)

	// The stamp must come from the org row, not from whatever a caller passed:
	// runs are created by several R0a commands, and a caller-supplied epoch would
	// let a new Run claim to predate every deny.
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.org SET access_epoch = 7 WHERE id = '%s'", org))
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.run SET state = 'succeeded' WHERE id = '%s'", run.runID))

	stamped := newUUID(t)
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id,
		  workflow_id, runtime_version, admission_access_epoch)
		VALUES ('%s', '%s', '%s', 2, 'queued', '%s', 'run:%s', 'pi-1', 99);
	`, stamped, org, run.taskID, snapshotID, stamped))
	if got := scalarCount(t, admin,
		`SELECT admission_access_epoch FROM work.run WHERE id = $1`, stamped); got != 7 {
		t.Fatalf("admission_access_epoch = %d, want the org epoch 7 the trigger stamps", got)
	}

	// Without a tenant context the stamp cannot see the org row, but the run is
	// refused anyway by the org execution gate that fires in the same phase, so
	// there is no path where a Run is admitted with an unverified epoch.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id,
		  workflow_id, runtime_version)
		VALUES ('%s', '%s', '%s', 3, 'queued', '%s', 'run:%s', 'pi-1')
	`, newUUID(t), "org_without_context", run.taskID, snapshotID, newUUID(t))); err == nil {
		t.Fatal("a run was admitted for an org that has no row")
	} else {
		// The execution gate, not the missing org's foreign key: pinning which one fired
		// is the whole point of the case.
		assertPgMessage(t, err, "org_execution_unavailable")
	}
}

func TestR0bAccessRestrictionShapeAndTerminalRelease(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_deny"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	deny := func(columns, values string) string {
		return fmt.Sprintf(`INSERT INTO work.access_restriction (org_id, %s) VALUES ('%s', %s)`,
			columns, org, values)
	}

	// A member deny that names no member, and a seat deny with no observed Host
	// revision, are both refused: neither can be released correctly later.
	for _, rejected := range []struct{ insert, want string }{
		// A 'policy' source on purpose: with a host_* source the same row also breaks
		// the host-revision rule, and that one fires first - the row would then never
		// have tested the target shape it was written for.
		{deny("scope, subject_id, source, reason, epoch, release_floor_revision",
			"'member', NULL, 'policy', 'policy_narrowed', 1, 4"),
			"access_restriction_target_shape"},
		{deny("scope, subject_id, source, reason, epoch, release_floor_revision",
			"'member', 'sub_a', 'host_seat', 'seat_dropped', 1, 4"),
			"access_restriction_host_revision_shape"},
		{deny("scope, subject_id, source, reason, epoch, host_revision, release_floor_revision",
			"'member', 'sub_a', 'work_seat_change', 'work_revoked_seat', 1, 9, 4"),
			"access_restriction_host_revision_shape"},
	} {
		if _, err := admin.Exec(testContext(t), rejected.insert); err == nil {
			t.Fatalf("access_restriction accepted a malformed row: %s", rejected.insert)
		} else {
			// Each row is refused by the shape rule it breaks. "Some error came back"
			// would also be satisfied by an unrelated constraint, which is how a missing
			// one gets mistaken for a working one.
			assertPgMessage(t, err, rejected.want)
		}
	}

	// The shapes that must be writable: a host_seat deny carrying its observed
	// revision, a work_seat_change deny whose release anchor is a floor rather
	// than a Host revision, and an org-level operator deny with no target column
	// at all (§3.4 rule 2: an org suspension denies the org, not each member).
	r0bExec(t, dbName, org, deny(
		"scope, subject_id, source, reason, epoch, host_revision, release_floor_revision",
		"'member', 'sub_a', 'host_seat', 'seat_dropped_no_command', 1, 9, 4"))
	r0bExec(t, dbName, org, deny(
		"scope, subject_id, source, reason, epoch, release_floor_revision",
		"'member', 'sub_b', 'work_seat_change', 'work_seat_saga_step1', 1, 0"))
	r0bExec(t, dbName, org, deny(
		"scope, source, reason, epoch, release_floor_revision",
		"'org', 'operator', 'ops_suspended', 1, 0"))

	// Release is a one-way transition and must carry its evidence together.
	_, err := admin.Exec(testContext(t), fmt.Sprintf(`
		UPDATE work.access_restriction SET state = 'released'
		WHERE org_id = '%s' AND subject_id = 'sub_a'`, org))
	assertPgMessage(t, err, "access_restriction_release_shape")

	r0bExec(t, dbName, org, fmt.Sprintf(`
		UPDATE work.access_restriction
		SET state = 'released', released_by_revision = 11, released_at = now()
		WHERE org_id = '%s' AND subject_id = 'sub_a'`, org))
	// released is terminal: a cursor advance must not resurrect it (§4.1, the
	// concurrency case behind EV107 and EV117).
	_, err = admin.Exec(testContext(t), fmt.Sprintf(`
		UPDATE work.access_restriction SET state = 'reconcile_required'
		WHERE org_id = '%s' AND subject_id = 'sub_a'`, org))
	assertPgMessage(t, err, "invalid_transition:access_restriction:released->reconcile_required")

	// The release anchor cannot be re-cut after the fact: a released deny whose
	// floor moved would silently authorize a different command.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.access_restriction SET release_floor_revision = 12 WHERE org_id = '%s' AND subject_id = 'sub_b'",
		org)); err == nil {
		t.Fatal("release_floor_revision was rewritten after creation")
	} else {
		assertPgMessage(t, err, "access_restriction_content_immutable")
	}

	// reconcile_required is the alert tier, not a second block tier: it must be
	// releasable, which is what stops the two-step recovery from dead-ending.
	r0bExec(t, dbName, org, fmt.Sprintf(`
		UPDATE work.access_restriction SET state = 'reconcile_required'
		WHERE org_id = '%s' AND subject_id = 'sub_b'`, org))
	r0bExec(t, dbName, org, fmt.Sprintf(`
		UPDATE work.access_restriction
		SET state = 'released', released_by_revision = 12, released_at = now()
		WHERE org_id = '%s' AND subject_id = 'sub_b'`, org))

	// No running role may write a deny directly.
	app := connect(t, appURL(dbName))
	defer app.Close(testContext(t))
	_, err = app.Exec(testContext(t), deny(
		"scope, source, reason, epoch, release_floor_revision",
		"'org', 'policy', 'from_api', 1, 0"))
	assertPermissionDenied(t, err)
}

func TestR0bGovernanceCursorAdvancesOnlyForward(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_cursor"
	seedRun(t, admin, org)
	r0bExec(t, dbName, org, fmt.Sprintf(
		"INSERT INTO work.governance_event_cursor (org_id, last_event_seq) VALUES ('%s', 0)", org))
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.governance_event_cursor SET last_event_seq = 41 WHERE org_id = '%s'", org))

	// A replayed or low-watermark advance is refused with the code §9 defines for
	// it, and the row keeps its position.
	_, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.governance_event_cursor SET last_event_seq = 40 WHERE org_id = '%s'", org))
	assertPgMessage(t, err, "cursor_advance_not_allowed")
	if got := scalarCount(t, admin,
		`SELECT last_event_seq FROM work.governance_event_cursor WHERE org_id = $1`, org); got != 41 {
		t.Fatalf("cursor position after refused advance = %d, want 41", got)
	}
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		"DELETE FROM work.governance_event_cursor WHERE org_id = '%s'", org)); err == nil {
		t.Fatal("the cursor row was deletable")
	} else {
		assertPgMessage(t, err, "append_only_table:governance_event_cursor")
	}
}

func TestR0bGapReportIsAForgeryProof(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_gap"
	seedRun(t, admin, org)
	gapID := newUUID(t)

	// The count must be the list it claims to cover; the operator's cursor jump
	// accepts this row as the only interval proof (§4.1, R9-8).
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		INSERT INTO work.governance_gap_report
		  (org_id, gap_report_id, from_seq, to_seq_exclusive, seat_events, seat_event_count, host_fetch_seq)
		VALUES ('%s', '%s', 10, 14, '[{"command_id": "AAAAAAAA-0000-0000-0000-000000000001"}]'::jsonb, 3, 20)
	`, org, gapID)); err == nil {
		t.Fatal("a gap report whose count disagrees with its list was accepted")
	} else {
		assertPgMessage(t, err, "governance_gap_report_count_shape")
	}

	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.governance_gap_report
		  (org_id, gap_report_id, from_seq, to_seq_exclusive, seat_events, seat_event_count, host_fetch_seq)
		VALUES ('%s', '%s', 10, 14, '[{"command_id": "AAAAAAAA-0000-0000-0000-000000000001"}]'::jsonb, 1, 20)
	`, org, gapID))

	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.governance_gap_report SET state = 'consumed' WHERE gap_report_id = '%s'", gapID))
	// A consumed report cannot be re-offered for a second advance.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.governance_gap_report SET state = 'pending' WHERE gap_report_id = '%s'", gapID)); err == nil {
		t.Fatal("a consumed gap report returned to pending")
	} else {
		assertPgMessage(t, err, "invalid_transition:governance_gap_report:consumed->pending")
	}
	// Nor can its interval be widened after the fact.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.governance_gap_report SET to_seq_exclusive = 99 WHERE gap_report_id = '%s'", gapID)); err == nil {
		t.Fatal("a gap report's interval was rewritten")
	} else {
		assertPgMessage(t, err, "governance_gap_report_content_immutable")
	}
}

// Tests for increment 0019: the deny lifecycle.

func TestR0bOrgNarrowingDenyIsCreatedAndReleasedByProjection(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_org_deny"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.org SET status = 'suspended', revision = revision + 1 WHERE id = '%s'", org))

	// One deny, and the org epoch advanced so that Runs admitted from now on carry a
	// higher admission epoch than this deny's cutoff.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'host_org' AND scope = 'org' AND state = 'active'`, org); got != 1 {
		t.Fatalf("host_org denys = %d, want 1", got)
	}
	floor := scalarString(t, admin,
		`SELECT release_floor_revision::text FROM work.access_restriction WHERE org_id = $1`, org)
	if floor == "" || floor == "0" {
		t.Fatalf("release_floor_revision = %q, want the observed org revision", floor)
	}

	// No narrowing hint travels through work.outbox: the relay's dispatch ends in a
	// non-retryable unknown_outbox_kind failure (internal/relay/relay.go:196), so every
	// deny would leave a permanently failed row in the queue whose failures are the
	// alarm. The deny row itself is the narrowing record.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.outbox
		WHERE org_id = $1 AND aggregate_type = 'access_restriction'`, org); got != 0 {
		t.Fatalf("narrowing rows written to the outbox = %d, want 0", got)
	}

	// Recovery at the same revision proves nothing; §3.4 requires a strictly higher
	// projection revision.
	if got := scalarCount(t, admin,
		`SELECT work.apply_directory_recovery($1, NULL, $2::bigint, 'sync')`, org, floor); got != 0 {
		t.Fatalf("denys released at the floor revision = %d, want 0", got)
	}
	// And the other conjunct is equally required: a revision the projection actually has,
	// for an organization it still records as suspended, must not release anything.
	// Without the status read inside the command this call would have released the deny,
	// because the only thing checking "is it actually active again" was the Go caller's
	// choice of when to call. 500 is the row's own revision, so nothing but the status
	// can refuse it here.
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.org SET revision = 500 WHERE id = '%s' AND status = 'suspended'", org))
	if got := scalarCount(t, admin,
		`SELECT work.apply_directory_recovery($1, NULL, 500::bigint, 'sync')`, org); got != 0 {
		t.Fatalf("denys released while the projection says suspended = %d, want 0", got)
	}
	// A revision the projection does not have is not observed evidence either: it would
	// be recorded in released_by_revision as a recovery nobody saw.
	if got := scalarCount(t, admin,
		`SELECT work.apply_directory_recovery($1, NULL, 900::bigint, 'sync')`, org); got != 0 {
		t.Fatalf("denys released on an invented revision = %d, want 0", got)
	}
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.org SET status = 'active', revision = revision + 4 WHERE id = '%s'", org))
	if got := scalarCount(t, admin,
		`SELECT work.apply_directory_recovery($1, NULL, 99::bigint, 'sync')`, org); got != 1 {
		t.Fatalf("denys released after recovery = %d, want 1", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND state = 'released' AND released_by_revision = 99`, org); got != 1 {
		t.Fatalf("released rows = %d, want 1", got)
	}

	// §6.1's other half, which is what the cutoff value exists for: the deny carries the
	// epoch it *retires*, so a Run admitted once the organization is active again freezes
	// a strictly higher admission epoch and a late hint cannot reach it. Storing the
	// post-bump value here would make the cutoff equal to every later admission and put
	// exactly those new Runs inside the cancellation scope. The seeded Run is finished
	// first because R0a keeps one open Run per Task, and a suspended org cannot admit one
	// anyway - the org execution gate refuses that.
	r0bExec(t, dbName, org, fmt.Sprintf(`
		UPDATE work.run SET state = 'cancel_requested' WHERE id = '%s';
		UPDATE work.run SET state = 'canceled' WHERE id = '%s';
	`, run.runID, run.runID))
	cutoff := scalarString(t, admin,
		`SELECT epoch::text FROM work.access_restriction WHERE org_id = $1`, org)
	snapshotID := scalarString(t, admin,
		`SELECT snapshot_id FROM work.task WHERE id = $1 AND org_id = $2`, run.taskID, org)
	lateRun := newUUID(t)
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.run (id, org_id, task_id, attempt_no, state, snapshot_id,
		  workflow_id, runtime_version)
		VALUES ('%s', '%s', '%s', 2, 'queued', '%s', 'run:%s', 'pi-1')
	`, lateRun, org, run.taskID, snapshotID, lateRun))
	admitted := scalarCount(t, admin,
		`SELECT admission_access_epoch FROM work.run WHERE id = $1`, lateRun)
	if cutoffValue, err := strconv.ParseInt(cutoff, 10, 64); err != nil {
		t.Fatal(err)
	} else if int64(admitted) <= cutoffValue {
		t.Fatalf("a Run admitted after the org came back froze epoch %d, want more than the deny's cutoff %d",
			admitted, cutoffValue)
	}
	// And the deny keeps the retirement point it was created with: the guard pins epoch,
	// so a release cannot move the cancellation scope under a late hint.
	if got := scalarString(t, admin,
		`SELECT epoch::text FROM work.access_restriction WHERE org_id = $1`, org); got != cutoff {
		t.Fatalf("cutoff after release = %q, want the issued value %q", got, cutoff)
	}

	// A seat deny is never released by the projection path, even at a high
	// revision: only a command event may do that (§3.4 rule 6).
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.access_restriction
		  (org_id, scope, subject_id, source, reason, epoch, host_revision, release_floor_revision)
		VALUES ('%s', 'member', 'sub_c', 'host_seat', 'seat_dropped', 1, 4, 0)`, org))
	if got := scalarCount(t, admin,
		`SELECT work.apply_directory_recovery($1, NULL, 200::bigint, 'sync')`, org); got != 0 {
		t.Fatalf("seat denys released by projection recovery = %d, want 0", got)
	}
}

func TestR0bSeatDenyReleasedOnlyByCommandEvent(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_seat_deny"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)

	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.member SET work_seat = false WHERE org_id = '%s' AND subject_id = '%s'",
		org, run.subject))
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'host_seat' AND subject_id = $2 AND state = 'active'`,
		org, run.subject); got != 1 {
		t.Fatalf("host_seat denys = %d, want 1", got)
	}

	puller := connect(t, testpg.GovernanceURL(dbName))
	defer puller.Close(testContext(t))
	ctx := testContext(t)
	if _, err := puller.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}

	event := func(seq int, commandID string, desired bool, memberRevision int) string {
		return fmt.Sprintf(`{"event_seq": %d, "command_id": "%s", "kind": "seat",
		  "target_subject_id": "%s", "desired": %t, "member_revision": %d,
		  "payload_hash": "sha256:%s", "applied_at": "2026-11-01T00:00:00Z"}`,
			seq, commandID, run.subject, desired, memberRevision, repeatHex(t, 64))
	}

	// A revoking command does not release anything.
	var result []byte
	if err := puller.QueryRow(ctx,
		`SELECT work.consume_governance_events($1, jsonb_build_array($2::jsonb), NULL, 0)`,
		org, event(1, newUUID(t), false, 4)).Scan(&result); err != nil {
		t.Fatal(err)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.access_restriction WHERE org_id = $1 AND state = 'active'`, org); got != 1 {
		t.Fatalf("active denys after a revoking command = %d, want 1", got)
	}

	// A granting command whose member_revision clears the floor does.
	if err := puller.QueryRow(ctx,
		`SELECT work.consume_governance_events($1, jsonb_build_array($2::jsonb))`,
		org, event(2, newUUID(t), true, 4)).Scan(&result); err != nil {
		t.Fatal(err)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'host_seat' AND state = 'released'`, org); got != 1 {
		t.Fatalf("released seat denys = %d, want 1", got)
	}
	if got := scalarCount(t, admin,
		`SELECT last_event_seq FROM work.governance_event_cursor WHERE org_id = $1`, org); got != 2 {
		t.Fatalf("cursor position = %d, want 2", got)
	}
	// The puller writes the consumed ledger and nothing else: no projection touched.
	if got := scalarCount(t, admin, `SELECT CASE WHEN work_seat THEN 1 ELSE 0 END FROM work.member
		WHERE org_id = $1 AND subject_id = $2`, org, run.subject); got != 0 {
		t.Fatalf("member work_seat after consumption = %d, want still false", got)
	}

	// Never-released sources stay untouched no matter what arrives.
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.access_restriction (org_id, scope, subject_id, source, reason, epoch, release_floor_revision)
		VALUES ('%s', 'member', 'sub_d', 'policy', 'policy_narrowed', 1, 0)`, org))
	if err := puller.QueryRow(ctx,
		`SELECT work.consume_governance_events($1, jsonb_build_array($2::jsonb))`,
		org, event(3, newUUID(t), true, 9)).Scan(&result); err != nil {
		t.Fatal(err)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'policy' AND state = 'active'`, org); got != 1 {
		t.Fatalf("policy deny states = %d, want 1 active (§3.4: never released)", got)
	}
}

// governanceEvent renders one Host governance command event as ListGovernanceEvents
// returns it, as a jsonb literal so it can be embedded in a consume call.
func governanceEvent(t *testing.T, seq int, commandID, subject string, desired bool, memberRevision int) string {
	t.Helper()
	return fmt.Sprintf(`'{"event_seq": %d, "command_id": "%s", "kind": "seat",
	  "target_subject_id": "%s", "desired": %t, "member_revision": %d,
	  "payload_hash": "sha256:%s", "applied_at": "2026-11-01T00:00:00Z"}'::jsonb`,
		seq, commandID, subject, desired, memberRevision, repeatHex(t, 64))
}

// TestR0bMemberProjectionTakesTheOrgLockFirst checks §4.3's lock direction as a
// privilege fact rather than a comment. The deny trigger fires after the member row is
// already locked and then updates work.org, so a caller that locked the member first
// reaches back for an org lock mark_members_absent may be holding (it takes the org row
// at 0008:309-312 and only then the members at 0008:351-365) - the ABBA pair §4.3 names
// in words. Revoking the unwrapped command from the directory identity means the only
// path it has takes the org lock before touching the member, instead of the safe order
// being a convention a reviewer has to remember.
func TestR0bMemberProjectionTakesTheOrgLockFirst(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_lock_order"
	run := seedRun(t, admin, org)
	r0bAdmin(t, admin, org)
	ctx := testContext(t)

	revision := scalarCount(t, admin,
		`SELECT revision FROM work.member WHERE org_id = $1 AND subject_id = $2`,
		org, run.subject)
	seated := scalarCount(t, admin, `SELECT CASE WHEN work_seat THEN 1 ELSE 0 END
		FROM work.member WHERE org_id = $1 AND subject_id = $2`, org, run.subject) == 1

	directory := connect(t, testpg.DirectoryURL(dbName))
	defer directory.Close(ctx)
	if _, err := directory.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}

	if _, err := directory.Exec(ctx,
		`SELECT work.sync_member_with_org_context($1, $2, $3, $4, $5, $6)`,
		org, run.subject, "active", "member", seated, int64(revision)+1); err != nil {
		t.Fatalf("the wrapped projection entry failed: %v", err)
	}
	// A projection that changes nothing about status or seat creates no deny, so the
	// next call's deny is attributable to the suspension alone.
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.access_restriction WHERE org_id = $1`, org); got != 0 {
		t.Fatalf("denys from a no-op projection = %d, want 0", got)
	}
	if _, err := directory.Exec(ctx,
		`SELECT work.sync_member_with_org_context($1, $2, $3, $4, $5, $6)`,
		org, run.subject, "suspended", "member", seated, int64(revision)+2); err != nil {
		t.Fatalf("the wrapped projection entry refused a narrowing: %v", err)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND source = 'host_member' AND subject_id = $2
		  AND state = 'active'`, org, run.subject); got != 1 {
		t.Fatalf("denys created through the wrapped entry = %d, want 1", got)
	}
	if _, err := directory.Exec(ctx,
		`SELECT work.sync_member_projection($1, $2, $3, $4, $5, $6)`,
		org, run.subject, "left", "member", seated, int64(revision)+3); err == nil {
		t.Fatal("work_directory can still call the unwrapped projection command")
	} else {
		assertPgMessage(t, err, "permission denied for function")
	}
}

// TestR0bConsumeAcceptsEventsWithoutMemberCoordinates is the anti-lockout case for §3.1's
// event stream. A Host describes an assignment command with permissions_revision and an
// entitlement command with org_revision, and an entitlement Apply names no person at all;
// the consumed table used to require target_subject_id and member_revision for every kind,
// so the puller's first non-seat event would have raised directory_protocol_invalid, frozen
// that organization's cursor, and left its seat denys unreleasable forever. Kind now decides
// which coordinates must be present - and a seat event still cannot arrive without the
// member anchor its release predicate reads.
func TestR0bConsumeAcceptsEventsWithoutMemberCoordinates(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_event_kinds"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)
	ctx := testContext(t)

	puller := connect(t, testpg.GovernanceURL(dbName))
	defer puller.Close(ctx)
	if _, err := puller.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}

	var result []byte
	stream := fmt.Sprintf(`jsonb_build_array(
		%s,
		'{"event_seq": 2, "command_id": "%s", "kind": "assignment",
		  "target_subject_id": "sub_a", "desired": true, "payload_hash": "sha256:%s",
		  "applied_at": "2026-11-01T00:00:00Z"}'::jsonb,
		'{"event_seq": 3, "command_id": "%s", "kind": "entitlement",
		  "desired": false, "payload_hash": "sha256:%s",
		  "applied_at": "2026-11-01T00:00:00Z"}'::jsonb)`,
		governanceEvent(t, 1, newUUID(t), "sub_a", true, 5),
		newUUID(t), repeatHex(t, 64),
		newUUID(t), repeatHex(t, 64))
	if err := puller.QueryRow(ctx,
		`SELECT work.consume_governance_events($1, `+stream+`, NULL, 0)`, org).Scan(&result); err != nil {
		t.Fatalf("a mixed-kind stream was refused: %v", err)
	}
	if got := scalarCount(t, admin,
		`SELECT last_event_seq FROM work.governance_event_cursor WHERE org_id = $1`, org); got != 3 {
		t.Fatalf("cursor after a mixed-kind stream = %d, want 3", got)
	}
	// The non-seat rows are recorded with the coordinates their kind actually has, which is
	// what keeps them from being mistaken for release evidence later.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.consumed_governance_command
		WHERE org_id = $1 AND kind = 'entitlement' AND target_subject_id IS NULL
		  AND member_revision IS NULL`, org); got != 1 {
		t.Fatalf("entitlement rows recorded without member coordinates = %d, want 1", got)
	}

	// A seat event with no member anchor is still a protocol violation: its whole purpose is
	// the member_revision comparison against release_floor_revision.
	missingRevision := `{"event_seq": 4, "command_id": "` + newUUID(t) + `", "kind": "seat",
		 "target_subject_id": "sub_a", "desired": true, "payload_hash": "sha256:` +
		repeatHex(t, 64) + `", "applied_at": "2026-11-01T00:00:00Z"}`
	if _, err := puller.Exec(ctx,
		`SELECT work.consume_governance_events($1, jsonb_build_array('`+missingRevision+`'::jsonb))`,
		org); err == nil {
		t.Fatal("a seat event without member_revision was accepted")
	} else {
		assertPgMessage(t, err, "directory_protocol_invalid")
	}
	// And an entitlement event that claims a person is refused rather than stored with a
	// subject nobody authorized against.
	entitled := `{"event_seq": 4, "command_id": "` + newUUID(t) + `", "kind": "entitlement",
		 "target_subject_id": "sub_a", "desired": true, "payload_hash": "sha256:` +
		repeatHex(t, 64) + `", "applied_at": "2026-11-01T00:00:00Z"}`
	if _, err := puller.Exec(ctx,
		`SELECT work.consume_governance_events($1, jsonb_build_array('`+entitled+`'::jsonb))`,
		org); err == nil {
		t.Fatal("an entitlement event naming a person was accepted")
	} else {
		assertPgMessage(t, err, "directory_protocol_invalid")
	}
	// The refusals must not have moved the cursor: a rejected batch leaves the position the
	// organization was at.
	if got := scalarCount(t, admin,
		`SELECT last_event_seq FROM work.governance_event_cursor WHERE org_id = $1`, org); got != 3 {
		t.Fatalf("cursor after refusals = %d, want still 3", got)
	}

	// The table's own shape check is the last line: a seat row without a subject cannot be
	// written around the command.
	if _, err := admin.Exec(ctx, fmt.Sprintf(`
		INSERT INTO work.consumed_governance_command
		  (org_id, command_id, kind, target_subject_id, desired, event_seq,
		   member_revision, payload_hash, applied_at)
		VALUES ('%s', '%s', 'seat', NULL, true, 99, 5, 'sha256:%s', now())`,
		org, newUUID(t), repeatHex(t, 64))); err == nil {
		t.Fatal("a seat command row without a subject was written around the command")
	} else {
		assertPgMessage(t, err, "consumed_governance_command_kind_shape")
	}
}

func TestR0bGapReportAndCursorAdvanceAreTwoDistinctSteps(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_gap_advance"
	seedRun(t, admin, org)
	r0bAdmin(t, admin, org)
	// The cursor command binds its actor to the session subject and to a projected
	// administrator row (assert_org_admin), so the actor here is the owner the fixture
	// writes rather than a free-text name.
	actor := r0bAdminSubject(org)

	// Out of order without Host's enumeration of the missing interval: nothing is
	// recorded, because a report the operator could cite would itself be unproven.
	_, err := admin.Exec(testContext(t), fmt.Sprintf(`
		SELECT work.consume_governance_events('%s',
		  jsonb_build_array(%s), NULL, 0)`,
		org, governanceEvent(t, 5, newUUID(t), "sub_a", true, 1)))
	assertPgMessage(t, err, "directory_protocol_invalid")
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.governance_gap_report WHERE org_id = $1`, org); got != 0 {
		t.Fatalf("gap reports without attestation = %d, want 0", got)
	}

	// An enumeration naming a position outside the interval it claims to cover is not a
	// proof of that interval - it is a list of whatever the caller later wants to be
	// able to cite. The interval is what §3.1 makes the puller attest, so the list must
	// live inside it.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(`
		SELECT work.consume_governance_events('%s',
		  jsonb_build_array(%s),
		  jsonb_build_object('from_seq', 1, 'to_seq_exclusive', 5,
		    'seat_events', jsonb_build_array(%s)),
		  0)`,
		org,
		governanceEvent(t, 5, newUUID(t), "sub_a", true, 1),
		governanceEvent(t, 7, newUUID(t), "sub_a", true, 1))); err == nil {
		t.Fatal("a gap attestation listing an event outside its own interval was accepted")
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.governance_gap_report WHERE org_id = $1`, org); got != 0 {
		t.Fatalf("gap reports from an out-of-interval enumeration = %d, want 0", got)
	}

	// With a well-formed attestation the interval is recorded and consumption stops at
	// the gap; the cursor does not move. The enumeration names the seat event that fell
	// inside it, because that list is what the advance command later registers.
	skippedCommand := newUUID(t)
	var payload []byte
	if err := admin.QueryRow(testContext(t), fmt.Sprintf(`
		SELECT work.consume_governance_events('%s',
		  jsonb_build_array(%s),
		  jsonb_build_object('from_seq', 1, 'to_seq_exclusive', 5,
		    'seat_events', jsonb_build_array(%s)),
		  0)`,
		org,
		governanceEvent(t, 5, newUUID(t), "sub_a", true, 1),
		governanceEvent(t, 2, skippedCommand, "sub_a", true, 9))).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.governance_gap_report
		WHERE org_id = $1 AND from_seq = 1 AND to_seq_exclusive = 5 AND state = 'pending'`,
		org); got != 1 {
		t.Fatalf("pending gap reports = %d, want 1", got)
	}
	if got := scalarCount(t, admin,
		`SELECT last_event_seq FROM work.governance_event_cursor WHERE org_id = $1`, org); got != 0 {
		t.Fatalf("cursor after a gap = %d, want 0 (stopped at the gap)", got)
	}

	// Three denys, and only one of them is affected by this interval:
	//   sub_a/host_seat   floor 3, below the skipped event's member_revision 9, so that
	//                     event could have released it - it needs human re-verification;
	//   sub_z/host_seat   floor 12, above every revision in the interval, so nothing
	//                     skipped here could ever have released it;
	//   sub_a/policy      §3.4 says no event releases a policy deny at all.
	// The old predicate marked every active deny whose floor was below the interval's
	// end, which turned an unrelated member's deny into an alarm and made the count in
	// the audit row meaningless.
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.access_restriction
		  (org_id, scope, subject_id, source, reason, epoch, host_revision, release_floor_revision)
		VALUES ('%s', 'member', 'sub_a', 'host_seat', 'seat_dropped', 1, 2, 3),
		       ('%s', 'member', 'sub_z', 'host_seat', 'seat_dropped_elsewhere', 1, 2, 12),
		       ('%s', 'member', 'sub_a', 'policy', 'policy_narrowed', 1, NULL, 3)`,
		org, org, org))
	reportID := scalarString(t, admin,
		`SELECT gap_report_id FROM work.governance_gap_report WHERE org_id = $1`, org)

	// A ticket is mandatory: it is the external-visibility control that replaces a
	// second person under a one-person operations model.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		`SELECT work.advance_governance_event_cursor('%s', 5, '%s', '', '%s', 'req-blank')`,
		org, reportID, actor)); err == nil {
		t.Fatal("a cursor advance without a ticket was accepted")
	}
	if err := admin.QueryRow(testContext(t), fmt.Sprintf(
		`SELECT work.advance_governance_event_cursor('%s', 5, '%s', 'TICKET-7', '%s', 'req-1')`,
		org, reportID, actor)).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if got := scalarCount(t, admin,
		`SELECT last_event_seq FROM work.governance_event_cursor WHERE org_id = $1`, org); got != 5 {
		t.Fatalf("cursor after advance = %d, want 5", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND subject_id = 'sub_a' AND source = 'host_seat'
		  AND state = 'reconcile_required'`, org); got != 1 {
		t.Fatalf("denys the skipped event could release = %d, want 1 marked reconcile_required", got)
	}
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND (subject_id = 'sub_z' OR source = 'policy')
		  AND state <> 'active'`, org); got != 0 {
		t.Fatalf("denys no skipped event could release but marked anyway = %d, want 0", got)
	}
	// §3.1 registers the skipped events so the interval is never replayed, and marks
	// them gap_skipped so they can never be read back as release evidence: a cursor
	// recovery must not be able to lift the deny it exists to keep closed.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.consumed_governance_command
		WHERE org_id = $1 AND command_id = $2 AND event_seq = 2 AND gap_skipped`,
		org, skippedCommand); got != 1 {
		t.Fatalf("skipped events registered as consumed = %d, want 1", got)
	}
	restrictionID := scalarString(t, admin, `SELECT id FROM work.access_restriction
		WHERE org_id = $1 AND subject_id = 'sub_a' AND source = 'host_seat'`, org)
	if got := scalarString(t, admin,
		`SELECT work.release_restriction($1, $2::uuid, $3::uuid, NULL, 'tester')`,
		org, restrictionID, skippedCommand); got != "restriction_not_releasable" {
		t.Fatalf("release against a gap-skipped command = %q, want restriction_not_releasable", got)
	}
	// The advance released nothing - that is the other half of the two-step rule.
	if got := scalarCount(t, admin, `SELECT count(*) FROM work.access_restriction
		WHERE org_id = $1 AND state = 'released'`, org); got != 0 {
		t.Fatalf("denys released by the advance = %d, want 0", got)
	}

	// Same request id replays; a second attempt against the consumed report does not.
	if err := admin.QueryRow(testContext(t), fmt.Sprintf(
		`SELECT work.advance_governance_event_cursor('%s', 5, '%s', 'TICKET-7', '%s', 'req-1')`,
		org, reportID, actor)).Scan(&payload); err != nil {
		t.Fatalf("replaying the same request id failed: %v", err)
	}
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		`SELECT work.advance_governance_event_cursor('%s', 7, '%s', 'TICKET-8', '%s', 'req-2')`,
		org, reportID, actor)); err == nil {
		t.Fatal("one gap report was consumed by two advances")
	}
	// Consumption resumes from the jumped position, so the out-of-order event is now
	// exactly the next expected sequence.
	if err := admin.QueryRow(testContext(t), fmt.Sprintf(
		`SELECT work.consume_governance_events('%s',
		  jsonb_build_array('{"event_seq": 6, "command_id": "%s", "kind": "seat",
		   "target_subject_id": "sub_b", "desired": true, "member_revision": 1,
		   "payload_hash": "sha256:%s", "applied_at": "2026-11-01T00:00:00Z"}'::jsonb))`,
		org, newUUID(t), repeatHex(t, 64))).Scan(&payload); err != nil {
		t.Fatalf("resumed consumption after the jump failed: %v", err)
	}
}

// TestR0bGovernanceTablesAreTenantScoped is the behavioural half of §4.2's "RLS 必须
// 逐个反向攻击". Every R0b table is FORCE-RLS with tenant_isolation, but no service
// role has table privileges at all (0018/0020 revoke them), so the policy is only ever
// exercised inside a SECURITY DEFINER body running as work_owner - which means the
// role to attack it as is the owner, not work_api. Rows are written for org B by a
// superuser (which bypasses RLS) and then read as the owner under three contexts: the
// wrong tenant sees nothing, no tenant at all sees nothing, and the right tenant sees
// exactly the row that proves the earlier two answers were tenancy rather than an empty
// table.
func TestR0bGovernanceTablesAreTenantScoped(t *testing.T) {
	_, admin := newGateDB(t)
	ctx := testContext(t)
	orgA := "org_r0b_tenant_a"
	orgB := "org_r0b_tenant_b"
	seedRun(t, admin, orgA)
	runB := seedRun(t, admin, orgB)

	cases := map[string]string{
		"access_restriction": fmt.Sprintf(`
			INSERT INTO work.access_restriction
			  (org_id, scope, source, reason, epoch, release_floor_revision)
			VALUES ('%s', 'org', 'policy', 'policy_narrowed', 1, 0)`, orgB),
		"governance_event_cursor": fmt.Sprintf(
			`INSERT INTO work.governance_event_cursor (org_id, last_event_seq) VALUES ('%s', 3)`, orgB),
		"consumed_governance_command": fmt.Sprintf(`
			INSERT INTO work.consumed_governance_command
			  (org_id, command_id, kind, target_subject_id, desired, event_seq,
			   member_revision, payload_hash, applied_at)
			VALUES ('%s', '%s', 'seat', 'sub_x', true, 4, 7, 'sha256:%s', now())`,
			orgB, newUUID(t), repeatHex(t, 64)),
		"governance_gap_report": fmt.Sprintf(`
			INSERT INTO work.governance_gap_report
			  (org_id, from_seq, to_seq_exclusive, seat_events, seat_event_count, host_fetch_seq)
			VALUES ('%s', 5, 9, '[]'::jsonb, 0, 9)`, orgB),
		"cancellation_intent": fmt.Sprintf(`
			INSERT INTO work.cancellation_intent (org_id, source_event_id, run_id, reason)
			VALUES ('%s', '%s', '%s', 'seat_revoked')`, orgB, newUUID(t), runB.runID),
		"operation_resolution": fmt.Sprintf(`
			INSERT INTO work.operation_resolution
			  (org_id, run_id, operation_id, resolution_revision, state, delivery_state,
			   settlement_state, signature)
			VALUES ('%s', '%s', '%s', 1, 'failed', 'not_applicable', 'unknown', 'sha256:%s')`,
			orgB, runB.runID, runB.opID, repeatHex(t, 64)),
	}

	for table, insert := range cases {
		if _, err := admin.Exec(ctx, insert); err != nil {
			t.Fatalf("seeding %s: %v", table, err)
		}
	}

	for table, insert := range cases {
		if _, err := admin.Exec(ctx, "RESET ROLE"); err != nil {
			t.Fatal(err)
		}
		// Wrong tenant: the row exists but must not be reachable.
		if _, err := admin.Exec(ctx, fmt.Sprintf(
			"SET ROLE work_owner; SET app.org_id = %s", quoteLiteral(orgA))); err != nil {
			t.Fatal(err)
		}
		if got := scalarCount(t, admin, fmt.Sprintf(
			`SELECT count(*) FROM work.%s WHERE org_id = $1`, table), orgB); got != 0 {
			t.Fatalf("work.%s leaked another tenant's row to org A", table)
		}
		// No tenant context at all: current_setting('app.org_id', true) is NULL, so the
		// policy must fail closed rather than show everything.
		if _, err := admin.Exec(ctx, "RESET app.org_id"); err != nil {
			t.Fatal(err)
		}
		if got := scalarCount(t, admin, fmt.Sprintf(
			`SELECT count(*) FROM work.%s`, table)); got != 0 {
			t.Fatalf("work.%s was readable with no org context at all", table)
		}
		// And a write for another tenant is refused by the WITH CHECK arm, not merely
		// invisible after the fact: the row is org B's, the context is org A's. (Writing
		// an org A row here would be legal and would prove nothing - the policy gates the
		// tenant you are in, not the row you are allowed to create in your own tenant.)
		if _, err := admin.Exec(ctx, fmt.Sprintf(
			"SET app.org_id = %s", quoteLiteral(orgA))); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, insert); err == nil {
			t.Fatalf("work.%s accepted another tenant's org_id under WITH CHECK", table)
		} else if !strings.Contains(err.Error(), "SQLSTATE 42501") {
			// The seeded statement is reused, so a unique or FK conflict would also make
			// this call fail - and would prove nothing about the policy. Only a row-level
			// security violation is evidence that WITH CHECK is what stopped the write.
			// Four of these tables (cursor, consumed command, intent, resolution) collide
			// on their primary key before any policy could be consulted, which is exactly
			// the false green this assertion had.
			t.Fatalf("work.%s refused the cross-tenant insert with %v, want a row-level "+
				"security violation (42501)", table, err)
		}
		// Right tenant sees the row, which is what makes the two refusals above about
		// tenancy rather than about an empty table.
		if _, err := admin.Exec(ctx, fmt.Sprintf(
			"SET app.org_id = %s", quoteLiteral(orgB))); err != nil {
			t.Fatal(err)
		}
		if got := scalarCount(t, admin, fmt.Sprintf(
			`SELECT count(*) FROM work.%s WHERE org_id = $1`, table), orgB); got != 1 {
			t.Fatalf("work.%s hid its own tenant's row: %d", table, got)
		}
	}
	if _, err := admin.Exec(ctx, "RESET ROLE"); err != nil {
		t.Fatal(err)
	}
}

func TestR0bGovernanceIdentityCannotReachTheOtherSide(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_identity"
	seedRun(t, admin, org)
	ctx := testContext(t)

	puller := connect(t, testpg.GovernanceURL(dbName))
	defer puller.Close(ctx)
	if _, err := puller.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}
	// The puller may consume events...
	var payload []byte
	if err := puller.QueryRow(ctx,
		`SELECT work.consume_governance_events($1, '[]'::jsonb, NULL, 0)`, org).Scan(&payload); err != nil {
		t.Fatalf("the puller cannot consume its own event batch: %v", err)
	}
	// ...but may not jump the cursor, may not release a deny directly, and may not
	// read or write the directory projection it is supposed to leave alone.
	_, err := puller.Exec(ctx, fmt.Sprintf(
		`SELECT work.advance_governance_event_cursor('%s', 9, gen_random_uuid(), 'T', 'a', 'r')`, org))
	assertPermissionDenied(t, err)
	_, err = puller.Exec(ctx, fmt.Sprintf(
		`SELECT work.release_restriction('%s', gen_random_uuid(), NULL, 9, 'a')`, org))
	assertPermissionDenied(t, err)
	_, err = puller.Exec(ctx, "SELECT count(*) FROM work.member")
	assertPermissionDenied(t, err)

	app := connect(t, appURL(dbName))
	defer app.Close(ctx)
	if _, err := app.Exec(ctx, "SET app.org_id = "+quoteLiteral(org)); err != nil {
		t.Fatal(err)
	}
	_, err = app.Exec(ctx, `SELECT work.consume_governance_events($1, '[]'::jsonb, NULL, 0)`, org)
	assertPermissionDenied(t, err)
}

func TestR0bEntitlementAndChangeRevisionsMoveForward(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_entitlement"
	seedRun(t, admin, org)
	r0bExec(t, dbName, org, fmt.Sprintf(
		"INSERT INTO work.execution_entitlement (org_id, enabled, seat_limit, revision) VALUES ('%s', true, 40, 3)", org))

	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.execution_entitlement SET revision = 2 WHERE org_id = '%s'", org)); err == nil {
		t.Fatal("an entitlement revision decrease was accepted")
	} else {
		assertPgMessage(t, err, "governance_revision_conflict")
	}
	// host_ack_revision records the ceiling the Host confirmed; a higher
	// acknowledgement than the local revision would read as confirmed authority
	// the org does not have.
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.execution_entitlement SET revision = 4, host_ack_revision = 9 WHERE org_id = '%s'",
		org)); err == nil {
		t.Fatal("host_ack_revision above revision was accepted")
	} else {
		assertPgMessage(t, err, "execution_entitlement_ack_shape")
	}
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.execution_entitlement SET revision = 4, host_ack_revision = 4 WHERE org_id = '%s'", org))
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.execution_entitlement SET seat_limit = -1 WHERE org_id = '%s'", org)); err == nil {
		t.Fatal("a negative seat_limit was accepted")
	} else {
		assertPgMessage(t, err, "execution_entitlement_seat_limit_nonneg")
	}

	// The saga rows are dedup keys, not ledgers a caller can rewrite. The retry
	// key is (org, actor, logical command, client request id), so the duplicate
	// below reuses that tuple with a *different* command id - otherwise the
	// assertion would pass on the unrelated command-id key and the retry key could
	// go missing unnoticed.
	command := newUUID(t)
	insert := func(requestID, commandID string) string {
		return fmt.Sprintf(`INSERT INTO work.governance_change
		  (org_id, command_id, actor_subject_id, logical_command, client_request_id,
		   target_kind, target_id, payload_hash, expected_revision)
		VALUES ('%s', '%s', 'sub_admin', 'seat:sub_a', '%s', 'seat', 'sub_a', 'sha256:%s', 4)`,
			org, commandID, requestID, repeatHex(t, 64))
	}
	r0bExec(t, dbName, org, insert("req-1", command))
	// PostgreSQL truncates generated index names at 63 characters, so the
	// constraint surfaces as ..._logical_command_c_key; match the part that
	// survives rather than the column that motivated it.
	_, err := admin.Exec(testContext(t), insert("req-1", newUUID(t)))
	if err == nil || !strings.Contains(err.Error(), "actor_subject_id_logical_command") {
		t.Fatalf("duplicate retry request must fail on the dedup key, got %v", err)
	}
	// One command id may not be replayed under a different request either.
	if _, err := admin.Exec(testContext(t), insert("req-2", command)); err == nil {
		t.Fatal("a governance command id was used twice")
	} else {
		// One command id may not be replayed under a different request either, and the
		// key that stops it is the (org, command_id) uniqueness, not the dedup tuple
		// asserted just above.
		assertPgMessage(t, err, "governance_change_org_id_command_id_key")
	}
	changeID := scalarString(t, admin,
		`SELECT id FROM work.governance_change WHERE org_id = $1 AND client_request_id = 'req-1'`, org)
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.governance_change SET state = 'reconcile' WHERE id = '%s'", changeID))
	r0bExec(t, dbName, org, fmt.Sprintf(
		"UPDATE work.governance_change SET state = 'applied' WHERE id = '%s'", changeID))
	if _, err := admin.Exec(testContext(t), fmt.Sprintf(
		"UPDATE work.governance_change SET state = 'pending' WHERE id = '%s'", changeID)); err == nil {
		t.Fatal("an applied governance change returned to pending")
	} else {
		assertPgMessage(t, err, "invalid_transition:governance_change:applied->pending")
	}
}
