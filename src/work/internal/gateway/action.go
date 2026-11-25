package gateway

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/devicesig"
)

// GW13: the action_prepare uplink and the server-signed action_prepared downlink (device-design
// §3.1 action_prepare row, §3.4; control-design §4.2 prepare_local_operation). Unlike GW11/GW12
// the domain command needed NO ownership restatement: 0042's prepare_local_operation already
// takes p_device_id/p_session_id/p_lease_id/p_fence and binds device, session, execute lease,
// fence, binding and the latest recorded checkpoint before it writes anything. 0054 only
// reconciles the device_signature shape with the real ES256 form, as 0048/0050/0052/0053 did.
//
// The gateway translates and forwards; it never judges. The classification cross-check, the (A)
// destination gate, the supersede invariants, the readonly-grant branch versus a new Approval and
// the quota re-verification are all SQL's, from server facts (work_worker has no SELECT on
// local_action / workspace_grant / device_session, 0024).
//
// The permit and command faces are GW14 (command.go): 0055 restated consume_device_permit to
// mint the 28-key document after the dispatch CAS and added the heartbeat-driven claim, so an
// accepted prepare is now followed by a signed command whenever the action is dispatchable —
// immediately on the readonly auto-approved path, on a later heartbeat once the user decides
// an ask_each Approval through the M1b REST face.

// actionPrepare is the wire action_prepare body. The uint64 fields are decimal strings (§3.1).
// device/session come from the certificate-mapped transport identity and the hello-established
// session, never from the body.
//
// lease_id and fence are the two keys the §3.1 row did not list (ruled 主签 2026-11-17, annotated
// in place): prepare_local_operation requires p_lease_id with purpose='execute' (0042:855-861) and
// compares p_fence against BOTH run.fence and lease.fence before raising stale_fence
// (0042:862-864). Deriving them server-side would make that gate an identity, so the device names
// the lease it is acting under, exactly as run_finish and checkpoint_commit already do.
//
// supersede_no is NOT a wire key: SQL enforces logical_key = step_key || '#' || supersede_no
// (0042:774), so it is derived from the logical_key the device already sends.
type actionPrepare struct {
	PrepareID             string          `json:"prepare_id"`
	RunID                 string          `json:"run_id"`
	LeaseID               string          `json:"lease_id"`
	Fence                 string          `json:"fence"`
	StepKey               string          `json:"step_key"`
	LogicalKey            string          `json:"logical_key"`
	SupersedesOperationID *string         `json:"supersedes_operation_id"`
	SupersedeReason       *string         `json:"supersede_reason"`
	SupersedeAssertion    json.RawMessage `json:"supersede_assertion"`
	CheckpointSeq         string          `json:"checkpoint_seq"`
	CheckpointHash        string          `json:"checkpoint_hash"`
	RequestHash           string          `json:"request_hash"`
	ActionKind            string          `json:"action_kind"`
	ToolSchema            string          `json:"tool_schema"`
	LocalPayloadRef       string          `json:"local_payload_ref"`
	GrantID               string          `json:"grant_id"`
	GrantRevision         string          `json:"grant_revision"`
	ResourceSelectorHash  string          `json:"resource_selector_hash"`
	Classification        string          `json:"classification"`
	DestinationID         *string         `json:"destination_id"`
	ByteUpperBound        string          `json:"byte_upper_bound"`
	TokenUpperBound       string          `json:"token_upper_bound"`
	Signature             string          `json:"signature"`
}

