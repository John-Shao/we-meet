package migrate

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// A real prepare/approval/consume supplies the historical dispatch, not just an
// Operation that happens to have a dispatch_attempt_id.
func reviewDispatchedAction(t *testing.T) (*actionFixture, string, string) {
	t.Helper()
	a := newActionFixture(t, "org_execution_review")
	out := a.prepare(t, a.workerConn(t), "review:1", a.grantClass)
	op, attempt := idOf(t, out, "operation_id"), idOf(t, out, "attempt_id")
	a.authorizeAction(t, op)
	a.consumePermit(t, a.workerConn(t), op, attempt)
	return a, op, attempt
}

func reviewReceipt(t *testing.T, a *actionFixture, op, attempt, session string) (map[string]any, string) {
	t.Helper()
	body := callJSON(t, a.admin, `SELECT jsonb_build_object(
 'receipt_seq',1,'request_hash',o.request_hash,'state','completed','outcome','succeeded',
 'result_hash',NULL,'local_result_ref',NULL,'error_code',NULL,'usage',NULL,'usage_source',NULL,
 'signature',$4::text,'original_execution',jsonb_build_object(
 'org_id',o.org_id,'subject_id',$5::text,'device_id',s.device_id,'session_id',s.id,
 'agent_instance_id',s.agent_instance_id,'boot_id',s.boot_id,'generation',s.generation,
 'run_id',o.run_id,'operation_id',o.id,'attempt_id',$3::text,'fence',r.fence))
 FROM work.operation o JOIN work.run r ON r.org_id=o.org_id AND r.id=o.run_id
 JOIN work.device_session s ON s.org_id=o.org_id AND s.id=$2::uuid WHERE o.id=$1::uuid`,
		op, session, attempt, strings.Repeat("a", 86), a.subject)
	journal := a.scalar(t, "SELECT journal_epoch::text FROM work.device_session WHERE id="+quoteLiteral(session))
	return body, journal
}

func reviewRecord(t *testing.T, a *actionFixture, device, journal string, body map[string]any) map[string]any {
	t.Helper()
	raw, err := json.Marshal([]any{body})
	if err != nil {
		t.Fatal(err)
	}
	return callJSON(t, a.workerConn(t), `SELECT work.record_device_receipt($1,$2::uuid,$3::uuid,$4::jsonb)`, a.org, device, journal, string(raw))
}

