package migrate

import (
	"encoding/json"
	"strings"
	"testing"
)

func revokeAccountingDevice(t *testing.T, a *actionFixture, requestID, reason string) string {
	t.Helper()
	out := callJSON(t, a.apiConn(t),
		`SELECT work.revoke_device($1,$2,$3::uuid,$4,$5)`,
		a.org, a.subject, a.deviceID, requestID, reason)
	if out["status"] != "revoked" {
		t.Fatalf("revoke = %#v", out)
	}
	return idOf(t, out, "restriction_id")
}

func TestR0bRecordedReceiptSurvivesCompromisedDeviceRevocation(t *testing.T) {
	a, op, attempt := reviewDispatchedAction(t)
	worker := a.workerConn(t)
	body, journal := reviewReceipt(t, a, op, attempt, a.sessionID)
	recorded := reviewRecord(t, a, a.deviceID, journal, body)
	if len(recorded["recorded"].([]any)) != 1 || len(recorded["conflicts"].([]any)) != 0 {
		t.Fatalf("historical completed receipt = %#v", recorded)
	}

	receiptHash := a.scalar(t, "SELECT signed_payload_hash FROM work.device_receipt WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op))
	resolveID := a.scalar(t, "SELECT resolve_id::text FROM work.operation_resolution WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op))
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE id="+quoteLiteral(op)); got != "succeeded" {
		t.Fatalf("completed receipt Operation state = %q, want succeeded", got)
	}
	if got := a.scalar(t, "SELECT resolution_source || '/' || server_only::text FROM work.device_receipt WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)); got != "device/false" {
		t.Fatalf("device receipt provenance = %q", got)
	}
	if got := a.scalar(t, "SELECT evidence ->> 'source' FROM work.operation_resolution WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)); got != "device_receipt" {
		t.Fatalf("resolution evidence source = %q", got)
	}

	denyID := revokeAccountingDevice(t, a, "req-compromised-revoke", "key_compromised")
	if got := a.scalar(t, "SELECT reason FROM work.access_restriction WHERE id="+quoteLiteral(denyID)); got != "key_compromised" {
		t.Fatalf("compromised deny reason = %q", got)
	}
	if got := a.scalar(t, "SELECT signed_payload_hash FROM work.device_receipt WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)); got != receiptHash {
		t.Fatal("revocation rewrote an already recorded receipt")
	}
	if got := a.scalar(t, "SELECT resolve_id::text FROM work.operation_resolution WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)); got != resolveID {
		t.Fatal("revocation rewrote an already issued resolution")
	}
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE id="+quoteLiteral(op)); got != "succeeded" {
		t.Fatalf("revocation rolled back settled Operation to %q", got)
	}

	operationsBefore := a.scalarInt(t, "SELECT count(*) FROM work.operation WHERE org_id="+quoteLiteral(a.org))
	late, _ := reviewReceipt(t, a, op, attempt, a.sessionID)
	late["receipt_seq"] = float64(2)
	expectCode(t, worker, "device_revoked",
		`SELECT work.record_device_receipt($1,$2::uuid,$3::uuid,$4::jsonb)`,
		a.org, a.deviceID, journal, mustJSON(t, []any{late}))
	expectCode(t, worker, "device_revoked",
		`SELECT work.prepare_local_operation($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb)`,
		a.org, a.runID, a.deviceID, a.sessionID, a.leaseID, a.fence, a.checkpointSeq,
		a.actionBody(t, "after-compromise", a.grantClass))
	if got := a.scalarInt(t, "SELECT count(*) FROM work.operation WHERE org_id="+quoteLiteral(a.org)); got != operationsBefore {
		t.Fatalf("revoked device created %d new Operations", got-operationsBefore)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_receipt WHERE org_id="+quoteLiteral(a.org)); got != 1 {
		t.Fatalf("late compromised receipt changed device_receipt rows: %d", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.operation_resolution WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)); got != 1 {
		t.Fatalf("late compromised receipt changed resolutions: %d", got)
	}
}

