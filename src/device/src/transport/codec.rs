//! The v2 device wire codec (device-design §3.1). One Connect stream message is exactly one
//! closed frame envelope carried as raw JCS-signed JSON bytes. The Go gateway's `frameCodec`
//! (`src/work/internal/gateway/codec.go`) passes `[]byte` through unchanged, so this side passes
//! `Bytes` through unchanged: tonic adds and strips the 5-byte gRPC length prefix, and nothing
//! here re-wraps the frame in protobuf (the v1 proto is reference only, §3:81).
//!
//! The content-subtype stays tonic's default `application/grpc` rather than the gateway's
//! `work-device-frame`: grpc-go's `Server.getCodec` returns the forced server codec whenever one
//! is set, so `grpc.ForceServerCodec(FrameCodec())` ignores the subtype the client announces
//! (`cmd/work-gateway/main.go`). tonic does not validate the response subtype either.
//!
//! The §3.1 64KiB per-frame ceiling is enforced in BOTH directions — an oversize uplink is
//! refused before it reaches the wire, and an oversize downlink is refused rather than buffered.

use bytes::{Buf, BufMut, Bytes};
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::Status;

/// The §3.1 per-frame ceiling: 64KiB.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;

/// The raw-frame codec. Both directions carry [`Bytes`].
#[derive(Clone, Copy, Debug, Default)]
pub struct FrameCodec;

/// Passes one frame's bytes to tonic, which adds the length prefix.
#[derive(Debug)]
pub struct FrameEncoder;

/// Takes one frame's bytes from tonic, which has already stripped the length prefix.
#[derive(Debug)]
pub struct FrameDecoder;

impl Codec for FrameCodec {
    type Encode = Bytes;
    type Decode = Bytes;
    type Encoder = FrameEncoder;
    type Decoder = FrameDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        FrameEncoder
    }

    fn decoder(&mut self) -> Self::Decoder {
        FrameDecoder
    }
}

impl Encoder for FrameEncoder {
    type Item = Bytes;
    type Error = Status;

    fn encode(&mut self, item: Bytes, dst: &mut EncodeBuf<'_>) -> Result<(), Status> {
        if item.len() > MAX_FRAME_BYTES {
            return Err(Status::resource_exhausted("frame exceeds 64KiB"));
        }
        dst.put_slice(&item);
        Ok(())
    }
}

impl Decoder for FrameDecoder {
    type Item = Bytes;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Bytes>, Status> {
        let len = src.remaining();
        if len > MAX_FRAME_BYTES {
            return Err(Status::resource_exhausted("frame exceeds 64KiB"));
        }
        // Always Some: tonic guarantees the buffer holds exactly one complete message, and
        // None means "not enough bytes yet". Returning None for a zero-length message would
        // stall the stream waiting for bytes that will never come. A zero-length payload is
        // not a valid §3.1 envelope, but that judgment belongs to the envelope parser, not here.
        Ok(Some(src.copy_to_bytes(len)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::{BodyExt, Full};
    use tonic::codec::{EncodeBody, Streaming};
    use tonic::codegen::tokio_stream;

    /// Encode one frame through tonic's own framing and return the bytes it would put on the
    /// wire, so the test asserts the real 5-byte prefix rather than a hand-rolled one.
    // Status is 176 bytes, so the helpers box it (clippy::result_large_err); the codec trait
    // itself mandates Error = Status and is exempt.
    async fn wire_bytes(payload: Bytes) -> Result<Bytes, Box<Status>> {
        let body = EncodeBody::new_client(
            FrameEncoder,
            tokio_stream::iter(vec![Ok(payload)]),
            None,
            None,
        );
        Ok(body.collect().await.map_err(Box::new)?.to_bytes())
    }

    /// Decode a length-prefixed message through tonic's own streaming decoder.
    async fn decode_wire(wire: Bytes) -> Result<Option<Bytes>, Box<Status>> {
        let mut stream = Streaming::new_empty(FrameDecoder, Full::new(wire));
        stream.message().await.map_err(Box::new)
    }

    fn prefixed(payload: &[u8]) -> Vec<u8> {
        let mut wire = vec![0u8];
        wire.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        wire.extend_from_slice(payload);
        wire
    }

    #[tokio::test]
    async fn round_trips_a_frame_through_grpc_framing() {
        let payload = Bytes::from_static(br#"{"schema_version":2,"type":"hello"}"#);
        let wire = wire_bytes(payload.clone()).await.unwrap();
        assert_eq!(&wire[..], &prefixed(&payload)[..]);
        assert_eq!(decode_wire(wire).await.unwrap(), Some(payload));
    }

    #[tokio::test]
    async fn round_trips_several_frames_in_one_body() {
        let frames = vec![
            Bytes::from_static(b"first"),
            Bytes::from_static(b"second"),
            Bytes::from_static(b""),
        ];
        let body = EncodeBody::new_client(
            FrameEncoder,
            tokio_stream::iter(frames.clone().into_iter().map(Ok)),
            None,
            None,
        );
        let wire = body.collect().await.unwrap().to_bytes();
        let mut stream = Streaming::new_empty(FrameDecoder, Full::new(wire));
        // An empty frame decodes as Some(empty), not as end-of-stream: the codec must not
        // confuse a zero-length message with the trailers-only end of a response.
        for expected in frames {
            assert_eq!(stream.message().await.unwrap(), Some(expected));
        }
        assert_eq!(stream.message().await.unwrap(), None);
    }

    #[tokio::test]
    async fn refuses_an_oversize_uplink_before_it_reaches_the_wire() {
        let payload = Bytes::from(vec![b'x'; MAX_FRAME_BYTES + 1]);
        let err = wire_bytes(payload).await.unwrap_err();
        // tonic wraps EVERY encoder error as Internal ("Error encoding: …", codec/encode.rs),
        // so the code is tonic's; the message proves it was this codec's 64KiB refusal and not
        // some other failure, and collect() yielding Err means no frame reached the wire.
        assert_eq!(err.code(), tonic::Code::Internal);
        assert!(err.message().contains("64KiB"), "{}", err.message());
    }

    #[tokio::test]
    async fn accepts_a_frame_at_exactly_the_ceiling() {
        let payload = Bytes::from(vec![b'x'; MAX_FRAME_BYTES]);
        let wire = wire_bytes(payload.clone()).await.unwrap();
        assert_eq!(decode_wire(wire).await.unwrap(), Some(payload));
    }

    #[tokio::test]
    async fn refuses_an_oversize_downlink() {
        let wire = prefixed(&vec![b'x'; MAX_FRAME_BYTES + 1]);
        let err = decode_wire(Bytes::from(wire)).await.unwrap_err();
        assert_eq!(err.code(), tonic::Code::ResourceExhausted);
    }

    #[tokio::test]
    async fn an_empty_body_is_end_of_stream_not_an_empty_frame() {
        assert_eq!(decode_wire(Bytes::new()).await.unwrap(), None);
    }

    #[test]
    fn codec_is_send_and_static() {
        fn assert_send<T: Send + 'static>() {}
        assert_send::<FrameCodec>();
        assert_send::<FrameEncoder>();
        assert_send::<FrameDecoder>();
    }
}
