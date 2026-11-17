//! The action_prepare / action_prepared bodies (device-design §3.1 action_prepare row, §3.4).
//! `action_prepare` is DEVICE-signed: the Broker proposes an action it has NOT executed, and the
//! control plane creates the Operation and its Approval (or consumes a readonly grant) without
//! dispatching anything. `action_prepared` is SERVER-signed and verified here against the
//! hello_ack `server_public_jwk`: the Operation identity, the attempt_id and the classification
//! are the control plane's facts, so a result the device cannot attribute must not be acted on.
//!
//! Two wire rulings (主签 2026-11-17, annotated in §3.1, original text preserved):
//!   * the closed body carries `lease_id` and `fence`. The design row listed neither, but
//!     prepare_local_operation requires an execute lease and compares the fence against BOTH
//!     run.fence and lease.fence before raising stale_fence (0042:855-864). A device that cannot
//!     name its lease and fence could never be refused as stale.
//!   * the ack is the closed FOURTEEN-key set: the command's thirteen response keys plus
//!     `signature`. §3.1's row lists four, but `attempt_id` is a required argument of
//!     consume_device_permit, so four keys left the next step uncallable.
//!
//! `supersede_no` is NOT a wire key: SQL forces logical_key = step_key || '#' || supersede_no
//! (0042:774) and the gateway derives it, so the device only sends the logical_key it allocated.
//!
//! Every optional key is serialized as null rather than omitted. SQL's validator counts keys
//! (twenty for the action, 0042:521-535), and omitting a null would also change the JCS preimage
//! so a deserialize→to_value round trip would stop reproducing the signed bytes (GW12 lesson).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::jwk::EcP256Jwk;
use crate::key::DeviceKey;

/// The action_prepare frame type tag (device-signed uplink).
pub const ACTION_PREPARE_FRAME_TYPE: &str = "action_prepare";
/// The action_prepared frame type tag (server-signed downlink).
pub const ACTION_PREPARED_FRAME_TYPE: &str = "action_prepared";

/// The closed supersede reason set (device-design §3.5, widened to six by 0042:79-83).
pub const SUPERSEDE_REASONS: &[&str] = &[
    "reauthorized",
    "approval_expired",
    "source_changed",
    "resend_undelivered",
    "workspace_rebound",
    "tool_params_changed",
];

/// The closed changed_fields set (device-design §3.5). There is no `destination`: changing the
/// destination is a new step_key, not a supersede.
pub const CHANGED_FIELDS: &[&str] = &["grant", "entry_ref", "source_identity", "params", "none"];

/// The closed action_kind set the server accepts (0042:766-768).
pub const ACTION_KINDS: &[&str] = &[
    "workspace.list",
    "workspace.read",
    "workspace.search",
    "artifact.write",
    "model.send_remote",
    "model.send_device_local",
];

/// The SupersedeAssertion (device-design §3.5): the device's own accountable statement of what a
/// supersede changed. It travels inside the action_prepare body, so the frame signature covers
/// it; SQL stores only its hash in operation.supersede_assertion_hash and keeps the original
/// document in the audit payload. The fourteen keys are the closed set 0042:1046-1052 demands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupersedeAssertion {
    pub v: u32,
    pub run_id: String,
    pub old_operation_id: String,
    pub new_operation_id: String,
    pub old_request_hash: String,
    pub new_request_hash: String,
    pub reason: String,
    pub changed_fields: Vec<String>,
    pub device_id: String,
    pub session_id: String,
    pub auth_plane: String,
    #[serde(with = "u64string")]
    pub auth_epoch: u64,
    pub nonce: String,
    /// RFC 8785 / §3.1 wall-clock expiry, the same form the lease and offer frames carry.
    pub expires_at: String,
}

impl SupersedeAssertion {
    /// Whether the reason and changed_fields are inside the closed sets and pair the way SQL
    /// decides them (0042:1015-1028). The server also checks the succession row and the bucket
    /// counts, which only it can see; this is the part the device can know before sending.
    pub fn consistent(&self) -> bool {
        if !SUPERSEDE_REASONS.contains(&self.reason.as_str()) {
            return false;
        }
        if self.changed_fields.is_empty() {
            return false;
        }
        let mut sorted = self.changed_fields.clone();
        sorted.sort();
        sorted.dedup();
        if sorted.len() != self.changed_fields.len() {
            return false;
        }
        if !self
            .changed_fields
            .iter()
            .all(|field| CHANGED_FIELDS.contains(&field.as_str()))
        {
            return false;
        }
        let has = |field: &str| self.changed_fields.iter().any(|f| f == field);
        match self.reason.as_str() {
            "workspace_rebound" => has("grant") && has("entry_ref"),
            "tool_params_changed" => has("params"),
            "source_changed" => has("source_identity"),
            "resend_undelivered" | "approval_expired" => has("none"),
            "reauthorized" => has("grant"),
            _ => false,
        }
    }
}

