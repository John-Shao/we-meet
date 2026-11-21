package gateway

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/devicesig"
)

// Batch 4: the local_publish uplink and the server-signed publish_ack downlink (device-design
// §3.1 local_publish row, §7.1 step 4; execution-face batch 4). The Broker names a sealed
// deliverable version it wrote and the control plane finalizes it into a published local_only
// artifact_version via work.finalize_local_artifact (0043, work_worker). This is what makes a
// `completed` run_finish reachable: 0059's deliverable_versions precondition needs pre-existing
// published rows, and before this batch finalize had no production caller (the batch-3 residual).
//
// Ownership is bound by finalize itself, not a second gateway judgment: the gateway sets the
// version's device_id to the certificate-mapped caller, and finalize cross-checks it against the
// completed receipt's device_id (0043:428) and binds the operation to the Run (0043:410). A
// foreign device cannot publish another's operation — its receipt's device_id would not match —
// so no separate device_run_binding getter (and no new migration) is needed (0024: work_worker
// has no SELECT on those tables).

// localPublish is the wire local_publish body: the closed TEN-key version payload
// (local_artifact_version_payload_valid, 0043:198) plus run_id/operation_id locating the
// Run/operation. byte_count is a decimal string (§3.1 uint64 boundary); artifact_id is null this
// period (merge by logical_name, lead ruling 甲 2026-11-21); content_hash is bare 64-hex.
type localPublish struct {
	RunID                 string  `json:"run_id"`
	OperationID           string  `json:"operation_id"`
	VersionID             string  `json:"version_id"`
	ArtifactID            *string `json:"artifact_id"`
	LogicalName           string  `json:"logical_name"`
	Format                string  `json:"format"`
	ContentHash           string  `json:"content_hash"`
	ByteCount             string  `json:"byte_count"`
	LocalRef              string  `json:"local_ref"`
	DeviceID              string  `json:"device_id"`
	ClassificationClaimed string  `json:"classification_claimed"`
	ReceiptRef            string  `json:"receipt_ref"`
	Signature             string  `json:"signature"`
}

