package gateway

import (
	"fmt"

	"google.golang.org/grpc/encoding"
)

// CodecName is the gRPC content-subtype for the v2 device wire. Each Connect
// stream message is one closed frame envelope (device-design §3.1) carried as raw
// JCS-signed JSON bytes — there is no proto-native message wrapping the frame, so
// the gateway verifies the signature with internal/devicesig directly. The frozen
// v1 proto is reference only (device-design §3:81); v2 is defined by this wire.
const CodecName = "work-device-frame"

// frameCodec passes the raw frame bytes through gRPC unchanged. gRPC handles the
// HTTP/2 length-prefixed framing; the payload of each message is exactly one JSON
// envelope.
type frameCodec struct{}

func (frameCodec) Marshal(v any) ([]byte, error) {
	b, ok := v.([]byte)
	if !ok {
		return nil, fmt.Errorf("gateway: frame codec marshal expects []byte, got %T", v)
	}
	return b, nil
}

func (frameCodec) Unmarshal(data []byte, v any) error {
	p, ok := v.(*[]byte)
	if !ok {
		return fmt.Errorf("gateway: frame codec unmarshal expects *[]byte, got %T", v)
	}
	*p = append((*p)[:0], data...)
	return nil
}

func (frameCodec) Name() string { return CodecName }

func init() { encoding.RegisterCodec(frameCodec{}) }

// FrameCodec exposes the codec for client dial options (grpc.ForceCodec).
func FrameCodec() encoding.Codec { return frameCodec{} }