/// The action_prepare body: one proposed action, idempotent by (org, run, logical_key) on the
/// server — NOT by prepare_id (O-9 = jia). A lost ack is repaired by re-sending the SAME signed
/// bytes, because ES256 is randomized and a fresh signature is a different payload.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActionPrepareBody {
    pub prepare_id: String,
    pub run_id: String,
    pub lease_id: String,
    #[serde(with = "u64string")]
    pub fence: u64,
    pub step_key: String,
    pub logical_key: String,
    pub supersedes_operation_id: Option<String>,
    pub supersede_reason: Option<String>,
    pub supersede_assertion: Option<SupersedeAssertion>,
    #[serde(with = "u64string")]
    pub checkpoint_seq: u64,
    pub checkpoint_hash: String,
    pub request_hash: String,
    pub action_kind: String,
    pub tool_schema: String,
    pub local_payload_ref: String,
    pub grant_id: String,
    #[serde(with = "u64string")]
    pub grant_revision: u64,
    pub resource_selector_hash: String,
    pub classification: String,
    pub destination_id: Option<String>,
    #[serde(with = "u64string")]
    pub byte_upper_bound: u64,
    #[serde(with = "u64string")]
    pub token_upper_bound: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl ActionPrepareBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("action_prepare serializes")
    }

    /// Whether the body is inside the closed sets SQL enforces before it writes anything.
    /// The three supersede keys must all be present or all be null (0042:777-780), a fresh
    /// action's logical_key must end in #0, and only a model action may name a destination
    /// (0042:786-793).
    pub fn shape_consistent(&self) -> bool {
        if !ACTION_KINDS.contains(&self.action_kind.as_str()) {
            return false;
        }
        let supersede = self.supersedes_operation_id.is_some();
        if supersede != self.supersede_reason.is_some()
            || supersede != self.supersede_assertion.is_some()
        {
            return false;
        }
        let suffix = match self.logical_key.rsplit_once('#') {
            Some((step, no)) => {
                if step != self.step_key {
                    return false;
                }
                match no.parse::<u64>() {
                    Ok(no) => no,
                    Err(_) => return false,
                }
            }
            None => return false,
        };
        if supersede {
            if suffix < 1 {
                return false;
            }
            match (&self.supersede_reason, &self.supersede_assertion) {
                (Some(reason), Some(assertion)) => {
                    if assertion.reason != *reason || !assertion.consistent() {
                        return false;
                    }
                }
                _ => return false,
            }
        } else if suffix != 0 {
            return false;
        }
        let model = self.action_kind == "model.send_remote"
            || self.action_kind == "model.send_device_local";
        if model != self.destination_id.is_some() {
            return false;
        }
        if let Some(destination) = &self.destination_id {
            if !["device_local", "org_private", "org_remote"].contains(&destination.as_str()) {
                return false;
            }
        }
        true
    }

    /// Sign the body and set its `signature` field.
    pub fn sign(&mut self, key: &dyn DeviceKey) -> Result<(), sign::SignError> {
        let value = self.to_value();
        self.signature = Some(sign::sign_frame(key, ACTION_PREPARE_FRAME_TYPE, &value)?);
        Ok(())
    }
}

