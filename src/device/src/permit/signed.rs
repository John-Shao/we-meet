//! SignedPermit (device-design §3.3). The permit is signed by the server's
//! independent permit key; the device verifies it and registers the `jti`
//! single-use in the journal transaction before executing. `aud` is a closed set
//! (`device-tool` / `device-model-proxy`); the action TTL is at most 5s and at
//! most the remaining lease. `fence` is `run.fence` (no device-side counter).
//!
//! `jti` single-use is enforced by the journal's `action_journal.permit_jti`
//! UNIQUE constraint (batch 2): registering an already-consumed jti fails the
//! insert, so a re-sent command returns the journal without re-executing.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::jwk::EcP256Jwk;

/// The permit frame type tag (signing domain).
pub const FRAME_TYPE: &str = "permit";
/// Audience: local tool action.
pub const AUD_DEVICE_TOOL: &str = "device-tool";
/// Audience: device-local model proxy.
pub const AUD_DEVICE_MODEL_PROXY: &str = "device-model-proxy";
/// Maximum action permit TTL (device-design §3.3: 5s).
pub const MAX_TTL_SECS: u64 = 5;

/// The closed SignedPermit document (device-design §3.3). Timestamps are unix
/// seconds carried as decimal strings at the boundary.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignedPermit {
    pub v: u32,
    pub aud: String,
    pub kid: String,
    pub jti: String,
    pub org_id: String,
    pub subject_id: String,
    pub device_id: String,
    pub session_id: String,
    pub agent_instance_id: String,
    pub boot_id: String,
    #[serde(with = "u64string")]
    pub generation: u64,
    pub run_id: String,
    pub operation_id: String,
    pub dispatch_attempt_id: String,
    pub request_hash: String,
    #[serde(with = "u64string")]
    pub fence: u64,
    #[serde(with = "u64string")]
    pub policy_epoch: u64,
    #[serde(with = "u64string")]
    pub access_epoch: u64,
    pub grant_id: String,
    #[serde(with = "u64string")]
    pub grant_revision: u64,
    pub approval_id: String,
    #[serde(with = "u64string")]
    pub decision_revision: u64,
    pub scope_hash: String,
    /// null for a pure local read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_id: Option<String>,
    #[serde(with = "u64string")]
    pub max_bytes: u64,
    #[serde(with = "u64string")]
    pub issued_at: u64,
    #[serde(with = "u64string")]
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// Why a permit was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermitError {
    Aud,
    Signature,
    Identity,
    Fence,
    Expired,
    Ttl,
}

/// The identity/time/fence context a permit is validated against.
pub struct PermitContext<'a> {
    /// The server's permit signing public key.
    pub server_permit_key: &'a EcP256Jwk,
    pub org_id: &'a str,
    pub subject_id: &'a str,
    pub device_id: &'a str,
    pub session_id: &'a str,
    /// The current `run.fence`.
    pub run_fence: u64,
    /// Current unix seconds.
    pub now_unix: u64,
    /// Remaining lease seconds (the permit TTL must not exceed this).
    pub remaining_lease_secs: u64,
}

