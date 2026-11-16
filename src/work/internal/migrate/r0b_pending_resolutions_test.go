package migrate

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/testpg"
)

// Tests for increment 0049: pending_device_resolutions, the gateway's read path for the
// server-signed operation_resolution downlink (M3 GW7). The getter targets a device's
// un-acked resolutions through the Run's latest device_run_binding (主签 2026-11-16 裁定＝
// run 级), skips the two terminal watermarks, and returns the wire conclusion fields without
// the internal signature placeholder (the gateway signs the wire frame itself).

// seedBindingDevice inserts a fresh active device + active session and a device_run_binding
// at the given revision pointing the Run at them. Calling it twice on one Run with rising
// revisions models a resume rebind: the highest revision is the current association.
func seedBindingDevice(t *testing.T, dbName, org string, run *gateRun, revision int) (deviceID, sessionID string) {
	t.Helper()
	deviceID = newUUID(t)
	sessionID = newUUID(t)
	// One live device per (org, thumbprint): a rebind seeds a second device, so each
	// needs its own thumbprint (the JWK coordinates may stay fixed; the index is on the
	// thumbprint, and pairing—not INSERT—is what binds it to the key).
	thumb := strings.ReplaceAll(newUUID(t), "-", "")
	thumb += thumb
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.device
		  (org_id, id, owner_subject_id, device_name, platform, public_key_jwk,
		   public_key_thumbprint, auth_plane, auth_epoch, status)
		VALUES ('%s','%s','%s','desk','windows-x64',
		        '{"crv":"P-256","kty":"EC","x":"%s","y":"%s"}'::jsonb,
		        '%s','bearer',0,'active');
		INSERT INTO work.device_session
		  (org_id, id, device_id, owner_subject_id, boot_id, agent_instance_id,
		   auth_plane, auth_epoch, protocol_major, protocol_minor, runtime_digest,
		   journal_epoch, generation, expires_at, state)
		VALUES ('%s','%s','%s','%s','boot-pending','%s','bearer',0,2,0,
		        '%s','%s',1, now() + interval '1 hour','active');
		INSERT INTO work.device_run_binding
		  (org_id, run_id, binding_revision, task_id, device_id, session_id, input_ref,
		   input_hash, snapshot_hash, profile_id, profile_revision, runtime_digest,
		   tool_manifest_hash, model_version, grant_set, start_nonce, offer_expiry, state)
		VALUES ('%s','%s',%d,'%s','%s','%s','ref','%s','%s','p1',1,'%s','%s','m1',
		        '[{"grant_id":"%s","grant_revision":1}]'::jsonb,'%s',
		        now() + interval '2 minutes','active');
	`, org, deviceID, run.subject, strings.Repeat("A", 43), strings.Repeat("B", 43),
		thumb,
		org, sessionID, deviceID, run.subject, newUUID(t), strings.Repeat("d", 64), newUUID(t),
		org, run.runID, revision, run.taskID, deviceID, sessionID,
		strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64),
		strings.Repeat("5", 64), newUUID(t), newUUID(t)))
	return deviceID, sessionID
}

// seedOperationResolution inserts one Operation on the Run and a resolution at revision 1
// in the given delivery watermark. The row is written directly: the getter reads the table,
// and how a conclusion arrives is issue_operation_resolution's concern (tested elsewhere).
func seedOperationResolution(t *testing.T, dbName, org string, run *gateRun, delivery string) (opID, resolveID string) {
	t.Helper()
	opID = newUUID(t)
	resolveID = newUUID(t)
	ackedAt := "NULL"
	if delivery == "acked" {
		ackedAt = "now()"
	}
	r0bExec(t, dbName, org, fmt.Sprintf(`
		INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state)
		VALUES ('%s','%s','%s','%s','tool','%s','dispatching');
		INSERT INTO work.operation_resolution
		  (org_id, run_id, operation_id, resolution_revision, resolve_id, state,
		   delivery_state, settlement_state, signature, resolution_delivery, acked_at)
		VALUES ('%s','%s','%s',1,'%s','failed','not_applicable','unknown','sha256:%s','%s',%s);
	`, opID, org, run.runID, "tool:"+opID, strings.Repeat("c", 64),
		org, run.runID, opID, resolveID, strings.Repeat("e", 64), delivery, ackedAt))
	return opID, resolveID
}

func claimPendingResolutions(t *testing.T, conn *pgx.Conn, org, deviceID, sessionID string) []map[string]any {
	t.Helper()
	var raw []byte
	if err := conn.QueryRow(testContext(t),
		`SELECT work.claim_pending_device_resolutions($1,$2::uuid,$3::uuid)`,
		org, deviceID, sessionID).Scan(&raw); err != nil {
		t.Fatalf("claim_pending_device_resolutions: %v", err)
	}
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestR0bPendingResolutionsSkipsTerminalWatermarksAndOmitsSignature(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_pending_res"
	run := seedRun(t, admin, org)
	deviceID, sessionID := seedBindingDevice(t, dbName, org, run, 1)
	pendingOp, pendingResolve := seedOperationResolution(t, dbName, org, run, "pending")
	seedOperationResolution(t, dbName, org, run, "acked")
	seedOperationResolution(t, dbName, org, run, "not_applicable")
	// 'delivered' is still un-acked, so it stays in the re-push set (RB-A21: 不在 {acked,
	// not_applicable}).
	deliveredOp, deliveredResolve := seedOperationResolution(t, dbName, org, run, "delivered")

	worker := workerConn(t, dbName, org)
	got := claimPendingResolutions(t, worker, org, deviceID, sessionID)
	if len(got) != 2 {
		t.Fatalf("pending queue = %d rows, want 2 (pending + delivered): %#v", len(got), got)
	}
	byResolve := map[string]map[string]any{}
	for _, row := range got {
		rid, _ := row["resolve_id"].(string)
		byResolve[rid] = row
	}
	for _, rid := range []string{pendingResolve, deliveredResolve} {
		row, ok := byResolve[rid]
		if !ok {
			t.Fatalf("resolution %s missing from the queue: %#v", rid, got)
		}
		if _, leaked := row["signature"]; leaked {
			t.Fatalf("getter leaked the internal signature placeholder: %#v", row)
		}
		if row["resolution_revision"] != float64(1) {
			t.Fatalf("resolution_revision = %v, want 1", row["resolution_revision"])
		}
		if row["state"] != "failed" || row["settlement_state"] != "unknown" {
			t.Fatalf("conclusion fields = %#v", row)
		}
		if row["attempt_id"] != nil {
			t.Fatalf("attempt_id = %v, want null (no permit issued)", row["attempt_id"])
		}
	}
	if byResolve[pendingResolve]["operation_id"] != pendingOp {
		t.Fatalf("operation_id = %v, want %s", byResolve[pendingResolve]["operation_id"], pendingOp)
	}
	if byResolve[deliveredResolve]["operation_id"] != deliveredOp {
		t.Fatalf("delivered operation_id = %v, want %s", byResolve[deliveredResolve]["operation_id"], deliveredOp)
	}

	// The claim is a write: the pending conclusion advanced to delivered (so
	// consume_device_ack can later ack delivered->acked), while the two terminal
	// watermarks were left untouched.
	if got := scalarString(t, admin,
		`SELECT resolution_delivery FROM work.operation_resolution WHERE resolve_id = $1`, pendingResolve); got != "delivered" {
		t.Fatalf("claimed pending resolution delivery = %q, want delivered", got)
	}
	if got := scalarCount(t, admin,
		`SELECT delivery_attempts FROM work.operation_resolution WHERE resolve_id = $1`, pendingResolve); got != 1 {
		t.Fatalf("claimed pending resolution delivery_attempts = %d, want 1", got)
	}
	if got := scalarCount(t, admin,
		`SELECT count(*) FROM work.operation_resolution
		 WHERE org_id = $1 AND resolution_delivery IN ('acked','not_applicable') AND delivery_attempts <> 0`, org); got != 0 {
		t.Fatalf("the claim touched %d terminal-watermark rows, want 0", got)
	}
}

func TestR0bPendingResolutionsFollowsTheLatestBinding(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_pending_rebind"
	run := seedRun(t, admin, org)
	firstDevice, firstSession := seedBindingDevice(t, dbName, org, run, 1)
	_, resolveID := seedOperationResolution(t, dbName, org, run, "pending")

	worker := workerConn(t, dbName, org)
	if got := claimPendingResolutions(t, worker, org, firstDevice, firstSession); len(got) != 1 {
		t.Fatalf("queue before rebind = %d, want 1", len(got))
	}

	// A resume rebinds the Run to a second device at a higher revision. The conclusion now
	// belongs to the second device's journal; the first device must stop receiving it.
	secondDevice, secondSession := seedBindingDevice(t, dbName, org, run, 2)
	if got := claimPendingResolutions(t, worker, org, firstDevice, firstSession); len(got) != 0 {
		t.Fatalf("first device still drained the queue after rebind: %#v", got)
	}
	got := claimPendingResolutions(t, worker, org, secondDevice, secondSession)
	if len(got) != 1 || got[0]["resolve_id"] != resolveID {
		t.Fatalf("second device queue = %#v, want the pending resolution %s", got, resolveID)
	}
}

func TestR0bPendingResolutionsGuardsSessionOrgAndRole(t *testing.T) {
	dbName, admin := newGateDB(t)
	org := "org_r0b_pending_guard"
	run := seedRun(t, admin, org)
	deviceID, sessionID := seedBindingDevice(t, dbName, org, run, 1)
	seedOperationResolution(t, dbName, org, run, "pending")
	worker := workerConn(t, dbName, org)

	// A session that is not this device's active session cannot drain the queue.
	expectCode(t, worker, "unauthorized",
		`SELECT work.claim_pending_device_resolutions($1,$2::uuid,$3::uuid)`,
		org, deviceID, newUUID(t))
	// The org guard refuses a context mismatch before any read.
	expectCode(t, worker, "org_context_mismatch",
		`SELECT work.claim_pending_device_resolutions($1,$2::uuid,$3::uuid)`,
		"org_other", deviceID, sessionID)

	// work_api has no EXECUTE: the downlink queue belongs to the machine workload only
	// (0024 grants no table privilege, so the definer EXECUTE grant is the whole boundary).
	api := connect(t, testpg.AppURL(dbName))
	t.Cleanup(func() { _ = api.Close(context.Background()) })
	mustExec(t, api, "SET app.org_id = "+quoteLiteral(org))
	expectCode(t, api, "permission denied",
		`SELECT work.claim_pending_device_resolutions($1,$2::uuid,$3::uuid)`,
		org, deviceID, sessionID)
}