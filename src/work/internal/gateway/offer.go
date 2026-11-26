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

// offerNonceKey identifies one offered binding. The gateway holds its start_nonce for the
// lifetime of the stream so a re-sent run_ready can still produce a run_start.
type offerNonceKey struct {
	runID    string
	revision int64
}

// pendingOffer is one row of list_pending_device_offers (0052). start_nonce is an INTERNAL
// field of the getter's result, never a §3.1 run_offer wire field: it first reaches the
// device inside run_start. Numbers stay json.Number so the wire keeps decimal strings
// (§3.1 uint64 boundary) instead of a float round trip.
type pendingOffer struct {
	RunID                  string          `json:"run_id"`
	BindingRevision        json.Number     `json:"binding_revision"`
	BindingHash            string          `json:"binding_hash"`
	TaskID                 string          `json:"task_id"`
	DeviceID               string          `json:"device_id"`
	SessionID              string          `json:"session_id"`
	InputRef               string          `json:"input_ref"`
	InputHash              string          `json:"input_hash"`
	SnapshotDescriptorRef  *string         `json:"snapshot_descriptor_ref"`
	SnapshotHash           string          `json:"snapshot_hash"`
	ProfileID              string          `json:"profile_id"`
	ProfileRevision        json.Number     `json:"profile_revision"`
	RuntimeDigest          string          `json:"runtime_digest"`
	ToolManifestHash       string          `json:"tool_manifest_hash"`
	ModelVersion           string          `json:"model_version"`
	GrantSet               json.RawMessage `json:"grant_set"`
	ExpectedCheckpointSeq  *json.Number    `json:"expected_checkpoint_seq"`
	ExpectedCheckpointHash *string         `json:"expected_checkpoint_hash"`
	StartNonce             string          `json:"start_nonce"`
	OfferExpiry            string          `json:"offer_expiry"`
}

// runReadyBody is the wire run_ready body (device-design §3.1 run_ready row: binding
// identity/hash, ready_or_reason, device_signature). It carries no identity: the
// device/session come from the certificate-mapped transport and the hello session, which
// 0052 binds to the binding's original device/session.
type runReadyBody struct {
	RunID           string `json:"run_id"`
	BindingRevision string `json:"binding_revision"`
	BindingHash     string `json:"binding_hash"`
	ReadyOrReason   string `json:"ready_or_reason"`
	Signature       string `json:"signature"`
}

// runStartedBody is the wire run_started body (device-design §3.1 run_started row:
// start_nonce, state, checkpoint_ref/hash).
type runStartedBody struct {
	StartNonce     string `json:"start_nonce"`
	State          string `json:"state"`
	CheckpointRef  string `json:"checkpoint_ref"`
	CheckpointHash string `json:"checkpoint_hash"`
	Signature      string `json:"signature"`
}

// signedDownlink signs one wire body under frameType with the gateway server key and wraps
// it in a v2 envelope addressed to the device on the current transport session. The device
// verifies it against the hello_ack server_public_jwk (GW7/GW8 chain).
func signedDownlink(key *ecdsa.PrivateKey, frameType, deviceID, sessionID string, wire map[string]any) ([]byte, error) {
	bodyJSON, err := json.Marshal(wire)
	if err != nil {
		return nil, err
	}
	body, err := signAckBody(key, frameType, bodyJSON)
	if err != nil {
		return nil, err
	}
	env := Envelope{
		SchemaVersion:      2,
		Type:               frameType,
		MessageID:          newMessageID(),
		DeviceID:           deviceID,
		SessionID:          sessionID,
		RecoveryGeneration: "0",
		Body:               body,
	}
	return json.Marshal(env)
}

