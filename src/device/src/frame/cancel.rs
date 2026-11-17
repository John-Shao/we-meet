//! The cancel stop face (device-design §3.1 cancel/cancel_ack row, §3.4 step 4). `cancel` is
//! SERVER-signed and verified here against the hello_ack `server_public_jwk`: an unattributable
//! instruction to stop a Run must never move the local process tree. `cancel_ack` is DEVICE-signed
//! and carries the stop fact back.
//!
//! TWO WIRE EXTENSIONS (ruled 主签 2026-11-17＝两侧都签, annotated in §3.1). The row lists
//! `run_id、cancel_revision / stopped_or_unknown、last_receipt_seq`. ① Neither side listed a
//! signature member, but `stopped_or_unknown` decides whether an in-flight Operation becomes
//! `unknown` on the server, so it is a consequential fact assertion rather than a liveness signal
//! like heartbeat — the same "required but no place" class GW13 fixed for action_prepared and GW14
//! for command. ② The ack side omitted `run_id` and `cancel_revision`, yet one session can hold
//! several Runs and the server must know which cancel is being acknowledged at which revision;
//! without them the ack is uncallable. `cancel_revision` is the Run's `control_revision`, which
//! `request_cancel` already bumps — no new counter is invented.
//!
//! THE ASSERTION IS NARROW. §3.1: "stopped 只确认本地可控进程停止，不宣称外部动作未发生". `stopped`
//! says the local process tree is no longer running; it says NOTHING about whether an external
//! effect already happened, which is why the server turns a dispatching Operation into `unknown`
//! and reconciles it rather than treating it as canceled. `unknown` is the honest answer when the
//! device cannot confirm the tree stopped, and the server then leaves the Operation dispatching.
//!
//! The ack is NOT a Run verdict. The local Run reaches its terminal state only through
//! `run_finish` (§3.4), whose `run_cancel_requested` rejection is what routes the device into this
//! flow in the first place. There is no server response to cancel_ack: §3.1 registers no third
//! frame, so a lost ack is repaired by the read-only cancel re-push on the next session/heartbeat.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::jwk::EcP256Jwk;
use crate::key::DeviceKey;
use crate::sidecar::lifecycle::SidecarState;

/// The cancel frame type tag (server-signed downlink).
pub const CANCEL_FRAME_TYPE: &str = "cancel";
/// The cancel_ack frame type tag (device-signed uplink).
pub const CANCEL_ACK_FRAME_TYPE: &str = "cancel_ack";

/// The closed stop-assertion vocabulary (§3.1). `stopped_or_unknown` is a frame-internal value,
/// deliberately outside the HTTP public error vocabulary (control-design §9:606).
pub const STOP_ASSERTIONS: &[&str] = &["stopped", "unknown"];

/// The cancel body: the closed three-key set (§3.1's two plus the ruled server signature). Nothing
/// else rides along — the device already holds the Run's binding, lease and journal, and a cancel
/// is an instruction to stop, not a re-offer.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancelBody {
    pub run_id: String,
    #[serde(with = "u64string")]
    pub cancel_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl CancelBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("cancel serializes")
    }

    /// Verify the server's frame signature. Fail-closed: an unsigned or unverifiable cancel must
    /// never stop a process tree (GW8 precedent, no optional-signature shim).
    pub fn verify(&self, server_jwk: &EcP256Jwk) -> bool {
        match &self.signature {
            Some(sig) => sign::verify_frame(server_jwk, CANCEL_FRAME_TYPE, &self.to_value(), sig),
            None => false,
        }
    }
}

/// What the device could confirm about the LOCAL process tree when the cancel arrived. The Job
/// Object's kill-on-close ([`crate::sidecar::job`]) is the primitive that terminates the tree; the
/// spawn integration that owns a live job handle lands with the Node batch, so the observation is
/// an input here rather than something this module invents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalStop {
    /// The tree is confirmed no longer running. This licenses `stopped` and nothing more: an
    /// external effect may already have happened (§3.1, invariant 2).
    Confirmed,
    /// The tree could not be confirmed stopped. Asserting `stopped` here would claim a fact nobody
    /// observed, so the device must say `unknown` and let the server keep the Operation in flight.
    Unconfirmed,
}

