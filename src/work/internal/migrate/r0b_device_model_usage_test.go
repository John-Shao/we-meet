package migrate

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func prepareAuthorizedDeviceModelAction(t *testing.T, a *actionFixture, stepKey string) (string, string) {
	t.Helper()
	worker := a.workerConn(t)
	prepared := a.prepareBody(t, worker, a.modelActionBody(t, stepKey,
		"model.send_device_local", "device_local"))
	operationID := idOf(t, prepared, "operation_id")
	attemptID := idOf(t, prepared, "attempt_id")
	a.authorizeAction(t, operationID)
	return operationID, attemptID
}

func prepareDeviceModelAction(t *testing.T, a *actionFixture, stepKey string) (string, string, map[string]any) {
	t.Helper()
	operationID, attemptID := prepareAuthorizedDeviceModelAction(t, a, stepKey)
	consumed := a.consumePermit(t, a.workerConn(t), operationID, attemptID)
	return operationID, idOf(t, consumed, "command_id"), consumed
}

func recordDeviceModelResult(t *testing.T, conn *pgx.Conn, a *actionFixture,
	operationID, executionID, deviceID, sessionID, resultHash, provider string,
	inputTokens, outputTokens, cachedTokens int64) map[string]any {
	t.Helper()
	return callJSON(t, conn,
		`SELECT work.record_device_model_result($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,CURRENT_DATE,$9,$10,$11,$12)`,
		a.org, operationID, executionID, deviceID, sessionID, resultHash, provider,
		"fixture-model", inputTokens, outputTokens, cachedTokens, inputTokens+outputTokens)
}

func reserveDeviceModelQuota(t *testing.T, a *actionFixture, operationID string) string {
	t.Helper()
	var reservationID string
	if err := a.workerConn(t).QueryRow(testContext(t),
		`SELECT work.reserve_quota($1, 'default', to_char(now(), 'YYYY-MM'), $2, 1000)::text`,
		a.org, operationID).Scan(&reservationID); err != nil {
		t.Fatalf("reserve_quota: %v", err)
	}
	if reservationID == "" {
		t.Fatal("reserve_quota returned no reservation id")
	}
	return reservationID
}

func TestR0bDeviceModelPermitCreatesActiveExecutionWithTwoSecondMargin(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_execution")
	operationID, executionID, consumed := prepareDeviceModelAction(t, a, "model:local:1")
	if consumed["delivery_state"] != "not_applicable" {
		t.Fatalf("device_local dispatch = %#v", consumed)
	}
	got := a.scalar(t, fmt.Sprintf(`SELECT state || '/' || mode || '/' ||
		holder_id || '/' || intent_ref || '/' || (input_checkpoint_ref IS NULL)::text
		FROM work.runtime_execution WHERE execution_id = %s AND org_id = %s`,
		quoteLiteral(executionID), quoteLiteral(a.org)))
	if want := "active/execute/device:" + a.deviceID + ":" + a.sessionID + "/local:" + operationID + "/true"; got != want {
		t.Fatalf("runtime execution = %q, want %q", got, want)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.runtime_execution e
		JOIN work.device_dispatch d ON d.org_id = e.org_id AND d.command_id = e.execution_id
		WHERE e.org_id = %s AND e.execution_id = %s
		  AND e.lease_until = d.expires_at + interval '2 seconds'
		  AND e.hard_deadline = e.lease_until
		  AND e.intent_hash = e.request_hash
		  AND e.run_fence = (SELECT fence FROM work.run r WHERE r.id = e.run_id)`,
		quoteLiteral(a.org), quoteLiteral(executionID))); got != 1 {
		t.Fatalf("execution margin/binding rows = %d, want 1", got)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.runtime_execution
		WHERE org_id = %s AND run_id = %s AND state IN ('registered','active')`,
		quoteLiteral(a.org), quoteLiteral(a.runID))); got != 1 {
		t.Fatalf("live executions = %d, want 1", got)
	}

	attemptID := a.scalar(t, fmt.Sprintf(`SELECT dispatch_attempt_id::text FROM work.operation
		WHERE org_id = %s AND id = %s`, quoteLiteral(a.org), quoteLiteral(operationID)))
	replay := a.consumePermit(t, a.workerConn(t), operationID, attemptID)
	if replay["command_id"] != executionID || replay["replayed"] != true {
		t.Fatalf("permit replay = %#v, want command %s", replay, executionID)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.runtime_execution
		WHERE org_id = %s AND run_id = %s`, quoteLiteral(a.org), quoteLiteral(a.runID))); got != 1 {
		t.Fatalf("execution rows after replay = %d, want 1", got)
	}
}

func TestR0bDeviceModelSecondRequestExpiresTheStaleLiveRow(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_second")
	_, firstExecution, _ := prepareDeviceModelAction(t, a, "model:local:1")
	mustExec(t, a.admin, fmt.Sprintf(`UPDATE work.runtime_execution
		SET lease_until = now() - interval '1 second', revision = revision + 1
		WHERE org_id = %s AND execution_id = %s`, quoteLiteral(a.org), quoteLiteral(firstExecution)))

	_, secondExecution, _ := prepareDeviceModelAction(t, a, "model:local:2")
	if firstExecution == secondExecution {
		t.Fatal("the second model request reused the first execution id")
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state || '/' || terminal_reason || '/' || (lease_until IS NULL)::text
		FROM work.runtime_execution WHERE org_id = %s AND execution_id = %s`,
		quoteLiteral(a.org), quoteLiteral(firstExecution))); got != "expired/deadline_elapsed/true" {
		t.Fatalf("first execution after replacement = %q", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state FROM work.runtime_execution
		WHERE org_id = %s AND execution_id = %s`, quoteLiteral(a.org), quoteLiteral(secondExecution))); got != "active" {
		t.Fatalf("second execution state = %q, want active", got)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.runtime_execution
		WHERE org_id = %s AND run_id = %s AND state IN ('registered','active')`,
		quoteLiteral(a.org), quoteLiteral(a.runID))); got != 1 {
		t.Fatalf("live executions after second request = %d, want 1", got)
	}
}

