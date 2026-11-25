//! Independent device_local model-result uplink and its server-signed delivery ack.
//!
//! Model results never enter the ACTION receipt sequence. The device-generated
//! `model_result_id` is the replay/idempotency identity; the signed body carries only
//! operation metadata and hashes, never model input/output content.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::jwk::EcP256Jwk;
use crate::key::DeviceKey;

pub const FRAME_TYPE: &str = "model_result";
pub const ACK_FRAME_TYPE: &str = "model_result_ack";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelUsage {
    #[serde(with = "u64string")]
    pub input_tokens: u64,
    #[serde(with = "u64string")]
    pub output_tokens: u64,
    #[serde(with = "u64string")]
    pub cached_input_tokens: u64,
    pub estimated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelResultBody {
    pub model_result_id: String,
    pub run_id: String,
    pub operation_id: String,
    pub attempt_id: String,
    pub request_hash: String,
    pub state: String,
    pub outcome: Option<String>,
    pub result_hash: Option<String>,
    pub provider_request_id: Option<String>,
    pub model: String,
    pub usage: Option<ModelUsage>,
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl ModelResultBody {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("model_result serializes")
    }

    pub fn sign(&mut self, key: &dyn DeviceKey) -> Result<(), sign::SignError> {
        let value = self.to_value();
        self.signature = Some(sign::sign_frame(key, FRAME_TYPE, &value)?);
        Ok(())
    }

    pub fn shape_consistent(&self) -> bool {
        let ids = [
            &self.model_result_id,
            &self.run_id,
            &self.operation_id,
            &self.attempt_id,
        ]
        .iter()
        .all(|value| uuid::Uuid::parse_str(value).is_ok());
        let hash = self.request_hash.len() == 64
            && self.request_hash.chars().all(|c| c.is_ascii_hexdigit());
        let result_hash = match &self.result_hash {
            Some(value) => value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()),
            None => true,
        };
        let terminal = match self.state.as_str() {
            "completed" => match self.outcome.as_deref() {
                Some("succeeded") => {
                    self.result_hash.is_some() && self.usage.is_some() && self.error_code.is_none()
                }
                Some("failed") => self.result_hash.is_none() && self.usage.is_none(),
                _ => false,
            },
            "unknown" => {
                self.outcome.is_none()
                    && self.usage.is_none()
                    && self.result_hash.is_none()
                    && self.provider_request_id.is_none()
                    && self.error_code.as_deref().is_some_and(|v| !v.is_empty())
            }
            _ => false,
        };
        let usage = self
            .usage
            .as_ref()
            .is_none_or(|usage| usage.cached_input_tokens <= usage.input_tokens);
        ids && hash && result_hash && terminal && usage && !self.model.trim().is_empty()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelResultAckBody {
    pub model_result_id: String,
    pub operation_id: String,
    pub state: String,
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl ModelResultAckBody {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("model_result_ack serializes")
    }

    pub fn verify(&self, jwk: &EcP256Jwk) -> bool {
        match &self.signature {
            Some(sig) => sign::verify_frame(jwk, ACK_FRAME_TYPE, &self.to_value(), sig),
            None => false,
        }
    }

    pub fn shape_consistent(&self) -> bool {
        uuid::Uuid::parse_str(&self.model_result_id).is_ok()
            && uuid::Uuid::parse_str(&self.operation_id).is_ok()
            && matches!(self.state.as_str(), "recorded" | "rejected")
            && (self.state != "rejected" || self.code.as_deref().is_some_and(|v| !v.is_empty()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SoftwareKey;

    fn result() -> ModelResultBody {
        ModelResultBody {
            model_result_id: "10000000-0000-0000-0000-000000000001".into(),
            run_id: "20000000-0000-0000-0000-000000000001".into(),
            operation_id: "30000000-0000-0000-0000-000000000001".into(),
            attempt_id: "40000000-0000-0000-0000-000000000001".into(),
            request_hash: "a".repeat(64),
            state: "completed".into(),
            outcome: Some("succeeded".into()),
            result_hash: Some("b".repeat(64)),
            provider_request_id: Some("req-1".into()),
            model: "fixture-model".into(),
            usage: Some(ModelUsage {
                input_tokens: 3,
                output_tokens: 2,
                cached_input_tokens: 1,
                estimated: false,
            }),
            error_code: None,
            signature: None,
        }
    }

    #[test]
    fn wire_is_closed_and_token_counts_are_decimal_strings() {
        let value = result().to_value();
        assert_eq!(value.as_object().unwrap().len(), 12);
        assert_eq!(value["usage"]["input_tokens"], "3");
        assert_eq!(value["usage"]["output_tokens"], "2");
        assert_eq!(value["usage"]["cached_input_tokens"], "1");
        assert!(value["result_hash"].is_string());
        assert!(value.get("signature").is_none());
        assert!(result().shape_consistent());
    }

    #[test]
    fn unknown_has_no_outcome_or_usage() {
        let mut body = result();
        body.state = "unknown".into();
        body.outcome = None;
        body.result_hash = None;
        body.provider_request_id = None;
        body.usage = None;
        body.error_code = Some("model_io_unknown".into());
        assert!(body.shape_consistent());
        body.usage = Some(ModelUsage {
            input_tokens: 0,
            output_tokens: 0,
            cached_input_tokens: 0,
            estimated: true,
        });
        assert!(!body.shape_consistent());
    }

    #[test]
    fn failed_and_usage_shapes_are_fail_closed() {
        let mut body = result();
        body.outcome = Some("failed".into());
        body.result_hash = None;
        body.provider_request_id = None;
        body.usage = None;
        body.error_code = Some("identity_mismatch".into());
        assert!(body.shape_consistent());
        body.usage = Some(ModelUsage {
            input_tokens: 0,
            output_tokens: 64,
            cached_input_tokens: 0,
            estimated: true,
        });
        assert!(!body.shape_consistent());

        let mut body = result();
        body.usage.as_mut().unwrap().cached_input_tokens = 4;
        assert!(!body.shape_consistent());
    }

    #[test]
    fn signature_is_type_bound_and_tamper_resistant() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut body = result();
        body.sign(&key).unwrap();
        let sig = body.signature.clone().unwrap();
        assert!(sign::verify_frame(&jwk, FRAME_TYPE, &body.to_value(), &sig));
        assert!(!sign::verify_frame(&jwk, "receipt", &body.to_value(), &sig));
        body.request_hash = "c".repeat(64);
        assert!(!sign::verify_frame(
            &jwk,
            FRAME_TYPE,
            &body.to_value(),
            &sig
        ));
    }

    #[test]
    fn ack_is_fail_closed_and_type_bound() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut ack = ModelResultAckBody {
            model_result_id: result().model_result_id,
            operation_id: result().operation_id,
            state: "recorded".into(),
            code: None,
            signature: None,
        };
        assert!(!ack.verify(&jwk));
        ack.signature = Some(sign::sign_frame(&key, ACK_FRAME_TYPE, &ack.to_value()).unwrap());
        assert!(ack.verify(&jwk));
        assert!(!sign::verify_frame(
            &jwk,
            "receipt_ack",
            &ack.to_value(),
            ack.signature.as_deref().unwrap()
        ));
    }
}
