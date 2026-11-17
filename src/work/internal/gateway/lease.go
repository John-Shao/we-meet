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
)

// leaseTTLSeconds is the TTL the gateway asks for on every renewal. It is the same
// server-side constant hello_ack already told the device (0040:1667 lease_ttl_ms=30000;
// device-design §3.3 "租约默认 30s/心跳10s"). The heartbeat body carries no requested TTL
// (§3.1), so the server decides and the device subtracts its measured round-trip from the
// returned ttl_ms when it extends its local monotonic deadline.
const leaseTTLSeconds = 30

// heartbeatBody is the wire heartbeat body (device-design §3.1 heartbeat row:
// monotonic_ms、lease IDs、last_receipt_seq). It carries NO signature and NO identity: the
// row lists neither, the transport is mTLS and the session was established by hello
// (hello_ack is the unsigned-frame precedent). The device/session are the certificate-mapped
// transport identity, which 0051 binds to the lease's original device/session.
//
// monotonic_ms is the device's monotonic clock reading at send time. The server validates
// its shape and otherwise does not use it: §3.3 makes the LOCAL deadline monotonic so a
// wall-clock rollback can never extend a lease, and a client-reported clock is not a
// server deadline.
type heartbeatBody struct {
	MonotonicMS    string   `json:"monotonic_ms"`
	LeaseIDs       []string `json:"lease_ids"`
	LastReceiptSeq string   `json:"last_receipt_seq"`
}

// parseHeartbeat validates the closed body. last_receipt_seq is parsed as a signed 64-bit
// integer because it is bound to a SQL bigint parameter (a uint64 above 2^63 would overflow
// the cast); monotonic_ms never reaches SQL, so it keeps the full uint64 wire range.
func parseHeartbeat(bodyJSON []byte) (*heartbeatBody, int64, error) {
	var body heartbeatBody
	if err := json.Unmarshal(bodyJSON, &body); err != nil {
		return nil, 0, fmt.Errorf("invalid_request: heartbeat body")
	}
	if _, err := strconv.ParseUint(body.MonotonicMS, 10, 64); err != nil {
		return nil, 0, fmt.Errorf("invalid_request: heartbeat monotonic_ms")
	}
	seq, err := strconv.ParseInt(body.LastReceiptSeq, 10, 64)
	if err != nil || seq < 0 {
		return nil, 0, fmt.Errorf("invalid_request: heartbeat last_receipt_seq")
	}
	for _, id := range body.LeaseIDs {
		if _, err := uuid.Parse(id); err != nil {
			return nil, 0, fmt.Errorf("invalid_request: heartbeat lease_ids")
		}
	}
	return &body, seq, nil
}

// leaseEnvelope turns one renew_device_lease result into the closed five-field wire lease
// body (device-design §3.1 lease row: lease_id、run_id、fence、expires_at、ttl_ms). purpose
// and last_receipt_seq are internal facts the row does not carry, so they are dropped
// (checkpointAckEnvelope drops `replayed` the same way). fence and ttl_ms cross the wire as
// decimal strings (§3.1 uint64 boundary) while SQL returns them as JSON numbers.
//
// UNSIGNED by ruling (2026-11-16: 照 §3.1 字面，heartbeat/lease 两帧不签). The lease row
// lists no signature member and the frame rides the same mTLS transport plus
// hello-established session as hello_ack; the ownership judgment is 0051's, in the DB.
// The device's own judgment is fence match plus a successful renewal, not a signature.
func leaseEnvelope(deviceID, sessionID string, result json.RawMessage) ([]byte, error) {
	var res struct {
		LeaseID   string      `json:"lease_id"`
		RunID     string      `json:"run_id"`
		Fence     json.Number `json:"fence"`
		ExpiresAt string      `json:"expires_at"`
		TTLMS     json.Number `json:"ttl_ms"`
	}
	if err := json.Unmarshal(result, &res); err != nil {
		return nil, fmt.Errorf("invalid_request: lease result")
	}
	if res.LeaseID == "" || res.RunID == "" || res.ExpiresAt == "" {
		return nil, fmt.Errorf("invalid_request: lease result identity")
	}
	body, err := json.Marshal(map[string]any{
		"lease_id":   res.LeaseID,
		"run_id":     res.RunID,
		"fence":      res.Fence.String(),
		"expires_at": res.ExpiresAt,
		"ttl_ms":     res.TTLMS.String(),
	})
	if err != nil {
		return nil, err
	}
	env := Envelope{
		SchemaVersion:      2,
		Type:               "lease",
		MessageID:          newMessageID(),
		DeviceID:           deviceID,
		SessionID:          sessionID,
		RecoveryGeneration: "0",
		Body:               body,
	}
	return json.Marshal(env)
}

