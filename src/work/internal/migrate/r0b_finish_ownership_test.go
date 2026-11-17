package migrate

import (
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// GW12 / 0053: finish_local_run is bound to the calling device and session.
//
// 0042 derived the device and session FROM THE LEASE ROW and only compared the binding against
// that lease, never either against the caller. So any authenticated device that learned another
// device's lease_id + binding_revision + fence could finish that Run: terminal state, lease
// released, readonly grants invalidated, runtime executions revoked. work_worker has no SELECT
// on those tables (0024), so the judgment has to live in the definer command.

// finishProposal builds the closed eight-key p_finish object local_run_finish_valid demands
// (0042:582-593). reason_code must be PRESENT even when null, the seqs are decimal strings like
// the wire, and device_signature is the real ES256 form 0053 now demands.
func finishProposal(outcome, reason string, seq int64, checkpointHash, setHash string, through int64, signature string) string {
	reasonField := "null"
	if reason != "" {
		reasonField = `"` + reason + `"`
	}
	return fmt.Sprintf(`{"outcome":%q,"reason_code":%s,"final_checkpoint_seq":"%d",`+
		`"final_checkpoint_hash":%q,"receipt_through_seq":"%d","final_operation_set_hash":%q,`+
		`"deliverable_versions":[],"device_signature":%q}`,
		outcome, reasonField, seq, checkpointHash, through, setHash, signature)
}

const finishSQL = `SELECT work.finish_local_run($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8::uuid,$9::uuid)`

// entitledFinish is the proposal the fixture's own device/session is entitled to make: a failed
// outcome (so the completed gate's deliverable requirement does not apply), the latest recorded
// checkpoint, the real receipt watermark and the server's own recomputed operation-set hash.
func entitledFinish(t *testing.T, a *actionFixture) string {
	t.Helper()
	setHash := a.scalar(t, "SELECT work.local_operation_set_hash("+quoteLiteral(a.org)+", "+
		quoteLiteral(a.runID)+")")
	return finishProposal("failed", "model_error", a.checkpointSeq, a.checkpointHash, setHash, 0,
		strings.Repeat("7", 86))
}

func (a *actionFixture) callFinish(t *testing.T, worker *pgx.Conn, finishID, body, deviceID, sessionID string) map[string]any {
	t.Helper()
	return callJSON(t, worker, finishSQL,
		a.org, a.runID, finishID, a.leaseID, 1, a.fence, body, deviceID, sessionID)
}

// finishRowCount reads how many verdict rows exist for the Run — a refused identity must leave
// none, because even the rejected row is evidence of an adjudication that never ran.
func (a *actionFixture) finishRowCount(t *testing.T) int {
	t.Helper()
	return a.scalarInt(t, "SELECT count(*) FROM work.device_run_finish WHERE run_id = "+
		quoteLiteral(a.runID))
}

// TestR0bFinishAcceptsFromTheLeaseOwner is the happy path under the new nine-argument signature:
// the entitled device/session gets an accepted verdict, and the terminal write set 0042's
// finish_local_run_state owns is read back — Run failed, lease released, binding finished, Task
// no longer pointing at the Run. A replay of the same finish_id returns the same revision.
func TestR0bFinishAcceptsFromTheLeaseOwner(t *testing.T) {
	a := newActionFixture(t, "org_gw12_finish_ok")
	worker := a.workerConn(t)
	finishID := newUUID(t)
	body := entitledFinish(t, a)

	out := a.callFinish(t, worker, finishID, body, a.deviceID, a.sessionID)
	if out["state"] != "accepted" || out["code"] != nil {
		t.Fatalf("finish = %#v, want accepted with no code", out)
	}
	revision, ok := out["terminal_run_revision"].(float64)
	if !ok || revision < 1 {
		t.Fatalf("terminal_run_revision = %v, want a positive control revision", out["terminal_run_revision"])
	}
	if out["replayed"] != false {
		t.Fatalf("first verdict claims replayed: %#v", out)
	}
	if got := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); got != "failed" {
		t.Fatalf("Run state = %q, want failed", got)
	}
	if got := a.scalar(t, "SELECT terminal_reason FROM work.run WHERE id = "+quoteLiteral(a.runID)); got != "model_error" {
		t.Fatalf("terminal_reason = %q, want the proposed model_error", got)
	}
	if got := a.scalar(t, "SELECT state FROM work.execution_lease WHERE id = "+quoteLiteral(a.leaseID)); got != "released" {
		t.Fatalf("lease state = %q, want released", got)
	}
	if got := a.scalar(t, "SELECT state FROM work.device_run_binding WHERE run_id = "+
		quoteLiteral(a.runID)+" AND binding_revision = 1"); got != "finished" {
		t.Fatalf("binding state = %q, want finished", got)
	}
	if got := a.scalar(t, "SELECT coalesce(active_run_id::text,'') FROM work.task WHERE id = "+
		"(SELECT task_id FROM work.run WHERE id = "+quoteLiteral(a.runID)+")"); got != "" {
		t.Fatalf("task.active_run_id = %q, want cleared", got)
	}
	if got := a.scalar(t, "SELECT latest_run_id::text FROM work.task WHERE id = "+
		"(SELECT task_id FROM work.run WHERE id = "+quoteLiteral(a.runID)+")"); got != a.runID {
		t.Fatalf("task.latest_run_id = %q, want %s", got, a.runID)
	}

	replay := a.callFinish(t, worker, finishID, body, a.deviceID, a.sessionID)
	if replay["replayed"] != true || replay["state"] != "accepted" ||
		replay["terminal_run_revision"] != out["terminal_run_revision"] {
		t.Fatalf("replay = %#v, want the original verdict and revision %v", replay, out["terminal_run_revision"])
	}
	if got := a.finishRowCount(t); got != 1 {
		t.Fatalf("finish rows = %d, want exactly 1", got)
	}
}

