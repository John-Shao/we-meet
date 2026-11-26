//! ApprovalDecisionProof signing domain for local approval decisions.

use serde_json::Value;

use crate::frame::sign::{sign_frame, verify_frame, SignError};
use crate::jwk::EcP256Jwk;
use crate::key::DeviceKey;

pub const TYPE: &str = "approval_decision_proof";

pub struct ApprovalDecisionInput {
    pub org_id: String,
    pub subject_id: String,
    pub auth_epoch: String,
    pub device_id: String,
    pub session_id: String,
    pub approval_id: String,
    pub operation_id: String,
    pub params_hash: String,
    pub expected_revision: String,
    pub decision: String,
    pub remember_readonly: bool,
    pub readonly_scope: Option<Value>,
    pub readonly_expires_at: Option<String>,
    pub policy_epoch: String,
    pub access_epoch: String,
}

fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_uint(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
        && value.parse::<u64>().is_ok()
}

pub fn produce(key: &dyn DeviceKey, input: ApprovalDecisionInput) -> Result<Value, SignError> {
    if input.org_id.is_empty()
        || input.subject_id.is_empty()
        || !valid_uuid(&input.device_id)
        || !valid_uuid(&input.session_id)
        || !valid_uuid(&input.approval_id)
        || !valid_uuid(&input.operation_id)
        || !valid_digest(&input.params_hash)
        || !valid_uint(&input.expected_revision)
        || !valid_uint(&input.auth_epoch)
        || !valid_uint(&input.policy_epoch)
        || !valid_uint(&input.access_epoch)
        || !matches!(input.decision.as_str(), "approved" | "rejected")
        || (input.decision == "rejected" && input.remember_readonly)
    {
        return Err(SignError::InvalidProof);
    }
    if !input.remember_readonly {
        if input.readonly_scope.is_some() || input.readonly_expires_at.is_some() {
            return Err(SignError::InvalidProof);
        }
    } else {
        let Some(scope) = input.readonly_scope.as_ref() else {
            return Err(SignError::InvalidProof);
        };
        let Some(expiry) = input.readonly_expires_at.as_deref() else {
            return Err(SignError::InvalidProof);
        };
        if crate::frame::rfc3339::parse_utc_seconds(expiry).is_none() {
            return Err(SignError::InvalidProof);
        }
        let object = scope.as_object().ok_or(SignError::InvalidProof)?;
        if object.len() != 4
            || !valid_digest(
                object["resource_selector_hash"]
                    .as_str()
                    .ok_or(SignError::InvalidProof)?,
            )
            || !valid_uuid(object["grant_id"].as_str().ok_or(SignError::InvalidProof)?)
            || !valid_uint(
                object["grant_revision"]
                    .as_str()
                    .ok_or(SignError::InvalidProof)?,
            )
        {
            return Err(SignError::InvalidProof);
        }
        let tools = object["tool_set"]
            .as_array()
            .ok_or(SignError::InvalidProof)?;
        if tools.is_empty()
            || !tools.iter().all(|tool| {
                matches!(
                    tool.as_str(),
                    Some("workspace.list" | "workspace.read" | "workspace.search")
                )
            })
        {
            return Err(SignError::InvalidProof);
        }
    }
    let expires_at = std::time::SystemTime::now()
        .checked_add(std::time::Duration::from_secs(60))
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|value| crate::frame::rfc3339::format_utc_seconds(value.as_secs()))
        .ok_or(SignError::InvalidProof)?;
    let mut proof = serde_json::json!({
        "v": 1,
        "org_id": input.org_id,
        "subject_id": input.subject_id,
        "auth_plane": "bearer",
        "auth_epoch": input.auth_epoch,
        "device_id": input.device_id,
        "session_id": input.session_id,
        "approval_id": input.approval_id,
        "operation_id": input.operation_id,
        "params_hash": input.params_hash,
        "expected_revision": input.expected_revision,
        "decision": input.decision,
        "remember_readonly": input.remember_readonly,
        "readonly_scope": input.readonly_scope,
        "readonly_expires_at": input.readonly_expires_at,
        "policy_epoch": input.policy_epoch,
        "access_epoch": input.access_epoch,
        "nonce": uuid::Uuid::new_v4().simple().to_string(),
        "expires_at": expires_at,
    });
    let signature = sign(key, &proof)?;
    proof["signature"] = Value::String(signature);
    Ok(proof)
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

    const VECTOR_SIG: &str =
        "pZ3THZfVcUPucJVzDulxbMSDUfJe2cdnlJjM6VAGUnW45JaMf7gz_BmvlRQ-FPMsRWPUdKvzwHjYlhct_Wmovg";

    #[test]
    fn produces_the_closed_signed_decision() {
        let key = SoftwareKey::from_bytes(&[7; 32]).unwrap();
        let input = ApprovalDecisionInput {
            org_id: "org".into(),
            subject_id: "subject".into(),
            auth_epoch: "4".into(),
            device_id: "11111111-1111-4111-8111-111111111111".into(),
            session_id: "22222222-2222-4222-8222-222222222222".into(),
            approval_id: "33333333-3333-4333-8333-333333333333".into(),
            operation_id: "44444444-4444-4444-8444-444444444444".into(),
            params_hash: "a".repeat(64),
            expected_revision: "0".into(),
            decision: "approved".into(),
            remember_readonly: false,
            readonly_scope: None,
            readonly_expires_at: None,
            policy_epoch: "0".into(),
            access_epoch: "0".into(),
        };
        let proof = produce(&key, input).unwrap();
        assert_eq!(proof.as_object().unwrap().len(), 20);
        assert_eq!(proof["signature"].as_str().unwrap().len(), 86);
        assert!(verify(
            &key.public_jwk(),
            &proof,
            proof["signature"].as_str().unwrap()
        ));
        let invalid = ApprovalDecisionInput {
            decision: "rejected".into(),
            remember_readonly: true,
            readonly_scope: Some(json!({
                "tool_set": ["workspace.read"],
                "resource_selector_hash": "b".repeat(64),
                "grant_id": "55555555-5555-4555-8555-555555555555",
                "grant_revision": "1",
            })),
            readonly_expires_at: Some("2027-01-01T00:00:00Z".into()),
            ..ApprovalDecisionInput {
                org_id: "org".into(),
                subject_id: "subject".into(),
                auth_epoch: "4".into(),
                device_id: "11111111-1111-4111-8111-111111111111".into(),
                session_id: "22222222-2222-4222-8222-222222222222".into(),
                approval_id: "33333333-3333-4333-8333-333333333333".into(),
                operation_id: "44444444-4444-4444-8444-444444444444".into(),
                params_hash: "a".repeat(64),
                expected_revision: "0".into(),
                decision: "approved".into(),
                remember_readonly: false,
                readonly_scope: None,
                readonly_expires_at: None,
                policy_epoch: "0".into(),
                access_epoch: "0".into(),
            }
        };
        assert!(matches!(
            produce(&key, invalid),
            Err(SignError::InvalidProof)
        ));
    }

    #[test]
    fn signs_and_verifies_the_closed_proof() {
        let key = SoftwareKey::from_bytes(&[7; 32]).unwrap();
        let proof = json!({
            "v":1,"org_id":"org","subject_id":"subject","auth_plane":"bearer",
            "auth_epoch":"4","device_id":"11111111-1111-4111-8111-111111111111",
            "session_id":"22222222-2222-4222-8222-222222222222",
            "approval_id":"33333333-3333-4333-8333-333333333333",
            "operation_id":"44444444-4444-4444-8444-444444444444",
            "params_hash":"a".repeat(64),"expected_revision":"0","decision":"approved",
            "remember_readonly":false,"readonly_scope":null,"readonly_expires_at":null,
            "policy_epoch":"0","access_epoch":"0","nonce":"nonce-approval-1",
            "expires_at":"2027-01-01T00:00:00Z"
        });
        let signature = sign(&key, &proof).unwrap();
        assert_eq!(signature, VECTOR_SIG);
        assert!(verify(&key.public_jwk(), &proof, &signature));
        let mut changed = proof.clone();
        changed["decision"] = json!("rejected");
        assert!(!verify(&key.public_jwk(), &changed, &signature));
    }
}
