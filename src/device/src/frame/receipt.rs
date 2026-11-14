//! The receipt body (device-design §3.1 receipt row). The signature covers all
//! historical execution identity (`original_execution`) and the result; the
//! current outer session is transport-only (m1a :658). `state` is
//! started/completed/unknown; completed carries succeeded/failed/
//! rejected_not_executed via `error_code`/result. The signed bytes produced here
//! are what `receipt_outbox` stores (batch 2).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::key::DeviceKey;

/// The receipt frame type tag.
pub const FRAME_TYPE: &str = "receipt";

/// The historical execution identity bound into the receipt signature. These are
/// the identity facts at execution time, not the current transport session.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OriginalExecution {
    pub org: String,
    pub subject: String,
    pub device: String,
    pub session: String,
    pub agent_instance: String,
    pub boot: String,
    #[serde(with = "u64string")]
    pub generation: u64,
    pub run: String,
    pub operation: String,
    #[serde(with = "u64string")]
    pub attempt: u64,
    #[serde(with = "u64string")]
    pub fence: u64,
}

/// The receipt body (device-design §3.1 receipt row).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReceiptBody {
    pub journal_epoch: String,
    #[serde(with = "u64string")]
    pub receipt_seq: u64,
    pub original_execution: OriginalExecution,
    pub request_hash: String,
    pub state: String,
    pub result_hash: String,
    pub local_result_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_receipt_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_delivery: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_source: Option<String>,
    pub error_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl ReceiptBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("receipt serializes")
    }

    /// Sign the body and set its `signature` field.
    pub fn sign(&mut self, key: &dyn DeviceKey) -> Result<(), sign::SignError> {
        let value = self.to_value();
        self.signature = Some(sign::sign_frame(key, FRAME_TYPE, &value)?);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::sign::verify_frame;
    use crate::key::SoftwareKey;

    fn sample() -> ReceiptBody {
        ReceiptBody {
            journal_epoch: "epoch".into(),
            receipt_seq: 1,
            original_execution: OriginalExecution {
                org: "org".into(),
                subject: "sub".into(),
                device: "dev".into(),
                session: "sess".into(),
                agent_instance: "agent".into(),
                boot: "boot".into(),
                generation: 1,
                run: "run".into(),
                operation: "op".into(),
                attempt: 1,
                fence: 1,
            },
            request_hash: "hash".into(),
            state: "completed".into(),
            result_hash: "result".into(),
            local_result_ref: "ref".into(),
            gateway_receipt_hash: None,
            model_delivery: None,
            usage: None,
            usage_source: None,
            error_code: String::new(),
            signature: None,
        }
    }

    #[test]
    fn uint64_fields_are_decimal_strings() {
        let value = sample().to_value();
        assert_eq!(value["receipt_seq"], "1");
        assert_eq!(value["original_execution"]["fence"], "1");
        assert_eq!(value["original_execution"]["generation"], "1");
    }

    #[test]
    fn sign_covers_historical_identity_and_result() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut receipt = sample();
        receipt.sign(&key).unwrap();
        let sig = receipt.signature.clone().unwrap();
        assert!(verify_frame(&jwk, FRAME_TYPE, &receipt.to_value(), &sig));
        // Tampering with the historical fence invalidates the signature.
        receipt.original_execution.fence = 2;
        assert!(!verify_frame(&jwk, FRAME_TYPE, &receipt.to_value(), &sig));
        // Tampering with the result invalidates it too.
        let mut receipt2 = sample();
        receipt2.sign(&key).unwrap();
        let sig2 = receipt2.signature.clone().unwrap();
        receipt2.result_hash = "other".into();
        assert!(!verify_frame(&jwk, FRAME_TYPE, &receipt2.to_value(), &sig2));
    }

    #[test]
    fn optional_org_remote_fields_omitted_when_none() {
        let value = sample().to_value();
        assert!(value.get("gateway_receipt_hash").is_none());
        assert!(value.get("model_delivery").is_none());
        assert!(value.get("usage").is_none());
    }
}
