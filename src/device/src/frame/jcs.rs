//! RFC 8785 JSON Canonicalization Scheme (JCS). Every signed frame document is
//! canonicalized to JCS UTF-8 before ES256 (device-design §2.1/§3.1). Uses the
//! `serde_jcs` implementation (ECMAScript number serialization, UTF-16 code-unit
//! key ordering, minimal string escaping) rather than hand-rolling the tricky
//! number formatting.

use serde::Serialize;

/// A canonicalization failure.
#[derive(Debug)]
pub struct JcsError(pub serde_json::Error);

/// Canonicalize a serializable value to JCS UTF-8 bytes.
pub fn canonicalize<T: Serialize>(value: &T) -> Result<Vec<u8>, JcsError> {
    serde_jcs::to_vec(value).map_err(JcsError)
}

/// Canonicalize a serializable value to a JCS UTF-8 string.
pub fn canonicalize_string<T: Serialize>(value: &T) -> Result<String, JcsError> {
    serde_jcs::to_string(value).map_err(JcsError)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_object_keys() {
        assert_eq!(
            canonicalize_string(&json!({"z": 1, "a": 2})).unwrap(),
            r#"{"a":2,"z":1}"#
        );
    }

    #[test]
    fn sorts_nested_keys() {
        assert_eq!(
            canonicalize_string(&json!({"b": {"d": 1, "c": 2}, "a": 3})).unwrap(),
            r#"{"a":3,"b":{"c":2,"d":1}}"#
        );
    }

    #[test]
    fn normalizes_numbers() {
        assert_eq!(
            canonicalize_string(&json!({"n": 1.0})).unwrap(),
            r#"{"n":1}"#
        );
        assert_eq!(
            canonicalize_string(&json!({"n": 1.5})).unwrap(),
            r#"{"n":1.5}"#
        );
    }

    #[test]
    fn preserves_array_order() {
        assert_eq!(canonicalize_string(&json!([3, 1, 2])).unwrap(), "[3,1,2]");
    }

    #[test]
    fn minimal_string_escaping() {
        assert_eq!(
            canonicalize_string(&json!({"s": "a\"b\\c"})).unwrap(),
            r#"{"s":"a\"b\\c"}"#
        );
    }

    #[test]
    fn utf8_passthrough() {
        // Non-ASCII characters are emitted as UTF-8, not \u escapes.
        assert_eq!(
            canonicalize_string(&json!({"s": "é"})).unwrap(),
            "{\"s\":\"é\"}"
        );
    }

    #[test]
    fn no_whitespace() {
        let out = canonicalize_string(&json!({"a": [1, 2], "b": {"c": 3}})).unwrap();
        assert!(!out.contains(' '));
        assert!(!out.contains('\n'));
    }
}
