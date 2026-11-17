//! The command downlink (device-design §3.1 command row, §3.3). A command is the control plane's
//! instruction to execute ONE already-authorized action, and it carries the permit that authorizes
//! it. Both layers are SERVER-signed and both are verified here fail-closed, against TWO different
//! keys provisioned from hello_ack:
//!
//!   - the frame against `server_public_jwk` under the `command` domain;
//!   - the nested permit against `permit_public_jwk` under the `permit` domain (§3.3's independent
//!     permit signing key). A permit that verifies under the frame key is refused: one key for both
//!     would collapse the separation between "the server said this" and "the server authorized this".
//!
//! §3.1's row lists nine body keys and no signature member; the tenth (`signature`) is the ruled
//! 主签 2026-11-17 addition, because an unattributable execution instruction is exactly what GW8
//! ruled against for acks. `local_payload_ref` names parameters the device already prepared
//! locally — the cloud cannot inject unpreviewed ones, so it is cross-checked against the local
//! action rather than trusted as an instruction.
//!
//! There is no command_ack (§3.1): delivery is confirmed by the device's receipt, and a re-sent
//! command whose `jti` is already consumed returns the journal instead of executing again (§3.3).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::sign;
use crate::jwk::EcP256Jwk;
use crate::permit::signed::{PermitContext, PermitError, SignedPermit};

/// The command frame type tag (server-signed downlink).
pub const COMMAND_FRAME_TYPE: &str = "command";

