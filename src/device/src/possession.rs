//! PossessionProof signing domain for local artifact acceptance.

use serde_json::Value;

use crate::frame::sign::{sign_frame, verify_frame, SignError};
use crate::jwk::EcP256Jwk;
use crate::key::DeviceKey;

pub const TYPE: &str = "possession_proof";

pub struct PossessionInput {
    pub org_id: String,
    pub subject_id: String,
    pub auth_epoch: String,
    pub device_id: String,
    pub session_id: String,
    pub task_id: String,
    pub artifact_id: String,
    pub version_id: String,
    pub content_hash: String,
    pub request_id: String,
}

fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_uint(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
        && value.parse::<u64>().is_ok()
}

pub fn produce(key: &dyn DeviceKey, input: PossessionInput) -> Result<Value, SignError> {
    if input.org_id.is_empty()
        || input.subject_id.is_empty()
        || !valid_uint(&input.auth_epoch)
        || !valid_uuid(&input.device_id)
        || !valid_uuid(&input.session_id)
        || !valid_uuid(&input.task_id)
        || !valid_uuid(&input.artifact_id)
        || !valid_uuid(&input.version_id)
        || !valid_digest(&input.content_hash)
        || input.request_id.is_empty()
        || input.request_id.len() > 128
        || input
            .request_id
            .chars()
            .any(|ch| ch < '\u{20}' || ch == '\u{7f}')
    {
        return Err(SignError::InvalidProof);
    }
    let expires_at = std::time::SystemTime::now()
        .checked_add(std::time::Duration::from_secs(30))
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|value| crate::frame::rfc3339::format_utc_seconds(value.as_secs()))
        .ok_or(SignError::InvalidProof)?;
    let proof = serde_json::json!({
        "v": 1,
        "org_id": input.org_id,
        "subject_id": input.subject_id,
        "auth_plane": "bearer",
        "auth_epoch": input.auth_epoch,
        "device_id": input.device_id,
        "session_id": input.session_id,
        "task_id": input.task_id,
        "artifact_id": input.artifact_id,
        "version_id": input.version_id,
        "content_hash": input.content_hash,
        "purpose": "accept",
        "request_id": input.request_id,
        "nonce": uuid::Uuid::new_v4().simple().to_string(),
        "expires_at": expires_at,
    });
    let signature = sign(key, &proof)?;
    Ok(serde_json::json!({ "proof": proof, "signature": signature }))
}

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

    #[test]
    fn produces_and_verifies_the_closed_acceptance_proof() {
        let key = SoftwareKey::from_bytes(&[7; 32]).unwrap();
        let signed = produce(
            &key,
            PossessionInput {
                org_id: "org".into(),
                subject_id: "subject".into(),
                auth_epoch: "4".into(),
                device_id: "11111111-1111-4111-8111-111111111111".into(),
                session_id: "22222222-2222-4222-8222-222222222222".into(),
                task_id: "33333333-3333-4333-8333-333333333333".into(),
                artifact_id: "44444444-4444-4444-8444-444444444444".into(),
                version_id: "55555555-5555-4555-8555-555555555555".into(),
                content_hash: "a".repeat(64),
                request_id: "accept-1".into(),
            },
        )
        .unwrap();
        let proof = signed["proof"].as_object().unwrap();
        assert_eq!(proof.len(), 15);
        assert_eq!(proof["purpose"], "accept");
        assert!(proof.get("signature").is_none());
        assert!(verify(
            &key.public_jwk(),
            &signed["proof"],
            signed["signature"].as_str().unwrap()
        ));
        let mut changed = signed["proof"].clone();
        changed["request_id"] = json!("accept-2");
        assert!(!verify(
            &key.public_jwk(),
            &changed,
            signed["signature"].as_str().unwrap()
        ));
    }

    #[test]
    fn refuses_non_accept_shapes() {
        let key = SoftwareKey::from_bytes(&[7; 32]).unwrap();
        let input = PossessionInput {
            org_id: "org".into(),
            subject_id: "subject".into(),
            auth_epoch: "04".into(),
            device_id: "11111111-1111-4111-8111-111111111111".into(),
            session_id: "22222222-2222-4222-8222-222222222222".into(),
            task_id: "33333333-3333-4333-8333-333333333333".into(),
            artifact_id: "44444444-4444-4444-8444-444444444444".into(),
            version_id: "55555555-5555-4555-8555-555555555555".into(),
            content_hash: "A".repeat(64),
            request_id: "accept-1".into(),
        };
        assert!(matches!(produce(&key, input), Err(SignError::InvalidProof)));
    }
}
