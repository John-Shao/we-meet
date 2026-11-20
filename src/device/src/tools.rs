//! The four device tools' safety primitives (device-design §4.1/§4.2, execution-face §6.2/§6.3 C).
//! Node names a tool from the closed four and supplies validated args; the Broker does every
//! handle-relative execution. This module pins the cross-platform safety layer: the closed argument
//! schemas (additionalProperties=false, DD:177), the relative_path rejection rules (§4.2 step 2), and
//! the TOCTOU-closed sealed buffer (§4.2 step 5). The Windows NT handle-relative open / reparse /
//! volume-ID verification (§4.2 steps 1/3/4/6) lives in the platform executor that consumes these.
//!
//! A relative_path is NEVER an authorization basis: normalization is for display/hash only (§4.2
//! step 2). Authorization binds the Broker-opened handle (root via GetFinalPathNameByHandle, §4.2
//! 根目录获取), not a string prefix.

use serde_json::Value;

/// The four tools (DD:179-184). Must match [`crate::ipc::nodemsg::TOOL_NAMES`].
pub const WORKSPACE_LIST: &str = "workspace.list";
pub const WORKSPACE_READ: &str = "workspace.read";
pub const WORKSPACE_SEARCH: &str = "workspace.search";
pub const ARTIFACT_WRITE: &str = "artifact.write";

/// read/search support only these text formats this period (DD:186); no code execution / macros.
pub const TEXT_EXTENSIONS: [&str; 4] = ["txt", "md", "csv", "json"];

/// workspace.read max_bytes ceiling (DD:182).
pub const READ_MAX_BYTES: u64 = 262_144;
/// workspace.search bounds (DD:183).
pub const SEARCH_MAX_FILES: usize = 1000;
pub const SEARCH_MAX_DEPTH: usize = 8;
pub const SEARCH_MAX_SCAN_BYTES: u64 = 16 * 1024 * 1024;
pub const SEARCH_MAX_FILE_BYTES: u64 = 256 * 1024;
pub const SEARCH_QUERY_MAX_CHARS: usize = 256;
/// workspace.list limit ceiling (DD:181).
pub const LIST_MAX_LIMIT: u64 = 200;
/// Relative-path depth ceiling (§4.2 step 2 "超深度").
pub const PATH_MAX_DEPTH: usize = 32;

/// A tool-arg / path refusal. Each maps to a closed tool_result/tool_blocked reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolError {
    /// An arg key outside the closed schema, or a missing required key.
    Schema,
    /// A relative_path violated §4.2 step 2 (absolute / drive / `..` / reparse-confusion / etc.).
    BadPath,
    /// A numeric bound was exceeded (limit / max_bytes / query length).
    Bound,
    /// A format outside the text closed set.
    BadFormat,
}

/// Reserved DOS device names (§4.2 step 2), case-insensitive, with or without an extension.
const DOS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Validate a device relative_path against §4.2 step 2. Returns the normalized segments (for
/// display/hash ONLY — never authorization). Rejects: absolute paths, drive letters, `..`/`.`
/// segments, empty segments, backslash confusion, ADS colons, NUL, reserved DOS names, trailing
/// space/dot, and over-depth. Forward slashes are the only separator accepted.
pub fn validate_relative_path(path: &str) -> Result<Vec<String>, ToolError> {
    if path.is_empty() || path.contains('\0') || path.contains('\\') || path.contains(':') {
        return Err(ToolError::BadPath);
    }
    // Absolute (leading '/') or any drive-letter prefix is refused.
    if path.starts_with('/') {
        return Err(ToolError::BadPath);
    }
    let mut segments = Vec::new();
    for seg in path.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(ToolError::BadPath);
        }
        // Trailing space or dot on a segment (Win32 strips them, a confusion vector).
        if seg.ends_with(' ') || seg.ends_with('.') {
            return Err(ToolError::BadPath);
        }
        // Reserved DOS name (strip extension for the check, case-insensitive).
        let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
        if DOS_RESERVED.contains(&stem.as_str()) {
            return Err(ToolError::BadPath);
        }
        segments.push(seg.to_string());
    }
    if segments.is_empty() || segments.len() > PATH_MAX_DEPTH {
        return Err(ToolError::BadPath);
    }
    Ok(segments)
}

// NT names must stay within one verified directory and fit UNICODE_STRING's u16 byte length.
pub fn validate_file_name(name: &str) -> Result<(), ToolError> {
    if validate_relative_path(name)?.len() != 1
        || name.encode_utf16().count() > usize::from(u16::MAX) / 2
    {
        return Err(ToolError::BadPath);
    }
    Ok(())
}

/// The TOCTOU-closed sealed buffer (§4.2 step 5): the Broker reads a verified handle ONCE into this
/// immutable buffer, checks expected hash/size, then hands THIS buffer to Node/searcher — never a
/// second read of the source. Approval previews seal the same buffer bound to its hash; execution
/// either continues with the approved buffer or returns source_changed, never substitutes new bytes.
#[derive(Clone, Debug)]
pub struct SealedBuffer {
    bytes: Vec<u8>,
    hash: String,
}

