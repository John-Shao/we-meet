package gateway_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/deviceca"
	"github.com/we-meet/work/internal/devicesig"
	"github.com/we-meet/work/internal/gateway"
	"github.com/we-meet/work/internal/testpg"
)

const (
	gwOrg     = "org_gw"
	gwSubject = "sub_gw"
	gwEpoch   = 7
)

func TestMain(m *testing.M) {
	if testpg.AdminURL() == "" {
		os.Exit(m.Run())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err == nil {
		err = testpg.EnsureFixtures(ctx, admin)
		_ = admin.Close(ctx)
	}
	cancel()
	if err != nil {
		fmt.Fprintf(os.Stderr, "prepare gateway test fixtures: %v\n", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func gwContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// genDeviceKey returns a fresh software P-256 key, its closed JWK and thumbprint.
func genDeviceKey(t *testing.T) (*ecdsa.PrivateKey, []byte, string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	x := base64.RawURLEncoding.EncodeToString(priv.PublicKey.X.FillBytes(make([]byte, 32)))
	y := base64.RawURLEncoding.EncodeToString(priv.PublicKey.Y.FillBytes(make([]byte, 32)))
	jwk := fmt.Sprintf(`{"crv":"P-256","kty":"EC","x":%q,"y":%q}`, x, y)
	return priv, []byte(jwk), devicesig.Thumbprint(x, y)
}

type gwFixture struct {
	pool       *pgxpool.Pool
	dbName     string
	deviceID   string
	ticket     string
	priv       *ecdsa.PrivateKey
	thumbprint string
	ca         *deviceca.CA
	serverCert tls.Certificate
	deviceCert tls.Certificate
}

// newGatewayFixture creates a baseline DB, seeds an active device with a known key
// and a pending single-use session ticket, and prepares a test-only CA with server
// and device certificates. The device is seeded directly (the pairing face is
// covered by internal/api); this batch tests the hello/session transport.
func newGatewayFixture(t *testing.T) *gwFixture {
	t.Helper()
	if testpg.AdminURL() == "" {
		t.Skip("WORK_TEST_PG_URL is not set")
	}
	ctx := gwContext(t)
	admin, err := testpg.Open(ctx, testpg.AdminURL())
	if err != nil {
		t.Fatal(err)
	}
	dbName, err := testpg.CreateBaselineDB(ctx, admin, "work_gw_test")
	_ = admin.Close(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		a, err := testpg.Open(cctx, testpg.AdminURL())
		if err == nil {
			_ = testpg.DropDatabase(cctx, a, dbName)
			_ = a.Close(cctx)
		}
	})

	priv, jwk, thumbprint := genDeviceKey(t)
	deviceID := uuid.NewString()
	ticket := "ticket-" + uuid.NewString()
	ticketHash := sha256Hex(ticket)

	seed, err := testpg.Open(ctx, testpg.AdminURLFor(dbName))
	if err != nil {
		t.Fatal(err)
	}
	statement := fmt.Sprintf(`
		INSERT INTO work.org (id, status, home_region, name) VALUES ('%s','active','cn-north','GW');
		INSERT INTO work.member (org_id, subject_id, status, role, work_seat)
			VALUES ('%s','%s','active','owner',true);
		INSERT INTO work.device
			(org_id, id, owner_subject_id, device_name, platform, public_key_jwk,
			 public_key_thumbprint, auth_plane, auth_epoch, status)
			VALUES ('%s','%s','%s','desk','windows-x64','%s'::jsonb,'%s','bearer',%d,'active');
		INSERT INTO work.device_session_ticket
			(org_id, device_id, owner_subject_id, auth_plane, auth_epoch,
			 public_key_thumbprint, ticket_hash, client_request_id, request_hash, expires_at, state)
			VALUES ('%s','%s','%s','bearer',%d,'%s','%s','tick-1','%s', now() + interval '60 seconds','pending');
	`, gwOrg, gwOrg, gwSubject, gwOrg, deviceID, gwSubject, string(jwk), thumbprint, gwEpoch,
		gwOrg, deviceID, gwSubject, gwEpoch, thumbprint, ticketHash, sha256Hex("req"))
	if err := testpg.ExecRaw(ctx, seed, statement); err != nil {
		_ = seed.Close(ctx)
		t.Fatal(err)
	}
	_ = seed.Close(ctx)

	pool, err := workdb.OpenPool(ctx, testpg.WorkerURL(dbName), "work-gateway-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	ca, err := deviceca.NewCA()
	if err != nil {
		t.Fatal(err)
	}
	serverCert, err := ca.IssueServerCert([]string{"localhost", "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	deviceCert, err := ca.IssueDeviceCert(deviceID, gwOrg, &priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	deviceCert.PrivateKey = priv

	return &gwFixture{
		pool: pool, dbName: dbName, deviceID: deviceID, ticket: ticket,
		priv: priv, thumbprint: thumbprint, ca: ca, serverCert: serverCert, deviceCert: deviceCert,
	}
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// startServer starts the mTLS gRPC gateway on a loopback listener and returns its address.
func (f *gwFixture) startServer(t *testing.T) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer(
		grpc.Creds(credentials.NewTLS(deviceca.ServerTLSConfig(f.ca, f.serverCert))),
		grpc.ForceServerCodec(gateway.FrameCodec()),
	)
	gateway.NewServer(f.pool).Register(srv)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	return lis.Addr().String()
}

// connect opens a Connect stream as the device (mTLS + frame codec).
func (f *gwFixture) connect(t *testing.T, addr string) grpc.ClientStream {
	t.Helper()
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(credentials.NewTLS(deviceca.ClientTLSConfig(f.ca, f.deviceCert, "localhost"))),
		grpc.WithDefaultCallOptions(grpc.ForceCodec(gateway.FrameCodec())),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	stream, err := conn.NewStream(gwContext(t),
		&grpc.StreamDesc{StreamName: "Connect", ServerStreams: true, ClientStreams: true},
		"/work.device.v2.DeviceGateway/Connect")
	if err != nil {
		t.Fatal(err)
	}
	return stream
}

// signHello builds a signed hello envelope. mutate, if non-nil, adjusts the body
// map before signing (for negative tests that still carry a valid signature).
func (f *gwFixture) signHello(t *testing.T, ticket string, features []string, mutate func(map[string]any)) []byte {
	t.Helper()
	body := map[string]any{
		"client_version":     "0.0.0",
		"protocol_major":     2,
		"protocol_minor":     0,
		"required_features":  features,
		"tool_manifest_hash": strings.Repeat("a", 64),
		"runtime_digest":     strings.Repeat("b", 64),
		"profile_id":         "profile",
		"journal_epoch":      uuid.NewString(),
		"last_receipt_seq":   "0",
		"ticket":             ticket,
		"challenge_response": "",
	}
	if mutate != nil {
		mutate(body)
	}
	bodyJSON, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	preimage, err := devicesig.SignedPayload("hello", bodyJSON)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(preimage)
	r, s, err := ecdsa.Sign(rand.Reader, f.priv, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	body["signature"] = base64.RawURLEncoding.EncodeToString(sig)
	bodyJSON, err = json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]any{
		"schema_version":      2,
		"type":                "hello",
		"message_id":          uuid.NewString(),
		"device_id":           f.deviceID,
		"session_id":          "",
		"agent_instance_id":   uuid.NewString(),
		"boot_id":             "boot-" + uuid.NewString(),
		"recovery_generation": "0",
		"sent_at":             time.Now().UTC().Format(time.RFC3339),
		"body":                json.RawMessage(bodyJSON),
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func recvAck(t *testing.T, stream grpc.ClientStream) map[string]any {
	t.Helper()
	var raw []byte
	if err := stream.RecvMsg(&raw); err != nil {
		t.Fatalf("recv hello_ack: %v", err)
	}
	var env struct {
		Type      string          `json:"type"`
		SessionID string          `json:"session_id"`
		DeviceID  string          `json:"device_id"`
		Body      json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "hello_ack" {
		t.Fatalf("frame type = %q, want hello_ack", env.Type)
	}
	var body map[string]any
	if err := json.Unmarshal(env.Body, &body); err != nil {
		t.Fatal(err)
	}
	body["_session_id"] = env.SessionID
	body["_device_id"] = env.DeviceID
	return body
}

func wantCode(t *testing.T, err error, want codes.Code) {
	t.Helper()
	if status.Code(err) != want {
		t.Fatalf("code = %v (err=%v), want %v", status.Code(err), err, want)
	}
}

func TestHelloAllocatesSession(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	if err := stream.SendMsg(f.signHello(t, f.ticket, []string{"journal"}, nil)); err != nil {
		t.Fatal(err)
	}
	ack := recvAck(t, stream)
	if ack["_session_id"] == "" || ack["_device_id"] != f.deviceID {
		t.Fatalf("hello_ack = %#v", ack)
	}
	if ack["session_id"] != ack["_session_id"] {
		t.Fatalf("body session_id = %v, envelope session_id = %v", ack["session_id"], ack["_session_id"])
	}
	if ack["lease_ttl_ms"] == nil || ack["heartbeat_ms"] == nil || ack["resync_required"] != true {
		t.Fatalf("hello_ack body = %#v", ack)
	}
}

func TestHelloRejectsBadSignature(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	hello := f.signHello(t, f.ticket, []string{"journal"}, nil)
	// Flip a byte in the body signature so the ES256 verification fails.
	var env map[string]json.RawMessage
	_ = json.Unmarshal(hello, &env)
	var body map[string]any
	_ = json.Unmarshal(env["body"], &body)
	body["signature"] = strings.Repeat("A", 86)
	env["body"], _ = json.Marshal(body)
	tampered, _ := json.Marshal(env)
	if err := stream.SendMsg(tampered); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.Unauthenticated)
}

func TestHelloRejectsUnknownFeature(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	if err := stream.SendMsg(f.signHello(t, f.ticket, []string{"journal", "unknown-security-feature"}, nil)); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.FailedPrecondition)
}

func TestHelloTicketIsSingleUse(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	s1 := f.connect(t, addr)
	if err := s1.SendMsg(f.signHello(t, f.ticket, []string{"journal"}, nil)); err != nil {
		t.Fatal(err)
	}
	_ = recvAck(t, s1)
	// A second hello with the same consumed ticket must be refused.
	s2 := f.connect(t, addr)
	if err := s2.SendMsg(f.signHello(t, f.ticket, []string{"journal"}, nil)); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, s2.RecvMsg(&raw), codes.Unauthenticated)
}

func TestHelloRejectsRevokedDevice(t *testing.T) {
	f := newGatewayFixture(t)
	ctx := gwContext(t)
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	if err := testpg.ExecRaw(ctx, seed, fmt.Sprintf(
		`UPDATE work.device SET status='revoked', revoked_at=now() WHERE org_id='%s' AND id='%s'`,
		gwOrg, f.deviceID)); err != nil {
		t.Fatal(err)
	}
	_ = seed.Close(ctx)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	if err := stream.SendMsg(f.signHello(t, f.ticket, []string{"journal"}, nil)); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.PermissionDenied)
}

func TestHelloRejectsMismatchedDeviceID(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	hello := f.signHello(t, f.ticket, []string{"journal"}, nil)
	var env map[string]json.RawMessage
	_ = json.Unmarshal(hello, &env)
	env["device_id"], _ = json.Marshal(uuid.NewString()) // not the cert-mapped device
	tampered, _ := json.Marshal(env)
	if err := stream.SendMsg(tampered); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.Unauthenticated)
}

// TestHelloRequiresClientCert proves the mTLS boundary: a peer that trusts the CA
// but presents no client certificate cannot reach the domain command (§2.2: mTLS
// and ticket must both pass).
func TestHelloRequiresClientCert(t *testing.T) {
	f := newGatewayFixture(t)
	addr := f.startServer(t)
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
			RootCAs:    f.ca.Pool(),
			ServerName: "localhost",
			MinVersion: tls.VersionTLS13,
		})),
		grpc.WithDefaultCallOptions(grpc.ForceCodec(gateway.FrameCodec())),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	stream, err := conn.NewStream(gwContext(t),
		&grpc.StreamDesc{StreamName: "Connect", ServerStreams: true, ClientStreams: true},
		"/work.device.v2.DeviceGateway/Connect")
	if err != nil {
		// Handshake may fail at stream creation; that is a refusal too.
		return
	}
	_ = stream.SendMsg(f.signHello(t, f.ticket, []string{"journal"}, nil))
	var raw []byte
	if err := stream.RecvMsg(&raw); err == nil {
		t.Fatal("expected mTLS refusal without a client certificate, got hello_ack")
	}
}

// TestHelloRejectsEpochMismatch proves a ticket bound to a stale auth_epoch is
// refused: the CAS requires the ticket epoch to equal the device's current epoch
// (§1.1 epoch raised → old tickets invalid; m1a §12.8 ④). The ticket and device
// epochs are both immutable by guard, so the mismatch is seeded directly: a ticket
// minted at epoch+1 against a device still at epoch.
func TestHelloRejectsEpochMismatch(t *testing.T) {
	f := newGatewayFixture(t)
	ctx := gwContext(t)
	staleTicket := "ticket-stale-" + uuid.NewString()
	seed, err := testpg.Open(ctx, testpg.AdminURLFor(f.dbName))
	if err != nil {
		t.Fatal(err)
	}
	if err := testpg.ExecRaw(ctx, seed, fmt.Sprintf(`
		INSERT INTO work.device_session_ticket
			(org_id, device_id, owner_subject_id, auth_plane, auth_epoch,
			 public_key_thumbprint, ticket_hash, client_request_id, request_hash, expires_at, state)
			VALUES ('%s','%s','%s','bearer',%d,'%s','%s','tick-stale','%s', now() + interval '60 seconds','pending')`,
		gwOrg, f.deviceID, gwSubject, gwEpoch+1, f.thumbprint, sha256Hex(staleTicket), sha256Hex("req-stale"))); err != nil {
		t.Fatal(err)
	}
	_ = seed.Close(ctx)
	addr := f.startServer(t)
	stream := f.connect(t, addr)
	if err := stream.SendMsg(f.signHello(t, staleTicket, []string{"journal"}, nil)); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	wantCode(t, stream.RecvMsg(&raw), codes.Unauthenticated)
}
