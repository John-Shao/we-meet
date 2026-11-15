package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

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
// → receipt_ack). The permit/lease/command/resolution/finish frames remain deferred.
type Server struct {
	pool *pgxpool.Pool
}

// NewServer builds a gateway bound to the work database pool.
func NewServer(pool *pgxpool.Pool) *Server { return &Server{pool: pool} }

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
	ackRaw, err := helloAckEnvelope(deviceID, sessionID, ack)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	if err := stream.SendMsg(ackRaw); err != nil {
		return err
	}

	// After hello_ack the stream carries device uplink frames. GW4 handles the
	// receipt frame; the remaining frames (permit/lease/command/resolution/finish)
	// are refused as unimplemented rather than silently dropped. The public key
	// verified at hello is reused for the session's frames.
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
		default:
			return status.Error(codes.Unimplemented, "frame deferred to GW4")
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
	ackRaw, err := receiptAckEnvelope(deviceID, sessionID, result)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	return stream.SendMsg(ackRaw)
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
	receipts, err := json.Marshal([]any{element})
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
