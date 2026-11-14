//! The closed EC P-256 public JWK (device-design §2.1; SQL 0040
//! `device_pubkey_valid`). Exactly four members `{kty:"EC", crv:"P-256", x, y}`;
//! any private field (`d`/`p`/`q`/`dp`/`dq`/`qi`/`k`) or extra member is refused,
//! and `x`/`y` must be 43-char base64url decoding to 32 bytes.

use serde::Serialize;
use serde_json::Value;

use crate::b64;

/// A validated EC P-256 public JWK. Construct only via [`EcP256Jwk::from_coords`]
/// or [`validate_json`]; the fields are public for serialization but the closed
/// set is enforced at construction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EcP256Jwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub y: String,
}

/// Why a JWK body was refused. Mirrors the closed-set checks in SQL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JwkError {
    NotObject,
    KeySet,
    Kty,
    Crv,
    Coordinate,
}

impl EcP256Jwk {
    /// Build from raw 32-byte affine coordinates.
    pub fn from_coords(x: &[u8], y: &[u8]) -> Self {
        Self {
            kty: "EC".to_string(),
            crv: "P-256".to_string(),
            x: b64::encode(x),
            y: b64::encode(y),
        }
    }

    /// The uncompressed SEC1 point `0x04 || X || Y` for ES256 verification.
    pub fn to_encoded_point(&self) -> Result<Vec<u8>, JwkError> {
        let x = decode_coord(&self.x)?;
        let y = decode_coord(&self.y)?;
        let mut point = Vec::with_capacity(65);
        point.push(0x04);
        point.extend_from_slice(&x);
        point.extend_from_slice(&y);
        Ok(point)
    }

    /// Serialize as the exact four-member JSON object.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("JWK serializes")
    }
}

fn decode_coord(text: &str) -> Result<[u8; 32], JwkError> {
    if text.len() != 43
        || !text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(JwkError::Coordinate);
    }
    let bytes = b64::decode(text).map_err(|_| JwkError::Coordinate)?;
    <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| JwkError::Coordinate)
}

/// Validate a JSON body against the closed set, returning the typed JWK.
pub fn validate_json(raw: &str) -> Result<EcP256Jwk, JwkError> {
    let value: Value = serde_json::from_str(raw).map_err(|_| JwkError::NotObject)?;
    let obj = value.as_object().ok_or(JwkError::NotObject)?;
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    if keys != ["crv", "kty", "x", "y"] {
        return Err(JwkError::KeySet);
    }
    let kty = obj["kty"].as_str().ok_or(JwkError::Kty)?;
    let crv = obj["crv"].as_str().ok_or(JwkError::Crv)?;
    if kty != "EC" {
        return Err(JwkError::Kty);
    }
    if crv != "P-256" {
        return Err(JwkError::Crv);
    }
    let x = obj["x"].as_str().ok_or(JwkError::Coordinate)?;
    let y = obj["y"].as_str().ok_or(JwkError::Coordinate)?;
    decode_coord(x)?;
    decode_coord(y)?;
    Ok(EcP256Jwk {
        kty: kty.to_string(),
        crv: crv.to_string(),
        x: x.to_string(),
        y: y.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> EcP256Jwk {
        EcP256Jwk::from_coords(&[1u8; 32], &[2u8; 32])
    }

    #[test]
    fn serializes_exactly_four_members() {
        let json = sample().to_json();
        let value: Value = serde_json::from_str(&json).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["crv", "kty", "x", "y"]);
    }

    #[test]
    fn accepts_valid_body() {
        let jwk = sample();
        assert_eq!(validate_json(&jwk.to_json()).unwrap(), jwk);
    }

    #[test]
    fn rejects_private_field() {
        let mut value: Value = serde_json::from_str(&sample().to_json()).unwrap();
        value["d"] = Value::String(b64::encode(&[3u8; 32]));
        assert_eq!(validate_json(&value.to_string()), Err(JwkError::KeySet));
    }

    #[test]
    fn rejects_wrong_kty_and_crv() {
        let mut value: Value = serde_json::from_str(&sample().to_json()).unwrap();
        value["kty"] = Value::String("RSA".into());
        assert_eq!(validate_json(&value.to_string()), Err(JwkError::Kty));
        let mut value: Value = serde_json::from_str(&sample().to_json()).unwrap();
        value["crv"] = Value::String("P-384".into());
        assert_eq!(validate_json(&value.to_string()), Err(JwkError::Crv));
    }

    #[test]
    fn rejects_short_coordinate() {
        let mut value: Value = serde_json::from_str(&sample().to_json()).unwrap();
        value["x"] = Value::String("AAAA".into());
        assert_eq!(validate_json(&value.to_string()), Err(JwkError::Coordinate));
    }

    #[test]
    fn encoded_point_is_uncompressed_65_bytes() {
        let point = sample().to_encoded_point().unwrap();
        assert_eq!(point.len(), 65);
        assert_eq!(point[0], 0x04);
        assert_eq!(&point[1..33], &[1u8; 32]);
        assert_eq!(&point[33..65], &[2u8; 32]);
    }
}
