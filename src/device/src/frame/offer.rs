//! The offer-spine bodies (device-design §3.1 run_offer/run_ready and run_start/run_started
//! rows, §3.2). run_offer and run_start are SERVER-signed and verified here against the
//! hello_ack `server_public_jwk`; run_ready and run_started are DEVICE-signed. The two
//! signature directions are the point of the spine: the device must not start a sidecar for
//! an offer it cannot attribute to the control plane, and the control plane must not move a
//! binding to ready on an answer it cannot attribute to the device.
//!
//! `start_nonce` appears ONLY in run_start, never in run_offer (§3.1). The nonce is minted
//! once by `create_device_run_binding` and is the single-use key the device persists in
//! `runtime_start` before spawning a sidecar (§3.2: "在SQLite持久记录start_nonce后启动指定
//! digest的单一sidecar"), so learning it before the offer is accepted would let a device
//! pre-register the nonce and block the real start.
//!
//! `grant_set` is passed through verbatim from the stored `device_run_binding.grant_set`
//! jsonb — the gateway does not re-shape grant ids — but its `grant_revision` is re-rendered
//! by the gateway into the same decimal-string boundary as the uint64 seq/fence/epoch fields
//! this module owns (§3.1), whichever way the row stored it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::jwk::EcP256Jwk;
use crate::key::DeviceKey;

/// The run_offer frame type tag (server-signed downlink).
pub const OFFER_FRAME_TYPE: &str = "run_offer";
/// The run_ready frame type tag (device-signed uplink).
pub const READY_FRAME_TYPE: &str = "run_ready";
/// The run_start frame type tag (server-signed downlink).
pub const START_FRAME_TYPE: &str = "run_start";
/// The run_started frame type tag (device-signed uplink).
pub const STARTED_FRAME_TYPE: &str = "run_started";

/// The closed run_ready answer set (`work.acknowledge_run_ready`, 0041/0052). Only `ready`
/// moves the binding; the other three are the user-visible next step and leave it offered.
pub const READY_REASONS: &[&str] = &[
    "ready",
    "missing_input",
    "needs_reauthorization",
    "profile_unavailable",
];

/// One grant the offer authorizes, as stored on the binding. `grant_revision` is a bigint
/// revision, so it crosses the wire as a decimal string like every other uint64 counter
/// (§3.1); the gateway re-renders the stored jsonb into that form before signing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantRef {
    pub grant_id: String,
    #[serde(with = "u64string")]
    pub grant_revision: u64,
}

/// The device/session the offer was made to. §3.2 binds an offer to the original
/// device/session, so a reconnect must not answer for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginalTarget {
    pub device_id: String,
    pub session_id: String,
}

/// The run_offer body. `expected_checkpoint_*` are both null for a first offer and both set
/// for a resume offer (§3.4: a resume references the latest recorded checkpoint of that Run),
/// which is how the device tells the two apart.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunOfferBody {
    pub run_id: String,
    #[serde(with = "u64string")]
    pub binding_revision: u64,
    pub binding_hash: String,
    pub task_id: String,
    pub input_ref: String,
    pub input_hash: String,
    pub snapshot_descriptor_ref: Option<String>,
    pub snapshot_hash: String,
    pub profile_id: String,
    #[serde(with = "u64string")]
    pub profile_revision: u64,
    pub runtime_digest: String,
    pub tool_manifest_hash: String,
    pub model_version: String,
    pub grant_set: Vec<GrantRef>,
    #[serde(with = "u64string::opt")]
    pub expected_checkpoint_seq: Option<u64>,
    pub expected_checkpoint_hash: Option<String>,
    pub original_target: OriginalTarget,
    pub offer_expiry: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl RunOfferBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("run_offer serializes")
    }

    /// Verify the server signature over the offer. Fail-closed: an offer without a
    /// verifiable signature must never reach the ready answer.
    pub fn verify(&self, jwk: &EcP256Jwk) -> bool {
        match &self.signature {
            Some(sig) => sign::verify_frame(jwk, OFFER_FRAME_TYPE, &self.to_value(), sig),
            None => false,
        }
    }

    /// Whether this offer is a resume (it references an expected checkpoint) rather than a
    /// first start. A resume must never re-run from the initial input (§3.2/§3.4).
    pub fn is_resume(&self) -> bool {
        self.expected_checkpoint_hash.is_some()
    }

    /// Whether both expected-checkpoint fields agree. The database enforces the same pairing
    /// (device_run_binding_checkpoint_shape), so a half-populated offer is a protocol break.
    pub fn expected_checkpoint_consistent(&self) -> bool {
        self.expected_checkpoint_seq.is_some() == self.expected_checkpoint_hash.is_some()
    }
}

