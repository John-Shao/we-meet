//! GrantSuccessionProof signing domain for same-root workspace rebinds.

use serde_json::Value;

use crate::frame::sign::{sign_frame, verify_frame, SignError};
use crate::jwk::EcP256Jwk;
use crate::key::DeviceKey;

pub const TYPE: &str = "workspace_grant_succession";

pub fn sign(key: &dyn DeviceKey, proof: &Value) -> Result<String, SignError> {
    sign_frame(key, TYPE, proof)
}

pub fn verify(jwk: &EcP256Jwk, proof: &Value, signature_b64: &str) -> bool {
    verify_frame(jwk, TYPE, proof, signature_b64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SoftwareKey;
    use serde_json::json;

    const VECTOR_SIG: &str =
        "b9vTZKjSJSOZCPzj-5n-L0yLAtCyqGguvuQYpbJbvyrfvkHwHxuDF4YOWHNieIRTMcRkNHhN6pAnw2M01Ptj_g";

    #[test]
    fn matches_go_cross_language_vector() {
        let key = SoftwareKey::from_bytes(&[7; 32]).unwrap();
        let proof = json!({
            "old_grant_id": "11111111-1111-1111-1111-111111111111",
            "new_grant_id": "22222222-2222-2222-2222-222222222222",
            "root_identity_hash": "3333333333333333333333333333333333333333333333333333333333333333",
            "run_id": "44444444-4444-4444-4444-444444444444",
            "session_id": "55555555-5555-5555-5555-555555555555",
            "auth_plane": "bearer",
            "auth_epoch": "4",
            "nonce": "nonce-grant-succession-1",
            "expires_at": "2027-01-01T00:00:00Z"
        });
        let signature = sign(&key, &proof).unwrap();
        assert_eq!(signature, VECTOR_SIG);
        assert!(verify(&key.public_jwk(), &proof, &signature));
    }

    #[test]
    fn every_proof_field_is_covered() {
        let key = SoftwareKey::from_bytes(&[7; 32]).unwrap();
        let proof = json!({"session_id": "55555555-5555-5555-5555-555555555555"});
        let signature = sign(&key, &proof).unwrap();
        let tampered = json!({"session_id": "66666666-6666-6666-6666-666666666666"});
        assert!(!verify(&key.public_jwk(), &tampered, &signature));
        assert!(!crate::frame::sign::verify_frame(
            &key.public_jwk(),
            "action_prepare",
            &proof,
            &signature
        ));
    }
}
