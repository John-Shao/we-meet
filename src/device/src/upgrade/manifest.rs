//! The release-manifest matrix (device-design §8 :376, architecture §5.2). The
//! shell, agent and runtime ship as one signed matrix; every field is required.
//! The minimum desktop version is the earliest published manifest that passes the
//! whole matrix — never a guess that the current install supports the device.
//! Feature negotiation and min_windows_build are checked here; the release
//! signature/hash/SBOM self-test lives in [`super::supply`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A manifest validation failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManifestError {
    MissingField(&'static str),
    FeatureUnsupported(String),
    BuildTooLow { required: u32, current: u32 },
    ProtocolMajor { manifest: u32, supported: u32 },
}

/// The closed release-manifest matrix (§8 :376). `signature` covers the JCS body
/// (see [`super::supply`]); the other fields are all required.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReleaseManifest {
    pub shell_version: String,
    pub agent_version: String,
    pub runtime_digest: String,
    pub node_version: String,
    pub protocol_major: u32,
    pub protocol_minor: u32,
    pub required_features: Vec<String>,
    pub tool_manifest_hash: String,
    pub profile_id: String,
    pub canonical_schema: String,
    pub min_windows_build: u32,
    pub timestamp: String,
    pub sbom_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl ReleaseManifest {
    /// Render the manifest as a JSON value (the signing body).
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("release-manifest serializes")
    }

    /// Validate the matrix against the running environment: required fields,
    /// protocol major match, required-feature negotiation, and min_windows_build.
    pub fn validate(
        &self,
        current_build: u32,
        supported_features: &[&str],
        supported_protocol_major: u32,
    ) -> Result<(), ManifestError> {
        for (name, value) in [
            ("shell_version", self.shell_version.as_str()),
            ("agent_version", self.agent_version.as_str()),
            ("runtime_digest", self.runtime_digest.as_str()),
            ("node_version", self.node_version.as_str()),
            ("tool_manifest_hash", self.tool_manifest_hash.as_str()),
            ("profile_id", self.profile_id.as_str()),
            ("canonical_schema", self.canonical_schema.as_str()),
            ("timestamp", self.timestamp.as_str()),
            ("sbom_ref", self.sbom_ref.as_str()),
        ] {
            if value.is_empty() {
                return Err(ManifestError::MissingField(name));
            }
        }
        if self.protocol_major != supported_protocol_major {
            return Err(ManifestError::ProtocolMajor {
                manifest: self.protocol_major,
                supported: supported_protocol_major,
            });
        }
        for feature in &self.required_features {
            if !supported_features.contains(&feature.as_str()) {
                return Err(ManifestError::FeatureUnsupported(feature.clone()));
            }
        }
        if self.min_windows_build > current_build {
            return Err(ManifestError::BuildTooLow {
                required: self.min_windows_build,
                current: current_build,
            });
        }
        Ok(())
    }
}

/// The minimum desktop version: the earliest published manifest (oldest first)
/// that passes the whole matrix (§8 :376). Returns `None` if none passes.
pub fn minimum_desktop_version<'a>(
    published_oldest_first: &'a [ReleaseManifest],
    current_build: u32,
    supported_features: &[&str],
    supported_protocol_major: u32,
) -> Option<&'a ReleaseManifest> {
    published_oldest_first.iter().find(|m| {
        m.validate(current_build, supported_features, supported_protocol_major)
            .is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(shell: &str) -> ReleaseManifest {
        ReleaseManifest {
            shell_version: shell.into(),
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

    const FEATURES: &[&str] = &["local_only", "named_pipe"];

    #[test]
    fn valid_manifest_passes() {
        assert!(manifest("1.0.0").validate(22000, FEATURES, 2).is_ok());
    }

    #[test]
    fn missing_required_field_rejected() {
        let mut m = manifest("1.0.0");
        m.sbom_ref = String::new();
        assert_eq!(
            m.validate(22000, FEATURES, 2),
            Err(ManifestError::MissingField("sbom_ref"))
        );
    }

    #[test]
    fn unsupported_feature_rejected() {
        let mut m = manifest("1.0.0");
        m.required_features = vec!["egress".into()];
        assert!(matches!(
            m.validate(22000, FEATURES, 2),
            Err(ManifestError::FeatureUnsupported(_))
        ));
    }

    #[test]
    fn build_too_low_rejected() {
        assert_eq!(
            manifest("1.0.0").validate(18000, FEATURES, 2),
            Err(ManifestError::BuildTooLow {
                required: 19041,
                current: 18000
            })
        );
    }

    #[test]
    fn protocol_major_must_match() {
        assert!(matches!(
            manifest("1.0.0").validate(22000, FEATURES, 3),
            Err(ManifestError::ProtocolMajor {
                manifest: 2,
                supported: 3
            })
        ));
    }

    #[test]
    fn minimum_desktop_version_is_earliest_passing() {
        // The oldest manifest fails the build floor; the next passes.
        let mut old = manifest("0.9.0");
        old.min_windows_build = 22001;
        let newer = manifest("1.0.0");
        let published = [old, newer];
        let min = minimum_desktop_version(&published, 22000, FEATURES, 2).unwrap();
        assert_eq!(min.shell_version, "1.0.0");
        // None passes a too-low current build.
        assert!(minimum_desktop_version(&published, 18000, FEATURES, 2).is_none());
    }
}
