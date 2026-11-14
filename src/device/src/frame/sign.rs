//! ES256-over-JCS frame signing (device-design §2.1/§3.1; m1a :658). The signed
//! document is `{schema_version, type, body}` with the body's own `signature`
//! field stripped (it is the output, not an input). The outer envelope transport
//! fields (message_id/session_id/sent_at/agent_instance_id/boot_id/
//! recovery_generation/device_id) are not signed — "当前外层 session 仅管传输".
//! The body carries each frame's historical execution identity and result, and
//! `type` + `schema_version` give domain separation (no cross-frame reuse).

use serde_json::{json, Value};

use crate::b64;
use crate::es256;
use crate::frame::envelope::SCHEMA_VERSION;
use crate::frame::jcs;
use crate::jwk::EcP256Jwk;
use crate::key::{DeviceKey, KeyError};

/// A frame-signing failure.
#[derive(Debug)]
pub enum SignError {
    Canonicalize,
    Key(KeyError),
}

impl From<KeyError> for SignError {
    fn from(err: KeyError) -> Self {
        Self::Key(err)
    }
}

/// Build the signed payload document: `{schema_version, type, body}` with the
/// body's `signature` field removed so the signature never covers itself.
pub fn signed_payload(frame_type: &str, body: &Value) -> Value {
    let mut body = body.clone();
    if let Some(obj) = body.as_object_mut() {
        obj.remove("signature");
    }
    json!({ "schema_version": SCHEMA_VERSION, "type": frame_type, "body": body })
}

/// Sign a frame body, returning the base64url ES256 R||S signature. The caller
/// places the result in the body's `signature` field.
pub fn sign_frame(
    key: &dyn DeviceKey,
    frame_type: &str,
    body: &Value,
) -> Result<String, SignError> {
    let payload = signed_payload(frame_type, body);
    let canonical = jcs::canonicalize(&payload).map_err(|_| SignError::Canonicalize)?;
    let signature = key.sign_es256(&canonical)?;
    Ok(b64::encode(&signature))
}

/// Verify a frame signature over `{schema_version, type, body}`. The body may
/// carry its `signature` field; it is stripped before reconstructing the payload.
pub fn verify_frame(jwk: &EcP256Jwk, frame_type: &str, body: &Value, signature_b64: &str) -> bool {
    let payload = signed_payload(frame_type, body);
    let Ok(canonical) = jcs::canonicalize(&payload) else {
        return false;
    };
    es256::verify(jwk, &canonical, signature_b64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SoftwareKey;

    #[test]
    fn round_trips_with_signature_in_body() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut body = json!({"state": "started", "operation_id": "op1"});
        let sig = sign_frame(&key, "receipt", &body).unwrap();
        body["signature"] = json!(sig);
        // Verification strips the signature field and still passes.
        assert!(verify_frame(&jwk, "receipt", &body, &sig));
    }

    #[test]
    fn tampered_body_fails() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let body = json!({"state": "started"});
        let sig = sign_frame(&key, "receipt", &body).unwrap();
        let tampered = json!({"state": "completed"});
        assert!(!verify_frame(&jwk, "receipt", &tampered, &sig));
    }

    #[test]
    fn type_is_domain_separated() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let body = json!({"x": 1});
        let sig = sign_frame(&key, "receipt", &body).unwrap();
        // The same body under a different frame type must not verify.
        assert!(!verify_frame(&jwk, "hello", &body, &sig));
    }

    #[test]
    fn signature_field_is_not_self_covered() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let body = json!({"x": 1});
        let sig = sign_frame(&key, "receipt", &body).unwrap();
        // Adding any signature value to the body does not change verification.
        let mut with_sig = body.clone();
        with_sig["signature"] = json!("ignored");
        assert!(verify_frame(&jwk, "receipt", &with_sig, &sig));
    }
}