// runOfferWire builds the closed run_offer body from one getter row (device-design §3.1
// run_offer row). start_nonce is deliberately absent — §3.1 puts it only in run_start, and
// leaking it earlier would let a device pre-register the single-use nonce before the offer
// is even accepted. server_signature is added by signedDownlink.
//
// runtime_digest and tool_manifest_hash are carried although the §3.1 row names only
// "profile/model版本": §3.2 requires the Broker to start "指定digest的单一sidecar" and to
// check the tool manifest before answering ready, so the device cannot decide
// ready/missing_input without them.
//
// grant_set is re-rendered into the §3.1 boundary form rather than passed through verbatim:
// grant_revision is a bigint revision, so it crosses as a decimal string like every other
// uint64 counter, whichever way the row was stored (the rebind path and older seeds store a
// JSON number). The signature therefore always covers the string form.
func runOfferWire(o *pendingOffer) (map[string]any, error) {
	grants, err := grantSetWire(o.GrantSet)
	if err != nil {
		return nil, err
	}
	wire := map[string]any{
		"run_id":                   o.RunID,
		"binding_revision":         o.BindingRevision.String(),
		"binding_hash":             o.BindingHash,
		"task_id":                  o.TaskID,
		"input_ref":                o.InputRef,
		"input_hash":               o.InputHash,
		"snapshot_descriptor_ref":  o.SnapshotDescriptorRef,
		"snapshot_hash":            o.SnapshotHash,
		"profile_id":               o.ProfileID,
		"profile_revision":         o.ProfileRevision.String(),
		"runtime_digest":           o.RuntimeDigest,
		"tool_manifest_hash":       o.ToolManifestHash,
		"model_version":            o.ModelVersion,
		"grant_set":                grants,
		"expected_checkpoint_seq":  numberOrNil(o.ExpectedCheckpointSeq),
		"expected_checkpoint_hash": o.ExpectedCheckpointHash,
		"original_target":          map[string]any{"device_id": o.DeviceID, "session_id": o.SessionID},
		"offer_expiry":             o.OfferExpiry,
	}
	return wire, nil
}

// grantSetWire renders binding_grant_set (0040: {grant_id, grant_revision}) with the revision
// as a decimal string. Any other element shape is a storage break, not a wire choice.
func grantSetWire(raw json.RawMessage) ([]map[string]any, error) {
	var elems []struct {
		GrantID       string          `json:"grant_id"`
		GrantRevision json.RawMessage `json:"grant_revision"`
	}
	if err := json.Unmarshal(raw, &elems); err != nil {
		return nil, fmt.Errorf("invalid_request: grant_set")
	}
	grants := make([]map[string]any, 0, len(elems))
	for _, elem := range elems {
		revision, err := decimalText(elem.GrantRevision)
		if err != nil {
			return nil, err
		}
		grants = append(grants, map[string]any{
			"grant_id":       elem.GrantID,
			"grant_revision": revision,
		})
	}
	return grants, nil
}

// decimalText accepts either stored form of a uint64 counter (JSON number or decimal string)
// and returns the canonical decimal string. Negative, fractional and exponent forms fail.
func decimalText(raw json.RawMessage) (string, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if _, err := strconv.ParseUint(text, 10, 64); err != nil {
			return "", fmt.Errorf("invalid_request: grant_revision")
		}
		return text, nil
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return "", fmt.Errorf("invalid_request: grant_revision")
	}
	if _, err := strconv.ParseUint(number.String(), 10, 64); err != nil {
		return "", fmt.Errorf("invalid_request: grant_revision")
	}
	return number.String(), nil
}

// numberOrNil renders a nullable SQL bigint as a decimal string, or JSON null.
func numberOrNil(n *json.Number) any {
	if n == nil {
		return nil
	}
	return n.String()
}