// handleHeartbeat consumes one heartbeat uplink and answers one lease downlink per renewed
// lease. There is no signature to verify (§3.1 heartbeat row lists none); the identity that
// matters is the certificate-mapped device and the hello-established session, which the
// restated renew_device_lease compares against the lease's ORIGINAL device/session (0051).
// Any refusal fails the whole frame, so the device never sees a partial extension.
//
// A heartbeat is also the offer poll (主签 2026-11-16 裁定＝搭在 heartbeat 上查): the repo has
// no worker→gateway signal and a binding is created only after the device already holds a
// session, so this is the one cadence the design already fixes (§3.3, 10s) at which the
// gateway can notice a new offer. GW14 rides the same cadence for the command claim, because
// an ask_each action becomes authorized only when the user decides it through the M1b REST
// face. GW15 rides it again for the cancel re-push: a cancel is requested through the REST or
// ops face, which equally has no worker→gateway signal. All three run AFTER the renewals, so a
// refused heartbeat pushes nothing.
func (s *Server) handleHeartbeat(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, env *Envelope, nonces map[offerNonceKey]string, pushed map[string]bool, cancels map[string]bool) error {
	body, seq, err := parseHeartbeat(env.Body)
	if err != nil {
		return mapError(err)
	}
	results, err := s.renewLeases(ctx, orgID, deviceID, sessionID, body.LeaseIDs, seq)
	if err != nil {
		return mapError(err)
	}
	for _, result := range results {
		raw, err := leaseEnvelope(deviceID, sessionID, result)
		if err != nil {
			return status.Error(codes.Internal, "service_degraded")
		}
		if err := stream.SendMsg(raw); err != nil {
			return err
		}
	}
	if err := s.pushPendingOffers(ctx, stream, orgID, deviceID, sessionID, nonces); err != nil {
		return err
	}
	if err := s.pushPendingCommands(ctx, stream, orgID, deviceID, sessionID, pushed); err != nil {
		return err
	}
	return s.pushPendingCancels(ctx, stream, orgID, deviceID, sessionID, cancels)
}

// renewLeases renews every lease the heartbeat names in ONE work_worker transaction, so the
// "任一失败即整帧拒" ruling (2026-11-16) is a real rollback rather than a partial extension:
// a refused lease (foreign device/session, expired lease, rewound watermark) rolls back the
// renewals that already succeeded inside the same frame. An empty list is a keep-alive with
// nothing to extend — it writes nothing and sends no downlink.
func (s *Server) renewLeases(ctx context.Context, orgID, deviceID, sessionID string, leaseIDs []string, lastReceiptSeq int64) ([]json.RawMessage, error) {
	results := make([]json.RawMessage, 0, len(leaseIDs))
	err := workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		for _, leaseID := range leaseIDs {
			var raw []byte
			if err := tx.QueryRow(ctx,
				`SELECT work.renew_device_lease($1, $2::uuid, $3, $4, $5::uuid, $6::uuid)`,
				orgID, leaseID, leaseTTLSeconds, lastReceiptSeq, deviceID, sessionID,
			).Scan(&raw); err != nil {
				return err
			}
			results = append(results, json.RawMessage(raw))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}