func TestDeviceExecutionReviewReceiptBindsHistoricalDispatch(t *testing.T) {
	for _, field := range []string{"request_hash", "subject_id", "fence", "foreign_device", "missing_dispatch"} {
		t.Run(field, func(t *testing.T) {
			a, op, attempt := reviewDispatchedAction(t)
			session, device := a.sessionID, a.deviceID
			if field == "foreign_device" {
				// A second legitimate device/session of the same organization signs B's action.
				api := a.apiConn(t)
				pair := callJSON(t, api, `SELECT work.pair_device($1,$2,'bearer',7,$3,'other','windows-x64',$4::jsonb)`, a.org, a.subject, "review-pair", strings.Replace(deviceTestKeyJWK, "AAAA", "CCCC", 1))
				device = idOf(t, pair, "device_id")
				callJSON(t, api, `SELECT work.confirm_device_pairing($1,$2,'bearer',7,$3::uuid,$4,$5,$6)`, a.org, a.subject, pair["pairing_id"], "review-confirm", pair["challenge"], deviceTestConfirmSignature)
				thumb := a.scalar(t, "SELECT public_key_thumbprint FROM work.device WHERE id="+quoteLiteral(device))
				ticket := callJSON(t, api, `SELECT work.mint_device_session_ticket($1,$2,'bearer',7,$3::uuid,$4,$5)`, a.org, a.subject, device, "review-ticket", thumb)
				hash := a.scalar(t, "SELECT work.sha256_text("+quoteLiteral(ticket["ticket"].(string))+")")
				hello := `{"boot_id":"other","agent_instance_id":"` + newUUID(t) + `","journal_epoch":"` + newUUID(t) + `","runtime_digest":"` + strings.Repeat("6", 64) + `","protocol_major":2,"protocol_minor":0}`
				activated := callJSON(t, a.workerConn(t), `SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`, a.org, device, hash, hello)
				session = idOf(t, activated, "session_id")
			}
			if field == "missing_dispatch" {
				op = a.op
				attempt = newUUID(t)
				mustExec(t, a.admin, "UPDATE work.operation SET dispatch_attempt_id="+quoteLiteral(attempt)+" WHERE id="+quoteLiteral(op))
			}
			body, journal := reviewReceipt(t, a, op, attempt, session)
			if field == "missing_dispatch" {
				body["state"] = "started"
				body["outcome"] = nil
			}
			exec := body["original_execution"].(map[string]any)
			switch field {
			case "request_hash":
				body[field] = strings.Repeat("e", 64)
			case "subject_id":
				exec[field] = "not-the-permitted-subject"
			case "fence":
				exec[field] = float64(a.fence + 1)
			}
			out := reviewRecord(t, a, device, journal, body)
			if len(out["conflicts"].([]any)) != 1 || len(out["recorded"].([]any)) != 0 {
				t.Fatalf("unbound %s receipt accepted: %#v", field, out)
			}
			if got := a.scalar(t, "SELECT state FROM work.operation WHERE id="+quoteLiteral(op)); got != "dispatching" {
				t.Fatalf("foreign receipt advanced Operation: %s", got)
			}
			for _, table := range []string{"device_receipt", "operation_resolution"} {
				if got := a.scalarInt(t, "SELECT count(*) FROM work."+table+" WHERE org_id="+quoteLiteral(a.org)); got != 0 {
					t.Fatalf("foreign receipt wrote %s: %d", table, got)
				}
			}
		})
	}
}

func TestDeviceExecutionReviewReceiptAcceptsHistoricalSessionAndOldFence(t *testing.T) {
	for _, oldFence := range []bool{false, true} {
		t.Run(map[bool]string{false: "current", true: "old_fence"}[oldFence], func(t *testing.T) {
			a, op, attempt := reviewDispatchedAction(t)
			body, journal := reviewReceipt(t, a, op, attempt, a.sessionID)
			// A fresh hello supersedes the original session, but does not rewrite dispatch history.
			api := a.apiConn(t)
			thumb := a.scalar(t, "SELECT public_key_thumbprint FROM work.device WHERE id="+quoteLiteral(a.deviceID))
			ticket := callJSON(t, api, `SELECT work.mint_device_session_ticket($1,$2,'bearer',7,$3::uuid,$4,$5)`, a.org, a.subject, a.deviceID, "reconnect-ticket", thumb)
			hash := a.scalar(t, "SELECT work.sha256_text("+quoteLiteral(ticket["ticket"].(string))+")")
			hello := `{"boot_id":"reconnect","agent_instance_id":"` + newUUID(t) + `","journal_epoch":"` + journal + `","runtime_digest":"` + strings.Repeat("6", 64) + `","protocol_major":2,"protocol_minor":0}`
			callJSON(t, a.workerConn(t), `SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`, a.org, a.deviceID, hash, hello)
			if oldFence {
				mustExec(t, a.admin, "UPDATE work.run SET fence=fence+1 WHERE id="+quoteLiteral(a.runID))
			}
			out := reviewRecord(t, a, a.deviceID, journal, body)
			if len(out["conflicts"].([]any)) != 0 || len(out["recorded"].([]any)) != 1 {
				t.Fatalf("history refused: %#v", out)
			}
			want := "succeeded"
			if oldFence {
				want = "dispatching"
			}
			if got := a.scalar(t, "SELECT state FROM work.operation WHERE id="+quoteLiteral(op)); got != want {
				t.Fatalf("state=%s want %s", got, want)
			}
			replay := reviewRecord(t, a, a.deviceID, journal, body)
			if replay["recorded"].([]any)[0].(map[string]any)["replayed"] != true {
				t.Fatalf("history replay: %#v", replay)
			}
		})
	}
}