/// The run_ready body: the device's answer to one offer.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunReadyBody {
    pub run_id: String,
    #[serde(with = "u64string")]
    pub binding_revision: u64,
    pub binding_hash: String,
    pub ready_or_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl RunReadyBody {
    /// Build an unsigned answer for one offer.
    pub fn new(offer: &RunOfferBody, ready_or_reason: &str) -> Self {
        Self {
            run_id: offer.run_id.clone(),
            binding_revision: offer.binding_revision,
            binding_hash: offer.binding_hash.clone(),
            ready_or_reason: ready_or_reason.into(),
            signature: None,
        }
    }

    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("run_ready serializes")
    }

    /// Sign the body and set its `signature` field.
    pub fn sign(&mut self, key: &dyn DeviceKey) -> Result<(), sign::SignError> {
        let value = self.to_value();
        self.signature = Some(sign::sign_frame(key, READY_FRAME_TYPE, &value)?);
        Ok(())
    }

    /// Whether the answer is in the closed reason set.
    pub fn reason_valid(&self) -> bool {
        READY_REASONS.contains(&self.ready_or_reason.as_str())
    }

    /// Whether this answer authorizes a start.
    pub fn is_ready(&self) -> bool {
        self.ready_or_reason == "ready"
    }
}

/// The run_start body: the server's authority to spawn exactly one sidecar. `expiry` and
/// `lease_id` describe the lease `acquire_device_lease` just minted; `payload_hash` is the
/// server's own binding of the start facts (0041).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunStartBody {
    #[serde(with = "u64string")]
    pub run_binding_id: u64,
    pub run_id: String,
    pub payload_hash: String,
    pub session_id: String,
    #[serde(with = "u64string")]
    pub fence: u64,
    #[serde(with = "u64string")]
    pub generation: u64,
    pub lease_id: String,
    pub runtime_digest: String,
    pub start_nonce: String,
    pub expiry: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl RunStartBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("run_start serializes")
    }

    /// Verify the server signature over the start authority.
    pub fn verify(&self, jwk: &EcP256Jwk) -> bool {
        match &self.signature {
            Some(sig) => sign::verify_frame(jwk, START_FRAME_TYPE, &self.to_value(), sig),
            None => false,
        }
    }

    /// Whether this start answers the given offer: same Run and same binding revision. The
    /// nonce cannot be checked against the offer because the offer never carries one.
    pub fn matches_offer(&self, offer: &RunOfferBody) -> bool {
        self.run_id == offer.run_id && self.run_binding_id == offer.binding_revision
    }
}