func TestR0bDeviceModelResultRecordsAdapterUsageAndSettlesOnce(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_usage")
	worker := a.workerConn(t)
	operationID, attemptID := prepareAuthorizedDeviceModelAction(t, a, "model:local:1")
	var reservationID string
	if err := worker.QueryRow(testContext(t),
		`SELECT work.reserve_quota($1, 'default', to_char(now(), 'YYYY-MM'), $2, 1000)::text`,
		a.org, operationID).Scan(&reservationID); err != nil {
		t.Fatalf("reserve_quota: %v", err)
	}
	if reservationID == "" {
		t.Fatal("reserve_quota returned no reservation id")
	}
	consumed := a.consumePermit(t, worker, operationID, attemptID)
	executionID := idOf(t, consumed, "command_id")
	resultHash := strings.Repeat("a", 64)
	got := recordDeviceModelResult(t, worker, a, operationID, executionID,
		a.deviceID, a.sessionID, resultHash, "device_local", 10, 5, 2)
	if got["outcome"] != "recorded" || got["usage_counted"] != true || got["settled"] != true ||
		got["execution_state"] != "completed" {
		t.Fatalf("model result = %#v", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT usage_source || '/' || provider || '/' || model || '/' ||
		input_tokens || '/' || output_tokens || '/' || cached_input_tokens || '/' ||
		source_receipt_hash || '/' || counted_in_usage_daily
		FROM work.operation_usage_fact WHERE org_id = %s AND operation_id = %s`,
		quoteLiteral(a.org), quoteLiteral(operationID))); got != "device_adapter/device_local/fixture-model/10/5/2/"+resultHash+"/true" {
		t.Fatalf("usage fact = %q", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state || '/' || settled_tokens FROM work.quota_reservation
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "settled/15" {
		t.Fatalf("reservation = %q, want settled/15", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT provider || '/' || input_tokens || '/' || output_tokens || '/' || cached_input_tokens
		FROM work.usage_daily WHERE org_id = %s AND provider = 'device_local' AND model = 'fixture-model'`,
		quoteLiteral(a.org))); got != "device_local/10/5/2" {
		t.Fatalf("usage_daily = %q", got)
	}

	replay := recordDeviceModelResult(t, worker, a, operationID, executionID,
		a.deviceID, a.sessionID, resultHash, "device_local", 10, 5, 2)
	if replay["outcome"] != "replayed" || replay["usage_counted"] != false || replay["settled"] != false {
		t.Fatalf("model result replay = %#v", replay)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.operation_usage_fact
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != 1 {
		t.Fatalf("usage facts after replay = %d, want 1", got)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.quota_entry
		WHERE org_id = %s AND operation_id = %s AND kind = 'settle'`,
		quoteLiteral(a.org), quoteLiteral(operationID))); got != 1 {
		t.Fatalf("settlement entries after replay = %d, want 1", got)
	}
	expectCode(t, worker, "usage_receipt_conflict",
		`SELECT work.record_device_model_result($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,CURRENT_DATE,$9,$10,$11,$12)`,
		a.org, operationID, executionID, a.deviceID, a.sessionID, strings.Repeat("b", 64),
		"device_local", "fixture-model", 10, 5, 2, 15)
}

func TestR0bDeviceModelResultRefusesBadProviderUsageACLAndRevokedDevice(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_usage_guards")
	worker := a.workerConn(t)
	operationID, executionID, _ := prepareDeviceModelAction(t, a, "model:local:1")
	expectCode(t, worker, "invalid_request:provider",
		`SELECT work.record_device_model_result($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,CURRENT_DATE,$9,$10,$11,$12)`,
		a.org, operationID, executionID, a.deviceID, a.sessionID, strings.Repeat("a", 64),
		"aliyun", "fixture-model", 10, 5, 2, 15)
	expectCode(t, worker, "invalid_request:provider",
		`SELECT work.record_device_model_result($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,CURRENT_DATE,$9,$10,$11,$12)`,
		a.org, operationID, executionID, a.deviceID, a.sessionID, strings.Repeat("a", 64),
		nil, "fixture-model", 10, 5, 2, 15)
	expectCode(t, worker, "invalid_request:usage",
		`SELECT work.record_device_model_result($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,CURRENT_DATE,$9,$10,$11,$12)`,
		a.org, operationID, executionID, a.deviceID, a.sessionID, strings.Repeat("a", 64),
		"device_local", "fixture-model", -1, 5, 2, 4)

	var pgErr *pgconn.PgError
	_, err := worker.Exec(testContext(t),
		`SELECT work.register_device_model_execution($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour')`,
		a.org, newUUID(t), a.runID, operationID, newUUID(t), a.deviceID, a.sessionID,
		strings.Repeat("1", 64), "pi-1")
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("work_worker register helper error = %#v, want permission denied", err)
	}
	_, err = worker.Exec(testContext(t),
		`SELECT work.complete_device_model_execution($1,$2,'model_result_recorded')`,
		a.org, executionID)
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("work_worker complete helper error = %#v, want permission denied", err)
	}

	api := a.apiConn(t)
	_, err = api.Exec(testContext(t),
		`SELECT work.record_device_model_result($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,CURRENT_DATE,$9,$10,$11,$12)`,
		a.org, operationID, executionID, a.deviceID, a.sessionID, strings.Repeat("a", 64),
		"device_local", "fixture-model", 10, 5, 2, 15)
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("work_api model result error = %#v, want permission denied", err)
	}
	_, err = a.admin.Exec(testContext(t), `INSERT INTO work.operation_usage_fact
		(org_id, operation_id, usage_revision, usage_source, subject_id, provider, model, usage_date)
		VALUES ($1,$2,1,'device_adapter_typo',$3,'device_local','fixture-model',CURRENT_DATE)`,
		a.org, operationID, a.subject)
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("invalid usage_source error = %#v, want check violation", err)
	}

	mustExec(t, a.admin, fmt.Sprintf(`UPDATE work.device SET status = 'revoked', revoked_at = now()
		WHERE org_id = %s AND id = %s`, quoteLiteral(a.org), quoteLiteral(a.deviceID)))
	expectCode(t, worker, "unauthorized",
		`SELECT work.record_device_model_result($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,CURRENT_DATE,$9,$10,$11,$12)`,
		a.org, operationID, executionID, a.deviceID, a.sessionID, strings.Repeat("a", 64),
		"device_local", "fixture-model", 10, 5, 2, 15)
}

