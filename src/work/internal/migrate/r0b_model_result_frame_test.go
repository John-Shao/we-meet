package migrate

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func modelResultFramePayload(t *testing.T, a *actionFixture, operationID, attemptID, state, outcome string) map[string]any {
	t.Helper()
	requestHash := a.scalar(t, fmt.Sprintf(`SELECT request_hash FROM work.operation
		WHERE org_id = %s AND id = %s`, quoteLiteral(a.org), quoteLiteral(operationID)))
	var outcomeValue any
	if state == "completed" {
		outcomeValue = outcome
	}
	payload := map[string]any{
		"model_result_id":     newUUID(t),
		"run_id":              a.runID,
		"operation_id":        operationID,
		"attempt_id":          attemptID,
		"request_hash":        requestHash,
		"state":               state,
		"outcome":             outcomeValue,
		"result_hash":         nil,
		"provider_request_id": nil,
		"model":               "fixture-model",
		"usage":               nil,
		"error_code":          nil,
		"signature":           strings.Repeat("A", 86),
	}
	if state == "completed" && outcome == "succeeded" {
		payload["result_hash"] = strings.Repeat("a", 64)
		payload["provider_request_id"] = "req-frame-1"
		payload["usage"] = map[string]any{
			"input_tokens": "10", "output_tokens": "5",
			"cached_input_tokens": "2", "estimated": false,
		}
	} else {
		payload["error_code"] = "model_io_unknown"
		if state == "completed" {
			payload["error_code"] = "identity_mismatch"
		}
	}
	return payload
}

func recordModelResultFrame(t *testing.T, conn *pgx.Conn, a *actionFixture, deviceID string, payload map[string]any) map[string]any {
	t.Helper()
	return callJSON(t, conn, `SELECT work.record_device_model_result_frame($1,$2::uuid,$3::jsonb)`,
		a.org, deviceID, payload)
}

