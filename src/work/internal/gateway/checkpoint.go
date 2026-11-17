package gateway

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/devicesig"
)

// checkpointCommit is the wire checkpoint_commit body (device-design §3.1 checkpoint row,
// §3.4). It carries only hashes and an opaque local ref — never ciphertext — and no
// identity: the device/session come from the certificate-mapped transport identity and
// the hello-established session, which 0050 binds to the Run's current device_run_binding.
type checkpointCommit struct {
	RunID                   string `json:"run_id"`
	BindingRevision         string `json:"binding_revision"`
	Fence                   string `json:"fence"`
	CheckpointSeq           string `json:"checkpoint_seq"`
	CheckpointHash          string `json:"checkpoint_hash"`
	LocalCheckpointRef      string `json:"local_checkpoint_ref"`
	ReceiptThroughSeq       string `json:"receipt_through_seq"`
	PendingOperationSetHash string `json:"pending_operation_set_hash"`
	Signature               string `json:"signature"`
}

// checkpointElement translates the wire body into the closed element
// record_device_checkpoint consumes (0050). The uint64 fields stay decimal strings (SQL
// casts them with ->>::bigint); the wire ES256 signature becomes device_signature, which
// SQL only shape-checks and hashes into signed_payload_hash — the cryptography was
// verified here over the original body before translation (0048 precedent).
func checkpointElement(bodyJSON []byte) (*checkpointCommit, int64, int64, map[string]any, error) {
	var body checkpointCommit
	if err := json.Unmarshal(bodyJSON, &body); err != nil {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: checkpoint body")
	}
	if body.RunID == "" || body.CheckpointHash == "" || body.LocalCheckpointRef == "" ||
		body.PendingOperationSetHash == "" || body.Signature == "" {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: checkpoint identity")
	}
	revision, err := strconv.ParseInt(body.BindingRevision, 10, 64)
	if err != nil || revision < 1 {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: checkpoint binding_revision")
	}
	fence, err := strconv.ParseInt(body.Fence, 10, 64)
	if err != nil || fence < 0 {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: checkpoint fence")
	}
	if _, err := strconv.ParseUint(body.CheckpointSeq, 10, 64); err != nil {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: checkpoint checkpoint_seq")
	}
	if body.ReceiptThroughSeq != "" {
		if _, err := strconv.ParseUint(body.ReceiptThroughSeq, 10, 64); err != nil {
			return nil, 0, 0, nil, fmt.Errorf("invalid_request: checkpoint receipt_through_seq")
		}
	}
	element := map[string]any{
		"checkpoint_seq":             body.CheckpointSeq,
		"checkpoint_hash":            body.CheckpointHash,
		"local_checkpoint_ref":       body.LocalCheckpointRef,
		"receipt_through_seq":        body.ReceiptThroughSeq,
		"pending_operation_set_hash": body.PendingOperationSetHash,
		"device_signature":           body.Signature,
	}
	return &body, revision, fence, element, nil
}

// checkpointAckEnvelope turns the record_device_checkpoint result into a server-signed
// checkpoint_ack on the current transport session. The wire body is the closed four-field
// set the device deserializes (Rust frame/checkpoint.rs CheckpointAckBody): run_id,
// checkpoint_seq, state, receipt_through_seq — the two seqs as decimal strings, because
// SQL returns bigint JSON numbers. `replayed` is an internal idempotency fact and is not
// part of the wire body. The recorded ack's receipt_through_seq is the watermark the
// device may release up to (B03 carrier §3.2); a conflict ack carries 0 and releases
// nothing. The signature is over the checkpoint_ack frame type, so a receipt_ack
// signature never verifies here (GW8 domain separation).
func checkpointAckEnvelope(deviceID, sessionID string, result json.RawMessage, key *ecdsa.PrivateKey) ([]byte, error) {
	var res struct {
		RunID             string      `json:"run_id"`
		CheckpointSeq     json.Number `json:"checkpoint_seq"`
		State             string      `json:"state"`
		ReceiptThroughSeq json.Number `json:"receipt_through_seq"`
	}
	if err := json.Unmarshal(result, &res); err != nil {
		return nil, fmt.Errorf("invalid_request: checkpoint result")
	}
	if res.State != "recorded" && res.State != "conflict" {
		return nil, fmt.Errorf("invalid_request: checkpoint state")
	}
	wire, err := json.Marshal(map[string]any{
		"run_id":              res.RunID,
		"checkpoint_seq":      res.CheckpointSeq.String(),
		"state":               res.State,
		"receipt_through_seq": res.ReceiptThroughSeq.String(),
	})
	if err != nil {
		return nil, err
	}
	body, err := signAckBody(key, "checkpoint_ack", wire)
	if err != nil {
		return nil, err
	}
	env := Envelope{
		SchemaVersion:      2,
		Type:               "checkpoint_ack",
		MessageID:          newMessageID(),
		DeviceID:           deviceID,
		SessionID:          sessionID,
		RecoveryGeneration: "0",
		Body:               body,
	}
	return json.Marshal(env)
}

// handleCheckpointCommit verifies the checkpoint_commit frame's ES256 signature over the
// wire body, translates it into the closed SQL element, records it through the landed
// domain command as work_worker, and returns the server-signed checkpoint_ack. The
// signature is checked BEFORE translation and BEFORE the command; SQL only shape-checks
// and hashes it (0050), the cryptography is here (0040:1135). The command binds the
// commit to this device/session and the Run's current binding, so a foreign or superseded
// binding is refused there rather than by a second gateway judgment.
func (s *Server) handleCheckpointCommit(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, pub *devicesig.PublicKey, env *Envelope) error {
	var sig struct {
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(env.Body, &sig); err != nil || sig.Signature == "" {
		return mapError(fmt.Errorf("invalid_request: checkpoint signature"))
	}
	if !devicesig.VerifyFrame(pub, "checkpoint_commit", env.Body, sig.Signature) {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	commit, revision, fence, element, err := checkpointElement(env.Body)
	if err != nil {
		return mapError(err)
	}
	// The envelope message_id is the idempotency key: a replay re-sends the same signed
	// frame, so the same request_id returns the stored response (and its watermark).
	result, err := s.recordCheckpoint(ctx, orgID, deviceID, sessionID, commit.RunID,
		revision, fence, env.MessageID, element)
	if err != nil {
		return mapError(err)
	}
	ackRaw, err := checkpointAckEnvelope(deviceID, sessionID, result, s.serverKey)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	return stream.SendMsg(ackRaw)
}

// recordCheckpoint records one translated checkpoint through record_device_checkpoint
// as work_worker (0050). The returned run_id/checkpoint_seq/state/receipt_through_seq
// become the checkpoint_ack body; receipt_through_seq is the durable receipt watermark
// the device may release up to (B03 carrier §3.2).
func (s *Server) recordCheckpoint(ctx context.Context, orgID, deviceID, sessionID, runID string, revision, fence int64, requestID string, element map[string]any) (json.RawMessage, error) {
	checkpoint, err := json.Marshal(element)
	if err != nil {
		return nil, fmt.Errorf("invalid_request: checkpoint element")
	}
	var raw []byte
	err = workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.record_device_checkpoint($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::uuid, $8::uuid)`,
			orgID, runID, revision, fence, requestID, checkpoint, deviceID, sessionID,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}