func TestR0bPrivateKeyLossKeepsStartedOnlyUnknownUntilServerEvidence(t *testing.T) {
	a, op, attempt := reviewDispatchedAction(t)
	worker := a.workerConn(t)
	started, journal := reviewReceipt(t, a, op, attempt, a.sessionID)
	started["state"] = "started"
	started["outcome"] = nil
	if out := reviewRecord(t, a, a.deviceID, journal, started); len(out["recorded"].([]any)) != 1 {
		t.Fatalf("started receipt = %#v", out)
	}

	denyID := revokeAccountingDevice(t, a, "req-key-loss-revoke", "private_key_lost")
	late, _ := reviewReceipt(t, a, op, attempt, a.sessionID)
	late["receipt_seq"] = float64(2)
	expectCode(t, worker, "device_revoked",
		`SELECT work.record_device_receipt($1,$2::uuid,$3::uuid,$4::jsonb)`,
		a.org, a.deviceID, journal, mustJSON(t, []any{late}))

	mustExec(t, a.admin, "UPDATE work.operation SET state='unknown' WHERE id="+quoteLiteral(op))
	mustExec(t, a.admin, "UPDATE work.run SET state='waiting', wait_reason='reconcile' WHERE id="+quoteLiteral(a.runID))
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE id="+quoteLiteral(op)); got != "unknown" {
		t.Fatalf("started-only Operation state = %q, want unknown", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.operation_resolution WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)); got != 0 {
		t.Fatalf("key loss auto-created %d resolutions", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_receipt WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)+" AND state='completed'"); got != 0 {
		t.Fatalf("key loss created %d completed device receipts", got)
	}
	reservationsBefore := a.scalar(t, `SELECT COALESCE(string_agg(state, ',' ORDER BY reservation_seq), '')
		FROM work.quota_reservation WHERE org_id=`+quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op))

	result := issueResolution(t, a.admin, a.org, op, "failed", "evidence_exhausted", "OPS-KEY-LOSS-1",
		map[string]any{"source": "ops", "ticket": "OPS-KEY-LOSS-1"})
	if result["operation_state"] != "reconciled" || result["settlement_state"] != "unknown" {
		t.Fatalf("server-only key-loss verdict = %#v", result)
	}
	if got := a.scalar(t, "SELECT state FROM work.operation WHERE id="+quoteLiteral(op)); got != "reconciled" {
		t.Fatalf("server-only verdict Operation state = %q", got)
	}
	if got := a.scalar(t, `SELECT COALESCE(string_agg(state, ',' ORDER BY reservation_seq), '')
		FROM work.quota_reservation WHERE org_id=`+quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)); got != reservationsBefore {
		t.Fatalf("server-only degradation changed reservations: %q -> %q", reservationsBefore, got)
	}
	if got := a.scalar(t, "SELECT code FROM work.operation_resolution WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)); got != "evidence_exhausted" {
		t.Fatalf("resolution code = %q", got)
	}
	if got := a.scalar(t, "SELECT (evidence -> 'server_basis' -> 'revoked_devices' -> 0 ->> 'device_id') FROM work.operation_resolution WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)); got != a.deviceID {
		t.Fatalf("server basis revoked device = %q, want %s", got, a.deviceID)
	}
	if got := a.scalar(t, "SELECT ticket_id FROM work.operation_resolution WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)); got != "OPS-KEY-LOSS-1" {
		t.Fatalf("resolution ticket = %q", got)
	}
	if got := a.scalar(t, "SELECT reason FROM work.access_restriction WHERE id="+quoteLiteral(denyID)); got != "private_key_lost" {
		t.Fatalf("key-loss deny reason = %q", got)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_receipt WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)); got != 1 {
		t.Fatalf("server-only verdict fabricated device receipts: %d", got)
	}
	if !strings.Contains(a.scalar(t, "SELECT evidence::text FROM work.operation_resolution WHERE org_id="+
		quoteLiteral(a.org)+" AND operation_id="+quoteLiteral(op)), `"source": "ops"`) {
		t.Fatal("server-only verdict lost its ops evidence provenance")
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
