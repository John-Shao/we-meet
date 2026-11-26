//! The operation_resolution downlink and operation_resolution_ack uplink bodies
//! (device-design §3.1 operation_resolution row). A resolution is server-signed
//! and is the only way a device journal row leaves `unknown`. `state` and
//! `settlement_state` are closed sets the device may not propose; a degradation
//! terminal (`evidence_unavailable`/`evidence_exhausted`) never proves the action
//! was un-executed (invariant 2). The ack only advances the delivery watermark.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::jwk::EcP256Jwk;

/// The operation_resolution frame type tag (server-signed downlink).
pub const FRAME_TYPE: &str = "operation_resolution";
/// The operation_resolution_ack frame type tag (device uplink).
pub const ACK_FRAME_TYPE: &str = "operation_resolution_ack";

/// The closed resolution `state` set.
pub const RESOLUTION_STATES: &[&str] = &[
    "succeeded",
    "failed",
    "canceled",
    "rejected_not_executed",
    "undelivered",
    "sealed_not_sent",
];
/// The closed `settlement_state` set (= quota_reservation state, 0002:276).
pub const SETTLEMENT_STATES: &[&str] = &["held", "settled", "released", "unknown"];
/// The closed ack `state` set.
pub const ACK_STATES: &[&str] = &["applied", "journal_row_missing", "conflict"];

/// The closed resolution `delivery_state` set.
pub const DELIVERY_STATES: &[&str] = &["not_applicable", "delivered", "undelivered"];
/// The closed resolution `code` set. Both codes are degradation terminals and never
/// prove non-execution.
pub const DEGRADATION_CODES: &[&str] = &["evidence_unavailable", "evidence_exhausted"];

/// A resolution validation failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolutionError {
    State,
    DeliveryState,
    Code,
    SettlementState,
    UsageSource,
}

/// The operation_resolution body.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OperationResolutionBody {
    pub resolve_id: String,
    pub run_id: String,
    pub operation_id: String,
    pub attempt_id: String,
    pub state: String,
    pub delivery_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_source: Option<String>,
    pub settlement_state: String,
    #[serde(with = "u64string")]
    pub resolution_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl OperationResolutionBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("operation_resolution serializes")
    }

    /// Verify the server signature over the resolution body.
    pub fn verify(&self, jwk: &EcP256Jwk) -> bool {
        match &self.signature {
            Some(sig) => sign::verify_frame(jwk, FRAME_TYPE, &self.to_value(), sig),
            None => false,
        }
    }

    /// Validate the closed frame sets and the degradation invariants. A degradation
    /// terminal must remain `failed/unknown/unavailable`: it resolves the journal row
    /// but can never be interpreted as proof that the action did not execute.
    pub fn validate(&self) -> Result<(), ResolutionError> {
        if !RESOLUTION_STATES.contains(&self.state.as_str()) {
            return Err(ResolutionError::State);
        }
        if !DELIVERY_STATES.contains(&self.delivery_state.as_str()) {
            return Err(ResolutionError::DeliveryState);
        }
        if !SETTLEMENT_STATES.contains(&self.settlement_state.as_str()) {
            return Err(ResolutionError::SettlementState);
        }
        if let Some(code) = self.code.as_deref() {
            if !DEGRADATION_CODES.contains(&code) {
                return Err(ResolutionError::Code);
            }
            if self.state != "failed" || self.settlement_state != "unknown" {
                return Err(ResolutionError::SettlementState);
            }
            if self.usage_source.as_deref() != Some("unavailable") {
                return Err(ResolutionError::UsageSource);
            }
        }
        Ok(())
    }
}

/// The operation_resolution_ack body (device uplink).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResolutionAckBody {
    pub resolve_id: String,
    pub state: String,
}

