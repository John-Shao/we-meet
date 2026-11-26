package gateway

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	workdb "github.com/we-meet/work/internal/db"
)

// GW14: the command downlink (device-design §3.1 command row, §3.3). The permit is no longer a
// caller input: 0055 restated consume_device_permit to MINT the 28-key document after the
// dispatch CAS and to store it on device_dispatch, and added claim_pending_device_commands as
// the heartbeat-driven entry point. The gateway's whole job here is to sign and deliver — it
// decides nothing about whether an action may run.
//
// TWO keys, TWO signing domains (主签 2026-11-17＝独立第二把键):
//   - the nested permit document is signed under "permit" with s.permitKey, whose public JWK
//     rides hello_ack as permit_public_jwk. §3.3 requires an independent permit signing key, so
//     a compromised frame-signing key cannot mint an execution authority and vice versa.
//   - the command frame itself is signed under "command" with s.serverKey (主签 2026-11-17＝
//     command 也服务端签名). §3.1's row lists no signature member, but an unattributable
//     execution instruction is exactly what GW8 ruled against for acks; the device verifies
//     both layers fail-closed.
//
// The stored permit carries SQL's INTERNAL sha256 placeholder (0042's column CHECK forces a
// signature member and plpgsql cannot make ES256). signAckBody strips that member from the
// preimage and overwrites it with the real signature, so the wire document keeps exactly 28
// keys and the device's deserialize→re-render round trip reproduces the signed bytes.

// pendingCommand is one row of claim_pending_device_commands (0055): the closed nine-key
// command body of §3.1, with the stored permit document still unsigned.
type pendingCommand struct {
	CommandID         string          `json:"command_id"`
	RunID             string          `json:"run_id"`
	OperationID       string          `json:"operation_id"`
	LogicalKey        string          `json:"logical_key"`
	DispatchAttemptID string          `json:"dispatch_attempt_id"`
	RequestHash       string          `json:"request_hash"`
	ToolSchema        string          `json:"tool_schema"`
	LocalPayloadRef   string          `json:"local_payload_ref"`
	Permit            json.RawMessage `json:"permit"`
}

// signedPermit replaces the stored placeholder with a real ES256 signature under the "permit"
// domain. The closed 28-key set is asserted rather than assumed: a document that lost a key
// would still sign, and the device would then refuse it for a reason the gateway invented.
func signedPermit(stored json.RawMessage, key *ecdsa.PrivateKey) (json.RawMessage, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(stored, &members); err != nil {
		return nil, fmt.Errorf("invalid_request: permit document")
	}
	if len(members) != 28 {
		return nil, fmt.Errorf("invalid_request: permit key count %d", len(members))
	}
	if _, present := members["signature"]; !present {
		return nil, fmt.Errorf("invalid_request: permit signature member")
	}
	return signAckBody(key, "permit", stored)
}

// commandWire builds the closed ten-key command body: §3.1's nine plus the server signature
// added by signedDownlink. local_payload_ref is passed through verbatim — §3.1's row rule is
// that it names parameters the device already prepared locally, so the cloud cannot inject
// unpreviewed ones, and the gateway has no business rewriting it.
func commandWire(c *pendingCommand, permit json.RawMessage) map[string]any {
	return map[string]any{
		"command_id":          c.CommandID,
		"run_id":              c.RunID,
		"operation_id":        c.OperationID,
		"logical_key":         c.LogicalKey,
		"dispatch_attempt_id": c.DispatchAttemptID,
		"request_hash":        c.RequestHash,
		"tool_schema":         c.ToolSchema,
		"local_payload_ref":   c.LocalPayloadRef,
		"permit":              permit,
	}
}

// claimCommands dispatches every authorized action of this device's active Runs and returns
// its live dispatches, through the 0055 getter as work_worker. Transient refusals are skipped
// inside the command's own subtransaction and stay authorized for the next heartbeat; 0079's
// destination refusal is instead a durable canceled/released result, so it cannot be retried.
// A domain refusal never becomes a transport failure that kills the device's session.
//
// The kid supplied is the permit public key's thumbprint — the repo's single P-256 key
// identifier (0040 work.device_key_thumbprint, Rust thumbprint::device_key_thumbprint), which
// names a KEY rather than a device role, so the device can recompute it from the hello_ack
// permit_public_jwk and refuse a permit naming any other key. SQL only shape-checks kid as
// non-empty; that binding is the device's.
func (s *Server) claimCommands(ctx context.Context, orgID, deviceID, sessionID string) ([]pendingCommand, error) {
	var raw []byte
	err := workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.claim_pending_device_commands($1, $2::uuid, $3::uuid, $4)`,
			orgID, deviceID, sessionID, s.permitKid,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	var res struct {
		Commands []pendingCommand `json:"commands"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("invalid_request: pending commands")
	}
	return res.Commands, nil
}

// pushPendingCommands signs and delivers the device's live commands. A command already pushed
// on THIS stream is skipped (GW11's offer precedent): the claim returns every live dispatch
// until its permit expires, so without the cache each 10s heartbeat would re-deliver an
// instruction the device may already be executing. Re-push across a reconnect still happens
// because the cache is per stream — and it is safe, because §3.3 makes a re-sent command whose
// jti is already consumed return the journal instead of executing again.
//
// Cross-session re-push is out of scope: hello supersedes the session and a new session cannot
// renew the old lease (GW10 boundary), so the dispatch rows of a dead session are not live for
// the new one anyway.
func (s *Server) pushPendingCommands(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, pushed map[string]bool) error {
	commands, err := s.claimCommands(ctx, orgID, deviceID, sessionID)
	if err != nil {
		return mapError(err)
	}
	for i := range commands {
		command := &commands[i]
		if command.CommandID == "" || pushed[command.CommandID] {
			continue
		}
		permit, err := signedPermit(command.Permit, s.permitKey)
		if err != nil {
			return status.Error(codes.Internal, "service_degraded")
		}
		raw, err := signedDownlink(s.serverKey, "command", deviceID, sessionID, commandWire(command, permit))
		if err != nil {
			return status.Error(codes.Internal, "service_degraded")
		}
		if err := stream.SendMsg(raw); err != nil {
			return err
		}
		pushed[command.CommandID] = true
	}
	return nil
}
