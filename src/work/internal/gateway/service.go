package gateway

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/deviceca"
	"github.com/we-meet/work/internal/devicesig"
)

// Server is the device gateway domain proxy. It terminates mTLS, verifies device
// frame signatures with internal/devicesig before any domain command, and calls
// the landed SQL as work_worker (m1a §12.8: gateway hello → activate_device_session,
// work_api has no EXECUTE). GW3 implements the hello/hello_ack/session slice; GW4
// adds the receipt uplink (verify → translate wire→SQL element → record_device_receipt
// → receipt_ack). GW7 adds the server signing key (test-only software P-256) whose
// public JWK rides hello_ack so the device can verify server-signed downlink frames
// (operation_resolution first). GW10 adds the heartbeat uplink and the unsigned lease
// downlink (renew_device_lease, 0051). GW11 adds the offer spine: server-signed run_offer
// re-push, run_ready uplink, and the server-signed run_start that follows a lease acquire
// (0052). GW12 adds the run_finish adjudication face, GW13 the action_prepare face, GW14
// the command downlink with its INDEPENDENT permit signing key (0055), and GW15 the cancel
// downlink plus the cancel_ack stop fact (0056).
type Server struct {
	pool      *pgxpool.Pool
	serverKey *ecdsa.PrivateKey
	serverJWK json.RawMessage
	// permitKey is the second, independent signing key §3.3 requires for execution permits.
	// It is never the frame key: a permit is an authority to act, so its key and signing
	// domain are separate from the one that signs receipts, offers and verdicts.
	permitKey *ecdsa.PrivateKey
	permitJWK json.RawMessage
	permitKid string
}

// NewServer builds a gateway bound to the work database pool and generates its two
// test-only software P-256 signing keys. Production signing keys belong to KMS/HSM with
// rotation and independent review (J39), deferred.
func NewServer(pool *pgxpool.Pool) (*Server, error) {
	key, err := devicesig.GenerateSigningKey()
	if err != nil {
		return nil, err
	}
	jwk, err := devicesig.PublicJWK(key)
	if err != nil {
		return nil, err
	}
	permitKey, err := devicesig.GenerateSigningKey()
	if err != nil {
		return nil, err
	}
	permitJWK, err := devicesig.PublicJWK(permitKey)
	if err != nil {
		return nil, err
	}
	permitPub, err := devicesig.ParseJWK(permitJWK)
	if err != nil {
		return nil, err
	}
	return &Server{pool: pool, serverKey: key, serverJWK: jwk,
		permitKey: permitKey, permitJWK: permitJWK, permitKid: permitPub.Thumbprint}, nil
}

// deviceGatewayHandler is the interface the gRPC service descriptor checks the
// implementation against (RegisterService requires HandlerType to be an interface).
type deviceGatewayHandler interface {
	connect(grpc.ServerStream) error
}

// serviceDesc is the hand-written v2 DeviceGateway service descriptor. The Connect
// bidi stream carries raw JCS-signed JSON frame bytes via frameCodec (no protoc;
// device-design §3:81 makes the v1 proto reference only).
var serviceDesc = grpc.ServiceDesc{
	ServiceName: "work.device.v2.DeviceGateway",
	HandlerType: (*deviceGatewayHandler)(nil),
	Streams: []grpc.StreamDesc{
		{
			StreamName:    "Connect",
			Handler:       connectStreamHandler,
			ServerStreams: true,
			ClientStreams: true,
		},
	},
}

func connectStreamHandler(srv any, stream grpc.ServerStream) error {
	return srv.(*Server).connect(stream)
}

// Register attaches the DeviceGateway service to a gRPC server.
func (s *Server) Register(grpcServer *grpc.Server) {
	grpcServer.RegisterService(&serviceDesc, s)
}

// peerDevice maps the mTLS client certificate to (deviceID, orgID). The mapping is
// trusted because the CA signed it; the client cannot forge it (device-design §2.1
// step 4: do not trust client-self-reported roles in the certificate).
func peerDevice(ctx context.Context) (deviceID, orgID string, err error) {
	p, ok := peer.FromContext(ctx)
	if !ok {
		return "", "", fmt.Errorf("no peer")
	}
	tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok || len(tlsInfo.State.PeerCertificates) == 0 {
		return "", "", fmt.Errorf("no client certificate")
	}
	return deviceca.DeviceIdentity(tlsInfo.State.PeerCertificates[0])
}