// TestR0bFinishRefusesForeignDeviceAndSupersededSession is the vulnerability 0053 closes. The
// foreign case is the discriminating one: the caller presents its OWN active, device-owned
// session, so gate 1 passes, and the lease/binding pair is internally consistent (both belong to
// the victim), so 0042's binding-vs-lease comparison passes too — only the new lease-vs-CALLER
// gate refuses it. Under 0042 this call finished the victim's Run.
func TestR0bFinishRefusesForeignDeviceAndSupersededSession(t *testing.T) {
	cases := []struct {
		name string
		// identity returns the device/session the proposal is made under.
		identity func(t *testing.T, a *actionFixture) (string, string)
	}{
		{"another device's own live session", func(t *testing.T, a *actionFixture) (string, string) {
			return seedSecondDevice(t, a.orchestrationFixture)
		}},
		{"this device's superseded session", func(t *testing.T, a *actionFixture) (string, string) {
			return a.deviceID, seedSupersededSession(t, a.orchestrationFixture)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := newActionFixture(t, "org_gw12_finish_foreign")
			worker := a.workerConn(t)
			deviceID, sessionID := tc.identity(t, a)
			expectCode(t, worker, "unauthorized", finishSQL,
				a.org, a.runID, newUUID(t), a.leaseID, 1, a.fence, entitledFinish(t, a), deviceID, sessionID)
			if got := a.finishRowCount(t); got != 0 {
				t.Fatalf("a refused identity wrote %d verdict rows, want 0", got)
			}
			if got := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); got != "active" {
				t.Fatalf("Run state = %q, want the untouched active", got)
			}
			if got := a.scalar(t, "SELECT state FROM work.execution_lease WHERE id = "+quoteLiteral(a.leaseID)); got != "active" {
				t.Fatalf("lease state = %q, want the untouched active", got)
			}
		})
	}
}

// TestR0bFinishRejectsThePlaceholderSignatureShape proves 0053 reconciled device_signature with
// the real device signature exactly as 0046/0048/0050/0052 did: the internal sha256 placeholder
// is now invalid_request, and nothing is written. The accepted form is covered by the happy path.
func TestR0bFinishRejectsThePlaceholderSignatureShape(t *testing.T) {
	a := newActionFixture(t, "org_gw12_finish_shape")
	worker := a.workerConn(t)
	setHash := a.scalar(t, "SELECT work.local_operation_set_hash("+quoteLiteral(a.org)+", "+
		quoteLiteral(a.runID)+")")
	body := finishProposal("failed", "model_error", a.checkpointSeq, a.checkpointHash, setHash, 0,
		"sha256:"+strings.Repeat("4", 64))
	expectCode(t, worker, "invalid_request", finishSQL,
		a.org, a.runID, newUUID(t), a.leaseID, 1, a.fence, body, a.deviceID, a.sessionID)
	if got := a.finishRowCount(t); got != 0 {
		t.Fatalf("a shape refusal wrote %d verdict rows, want 0", got)
	}
}

