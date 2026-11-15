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
// work_api has no EXECUTE). GW3 implements the hello/hello_ack/session slice; the
// receipt/permit/lease/command/resolution/finish frames are GW4.
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

	// GW3 slice ends at hello_ack. Any further frame (heartbeat/receipt/permit/
	// lease/command/resolution/finish) is GW4 and refused as unimplemented rather
	// than silently dropped.
	var next []byte
	if err := stream.RecvMsg(&next); err != nil {
		return err
	}
	return status.Error(codes.Unimplemented, "frame deferred to GW4")
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
