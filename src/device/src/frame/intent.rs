//! The `local_intent` body (device-design §2.2): the device-signed local
//! submission proof. It binds the current session, request, input/preview/target
//! hashes, selected grants and revisions, execution profile, device, auth plane
//! and epoch, a nonce and a 60s expiry. The Go submit transaction consumes the
//! nonce atomically; only the original Bearer desktop identity may submit.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{sign, u64string};
use crate::key::DeviceKey;

/// The local_intent frame type tag.
pub const FRAME_TYPE: &str = "local_intent";

/// The closed local submission proof body.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LocalIntent {
    pub v: u32,
    pub org_id: String,
    pub subject_id: String,
    pub auth_plane: String,
    #[serde(with = "u64string")]
    pub auth_epoch: u64,
    pub device_id: String,
    pub session_id: String,
    pub request_id: String,
    pub input_hash: String,
    pub preview_hash: String,
    pub target_selection_hash: String,
    pub selected_grant_ids: Vec<String>,
    pub grant_revisions: Vec<String>,
    pub profile_id: String,
    #[serde(with = "u64string")]
    pub profile_revision: u64,
    pub profile_hash: String,
    pub nonce: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

pub struct LocalIntentInput {
    pub org_id: String,
    pub subject_id: String,
    pub auth_epoch: String,
    pub device_id: String,
    pub session_id: String,
    pub request_id: String,
    pub input_hash: String,
    pub preview_hash: String,
    pub target_selection_hash: String,
    pub selected_grant_ids: Vec<String>,
    pub grant_revisions: Vec<String>,
    pub profile_id: String,
    pub profile_revision: String,
    pub profile_hash: String,
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn valid_preview(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_uint(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
        && value.parse::<u64>().is_ok()
}

fn valid_request_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_nonce(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

impl LocalIntent {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("local_intent serializes")
    }

    pub fn validate(&self) -> Result<(), sign::SignError> {
        if self.v != 1
            || !valid_text(&self.org_id, 256)
            || !valid_text(&self.subject_id, 256)
            || self.auth_plane != "bearer"
            || !valid_uint(&self.auth_epoch.to_string())
            || !valid_uuid(&self.device_id)
            || !valid_uuid(&self.session_id)
            || !valid_request_id(&self.request_id)
            || !valid_digest(&self.input_hash)
            || !valid_preview(&self.preview_hash)
            || !valid_digest(&self.target_selection_hash)
            || !(1..=4).contains(&self.selected_grant_ids.len())
            || self.selected_grant_ids.len() != self.grant_revisions.len()
            || !valid_text(&self.profile_id, 128)
            || !valid_uint(&self.profile_revision.to_string())
            || !valid_digest(&self.profile_hash)
            || !valid_nonce(&self.nonce)
            || crate::frame::rfc3339::parse_utc_seconds(&self.expires_at).is_none()
        {
            return Err(sign::SignError::InvalidProof);
        }
        let mut seen = std::collections::BTreeSet::new();
        for (grant, revision) in self.selected_grant_ids.iter().zip(&self.grant_revisions) {
            if !valid_uuid(grant) || !seen.insert(grant) || !valid_uint(revision) {
                return Err(sign::SignError::InvalidProof);
            }
        }
        if let Some(signature) = &self.signature {
            if signature.len() != 86
                || !signature
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            {
                return Err(sign::SignError::InvalidProof);
            }
        }
        Ok(())
    }

    /// Sign the validated body and set its `signature` field.
    pub fn sign(&mut self, key: &dyn DeviceKey) -> Result<(), sign::SignError> {
        self.validate()?;
        let value = self.to_value();
        self.signature = Some(sign(key, &value)?);
        Ok(())
    }
}

pub fn sign(key: &dyn DeviceKey, proof: &Value) -> Result<String, sign::SignError> {
    sign::sign_frame(key, FRAME_TYPE, proof)
}

pub fn produce(key: &dyn DeviceKey, input: LocalIntentInput) -> Result<Value, sign::SignError> {
    let auth_epoch = input
        .auth_epoch
        .parse::<u64>()
        .map_err(|_| sign::SignError::InvalidProof)?;
    let profile_revision = input
        .profile_revision
        .parse::<u64>()
        .map_err(|_| sign::SignError::InvalidProof)?;
    let expires_at = std::time::SystemTime::now()
        .checked_add(std::time::Duration::from_secs(60))
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|value| crate::frame::rfc3339::format_utc_seconds(value.as_secs()))
        .ok_or(sign::SignError::InvalidProof)?;
    let mut intent = LocalIntent {
        v: 1,
        org_id: input.org_id,
        subject_id: input.subject_id,
        auth_plane: "bearer".into(),
        auth_epoch,
        device_id: input.device_id,
        session_id: input.session_id,
        request_id: input.request_id,
        input_hash: input.input_hash,
        preview_hash: input.preview_hash,
        target_selection_hash: input.target_selection_hash,
        selected_grant_ids: input.selected_grant_ids,
        grant_revisions: input.grant_revisions,
        profile_id: input.profile_id,
        profile_revision,
        profile_hash: input.profile_hash,
        nonce: uuid::Uuid::new_v4().simple().to_string(),
        expires_at,
        signature: None,
    };
    intent.sign(key)?;
    Ok(intent.to_value())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::sign::verify_frame;
    use crate::key::SoftwareKey;

    fn sample() -> LocalIntent {
        LocalIntent {
            v: 1,
            org_id: "org".into(),
            subject_id: "subject".into(),
            auth_plane: "bearer".into(),
            auth_epoch: 3,
            device_id: "11111111-1111-4111-8111-111111111111".into(),
            session_id: "22222222-2222-4222-8222-222222222222".into(),
            request_id: "local-submit-1".into(),
            input_hash: "a".repeat(64),
            preview_hash: "p1.preview.signature".into(),
            target_selection_hash: "b".repeat(64),
            selected_grant_ids: vec!["33333333-3333-4333-8333-333333333333".into()],
            grant_revisions: vec!["1".into()],
            profile_id: "local-profile".into(),
            profile_revision: 2,
            profile_hash: "c".repeat(64),
            nonce: "nonce-local-1".into(),
            expires_at: "2027-01-01T00:00:00Z".into(),
            signature: None,
        }
    }

    #[test]
    fn auth_epoch_and_profile_revision_are_decimal_strings() {
        let value = sample().to_value();
        assert_eq!(value["auth_epoch"], "3");
        assert_eq!(value["profile_revision"], "2");
        assert_eq!(value["auth_plane"], "bearer");
    }

    #[test]
    fn sign_binds_request_target_and_grant_set() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let mut intent = sample();
        intent.sign(&key).unwrap();
        let sig = intent.signature.clone().unwrap();
        assert!(verify_frame(&jwk, FRAME_TYPE, &intent.to_value(), &sig));
        for field in ["request_id", "preview_hash", "target_selection_hash"] {
            let mut changed = intent.clone();
            match field {
                "request_id" => changed.request_id = "local-submit-2".into(),
                "preview_hash" => changed.preview_hash = "p1.other.signature".into(),
                _ => changed.target_selection_hash = "d".repeat(64),
            }
            assert!(!verify_frame(&jwk, FRAME_TYPE, &changed.to_value(), &sig));
        }
        intent
            .selected_grant_ids
            .push("44444444-4444-4444-8444-444444444444".into());
        assert!(!verify_frame(&jwk, FRAME_TYPE, &intent.to_value(), &sig));
    }

