//! Bundle digest pinning (execution-face §6.4/§6.5, 批2-5 主签单选甲). `runtime_digest` =
//! sha256(JCS(ordered signed-file manifest)); `tool_manifest_hash` = sha256(JCS(four tool schemas)).
//! The Node build script (`device-bundle/build-manifest.mjs`) computes the same hashes with an RFC
//! 8785 canonicalizer; this module recomputes them with the device's own JCS ([`crate::frame::jcs`],
//! `serde_jcs`) so the shell's pinned config and the Broker's spawn-time re-verification agree
//! byte-for-byte. The cross-check test reads the shipped fixtures and asserts equality, catching any
//! divergence between the two canonicalizers instead of silently shipping a mismatched pin.
//!
//! [`verify_bundle`] is the DD:113 spawn-time gate: it re-hashes every listed file from disk and
//! refuses a bundle whose bytes drifted from the pinned digest, so the Broker only ever starts the
//! single sidecar of the designated digest. It is cross-platform (pure hashing); the Windows spawn
//! path calls it before `CreateProcess`.

use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// A digest-pinning failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DigestError {
    /// A file or the manifest could not be read.
    Io,
    /// The manifest is not the closed {files:[{path,sha256}], runtime_digest, tool_manifest_hash} shape.
    Manifest,
    /// A file's bytes, the manifest's stored digest, or the expected digest disagree.
    Mismatch,
    /// JCS canonicalization failed.
    Schema,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// sha256(JCS(value)) — the canonical manifest hash form (lowercase hex, no `sha256:` prefix; the
/// hello/offer wire carries bare sha256-hex per 0040:897-921).
pub fn jcs_hash(value: &Value) -> Result<String, DigestError> {
    let bytes = crate::frame::jcs::canonicalize(value).map_err(|_| DigestError::Schema)?;
    Ok(sha256_hex(&bytes))
}

/// `tool_manifest_hash` from the four-tool schema object (DD:179-184, additionalProperties=false).
pub fn tool_manifest_hash(schemas: &Value) -> Result<String, DigestError> {
    jcs_hash(schemas)
}

