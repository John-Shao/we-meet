package gateway

import (
	"context"
	"crypto/ecdsa"
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

// GW12: the run_finish uplink and the server-signed run_finish_ack downlink (device-design
// §3.1 run_finish row, §3.4 steps 3-4; control-design §6.4). The device proposes, the control
// plane adjudicates: 0042's finish_local_run already implements all six steps and
// finish_local_run_state is the local Run's only terminal writer, so the gateway translates and
// forwards — it never decides the outcome itself. 0053 binds the command to the calling device
// and session, so a foreign or superseded identity is refused in the database rather than by a
// second gateway judgment (work_worker has no SELECT on those tables, 0024).

// runFinish is the wire run_finish body. The uint64 fields are decimal strings (§3.1) and the
// body carries no identity: device/session come from the certificate-mapped transport identity
// and the hello-established session. reason_code is optional on the wire but the SQL element
// always carries the key (null for a completed Run), because local_run_finish_valid demands
// exactly eight keys (0042:582-593).
type runFinish struct {
	FinishID              string          `json:"finish_id"`
	RunID                 string          `json:"run_id"`
	BindingRevision       string          `json:"binding_revision"`
	Fence                 string          `json:"fence"`
	LeaseID               string          `json:"lease_id"`
	Outcome               string          `json:"outcome"`
	ReasonCode            string          `json:"reason_code"`
	FinalCheckpointSeq    string          `json:"final_checkpoint_seq"`
	FinalCheckpointHash   string          `json:"final_checkpoint_hash"`
	ReceiptThroughSeq     string          `json:"receipt_through_seq"`
	FinalOperationSetHash string          `json:"final_operation_set_hash"`
	DeliverableVersions   json.RawMessage `json:"deliverable_versions"`
	Signature             string          `json:"signature"`
}

// finishElement translates the wire body into the closed eight-key p_finish object plus the
// scalar arguments. The cryptography was already verified over the original body, so the wire
// ES256 signature becomes device_signature, which SQL only shape-checks and hashes into
// signed_payload_hash (0048/0050/0052 precedent). The closed sets (outcome, reason_code) and
// every verdict are SQL's judgment, not a second copy here.
func finishElement(bodyJSON []byte) (*runFinish, int64, int64, map[string]any, error) {
	var body runFinish
	if err := json.Unmarshal(bodyJSON, &body); err != nil {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: finish body")
	}
	for _, id := range []struct{ name, value string }{
		{"finish_id", body.FinishID}, {"run_id", body.RunID}, {"lease_id", body.LeaseID},
	} {
		if _, err := uuid.Parse(id.value); err != nil {
			return nil, 0, 0, nil, fmt.Errorf("invalid_request: finish %s", id.name)
		}
	}
	if body.FinalCheckpointHash == "" || body.FinalOperationSetHash == "" ||
		body.Outcome == "" || body.Signature == "" {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: finish identity")
	}
	revision, err := strconv.ParseInt(body.BindingRevision, 10, 64)
	if err != nil || revision < 1 {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: finish binding_revision")
	}
	// A wrong fence is the stale_fence VERDICT (§6.4 step 1), not a shape error, so only a
	// non-numeric or negative value is refused here.
	fence, err := strconv.ParseInt(body.Fence, 10, 64)
	if err != nil || fence < 0 {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: finish fence")
	}
	for _, seq := range []struct{ name, value string }{
		{"final_checkpoint_seq", body.FinalCheckpointSeq},
		{"receipt_through_seq", body.ReceiptThroughSeq},
	} {
		if _, err := strconv.ParseUint(seq.value, 10, 64); err != nil {
			return nil, 0, 0, nil, fmt.Errorf("invalid_request: finish %s", seq.name)
		}
	}
	var versions []string
	// A nil slice means the key was absent or explicitly null. Both are invalid_request here:
	// SQL's eight-key validator only checks key PRESENCE, so a null would reach the table's
	// deliverable_versions_valid CHECK and die on 23514 instead of being refused as a shape.
	if err := json.Unmarshal(body.DeliverableVersions, &versions); err != nil || versions == nil {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: finish deliverable_versions")
	}
	reason := any(nil)
	if body.ReasonCode != "" {
		reason = body.ReasonCode
	}
	element := map[string]any{
		"outcome":                  body.Outcome,
		"reason_code":              reason,
		"final_checkpoint_seq":     body.FinalCheckpointSeq,
		"final_checkpoint_hash":    body.FinalCheckpointHash,
		"receipt_through_seq":      body.ReceiptThroughSeq,
		"final_operation_set_hash": body.FinalOperationSetHash,
		"deliverable_versions":     versions,
		"device_signature":         body.Signature,
	}
	return &body, revision, fence, element, nil
}

// finishAckEnvelope turns the finish_local_run result into a server-signed run_finish_ack.
//
// The wire body is the closed SEVEN-key set ruled 主签 2026-11-16: §3.1's row lists five
// (finish_id/state/code?/terminal_run_revision?/server_signature), but §3.4 step 4 and §6.4
// step 3 both require the ack to carry expected_operation_set_hash and unresolved_operations[]
// — without them a device told finish_state_mismatch cannot know what to repair and would be
// left blind-retrying, which §3.4 forbids. The two optional keys are always emitted (null when
// not applicable) so the device can assert on a closed set.
//
// Dropped from the SQL result: `server_signature`, which is the INTERNAL sha256 placeholder the
// column's CHECK forces (0042:479-480) and which plpgsql cannot make a real ES256 signature
// (0040:1135, 0049 precedent) — the gateway signs the wire frame instead, over the
// run_finish_ack frame type, so a run_offer or checkpoint_ack signature never verifies here;
// and `replayed`, an internal idempotency fact (GW9 precedent). terminal_run_revision is a
// bigint JSON number, re-rendered as a decimal string (§3.1 uint64 boundary).
func finishAckEnvelope(deviceID, sessionID string, result json.RawMessage, key *ecdsa.PrivateKey) ([]byte, error) {
	var res struct {
		FinishID                 string          `json:"finish_id"`
		State                    string          `json:"state"`
		Code                     *string         `json:"code"`
		TerminalRunRevision      *json.Number    `json:"terminal_run_revision"`
		ExpectedOperationSetHash string          `json:"expected_operation_set_hash"`
		UnresolvedOperations     json.RawMessage `json:"unresolved_operations"`
	}
	if err := json.Unmarshal(result, &res); err != nil {
		return nil, fmt.Errorf("invalid_request: finish result")
	}
	if res.State != "accepted" && res.State != "rejected" {
		return nil, fmt.Errorf("invalid_request: finish state")
	}
	var revision any
	if res.TerminalRunRevision != nil {
		revision = res.TerminalRunRevision.String()
	}
	unresolved := res.UnresolvedOperations
	if len(unresolved) == 0 {
		unresolved = json.RawMessage("[]")
	}
	wire, err := json.Marshal(map[string]any{
		"finish_id":                   res.FinishID,
		"state":                       res.State,
		"code":                        res.Code,
		"terminal_run_revision":       revision,
		"expected_operation_set_hash": res.ExpectedOperationSetHash,
		"unresolved_operations":       unresolved,
	})
	if err != nil {
		return nil, err
	}
	body, err := signAckBody(key, "run_finish_ack", wire)
	if err != nil {
		return nil, err
	}
	env := Envelope{
		SchemaVersion:      2,
		Type:               "run_finish_ack",
		MessageID:          newMessageID(),
		DeviceID:           deviceID,
		SessionID:          sessionID,
		RecoveryGeneration: "0",
		Body:               body,
	}
	return json.Marshal(env)
}

// handleRunFinish verifies the run_finish frame's ES256 signature over the wire body BEFORE
// translation and BEFORE the domain command, forwards the proposal to finish_local_run as
// work_worker, and answers with the server-signed verdict. A REJECTED proposal is not a
// transport error: the four verdict codes travel in the ack body (device-design §3.1 keeps them
// in run_finish_ack.code's closed set, separate from operation_resolution's), because the device
// has to act on them — repair the missing receipts, wait for a resolution, or stop proposing.
//
// The idempotency key is the device's finish_id, NOT the envelope message_id: §3.4 step 3 and
// §6.3 require a lost ack to be repaired by re-sending the SAME finish_id and the same signed
// bytes, never by re-judging the outcome under a new one.
//
// After the verdict the cancel re-push runs (GW15). §3.4 step 4 routes a rejected
// run_cancel_requested into the cancel_ack flow, and cancel_ack needs the cancel_revision the
// device only learns from the cancel downlink — pushing here rather than waiting for the next
// heartbeat is what makes that route callable in the same round trip (GW14's command-after-
// action_prepared precedent). The per-stream cache means an already-delivered cancel is not
// repeated.
func (s *Server) handleRunFinish(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, pub *devicesig.PublicKey, env *Envelope, cancels map[string]bool) error {
	var sig struct {
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(env.Body, &sig); err != nil || sig.Signature == "" {
		return mapError(fmt.Errorf("invalid_request: finish signature"))
	}
	if !devicesig.VerifyFrame(pub, "run_finish", env.Body, sig.Signature) {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	proposal, revision, fence, element, err := finishElement(env.Body)
	if err != nil {
		return mapError(err)
	}
	result, err := s.finishRun(ctx, orgID, deviceID, sessionID, proposal, revision, fence, element)
	if err != nil {
		return mapError(err)
	}
	ackRaw, err := finishAckEnvelope(deviceID, sessionID, result, s.serverKey)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	if err := stream.SendMsg(ackRaw); err != nil {
		return err
	}
	return s.pushPendingCancels(ctx, stream, orgID, deviceID, sessionID, cancels)
}

// finishRun forwards one translated proposal through finish_local_run as work_worker (0053).
// The command owns the whole adjudication and the terminal write set in one transaction, so
// there is nothing for the gateway to commit alongside it.
func (s *Server) finishRun(ctx context.Context, orgID, deviceID, sessionID string, proposal *runFinish, revision, fence int64, element map[string]any) (json.RawMessage, error) {
	finish, err := json.Marshal(element)
	if err != nil {
		return nil, fmt.Errorf("invalid_request: finish element")
	}
	var raw []byte
	err = workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.finish_local_run($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb, $8::uuid, $9::uuid)`,
			orgID, proposal.RunID, proposal.FinishID, proposal.LeaseID, revision, fence,
			finish, deviceID, sessionID,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}