/// The action_prepared body: the control plane's result for one proposal. The device acts on
/// `attempt_id` (it is consume_device_permit's required argument) and cross-checks
/// `classification` / `destination_id` against its own action — the server's value is the
/// authority, and a device claim below it was already refused as classification_floor_required.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActionPreparedBody {
    pub operation_id: String,
    pub logical_key: String,
    pub step_key: String,
    #[serde(with = "u64string")]
    pub supersede_no: u64,
    pub state: String,
    #[serde(with = "u64string")]
    pub revision: u64,
    pub approval_id: Option<String>,
    pub auto_approved: bool,
    pub request_hash: String,
    pub attempt_id: String,
    #[serde(with = "u64string")]
    pub checkpoint_seq: u64,
    pub classification: String,
    pub destination_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl ActionPreparedBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("action_prepared serializes")
    }

    /// Verify the server signature over the result. Fail-closed: an unsigned or unverifiable
    /// ack must never be acted on (GW8 precedent, no optional-signature shim).
    pub fn verify(&self, jwk: &EcP256Jwk) -> bool {
        match &self.signature {
            Some(sig) => sign::verify_frame(jwk, ACTION_PREPARED_FRAME_TYPE, &self.to_value(), sig),
            None => false,
        }
    }

    /// Whether the Operation is authorized and may proceed to a permit. prepare never dispatches:
    /// an authorized Operation still needs consume_device_permit's single CAS.
    pub fn is_authorized(&self) -> bool {
        self.state == "authorized"
    }

    /// Whether the action is parked on a manual approval (ask_each, the default).
    pub fn needs_approval(&self) -> bool {
        self.state == "waiting_approval"
    }

    /// Whether the result is internally consistent with the three states prepare can leave an
    /// Operation in: an auto-approved action carries no Approval, an ask_each action carries one.
    pub fn state_consistent(&self) -> bool {
        match self.state.as_str() {
            "authorized" => self.auto_approved && self.approval_id.is_none(),
            "waiting_approval" => !self.auto_approved && self.approval_id.is_some(),
            "prepared" => !self.auto_approved && self.approval_id.is_none(),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SoftwareKey;

    fn assertion(reason: &str, fields: &[&str]) -> SupersedeAssertion {
        SupersedeAssertion {
            v: 2,
            run_id: "run-1".into(),
            old_operation_id: "op-old".into(),
            new_operation_id: "op-new".into(),
            old_request_hash: "a".repeat(64),
            new_request_hash: "b".repeat(64),
            reason: reason.into(),
            changed_fields: fields.iter().map(|f| f.to_string()).collect(),
            device_id: "dev-1".into(),
            session_id: "sess-1".into(),
            auth_plane: "bearer".into(),
            auth_epoch: 7,
            nonce: "nonce-1".into(),
            expires_at: "2026-11-17T00:01:00Z".into(),
        }
    }

    fn proposal() -> ActionPrepareBody {
        ActionPrepareBody {
            prepare_id: "prepare-1".into(),
            run_id: "run-1".into(),
            lease_id: "lease-1".into(),
            fence: 2,
            step_key: "tool:1".into(),
            logical_key: "tool:1#0".into(),
            supersedes_operation_id: None,
            supersede_reason: None,
            supersede_assertion: None,
            checkpoint_seq: 0,
            checkpoint_hash: "c".repeat(64),
            request_hash: "d".repeat(64),
            action_kind: "workspace.read".into(),
            tool_schema: "read-v1".into(),
            local_payload_ref: "local/payload".into(),
            grant_id: "grant-1".into(),
            grant_revision: 1,
            resource_selector_hash: "e".repeat(64),
            classification: "local_only".into(),
            destination_id: None,
            byte_upper_bound: 1024,
            token_upper_bound: 64,
            signature: None,
        }
    }

    fn prepared(state: &str, approval: Option<&str>, auto: bool) -> ActionPreparedBody {
        ActionPreparedBody {
            operation_id: "op-1".into(),
            logical_key: "tool:1#0".into(),
            step_key: "tool:1".into(),
            supersede_no: 0,
            state: state.into(),
            revision: 2,
            approval_id: approval.map(str::to_string),
            auto_approved: auto,
            request_hash: "d".repeat(64),
            attempt_id: "attempt-1".into(),
            checkpoint_seq: 0,
            classification: "local_only".into(),
            destination_id: None,
            signature: None,
        }
    }

    #[test]
    fn prepare_wire_shape_is_closed_and_decimal_strings() {
        let mut body = proposal();
        let value = body.to_value();
        let obj = value.as_object().unwrap();
        // Twenty-two keys unsigned: the twenty-key SQL element minus supersede_no (derived by
        // the gateway) minus device_signature, plus run_id/lease_id/fence/checkpoint_seq/signature.
        assert_eq!(obj.len(), 22);
        assert_eq!(obj["fence"], "2");
        assert_eq!(obj["checkpoint_seq"], "0");
        assert_eq!(obj["grant_revision"], "1");
        assert_eq!(obj["byte_upper_bound"], "1024");
        assert_eq!(obj["token_upper_bound"], "64");
        // The optional keys are present as null, not omitted: SQL counts keys.
        for key in [
            "supersedes_operation_id",
            "supersede_reason",
            "supersede_assertion",
            "destination_id",
        ] {
            assert!(obj.contains_key(key), "{key} must be present");
            assert!(obj[key].is_null(), "{key} must be null for a fresh action");
        }
        assert!(!obj.contains_key("signature"));
        assert!(!obj.contains_key("supersede_no"));
        assert!(body.shape_consistent());

        let round: ActionPrepareBody = serde_json::from_value(value).unwrap();
        assert_eq!(round.fence, 2);
        assert_eq!(round.byte_upper_bound, 1024);
        body.sign(&SoftwareKey::random()).unwrap();
        assert_eq!(body.to_value().as_object().unwrap().len(), 23);
    }

    #[test]
    fn prepare_rejects_float_and_number_boundaries() {
        let mut obj = proposal().to_value();
        obj["fence"] = serde_json::json!(2.0);
        assert!(serde_json::from_value::<ActionPrepareBody>(obj.clone()).is_err());
        obj["fence"] = serde_json::json!(2);
        assert!(serde_json::from_value::<ActionPrepareBody>(obj.clone()).is_err());
        obj["fence"] = serde_json::json!("18446744073709551615");
        let round: ActionPrepareBody = serde_json::from_value(obj).unwrap();
        assert_eq!(round.fence, u64::MAX);
    }

    #[test]
    fn prepare_signature_is_bound_to_its_frame_type() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut body = proposal();
        body.sign(&key).unwrap();
        let value = body.to_value();
        let sig = body.signature.clone().unwrap();
        assert!(sign::verify_frame(
            &jwk,
            ACTION_PREPARE_FRAME_TYPE,
            &value,
            &sig
        ));
        // The same bytes must not verify as the ack: the two directions are domain-separated.
        assert!(!sign::verify_frame(
            &jwk,
            ACTION_PREPARED_FRAME_TYPE,
            &value,
            &sig
        ));
    }

    #[test]
    fn supersede_triple_is_all_or_nothing() {
        let mut body = proposal();
        body.logical_key = "tool:1#1".into();
        // A supersede id without its reason and assertion is invalid_request, not a new action.
        body.supersedes_operation_id = Some("op-old".into());
        assert!(!body.shape_consistent());
        body.supersede_reason = Some("reauthorized".into());
        assert!(!body.shape_consistent());
        body.supersede_assertion = Some(assertion("reauthorized", &["grant"]));
        assert!(body.shape_consistent());
        // A fresh action must be #0 and carry no supersede material.
        let mut fresh = proposal();
        fresh.logical_key = "tool:1#1".into();
        assert!(!fresh.shape_consistent());
        // The assertion's reason must agree with the frame's.
        body.supersede_reason = Some("source_changed".into());
        assert!(!body.shape_consistent());
    }

    #[test]
    fn assertion_reason_and_changed_fields_pair_the_closed_way() {
        assert!(assertion("reauthorized", &["grant"]).consistent());
        assert!(assertion("workspace_rebound", &["grant", "entry_ref"]).consistent());
        assert!(assertion("tool_params_changed", &["params"]).consistent());
        assert!(assertion("source_changed", &["source_identity"]).consistent());
        assert!(assertion("resend_undelivered", &["none"]).consistent());
        assert!(assertion("approval_expired", &["none"]).consistent());
        // Missing the required field, an unknown field, a duplicate, an empty list and an
        // unknown reason are all refused.
        assert!(!assertion("workspace_rebound", &["grant"]).consistent());
        assert!(!assertion("tool_params_changed", &["none"]).consistent());
        assert!(!assertion("reauthorized", &["destination"]).consistent());
        assert!(!assertion("reauthorized", &["grant", "grant"]).consistent());
        assert!(!assertion("reauthorized", &[]).consistent());
        assert!(!assertion("made_up", &["grant"]).consistent());
        // `params` may only ride with tool_params_changed (§3.5).
        assert!(!assertion("source_changed", &["params"]).consistent());
    }

    #[test]
    fn only_a_model_action_names_a_destination() {
        let mut body = proposal();
        body.destination_id = Some("device_local".into());
        assert!(!body.shape_consistent());
        body.action_kind = "model.send_device_local".into();
        assert!(body.shape_consistent());
        body.destination_id = Some("made_up".into());
        assert!(!body.shape_consistent());
        body.destination_id = None;
        assert!(!body.shape_consistent());
        body.action_kind = "made_up".into();
        body.destination_id = Some("device_local".into());
        assert!(!body.shape_consistent());
    }

    #[test]
    fn ack_keeps_null_keys_so_round_trip_reproduces_signed_bytes() {
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        for mut body in [
            prepared("authorized", None, true),
            prepared("waiting_approval", Some("approval-1"), false),
        ] {
            let unsigned = body.to_value();
            assert_eq!(unsigned.as_object().unwrap().len(), 13);
            body.signature =
                Some(sign::sign_frame(&server, ACTION_PREPARED_FRAME_TYPE, &unsigned).unwrap());
            assert!(body.verify(&jwk));
            // Deserialize then re-render: the null keys must survive, or the JCS preimage
            // changes and the signature stops verifying.
            let round: ActionPreparedBody = serde_json::from_value(body.to_value()).unwrap();
            assert!(round.verify(&jwk));
            assert!(round.state_consistent());
            let obj = round.to_value();
            let map = obj.as_object().unwrap();
            assert_eq!(map.len(), 14);
            assert!(map.contains_key("approval_id"));
            assert!(map.contains_key("destination_id"));
            assert!(!map.contains_key("replayed"));
        }
    }

    #[test]
    fn ack_is_fail_closed_and_type_bound() {
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        let mut body = prepared("authorized", None, true);
        // Unsigned: never trusted.
        assert!(!body.verify(&jwk));
        let unsigned = body.to_value();
        body.signature =
            Some(sign::sign_frame(&server, ACTION_PREPARED_FRAME_TYPE, &unsigned).unwrap());
        assert!(body.verify(&jwk));
        // Signed as a different frame type: refused.
        let mut wrong = prepared("authorized", None, true);
        wrong.signature = Some(
            sign::sign_frame(
                &server,
                crate::frame::offer::OFFER_FRAME_TYPE,
                &wrong.to_value(),
            )
            .unwrap(),
        );
        assert!(!wrong.verify(&jwk));
        // Tampered attempt_id: refused. This is the field the next step consumes, so a device
        // that accepted a rewritten one would dispatch against the wrong attempt.
        let mut tampered = body.clone();
        tampered.attempt_id = "attempt-2".into();
        assert!(!tampered.verify(&jwk));
        // A foreign key: refused.
        assert!(!body.verify(&SoftwareKey::random().public_jwk()));
    }

    #[test]
    fn ack_state_matches_the_approval_fact() {
        assert!(prepared("authorized", None, true).is_authorized());
        assert!(prepared("authorized", None, true).state_consistent());
        assert!(prepared("waiting_approval", Some("a"), false).needs_approval());
        assert!(prepared("waiting_approval", Some("a"), false).state_consistent());
        assert!(prepared("prepared", None, false).state_consistent());
        // An authorized action that still names an Approval, or an ask_each action without one,
        // is not a shape the server produces.
        assert!(!prepared("authorized", Some("a"), true).state_consistent());
        assert!(!prepared("waiting_approval", None, false).state_consistent());
        assert!(!prepared("authorized", None, false).state_consistent());
        assert!(!prepared("dispatching", None, false).state_consistent());
    }

    #[test]
    fn ack_numbers_cross_as_decimal_strings_at_u64_max() {
        let mut body = prepared("authorized", None, true);
        body.revision = u64::MAX;
        body.supersede_no = 9_007_199_254_740_993;
        let value = body.to_value();
        assert_eq!(value["revision"], "18446744073709551615");
        assert_eq!(value["supersede_no"], "9007199254740993");
        let round: ActionPreparedBody = serde_json::from_value(value).unwrap();
        assert_eq!(round.revision, u64::MAX);
        assert_eq!(round.supersede_no, 9_007_199_254_740_993);
        let mut obj = prepared("authorized", None, true).to_value();
        obj["revision"] = serde_json::json!(7.0);
        assert!(serde_json::from_value::<ActionPreparedBody>(obj).is_err());
    }
}