func TestR0bDeviceModelResultRequiresAQuotaReservation(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_usage_no_quota")
	worker := a.workerConn(t)
	operationID, executionID, _ := prepareDeviceModelAction(t, a, "model:local:1")
	expectCode(t, worker, "quota_reservation_not_held",
		`SELECT work.record_device_model_result($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,CURRENT_DATE,$9,$10,$11,$12)`,
		a.org, operationID, executionID, a.deviceID, a.sessionID, strings.Repeat("a", 64),
		"device_local", "fixture-model", 10, 5, 2, 15)
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.operation_usage_fact
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != 0 {
		t.Fatalf("usage facts after no-quota refusal = %d, want 0", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state FROM work.runtime_execution
		WHERE org_id = %s AND execution_id = %s`, quoteLiteral(a.org), quoteLiteral(executionID))); got != "active" {
		t.Fatalf("execution after no-quota refusal = %q, want active", got)
	}
}

func TestR0bDeviceModelResultSurvivesSessionExpiryAndFinishRevocation(t *testing.T) {
	t.Run("expired session remains historical evidence", func(t *testing.T) {
		a := newActionFixture(t, "org_r0b_model_usage_expired_session")
		worker := a.workerConn(t)
		operationID, attemptID := prepareAuthorizedDeviceModelAction(t, a, "model:local:1")
		reserveDeviceModelQuota(t, a, operationID)
		consumed := a.consumePermit(t, worker, operationID, attemptID)
		executionID := idOf(t, consumed, "command_id")
		mustExec(t, a.admin, fmt.Sprintf(`UPDATE work.device_session SET state = 'expired'
			WHERE org_id = %s AND id = %s`, quoteLiteral(a.org), quoteLiteral(a.sessionID)))
		got := recordDeviceModelResult(t, worker, a, operationID, executionID,
			a.deviceID, a.sessionID, strings.Repeat("a", 64), "device_local", 10, 5, 2)
		if got["outcome"] != "recorded" || got["execution_state"] != "completed" {
			t.Fatalf("late result after session expiry = %#v", got)
		}
	})

	t.Run("finish revocation does not erase produced usage", func(t *testing.T) {
		a := newActionFixture(t, "org_r0b_model_usage_after_finish")
		worker := a.workerConn(t)
		operationID, attemptID := prepareAuthorizedDeviceModelAction(t, a, "model:local:1")
		reserveDeviceModelQuota(t, a, operationID)
		consumed := a.consumePermit(t, worker, operationID, attemptID)
		executionID := idOf(t, consumed, "command_id")
		if _, err := worker.Exec(testContext(t),
			`SELECT work.finish_local_run_state($1,$2::uuid,'failed','model_finished')`,
			a.org, a.runID); err != nil {
			t.Fatalf("finish_local_run_state: %v", err)
		}
		got := recordDeviceModelResult(t, worker, a, operationID, executionID,
			a.deviceID, a.sessionID, strings.Repeat("a", 64), "device_local", 10, 5, 2)
		if got["outcome"] != "recorded" || got["execution_state"] != "revoked" || got["settled"] != true {
			t.Fatalf("late result after finish revocation = %#v", got)
		}
	})
}

func TestR0bDeviceModelConcurrentPermitReplayReturnsOneCommand(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_usage_concurrent")
	operationID, attemptID := prepareAuthorizedDeviceModelAction(t, a, "model:local:1")
	start := make(chan struct{})
	type result struct {
		body map[string]any
		err  error
	}
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		conn := a.workerConn(t)
		go func() {
			<-start
			var body []byte
			err := conn.QueryRow(testContext(t),
				`SELECT work.consume_device_permit($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9)`,
				a.org, operationID, attemptID, a.deviceID, a.sessionID, a.leaseID,
				a.fence, strings.Repeat("1", 64), permitTestKid).Scan(&body)
			var decoded map[string]any
			if err == nil {
				err = json.Unmarshal(body, &decoded)
			}
			results <- result{body: decoded, err: err}
		}()
	}
	close(start)
	var commandID string
	replayed := map[bool]int{}
	for i := 0; i < 2; i++ {
		got := <-results
		if got.err != nil {
			t.Fatalf("concurrent consume: %v", got.err)
		}
		id := idOf(t, got.body, "command_id")
		if commandID == "" {
			commandID = id
		} else if commandID != id {
			t.Fatalf("concurrent commands = %s and %s", commandID, id)
		}
		replayed[got.body["replayed"] == true]++
	}
	if replayed[false] != 1 || replayed[true] != 1 {
		t.Fatalf("concurrent replay flags = %#v, want one fresh and one replay", replayed)
	}
}

func TestR0bDeviceModelFinishRevokesResidualActiveExecution(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_finish")
	worker := a.workerConn(t)
	_, executionID, _ := prepareDeviceModelAction(t, a, "model:local:1")
	if _, err := worker.Exec(testContext(t),
		`SELECT work.finish_local_run_state($1,$2::uuid,'failed','model_finished')`,
		a.org, a.runID); err != nil {
		t.Fatalf("finish_local_run_state: %v", err)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state || '/' || terminal_reason || '/' || (lease_until IS NULL)::text
		FROM work.runtime_execution WHERE org_id = %s AND execution_id = %s`,
		quoteLiteral(a.org), quoteLiteral(executionID))); got != "revoked/model_finished/true" {
		t.Fatalf("execution after finish = %q", got)
	}
}