// listPendingOffers reads the device's live offered bindings through the 0052 getter as
// work_worker. The getter is read-only: it moves no state, so offered->ready remains
// acknowledge_run_ready's unique transition.
func (s *Server) listPendingOffers(ctx context.Context, orgID, deviceID, sessionID string) ([]pendingOffer, error) {
	var raw []byte
	err := workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.list_pending_device_offers($1, $2::uuid, $3::uuid)`,
			orgID, deviceID, sessionID,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	var offers []pendingOffer
	if err := json.Unmarshal(raw, &offers); err != nil {
		return nil, fmt.Errorf("invalid_request: pending offers")
	}
	return offers, nil
}

// pushPendingOffers pushes the device's live offers (device-design §3.1: delivery is push and
// re-pushable at each session establish, symmetric with the resolution queue). Each frame is
// server-signed under the run_offer frame type. The start_nonce of each row is cached for the
// stream so a later run_ready can acquire the lease without a second read.
//
// A binding already pushed on THIS stream is skipped: the getter is read-only, so unlike the
// resolution queue (0049 marks rows delivered and the set shrinks as the device acks) an
// offer stays 'offered' until the device answers, and re-pushing it on every 10s heartbeat
// would nag a device that already answered missing_input until the offer expired. Re-push
// across a reconnect still happens, because the cache is per stream.
func (s *Server) pushPendingOffers(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, nonces map[offerNonceKey]string) error {
	offers, err := s.listPendingOffers(ctx, orgID, deviceID, sessionID)
	if err != nil {
		return mapError(err)
	}
	for i := range offers {
		offer := &offers[i]
		revision, err := strconv.ParseInt(offer.BindingRevision.String(), 10, 64)
		if err != nil || offer.StartNonce == "" {
			return status.Error(codes.Internal, "service_degraded")
		}
		key := offerNonceKey{runID: offer.RunID, revision: revision}
		if _, pushed := nonces[key]; pushed {
			continue
		}
		nonces[key] = offer.StartNonce
		wire, err := runOfferWire(offer)
		if err != nil {
			return status.Error(codes.Internal, "service_degraded")
		}
		raw, err := signedDownlink(s.serverKey, "run_offer", deviceID, sessionID, wire)
		if err != nil {
			return status.Error(codes.Internal, "service_degraded")
		}
		if err := stream.SendMsg(raw); err != nil {
			return err
		}
	}
	return nil
}

// resolveStartNonce returns the binding's start_nonce, from the stream cache when this
// session pushed the offer, otherwise from a fresh read-only getter call (the binding is
// still 'offered' at that point). Ruling 2026-11-16: the nonce is READ from the binding row
// and passed through verbatim — never minted here. device_run_binding.start_nonce is NOT NULL
// and guard-immutable (0040:903, 0040:976) and create_device_run_binding already mints it,
// and §3.2's start_nonce uniqueness plus the device's single-use runtime_start both key off
// that one value.
//
// A run_ready for a binding this session never saw and that is no longer 'offered' has no
// nonce source and is refused: cross-session run_start re-push (recovering a lost run_start
// after a reconnect) is a deferred boundary, and minting a nonce to paper over it would
// desync the device's single-use journal row.
func (s *Server) resolveStartNonce(ctx context.Context, orgID, deviceID, sessionID, runID string, revision int64, nonces map[offerNonceKey]string) (string, error) {
	key := offerNonceKey{runID: runID, revision: revision}
	if nonce := nonces[key]; nonce != "" {
		return nonce, nil
	}
	offers, err := s.listPendingOffers(ctx, orgID, deviceID, sessionID)
	if err != nil {
		return "", err
	}
	for i := range offers {
		if offers[i].RunID == runID && offers[i].BindingRevision.String() == strconv.FormatInt(revision, 10) {
			nonces[key] = offers[i].StartNonce
			return offers[i].StartNonce, nil
		}
	}
	return "", fmt.Errorf("invalid_request: run_ready offer")
}

// handleRunReady verifies the device's ES256 run_ready signature BEFORE any domain command,
// records the answer through acknowledge_run_ready and, only for a ready answer, sends
// the server-signed run_start. 0069 bindings are already active with a pre-created lease;
// legacy bindings still report ready and mint the lease on this call.
func (s *Server) handleRunReady(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, pub *devicesig.PublicKey, env *Envelope, nonces map[offerNonceKey]string) error {
	var body runReadyBody
	if err := json.Unmarshal(env.Body, &body); err != nil || body.Signature == "" {
		return mapError(fmt.Errorf("invalid_request: run_ready body"))
	}
	if !devicesig.VerifyFrame(pub, "run_ready", env.Body, body.Signature) {
		return mapError(fmt.Errorf("unauthorized"))
	}
	revision, err := strconv.ParseInt(body.BindingRevision, 10, 64)
	if err != nil || revision < 1 || body.RunID == "" || body.BindingHash == "" || body.ReadyOrReason == "" {
		return mapError(fmt.Errorf("invalid_request: run_ready identity"))
	}

	ready, err := json.Marshal(map[string]any{
		"binding_hash":     body.BindingHash,
		"ready_or_reason":  body.ReadyOrReason,
		"device_signature": body.Signature,
	})
	if err != nil {
		return mapError(fmt.Errorf("invalid_request: run_ready element"))
	}
	// The envelope message_id is the idempotency key: a re-sent run_ready replays the stored
	// response rather than moving the binding twice.
	result, err := s.acknowledgeReady(ctx, orgID, deviceID, sessionID, body.RunID, revision, env.MessageID, ready)
	if err != nil {
		return mapError(err)
	}
	var acked struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal(result, &acked); err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	if acked.State != "ready" && acked.State != "active" {
		return nil
	}

	nonce, err := s.resolveStartNonce(ctx, orgID, deviceID, sessionID, body.RunID, revision, nonces)
	if err != nil {
		return mapError(err)
	}
	lease, err := s.acquireLease(ctx, orgID, deviceID, sessionID, body.RunID, revision, nonce)
	if err != nil {
		return mapError(err)
	}
	startRaw, err := runStartWire(lease, sessionID)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	raw, err := signedDownlink(s.serverKey, "run_start", deviceID, sessionID, startRaw)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	return stream.SendMsg(raw)
}

// acknowledgeReady records one run_ready answer through acknowledge_run_ready as work_worker
// (0052: the command now checks the calling device/session against the binding's own).
func (s *Server) acknowledgeReady(ctx context.Context, orgID, deviceID, sessionID, runID string, revision int64, requestID string, ready json.RawMessage) (json.RawMessage, error) {
	var raw []byte
	err := workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.acknowledge_run_ready($1, $2::uuid, $3, $4, $5::jsonb, $6::uuid, $7::uuid)`,
			orgID, runID, revision, requestID, ready, deviceID, sessionID,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// acquireLease passes the binding's own start_nonce verbatim. For 0069 bindings the lease
// and baseline already exist and this call signs run_start once; legacy bindings mint them.
func (s *Server) acquireLease(ctx context.Context, orgID, deviceID, sessionID, runID string, revision int64, nonce string) (json.RawMessage, error) {
	var raw []byte
	err := workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.acquire_device_lease($1, $2::uuid, $3::uuid, $4::uuid, $5, 'execute', $6::uuid, $7)`,
			orgID, runID, deviceID, sessionID, revision, nonce, leaseTTLSeconds,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// runStartWire builds the closed run_start body (device-design §3.1 run_start row:
// run_binding_id/hash, run_id, session/fence/generation, lease_id, runtime_digest,
// start_nonce, expiry, server_signature) from the acquire_device_lease result. The command
// already returns exactly that run_start object; the gateway adds the transport session_id
// and the generation from the same response, and re-renders the uint64s as decimal strings.
//
// §3.2's "有效期≤5s的run_start" is a delivery window, not a lease TTL: the frame is signed
// and sent immediately inside this handler, while the lease itself keeps the 30s TTL the
// hello_ack already advertised.
func runStartWire(lease json.RawMessage, sessionID string) (map[string]any, error) {
	var res struct {
		Generation json.Number                `json:"generation"`
		RunStart   map[string]json.RawMessage `json:"run_start"`
	}
	if err := json.Unmarshal(lease, &res); err != nil || res.RunStart == nil {
		return nil, fmt.Errorf("invalid_request: lease run_start")
	}
	text := func(key string) (string, error) {
		var v string
		if err := json.Unmarshal(res.RunStart[key], &v); err != nil {
			return "", fmt.Errorf("invalid_request: run_start %s", key)
		}
		return v, nil
	}
	number := func(key string) (string, error) {
		var v json.Number
		if err := json.Unmarshal(res.RunStart[key], &v); err != nil {
			return "", fmt.Errorf("invalid_request: run_start %s", key)
		}
		return v.String(), nil
	}
	bindingID, err := number("run_binding_id")
	if err != nil {
		return nil, err
	}
	runID, err := text("run_id")
	if err != nil {
		return nil, err
	}
	leaseID, err := text("lease_id")
	if err != nil {
		return nil, err
	}
	fence, err := number("fence")
	if err != nil {
		return nil, err
	}
	nonce, err := text("start_nonce")
	if err != nil {
		return nil, err
	}
	expiry, err := text("expiry")
	if err != nil {
		return nil, err
	}
	digest, err := text("runtime_digest")
	if err != nil {
		return nil, err
	}
	payloadHash, err := text("payload_hash")
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"run_binding_id": bindingID,
		"run_id":         runID,
		"payload_hash":   payloadHash,
		"session_id":     sessionID,
		"fence":          fence,
		"generation":     res.Generation.String(),
		"lease_id":       leaseID,
		"runtime_digest": digest,
		"start_nonce":    nonce,
		"expiry":         expiry,
	}, nil
}

// handleRunStarted verifies the device's ES256 run_started signature and stops there.
// Ruling 2026-11-16: verify-only, NO database write — the server facts already exist (the
// binding is active, acquire_device_lease wrote the seq=0 baseline, and the lease row
// carries the start_nonce), and work.append_audit has no work_worker EXECUTE grant, so
// there is no worker-callable audit path to write to. run_started is the device's journal
// fact (runtime_start, single-use by start_nonce); §3.2 makes a lost response the device's
// problem to resolve by querying its own local state, not a second server write.
func (s *Server) handleRunStarted(pub *devicesig.PublicKey, env *Envelope) error {
	var body runStartedBody
	if err := json.Unmarshal(env.Body, &body); err != nil || body.Signature == "" {
		return mapError(fmt.Errorf("invalid_request: run_started body"))
	}
	if !devicesig.VerifyFrame(pub, "run_started", env.Body, body.Signature) {
		return mapError(fmt.Errorf("unauthorized"))
	}
	if body.StartNonce == "" || body.State == "" {
		return mapError(fmt.Errorf("invalid_request: run_started identity"))
	}
	return nil
}
