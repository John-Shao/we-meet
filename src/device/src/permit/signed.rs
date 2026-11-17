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

use crate::frame::{rfc3339::parse_utc_seconds, sign, u64string};
use crate::jwk::EcP256Jwk;
use crate::thumbprint::device_key_thumbprint;

/// The permit frame type tag (signing domain).
pub const FRAME_TYPE: &str = "permit";
/// Audience: local tool action.
pub const AUD_DEVICE_TOOL: &str = "device-tool";
/// Audience: device-local model proxy.
pub const AUD_DEVICE_MODEL_PROXY: &str = "device-model-proxy";
/// Maximum action permit TTL (device-design §3.3: 5s).
pub const MAX_TTL_SECS: u64 = 5;

/// The closed SignedPermit document (device-design §3.3, 28 keys including `signature`).
///
/// Three fields were aligned with the landed server mint (0055) rather than the pre-gateway
/// batch-4 shape, because each one made a real server-signed permit unverifiable:
///   - `issued_at`/`expires_at` are RFC 3339 UTC strings, not unix-second decimal strings. SQL
///     mints them with `to_char(now() AT TIME ZONE 'UTC', …)` and compares them as
///     `::timestamptz`; every other landed frame carries the same form.
///   - `destination_id` is always emitted, null for a pure local read. SQL demands exactly 28
///     keys, so omitting it changed the JCS preimage and no readonly permit could ever verify.
///   - `approval_id`/`decision_revision` are optional and always emitted: the readonly
///     auto-approved path has no Approval row, so the server sends both as null.
///
/// `kid` is the permit signing key's thumbprint, which the device recomputes from the hello_ack
/// `permit_public_jwk` — that key is INDEPENDENT of the frame key (`server_public_jwk`).
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
    /// null on the readonly auto-approved path, which has no Approval.
    pub approval_id: Option<String>,
    #[serde(with = "u64string::opt")]
    pub decision_revision: Option<u64>,
    pub scope_hash: String,
    /// null for a pure local read; the key is always present.
    pub destination_id: Option<String>,
    #[serde(with = "u64string")]
    pub max_bytes: u64,
    /// RFC 3339 UTC (`YYYY-MM-DDTHH:MM:SSZ`), the form the server mints.
    pub issued_at: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// Why a permit was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermitError {
    Aud,
    Signature,
    /// `kid` does not name the provisioned permit key.
    Kid,
    Identity,
    Fence,
    /// A timestamp is not in the RFC 3339 UTC form the server emits.
    Time,
    Expired,
    Ttl,
}