    #[test]
    fn refuses_open_or_misaligned_grant_shapes() {
        let key = SoftwareKey::random();
        let mut mismatched = sample();
        mismatched.grant_revisions.clear();
        assert!(matches!(
            mismatched.sign(&key),
            Err(sign::SignError::InvalidProof)
        ));
        let mut duplicate = sample();
        duplicate
            .selected_grant_ids
            .push(duplicate.selected_grant_ids[0].clone());
        duplicate.grant_revisions.push("2".into());
        assert!(matches!(
            duplicate.sign(&key),
            Err(sign::SignError::InvalidProof)
        ));
        let mut wrong_plane = sample();
        wrong_plane.auth_plane = "cookie".into();
        assert!(matches!(
            wrong_plane.sign(&key),
            Err(sign::SignError::InvalidProof)
        ));
    }

    #[test]
    fn matches_the_go_cross_language_vector() {
        const BODY: &str = r#"{"v":1,"org_id":"org","subject_id":"subject","auth_plane":"bearer","auth_epoch":"3","device_id":"11111111-1111-4111-8111-111111111111","session_id":"22222222-2222-4222-8222-222222222222","request_id":"local-submit-1","input_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","preview_hash":"p1.preview.signature","target_selection_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","selected_grant_ids":["33333333-3333-4333-8333-333333333333"],"grant_revisions":["1"],"profile_id":"local-profile","profile_revision":"2","profile_hash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","nonce":"nonce-local-1","expires_at":"2027-01-01T00:00:00Z"}"#;
        const SIGNATURE: &str =
            "D3F3eF3QxH5vcT4PjrRsXHjY-b0FY1gSFHng6yQqBjA7HY29X4j5xd9VXuhb5N5C2iv_13RzdXf0Fo-fVIjX-A";
        let key = SoftwareKey::from_bytes(&[7; 32]).unwrap();
        let mut intent: LocalIntent = serde_json::from_str(BODY).unwrap();
        intent.sign(&key).unwrap();
        assert_eq!(intent.signature.as_deref(), Some(SIGNATURE));
        assert!(verify_frame(
            &key.public_jwk(),
            FRAME_TYPE,
            &intent.to_value(),
            SIGNATURE
        ));
    }
}
