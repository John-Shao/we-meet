//! uint64 boundary adapters (device-design §3.1; m1a §7 hard constraint ①).
//! uint64 seq/epoch/fence cross the JSON/TS boundary as decimal strings, never
//! floats (a float would silently lose precision above 2^53). Apply with
//! `#[serde(with = "crate::frame::u64string")]` on `u64` fields, or the `opt`
//! submodule for `Option<u64>`.

use serde::{Deserialize, Deserializer, Serializer};

/// Serialize a `u64` as a decimal string.
pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

/// Deserialize a decimal string into a `u64`, rejecting floats/non-numerics.
pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let text = String::deserialize(deserializer)?;
    text.parse::<u64>().map_err(serde::de::Error::custom)
}

/// Adapters for `Option<u64>` (null stays null, present values are strings).
pub mod opt {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(v) => serializer.serialize_str(&v.to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<u64>, D::Error> {
        match Option::<String>::deserialize(deserializer)? {
            Some(text) => text
                .parse::<u64>()
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Row {
        #[serde(with = "super")]
        seq: u64,
    }

    #[test]
    fn serializes_as_decimal_string() {
        let json = serde_json::to_string(&Row { seq: 42 }).unwrap();
        assert_eq!(json, r#"{"seq":"42"}"#);
    }

    #[test]
    fn round_trips_above_2pow53() {
        // 2^53 + 1 cannot be represented exactly as an f64.
        let value = 9_007_199_254_740_993u64;
        let json = serde_json::to_string(&Row { seq: value }).unwrap();
        assert_eq!(json, r#"{"seq":"9007199254740993"}"#);
        let back: Row = serde_json::from_str(&json).unwrap();
        assert_eq!(back.seq, value);
    }

    #[test]
    fn rejects_float_boundary() {
        let err = serde_json::from_str::<Row>(r#"{"seq":42.0}"#);
        assert!(err.is_err());
    }

    #[test]
    fn max_u64_round_trips() {
        let value = u64::MAX;
        let json = serde_json::to_string(&Row { seq: value }).unwrap();
        let back: Row = serde_json::from_str(&json).unwrap();
        assert_eq!(back.seq, value);
    }
}
