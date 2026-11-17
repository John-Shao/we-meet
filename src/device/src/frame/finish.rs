//! The run-finish bodies (device-design §3.1 run_finish/run_finish_ack row, §3.4 steps 3-4).
//! `run_finish` is DEVICE-signed: the device proposes an outcome judged only from its journal,
//! receipts and sealed deliverables (§3.4 step 1 — never Node's self-report). `run_finish_ack`
//! is SERVER-signed and verified here against the hello_ack `server_public_jwk`: the control
//! plane adjudicates (§6.4), so a verdict the device cannot attribute must not move its journal.
//!
//! The ack body is the closed SEVEN-key set ruled 主签 2026-11-16. §3.1's row lists five
//! (finish_id/state/code?/terminal_run_revision?/server_signature), but §3.4 step 4 and §6.4
//! step 3 both require `expected_operation_set_hash` and `unresolved_operations[]` — they are
//! what lets the device repair a `finish_state_mismatch` instead of blind-retrying, which §3.4
//! forbids. The two optional keys always arrive (null when not applicable), and they are
//! serialized as null rather than omitted so a deserialize→to_value round trip reproduces the
//! exact signed bytes.
//!
//! A rejected verdict does NOT change local deliverable facts (§3.4 step 4): it only stops the
//! same finish_id being replayed. Repairing means a NEW finish_id over the current facts.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::finish::outcome::{Outcome, REASON_CODES};
use crate::frame::{sign, u64string};
use crate::jwk::EcP256Jwk;
use crate::key::DeviceKey;

/// The run_finish frame type tag (device-signed uplink).
pub const FINISH_FRAME_TYPE: &str = "run_finish";
/// The run_finish_ack frame type tag (server-signed downlink).
pub const FINISH_ACK_FRAME_TYPE: &str = "run_finish_ack";

/// The closed verdict code set (control-design §6.4, `device_run_finish_reject_code_check`).
/// These are ack-body codes, NOT the operation_resolution state set — §3.1 keeps the two closed
/// sets apart, and the four finish codes never appear on a resolution frame.
pub const FINISH_REJECT_CODES: &[&str] = &[
    "run_cancel_requested",
    "stale_fence",
    "finish_state_mismatch",
    "finish_precondition_failed",
];

/// The run_finish body: one proposal, idempotent by `finish_id`. §3.4 step 3 requires a lost ack
/// to be repaired by re-sending the SAME finish_id and the SAME signed bytes — ES256 is
/// randomized, so re-signing produces a different payload hash and the server answers
/// `idempotency_key_conflict`. The durable copy lives in the journal `runtime_finish` row.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunFinishBody {
    pub finish_id: String,
    pub run_id: String,
    #[serde(with = "u64string")]
    pub binding_revision: u64,
    #[serde(with = "u64string")]
    pub fence: u64,
    pub lease_id: String,
    pub outcome: String,
    pub reason_code: Option<String>,
    #[serde(with = "u64string")]
    pub final_checkpoint_seq: u64,
    pub final_checkpoint_hash: String,
    #[serde(with = "u64string")]
    pub receipt_through_seq: u64,
    pub final_operation_set_hash: String,
    pub deliverable_versions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl RunFinishBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("run_finish serializes")
    }

    /// Stamp the judged outcome onto the proposal. `Completed` carries no reason; `Failed`
    /// carries one from the closed set (§3.4 step 2).
    pub fn apply_outcome(&mut self, outcome: &Outcome) {
        match outcome {
            Outcome::Completed => {
                self.outcome = "completed".into();
                self.reason_code = None;
            }
            Outcome::Failed { reason_code } => {
                self.outcome = "failed".into();
                self.reason_code = Some(reason_code.clone());
            }
        }
    }

    /// Whether the outcome/reason pairing is inside the closed sets the server enforces
    /// (0042:1954-1963). A completed proposal with a reason, or a failed one without a known
    /// reason, is invalid_request — never a verdict.
    pub fn outcome_consistent(&self) -> bool {
        match self.outcome.as_str() {
            "completed" => self.reason_code.is_none(),
            "failed" => match &self.reason_code {
                Some(reason) => REASON_CODES.contains(&reason.as_str()),
                None => false,
            },
            _ => false,
        }
    }

    /// Sign the body and set its `signature` field.
    pub fn sign(&mut self, key: &dyn DeviceKey) -> Result<(), sign::SignError> {
        let value = self.to_value();
        self.signature = Some(sign::sign_frame(key, FINISH_FRAME_TYPE, &value)?);
        Ok(())
    }
}

/// One Operation the server reports as still blocking the Run, carried by a
/// `finish_state_mismatch` ack so the device knows exactly which receipts to repair (§6.4 step 3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnresolvedOperation {
    pub operation_id: String,
    pub state: String,
}