impl SealedBuffer {
    /// Seal bytes with their sha256 hex hash (the `sha256:` form the device face uses).
    pub fn seal(bytes: Vec<u8>) -> Self {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&bytes);
        let hash = format!("sha256:{}", hex_lower(&digest));
        Self { bytes, hash }
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn hash(&self) -> &str {
        &self.hash
    }

    pub fn len(&self) -> u64 {
        self.bytes.len() as u64
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Verify against an expected hash AND size before release (§4.2 step 5). A mismatch (e.g. an
    /// in-place write during read) is refused, never silently truncated or substituted.
    pub fn verify(&self, expected_hash: &str, expected_size: u64) -> Result<(), ToolError> {
        if self.hash != expected_hash || self.len() != expected_size {
            return Err(ToolError::Bound);
        }
        Ok(())
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Validate a tool's args against its closed schema (additionalProperties=false). Returns the parsed
/// grant_id every tool carries. The platform executor reads the remaining fields after this gate.
pub fn validate_args(tool: &str, args: &Value) -> Result<String, ToolError> {
    let obj = args.as_object().ok_or(ToolError::Schema)?;
    let allowed: &[&str] = match tool {
        WORKSPACE_LIST => &["grant_id", "relative_dir", "cursor", "limit"],
        WORKSPACE_READ => &["grant_id", "entry_ref", "expected_identity", "max_bytes"],
        WORKSPACE_SEARCH => &["grant_id", "relative_dir", "literal_query", "limit"],
        ARTIFACT_WRITE => &[
            "grant_id",
            "artifact_id",
            "version_id",
            "format",
            "body_ref",
            "content_hash",
            "byte_count",
        ],
        _ => return Err(ToolError::Schema),
    };
    // grant_id is required for every tool; the rest are required per schema except list/search cursor.
    for key in obj.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(ToolError::Schema);
        }
    }
    let grant_id = obj
        .get("grant_id")
        .and_then(|v| v.as_str())
        .ok_or(ToolError::Schema)?
        .to_string();
    match tool {
        WORKSPACE_LIST => {
            require_str(obj, "relative_dir")?;
            let limit = require_u64(obj, "limit")?;
            if !(1..=LIST_MAX_LIMIT).contains(&limit) {
                return Err(ToolError::Bound);
            }
            validate_relative_path(obj["relative_dir"].as_str().unwrap())?;
        }
        WORKSPACE_READ => {
            require_str(obj, "entry_ref")?;
            require_str(obj, "expected_identity")?;
            let max_bytes = require_u64(obj, "max_bytes")?;
            if max_bytes == 0 || max_bytes > READ_MAX_BYTES {
                return Err(ToolError::Bound);
            }
        }
        WORKSPACE_SEARCH => {
            require_str(obj, "relative_dir")?;
            let query = obj["literal_query"].as_str().ok_or(ToolError::Schema)?;
            let chars = query.chars().count();
            if chars == 0 || chars > SEARCH_QUERY_MAX_CHARS {
                return Err(ToolError::Bound);
            }
            let limit = require_u64(obj, "limit")?;
            if !(1..=100).contains(&limit) {
                return Err(ToolError::Bound);
            }
            validate_relative_path(obj["relative_dir"].as_str().unwrap())?;
        }
        ARTIFACT_WRITE => {
            for key in [
                "artifact_id",
                "version_id",
                "format",
                "body_ref",
                "content_hash",
            ] {
                require_str(obj, key)?;
            }
            require_u64(obj, "byte_count")?;
            let format = obj["format"].as_str().unwrap().to_ascii_lowercase();
            if !TEXT_EXTENSIONS.contains(&format.as_str()) {
                return Err(ToolError::BadFormat);
            }
            let version_id = obj["version_id"].as_str().unwrap();
            validate_file_name(version_id)?;
            validate_file_name(&format!("{version_id}.{format}"))?;
        }
        _ => return Err(ToolError::Schema),
    }
    Ok(grant_id)
}

fn require_str(obj: &serde_json::Map<String, Value>, key: &str) -> Result<(), ToolError> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(|_| ())
        .ok_or(ToolError::Schema)
}

fn require_u64(obj: &serde_json::Map<String, Value>, key: &str) -> Result<u64, ToolError> {
    // u64 members cross as decimal strings (the device wire convention); also accept a JSON number.
    match obj.get(key) {
        Some(Value::String(s)) => s.parse::<u64>().map_err(|_| ToolError::Schema),
        Some(Value::Number(n)) => n.as_u64().ok_or(ToolError::Schema),
        _ => Err(ToolError::Schema),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relative_path_accepts_normal_nested_paths() {
        assert_eq!(
            validate_relative_path("docs/readme.md").unwrap(),
            vec!["docs".to_string(), "readme.md".to_string()]
        );
        assert_eq!(validate_relative_path("a").unwrap(), vec!["a".to_string()]);
    }

    #[test]
    fn relative_path_refuses_every_confusion_vector() {
        for bad in [
            "",
            "/abs",
            "C:/x",
            "c:\\x",
            "..",
            "a/../b",
            "./a",
            "a//b",
            "a\\b",
            "a:b",
            "a\0b",
            "CON",
            "con.txt",
            "NUL.md",
            "COM1",
            "LPT9.json",
            "a.",
            "a ",
            "trail /x",
        ] {
            assert!(validate_relative_path(bad).is_err(), "accepted {bad:?}");
        }
        // Over-depth.
        let deep = (0..PATH_MAX_DEPTH + 1)
            .map(|i| format!("d{i}"))
            .collect::<Vec<_>>()
            .join("/");
        assert!(validate_relative_path(&deep).is_err());
    }

    #[test]
    fn artifact_version_and_file_name_require_one_safe_component() {
        let mut args = json!({ "grant_id": "g", "artifact_id": "a", "version_id": "v1",
            "format": "md", "body_ref": "b", "content_hash": "sha256:x", "byte_count": "1" });
        for valid in ["v1", "release-1", "版本1"] {
            args["version_id"] = json!(valid);
            assert!(validate_args(ARTIFACT_WRITE, &args).is_ok());
            assert!(validate_file_name(&format!("{valid}.md")).is_ok());
        }
        for bad in [
            "",
            "a/b",
            "a\\b",
            "../v1",
            "..\\v1",
            "/abs",
            "C:evil",
            "v1:ads",
            "v1\0tail",
            ".",
            "..",
            "CON",
            "nul.txt",
            "COM1",
            "LPT9.json",
            "v1.",
            "v1 ",
        ] {
            args["version_id"] = json!(bad);
            assert_eq!(
                validate_args(ARTIFACT_WRITE, &args),
                Err(ToolError::BadPath),
                "{bad:?}"
            );
            assert_eq!(validate_file_name(bad), Err(ToolError::BadPath), "{bad:?}");
        }
    }

    #[test]
    fn artifact_file_name_checks_utf16_byte_length_without_truncation() {
        // Only the NT representation limit is imposed here; the filesystem applies its own limit.
        assert!(validate_file_name(&"a".repeat(32767)).is_ok());
        assert_eq!(
            validate_file_name(&"a".repeat(32768)),
            Err(ToolError::BadPath)
        );
        let astral = "\u{10000}".repeat(16384);
        assert_eq!(validate_file_name(&astral), Err(ToolError::BadPath));
        let args = json!({ "grant_id": "g", "artifact_id": "a", "version_id": "a".repeat(32765),
            "format": "md", "body_ref": "b", "content_hash": "sha256:x", "byte_count": "1" });
        // The extension must also fit; checking just version_id would miss this overflow.
        assert_eq!(
            validate_args(ARTIFACT_WRITE, &args),
            Err(ToolError::BadPath)
        );
    }

    #[test]
    fn sealed_buffer_verifies_hash_and_size_and_refuses_mismatch() {
        let buf = SealedBuffer::seal(b"hello".to_vec());
        assert_eq!(buf.len(), 5);
        assert!(buf.hash().starts_with("sha256:"));
        assert!(buf.verify(buf.hash(), 5).is_ok());
        assert!(buf.verify(buf.hash(), 6).is_err());
        assert!(buf.verify("sha256:other", 5).is_err());
    }

    #[test]
    fn tool_args_closed_schema_and_bounds() {
        let list = json!({ "grant_id": "g", "relative_dir": "docs", "limit": "50" });
        assert_eq!(validate_args(WORKSPACE_LIST, &list).unwrap(), "g");
        // Extra key refused.
        let extra =
            json!({ "grant_id": "g", "relative_dir": "docs", "limit": "50", "path": "/etc" });
        assert_eq!(
            validate_args(WORKSPACE_LIST, &extra),
            Err(ToolError::Schema)
        );
        // limit out of range.
        let big = json!({ "grant_id": "g", "relative_dir": "docs", "limit": "201" });
        assert_eq!(validate_args(WORKSPACE_LIST, &big), Err(ToolError::Bound));
        // read max_bytes ceiling.
        let read = json!({ "grant_id": "g", "entry_ref": "e", "expected_identity": "id", "max_bytes": "262145" });
        assert_eq!(validate_args(WORKSPACE_READ, &read), Err(ToolError::Bound));
        // artifact.write format closed set.
        let write = json!({ "grant_id": "g", "artifact_id": "a", "version_id": "v", "format": "exe",
            "body_ref": "b", "content_hash": "sha256:x", "byte_count": "1" });
        assert_eq!(
            validate_args(ARTIFACT_WRITE, &write),
            Err(ToolError::BadFormat)
        );
        let ok_write = json!({ "grant_id": "g", "artifact_id": "a", "version_id": "v", "format": "md",
            "body_ref": "b", "content_hash": "sha256:x", "byte_count": "1" });
        assert_eq!(validate_args(ARTIFACT_WRITE, &ok_write).unwrap(), "g");
        // Unknown tool refused.
        assert_eq!(
            validate_args("shell.exec", &json!({})),
            Err(ToolError::Schema)
        );
    }
}
