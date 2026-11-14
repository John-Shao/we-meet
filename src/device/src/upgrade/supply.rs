//! The supply-chain self-test gate (device-design §8 :376/:378, architecture
//! §5.2). After download and before dual-slot activation, the release manifest
//! must pass: a valid release signature (ES256-over-JCS, release public key),
//! sha256 hash integrity for the runtime digest and tool manifest, a present SBOM
//! reference and timestamp, and the matrix/profile/feature validation. The signing
//! domain is `release_manifest`, distinct from device frames (no cross-domain
//! signature reuse).

use crate::frame::sign;
use crate::jwk::EcP256Jwk;
use crate::upgrade::manifest::{ManifestError, ReleaseManifest};

/// The release-manifest signing domain.
pub const MANIFEST_FRAME_TYPE: &str = "release_manifest";

/// A supply-chain self-test failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SupplyError {
    Signature,
    Hash,
    Sbom,
    Timestamp,
    Manifest(ManifestError),
}

impl From<ManifestError> for SupplyError {
    fn from(err: ManifestError) -> Self {
        Self::Manifest(err)
    }
}

/// Whether `text` is a sha256 digest: 64 hex chars, optionally `sha256:`-prefixed.
fn is_sha256_hex(text: &str) -> bool {
    let hex = text.strip_prefix("sha256:").unwrap_or(text);
    hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Verify the release signature over the JCS manifest body (signature stripped).
pub fn verify_release_signature(manifest: &ReleaseManifest, release_jwk: &EcP256Jwk) -> bool {
    match &manifest.signature {
        Some(sig) => {
            sign::verify_frame(release_jwk, MANIFEST_FRAME_TYPE, &manifest.to_value(), sig)
        }
        None => false,
    }
}

/// The full pre-activation self-test: signature, hash integrity, SBOM, timestamp,
/// then the matrix validation. All must pass before a slot may be activated.
pub fn self_test(
    manifest: &ReleaseManifest,
    release_jwk: &EcP256Jwk,
    current_build: u32,
    supported_features: &[&str],
    supported_protocol_major: u32,
) -> Result<(), SupplyError> {
    if !verify_release_signature(manifest, release_jwk) {
        return Err(SupplyError::Signature);
    }
    if !is_sha256_hex(&manifest.runtime_digest) || !is_sha256_hex(&manifest.tool_manifest_hash) {
        return Err(SupplyError::Hash);
    }
    if manifest.sbom_ref.is_empty() {
        return Err(SupplyError::Sbom);
    }
    if manifest.timestamp.is_empty() {
        return Err(SupplyError::Timestamp);
    }
    manifest.validate(current_build, supported_features, supported_protocol_major)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::{DeviceKey, SoftwareKey};

    fn manifest() -> ReleaseManifest {
        ReleaseManifest {
            shell_version: "1.0.0".into(),
            agent_version: "1.0.0".into(),
            runtime_digest: "a".repeat(64),
            node_version: "24.0.0".into(),
            protocol_major: 2,
            protocol_minor: 0,
            required_features: vec!["local_only".into()],
            tool_manifest_hash: "b".repeat(64),
            profile_id: "profile".into(),
            canonical_schema: "2".into(),
            min_windows_build: 19041,
            timestamp: "2026-11-15T00:00:00Z".into(),
            sbom_ref: "sbom:sha256:...".into(),
            signature: None,
        }
    }

    fn signed(key: &SoftwareKey) -> ReleaseManifest {
        let mut m = manifest();
        let sig = sign::sign_frame(key, MANIFEST_FRAME_TYPE, &m.to_value()).unwrap();
        m.signature = Some(sig);
        m
    }

    const FEATURES: &[&str] = &["local_only"];

    #[test]
    fn signed_manifest_passes_self_test() {
        let key = SoftwareKey::random();
        let m = signed(&key);
        assert!(self_test(&m, &key.public_jwk(), 22000, FEATURES, 2).is_ok());
    }

    #[test]
    fn wrong_release_key_rejected() {
        let key = SoftwareKey::random();
        let other = SoftwareKey::random();
        let m = signed(&key);
        assert_eq!(
            self_test(&m, &other.public_jwk(), 22000, FEATURES, 2),
            Err(SupplyError::Signature)
        );
    }

    #[test]
    fn unsigned_manifest_rejected() {
        let key = SoftwareKey::random();
        assert_eq!(
            self_test(&manifest(), &key.public_jwk(), 22000, FEATURES, 2),
            Err(SupplyError::Signature)
        );
    }

    #[test]
    fn tampered_manifest_breaks_signature() {
        let key = SoftwareKey::random();
        let mut m = signed(&key);
        m.runtime_digest = "c".repeat(64);
        assert_eq!(
            self_test(&m, &key.public_jwk(), 22000, FEATURES, 2),
            Err(SupplyError::Signature)
        );
    }

    #[test]
    fn bad_hash_rejected() {
        let key = SoftwareKey::random();
        let mut m = signed(&key);
        m.runtime_digest = "not-a-hash".into();
        // Re-sign so the signature passes and the hash check is exercised.
        let sig = sign::sign_frame(&key, MANIFEST_FRAME_TYPE, &m.to_value()).unwrap();
        m.signature = Some(sig);
        assert_eq!(
            self_test(&m, &key.public_jwk(), 22000, FEATURES, 2),
            Err(SupplyError::Hash)
        );
    }

    #[test]
    fn sha256_prefix_accepted() {
        assert!(is_sha256_hex(&format!("sha256:{}", "a".repeat(64))));
        assert!(is_sha256_hex(&"a".repeat(64)));
        assert!(!is_sha256_hex(&"a".repeat(63)));
        assert!(!is_sha256_hex(&"g".repeat(64)));
    }
}