// prepareElement translates the wire body into the closed twenty-key p_action object
// (local_action_prepare_valid, 0042:521-535) plus the scalar arguments. The cryptography was
// already verified over the original body, so the wire ES256 signature becomes device_signature,
// which SQL only shape-checks (0054). The three optional supersede keys are always emitted, null
// when absent: the validator counts keys, and SQL refuses a supersede whose reason or assertion
// is missing (0042:777-780) rather than treating an absent key as "not a supersede".
func prepareElement(bodyJSON []byte) (*actionPrepare, int64, int64, map[string]any, error) {
	var body actionPrepare
	if err := json.Unmarshal(bodyJSON, &body); err != nil {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: action body")
	}
	for _, id := range []struct{ name, value string }{
		{"prepare_id", body.PrepareID}, {"run_id", body.RunID},
		{"lease_id", body.LeaseID}, {"grant_id", body.GrantID},
	} {
		if _, err := uuid.Parse(id.value); err != nil {
			return nil, 0, 0, nil, fmt.Errorf("invalid_request: action %s", id.name)
		}
	}
	var supersedes any
	if body.SupersedesOperationID != nil {
		if _, err := uuid.Parse(*body.SupersedesOperationID); err != nil {
			return nil, 0, 0, nil, fmt.Errorf("invalid_request: action supersedes_operation_id")
		}
		supersedes = *body.SupersedesOperationID
	}
	for _, field := range []struct{ name, value string }{
		{"step_key", body.StepKey}, {"logical_key", body.LogicalKey},
		{"checkpoint_hash", body.CheckpointHash}, {"request_hash", body.RequestHash},
		{"action_kind", body.ActionKind}, {"tool_schema", body.ToolSchema},
		{"local_payload_ref", body.LocalPayloadRef},
		{"resource_selector_hash", body.ResourceSelectorHash},
		{"classification", body.Classification}, {"signature", body.Signature},
	} {
		if field.value == "" {
			return nil, 0, 0, nil, fmt.Errorf("invalid_request: action %s", field.name)
		}
	}
	// A wrong fence is the stale_fence VERDICT, not a shape error, so only a non-numeric or
	// negative value is refused here (GW12 precedent).
	fence, err := strconv.ParseInt(body.Fence, 10, 64)
	if err != nil || fence < 0 {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: action fence")
	}
	checkpointSeq, err := strconv.ParseInt(body.CheckpointSeq, 10, 64)
	if err != nil || checkpointSeq < 0 {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: action checkpoint_seq")
	}
	grantRevision, err := strconv.ParseInt(body.GrantRevision, 10, 64)
	if err != nil || grantRevision < 1 {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: action grant_revision")
	}
	byteBound, err := strconv.ParseInt(body.ByteUpperBound, 10, 64)
	if err != nil || byteBound < 0 {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: action byte_upper_bound")
	}
	tokenBound, err := strconv.ParseInt(body.TokenUpperBound, 10, 64)
	if err != nil || tokenBound < 0 {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: action token_upper_bound")
	}
	separator := strings.LastIndex(body.LogicalKey, "#")
	if separator < 0 {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: action logical_key")
	}
	supersedeNo, err := strconv.ParseInt(body.LogicalKey[separator+1:], 10, 64)
	if err != nil || supersedeNo < 0 {
		return nil, 0, 0, nil, fmt.Errorf("invalid_request: action logical_key")
	}
	var reason any
	if body.SupersedeReason != nil {
		reason = *body.SupersedeReason
	}
	var destination any
	if body.DestinationID != nil {
		destination = *body.DestinationID
	}
	assertion := body.SupersedeAssertion
	if len(assertion) == 0 {
		assertion = json.RawMessage("null")
	}
	element := map[string]any{
		"prepare_id":              body.PrepareID,
		"step_key":                body.StepKey,
		"supersede_no":            supersedeNo,
		"logical_key":             body.LogicalKey,
		"supersedes_operation_id": supersedes,
		"supersede_reason":        reason,
		"supersede_assertion":     assertion,
		"checkpoint_hash":         body.CheckpointHash,
		"request_hash":            body.RequestHash,
		"action_kind":             body.ActionKind,
		"tool_schema":             body.ToolSchema,
		"local_payload_ref":       body.LocalPayloadRef,
		"grant_id":                body.GrantID,
		"grant_revision":          grantRevision,
		"resource_selector_hash":  body.ResourceSelectorHash,
		"classification":          body.Classification,
		"destination_id":          destination,
		"byte_upper_bound":        byteBound,
		"token_upper_bound":       tokenBound,
		"device_signature":        body.Signature,
	}
	return &body, fence, checkpointSeq, element, nil
}