// TestR0bFinishRecordsARejectedCompletedProposalWithNoDeliverable is the 0042 defect 0053 change
// 3 fixes (主签 2026-11-17). §6.4 step 4 answers a completed proposal with an empty deliverable
// list finish_precondition_failed, and 0042:1903-1905 keeps the refused proposal as evidence —
// but the table's deliverable shape CHECK demanded completed => non-empty on EVERY row, so the
// evidence INSERT itself died on 23514 and the device got a transport error instead of a verdict.
// The exemption must not relax the accepted path: a completed proposal with a bogus version is
// still refused, because the deliverable has to be a published local_only version of THIS Run.
func TestR0bFinishRecordsARejectedCompletedProposalWithNoDeliverable(t *testing.T) {
	a := newActionFixture(t, "org_gw12_finish_empty")
	worker := a.workerConn(t)
	setHash := a.scalar(t, "SELECT work.local_operation_set_hash("+quoteLiteral(a.org)+", "+
		quoteLiteral(a.runID)+")")
	empty := finishProposal("completed", "", a.checkpointSeq, a.checkpointHash, setHash, 0,
		strings.Repeat("7", 86))

	out := a.callFinish(t, worker, newUUID(t), empty, a.deviceID, a.sessionID)
	if out["state"] != "rejected" || out["code"] != "finish_precondition_failed" {
		t.Fatalf("empty-deliverable completed = %#v, want rejected/finish_precondition_failed", out)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_run_finish WHERE run_id = "+
		quoteLiteral(a.runID)+" AND state = 'rejected' AND outcome = 'completed' AND "+
		"deliverable_versions = '[]'::jsonb"); got != 1 {
		t.Fatalf("rejected evidence rows = %d, want 1 (the refusal is evidence too)", got)
	}
	if got := a.scalar(t, "SELECT state FROM work.run WHERE id = "+quoteLiteral(a.runID)); got != "active" {
		t.Fatalf("Run state = %q, want the untouched active", got)
	}
	if got := a.scalar(t, "SELECT state FROM work.execution_lease WHERE id = "+quoteLiteral(a.leaseID)); got != "active" {
		t.Fatalf("lease state = %q, want the untouched active", got)
	}

	// The exemption is for the evidence row only: a non-empty list of versions that are not this
	// Run's published local_only artifacts is still refused, so no success criterion was widened.
	bogus := strings.Replace(empty, `"deliverable_versions":[]`,
		`"deliverable_versions":["`+newUUID(t)+`"]`, 1)
	out2 := a.callFinish(t, worker, newUUID(t), bogus, a.deviceID, a.sessionID)
	if out2["state"] != "rejected" || out2["code"] != "finish_precondition_failed" {
		t.Fatalf("bogus-deliverable completed = %#v, want rejected/finish_precondition_failed", out2)
	}
	if got := a.scalarInt(t, "SELECT count(*) FROM work.device_run_finish WHERE run_id = "+
		quoteLiteral(a.runID)+" AND state = 'accepted'"); got != 0 {
		t.Fatalf("accepted rows = %d, want 0 (the completed gate still holds)", got)
	}
}

// TestR0bFinishRefusesRevokedDeviceEvenOnReplay proves gate 1 sits AHEAD of the idempotency
// lookup (0050/0052 precedent): once the device is revoked it cannot even retrieve the verdict it
// already earned, let alone earn a new one.
func TestR0bFinishRefusesRevokedDeviceEvenOnReplay(t *testing.T) {
	a := newActionFixture(t, "org_gw12_finish_revoked")
	worker := a.workerConn(t)
	finishID := newUUID(t)
	body := entitledFinish(t, a)
	if out := a.callFinish(t, worker, finishID, body, a.deviceID, a.sessionID); out["state"] != "accepted" {
		t.Fatalf("setup finish = %#v, want accepted", out)
	}
	mustExec(t, a.admin, "UPDATE work.device SET status = 'revoked', revoked_at = now() WHERE id = "+
		quoteLiteral(a.deviceID))
	expectCode(t, worker, "device_revoked", finishSQL,
		a.org, a.runID, finishID, a.leaseID, 1, a.fence, body, a.deviceID, a.sessionID)
	if got := a.finishRowCount(t); got != 1 {
		t.Fatalf("finish rows = %d, want the original 1 (no second verdict)", got)
	}
}