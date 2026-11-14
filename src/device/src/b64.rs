//! base64url without padding (RFC 4648 §5). device-design §2.1 fixes this
//! encoding for JWK `x`/`y` and ES256 R||S signatures: no padding, never DER.

use base64ct::{Base64UrlUnpadded, Encoding};

/// Encode bytes as base64url with no `=` padding.
pub fn encode(bytes: &[u8]) -> String {
    Base64UrlUnpadded::encode_string(bytes)
}

/// Decode base64url text, rejecting padding and non-alphabet characters.
pub fn decode(text: &str) -> Result<Vec<u8>, base64ct::Error> {
    Base64UrlUnpadded::decode_vec(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vector_no_padding() {
        // RFC 4648 §10: "foobar" -> "Zm9vYmFy" (no padding needed here).
        assert_eq!(encode(b"foobar"), "Zm9vYmFy");
        // "f" -> "Zg" (would be "Zg==" with padding).
        assert_eq!(encode(b"f"), "Zg");
        assert!(!encode(b"f").contains('='));
    }

    #[test]
    fn round_trips_arbitrary_bytes() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        let text = encode(&bytes);
        assert_eq!(decode(&text).unwrap(), bytes);
    }

    #[test]
    fn rejects_padding() {
        assert!(decode("Zg==").is_err());
    }
}
