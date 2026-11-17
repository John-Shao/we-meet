package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/devicesig"
)

// GW15: the cancel downlink and the cancel_ack uplink (device-design §3.1 cancel row, §3.4
// step 4; control-design §6.1). request_cancel and ops_cancel_run already put a Run into
// cancel_requested, but nothing ever told the device, so finish_local_run's run_cancel_requested
// verdict was unreachable in practice. 0056 adds the read-only getter and the ack command.
//
// TWO WIRE EXTENSIONS (annotated in §3.1, original text preserved). The row lists
// `run_id、cancel_revision / stopped_or_unknown、last_receipt_seq`. ① Both sides are signed
// (ruled 主签 2026-11-17＝两侧都签): the row lists no signature member, but stopped_or_unknown
// decides whether an in-flight Operation becomes unknown, so it is a consequential fact
// assertion rather than a liveness signal like heartbeat — the same "required but no place"
// class GW13 fixed for action_prepared and GW14 for command. ② The ACK side omits run_id and
// cancel_revision, yet one session can hold several Runs and the server must know which cancel
// is being acknowledged at which revision; without them the ack is uncallable. The closed ack
// body is therefore run_id/cancel_revision/stopped_or_unknown/last_receipt_seq/signature.
// cancel_revision has an existing source — run.control_revision, which request_cancel already
// bumps — so no new counter is invented.
//
// The gateway translates and forwards; it never judges. Whether the Run may be acknowledged,
// whether the revision matches, and what 'stopped' versus 'unknown' does to each Operation are
// all SQL's, from server facts (work_worker has no SELECT on run/operation/device_session, 0024).
//
// There is NO server response to cancel_ack: §3.1 registers no third frame, and the ack is a
// fact assertion rather than a proposal awaiting a verdict (operation_resolution_ack and
// run_started precedent). A refusal is a gRPC status that terminates the stream, so the device
// reconnects and the read-only getter re-pushes the cancel.

// pendingCancel is one row of list_pending_device_cancels (0056). cancel_revision is already a
// decimal string: the getter casts control_revision::text at the JSON boundary (§3.1 uint64).
type pendingCancel struct {
	RunID          string `json:"run_id"`
	CancelRevision string `json:"cancel_revision"`
}

// cancelWire builds the closed three-key cancel body: §3.1's two plus the server signature
// added by signedDownlink. Nothing else rides along — the device already holds the Run's
// binding, lease and journal, and a cancel is an instruction to stop, not a re-offer.
func cancelWire(c *pendingCancel) map[string]any {
	return map[string]any{
		"run_id":          c.RunID,
		"cancel_revision": c.CancelRevision,
	}
}

// listCancels reads the device's pending cancels through the 0056 getter as work_worker. It is
// READ-ONLY (ruled 主签 2026-11-17＝只读重推): cancel_requested plus control_revision is already
// a durable idempotent fact and the run closed set has no delivered member, so re-push needs no
// new state and no write (GW11's list_pending_device_offers reasoning).
func (s *Server) listCancels(ctx context.Context, orgID, deviceID, sessionID string) ([]pendingCancel, error) {
	var raw []byte
	err := workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.list_pending_device_cancels($1, $2::uuid, $3::uuid)`,
			orgID, deviceID, sessionID,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	var res struct {
		Cancels []pendingCancel `json:"cancels"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("invalid_request: pending cancels")
	}
	return res.Cancels, nil
}

// pushPendingCancels signs and delivers the device's pending cancels, skipping any Run already
// pushed on THIS stream (ruled 每流去重; GW11/GW14 precedent). Without the cache each 10s
// heartbeat would re-deliver a stop instruction the device may already have acted on.
//
// Unlike the command claim, re-push here survives a reconnect by design: the getter targets the
// Run through its latest device_run_binding rather than through the calling session, so a device
// that crashed before acknowledging still learns of the cancel on its new session. That is safe
// because the ack is idempotent — a replay finds the Operations already settled and counts zero.
func (s *Server) pushPendingCancels(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, canceled map[string]bool) error {
	cancels, err := s.listCancels(ctx, orgID, deviceID, sessionID)
	if err != nil {
		return mapError(err)
	}
	for i := range cancels {
		cancel := &cancels[i]
		if cancel.RunID == "" || canceled[cancel.RunID] {
			continue
		}
		raw, err := signedDownlink(s.serverKey, "cancel", deviceID, sessionID, cancelWire(cancel))
		if err != nil {
			return status.Error(codes.Internal, "service_degraded")
		}
		if err := stream.SendMsg(raw); err != nil {
			return err
		}
		canceled[cancel.RunID] = true
	}
	return nil
}