/// The identity/time/fence context a permit is validated against.
pub struct PermitContext<'a> {
    /// The server's INDEPENDENT permit signing public key, provisioned from the hello_ack
    /// `permit_public_jwk` — never `server_public_jwk`, which signs frames (§3.3).
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

    /// Verify the server signature, the key id, audience, identity, fence, expiry and TTL.
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
        // The kid must name the key that was just provisioned. Without this a permit signed by
        // a DIFFERENT permit key would still verify if the device ever held two, and §3.3's
        // single independent authority would be ambiguous.
        if self.kid != device_key_thumbprint(ctx.server_permit_key) {
            return Err(PermitError::Kid);
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
        // The timestamps are parsed, never guessed: an unparseable deadline is a refusal, not
        // an open-ended permission.
        let issued = parse_utc_seconds(&self.issued_at).ok_or(PermitError::Time)?;
        let expires = parse_utc_seconds(&self.expires_at).ok_or(PermitError::Time)?;
        if expires <= ctx.now_unix {
            return Err(PermitError::Expired);
        }
        if expires.saturating_sub(issued) > MAX_TTL_SECS {
            return Err(PermitError::Ttl);
        }
        if expires.saturating_sub(ctx.now_unix) > ctx.remaining_lease_secs {
            return Err(PermitError::Ttl);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::{DeviceKey, SoftwareKey};

    /// The minted form: whole-second RFC 3339 UTC, five seconds apart.
    const ISSUED: &str = "2026-11-17T12:00:00Z";
    const EXPIRES: &str = "2026-11-17T12:00:05Z";

    fn unix(text: &str) -> u64 {
        parse_utc_seconds(text).unwrap()
    }

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
            approval_id: Some("approval".into()),
            decision_revision: Some(1),
            scope_hash: "scope".into(),
            destination_id: None,
            max_bytes: 1024,
            issued_at: ISSUED.into(),
            expires_at: EXPIRES.into(),
            signature: None,
        };
        p.signature = Some(sign::sign_frame(key, FRAME_TYPE, &p.to_value()).unwrap());
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
            now_unix: unix(ISSUED) + 1,
            remaining_lease_secs: 30,
        }
    }

    /// Re-sign after a mutation: the signature covers the whole document, so editing a field
    /// without re-signing would only measure the signature check, not the gate under test.
    fn resign(key: &dyn DeviceKey, p: &mut SignedPermit) {
        p.signature = None;
        p.signature = Some(sign::sign_frame(key, FRAME_TYPE, &p.to_value()).unwrap());
    }

    #[test]
    fn valid_permit_passes() {
        let key = SoftwareKey::random();
        let p = permit(&key);
        assert_eq!(p.validate(&ctx(&key.public_jwk())), Ok(()));
    }

    #[test]
    fn document_is_the_closed_28_keys_with_nulls_present() {
        let key = SoftwareKey::random();
        let mut p = permit(&key);
        // Unsigned the signature member is absent; signed it is the 28th key.
        p.signature = None;
        assert_eq!(p.to_value().as_object().unwrap().len(), 27);
        resign(&key, &mut p);
        let value = p.to_value();
        assert_eq!(value.as_object().unwrap().len(), 28);
        // A pure local read keeps destination_id as an explicit null, and the uint64 fields
        // cross as decimal strings — omitting or re-typing either changes the JCS preimage.
        assert!(value["destination_id"].is_null());
        for field in [
            "generation",
            "fence",
            "policy_epoch",
            "access_epoch",
            "grant_revision",
            "max_bytes",
        ] {
            assert!(value[field].is_string(), "{field} must be a decimal string");
        }
        assert_eq!(value["issued_at"], ISSUED);
        assert_eq!(value["expires_at"], EXPIRES);
    }

    #[test]
    fn readonly_permit_keeps_null_approval_keys_and_verifies() {
        let key = SoftwareKey::random();
        let mut p = permit(&key);
        // The readonly auto-approved path has no Approval row, so the server mints both null.
        p.approval_id = None;
        p.decision_revision = None;
        resign(&key, &mut p);
        let value = p.to_value();
        assert_eq!(value.as_object().unwrap().len(), 28);
        assert!(value["approval_id"].is_null());
        assert!(value["decision_revision"].is_null());
        assert_eq!(p.validate(&ctx(&key.public_jwk())), Ok(()));
        // Deserialize then re-render: the null keys must survive or the signature stops verifying.
        let round: SignedPermit = serde_json::from_value(value).unwrap();
        assert_eq!(round.approval_id, None);
        assert_eq!(round.decision_revision, None);
        assert_eq!(round.validate(&ctx(&key.public_jwk())), Ok(()));
    }

    #[test]
    fn rejects_unknown_aud() {
        let key = SoftwareKey::random();
        let mut p = permit(&key);
        p.aud = "device-egress".into();
        resign(&key, &mut p);
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
    fn rejects_a_kid_naming_another_key() {
        let key = SoftwareKey::random();
        let mut p = permit(&key);
        p.kid = device_key_thumbprint(&SoftwareKey::random().public_jwk());
        resign(&key, &mut p);
        assert_eq!(p.validate(&ctx(&key.public_jwk())), Err(PermitError::Kid));
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
        c.now_unix = unix(EXPIRES);
        assert_eq!(p.validate(&c), Err(PermitError::Expired));
    }

    #[test]
    fn ttl_boundary_is_exactly_five_seconds() {
        let key = SoftwareKey::random();
        let mut p = permit(&key);
        // Five seconds is the maximum and must pass.
        assert_eq!(p.validate(&ctx(&key.public_jwk())), Ok(()));
        p.expires_at = "2026-11-17T12:00:06Z".into();
        resign(&key, &mut p);
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

    #[test]
    fn refuses_a_timestamp_outside_the_minted_form() {
        let key = SoftwareKey::random();
        for bad in [
            "1000",
            "2026-11-17T12:00:00+00:00",
            "2026-11-17T12:00:00.000Z",
            "",
        ] {
            let mut p = permit(&key);
            p.issued_at = bad.into();
            resign(&key, &mut p);
            assert_eq!(p.validate(&ctx(&key.public_jwk())), Err(PermitError::Time));
            let mut q = permit(&key);
            q.expires_at = bad.into();
            resign(&key, &mut q);
            assert_eq!(q.validate(&ctx(&key.public_jwk())), Err(PermitError::Time));
        }
    }

    #[test]
    fn unsigned_permit_is_never_trusted() {
        let key = SoftwareKey::random();
        let mut p = permit(&key);
        p.signature = None;
        assert_eq!(
            p.validate(&ctx(&key.public_jwk())),
            Err(PermitError::Signature)
        );
    }
}
