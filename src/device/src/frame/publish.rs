//! The local-publication bodies (device-design §3.1 local_publish/publish_ack row, §7.1 step 4;
//! execution-face batch 4). `local_publish` is DEVICE-signed: the Broker names a sealed deliverable
//! version it wrote and asks the control plane to finalize it into a published `local_only`
//! `artifact_version` (`work.finalize_local_artifact`, 0043, work_worker). `publish_ack` is
//! SERVER-signed and verified here against the hello_ack `server_public_jwk`: a publication the
//! device cannot attribute must not let it propose a `completed` finish (0059 needs the published
//! row to exist).
//!
//! The uplink body carries the closed TEN-key version payload `local_artifact_version_payload_valid`
//! demands (0043:198) — version_id/artifact_id/logical_name/format/content_hash/byte_count/local_ref/
//! device_id/classification_claimed/receipt_ref — plus run_id/operation_id so the gateway can call
//! finalize and bind the publication to the calling device's own receipted operation. `artifact_id`
//! is null this period (merge by logical_name; lead ruling 甲 2026-11-21): logical_name is derived
//! from the artifact.write args' artifact_id (a stable per-artifact server UUID), so the tool schema
//! and tool_manifest_hash are unchanged. It is serialized as null rather than omitted so a
//! deserialize→to_value round trip reproduces the exact signed bytes (GW12 null-key precedent).
//!
//! `content_hash` is bare 64-hex (0043:218), NOT the `sha256:` form the sealed buffer/receipt face
//! uses; `local_ref` equals the completed receipt's `local_result_ref` (`run_id:logical_key`) so
//! finalize's receipt cross-check (0043:425) passes; `receipt_ref` is `journal_epoch:seq` of that
//! completed receipt. `classification_claimed` is the device's claim (`local_only` floor); the
//! server derives the binding (B) classification and refuses a claim below the floor (DD:338).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::jwk::EcP256Jwk;
use crate::key::DeviceKey;

/// The local_publish frame type tag (device-signed uplink).
pub const PUBLISH_FRAME_TYPE: &str = "local_publish";
/// The publish_ack frame type tag (server-signed downlink).
pub const PUBLISH_ACK_FRAME_TYPE: &str = "publish_ack";

/// The local_publish body: one sealed deliverable version to finalize, idempotent by version_id
/// (finalize replays the same artifact+hash+run, 0043:543). The ten payload keys mirror
/// `local_artifact_version_payload_valid` exactly; run_id/operation_id locate the Run/operation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LocalPublishBody {
    pub run_id: String,
    pub operation_id: String,
    pub version_id: String,
    /// Always null this period (merge by logical_name); present as a JSON null, never omitted.
    pub artifact_id: Option<String>,
    pub logical_name: String,
    pub format: String,
    pub content_hash: String,
    #[serde(with = "u64string")]
    pub byte_count: u64,
    pub local_ref: String,
    pub device_id: String,
    pub classification_claimed: String,
    pub receipt_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl LocalPublishBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("local_publish serializes")
    }

    /// Sign the body and set its `signature` field.
    pub fn sign(&mut self, key: &dyn DeviceKey) -> Result<(), sign::SignError> {
        let value = self.to_value();
        self.signature = Some(sign::sign_frame(key, PUBLISH_FRAME_TYPE, &value)?);
        Ok(())
    }

    /// Whether the body is inside the closed payload shape the server enforces
    /// (`local_artifact_version_payload_valid`, 0043:198): a bare-hex content_hash, a non-empty
    /// logical_name/format/local_ref/classification_claimed, an `epoch:seq` receipt_ref, and a
    /// null-or-uuid artifact_id. A shape the server would refuse must not be uplinked.
    pub fn payload_consistent(&self) -> bool {
        let bare_hex = self.content_hash.len() == 64
            && self.content_hash.chars().all(|c| c.is_ascii_hexdigit());
        let receipt_ref = self
            .receipt_ref
            .split_once(':')
            .is_some_and(|(epoch, seq)| {
                uuid::Uuid::parse_str(epoch).is_ok()
                    && !seq.is_empty()
                    && seq.chars().all(|c| c.is_ascii_digit())
                    && seq != "0"
            });
        let artifact_id = match &self.artifact_id {
            None => true,
            Some(id) => uuid::Uuid::parse_str(id).is_ok(),
        };
        bare_hex
            && receipt_ref
            && artifact_id
            && !self.logical_name.is_empty()
            && !self.format.is_empty()
            && !self.local_ref.is_empty()
            && !self.version_id.is_empty()
            && matches!(
                self.classification_claimed.as_str(),
                "local_only" | "remote_excerpt_allowed"
            )
    }
}

