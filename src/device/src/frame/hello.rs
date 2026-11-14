//! The hello frame body (device-design §3.1). `session_id` is empty in the
//! request and assigned by `hello_ack`; the ticket/challenge_response handshake
//! completes with the gateway batch — the fields are carried and signed here.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::key::DeviceKey;

/// The hello frame type tag.
pub const FRAME_TYPE: &str = "hello";

/// The hello request body (device-design §3.1 hello/hello_ack row).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HelloBody {
    pub client_version: String,
    pub protocol_major: u32,
    pub protocol_minor: u32,
    pub required_features: Vec<String>,
    pub tool_manifest_hash: String,
    pub runtime_digest: String,
    pub profile_id: String,
    pub journal_epoch: String,
    #[serde(with = "u64string")]
    pub last_receipt_seq: u64,
    pub ticket: String,
    pub challenge_response: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl HelloBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("hello body serializes")
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

    fn sample() -> HelloBody {
        HelloBody {
            client_version: "0.0.0".into(),
            protocol_major: 2,
            protocol_minor: 0,
            required_features: vec!["journal".into()],
            tool_manifest_hash: "hash".into(),
            runtime_digest: "digest".into(),
            profile_id: "profile".into(),
            journal_epoch: "epoch".into(),
            last_receipt_seq: 7,
            ticket: "ticket".into(),
            challenge_response: "response".into(),
            signature: None,
        }
    }

    #[test]
    fn last_receipt_seq_is_decimal_string() {
        let value = sample().to_value();
        assert_eq!(value["last_receipt_seq"], "7");
    }

    #[test]
    fn sign_then_verify() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut body = sample();
        body.sign(&key).unwrap();
        assert!(body.signature.is_some());
        assert!(verify_frame(
            &jwk,
            FRAME_TYPE,
            &body.to_value(),
            body.signature.as_ref().unwrap()
        ));
    }
}