// cancelAck is the closed five-key wire cancel_ack body. device/session come from the
// certificate-mapped transport identity and the hello-established session, never from the body.
type cancelAck struct {
	RunID            string `json:"run_id"`
	CancelRevision   string `json:"cancel_revision"`
	StoppedOrUnknown string `json:"stopped_or_unknown"`
	LastReceiptSeq   string `json:"last_receipt_seq"`
	Signature        string `json:"signature"`
}

// cancelAckArgs shape-checks the wire body and returns the two scalar counters. The closed
// stopped/unknown vocabulary and the revision match are SQL's judgment, not a second copy here:
// a wrong revision is the revision_conflict VERDICT, so only a non-numeric or negative value is
// refused at this layer (GW12's fence precedent).
func cancelAckArgs(bodyJSON []byte) (*cancelAck, int64, uint64, error) {
	var body cancelAck
	if err := json.Unmarshal(bodyJSON, &body); err != nil {
		return nil, 0, 0, fmt.Errorf("invalid_request: cancel_ack body")
	}
	if _, err := uuid.Parse(body.RunID); err != nil {
		return nil, 0, 0, fmt.Errorf("invalid_request: cancel_ack run_id")
	}
	if body.StoppedOrUnknown == "" || body.Signature == "" {
		return nil, 0, 0, fmt.Errorf("invalid_request: cancel_ack identity")
	}
	revision, err := strconv.ParseInt(body.CancelRevision, 10, 64)
	if err != nil || revision < 0 {
		return nil, 0, 0, fmt.Errorf("invalid_request: cancel_ack cancel_revision")
	}
	seq, err := strconv.ParseUint(body.LastReceiptSeq, 10, 64)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("invalid_request: cancel_ack last_receipt_seq")
	}
	return &body, revision, seq, nil
}

// handleCancelAck verifies the cancel_ack frame's ES256 signature over the wire body BEFORE
// translation and BEFORE the domain command, then forwards the stop fact to
// acknowledge_device_cancel as work_worker. The wire signature becomes p_device_signature, which
// SQL only shape-checks (0056); the cryptography is here (0040:1135 precedent).
//
// Nothing is sent back. The command's result is server-side evidence (the settled Operation
// counts and the reported watermark, written to the task event and audit); the device's own
// confirmation that it stopped is local, and the Run's terminal verdict still comes only from
// run_finish (ruled 只落停止事实，不当终态写者).
func (s *Server) handleCancelAck(ctx context.Context, orgID, deviceID, sessionID string, pub *devicesig.PublicKey, env *Envelope) error {
	var sig struct {
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(env.Body, &sig); err != nil || sig.Signature == "" {
		return mapError(fmt.Errorf("invalid_request: cancel_ack signature"))
	}
	if !devicesig.VerifyFrame(pub, "cancel_ack", env.Body, sig.Signature) {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	body, revision, seq, err := cancelAckArgs(env.Body)
	if err != nil {
		return mapError(err)
	}
	if _, err := s.acknowledgeCancel(ctx, orgID, deviceID, sessionID, body, revision, seq); err != nil {
		return mapError(err)
	}
	return nil
}

// acknowledgeCancel forwards one stop fact through acknowledge_device_cancel as work_worker.
// The command owns the device/session/binding gates, the revision match, the per-Operation
// settlement through cancel_operation and the evidence rows in one transaction. It never writes
// run.state and never advances the lease watermark — renew_device_lease owns that column (0051).
func (s *Server) acknowledgeCancel(ctx context.Context, orgID, deviceID, sessionID string, body *cancelAck, revision int64, seq uint64) (json.RawMessage, error) {
	var raw []byte
	err := workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.acknowledge_device_cancel($1, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8)`,
			orgID, body.RunID, revision, body.StoppedOrUnknown, int64(seq),
			deviceID, sessionID, body.Signature,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}