func TestR0bModelResultFrameRecordsAndReplaysWithoutDoubleCounting(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_result_frame")
	worker := a.workerConn(t)
	operationID, attemptID := prepareAuthorizedDeviceModelAction(t, a, "model:local:1")
	reserveDeviceModelQuota(t, a, operationID)
	a.consumePermit(t, worker, operationID, attemptID)
	payload := modelResultFramePayload(t, a, operationID, attemptID, "completed", "succeeded")

	got := recordModelResultFrame(t, worker, a, a.deviceID, payload)
	if got["state"] != "recorded" || got["replayed"] != false || got["code"] != nil {
		t.Fatalf("model result frame = %#v", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state FROM work.operation
		WHERE org_id = %s AND id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "succeeded" {
		t.Fatalf("operation state = %q, want succeeded", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state || '/' || settlement_state FROM work.operation_resolution
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "succeeded/settled" {
		t.Fatalf("resolution = %q", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT input_tokens || '/' || output_tokens || '/' || cached_input_tokens
		FROM work.operation_usage_fact WHERE org_id = %s AND operation_id = %s`,
		quoteLiteral(a.org), quoteLiteral(operationID))); got != "10/5/2" {
		t.Fatalf("usage fact = %q", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state || '/' || settled_tokens FROM work.quota_reservation
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "settled/15" {
		t.Fatalf("reservation = %q", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state FROM work.runtime_execution e
		WHERE e.org_id = %s AND e.operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "completed" {
		t.Fatalf("execution state = %q", got)
	}

	replay := recordModelResultFrame(t, worker, a, a.deviceID, payload)
	if replay["state"] != "recorded" || replay["replayed"] != true {
		t.Fatalf("model result replay = %#v", replay)
	}
	for _, table := range []string{"operation_usage_fact", "operation_resolution", "device_model_result"} {
		if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.%s
			WHERE org_id = %s AND operation_id = %s`, table, quoteLiteral(a.org), quoteLiteral(operationID))); got != 1 {
			t.Fatalf("%s rows after replay = %d, want 1", table, got)
		}
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.quota_entry
		WHERE org_id = %s AND operation_id = %s AND kind = 'settle'`,
		quoteLiteral(a.org), quoteLiteral(operationID))); got != 1 {
		t.Fatalf("settlement entries after replay = %d, want 1", got)
	}

	conflict := modelResultFramePayload(t, a, operationID, attemptID, "completed", "succeeded")
	conflict["model_result_id"] = payload["model_result_id"]
	conflict["result_hash"] = strings.Repeat("b", 64)
	expectCode(t, worker, "idempotency_key_conflict",
		`SELECT work.record_device_model_result_frame($1,$2::uuid,$3::jsonb)`,
		a.org, a.deviceID, conflict)
	otherID := modelResultFramePayload(t, a, operationID, attemptID, "completed", "succeeded")
	expectCode(t, worker, "idempotency_key_conflict",
		`SELECT work.record_device_model_result_frame($1,$2::uuid,$3::jsonb)`,
		a.org, a.deviceID, otherID)
}

func TestR0bModelResultFrameSuccessWithoutReservationStillCountsUsage(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_result_no_reservation")
	worker := a.workerConn(t)
	operationID, attemptID := prepareAuthorizedDeviceModelAction(t, a, "model:local:1")
	a.consumePermit(t, worker, operationID, attemptID)
	payload := modelResultFramePayload(t, a, operationID, attemptID, "completed", "succeeded")

	got := recordModelResultFrame(t, worker, a, a.deviceID, payload)
	if got["state"] != "recorded" {
		t.Fatalf("model result without reservation = %#v", got)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.operation_usage_fact
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != 1 {
		t.Fatalf("usage facts without reservation = %d, want 1", got)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.quota_reservation
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != 0 {
		t.Fatalf("unexpected reservations = %d, want 0", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state FROM work.operation
		WHERE org_id = %s AND id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "succeeded" {
		t.Fatalf("operation state = %q, want succeeded", got)
	}
}

func TestR0bModelResultFrameUnknownKeepsQuotaHeldAndUsageAbsent(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_result_unknown")
	worker := a.workerConn(t)
	operationID, attemptID := prepareAuthorizedDeviceModelAction(t, a, "model:local:1")
	reserveDeviceModelQuota(t, a, operationID)
	a.consumePermit(t, worker, operationID, attemptID)
	payload := modelResultFramePayload(t, a, operationID, attemptID, "unknown", "")

	got := recordModelResultFrame(t, worker, a, a.deviceID, payload)
	if got["state"] != "recorded" || got["replayed"] != false {
		t.Fatalf("unknown model result = %#v", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state FROM work.operation
		WHERE org_id = %s AND id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "unknown" {
		t.Fatalf("operation state = %q, want unknown", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state FROM work.quota_reservation
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "held" {
		t.Fatalf("reservation state = %q, want held", got)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.operation_usage_fact
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != 0 {
		t.Fatalf("unknown usage facts = %d, want 0", got)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.operation_resolution
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != 0 {
		t.Fatalf("unknown resolutions = %d, want 0", got)
	}
}

func TestR0bModelResultFrameFailureSettlesZeroAndCompletesExecution(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_result_failed")
	worker := a.workerConn(t)
	operationID, attemptID := prepareAuthorizedDeviceModelAction(t, a, "model:local:1")
	reserveDeviceModelQuota(t, a, operationID)
	a.consumePermit(t, worker, operationID, attemptID)
	payload := modelResultFramePayload(t, a, operationID, attemptID, "completed", "failed")

	got := recordModelResultFrame(t, worker, a, a.deviceID, payload)
	if got["state"] != "recorded" {
		t.Fatalf("failed model result = %#v", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state FROM work.operation
		WHERE org_id = %s AND id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "failed" {
		t.Fatalf("operation state = %q, want failed", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state || '/' || settled_tokens FROM work.quota_reservation
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "settled/0" {
		t.Fatalf("reservation = %q, want settled/0", got)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.operation_usage_fact
		WHERE org_id = %s AND operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != 0 {
		t.Fatalf("failed usage facts = %d, want 0", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state || '/' || terminal_reason FROM work.runtime_execution e
		WHERE e.org_id = %s AND e.operation_id = %s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "completed/model_result_failed" {
		t.Fatalf("execution = %q", got)
	}
}

func TestR0bModelResultFrameLateSuccessAfterCancellationStillCountsUsage(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_result_late_cancel")
	worker := a.workerConn(t)
	operationID, attemptID := prepareAuthorizedDeviceModelAction(t, a, "model:local:1")
	reservationID := reserveDeviceModelQuota(t, a, operationID)
	a.consumePermit(t, worker, operationID, attemptID)
	if _, err := worker.Exec(testContext(t), `
		SELECT work.issue_operation_resolution($1,$2::uuid,'failed',NULL,NULL,$3,NULL,'{}'::jsonb)`,
		a.org, operationID, "sha256:"+strings.Repeat("a", 64)); err != nil {
		t.Fatalf("issue terminal resolution: %v", err)
	}
	if _, err := worker.Exec(testContext(t), `SELECT work.release_quota($1::uuid)`, reservationID); err != nil {
		t.Fatalf("release_quota: %v", err)
	}
	payload := modelResultFramePayload(t, a, operationID, attemptID, "completed", "succeeded")

	if got := recordModelResultFrame(t, worker, a, a.deviceID, payload); got["state"] != "recorded" {
		t.Fatalf("late canceled model result = %#v", got)
	}
	if got := a.scalar(t, fmt.Sprintf(`SELECT state FROM work.operation
		WHERE org_id=%s AND id=%s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != "failed" {
		t.Fatalf("late result changed terminal operation state to %q", got)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.operation_usage_fact
		WHERE org_id=%s AND operation_id=%s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != 1 {
		t.Fatalf("late result usage facts = %d, want 1", got)
	}
	if got := a.scalarInt(t, fmt.Sprintf(`SELECT count(*) FROM work.device_model_result
		WHERE org_id=%s AND operation_id=%s`, quoteLiteral(a.org), quoteLiteral(operationID))); got != 1 {
		t.Fatalf("late result rows = %d, want 1", got)
	}
}

func TestR0bModelResultFrameRefusesBadShapeForeignDeviceAndAPIRole(t *testing.T) {
	a := newActionFixture(t, "org_r0b_model_result_guards")
	worker := a.workerConn(t)
	operationID, attemptID := prepareAuthorizedDeviceModelAction(t, a, "model:local:1")
	reserveDeviceModelQuota(t, a, operationID)
	a.consumePermit(t, worker, operationID, attemptID)
	payload := modelResultFramePayload(t, a, operationID, attemptID, "completed", "succeeded")

	extra := modelResultFramePayload(t, a, operationID, attemptID, "completed", "succeeded")
	extra["content"] = "forbidden"
	expectCode(t, worker, "invalid_request",
		`SELECT work.record_device_model_result_frame($1,$2::uuid,$3::jsonb)`,
		a.org, a.deviceID, extra)
	badUsage := modelResultFramePayload(t, a, operationID, attemptID, "completed", "succeeded")
	badUsage["usage"].(map[string]any)["cached_input_tokens"] = "11"
	expectCode(t, worker, "invalid_request:usage",
		`SELECT work.record_device_model_result_frame($1,$2::uuid,$3::jsonb)`,
		a.org, a.deviceID, badUsage)
	expectCode(t, worker, "runtime_execution_binding_conflict",
		`SELECT work.record_device_model_result_frame($1,$2::uuid,$3::jsonb)`,
		a.org, newUUID(t), payload)

	payload["provider_request_id"] = nil
	if got := recordModelResultFrame(t, worker, a, a.deviceID, payload); got["state"] != "recorded" {
		t.Fatalf("model result without provider request id = %#v", got)
	}

	api := a.apiConn(t)
	_, err := api.Exec(testContext(t),
		`SELECT work.record_device_model_result_frame($1,$2::uuid,$3::jsonb)`,
		a.org, a.deviceID, payload)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Fatalf("work_api model result frame error = %#v, want permission denied", err)
	}
}
