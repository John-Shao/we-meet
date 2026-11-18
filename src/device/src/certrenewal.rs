//! The certificate-renewal signature domain (device-design §2.1 step 4; SQL 0058
//! `confirm_device_certificate_renewal`).
//!
//! §2.1 forbids reusing a signature domain across purposes, so renewal is NOT the pairing
//! domain with a different label: it is its own prefix, and a pairing signature over the same
//! pairing_id/challenge must not verify here (and vice versa). The covered string is the same
//! pipe-delimited UTF-8 layout the server rebuilds from in-DB values:
//! `work-device-cert-renew-v2|{pairing_id}|{challenge}|{thumbprint}|{org_id}|{subject_id}`.
//!
//! The domain string is the implementation's choice, registered as such: §2.1 names only the
//! pairing domain. It matches Go `internal/devicesig/certrenewal.go` and SQL 0058 byte for byte.

use crate::b64;
use crate::key::{DeviceKey, KeyError};

/// The certificate-renewal message-type domain prefix (SQL 0058; Go CertRenewalDomain).
pub const RENEW_DOMAIN: &str = "work-device-cert-renew-v2";

/// Build the exact covered string the server recomputes from in-DB values.
pub fn covered_string(
    pairing_id: &str,
    challenge: &str,
    thumbprint: &str,
    org_id: &str,
    subject_id: &str,
) -> String {
    format!("{RENEW_DOMAIN}|{pairing_id}|{challenge}|{thumbprint}|{org_id}|{subject_id}")
}

/// Sign a certificate-renewal confirmation with the device key, returning the base64url
/// ES256 R||S signature. The thumbprint comes from the key itself, so it always matches the
/// public JWK the server holds for this device.
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
    use crate::pairing;

    #[test]
    fn covered_string_matches_sql_shape() {
        let covered = covered_string("pid", "chal", "tp", "org", "sub");
        assert_eq!(covered, "work-device-cert-renew-v2|pid|chal|tp|org|sub");
    }

    #[test]
    fn the_two_domains_are_not_the_same_string() {
        assert_ne!(RENEW_DOMAIN, pairing::PAIR_DOMAIN);
        let renewal = covered_string("pid", "chal", "tp", "org", "sub");
        let pair = pairing::covered_string("pid", "chal", "tp", "org", "sub");
        assert_ne!(renewal, pair);
    }

    #[test]
    fn signature_verifies_over_its_own_covered_string() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let signature = sign(&key, "pid", "chal", "org", "sub").unwrap();
        let covered = covered_string("pid", "chal", &key.thumbprint(), "org", "sub");
        assert!(es256::verify(&jwk, covered.as_bytes(), &signature));
    }

    #[test]
    fn a_pairing_signature_does_not_verify_as_a_renewal() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        // Same device, same pairing_id, same challenge: only the domain differs. §2.1 forbids
        // cross-purpose replay, so each direction must fail.
        let pair_sig = pairing::sign(&key, "pid", "chal", "org", "sub").unwrap();
        let renewal_covered = covered_string("pid", "chal", &key.thumbprint(), "org", "sub");
        assert!(!es256::verify(&jwk, renewal_covered.as_bytes(), &pair_sig));

        let renew_sig = sign(&key, "pid", "chal", "org", "sub").unwrap();
        let pair_covered = pairing::covered_string("pid", "chal", &key.thumbprint(), "org", "sub");
        assert!(!es256::verify(&jwk, pair_covered.as_bytes(), &renew_sig));
    }

    #[test]
    fn signature_binds_every_field() {
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let signature = sign(&key, "pid", "chal", "org", "sub").unwrap();
        for tampered in [
            covered_string("other", "chal", &key.thumbprint(), "org", "sub"),
            covered_string("pid", "other", &key.thumbprint(), "org", "sub"),
            covered_string("pid", "chal", "other", "org", "sub"),
            covered_string("pid", "chal", &key.thumbprint(), "other", "sub"),
            covered_string("pid", "chal", &key.thumbprint(), "org", "other"),
        ] {
            assert!(!es256::verify(&jwk, tampered.as_bytes(), &signature));
        }
    }

    #[test]
    fn a_different_key_does_not_verify() {
        let key = SoftwareKey::random();
        let other = SoftwareKey::random();
        let signature = sign(&key, "pid", "chal", "org", "sub").unwrap();
        let covered = covered_string("pid", "chal", &other.thumbprint(), "org", "sub");
        assert!(!es256::verify(
            &other.public_jwk(),
            covered.as_bytes(),
            &signature
        ));
    }
}
