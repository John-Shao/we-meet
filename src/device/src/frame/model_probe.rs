//! Closed device model-probe receipt signed under the `model_probe` domain.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::key::DeviceKey;

pub const FRAME_TYPE: &str = "model_probe";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelProbeReceipt {
    pub v: u32,
    pub org_id: String,
    pub subject_id: String,
    #[serde(with = "u64string")]
    pub auth_epoch: u64,
    pub device_id: String,
    pub session_id: String,
    pub binding_id: String,
    pub probe_id: String,
    pub preview_hash: String,
    pub receipt_hash: String,
    pub receipt_ref: String,
    pub state: String,
    pub nonce: String,
    pub expires_at: String,
}

impl ModelProbeReceipt {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("model_probe receipt serializes")
    }

    pub fn signature_for(&self, key: &dyn DeviceKey) -> Result<String, sign::SignError> {
        if !self.shape_consistent() {
            return Err(sign::SignError::InvalidProof);
        }
        sign::sign_frame(key, FRAME_TYPE, &self.to_value())
    }

    pub fn shape_consistent(&self) -> bool {
        let digest = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        let uuid = |value: &str| uuid::Uuid::parse_str(value).is_ok();
        let state_ok = match self.state.as_str() {
            "running" => true,
            "verified" => digest(&self.receipt_hash) && !self.receipt_ref.is_empty(),
            "failed" | "reconcile" => !self.receipt_ref.is_empty(),
            _ => false,
        };
        self.v == 1
            && !self.org_id.trim().is_empty()
            && !self.subject_id.trim().is_empty()
            && uuid(&self.device_id)
            && uuid(&self.session_id)
            && uuid(&self.binding_id)
            && uuid(&self.probe_id)
            && digest(&self.preview_hash)
            && (self.receipt_hash.is_empty() || digest(&self.receipt_hash))
            && state_ok
            && (8..=128).contains(&self.nonce.len())
            && self
                .nonce
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            && crate::frame::rfc3339::parse_utc_seconds(&self.expires_at).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SoftwareKey;

    fn receipt() -> ModelProbeReceipt {
        ModelProbeReceipt {
            v: 1,
            org_id: "org".into(),
            subject_id: "subject".into(),
            auth_epoch: 7,
            device_id: "11111111-1111-4111-8111-111111111111".into(),
            session_id: "22222222-2222-4222-8222-222222222222".into(),
            binding_id: "33333333-3333-4333-8333-333333333333".into(),
            probe_id: "44444444-4444-4444-8444-444444444444".into(),
            preview_hash: "a".repeat(64),
            receipt_hash: "b".repeat(64),
            receipt_ref: "model_result:55555555-5555-4555-8555-555555555555".into(),
            state: "verified".into(),
            nonce: "nonce-probe-1".into(),
            expires_at: "2027-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn wire_is_closed_and_auth_epoch_is_a_decimal_string() {
        let value = receipt().to_value();
        assert_eq!(value.as_object().unwrap().len(), 14);
        assert_eq!(value["auth_epoch"], "7");
        assert!(receipt().shape_consistent());
    }

    #[test]
    fn state_shapes_are_fail_closed() {
        let mut failed = receipt();
        failed.state = "failed".into();
        failed.receipt_hash.clear();
        assert!(failed.shape_consistent());
        failed.receipt_ref.clear();
        assert!(!failed.shape_consistent());

        let mut unverified = receipt();
        unverified.receipt_hash.clear();
        assert!(!unverified.shape_consistent());
    }

    #[test]
    fn signature_is_domain_bound_and_tamper_resistant() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut body = receipt();
        let signature = body.signature_for(&key).unwrap();
        assert!(sign::verify_frame(
            &jwk,
            FRAME_TYPE,
            &body.to_value(),
            &signature
        ));
        assert!(!sign::verify_frame(
            &jwk,
            "model_result",
            &body.to_value(),
            &signature
        ));
        body.preview_hash = "c".repeat(64);
        assert!(!sign::verify_frame(
            &jwk,
            FRAME_TYPE,
            &body.to_value(),
            &signature
        ));
    }
}