// Observe the particular blocked backend, never merely sleep and assume overlap.
func reviewWaitForLock(t *testing.T, admin *pgx.Conn, pid uint32) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		if err := admin.QueryRow(testContext(t), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("backend did not reach the held Task lock")
}

func TestDeviceExecutionReviewCancelWinsBeforeClaim(t *testing.T) {
	a := newActionFixture(t, "org_review_cancel")
	out := a.prepare(t, a.workerConn(t), "review:cancel", a.grantClass)
	op := idOf(t, out, "operation_id")
	a.authorizeAction(t, op)
	// request_cancel's Task lock precedes its Run transition. Keep that first lock
	// held while claim takes its candidate snapshot and waits inside consume.
	// work_worker has no table privilege: the maintenance connection holds the lock.
	tx, err := a.admin.Begin(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(testContext(t))
	if _, err = tx.Exec(testContext(t), `SELECT 1 FROM work.task WHERE id=$1::uuid FOR UPDATE`, a.taskID); err != nil {
		t.Fatal(err)
	}
	claim := a.workerConn(t)
	done := make(chan error, 1)
	var result []byte
	go func() {
		done <- claim.QueryRow(testContext(t), `SELECT work.claim_pending_device_commands($1,$2::uuid,$3::uuid,$4)`, a.org, a.deviceID, a.sessionID, permitTestKid).Scan(&result)
	}()
	observer := connect(t, adminURL(a.dbName))
	reviewWaitForLock(t, observer, claim.PgConn().PID())
	if _, err = tx.Exec(testContext(t), `SELECT work.request_cancel($1,$2::uuid,$3)`, a.org, a.runID, a.subject); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(testContext(t)); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_dispatch WHERE org_id="+quoteLiteral(a.org)); got != 0 {
		t.Fatalf("cancel committed first but claim minted %d dispatch/permit rows: %s", got, result)
	}
	a.refuseConsume(t, a.workerConn(t), op, idOf(t, out, "attempt_id"), "run_not_active")
}

func TestDeviceExecutionReviewDispatchWinsPreservesPermit(t *testing.T) {
	a := newActionFixture(t, "org_review_dispatch_first")
	out := a.prepare(t, a.workerConn(t), "review:first", a.grantClass)
	op, attempt := idOf(t, out, "operation_id"), idOf(t, out, "attempt_id")
	a.authorizeAction(t, op)
	worker := a.workerConn(t)
	mustExec(t, worker, "BEGIN")
	defer worker.Exec(testContext(t), "ROLLBACK")
	before := a.consumePermit(t, worker, op, attempt)
	api := a.apiConn(t)
	done := make(chan error, 1)
	go func() {
		_, err := api.Exec(testContext(t), `SELECT work.request_cancel($1,$2::uuid,$3)`, a.org, a.runID, a.subject)
		done <- err
	}()
	reviewWaitForLock(t, a.admin, api.PgConn().PID())
	mustExec(t, worker, "COMMIT")
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	after := a.consumePermit(t, worker, op, attempt)
	if after["replayed"] != true {
		t.Fatalf("expected replay: %#v", after)
	}
	delete(before, "replayed")
	delete(after, "replayed")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("cancel rewrote historical dispatch: before=%#v after=%#v", before, after)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_dispatch WHERE org_id="+quoteLiteral(a.org)); got != 1 {
		t.Fatalf("dispatch rows: %d", got)
	}
}

func TestDeviceExecutionReviewPermitRequiresCurrentRun(t *testing.T) {
	a := newActionFixture(t, "org_review_current")
	out := a.prepare(t, a.workerConn(t), "review:current", a.grantClass)
	op := idOf(t, out, "operation_id")
	a.authorizeAction(t, op)
	mustExec(t, a.admin, "UPDATE work.task SET active_run_id=NULL WHERE id="+quoteLiteral(a.taskID))
	a.refuseConsume(t, a.workerConn(t), op, idOf(t, out, "attempt_id"), "run_not_current")
}

