//! The checkpoint_commit uplink and checkpoint_ack downlink bodies
//! (device-design §3.1 checkpoint row, §3.4). The commit is device-signed and
//! carries only hashes and an opaque local ref — never ciphertext. The ack is
//! server-signed; its `recorded` state carries the receipt watermark that drives
//! incremental receipt cleanup (B03 carrier §3.2, replacing journal_release).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::jwk::EcP256Jwk;
use crate::key::DeviceKey;

/// The checkpoint_commit frame type tag (device-signed uplink).
pub const COMMIT_FRAME_TYPE: &str = "checkpoint_commit";
/// The checkpoint_ack frame type tag (server-signed downlink).
pub const ACK_FRAME_TYPE: &str = "checkpoint_ack";
/// The closed checkpoint_ack state set.
pub const ACK_STATES: &[&str] = &["recorded", "conflict"];

/// The checkpoint_commit body.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CheckpointCommitBody {
    pub run_id: String,
    #[serde(with = "u64string")]
    pub binding_revision: u64,
    #[serde(with = "u64string")]
    pub fence: u64,
    #[serde(with = "u64string")]
    pub checkpoint_seq: u64,
    pub checkpoint_hash: String,
    pub local_checkpoint_ref: String,
    #[serde(with = "u64string")]
    pub receipt_through_seq: u64,
    pub pending_operation_set_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl CheckpointCommitBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("checkpoint_commit serializes")
    }

    /// Sign the body and set its `signature` field.
    pub fn sign(&mut self, key: &dyn DeviceKey) -> Result<(), sign::SignError> {
        let value = self.to_value();
        self.signature = Some(sign::sign_frame(key, COMMIT_FRAME_TYPE, &value)?);
        Ok(())
    }
}

/// The checkpoint_ack body. `receipt_through_seq` is the receipt watermark the
/// device may release up to (only when `state == "recorded"`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CheckpointAckBody {
    pub run_id: String,
    #[serde(with = "u64string")]
    pub checkpoint_seq: u64,
    pub state: String,
    #[serde(with = "u64string")]
    pub receipt_through_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl CheckpointAckBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("checkpoint_ack serializes")
    }

    /// Verify the server signature over the ack body.
    pub fn verify(&self, jwk: &EcP256Jwk) -> bool {
        match &self.signature {
            Some(sig) => sign::verify_frame(jwk, ACK_FRAME_TYPE, &self.to_value(), sig),
            None => false,
        }
    }

    /// Whether the state is in the closed set.
    pub fn state_valid(&self) -> bool {
        ACK_STATES.contains(&self.state.as_str())
    }

    /// Whether this ack records the checkpoint (and thus carries a usable watermark).
    pub fn is_recorded(&self) -> bool {
        self.state == "recorded"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SoftwareKey;

    fn commit() -> CheckpointCommitBody {
        CheckpointCommitBody {
            run_id: "run".into(),
            binding_revision: 1,
            fence: 1,
            checkpoint_seq: 3,
            checkpoint_hash: "ch".into(),
            local_checkpoint_ref: "ref".into(),
            receipt_through_seq: 5,
            pending_operation_set_hash: "pending".into(),
            signature: None,
        }
    }

    fn ack(state: &str) -> CheckpointAckBody {
        CheckpointAckBody {
            run_id: "run".into(),
            checkpoint_seq: 3,
            state: state.into(),
            receipt_through_seq: 5,
            signature: None,
        }
    }

    #[test]
    fn commit_signs_and_tamper_fails() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut body = commit();
        body.sign(&key).unwrap();
        let sig = body.signature.clone().unwrap();
        assert!(sign::verify_frame(
            &jwk,
            COMMIT_FRAME_TYPE,
            &body.to_value(),
            &sig
        ));
        body.fence = 2;
        assert!(!sign::verify_frame(
            &jwk,
            COMMIT_FRAME_TYPE,
            &body.to_value(),
            &sig
        ));
    }

    #[test]
    fn commit_uint64_fields_are_decimal_strings() {
        let value = commit().to_value();
        assert_eq!(value["checkpoint_seq"], "3");
        assert_eq!(value["fence"], "1");
        assert_eq!(value["receipt_through_seq"], "5");
    }

    #[test]
    fn ack_verifies_with_server_key_and_closed_state() {
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        let mut body = ack("recorded");
        let sig = sign::sign_frame(&server, ACK_FRAME_TYPE, &body.to_value()).unwrap();
        body.signature = Some(sig);
        assert!(body.verify(&jwk));
        assert!(body.state_valid());
        assert!(body.is_recorded());
        // A conflict ack is valid state but not recorded.
        let conflict = ack("conflict");
        assert!(conflict.state_valid());
        assert!(!conflict.is_recorded());
        // An unknown state is rejected.
        assert!(!ack("bogus").state_valid());
    }

    #[test]
    fn unsigned_ack_does_not_verify() {
        let server = SoftwareKey::random();
        assert!(!ack("recorded").verify(&server.public_jwk()));
    }
}