var (
	bareHex64    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	receiptRefRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]*$`)
)

// publishElement validates the wire shape and builds the closed ten-key p_version object. The
// cryptography was already verified over the original body; the gateway pins device_id to the
// certificate-mapped caller (the device's claim must equal it) so finalize's receipt cross-check
// binds the publication to the caller's own receipted operation. The full payload shape is
// re-checked here so a bad value is refused as invalid_request rather than dying on a SQL CHECK
// (the finishElement precedent).
func publishElement(bodyJSON []byte, callerDeviceID string) (*localPublish, map[string]any, error) {
	var body localPublish
	if err := json.Unmarshal(bodyJSON, &body); err != nil {
		return nil, nil, fmt.Errorf("invalid_request: publish body")
	}
	for _, id := range []struct{ name, value string }{
		{"run_id", body.RunID}, {"operation_id", body.OperationID}, {"version_id", body.VersionID},
	} {
		if _, err := uuid.Parse(id.value); err != nil {
			return nil, nil, fmt.Errorf("invalid_request: publish %s", id.name)
		}
	}
	if body.DeviceID != callerDeviceID {
		return nil, nil, fmt.Errorf("invalid_request: publish device_id")
	}
	if body.ArtifactID != nil {
		if _, err := uuid.Parse(*body.ArtifactID); err != nil {
			return nil, nil, fmt.Errorf("invalid_request: publish artifact_id")
		}
	}
	if body.LogicalName == "" || body.Format == "" || body.LocalRef == "" ||
		body.ClassificationClaimed == "" || body.Signature == "" {
		return nil, nil, fmt.Errorf("invalid_request: publish identity")
	}
	if !bareHex64.MatchString(body.ContentHash) {
		return nil, nil, fmt.Errorf("invalid_request: publish content_hash")
	}
	if !receiptRefRe.MatchString(body.ReceiptRef) {
		return nil, nil, fmt.Errorf("invalid_request: publish receipt_ref")
	}
	if _, err := strconv.ParseUint(body.ByteCount, 10, 64); err != nil {
		return nil, nil, fmt.Errorf("invalid_request: publish byte_count")
	}
	if body.ClassificationClaimed != "local_only" && body.ClassificationClaimed != "remote_excerpt_allowed" {
		return nil, nil, fmt.Errorf("invalid_request: publish classification_claimed")
	}
	artifactID := any(nil)
	if body.ArtifactID != nil {
		artifactID = *body.ArtifactID
	}
	version := map[string]any{
		"version_id":             body.VersionID,
		"artifact_id":            artifactID,
		"logical_name":           body.LogicalName,
		"format":                 body.Format,
		"content_hash":           body.ContentHash,
		"byte_count":             body.ByteCount,
		"local_ref":              body.LocalRef,
		"device_id":              callerDeviceID,
		"classification_claimed": body.ClassificationClaimed,
		"receipt_ref":            body.ReceiptRef,
	}
	return &body, version, nil
}

// publishAckEnvelope turns the finalize_local_artifact result into a server-signed publish_ack.
// The wire body is the closed set the device's PublishAckBody asserts: run_id/operation_id (echoed
// from the request, the SQL result does not carry them), version_id/artifact_id/version_no/
// location/classification/publish_ack. version_no is a bigint JSON number re-rendered as a decimal
// string (§3.1 uint64 boundary). Dropped from the SQL result: classification_derivation/hash/bytes/
// format/local_ref (derivation evidence the device does not act on) and replayed (an internal
// idempotency fact, GW9 precedent). The gateway signs over the publish_ack frame type so a
// run_finish_ack or receipt_ack signature never verifies here (GW8 type-bound precedent).
func publishAckEnvelope(deviceID, sessionID, runID, operationID string, result json.RawMessage, key *ecdsa.PrivateKey) ([]byte, error) {
	var res struct {
		VersionID      string       `json:"version_id"`
		ArtifactID     string       `json:"artifact_id"`
		VersionNo      json.Number  `json:"version_no"`
		Location       string       `json:"location"`
		Classification string       `json:"classification"`
		PublishAck     string       `json:"publish_ack"`
	}
	if err := json.Unmarshal(result, &res); err != nil {
		return nil, fmt.Errorf("invalid_request: publish result")
	}
	if res.VersionID == "" || res.Location == "" {
		return nil, fmt.Errorf("invalid_request: publish result identity")
	}
	wire, err := json.Marshal(map[string]any{
		"run_id":         runID,
		"operation_id":   operationID,
		"version_id":     res.VersionID,
		"artifact_id":    res.ArtifactID,
		"version_no":     res.VersionNo.String(),
		"location":       res.Location,
		"classification": res.Classification,
		"publish_ack":    res.PublishAck,
	})
	if err != nil {
		return nil, err
	}
	body, err := signAckBody(key, "publish_ack", wire)
	if err != nil {
		return nil, err
	}
	env := Envelope{
		SchemaVersion:      2,
		Type:               "publish_ack",
		MessageID:          newMessageID(),
		DeviceID:           deviceID,
		SessionID:          sessionID,
		RecoveryGeneration: "0",
		Body:               body,
	}
	return json.Marshal(env)
}

// handleLocalPublish verifies the local_publish frame's ES256 signature over the wire body BEFORE
// translation and BEFORE the domain command, forwards the version to finalize_local_artifact as
// work_worker, and answers with the server-signed publication confirmation. A refusal (bad shape,
// classification floor, unreconciled operation, foreign receipt) is a gRPC status the device acts
// on; finalize is idempotent by version_id (same artifact+hash+run replays, 0043:543), so a
// restart re-publish replays rather than conflicts.
func (s *Server) handleLocalPublish(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, pub *devicesig.PublicKey, env *Envelope) error {
	var sig struct {
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(env.Body, &sig); err != nil || sig.Signature == "" {
		return mapError(fmt.Errorf("invalid_request: publish signature"))
	}
	if !devicesig.VerifyFrame(pub, "local_publish", env.Body, sig.Signature) {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	proposal, version, err := publishElement(env.Body, deviceID)
	if err != nil {
		return mapError(err)
	}
	result, err := s.finalizeArtifact(ctx, orgID, proposal, version)
	if err != nil {
		return mapError(err)
	}
	ackRaw, err := publishAckEnvelope(deviceID, sessionID, proposal.RunID, proposal.OperationID, result, s.serverKey)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	return stream.SendMsg(ackRaw)
}

// finalizeArtifact forwards one translated version through finalize_local_artifact as work_worker
// (0043). The command owns the classification derivation, the artifact/version/replica writes and
// the audit in one transaction, so there is nothing for the gateway to commit alongside it.
func (s *Server) finalizeArtifact(ctx context.Context, orgID string, proposal *localPublish, version map[string]any) (json.RawMessage, error) {
	payload, err := json.Marshal(version)
	if err != nil {
		return nil, fmt.Errorf("invalid_request: publish version")
	}
	var raw []byte
	err = workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.finalize_local_artifact($1, $2::uuid, $3::uuid, $4::jsonb)`,
			orgID, proposal.RunID, proposal.OperationID, payload,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}