/// The closed command body: §3.1's nine keys plus the server signature.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommandBody {
    pub command_id: String,
    pub run_id: String,
    pub operation_id: String,
    pub logical_key: String,
    pub dispatch_attempt_id: String,
    pub request_hash: String,
    pub tool_schema: String,
    pub local_payload_ref: String,
    pub permit: SignedPermit,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl CommandBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("command serializes")
    }

    /// Verify the server's frame signature. Fail-closed: an unsigned or unverifiable command must
    /// never reach the journal, let alone the sidecar.
    pub fn verify(&self, server_jwk: &EcP256Jwk) -> bool {
        match &self.signature {
            Some(sig) => sign::verify_frame(server_jwk, COMMAND_FRAME_TYPE, &self.to_value(), sig),
            None => false,
        }
    }

    /// Verify the nested permit against the INDEPENDENT permit key carried by `ctx` and the
    /// device's own identity/fence/clock. This is the authorization layer: the frame signature
    /// only says the server sent it.
    pub fn verify_permit(&self, ctx: &PermitContext) -> Result<(), PermitError> {
        self.permit.validate(ctx)
    }

    /// Whether the permit authorizes exactly the action this command names. The two documents are
    /// assembled by the server from the same dispatch row, so a mismatch means the frame was built
    /// from two different actions — and executing it would run an action under another's authority.
    pub fn permit_matches_command(&self) -> bool {
        self.permit.run_id == self.run_id
            && self.permit.operation_id == self.operation_id
            && self.permit.dispatch_attempt_id == self.dispatch_attempt_id
            && self.permit.request_hash == self.request_hash
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::rfc3339::parse_utc_seconds;
    use crate::key::{DeviceKey, SoftwareKey};
    use crate::permit::signed::{AUD_DEVICE_TOOL, FRAME_TYPE as PERMIT_FRAME_TYPE};
    use crate::thumbprint::device_key_thumbprint;

    const ISSUED: &str = "2026-11-17T12:00:00Z";
    const EXPIRES: &str = "2026-11-17T12:00:05Z";

    fn permit(key: &dyn DeviceKey) -> SignedPermit {
        let mut p = SignedPermit {
            v: 2,
            aud: AUD_DEVICE_TOOL.into(),
            kid: device_key_thumbprint(&key.public_jwk()),
            jti: "jti-1".into(),
            org_id: "org".into(),
            subject_id: "sub".into(),
            device_id: "dev".into(),
            session_id: "sess".into(),
            agent_instance_id: "agent".into(),
            boot_id: "boot".into(),
            generation: 1,
            run_id: "run".into(),
            operation_id: "op".into(),
            dispatch_attempt_id: "attempt".into(),
            request_hash: "hash".into(),
            fence: 2,
            policy_epoch: 1,
            access_epoch: 1,
            grant_id: "grant".into(),
            grant_revision: 1,
            approval_id: None,
            decision_revision: None,
            scope_hash: "scope".into(),
            destination_id: None,
            max_bytes: 1024,
            issued_at: ISSUED.into(),
            expires_at: EXPIRES.into(),
            signature: None,
        };
        p.signature = Some(sign::sign_frame(key, PERMIT_FRAME_TYPE, &p.to_value()).unwrap());
        p
    }

    fn command(server: &dyn DeviceKey, permit_key: &dyn DeviceKey) -> CommandBody {
        let mut c = CommandBody {
            command_id: "cmd-1".into(),
            run_id: "run".into(),
            operation_id: "op".into(),
            logical_key: "step#0".into(),
            dispatch_attempt_id: "attempt".into(),
            request_hash: "hash".into(),
            tool_schema: "read-v1".into(),
            local_payload_ref: "local/payload".into(),
            permit: permit(permit_key),
            signature: None,
        };
        c.signature = Some(sign::sign_frame(server, COMMAND_FRAME_TYPE, &c.to_value()).unwrap());
        c
    }

    fn ctx(key: &EcP256Jwk) -> PermitContext<'_> {
        PermitContext {
            server_permit_key: key,
            org_id: "org",
            subject_id: "sub",
            device_id: "dev",
            session_id: "sess",
            run_fence: 2,
            now_unix: parse_utc_seconds(ISSUED).unwrap() + 1,
            remaining_lease_secs: 30,
        }
    }

    #[test]
    fn wire_shape_is_the_closed_ten_keys() {
        let server = SoftwareKey::random();
        let permit_key = SoftwareKey::random();
        let mut c = command(&server, &permit_key);
        let value = c.to_value();
        let obj = value.as_object().unwrap();
        assert_eq!(obj.len(), 10);
        assert_eq!(obj["permit"].as_object().unwrap().len(), 28);
        // The readonly permit's null keys survive, so the nested JCS preimage is reproducible.
        assert!(obj["permit"]["approval_id"].is_null());
        assert!(obj["permit"]["decision_revision"].is_null());
        assert!(obj["permit"]["destination_id"].is_null());
        c.signature = None;
        assert_eq!(c.to_value().as_object().unwrap().len(), 9);
    }

    #[test]
    fn both_layers_verify_and_round_trip() {
        let server = SoftwareKey::random();
        let permit_key = SoftwareKey::random();
        let c = command(&server, &permit_key);
        assert!(c.verify(&server.public_jwk()));
        assert_eq!(c.verify_permit(&ctx(&permit_key.public_jwk())), Ok(()));
        assert!(c.permit_matches_command());
        let round: CommandBody = serde_json::from_value(c.to_value()).unwrap();
        assert!(round.verify(&server.public_jwk()));
        assert_eq!(round.verify_permit(&ctx(&permit_key.public_jwk())), Ok(()));
    }

    #[test]
    fn the_two_keys_are_not_interchangeable() {
        let server = SoftwareKey::random();
        let permit_key = SoftwareKey::random();
        let c = command(&server, &permit_key);
        // The permit must NOT verify under the frame key, nor the frame under the permit key.
        assert_eq!(
            c.verify_permit(&ctx(&server.public_jwk())),
            Err(PermitError::Signature)
        );
        assert!(!c.verify(&permit_key.public_jwk()));
    }

    #[test]
    fn frame_signature_is_fail_closed_and_type_bound() {
        let server = SoftwareKey::random();
        let permit_key = SoftwareKey::random();
        let mut c = command(&server, &permit_key);
        let jwk = server.public_jwk();
        assert!(c.verify(&jwk));
        // Unsigned: never trusted.
        let mut unsigned = c.clone();
        unsigned.signature = None;
        assert!(!unsigned.verify(&jwk));
        // Signed as a different frame type: refused.
        let mut wrong = command(&server, &permit_key);
        wrong.signature = None;
        wrong.signature = Some(
            sign::sign_frame(
                &server,
                crate::frame::action::ACTION_PREPARED_FRAME_TYPE,
                &wrong.to_value(),
            )
            .unwrap(),
        );
        assert!(!wrong.verify(&jwk));
        // Tampered payload reference: refused.
        c.local_payload_ref = "local/other".into();
        assert!(!c.verify(&jwk));
        // A foreign frame key: refused.
        let fresh = command(&server, &permit_key);
        assert!(!fresh.verify(&SoftwareKey::random().public_jwk()));
    }

    #[test]
    fn a_permit_for_another_action_is_refused() {
        let server = SoftwareKey::random();
        let permit_key = SoftwareKey::random();
        let mut c = command(&server, &permit_key);
        assert!(c.permit_matches_command());
        // The permit still verifies cryptographically, but it authorizes a different action.
        c.operation_id = "op-other".into();
        assert!(!c.permit_matches_command());
        c.operation_id = "op".into();
        c.request_hash = "other-hash".into();
        assert!(!c.permit_matches_command());
        c.request_hash = "hash".into();
        c.dispatch_attempt_id = "attempt-2".into();
        assert!(!c.permit_matches_command());
    }

    #[test]
    fn an_expired_permit_is_refused_even_with_a_valid_frame() {
        let server = SoftwareKey::random();
        let permit_key = SoftwareKey::random();
        let c = command(&server, &permit_key);
        let jwk = permit_key.public_jwk();
        let mut late = ctx(&jwk);
        late.now_unix = parse_utc_seconds(EXPIRES).unwrap();
        // The frame signature is still valid: the refusal comes from the authorization layer.
        assert!(c.verify(&server.public_jwk()));
        assert_eq!(c.verify_permit(&late), Err(PermitError::Expired));
    }

    #[test]
    fn permit_uint64_fields_cross_as_decimal_strings() {
        let server = SoftwareKey::random();
        let permit_key = SoftwareKey::random();
        let mut c = command(&server, &permit_key);
        c.permit.fence = u64::MAX;
        c.permit.max_bytes = 9_007_199_254_740_993;
        c.permit.decision_revision = Some(u64::MAX);
        c.permit.signature = None;
        c.permit.signature =
            Some(sign::sign_frame(&permit_key, PERMIT_FRAME_TYPE, &c.permit.to_value()).unwrap());
        c.signature = None;
        c.signature = Some(sign::sign_frame(&server, COMMAND_FRAME_TYPE, &c.to_value()).unwrap());
        let value = c.to_value();
        assert_eq!(value["permit"]["fence"], "18446744073709551615");
        assert_eq!(value["permit"]["max_bytes"], "9007199254740993");
        assert_eq!(value["permit"]["decision_revision"], "18446744073709551615");
        let round: CommandBody = serde_json::from_value(value).unwrap();
        assert_eq!(round.permit.fence, u64::MAX);
        assert_eq!(round.permit.decision_revision, Some(u64::MAX));
        assert!(round.verify(&server.public_jwk()));
        // A float at the boundary is refused, not silently truncated.
        let mut bad = round.to_value();
        bad["permit"]["fence"] = serde_json::json!(2.0);
        assert!(serde_json::from_value::<CommandBody>(bad).is_err());
    }
}