impl ResolutionAckBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("operation_resolution_ack serializes")
    }

    /// Whether the ack state is in the closed set.
    pub fn state_valid(&self) -> bool {
        ACK_STATES.contains(&self.state.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::{DeviceKey, SoftwareKey};

    fn resolution(state: &str, settlement: &str) -> OperationResolutionBody {
        OperationResolutionBody {
            resolve_id: "res1".into(),
            run_id: "run".into(),
            operation_id: "op1".into(),
            attempt_id: "att1".into(),
            state: state.into(),
            delivery_state: "delivered".into(),
            code: None,
            usage_source: None,
            settlement_state: settlement.into(),
            resolution_revision: 5,
            signature: None,
        }
    }

    #[test]
    fn verifies_with_server_key_and_tamper_fails() {
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        let mut body = resolution("failed", "unknown");
        let sig = sign::sign_frame(&server, FRAME_TYPE, &body.to_value()).unwrap();
        body.signature = Some(sig);
        assert!(body.verify(&jwk));
        body.operation_id = "op2".into();
        assert!(!body.verify(&jwk));
    }

    #[test]
    fn closed_state_and_settlement_sets() {
        assert!(resolution("succeeded", "settled").validate().is_ok());
        assert!(resolution("undelivered", "held").validate().is_ok());
        assert_eq!(
            resolution("unknown", "held").validate(),
            Err(ResolutionError::State)
        );
        assert_eq!(
            resolution("failed", "bogus").validate(),
            Err(ResolutionError::SettlementState)
        );
        assert_eq!(RESOLUTION_STATES.len(), 6);
        assert_eq!(SETTLEMENT_STATES.len(), 4);
    }

    #[test]
    fn degradation_shape_is_closed_and_never_claims_settlement() {
        for code in DEGRADATION_CODES {
            let mut body = resolution("failed", "unknown");
            body.code = Some((*code).into());
            body.usage_source = Some("unavailable".into());
            assert_eq!(body.validate(), Ok(()));

            body.settlement_state = "settled".into();
            assert_eq!(body.validate(), Err(ResolutionError::SettlementState));
            body.settlement_state = "unknown".into();
            body.state = "undelivered".into();
            assert_eq!(body.validate(), Err(ResolutionError::SettlementState));
            body.state = "failed".into();
            body.usage_source = Some("provider".into());
            assert_eq!(body.validate(), Err(ResolutionError::UsageSource));
        }
        let mut unknown_code = resolution("failed", "unknown");
        unknown_code.code = Some("not_a_resolution_code".into());
        assert_eq!(unknown_code.validate(), Err(ResolutionError::Code));
        let mut bad_delivery = resolution("failed", "unknown");
        bad_delivery.delivery_state = "pending".into();
        assert_eq!(bad_delivery.validate(), Err(ResolutionError::DeliveryState));
    }

    #[test]
    fn resolution_revision_is_decimal_string() {
        assert_eq!(
            resolution("failed", "unknown").to_value()["resolution_revision"],
            "5"
        );
    }

    #[test]
    fn ack_closed_states() {
        for state in ["applied", "journal_row_missing", "conflict"] {
            let ack = ResolutionAckBody {
                resolve_id: "res1".into(),
                state: state.into(),
            };
            assert!(ack.state_valid());
        }
        let bad = ResolutionAckBody {
            resolve_id: "res1".into(),
            state: "bogus".into(),
        };
        assert!(!bad.state_valid());
    }

    // Cross-language vector: the Go gateway (internal/devicesig.SignFrame) signed
    // this resolution body with a fixed server key; the device must verify it byte
    // for byte. Proves the server-signing path (GW7) matches device verification.
    #[test]
    fn verifies_go_gateway_server_signature() {
        let jwk = crate::jwk::validate_json(
            r#"{"kty":"EC","crv":"P-256","x":"tUFRjLcJt4k8zRYMpM1YazK2uVW6O6bzmgiM-nkUBcQ","y":"hAiDAW1L5bBXS7qg_yLExLKrHP1Wo1WrjWD5IkXrvzA"}"#,
        )
        .unwrap();
        let body: OperationResolutionBody = serde_json::from_str(
            r#"{"resolve_id":"11111111-1111-4111-8111-111111111111","run_id":"22222222-2222-4222-8222-222222222222","operation_id":"33333333-3333-4333-8333-333333333333","attempt_id":"44444444-4444-4444-8444-444444444444","state":"failed","delivery_state":"delivered","settlement_state":"unknown","resolution_revision":"5"}"#,
        )
        .unwrap();
        let sig = "YdyoqManItvFSo9wz6iMzepZA8N__1UKCXFKnTOcHyFwW1bdMPlJRGwdl8dXoAldX5o-mxKRprJdsnide0JB8w";
        assert!(sign::verify_frame(&jwk, FRAME_TYPE, &body.to_value(), sig));
        // Tampering with the conclusion invalidates the server signature.
        let mut tampered = body.clone();
        tampered.state = "succeeded".into();
        assert!(!sign::verify_frame(
            &jwk,
            FRAME_TYPE,
            &tampered.to_value(),
            sig
        ));
    }
}
