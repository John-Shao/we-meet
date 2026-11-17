package gateway

import (
	"context"
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

// pendingResolution is one row of work.pending_device_resolutions (0049): the wire
// conclusion fields of an un-acked operation_resolution, without the internal signature
// placeholder. resolution_revision arrives as a SQL bigint (JSON number); attempt_id,
// code and usage_source are nullable.
type pendingResolution struct {
	ResolveID          string  `json:"resolve_id"`
	RunID              string  `json:"run_id"`
	OperationID        string  `json:"operation_id"`
	AttemptID          *string `json:"attempt_id"`
	State              string  `json:"state"`
	DeliveryState      string  `json:"delivery_state"`
	Code               *string `json:"code"`
	UsageSource        *string `json:"usage_source"`
	SettlementState    string  `json:"settlement_state"`
	ResolutionRevision uint64  `json:"resolution_revision"`
}

// resolutionWireBody translates a getter row into the device wire body (Rust
// frame/resolution.rs OperationResolutionBody). resolution_revision becomes a decimal
// string (u64string); a null attempt_id becomes the empty string (the wire field is a
// String, and no permit was issued); code/usage_source are omitted when null. The
// signature is added by the caller after signing — it is the server's ES256 over the
// wire frame, never the SQL placeholder.
func resolutionWireBody(row pendingResolution) map[string]any {
	attempt := ""
	if row.AttemptID != nil {
		attempt = *row.AttemptID
	}
	body := map[string]any{
		"resolve_id":          row.ResolveID,
		"run_id":              row.RunID,
		"operation_id":        row.OperationID,
		"attempt_id":          attempt,
		"state":               row.State,
		"delivery_state":      row.DeliveryState,
		"settlement_state":    row.SettlementState,
		"resolution_revision": strconv.FormatUint(row.ResolutionRevision, 10),
	}
	if row.Code != nil {
		body["code"] = *row.Code
	}
	if row.UsageSource != nil {
		body["usage_source"] = *row.UsageSource
	}
	return body
}

// resolutionEnvelope wraps a signed resolution body into an operation_resolution frame
// addressed to the device on the current transport session. The outer transport fields
// are unsigned (device-design §3.1); the device verifies {schema_version, type, body}.
func resolutionEnvelope(deviceID, sessionID string, bodyJSON []byte) ([]byte, error) {
	env := Envelope{
		SchemaVersion:      2,
		Type:               "operation_resolution",
		MessageID:          newMessageID(),
		DeviceID:           deviceID,
		SessionID:          sessionID,
		RecoveryGeneration: "0",
		Body:               bodyJSON,
	}
	return json.Marshal(env)
}

// claimPendingResolutions claims the device's un-acked resolution queue through the 0049
// definer command as work_worker (no table SELECT/UPDATE under the 0024 house rule). The
// claim atomically advances pending->delivered (push is delivered) and returns the rows to
// sign and send; consume_device_ack can then ack delivered->acked.
func (s *Server) claimPendingResolutions(ctx context.Context, orgID, deviceID, sessionID string) ([]pendingResolution, error) {
	var raw []byte
	err := workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.claim_pending_device_resolutions($1, $2::uuid, $3::uuid)`,
			orgID, deviceID, sessionID,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	var rows []pendingResolution
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// pushPendingResolutions signs and sends every un-acked resolution for the device. It
// runs on session establish and after a receipt/reconcile batch is recorded (a completed
// receipt may have issued a fresh conclusion). Re-push is idempotent: the device applies
// monotonically by resolution_revision and acks only to advance the delivery watermark
// (device-design §3.1; ack is never a Run-terminal precondition). Each frame is signed
// with the gateway server key whose public JWK rode hello_ack, so the device verifies it
// without trusting the SQL signature column.
func (s *Server) pushPendingResolutions(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string) error {
	rows, err := s.claimPendingResolutions(ctx, orgID, deviceID, sessionID)
	if err != nil {
		return mapError(err)
	}
	for _, row := range rows {
		body := resolutionWireBody(row)
		bodyJSON, err := json.Marshal(body)
		if err != nil {
			return status.Error(codes.Internal, "service_degraded")
		}
		sig, err := devicesig.SignFrame(s.serverKey, "operation_resolution", bodyJSON)
		if err != nil {
			return status.Error(codes.Internal, "service_degraded")
		}
		body["signature"] = sig
		signedJSON, err := json.Marshal(body)
		if err != nil {
			return status.Error(codes.Internal, "service_degraded")
		}
		raw, err := resolutionEnvelope(deviceID, sessionID, signedJSON)
		if err != nil {
			return status.Error(codes.Internal, "service_degraded")
		}
		if err := stream.SendMsg(raw); err != nil {
			return err
		}
	}
	return nil
}

// handleResolutionAck consumes the device's operation_resolution_ack uplink through
// consume_device_ack (0042) as work_worker. The ack body is the closed two-key
// {resolve_id, state} (device-design §3.1; Rust ResolutionAckBody); it is authenticated
// by mTLS and carries no device signature, matching the command's strict two-key element
// validator. The gateway rebuilds a clean element (so any extra wire key cannot widen
// it), wraps it in the one-element batch the command takes, and lets SQL validate the
// closed state set, the revision conflict and the active session. The ack only advances
// resolution_delivery/acked_at; it writes no business fact and needs no response frame.
func (s *Server) handleResolutionAck(ctx context.Context, orgID, deviceID, sessionID string, env *Envelope) error {
	var ack struct {
		ResolveID string `json:"resolve_id"`
		State     string `json:"state"`
	}
	if err := json.Unmarshal(env.Body, &ack); err != nil {
		return mapError(fmt.Errorf("invalid_request: operation_resolution_ack body"))
	}
	acksJSON, err := json.Marshal([]map[string]any{
		{"resolve_id": ack.ResolveID, "state": ack.State},
	})
	if err != nil {
		return mapError(fmt.Errorf("invalid_request: operation_resolution_ack"))
	}
	err = workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		var raw []byte
		return tx.QueryRow(ctx,
			`SELECT work.consume_device_ack($1, $2::uuid, $3::uuid, $4::jsonb)`,
			orgID, deviceID, sessionID, acksJSON,
		).Scan(&raw)
	})
	if err != nil {
		return mapError(err)
	}
	return nil
}
