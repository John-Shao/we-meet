//! UserVersionProof signing domain for local artifact edits.

use serde_json::Value;

use crate::frame::sign::{sign_frame, verify_frame, SignError};
use crate::jwk::EcP256Jwk;
use crate::key::DeviceKey;

pub const TYPE: &str = "user_version_proof";

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
        "Aq4fF2MQHQ4b2PKBL1SAZuFm6WqXiozVU8eSlFpulHdvUOGGvCN8_eU8nnp5lQvakw8GryVIhTW5U8oLg9U8iQ";

    #[test]
    fn signs_and_verifies_the_closed_proof() {
        let key = SoftwareKey::from_bytes(&[7; 32]).unwrap();
        let proof = json!({
            "v":1,"org_id":"org","subject_id":"subject","auth_plane":"bearer",
            "auth_epoch":"4","device_id":"11111111-1111-4111-8111-111111111111",
            "session_id":"22222222-2222-4222-8222-222222222222",
            "task_id":"33333333-3333-4333-8333-333333333333",
            "artifact_id":"44444444-4444-4444-8444-444444444444",
            "base_version_no":1,"base_hash":"a".repeat(64),
            "version_id":"55555555-5555-4555-8555-555555555555",
            "format":"text/markdown","content_hash":"b".repeat(64),"bytes":512,
            "classification":"local_only","clipboard_derived":false,
            "clipboard_source_version_ids":[],"client_request_id":"save-0001",
            "nonce":"nonce-user-version-1","expires_at":"2027-01-01T00:00:00Z"
        });
        let signature = sign(&key, &proof).unwrap();
        assert_eq!(signature, VECTOR_SIG);
        assert!(verify(&key.public_jwk(), &proof, &signature));
        assert!(!verify(
            &key.public_jwk(),
            &proof,
            "b9vTZKjSJSOZCPzj-5n-L0yLAtCyqGguvuQYpbJbvyrfvkHwHxuDF4YOWHNieIRTMcRkNHhN6pAnw2M01Ptj_g"
        ));
    }
}
