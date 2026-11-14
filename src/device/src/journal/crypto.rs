//! AES-256-GCM record encryption (device-design §6.1). Every content/parameter/
//! path/checkpoint blob is sealed with the per-device DEK; the AAD binds
//! org/subject/device/journal_epoch/record_type/record_id/schema_version so a
//! ciphertext cannot be replayed under another identity or record. Each write
//! draws a fresh 12-byte nonce (never reused). The sealed layout is
//! `nonce(12) || ciphertext+tag`, so no plaintext reaches the WAL.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use rand_core::RngCore;

/// GCM nonce length (96 bits, the standard size).
pub const NONCE_LEN: usize = 12;

/// A cryptographic failure. `Open` covers tampering, wrong AAD and wrong key —
/// all fail closed without distinguishing the cause to the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CryptoError {
    Key,
    Seal,
    Open,
}

/// Bind the record identity into the AAD. Pipe-delimited and local to the device
/// (it seals and opens its own journal); the encoding only needs to be
/// deterministic, matching the thumbprint/pairing preimage style.
pub fn aad(
    org: &str,
    subject: &str,
    device: &str,
    journal_epoch: &str,
    record_type: &str,
    record_id: &str,
    schema_version: u32,
) -> String {
    format!("{org}|{subject}|{device}|{journal_epoch}|{record_type}|{record_id}|{schema_version}")
}

/// Seal `plaintext` under `dek` with `aad`, returning `nonce || ciphertext+tag`.
pub fn seal(dek: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(dek).map_err(|_| CryptoError::Key)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand_core::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Seal)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Open a sealed blob produced by [`seal`]. Fails closed on any mismatch.
pub fn open(dek: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if sealed.len() < NONCE_LEN {
        return Err(CryptoError::Open);
    }
    let (nonce_bytes, ciphertext) = sealed.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(dek).map_err(|_| CryptoError::Key)?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Open)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dek() -> [u8; 32] {
        [7u8; 32]
    }

    #[test]
    fn round_trips_with_matching_aad() {
        let a = aad("org", "sub", "dev", "epoch", "action", "op1", 2);
        let sealed = seal(&dek(), a.as_bytes(), b"secret body").unwrap();
        assert_eq!(open(&dek(), a.as_bytes(), &sealed).unwrap(), b"secret body");
    }

    #[test]
    fn sealed_blob_has_no_plaintext() {
        let a = aad("org", "sub", "dev", "epoch", "action", "op1", 2);
        let plaintext = b"the quick brown fox jumps over the lazy dog";
        let sealed = seal(&dek(), a.as_bytes(), plaintext).unwrap();
        assert!(!sealed.windows(plaintext.len()).any(|w| w == plaintext));
        assert_eq!(sealed.len(), NONCE_LEN + plaintext.len() + 16);
    }

    #[test]
    fn wrong_aad_fails() {
        let a = aad("org", "sub", "dev", "epoch", "action", "op1", 2);
        let b = aad("org", "sub", "dev", "epoch", "action", "op2", 2);
        let sealed = seal(&dek(), a.as_bytes(), b"body").unwrap();
        assert_eq!(open(&dek(), b.as_bytes(), &sealed), Err(CryptoError::Open));
    }

    #[test]
    fn wrong_key_fails() {
        let a = aad("org", "sub", "dev", "epoch", "action", "op1", 2);
        let sealed = seal(&dek(), a.as_bytes(), b"body").unwrap();
        assert_eq!(
            open(&[8u8; 32], a.as_bytes(), &sealed),
            Err(CryptoError::Open)
        );
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let a = aad("org", "sub", "dev", "epoch", "action", "op1", 2);
        let mut sealed = seal(&dek(), a.as_bytes(), b"body").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert_eq!(open(&dek(), a.as_bytes(), &sealed), Err(CryptoError::Open));
    }

    #[test]
    fn nonce_is_unique_per_write() {
        let a = aad("org", "sub", "dev", "epoch", "action", "op1", 2);
        let s1 = seal(&dek(), a.as_bytes(), b"same").unwrap();
        let s2 = seal(&dek(), a.as_bytes(), b"same").unwrap();
        assert_ne!(s1[..NONCE_LEN], s2[..NONCE_LEN]);
        assert_ne!(s1, s2);
    }

    #[test]
    fn short_blob_fails() {
        let a = aad("org", "sub", "dev", "epoch", "action", "op1", 2);
        assert_eq!(
            open(&dek(), a.as_bytes(), &[0u8; 5]),
            Err(CryptoError::Open)
        );
    }
}
