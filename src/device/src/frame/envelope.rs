//! The closed frame envelope (device-design §3.1). Ten fields wrap every frame.
//! The outer transport fields are NOT signed — the signature covers
//! `{schema_version, type, body}` (see [`crate::frame::sign`]); the body carries
//! each frame's identity, result and its own `signature` field. uint64 fields
//! cross the boundary as decimal strings.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::u64string;

/// The wire schema version (device-design §3.1: `schema_version=2`).
pub const SCHEMA_VERSION: u32 = 2;

/// The closed ten-field envelope. `body` is the frame-specific signed document;
/// `session_id` is empty in a hello request and assigned by `hello_ack`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope {
    pub schema_version: u32,
    #[serde(rename = "type")]
    pub frame_type: String,
    pub message_id: String,
    pub device_id: String,
    pub session_id: String,
    pub agent_instance_id: String,
    pub boot_id: String,
    #[serde(with = "u64string")]
    pub recovery_generation: u64,
    pub sent_at: String,
    pub body: Value,
}

impl Envelope {
    /// Build an envelope with a fresh `message_id` and `schema_version=2`. The
    /// transport layer (later batch) fills `session_id`/`sent_at`; hello leaves
    /// `session_id` empty. Identity fields default empty for the caller to set.
    pub fn new(frame_type: &str, device_id: &str, body: Value) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            frame_type: frame_type.to_string(),
            message_id: uuid::Uuid::new_v4().to_string(),
            device_id: device_id.to_string(),
            session_id: String::new(),
            agent_instance_id: String::new(),
            boot_id: String::new(),
            recovery_generation: 0,
            sent_at: String::new(),
            body,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_has_ten_closed_fields() {
        let env = Envelope::new("hello", "dev", json!({"k": "v"}));
        let value = serde_json::to_value(&env).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "agent_instance_id",
                "body",
                "boot_id",
                "device_id",
                "message_id",
                "recovery_generation",
                "schema_version",
                "sent_at",
                "session_id",
                "type"
            ]
        );
        assert_eq!(value["schema_version"], 2);
        assert_eq!(value["type"], "hello");
    }

    #[test]
    fn recovery_generation_is_decimal_string() {
        let mut env = Envelope::new("heartbeat", "dev", json!({}));
        env.recovery_generation = 9_007_199_254_740_993;
        let value = serde_json::to_value(&env).unwrap();
        assert_eq!(value["recovery_generation"], "9007199254740993");
    }

    #[test]
    fn hello_session_id_is_empty() {
        let env = Envelope::new("hello", "dev", json!({}));
        assert_eq!(env.session_id, "");
    }
}
