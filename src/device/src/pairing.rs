//! The pairing signature domain (device-design §2.1 step 3; SQL 0040:1356).
//!
//! The covered string is pipe-delimited UTF-8, matching the server's
//! `v_canonical` byte for byte:
//! `work-device-pair-v2|{pairing_id}|{challenge}|{thumbprint}|{org_id}|{subject_id}`.
//! The signature is ES256 R||S, base64url with no padding. The general JCS rule
//! (device-design §2.1) applies to JSON message bodies (hello/journal/model
//! request); the pairing covered string is this pipe form, which the landed SQL
//! reconstructs. Server-side ES256 verification is the gateway's job (SQL only
//! shape-checks a placeholder today; tracked M1b/I4 + M3).

use crate::b64;
use crate::key::{DeviceKey, KeyError};

/// The pairing message-type domain prefix (SQL 0040:1356).
pub const PAIR_DOMAIN: &str = "work-device-pair-v2";

/// Build the exact covered string the server recomputes from in-DB values.
pub fn covered_string(
    pairing_id: &str,
    challenge: &str,
    thumbprint: &str,
    org_id: &str,
    subject_id: &str,
) -> String {
    format!("{PAIR_DOMAIN}|{pairing_id}|{challenge}|{thumbprint}|{org_id}|{subject_id}")
}

/// Sign a pairing confirmation with the device key, returning the base64url
/// ES256 R||S signature. The thumbprint is taken from the key itself so it always
/// matches the public JWK submitted at `POST /devices/pairings`.
pub fn sign(
    key: &dyn DeviceKey,
    pairing_id: &str,
    challenge: &str,
    org_id: &str,
    subject_id: &str,
) -> Result<String, KeyError> {
    let thumbprint = key.thumbprint();
    let covered = covered_string(pairing_id, challenge, &thumbprint, org_id, subject_id);
    let signature = key.sign_es256(covered.as_bytes())?;
    Ok(b64::encode(&signature))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::es256;
    use crate::key::SoftwareKey;

    #[test]
    fn covered_string_matches_sql_shape() {
        let covered = covered_string("pid", "chal", "tp", "org", "sub");
        assert_eq!(covered, "work-device-pair-v2|pid|chal|tp|org|sub");
    }

    #[test]
    fn signature_verifies_over_covered_string() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let signature = sign(&key, "pid", "chal", "org", "sub").unwrap();
        let covered = covered_string("pid", "chal", &key.thumbprint(), "org", "sub");
        assert!(es256::verify(&jwk, covered.as_bytes(), &signature));
    }

    #[test]
    fn signature_binds_every_field() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let signature = sign(&key, "pid", "chal", "org", "sub").unwrap();
        // A different subject must not verify under the same covered layout.
        let tampered = covered_string("pid", "chal", &key.thumbprint(), "org", "other");
        assert!(!es256::verify(&jwk, tampered.as_bytes(), &signature));
    }
}