impl SignedPermit {
    /// Render the permit as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("permit serializes")
    }

    /// Verify the server signature, audience, identity, fence, expiry and TTL.
    /// `jti` single-use is enforced separately by the journal UNIQUE constraint.
    pub fn validate(&self, ctx: &PermitContext) -> Result<(), PermitError> {
        if self.aud != AUD_DEVICE_TOOL && self.aud != AUD_DEVICE_MODEL_PROXY {
            return Err(PermitError::Aud);
        }
        let signature = self.signature.as_ref().ok_or(PermitError::Signature)?;
        if !sign::verify_frame(
            ctx.server_permit_key,
            FRAME_TYPE,
            &self.to_value(),
            signature,
        ) {
            return Err(PermitError::Signature);
        }
        if self.org_id != ctx.org_id
            || self.subject_id != ctx.subject_id
            || self.device_id != ctx.device_id
            || self.session_id != ctx.session_id
        {
            return Err(PermitError::Identity);
        }
        if self.fence != ctx.run_fence {
            return Err(PermitError::Fence);
        }
        if self.expires_at <= ctx.now_unix {
            return Err(PermitError::Expired);
        }
        if self.expires_at.saturating_sub(self.issued_at) > MAX_TTL_SECS {
            return Err(PermitError::Ttl);
        }
        if self.expires_at.saturating_sub(ctx.now_unix) > ctx.remaining_lease_secs {
            return Err(PermitError::Ttl);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::{DeviceKey, SoftwareKey};

    fn permit(key: &dyn DeviceKey) -> SignedPermit {
        let mut p = SignedPermit {
            v: 2,
            aud: AUD_DEVICE_TOOL.into(),
            kid: "kid".into(),
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
            approval_id: "approval".into(),
            decision_revision: 1,
            scope_hash: "scope".into(),
            destination_id: None,
            max_bytes: 1024,
            issued_at: 1000,
            expires_at: 1005,
            signature: None,
        };
        let value = p.to_value();
        p.signature = Some(sign::sign_frame(key, FRAME_TYPE, &value).unwrap());
        p
    }

    fn ctx(key: &EcP256Jwk) -> PermitContext<'_> {
        PermitContext {
            server_permit_key: key,
            org_id: "org",
            subject_id: "sub",
            device_id: "dev",
            session_id: "sess",
            run_fence: 2,
            now_unix: 1001,
            remaining_lease_secs: 30,
        }
    }

    #[test]
    fn valid_permit_passes() {
        let key = SoftwareKey::random();
        let p = permit(&key);
        assert_eq!(p.validate(&ctx(&key.public_jwk())), Ok(()));
    }

    #[test]
    fn rejects_unknown_aud() {
        let key = SoftwareKey::random();
        let mut p = permit(&key);
        p.aud = "device-egress".into();
        assert_eq!(p.validate(&ctx(&key.public_jwk())), Err(PermitError::Aud));
    }

    #[test]
    fn rejects_wrong_signing_key() {
        let key = SoftwareKey::random();
        let other = SoftwareKey::random();
        let p = permit(&key);
        assert_eq!(
            p.validate(&ctx(&other.public_jwk())),
            Err(PermitError::Signature)
        );
    }

    #[test]
    fn rejects_identity_mismatch() {
        let key = SoftwareKey::random();
        let p = permit(&key);
        let jwk = key.public_jwk();
        let mut c = ctx(&jwk);
        c.device_id = "other-dev";
        assert_eq!(p.validate(&c), Err(PermitError::Identity));
    }

    #[test]
    fn rejects_stale_fence() {
        let key = SoftwareKey::random();
        let p = permit(&key);
        let jwk = key.public_jwk();
        let mut c = ctx(&jwk);
        c.run_fence = 3;
        assert_eq!(p.validate(&c), Err(PermitError::Fence));
    }

    #[test]
    fn rejects_expired() {
        let key = SoftwareKey::random();
        let p = permit(&key);
        let jwk = key.public_jwk();
        let mut c = ctx(&jwk);
        c.now_unix = 1005;
        assert_eq!(p.validate(&c), Err(PermitError::Expired));
    }

    #[test]
    fn rejects_ttl_over_five_seconds() {
        let key = SoftwareKey::random();
        let mut p = permit(&key);
        p.issued_at = 1000;
        p.expires_at = 1006;
        let value = p.to_value();
        p.signature = Some(sign::sign_frame(&key, FRAME_TYPE, &value).unwrap());
        assert_eq!(p.validate(&ctx(&key.public_jwk())), Err(PermitError::Ttl));
    }

    #[test]
    fn rejects_ttl_over_remaining_lease() {
        let key = SoftwareKey::random();
        let p = permit(&key);
        let jwk = key.public_jwk();
        let mut c = ctx(&jwk);
        c.remaining_lease_secs = 2; // permit has 4s left, lease only 2s
        assert_eq!(p.validate(&c), Err(PermitError::Ttl));
    }
}
