// Command work-gateway is the R0b device gateway: an mTLS gRPC server exposing
// work.device.v2.DeviceGateway/Connect. GW3 implements the hello/hello_ack/session
// slice; later frames are GW4. The device CA and certificate provisioning are
// external (the test-only internal/deviceca exercises this in tests); production
// CA/rotation is a deferred sign-off item.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/gateway"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "work-gateway:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	url := flag.String("url", os.Getenv("WORK_DATABASE_URL"), "PostgreSQL connection URL")
	listen := flag.String("listen", ":8443", "mTLS gRPC listen address")
	caFile := flag.String("ca-cert", "", "device CA certificate PEM (verifies client certs)")
	certFile := flag.String("server-cert", "", "gateway server certificate PEM")
	keyFile := flag.String("server-key", "", "gateway server private key PEM")
	flag.Parse()

	if *url == "" {
		return fmt.Errorf("database URL is required (-url or WORK_DATABASE_URL)")
	}
	if *caFile == "" || *certFile == "" || *keyFile == "" {
		return fmt.Errorf("-ca-cert, -server-cert and -server-key are required")
	}

	pool, err := workdb.OpenPool(ctx, *url, "work-gateway")
	if err != nil {
		return err
	}
	defer pool.Close()

	caPEM, err := os.ReadFile(*caFile)
	if err != nil {
		return fmt.Errorf("read CA cert: %w", err)
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(caPEM) {
		return fmt.Errorf("CA cert PEM did not parse")
	}
	serverCert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		return fmt.Errorf("load server key pair: %w", err)
	}
	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{serverCert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCAs,
		MinVersion:   tls.VersionTLS13,
	}

	lis, err := net.Listen("tcp", *listen)
	if err != nil {
		return fmt.Errorf("listen %s: %w", *listen, err)
	}
	grpcServer := grpc.NewServer(
		grpc.Creds(credentials.NewTLS(tlsConfig)),
		grpc.ForceServerCodec(gateway.FrameCodec()),
	)
	gateway.NewServer(pool).Register(grpcServer)

	go func() {
		<-ctx.Done()
		grpcServer.GracefulStop()
	}()
	return grpcServer.Serve(lis)
}