func TestDeviceExecutionReviewLeaseReplay(t *testing.T) {
	o := newOrchestrationFixture(t, "org_review_lease")
	worker := o.workerConn(t)
	nonce := o.nonce
	query := `SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,$5,'execute',$6::uuid,30)`
	args := []any{o.org, o.runID, o.deviceID, o.sessionID, 1, nonce}
	first := callJSON(t, worker, query, args...)
	again := callJSON(t, worker, query, args...)
	delete(first, "replayed")
	delete(again, "replayed")
	if !reflect.DeepEqual(first, again) {
		t.Fatalf("lease replay changed start/baseline: first=%#v again=%#v", first, again)
	}
	bad := append([]any(nil), args...)
	bad[4] = 2
	expectCode(t, worker, "unauthorized", query, bad...)
	bad = append([]any(nil), args...)
	bad[3] = newUUID(t)
	expectCode(t, worker, "unauthorized", query, bad...)
	bad = append([]any(nil), args...)
	bad[2] = newUUID(t)
	expectCode(t, worker, "unauthorized", query, bad...)

	// A renewal and a changed caller TTL must not reconstruct the original response.
	renewLease(t, o, first["lease_id"].(string), 30, 1, o.deviceID, o.sessionID)
	snapshotQuery := `SELECT jsonb_build_object(
	 'lease',(SELECT to_jsonb(l) FROM work.execution_lease l WHERE org_id=$1 AND run_id=$2::uuid),
	 'binding',(SELECT to_jsonb(b) FROM work.device_run_binding b WHERE org_id=$1 AND run_id=$2::uuid),
	 'checkpoints',(SELECT jsonb_agg(c) FROM work.device_checkpoint c WHERE org_id=$1 AND run_id=$2::uuid),
	 'audits',(SELECT count(*) FROM work.audit_event WHERE org_id=$1))`
	before := callJSON(t, o.admin, snapshotQuery, o.org, o.runID)
	again = callJSON(t, worker, strings.Replace(query, ",30)", ",1)", 1), args...)
	delete(again, "replayed")
	if !reflect.DeepEqual(first, again) {
		t.Fatalf("renewal/TTL changed the original start: %#v vs %#v", first, again)
	}
	after := callJSON(t, o.admin, snapshotQuery, o.org, o.runID)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("replay mutated lease/binding/checkpoints/audits: %#v vs %#v", before, after)
	}
	mustExec(t, o.admin, "UPDATE work.execution_lease SET state='expired' WHERE id="+quoteLiteral(first["lease_id"].(string)))
	expectCode(t, worker, "resync_required", query, args...)
}

func TestDeviceExecutionReviewFinishReplayKeepsOriginalEvidence(t *testing.T) {
	a, op, attempt := reviewDispatchedAction(t)
	worker := a.workerConn(t)
	finishID := newUUID(t)
	body := finishProposal("failed", "model_error", a.checkpointSeq, a.checkpointHash,
		strings.Repeat("e", 64), 0, strings.Repeat("7", 86))
	first := a.callFinish(t, worker, finishID, body, a.deviceID, a.sessionID)
	if first["state"] != "rejected" || first["code"] != "finish_state_mismatch" || len(first["unresolved_operations"].([]any)) == 0 {
		t.Fatalf("expected a rejected verdict with repair evidence: %#v", first)
	}
	// Advance the dispatched Operation through its real receipt writer. The replay
	// must still carry the original unresolved state, not today's recomputed list.
	receipt, journal := reviewReceipt(t, a, op, attempt, a.sessionID)
	reviewRecord(t, a, a.deviceID, journal, receipt)
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE id="+quoteLiteral(op)); got != "succeeded" {
		t.Fatalf("receipt did not advance the Operation: %s", got)
	}
	again := a.callFinish(t, worker, finishID, body, a.deviceID, a.sessionID)
	delete(first, "replayed")
	delete(again, "replayed")
	if !reflect.DeepEqual(first, again) {
		t.Fatalf("finish replay recomputed historical evidence: %#v vs %#v", first, again)
	}
	if got := a.finishRowCount(t); got != 1 {
		t.Fatalf("finish rows: %d", got)
	}
	if got := a.scalar(t, "SELECT (relrowsecurity AND relforcerowsecurity)::text FROM pg_class WHERE oid='work.device_run_finish'::regclass"); got != "true" {
		t.Fatal("finish evidence lost FORCE RLS")
	}
	expectConstraint(t, worker, "permission denied", "SELECT unresolved_operations FROM work.device_run_finish")
	expectConstraint(t, a.admin, "append_only_table:device_run_finish",
		"UPDATE work.device_run_finish SET unresolved_operations='[]'::jsonb WHERE finish_id=$1::uuid", finishID)
	expectConstraint(t, a.admin, "append_only_table:device_run_finish",
		"DELETE FROM work.device_run_finish WHERE finish_id=$1::uuid", finishID)
}