impl LocalStop {
    /// The assertion this observation licenses.
    pub fn assertion(self) -> &'static str {
        match self {
            LocalStop::Confirmed => "stopped",
            LocalStop::Unconfirmed => "unknown",
        }
    }

    /// Read the observation off the sidecar lifecycle: an exited process is not running, while a
    /// spawned or running one has not been confirmed stopped. A crash therefore still licenses
    /// `stopped` — the assertion is about the local process, not about why it ended.
    pub fn from_sidecar_state(state: SidecarState) -> Self {
        match state {
            SidecarState::Exited => LocalStop::Confirmed,
            SidecarState::Spawned | SidecarState::Running => LocalStop::Unconfirmed,
        }
    }
}

/// The cancel_ack body: the closed five-key set (§3.1's two ack keys plus the ruled run_id,
/// cancel_revision and signature). It answers exactly one cancel, so the run/revision pair is
/// cross-checked against the downlink rather than trusted from local memory.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancelAckBody {
    pub run_id: String,
    #[serde(with = "u64string")]
    pub cancel_revision: u64,
    pub stopped_or_unknown: String,
    #[serde(with = "u64string")]
    pub last_receipt_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl CancelAckBody {
    /// Build the unsigned ack that answers `cancel`, carrying the device's receipt watermark as
    /// evidence. The watermark is reported, not negotiated: `renew_device_lease` owns the server's
    /// `execution_lease.last_receipt_seq` column (0051) and the ack must not become a second writer.
    pub fn for_stop(cancel: &CancelBody, last_receipt_seq: u64, local: LocalStop) -> Self {
        Self {
            run_id: cancel.run_id.clone(),
            cancel_revision: cancel.cancel_revision,
            stopped_or_unknown: local.assertion().into(),
            last_receipt_seq,
            signature: None,
        }
    }

    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("cancel_ack serializes")
    }

    /// Sign the body and set its `signature` field. ES256 is randomized, so a replay must re-send
    /// the SAME signed bytes rather than re-sign (§3.4 step 3's rule for run_finish applies here
    /// too: the durable copy is the one that was sent).
    pub fn sign(&mut self, key: &dyn DeviceKey) -> Result<(), sign::SignError> {
        let value = self.to_value();
        self.signature = Some(sign::sign_frame(key, CANCEL_ACK_FRAME_TYPE, &value)?);
        Ok(())
    }

    /// Whether the assertion is inside the closed vocabulary. Anything else is invalid_request on
    /// the server, never a stop fact.
    pub fn assertion_consistent(&self) -> bool {
        STOP_ASSERTIONS.contains(&self.stopped_or_unknown.as_str())
    }

    /// Whether this ack answers exactly the cancel it claims to. A mismatch means the device is
    /// reporting a stop against a different Run or a stale revision, which the server refuses with
    /// `revision_conflict` — the device must re-read the cancel downlink, not retry unchanged.
    pub fn ack_matches_cancel(&self, cancel: &CancelBody) -> bool {
        self.run_id == cancel.run_id && self.cancel_revision == cancel.cancel_revision
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SoftwareKey;

    fn cancel(server: &dyn DeviceKey) -> CancelBody {
        let mut c = CancelBody {
            run_id: "run-1".into(),
            cancel_revision: 3,
            signature: None,
        };
        c.signature = Some(sign::sign_frame(server, CANCEL_FRAME_TYPE, &c.to_value()).unwrap());
        c
    }

    #[test]
    fn wire_shape_is_closed_and_decimal_strings() {
        let server = SoftwareKey::random();
        let c = cancel(&server);
        let obj = c.to_value();
        assert_eq!(obj.as_object().unwrap().len(), 3);
        assert_eq!(obj["cancel_revision"], "3");
        let mut unsigned = c.clone();
        unsigned.signature = None;
        assert_eq!(unsigned.to_value().as_object().unwrap().len(), 2);

        let mut ack = CancelAckBody::for_stop(&c, 9, LocalStop::Confirmed);
        assert_eq!(ack.to_value().as_object().unwrap().len(), 4);
        ack.sign(&SoftwareKey::random()).unwrap();
        let value = ack.to_value();
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert_eq!(value["cancel_revision"], "3");
        assert_eq!(value["last_receipt_seq"], "9");
        assert_eq!(value["stopped_or_unknown"], "stopped");
    }

    #[test]
    fn counters_cross_as_decimal_strings_at_u64_max() {
        let server = SoftwareKey::random();
        let mut c = CancelBody {
            run_id: "run-1".into(),
            cancel_revision: u64::MAX,
            signature: None,
        };
        c.signature = Some(sign::sign_frame(&server, CANCEL_FRAME_TYPE, &c.to_value()).unwrap());
        let mut ack = CancelAckBody::for_stop(&c, u64::MAX, LocalStop::Unconfirmed);
        ack.sign(&SoftwareKey::random()).unwrap();
        let value = ack.to_value();
        assert_eq!(value["cancel_revision"], "18446744073709551615");
        assert_eq!(value["last_receipt_seq"], "18446744073709551615");
        let round: CancelAckBody = serde_json::from_value(value).unwrap();
        assert_eq!(round.cancel_revision, u64::MAX);
        assert_eq!(round.last_receipt_seq, u64::MAX);
        // Above 2^53 the value must not have gone through a float.
        let mut precise = CancelAckBody::for_stop(&c, 9_007_199_254_740_993, LocalStop::Confirmed);
        precise.sign(&SoftwareKey::random()).unwrap();
        let round: CancelAckBody = serde_json::from_value(precise.to_value()).unwrap();
        assert_eq!(round.last_receipt_seq, 9_007_199_254_740_993);
        // A float or a bare number at the boundary is refused, not silently truncated.
        let mut obj = ack.to_value();
        obj["last_receipt_seq"] = serde_json::json!(9.0);
        assert!(serde_json::from_value::<CancelAckBody>(obj.clone()).is_err());
        obj["last_receipt_seq"] = serde_json::json!(9);
        assert!(serde_json::from_value::<CancelAckBody>(obj).is_err());
        let mut cobj = c.to_value();
        cobj["cancel_revision"] = serde_json::json!(3.0);
        assert!(serde_json::from_value::<CancelBody>(cobj).is_err());
    }

    #[test]
    fn cancel_signature_is_fail_closed_and_type_bound() {
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        let c = cancel(&server);
        assert!(c.verify(&jwk));
        // Unsigned: never trusted to stop a process tree.
        let mut unsigned = c.clone();
        unsigned.signature = None;
        assert!(!unsigned.verify(&jwk));
        // Signed as a different frame type: refused.
        let mut wrong = CancelBody {
            run_id: "run-1".into(),
            cancel_revision: 3,
            signature: None,
        };
        wrong.signature = Some(
            sign::sign_frame(
                &server,
                crate::frame::command::COMMAND_FRAME_TYPE,
                &wrong.to_value(),
            )
            .unwrap(),
        );
        assert!(!wrong.verify(&jwk));
        // Tampered Run or revision: refused.
        let mut tampered = c.clone();
        tampered.run_id = "run-2".into();
        assert!(!tampered.verify(&jwk));
        let mut bumped = c.clone();
        bumped.cancel_revision = 4;
        assert!(!bumped.verify(&jwk));
        // A foreign key (including the independent permit key): refused.
        assert!(!c.verify(&SoftwareKey::random().public_jwk()));
        // Round trip reproduces the signed bytes.
        let round: CancelBody = serde_json::from_value(c.to_value()).unwrap();
        assert!(round.verify(&jwk));
    }

    #[test]
    fn ack_signature_is_bound_to_its_own_frame_type() {
        let device = SoftwareKey::random();
        let server = SoftwareKey::random();
        let c = cancel(&server);
        let mut ack = CancelAckBody::for_stop(&c, 0, LocalStop::Confirmed);
        ack.sign(&device).unwrap();
        let value = ack.to_value();
        let sig = ack.signature.clone().unwrap();
        assert!(sign::verify_frame(
            &device.public_jwk(),
            CANCEL_ACK_FRAME_TYPE,
            &value,
            &sig
        ));
        // The uplink must not verify as the downlink, nor under the server's key: the two
        // directions are domain-separated and attributed to different signers.
        assert!(!sign::verify_frame(
            &device.public_jwk(),
            CANCEL_FRAME_TYPE,
            &value,
            &sig
        ));
        assert!(!sign::verify_frame(
            &server.public_jwk(),
            CANCEL_ACK_FRAME_TYPE,
            &value,
            &sig
        ));
        let round: CancelAckBody = serde_json::from_value(value).unwrap();
        assert!(sign::verify_frame(
            &device.public_jwk(),
            CANCEL_ACK_FRAME_TYPE,
            &round.to_value(),
            round.signature.as_ref().unwrap()
        ));
        // Tampering with the assertion after signing breaks verification: this is the field that
        // decides whether an in-flight Operation becomes unknown.
        let mut tampered = ack.clone();
        tampered.stopped_or_unknown = "unknown".into();
        assert!(!sign::verify_frame(
            &device.public_jwk(),
            CANCEL_ACK_FRAME_TYPE,
            &tampered.to_value(),
            tampered.signature.as_ref().unwrap()
        ));
    }

    #[test]
    fn assertion_vocabulary_is_closed() {
        let server = SoftwareKey::random();
        let c = cancel(&server);
        for assertion in STOP_ASSERTIONS {
            let mut ack = CancelAckBody::for_stop(&c, 0, LocalStop::Confirmed);
            ack.stopped_or_unknown = (*assertion).into();
            assert!(ack.assertion_consistent());
        }
        let mut ack = CancelAckBody::for_stop(&c, 0, LocalStop::Confirmed);
        for bad in ["", "Stopped", "stopped_or_unknown", "canceled", "failed"] {
            ack.stopped_or_unknown = bad.into();
            assert!(
                !ack.assertion_consistent(),
                "{bad} must not be a stop assertion"
            );
        }
    }

    #[test]
    fn ack_must_answer_the_cancel_it_names() {
        let server = SoftwareKey::random();
        let c = cancel(&server);
        let ack = CancelAckBody::for_stop(&c, 0, LocalStop::Confirmed);
        assert!(ack.ack_matches_cancel(&c));
        let mut other_run = ack.clone();
        other_run.run_id = "run-2".into();
        assert!(!other_run.ack_matches_cancel(&c));
        let mut stale = ack.clone();
        stale.cancel_revision = 2;
        assert!(!stale.ack_matches_cancel(&c));
        // A newer revision is equally not an answer to THIS cancel.
        let mut ahead = ack;
        ahead.cancel_revision = 4;
        assert!(!ahead.ack_matches_cancel(&c));
    }

    #[test]
    fn only_a_confirmed_local_exit_licenses_stopped() {
        assert_eq!(LocalStop::Confirmed.assertion(), "stopped");
        assert_eq!(LocalStop::Unconfirmed.assertion(), "unknown");
        assert_eq!(
            LocalStop::from_sidecar_state(SidecarState::Exited),
            LocalStop::Confirmed
        );
        for state in [SidecarState::Spawned, SidecarState::Running] {
            assert_eq!(LocalStop::from_sidecar_state(state), LocalStop::Unconfirmed);
        }
        // The unconfirmed path must still produce a well-formed ack: the device reports honestly
        // rather than staying silent, and the server keeps the Operation dispatching.
        let server = SoftwareKey::random();
        let c = cancel(&server);
        let ack =
            CancelAckBody::for_stop(&c, 5, LocalStop::from_sidecar_state(SidecarState::Running));
        assert_eq!(ack.stopped_or_unknown, "unknown");
        assert_eq!(ack.last_receipt_seq, 5);
        assert!(ack.assertion_consistent());
        assert!(ack.ack_matches_cancel(&c));
    }
}
