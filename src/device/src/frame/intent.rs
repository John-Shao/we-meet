//! The `local_intent` body (device-design §2.2): the device-signed local
//! submission proof. It binds the current session, input/preview hashes, the
//! selected grant IDs, device, auth plane + epoch, a nonce and a 60s expiry. The
//! Go submit transaction atomically consumes the nonce; only the original Bearer
//! desktop identity may submit. The nonce-consume transaction is server-side.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::key::DeviceKey;

/// The local_intent frame type tag.
pub const FRAME_TYPE: &str = "local_intent";

/// The local submission proof body (device-design §2.2).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LocalIntent {
    pub session_id: String,
    pub input_hash: String,
    pub preview_hash: String,
    pub selected_grant_ids: Vec<String>,
    pub device_id: String,
    pub auth_plane: String,
    #[serde(with = "u64string")]
    pub auth_epoch: u64,
    pub nonce: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl LocalIntent {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("local_intent serializes")
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

    fn sample() -> LocalIntent {
        LocalIntent {
            session_id: "sess".into(),
            input_hash: "input".into(),
            preview_hash: "preview".into(),
            selected_grant_ids: vec!["g1".into(), "g2".into()],
            device_id: "dev".into(),
            auth_plane: "bearer".into(),
            auth_epoch: 3,
            nonce: "nonce".into(),
            expires_at: "2026-11-14T00:00:00Z".into(),
            signature: None,
        }
    }

    #[test]
    fn auth_epoch_is_decimal_string() {
        let value = sample().to_value();
        assert_eq!(value["auth_epoch"], "3");
        assert_eq!(value["auth_plane"], "bearer");
    }

    #[test]
    fn sign_binds_grant_set() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut intent = sample();
        intent.sign(&key).unwrap();
        let sig = intent.signature.clone().unwrap();
        assert!(verify_frame(&jwk, FRAME_TYPE, &intent.to_value(), &sig));
        // Changing the selected grants invalidates the signature.
        intent.selected_grant_ids.push("g3".into());
        assert!(!verify_frame(&jwk, FRAME_TYPE, &intent.to_value(), &sig));
    }
}