/// The run_started body: the device's confirmation that the single sidecar for this nonce is
/// up. The server only verifies it (ruling 2026-11-16: no database write — the binding is
/// already active, the seq=0 baseline is written and the lease row carries the nonce).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunStartedBody {
    pub start_nonce: String,
    pub state: String,
    pub checkpoint_ref: String,
    pub checkpoint_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl RunStartedBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("run_started serializes")
    }

    /// Sign the body and set its `signature` field.
    pub fn sign(&mut self, key: &dyn DeviceKey) -> Result<(), sign::SignError> {
        let value = self.to_value();
        self.signature = Some(sign::sign_frame(key, STARTED_FRAME_TYPE, &value)?);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SoftwareKey;

    fn offer() -> RunOfferBody {
        RunOfferBody {
            run_id: "run-1".into(),
            binding_revision: 1,
            binding_hash: "a".repeat(64),
            task_id: "task-1".into(),
            input_ref: "ref".into(),
            input_hash: "b".repeat(64),
            snapshot_descriptor_ref: None,
            snapshot_hash: "c".repeat(64),
            profile_id: "p1".into(),
            profile_revision: 3,
            runtime_digest: "d".repeat(64),
            tool_manifest_hash: "e".repeat(64),
            model_version: "m1".into(),
            grant_set: vec![GrantRef {
                grant_id: "g1".into(),
                grant_revision: 1,
            }],
            expected_checkpoint_seq: None,
            expected_checkpoint_hash: None,
            original_target: OriginalTarget {
                device_id: "dev-1".into(),
                session_id: "sess-1".into(),
            },
            offer_expiry: "2026-11-16T00:02:00Z".into(),
            signature: None,
        }
    }

    fn start(nonce: &str) -> RunStartBody {
        RunStartBody {
            run_binding_id: 1,
            run_id: "run-1".into(),
            payload_hash: "f".repeat(64),
            session_id: "sess-1".into(),
            fence: 2,
            generation: 7,
            lease_id: "lease-1".into(),
            runtime_digest: "d".repeat(64),
            start_nonce: nonce.into(),
            expiry: "2026-11-16T00:00:30Z".into(),
            signature: None,
        }
    }

    #[test]
    fn offer_wire_shape_is_closed_and_decimal_strings() {
        let value = offer().to_value();
        let obj = value.as_object().unwrap();
        assert_eq!(obj.len(), 18);
        assert_eq!(obj["binding_revision"], "1");
        assert_eq!(obj["profile_revision"], "3");
        assert!(obj["expected_checkpoint_seq"].is_null());
        assert!(obj["expected_checkpoint_hash"].is_null());
        // grant_set revisions cross the §3.1 uint64 boundary as decimal strings.
        assert_eq!(obj["grant_set"][0]["grant_revision"], "1");
        assert_eq!(obj["original_target"]["device_id"], "dev-1");
        // No start_nonce on the offer: §3.1 puts it only in run_start.
        assert!(!obj.contains_key("start_nonce"));
        let round: RunOfferBody = serde_json::from_value(value).unwrap();
        assert_eq!(round.binding_revision, 1);
        assert!(!round.is_resume());
        assert!(round.expected_checkpoint_consistent());
    }

    #[test]
    fn resume_offer_carries_both_expected_checkpoint_fields() {
        let mut body = offer();
        body.binding_revision = 2;
        body.expected_checkpoint_seq = Some(4);
        body.expected_checkpoint_hash = Some("9".repeat(64));
        let value = body.to_value();
        assert_eq!(value["expected_checkpoint_seq"], "4");
        let round: RunOfferBody = serde_json::from_value(value).unwrap();
        assert!(round.is_resume());
        assert!(round.expected_checkpoint_consistent());
        // A half-populated offer is a protocol break, not a first offer.
        let mut half = round.clone();
        half.expected_checkpoint_hash = None;
        assert!(!half.expected_checkpoint_consistent());
    }

    #[test]
    fn offer_verifies_against_server_key_and_rejects_tampering() {
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        let mut body = offer();
        body.signature =
            Some(sign::sign_frame(&server, OFFER_FRAME_TYPE, &body.to_value()).unwrap());
        assert!(body.verify(&jwk));
        // The frame type is domain separation: the same bytes must not verify as run_start.
        assert!(!sign::verify_frame(
            &jwk,
            START_FRAME_TYPE,
            &body.to_value(),
            body.signature.as_ref().unwrap()
        ));
        body.offer_expiry = "2027-01-01T00:00:00Z".into();
        assert!(!body.verify(&jwk));
        let unsigned = offer();
        assert!(!unsigned.verify(&jwk));
    }

    #[test]
    fn ready_answer_signs_and_carries_the_offer_binding_hash() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let offered = offer();
        let mut ready = RunReadyBody::new(&offered, "ready");
        assert!(ready.reason_valid());
        assert!(ready.is_ready());
        ready.sign(&key).unwrap();
        assert!(sign::verify_frame(
            &jwk,
            READY_FRAME_TYPE,
            &ready.to_value(),
            ready.signature.as_ref().unwrap()
        ));
        assert_eq!(ready.binding_hash, offered.binding_hash);
        assert_eq!(ready.binding_revision, offered.binding_revision);

        let mut bogus = RunReadyBody::new(&offered, "looks_ready");
        assert!(!bogus.reason_valid());
        assert!(!bogus.is_ready());
        bogus.sign(&key).unwrap();
        let obj = bogus.to_value();
        assert_eq!(obj.as_object().unwrap().len(), 5);
        assert_eq!(obj["binding_revision"], "1");
    }

    #[test]
    fn start_verifies_and_matches_its_offer() {
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        let offered = offer();
        let mut body = start("nonce-1");
        body.signature =
            Some(sign::sign_frame(&server, START_FRAME_TYPE, &body.to_value()).unwrap());
        assert!(body.verify(&jwk));
        assert!(body.matches_offer(&offered));
        let obj = body.to_value();
        assert_eq!(obj["run_binding_id"], "1");
        assert_eq!(obj["fence"], "2");
        assert_eq!(obj["generation"], "7");
        assert_eq!(obj["start_nonce"], "nonce-1");
        // A start for another revision is not this offer's start.
        let mut other = start("nonce-1");
        other.run_binding_id = 2;
        assert!(!other.matches_offer(&offered));
        let mut tampered = body.clone();
        tampered.start_nonce = "nonce-2".into();
        assert!(!tampered.verify(&jwk));
    }

    #[test]
    fn started_answer_signs_under_its_own_frame_type() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut body = RunStartedBody {
            start_nonce: "nonce-1".into(),
            state: "started".into(),
            checkpoint_ref: "local/cp0".into(),
            checkpoint_hash: "2".repeat(64),
            signature: None,
        };
        body.sign(&key).unwrap();
        let sig = body.signature.clone().unwrap();
        assert!(sign::verify_frame(
            &jwk,
            STARTED_FRAME_TYPE,
            &body.to_value(),
            &sig
        ));
        // Not reusable as a run_ready signature.
        assert!(!sign::verify_frame(
            &jwk,
            READY_FRAME_TYPE,
            &body.to_value(),
            &sig
        ));
        assert_eq!(body.to_value().as_object().unwrap().len(), 5);
    }
}