/// The publish_ack body: the control plane's confirmation that one version is published. The device
/// marks the version published only after verifying the server signature; a `completed` finish
/// waits until every sealed deliverable of the Run has such an ack (0059 precondition).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublishAckBody {
    pub run_id: String,
    pub operation_id: String,
    pub version_id: String,
    pub artifact_id: String,
    #[serde(with = "u64string")]
    pub version_no: u64,
    pub location: String,
    pub classification: String,
    pub publish_ack: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl PublishAckBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("publish_ack serializes")
    }

    /// Verify the server signature over the confirmation. Fail-closed: an unsigned or unverifiable
    /// ack must never mark a version published (GW8 precedent, no optional-signature shim).
    pub fn verify(&self, jwk: &EcP256Jwk) -> bool {
        match &self.signature {
            Some(sig) => sign::verify_frame(jwk, PUBLISH_ACK_FRAME_TYPE, &self.to_value(), sig),
            None => false,
        }
    }

    /// Whether the confirmation names a published local_only version (the only shape finalize
    /// produces, 0043:586-589). A different location/classification is not a publication the
    /// completed-finish precondition can rest on.
    pub fn is_published_local(&self) -> bool {
        self.location == "local_only" && !self.version_id.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SoftwareKey;

    fn publish() -> LocalPublishBody {
        LocalPublishBody {
            run_id: "run-1".into(),
            operation_id: "op-1".into(),
            version_id: "11111111-1111-1111-1111-111111111111".into(),
            artifact_id: None,
            logical_name: "a".into(),
            format: "md".into(),
            content_hash: "a".repeat(64),
            byte_count: 5,
            local_ref: "run-1:tool:0:0".into(),
            device_id: "22222222-2222-2222-2222-222222222222".into(),
            classification_claimed: "local_only".into(),
            receipt_ref: "33333333-3333-3333-3333-333333333333:1".into(),
            signature: None,
        }
    }

    fn ack() -> PublishAckBody {
        PublishAckBody {
            run_id: "run-1".into(),
            operation_id: "op-1".into(),
            version_id: "11111111-1111-1111-1111-111111111111".into(),
            artifact_id: "44444444-4444-4444-4444-444444444444".into(),
            version_no: 1,
            location: "local_only".into(),
            classification: "local_only".into(),
            publish_ack: format!("sha256:{}", "b".repeat(64)),
            signature: None,
        }
    }

    #[test]
    fn publish_wire_shape_is_closed_with_null_artifact_id_and_decimal_bytes() {
        let body = publish();
        let value = body.to_value();
        let obj = value.as_object().unwrap();
        // Twelve data keys (ten payload + run_id/operation_id); unsigned the signature is absent.
        assert_eq!(obj.len(), 12);
        assert!(obj.contains_key("artifact_id"));
        assert!(obj["artifact_id"].is_null()); // null present, never omitted
        assert_eq!(obj["byte_count"], "5"); // decimal string, not a JSON number
        assert!(!obj.contains_key("signature"));
        assert!(body.payload_consistent());
    }

    #[test]
    fn publish_sign_verify_round_trip_and_tamper_refusal() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut body = publish();
        body.sign(&key).unwrap();
        let sig = body.signature.clone().unwrap();
        assert!(sign::verify_frame(
            &jwk,
            PUBLISH_FRAME_TYPE,
            &body.to_value(),
            &sig
        ));
        // A tampered payload no longer verifies under the original signature.
        let mut tampered = body.clone();
        tampered.content_hash = "b".repeat(64);
        assert!(!sign::verify_frame(
            &jwk,
            PUBLISH_FRAME_TYPE,
            &tampered.to_value(),
            &sig
        ));
        // The wrong frame type does not verify (type-bound signature).
        assert!(!sign::verify_frame(&jwk, "receipt", &body.to_value(), &sig));
    }

    #[test]
    fn publish_payload_consistent_refuses_bad_shapes() {
        let mut body = publish();
        body.content_hash = format!("sha256:{}", "a".repeat(64)); // prefixed form is not bare hex
        assert!(!body.payload_consistent());
        let mut body = publish();
        body.receipt_ref = "not-a-uuid:1".into();
        assert!(!body.payload_consistent());
        let mut body = publish();
        body.receipt_ref = "33333333-3333-3333-3333-333333333333:0".into(); // seq must be >= 1
        assert!(!body.payload_consistent());
        let mut body = publish();
        body.artifact_id = Some("not-a-uuid".into());
        assert!(!body.payload_consistent());
        let mut body = publish();
        body.classification_claimed = "org_remote".into(); // outside the claimed closed set
        assert!(!body.payload_consistent());
    }

    #[test]
    fn ack_verify_is_fail_closed_and_type_bound() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut body = ack();
        // Unsigned ack never verifies.
        assert!(!body.verify(&jwk));
        body.signature =
            Some(sign::sign_frame(&key, PUBLISH_ACK_FRAME_TYPE, &body.to_value()).unwrap());
        assert!(body.verify(&jwk));
        assert!(body.is_published_local());
        // A tampered version_id breaks the signature.
        let sig = body.signature.clone().unwrap();
        let mut tampered = body.clone();
        tampered.version_id = "99999999-9999-9999-9999-999999999999".into();
        assert!(!sign::verify_frame(
            &jwk,
            PUBLISH_ACK_FRAME_TYPE,
            &tampered.to_value(),
            &sig
        ));
        // A non-local_only location is not a publication the finish can rest on.
        let mut remote = ack();
        remote.location = "org_remote".into();
        assert!(!remote.is_published_local());
    }

    #[test]
    fn ack_null_signature_round_trips_as_absent_then_present() {
        let body = ack();
        let value = body.to_value();
        assert!(!value.as_object().unwrap().contains_key("signature"));
        let back: PublishAckBody = serde_json::from_value(value).unwrap();
        assert_eq!(back.to_value(), body.to_value());
    }
}