func TestDeviceExecutionReviewLeaseReplayExpiresAtOriginalDeadline(t *testing.T) {
	for _, ttl := range []int{1, 30} {
		name := map[int]string{1: "lease_expiry", 30: "delivery_expiry_after_renewal"}[ttl]
		t.Run(name, func(t *testing.T) {
			o := newOrchestrationFixture(t, "org_review_deadline")
			worker := o.workerConn(t)
			query := `SELECT work.acquire_device_lease($1,$2::uuid,$3::uuid,$4::uuid,1,'execute',$5::uuid,$6)`
			args := []any{o.org, o.runID, o.deviceID, o.sessionID, o.nonce, ttl}
			if ttl == 1 {
				mustExec(t, o.admin, "UPDATE work.execution_lease SET expires_at = clock_timestamp() + interval '1 second' WHERE id = "+quoteLiteral(o.leaseID))
			}
			first := callJSON(t, worker, query, args...)
			lease := first["lease_id"].(string)
			expiry := first["run_start"].(map[string]any)["expiry"].(string)
			if ttl == 1 {
				if got := o.scalar(t, "SELECT ("+quoteLiteral(expiry)+"::timestamptz = expires_at)::text FROM work.execution_lease WHERE id="+quoteLiteral(lease)); got != "true" {
					t.Fatalf("run_start does not use the lease expiry: %#v", first)
				}
			} else if got := o.scalar(t, "SELECT ("+quoteLiteral(expiry)+"::timestamptz > clock_timestamp() AND "+quoteLiteral(expiry)+"::timestamptz <= clock_timestamp() + interval '5 seconds')::text"); got != "true" {
				t.Fatalf("run_start does not have a fresh bounded delivery deadline: %#v", first)
			}
			if ttl == 30 {
				renewLease(t, o, lease, 30, 0, o.deviceID, o.sessionID)
			}
			// Wait for the exact server-issued deadline, not a guessed delay. The state
			// stays active, so only the wall-clock check can reject the replay.
			if _, err := o.admin.Exec(testContext(t), `SELECT pg_sleep(GREATEST(0, EXTRACT(epoch FROM ($1::timestamptz - clock_timestamp()))) + 0.01)`, expiry); err != nil {
				t.Fatal(err)
			}
			if got := o.scalar(t, "SELECT state FROM work.execution_lease WHERE id="+quoteLiteral(lease)); got != "active" {
				t.Fatalf("fixture expired the state rather than time: %s", got)
			}
			if ttl == 30 && o.scalar(t, "SELECT (expires_at > clock_timestamp())::text FROM work.execution_lease WHERE id="+quoteLiteral(lease)) != "true" {
				t.Fatal("the lease itself expired before the delivery-window test")
			}
			expectCode(t, worker, "resync_required", query, args...)
		})
	}
}