// actionPreparedEnvelope turns the prepare_local_operation result into a server-signed
// action_prepared frame.
//
// The wire body is the closed FOURTEEN-key set ruled 主签 2026-11-17: the command's thirteen
// response keys plus `signature`. §3.1's row lists only four (operation_id/approval_id?/state/
// revision), but `attempt_id` is a required argument of consume_device_permit, so the four-key
// row left the very next step uncallable — the same "required but no place" defect GW12 fixed on
// run_finish_ack. The remaining keys are the server facts the device cross-checks its own action
// against (classification, destination_id, checkpoint_seq, request_hash) and the identity of the
// Operation it must later receipt.
//
// Dropped: `replayed`, an internal idempotency fact (GW9/GW12 precedent) — the device dedups by
// logical_key, which SQL owns as the idempotency authority (O-9 = jia), not by prepare_id.
// supersede_no/revision/checkpoint_seq are bigint JSON numbers, re-rendered as decimal strings
// (§3.1 uint64 boundary). approval_id and destination_id are always emitted, null when not
// applicable, so a deserialize→re-render round trip reproduces the exact signed bytes.
func actionPreparedEnvelope(deviceID, sessionID string, result json.RawMessage, key *ecdsa.PrivateKey) ([]byte, error) {
	var res struct {
		OperationID    string      `json:"operation_id"`
		LogicalKey     string      `json:"logical_key"`
		StepKey        string      `json:"step_key"`
		SupersedeNo    json.Number `json:"supersede_no"`
		State          string      `json:"state"`
		Revision       json.Number `json:"revision"`
		ApprovalID     *string     `json:"approval_id"`
		AutoApproved   bool        `json:"auto_approved"`
		RequestHash    string      `json:"request_hash"`
		AttemptID      string      `json:"attempt_id"`
		CheckpointSeq  json.Number `json:"checkpoint_seq"`
		Classification string      `json:"classification"`
		DestinationID  *string     `json:"destination_id"`
	}
	if err := json.Unmarshal(result, &res); err != nil {
		return nil, fmt.Errorf("invalid_request: action result")
	}
	if res.OperationID == "" || res.AttemptID == "" || res.State == "" {
		return nil, fmt.Errorf("invalid_request: action result identity")
	}
	wire := map[string]any{
		"operation_id":   res.OperationID,
		"logical_key":    res.LogicalKey,
		"step_key":       res.StepKey,
		"supersede_no":   res.SupersedeNo.String(),
		"state":          res.State,
		"revision":       res.Revision.String(),
		"approval_id":    res.ApprovalID,
		"auto_approved":  res.AutoApproved,
		"request_hash":   res.RequestHash,
		"attempt_id":     res.AttemptID,
		"checkpoint_seq": res.CheckpointSeq.String(),
		"classification": res.Classification,
		"destination_id": res.DestinationID,
	}
	return signedDownlink(key, "action_prepared", deviceID, sessionID, wire)
}

// handleActionPrepare verifies the action_prepare frame's ES256 signature over the wire body
// BEFORE translation and BEFORE the domain command, then forwards it to prepare_local_operation
// as work_worker and answers with the server-signed result. A refusal is a gRPC status carrying
// the business code (§582), not an ack body: unlike run_finish there is no verdict set here, and
// the device must not treat a refused prepare as evidence that the action did not happen.
//
// After the ack the command claim runs unconditionally. The gateway does not decide whether
// this action is dispatchable — the claim is the authority, and it returns nothing while the
// Operation waits on an Approval. Running it here rather than only on the next heartbeat is
// what makes the readonly auto-approved path deliver in the same round trip.
func (s *Server) handleActionPrepare(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, pub *devicesig.PublicKey, env *Envelope, pushed map[string]bool) error {
	var sig struct {
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(env.Body, &sig); err != nil || sig.Signature == "" {
		return mapError(fmt.Errorf("invalid_request: action signature"))
	}
	if !devicesig.VerifyFrame(pub, "action_prepare", env.Body, sig.Signature) {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	proposal, fence, checkpointSeq, element, err := prepareElement(env.Body)
	if err != nil {
		return mapError(err)
	}
	result, err := s.prepareAction(ctx, orgID, deviceID, sessionID, proposal, fence, checkpointSeq, element)
	if err != nil {
		return mapError(err)
	}
	ackRaw, err := actionPreparedEnvelope(deviceID, sessionID, result, s.serverKey)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	if err := stream.SendMsg(ackRaw); err != nil {
		return err
	}
	return s.pushPendingCommands(ctx, stream, orgID, deviceID, sessionID, pushed)
}

// prepareAction forwards one translated action through prepare_local_operation as work_worker.
// The command owns the Operation, the local_action carrier, the Approval or readonly-grant
// consumption, the audit row and the task events in one transaction; it reserves no quota
// (O-14 = jia), so there is nothing for the gateway to commit alongside it.
func (s *Server) prepareAction(ctx context.Context, orgID, deviceID, sessionID string, proposal *actionPrepare, fence, checkpointSeq int64, element map[string]any) (json.RawMessage, error) {
	action, err := json.Marshal(element)
	if err != nil {
		return nil, fmt.Errorf("invalid_request: action element")
	}
	var raw []byte
	err = workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.prepare_local_operation($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::jsonb)`,
			orgID, proposal.RunID, deviceID, sessionID, proposal.LeaseID, fence, checkpointSeq, action,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	var outcome struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(raw, &outcome); err != nil {
		return nil, fmt.Errorf("invalid_request: prepare result")
	}
	if outcome.Error == "supersede_limit_exceeded" {
		return nil, fmt.Errorf("supersede_limit_exceeded")
	}
	return json.RawMessage(raw), nil
}
