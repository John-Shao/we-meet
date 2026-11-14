//! Length-prefixed message framing (device-design §3 :105: single frame ≤ 64KiB).
//! Each frame is a 4-byte big-endian length followed by that many payload bytes.
//! Oversized frames are refused before allocation; data is never dropped under
//! backpressure (the transport pauses instead).

/// Maximum single-frame payload (device-design §3 :105: 64KiB).
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
/// The length prefix size.
pub const LENGTH_PREFIX: usize = 4;

/// A framing failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameError {
    TooLarge,
    Incomplete,
}

/// Encode a payload into a length-prefixed frame.
pub fn encode(payload: &[u8]) -> Result<Vec<u8>, FrameError> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    let mut out = Vec::with_capacity(LENGTH_PREFIX + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// Decode the payload of a complete frame held in `buf`. Returns the payload
/// slice; refuses an oversized length before reading and reports incomplete
/// buffers without consuming them.
pub fn decode(buf: &[u8]) -> Result<&[u8], FrameError> {
    if buf.len() < LENGTH_PREFIX {
        return Err(FrameError::Incomplete);
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    if buf.len() < LENGTH_PREFIX + len {
        return Err(FrameError::Incomplete);
    }
    Ok(&buf[LENGTH_PREFIX..LENGTH_PREFIX + len])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let frame = encode(b"hello broker").unwrap();
        assert_eq!(decode(&frame).unwrap(), b"hello broker");
    }

    #[test]
    fn length_prefix_is_big_endian() {
        let frame = encode(b"abc").unwrap();
        assert_eq!(&frame[..4], &[0, 0, 0, 3]);
    }

    #[test]
    fn max_size_accepted() {
        let payload = vec![0u8; MAX_FRAME_BYTES];
        let frame = encode(&payload).unwrap();
        assert_eq!(decode(&frame).unwrap().len(), MAX_FRAME_BYTES);
    }

    #[test]
    fn oversized_encode_rejected() {
        let payload = vec![0u8; MAX_FRAME_BYTES + 1];
        assert_eq!(encode(&payload), Err(FrameError::TooLarge));
    }

    #[test]
    fn oversized_length_rejected_before_read() {
        // A claimed length above the limit is refused even with no payload.
        let buf = (MAX_FRAME_BYTES as u32 + 1).to_be_bytes();
        assert_eq!(decode(&buf), Err(FrameError::TooLarge));
    }

    #[test]
    fn incomplete_buffer_reported() {
        assert_eq!(decode(&[0, 0]), Err(FrameError::Incomplete));
        let frame = encode(b"abc").unwrap();
        assert_eq!(decode(&frame[..5]), Err(FrameError::Incomplete));
    }

    #[test]
    fn empty_payload_round_trips() {
        let frame = encode(b"").unwrap();
        assert_eq!(decode(&frame).unwrap(), b"");
    }
}
