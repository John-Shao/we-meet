//! `device_key_thumbprint` (SQL 0040:82): SHA-256 hex of
//! `work-device-key-v1|{kty}|{crv}|{x}|{y}`. This is a pipe-delimited preimage,
//! NOT JCS — the agent reproduces the server value byte for byte without a
//! canonicalizer.

use crate::jwk::EcP256Jwk;
use crate::sha256_hex;

/// The domain prefix baked into the thumbprint preimage (SQL 0040:82).
pub const THUMBPRINT_DOMAIN: &str = "work-device-key-v1";

/// Compute the 64-hex-char thumbprint of a public JWK.
pub fn device_key_thumbprint(jwk: &EcP256Jwk) -> String {
    let preimage = format!(
        "{THUMBPRINT_DOMAIN}|{}|{}|{}|{}",
        jwk.kty, jwk.crv, jwk.x, jwk.y
    );
    sha256_hex(preimage.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_independent_preimage_hash() {
        let jwk = EcP256Jwk::from_coords(&[1u8; 32], &[2u8; 32]);
        let preimage = format!("work-device-key-v1|EC|P-256|{}|{}", jwk.x, jwk.y);
        assert_eq!(device_key_thumbprint(&jwk), sha256_hex(preimage.as_bytes()));
        assert_eq!(device_key_thumbprint(&jwk).len(), 64);
    }

    #[test]
    fn changes_with_coordinate() {
        let a = device_key_thumbprint(&EcP256Jwk::from_coords(&[1u8; 32], &[2u8; 32]));
        let b = device_key_thumbprint(&EcP256Jwk::from_coords(&[1u8; 32], &[3u8; 32]));
        assert_ne!(a, b);
    }
}
