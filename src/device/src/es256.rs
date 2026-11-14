//! ES256 verification (ECDSA P-256 + SHA-256), fixed 64-byte R||S carried as
//! base64url with no padding (device-design §2.1). DER is never accepted. Signing
//! lives behind [`crate::key::DeviceKey`] (CNG on Windows, p256 in tests).

use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};

use crate::b64;
use crate::jwk::EcP256Jwk;

/// Fixed R||S length for P-256 (32-byte R, 32-byte S).
pub const SIGNATURE_LEN: usize = 64;

/// Verify an ES256 signature over `msg`. Returns false on any malformed input
/// rather than panicking; the caller treats false as a failed proof.
pub fn verify(jwk: &EcP256Jwk, msg: &[u8], signature_b64url: &str) -> bool {
    let Ok(bytes) = b64::decode(signature_b64url) else {
        return false;
    };
    if bytes.len() != SIGNATURE_LEN {
        return false;
    }
    let Ok(point) = jwk.to_encoded_point() else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_sec1_bytes(&point) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&bytes) else {
        return false;
    };
    key.verify(msg, &signature).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::{DeviceKey, SoftwareKey};

    #[test]
    fn round_trips_software_signature() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let msg = b"work-device-pair-v2|example";
        let sig = key.sign_es256(msg).unwrap();
        assert!(verify(&jwk, msg, &b64::encode(&sig)));
    }

    #[test]
    fn rejects_tampered_message() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let sig = key.sign_es256(b"original").unwrap();
        assert!(!verify(&jwk, b"tampered", &b64::encode(&sig)));
    }

    #[test]
    fn rejects_wrong_key() {
        let signer = SoftwareKey::random();
        let other = SoftwareKey::random();
        let sig = signer.sign_es256(b"msg").unwrap();
        assert!(!verify(&other.public_jwk(), b"msg", &b64::encode(&sig)));
    }

    #[test]
    fn rejects_malformed_signature() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        assert!(!verify(&jwk, b"msg", "not-base64!!"));
        assert!(!verify(&jwk, b"msg", &b64::encode(&[0u8; 63])));
        assert!(!verify(&jwk, b"msg", &b64::encode(&[0u8; 65])));
    }
}