/// Re-verify a bundle directory against its pinned `runtime_digest` (DD:113). Reads the shipped
/// `bundle-manifest.json`, re-hashes every listed file from disk (refusing any drift or missing file),
/// recomputes sha256(JCS(files)), and requires it to equal both the manifest's stored digest and the
/// expected pin. The file list AND the bytes are pinned; a tampered or substituted bundle is refused.
pub fn verify_bundle(bundle_dir: &Path, expected_runtime_digest: &str) -> Result<(), DigestError> {
    let raw =
        std::fs::read(bundle_dir.join("bundle-manifest.json")).map_err(|_| DigestError::Io)?;
    let manifest: Value = serde_json::from_slice(&raw).map_err(|_| DigestError::Manifest)?;
    let files = manifest
        .get("files")
        .and_then(Value::as_array)
        .ok_or(DigestError::Manifest)?;
    for entry in files {
        let rel = entry
            .get("path")
            .and_then(Value::as_str)
            .ok_or(DigestError::Manifest)?;
        let expected = entry
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or(DigestError::Manifest)?;
        // A manifest path must stay inside the bundle dir (no absolute / parent escape).
        if rel.starts_with('/')
            || rel.contains('\\')
            || rel.split('/').any(|s| s == ".." || s.is_empty())
        {
            return Err(DigestError::Manifest);
        }
        let bytes = std::fs::read(bundle_dir.join(rel)).map_err(|_| DigestError::Io)?;
        if sha256_hex(&bytes) != expected {
            return Err(DigestError::Mismatch);
        }
    }
    let digest = jcs_hash(&Value::Array(files.clone()))?;
    let stored = manifest
        .get("runtime_digest")
        .and_then(Value::as_str)
        .ok_or(DigestError::Manifest)?;
    if stored != digest || digest != expected_runtime_digest {
        return Err(DigestError::Mismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bundle_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../work/node/device-bundle")
            .canonicalize()
            .unwrap()
    }

    #[test]
    fn jcs_hash_matches_the_node_build_script_for_the_shipped_fixtures() {
        // The authoritative cross-check: Rust's serde_jcs must reproduce the Node build script's
        // hashes byte-for-byte, or the shell's pin and the Broker's re-verification would disagree.
        let dir = bundle_dir();
        let profile: Value =
            serde_json::from_slice(&std::fs::read(dir.join("dev-fixture-profile.json")).unwrap())
                .unwrap();
        let schemas: Value =
            serde_json::from_slice(&std::fs::read(dir.join("tool-schemas.json")).unwrap()).unwrap();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(dir.join("bundle-manifest.json")).unwrap())
                .unwrap();

        let tmh = tool_manifest_hash(&schemas).unwrap();
        assert_eq!(tmh, profile["tool_manifest_hash"].as_str().unwrap());
        assert_eq!(tmh, manifest["tool_manifest_hash"].as_str().unwrap());

        let rd = jcs_hash(&manifest["files"]).unwrap();
        assert_eq!(rd, profile["runtime_digest"].as_str().unwrap());
        assert_eq!(rd, manifest["runtime_digest"].as_str().unwrap());
    }

    #[test]
    fn verify_bundle_accepts_the_shipped_bundle_and_refuses_a_wrong_pin() {
        let dir = bundle_dir();
        let profile: Value =
            serde_json::from_slice(&std::fs::read(dir.join("dev-fixture-profile.json")).unwrap())
                .unwrap();
        let pin = profile["runtime_digest"].as_str().unwrap();
        verify_bundle(&dir, pin).unwrap();
        // A different pin is refused even though the bytes are intact.
        assert_eq!(
            verify_bundle(&dir, &"0".repeat(64)),
            Err(DigestError::Mismatch)
        );
    }

    #[test]
    fn verify_bundle_refuses_a_tampered_file() {
        // Copy the manifest into a temp bundle with one file's bytes changed: the re-hash must catch
        // it. We build a minimal two-file bundle so the test does not mutate the shipped tree.
        let tmp = std::env::temp_dir().join(format!("work-digest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.js"), b"original").unwrap();
        let entries = json!([
            { "path": "a.js", "sha256": sha256_hex(b"original") }
        ]);
        let rd = jcs_hash(&entries).unwrap();
        let manifest = json!({ "files": entries, "runtime_digest": rd, "tool_manifest_hash": "x" });
        std::fs::write(tmp.join("bundle-manifest.json"), manifest.to_string()).unwrap();
        verify_bundle(&tmp, &rd).unwrap();
        // Tamper the file: the re-hash disagrees with the manifest entry.
        std::fs::write(tmp.join("a.js"), b"tampered").unwrap();
        assert_eq!(verify_bundle(&tmp, &rd), Err(DigestError::Mismatch));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn verify_bundle_refuses_a_manifest_path_escape() {
        let tmp = std::env::temp_dir().join(format!("work-digest-esc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let entries = json!([ { "path": "../evil.js", "sha256": sha256_hex(b"x") } ]);
        let rd = jcs_hash(&entries).unwrap();
        let manifest = json!({ "files": entries, "runtime_digest": rd, "tool_manifest_hash": "x" });
        std::fs::write(tmp.join("bundle-manifest.json"), manifest.to_string()).unwrap();
        assert_eq!(verify_bundle(&tmp, &rd), Err(DigestError::Manifest));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_dev_fixture_profile_declares_a_non_empty_listener_requirement() {
        // §5.4 step 5: a three-empty device_local profile cannot publish; the dev fixture must satisfy
        // it too (E6 甲), else the evidence does not prove the production identity gate.
        let dir = bundle_dir();
        let profile: Value =
            serde_json::from_slice(&std::fs::read(dir.join("dev-fixture-profile.json")).unwrap())
                .unwrap();
        let req = &profile["listener_requirement"];
        let publishable = !req["allowed_signers"].as_array().unwrap().is_empty()
            || req["allow_user_pinned_hash"].as_bool().unwrap()
            || !req["allowed_service_sids"].as_array().unwrap().is_empty();
        assert!(
            publishable,
            "dev fixture listener_requirement is three-empty"
        );
        assert_eq!(profile["profile_id"], "profile-dev-fixture-v1");
    }
}