/// The run_finish_ack body: the control plane's verdict on one proposal.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunFinishAckBody {
    pub finish_id: String,
    pub state: String,
    pub code: Option<String>,
    #[serde(with = "u64string::opt")]
    pub terminal_run_revision: Option<u64>,
    pub expected_operation_set_hash: String,
    pub unresolved_operations: Vec<UnresolvedOperation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl RunFinishAckBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("run_finish_ack serializes")
    }

    /// Verify the server signature over the verdict. Fail-closed: an unsigned or unverifiable
    /// ack must never move the journal (GW8 precedent, no optional-signature shim).
    pub fn verify(&self, jwk: &EcP256Jwk) -> bool {
        match &self.signature {
            Some(sig) => sign::verify_frame(jwk, FINISH_ACK_FRAME_TYPE, &self.to_value(), sig),
            None => false,
        }
    }

    /// Whether the verdict is an acceptance, which is the only thing that makes the Run terminal
    /// locally and releases the cleanup watermark (§3.4 step 4, B03 carrier §3.2).
    pub fn is_accepted(&self) -> bool {
        self.state == "accepted"
    }

    /// Whether the verdict is internally consistent with the server's own row shape
    /// (`device_run_finish_verdict_shape`): accepted carries a terminal revision and no code,
    /// rejected carries a known code and no revision.
    pub fn verdict_consistent(&self) -> bool {
        match self.state.as_str() {
            "accepted" => self.code.is_none() && self.terminal_run_revision.is_some(),
            "rejected" => {
                self.terminal_run_revision.is_none()
                    && match &self.code {
                        Some(code) => FINISH_REJECT_CODES.contains(&code.as_str()),
                        None => false,
                    }
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SoftwareKey;

    fn proposal() -> RunFinishBody {
        RunFinishBody {
            finish_id: "finish-1".into(),
            run_id: "run-1".into(),
            binding_revision: 1,
            fence: 2,
            lease_id: "lease-1".into(),
            outcome: "failed".into(),
            reason_code: Some("model_error".into()),
            final_checkpoint_seq: 4,
            final_checkpoint_hash: "a".repeat(64),
            receipt_through_seq: 9,
            final_operation_set_hash: "b".repeat(64),
            deliverable_versions: vec![],
            signature: None,
        }
    }

    fn ack(state: &str, code: Option<&str>, revision: Option<u64>) -> RunFinishAckBody {
        RunFinishAckBody {
            finish_id: "finish-1".into(),
            state: state.into(),
            code: code.map(str::to_string),
            terminal_run_revision: revision,
            expected_operation_set_hash: "b".repeat(64),
            unresolved_operations: vec![],
            signature: None,
        }
    }

    #[test]
    fn finish_wire_shape_is_closed_and_decimal_strings() {
        let mut body = proposal();
        let value = body.to_value();
        let obj = value.as_object().unwrap();
        // §3.1 lists thirteen keys including device_signature; unsigned the signature is absent,
        // and reason_code is present because this is a failed proposal.
        assert_eq!(obj.len(), 12);
        assert_eq!(obj["binding_revision"], "1");
        assert_eq!(obj["fence"], "2");
        assert_eq!(obj["final_checkpoint_seq"], "4");
        assert_eq!(obj["receipt_through_seq"], "9");
        assert!(obj["deliverable_versions"].is_array());
        assert!(!obj.contains_key("signature"));
        let round: RunFinishBody = serde_json::from_value(value).unwrap();
        assert_eq!(round.receipt_through_seq, 9);
        assert!(round.outcome_consistent());

        body.sign(&SoftwareKey::random()).unwrap();
        assert_eq!(body.to_value().as_object().unwrap().len(), 13);
        // A completed proposal keeps the reason key as null (the server's eight-key element
        // demands the key be present), so the unsigned body is still twelve keys.
        body.apply_outcome(&Outcome::Completed);
        body.signature = None;
        let completed = body.to_value();
        assert_eq!(completed.as_object().unwrap().len(), 12);
        assert!(completed["reason_code"].is_null());
    }

    #[test]
    fn finish_rejects_float_and_number_boundaries() {
        let mut obj = proposal().to_value();
        obj["fence"] = serde_json::json!(2.0);
        assert!(serde_json::from_value::<RunFinishBody>(obj.clone()).is_err());
        obj["fence"] = serde_json::json!(2);
        assert!(serde_json::from_value::<RunFinishBody>(obj).is_err());
    }

    #[test]
    fn outcome_pairing_is_the_closed_set() {
        let mut body = proposal();
        body.apply_outcome(&Outcome::Completed);
        assert_eq!(body.outcome, "completed");
        assert!(body.reason_code.is_none());
        assert!(body.outcome_consistent());
        // A completed proposal that still carries a reason is invalid_request, not a verdict.
        body.reason_code = Some("model_error".into());
        assert!(!body.outcome_consistent());

        body.apply_outcome(&Outcome::Failed {
            reason_code: "no_deliverable".into(),
        });
        assert!(body.outcome_consistent());
        body.reason_code = Some("made_up".into());
        assert!(!body.outcome_consistent());
        body.reason_code = None;
        assert!(!body.outcome_consistent());
    }

    #[test]
    fn finish_signature_is_bound_to_its_frame_type() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut body = proposal();
        body.sign(&key).unwrap();
        let value = body.to_value();
        let sig = body.signature.clone().unwrap();
        assert!(sign::verify_frame(&jwk, FINISH_FRAME_TYPE, &value, &sig));
        // The same bytes must not verify as the ack: the two directions are domain-separated.
        assert!(!sign::verify_frame(
            &jwk,
            FINISH_ACK_FRAME_TYPE,
            &value,
            &sig
        ));
    }

    #[test]
    fn ack_keeps_null_keys_so_round_trip_reproduces_signed_bytes() {
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        for mut body in [
            ack("accepted", None, Some(7)),
            ack("rejected", Some("finish_state_mismatch"), None),
        ] {
            let unsigned = body.to_value();
            body.signature =
                Some(sign::sign_frame(&server, FINISH_ACK_FRAME_TYPE, &unsigned).unwrap());
            assert!(body.verify(&jwk));
            // Deserialize then re-render: the null keys must survive, or the JCS preimage
            // changes and the signature stops verifying.
            let round: RunFinishAckBody = serde_json::from_value(body.to_value()).unwrap();
            assert!(round.verify(&jwk));
            assert!(round.verdict_consistent());
            let obj = round.to_value();
            assert_eq!(obj.as_object().unwrap().len(), 7);
        }
    }

    #[test]
    fn ack_is_fail_closed_and_type_bound() {
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        let mut body = ack("accepted", None, Some(7));
        // Unsigned: never trusted.
        assert!(!body.verify(&jwk));
        let unsigned = body.to_value();
        body.signature = Some(sign::sign_frame(&server, FINISH_ACK_FRAME_TYPE, &unsigned).unwrap());
        assert!(body.verify(&jwk));
        // Signed as a different frame type: refused.
        let mut wrong = ack("accepted", None, Some(7));
        wrong.signature = Some(
            sign::sign_frame(
                &server,
                crate::frame::offer::OFFER_FRAME_TYPE,
                &wrong.to_value(),
            )
            .unwrap(),
        );
        assert!(!wrong.verify(&jwk));
        // Tampered verdict: refused.
        let mut tampered = body.clone();
        tampered.terminal_run_revision = Some(8);
        assert!(!tampered.verify(&jwk));
        // A foreign key: refused.
        assert!(!body.verify(&SoftwareKey::random().public_jwk()));
    }

    #[test]
    fn ack_verdict_shape_matches_the_server_row() {
        assert!(ack("accepted", None, Some(7)).verdict_consistent());
        assert!(!ack("accepted", None, None).verdict_consistent());
        assert!(!ack("accepted", Some("stale_fence"), Some(7)).verdict_consistent());
        for code in FINISH_REJECT_CODES {
            assert!(ack("rejected", Some(code), None).verdict_consistent());
        }
        assert!(!ack("rejected", None, None).verdict_consistent());
        assert!(!ack("rejected", Some("made_up"), None).verdict_consistent());
        assert!(!ack("rejected", Some("stale_fence"), Some(7)).verdict_consistent());
        assert!(!ack("pending", None, None).verdict_consistent());
    }

    #[test]
    fn ack_revision_crosses_as_decimal_string_at_u64_max() {
        let mut body = ack("accepted", None, Some(u64::MAX));
        let value = body.to_value();
        assert_eq!(value["terminal_run_revision"], "18446744073709551615");
        let round: RunFinishAckBody = serde_json::from_value(value).unwrap();
        assert_eq!(round.terminal_run_revision, Some(u64::MAX));
        body.terminal_run_revision = Some(9_007_199_254_740_993);
        let round: RunFinishAckBody = serde_json::from_value(body.to_value()).unwrap();
        assert_eq!(round.terminal_run_revision, Some(9_007_199_254_740_993));
        // A float revision is refused at the boundary.
        let mut obj = ack("accepted", None, Some(7)).to_value();
        obj["terminal_run_revision"] = serde_json::json!(7.0);
        assert!(serde_json::from_value::<RunFinishAckBody>(obj).is_err());
    }

    #[test]
    fn mismatch_ack_carries_the_repair_material() {
        let mut body = ack("rejected", Some("finish_state_mismatch"), None);
        body.expected_operation_set_hash = "c".repeat(64);
        body.unresolved_operations = vec![UnresolvedOperation {
            operation_id: "op-1".into(),
            state: "dispatching".into(),
        }];
        let round: RunFinishAckBody = serde_json::from_value(body.to_value()).unwrap();
        assert_eq!(round.expected_operation_set_hash, "c".repeat(64));
        assert_eq!(round.unresolved_operations.len(), 1);
        assert_eq!(round.unresolved_operations[0].state, "dispatching");
        assert!(!round.is_accepted());
    }
}