func (s *Server) connect(stream grpc.ServerStream) error {
	ctx := stream.Context()
	deviceID, orgID, err := peerDevice(ctx)
	if err != nil {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	if _, err := uuid.Parse(deviceID); err != nil {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}

	var raw []byte
	if err := stream.RecvMsg(&raw); err != nil {
		return err
	}
	env, err := parseEnvelope(raw)
	if err != nil {
		return mapError(err)
	}
	if env.Type != "hello" {
		return status.Error(codes.FailedPrecondition, "invalid_request: first frame must be hello")
	}
	// The envelope device_id must equal the certificate-mapped device; the body
	// cannot override the server-mapped identity (device-design §3.1).
	if env.DeviceID != deviceID {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	var body HelloBody
	if err := json.Unmarshal(env.Body, &body); err != nil {
		return mapError(fmt.Errorf("invalid_request: hello body"))
	}

	// Verify the ES256 frame signature against the in-DB public key BEFORE the
	// domain command (0047 getter; 0040:1135, 0021 precedent). The key never comes
	// from the request body (m1a §12 judgment 5).
	jwk, err := s.signingKey(ctx, orgID, deviceID)
	if err != nil {
		return mapError(err)
	}
	pub, err := devicesig.ParseJWK(jwk)
	if err != nil {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	if !devicesig.VerifyFrame(pub, "hello", env.Body, body.Signature) {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	if err := checkFeatures(body.RequiredFeatures); err != nil {
		return mapError(err)
	}
	if body.Ticket == "" {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	sum := sha256.Sum256([]byte(body.Ticket))
	ticketHash := hex.EncodeToString(sum[:])

	command, err := helloCommand(env, &body)
	if err != nil {
		return mapError(err)
	}
	ack, err := s.activateSession(ctx, orgID, deviceID, ticketHash, command)
	if err != nil {
		return mapError(err)
	}
	var ackObj map[string]any
	if err := json.Unmarshal(ack, &ackObj); err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	sessionID, _ := ackObj["session_id"].(string)
	ackRaw, err := helloAckEnvelope(deviceID, sessionID, ack, s.serverJWK, s.permitJWK)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	if err := stream.SendMsg(ackRaw); err != nil {
		return err
	}
	// Session establish: re-push every un-acked resolution before the uplink loop
	// (device-design §3.1 "每次 session 建立…先按未 ack 的 resolution 重发"), then every
	// live offer (GW11: the same push-and-re-push rule for run_offer, 0052 read-only getter).
	if err := s.pushPendingResolutions(ctx, stream, orgID, deviceID, sessionID); err != nil {
		return err
	}
	// The nonce cache holds each pushed binding's start_nonce for the lifetime of this
	// stream, so a re-sent run_ready can still acquire the lease (0041 keys lease replay on
	// that nonce) without minting a second one.
	nonces := map[offerNonceKey]string{}
	if err := s.ensureResumeOffers(ctx, orgID, deviceID, sessionID); err != nil {
		return mapError(err)
	}
	if err := s.pushPendingOffers(ctx, stream, orgID, deviceID, sessionID, nonces); err != nil {
		return err
	}
	// GW14: the command claim is the third session-establish push. Unlike the offer getter it
	// MOVES state (it dispatches authorized actions), and the pushed cache keeps a heartbeat
	// from re-delivering an instruction the device may already be executing.
	pushed := map[string]bool{}
	if err := s.pushPendingCommands(ctx, stream, orgID, deviceID, sessionID, pushed); err != nil {
		return err
	}
	// GW15: the cancel re-push is the fourth session-establish push. It is read-only and targets
	// the Run through its latest binding, so a device that crashed before acknowledging still
	// learns of the cancel here; the per-stream cache keeps a heartbeat from repeating it.
	cancels := map[string]bool{}
	if err := s.pushPendingCancels(ctx, stream, orgID, deviceID, sessionID, cancels); err != nil {
		return err
	}

	// After hello_ack the stream carries device uplink frames. GW4 handles receipt,
	// GW6 reconcile, GW7 the operation_resolution_ack that advances the delivery
	// watermark, GW9 checkpoint_commit, GW10 heartbeat (lease renewal), batch 6 lease_acquire
	// (reconcile_finish mint), GW11 run_ready and
	// run_started, GW12 run_finish, GW13 action_prepare, GW15 cancel_ack. The action spine is
	// closed end to end (prepare → permit mint → command) and so is the stop face (cancel →
	// cancel_ack); the still-deferred faces (journal_release/journal_ack, run_sealed/
	// run_sealed_ack — R0c) are refused as unimplemented rather than silently dropped, and
	// command and cancel are downlinks only. The public key verified at hello is reused for the
	// session's signed uplink frames; heartbeat is unsigned by design (§3.1 lists no signature
	// for it).
	for {
		var next []byte
		if err := stream.RecvMsg(&next); err != nil {
			return err
		}
		frame, err := parseEnvelope(next)
		if err != nil {
			return mapError(err)
		}
		if frame.DeviceID != deviceID {
			return status.Error(codes.Unauthenticated, "unauthorized")
		}
		switch frame.Type {
		case "receipt":
			if err := s.handleReceipt(ctx, stream, orgID, deviceID, sessionID, pub, frame); err != nil {
				return err
			}
		case "reconcile":
			if err := s.handleReconcile(ctx, stream, orgID, deviceID, sessionID, pub, frame); err != nil {
				return err
			}
		case "operation_resolution_ack":
			if err := s.handleResolutionAck(ctx, orgID, deviceID, sessionID, frame); err != nil {
				return err
			}
		case "checkpoint_commit":
			if err := s.handleCheckpointCommit(ctx, stream, orgID, deviceID, sessionID, pub, frame); err != nil {
				return err
			}
		case "heartbeat":
			if err := s.handleHeartbeat(ctx, stream, orgID, deviceID, sessionID, frame, nonces, pushed, cancels); err != nil {
				return err
			}
		case "lease_acquire":
			if err := s.handleLeaseAcquire(ctx, stream, orgID, deviceID, sessionID, frame); err != nil {
				return err
			}
		case "run_ready":
			if err := s.handleRunReady(ctx, stream, orgID, deviceID, sessionID, pub, frame, nonces); err != nil {
				return err
			}
		case "run_started":
			if err := s.handleRunStarted(pub, frame); err != nil {
				return err
			}
		case "run_finish":
			if err := s.handleRunFinish(ctx, stream, orgID, deviceID, sessionID, pub, frame, cancels); err != nil {
				return err
			}
		case "action_prepare":
			if err := s.handleActionPrepare(ctx, stream, orgID, deviceID, sessionID, pub, frame, pushed); err != nil {
				return err
			}
		case "model_result":
			if err := s.handleModelResult(ctx, stream, orgID, deviceID, sessionID, pub, frame); err != nil {
				return err
			}
		case "local_publish":
			if err := s.handleLocalPublish(ctx, stream, orgID, deviceID, sessionID, pub, frame); err != nil {
				return err
			}
		case "cancel_ack":
			if err := s.handleCancelAck(ctx, orgID, deviceID, sessionID, pub, frame); err != nil {
				return err
			}
		default:
			return status.Error(codes.Unimplemented, "frame deferred to a later gateway batch")
		}
	}
}

// handleReceipt verifies the receipt frame's ES256 signature over the wire body,
// translates the body into the closed SQL element, records it through the landed
// domain command as work_worker, and returns the result as a receipt_ack. The
// signature is checked BEFORE translation and BEFORE the domain command; SQL only
// shape-checks and hashes it (0048), the cryptography is here (0040:1135).
func (s *Server) handleReceipt(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, pub *devicesig.PublicKey, env *Envelope) error {
	sig, err := receiptSignature(env.Body)
	if err != nil {
		return mapError(err)
	}
	if !devicesig.VerifyFrame(pub, "receipt", env.Body, sig) {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	journalEpoch, element, err := receiptElement(env.Body)
	if err != nil {
		return mapError(err)
	}
	result, err := s.recordReceipt(ctx, orgID, deviceID, journalEpoch, element)
	if err != nil {
		return mapError(err)
	}
	ackRaw, err := receiptAckEnvelope(deviceID, sessionID, result, s.serverKey)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	if err := stream.SendMsg(ackRaw); err != nil {
		return err
	}
	// A completed receipt may have issued a fresh conclusion; re-push the queue.
	return s.pushPendingResolutions(ctx, stream, orgID, deviceID, sessionID)
}

// handleReconcile consumes a reconcile batch (device-design §3.1 reconcile row,
// §6.3 recovery). Each nested signed_receipt_bytes entry is a full original
// receipt envelope, verified and translated exactly like a live receipt frame;
// the recovery identity only authenticates transport and never rewrites the
// nested original_execution (§2.3). A bad nested signature or identity refuses
// the whole batch (fail-closed); seq-window/binding refusals are per-receipt
// conflicts surfaced by record_device_receipt. The batch result becomes a
// reconcile_ack (same body shape as receipt_ack).
func (s *Server) handleReconcile(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, pub *devicesig.PublicKey, env *Envelope) error {
	var body ReconcileBody
	if err := json.Unmarshal(env.Body, &body); err != nil {
		return mapError(fmt.Errorf("invalid_request: reconcile body"))
	}
	if len(body.SignedReceiptBytes) > maxReconcileBatch {
		return status.Error(codes.ResourceExhausted, "rate_limited")
	}
	elements := make([]map[string]any, 0, len(body.SignedReceiptBytes))
	for _, encoded := range body.SignedReceiptBytes {
		raw, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil {
			return mapError(fmt.Errorf("invalid_request: reconcile nested bytes"))
		}
		nested, err := parseEnvelope(raw)
		if err != nil {
			return mapError(err)
		}
		if nested.Type != "receipt" {
			return mapError(fmt.Errorf("invalid_request: reconcile nested frame type"))
		}
		if nested.DeviceID != deviceID {
			return status.Error(codes.Unauthenticated, "unauthorized")
		}
		sig, err := receiptSignature(nested.Body)
		if err != nil {
			return mapError(err)
		}
		if !devicesig.VerifyFrame(pub, "receipt", nested.Body, sig) {
			return status.Error(codes.Unauthenticated, "unauthorized")
		}
		journalEpoch, element, err := receiptElement(nested.Body)
		if err != nil {
			return mapError(err)
		}
		if journalEpoch != body.JournalEpoch {
			return mapError(fmt.Errorf("invalid_request: reconcile journal_epoch mismatch"))
		}
		elements = append(elements, element)
	}

	var result json.RawMessage
	if len(elements) == 0 {
		// Empty batch: the device has nothing from from_seq onward. Ack with the
		// conservative watermark just below from_seq; nothing is recorded.
		fromSeq, err := strconv.ParseUint(body.FromSeq, 10, 64)
		if err != nil {
			return mapError(fmt.Errorf("invalid_request: reconcile from_seq"))
		}
		through := uint64(0)
		if fromSeq > 0 {
			through = fromSeq - 1
		}
		result = json.RawMessage(fmt.Sprintf(
			`{"recorded":[],"conflicts":[],"receipt_through_seq":%d}`, through))
	} else {
		var err error
		result, err = s.recordReceiptBatch(ctx, orgID, deviceID, body.JournalEpoch, elements)
		if err != nil {
			return mapError(err)
		}
	}
	ackRaw, err := reconcileAckEnvelope(deviceID, sessionID, result, s.serverKey)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	if err := stream.SendMsg(ackRaw); err != nil {
		return err
	}
	return s.pushPendingResolutions(ctx, stream, orgID, deviceID, sessionID)
}

// signingKey reads the device public key through the 0047 definer getter as
// work_worker (no table SELECT under the 0024 house rule).
func (s *Server) signingKey(ctx context.Context, orgID, deviceID string) ([]byte, error) {
	var jwk []byte
	err := workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.device_signing_key($1, $2::uuid)`, orgID, deviceID,
		).Scan(&jwk)
	})
	if err != nil {
		return nil, err
	}
	return jwk, nil
}

// activateSession consumes the single-use ticket and allocates the session through
// the landed domain command as work_worker (m1a §12.8).
func (s *Server) activateSession(ctx context.Context, orgID, deviceID, ticketHash string, hello map[string]any) (json.RawMessage, error) {
	helloJSON, err := json.Marshal(hello)
	if err != nil {
		return nil, fmt.Errorf("invalid_request: hello command")
	}
	var raw []byte
	err = workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.activate_device_session($1, $2::uuid, $3, $4::jsonb)`,
			orgID, deviceID, ticketHash, helloJSON,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// recordReceipt records one translated receipt element through the landed domain
// command as work_worker (m1a §12.8). The wire carries one receipt per frame; the
// command takes a batch, so the element is wrapped in a single-element array. The
// returned recorded/conflicts/receipt_through_seq become the receipt_ack body.
func (s *Server) recordReceipt(ctx context.Context, orgID, deviceID, journalEpoch string, element map[string]any) (json.RawMessage, error) {
	return s.recordReceiptBatch(ctx, orgID, deviceID, journalEpoch, []map[string]any{element})
}

// recordReceiptBatch records a translated receipt batch through record_device_receipt
// as work_worker. The command shape-checks the batch (1..100), binds each
// original_execution, enforces seq continuity and returns per-receipt conflicts.
func (s *Server) recordReceiptBatch(ctx context.Context, orgID, deviceID, journalEpoch string, elements []map[string]any) (json.RawMessage, error) {
	receipts, err := json.Marshal(elements)
	if err != nil {
		return nil, fmt.Errorf("invalid_request: receipt element")
	}
	var raw []byte
	err = workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.record_device_receipt($1, $2::uuid, $3::uuid, $4::jsonb)`,
			orgID, deviceID, journalEpoch, receipts,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}
