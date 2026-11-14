//! Windows CNG device key (device-design §2.1): a non-exportable P-256 signing
//! key held by the Microsoft Software Key Storage Provider. The private scalar
//! never leaves CNG; only the public JWK is exported. ES256 signatures come from
//! NCryptSignHash as raw R||S (no padding info), never DER.
//!
//! This is the production device identity. The export policy is set to zero so
//! the private key cannot be exported; public-key export (ECCPUBLICBLOB) is not
//! governed by that policy and still succeeds.

use sha2::{Digest, Sha256};
use windows::core::{w, PCWSTR};
use windows::Win32::Security::Cryptography::{
    NCryptCreatePersistedKey, NCryptDeleteKey, NCryptExportKey, NCryptFinalizeKey,
    NCryptFreeObject, NCryptOpenKey, NCryptOpenStorageProvider, NCryptSetProperty, NCryptSignHash,
    CERT_KEY_SPEC, NCRYPT_FLAGS, NCRYPT_HANDLE, NCRYPT_KEY_HANDLE, NCRYPT_PROV_HANDLE,
};

use crate::jwk::EcP256Jwk;
use crate::key::{DeviceKey, KeyError};

/// A persisted, non-exportable CNG P-256 signing key.
pub struct CngKey {
    provider: NCRYPT_PROV_HANDLE,
    key: NCRYPT_KEY_HANDLE,
    jwk: EcP256Jwk,
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

impl CngKey {
    /// Create and finalize a new persisted key under `name`, denying private
    /// export. Fails if a key with that name already exists.
    pub fn create(name: &str) -> Result<Self, KeyError> {
        unsafe {
            let mut provider = NCRYPT_PROV_HANDLE::default();
            NCryptOpenStorageProvider(
                &mut provider,
                w!("Microsoft Software Key Storage Provider"),
                0,
            )
            .map_err(|_| KeyError::Sign)?;
            let mut key = NCRYPT_KEY_HANDLE::default();
            let name_w = wide(name);
            NCryptCreatePersistedKey(
                provider,
                &mut key,
                w!("ECDSA_P256"),
                PCWSTR(name_w.as_ptr()),
                CERT_KEY_SPEC(0),
                NCRYPT_FLAGS(0),
            )
            .map_err(|_| KeyError::Sign)?;
            // Export policy 0 = no private export (public export unaffected).
            let policy = 0u32.to_le_bytes();
            NCryptSetProperty(
                NCRYPT_HANDLE(key.0),
                w!("Export Policy"),
                &policy,
                NCRYPT_FLAGS(0),
            )
            .map_err(|_| KeyError::Sign)?;
            NCryptFinalizeKey(key, NCRYPT_FLAGS(0)).map_err(|_| KeyError::Sign)?;
            let jwk = export_public(key)?;
            Ok(Self { provider, key, jwk })
        }
    }

    /// Open an existing persisted key by name.
    pub fn open(name: &str) -> Result<Self, KeyError> {
        unsafe {
            let mut provider = NCRYPT_PROV_HANDLE::default();
            NCryptOpenStorageProvider(
                &mut provider,
                w!("Microsoft Software Key Storage Provider"),
                0,
            )
            .map_err(|_| KeyError::Sign)?;
            let mut key = NCRYPT_KEY_HANDLE::default();
            let name_w = wide(name);
            NCryptOpenKey(
                provider,
                &mut key,
                PCWSTR(name_w.as_ptr()),
                CERT_KEY_SPEC(0),
                NCRYPT_FLAGS(0),
            )
            .map_err(|_| KeyError::Sign)?;
            let jwk = export_public(key)?;
            Ok(Self { provider, key, jwk })
        }
    }

    /// Delete the persisted key from the provider and release handles.
    pub fn delete(mut self) -> Result<(), KeyError> {
        unsafe {
            let key = self.key;
            let provider = self.provider;
            self.key = NCRYPT_KEY_HANDLE::default();
            self.provider = NCRYPT_PROV_HANDLE::default();
            NCryptDeleteKey(key, 0).map_err(|_| KeyError::Sign)?;
            NCryptFreeObject(NCRYPT_HANDLE(provider.0)).map_err(|_| KeyError::Sign)?;
            Ok(())
        }
    }
}

/// Export the public key as an ECCPUBLICBLOB and read the affine X/Y coordinates.
///
/// # Safety
/// `key` must be a finalized CNG key handle.
unsafe fn export_public(key: NCRYPT_KEY_HANDLE) -> Result<EcP256Jwk, KeyError> {
    let mut len: u32 = 0;
    NCryptExportKey(
        key,
        NCRYPT_KEY_HANDLE::default(),
        w!("ECCPUBLICBLOB"),
        None,
        None,
        &mut len,
        NCRYPT_FLAGS(0),
    )
    .map_err(|_| KeyError::Sign)?;
    let mut buf = vec![0u8; len as usize];
    NCryptExportKey(
        key,
        NCRYPT_KEY_HANDLE::default(),
        w!("ECCPUBLICBLOB"),
        None,
        Some(&mut buf),
        &mut len,
        NCRYPT_FLAGS(0),
    )
    .map_err(|_| KeyError::Sign)?;
    // BCRYPT_ECCKEY_BLOB: dwMagic u32, cbKey u32, X[cbKey], Y[cbKey].
    if buf.len() < 8 {
        return Err(KeyError::Sign);
    }
    let cb_key = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize;
    if cb_key != 32 || buf.len() < 8 + 2 * cb_key {
        return Err(KeyError::Sign);
    }
    let x = &buf[8..8 + cb_key];
    let y = &buf[8 + cb_key..8 + 2 * cb_key];
    Ok(EcP256Jwk::from_coords(x, y))
}

impl DeviceKey for CngKey {
    fn public_jwk(&self) -> EcP256Jwk {
        self.jwk.clone()
    }

    fn sign_es256(&self, msg: &[u8]) -> Result<[u8; 64], KeyError> {
        let hash = Sha256::digest(msg);
        unsafe {
            let mut len: u32 = 0;
            NCryptSignHash(
                self.key,
                None,
                hash.as_slice(),
                None,
                &mut len,
                NCRYPT_FLAGS(0),
            )
            .map_err(|_| KeyError::Sign)?;
            let mut sig = vec![0u8; len as usize];
            NCryptSignHash(
                self.key,
                None,
                hash.as_slice(),
                Some(&mut sig),
                &mut len,
                NCRYPT_FLAGS(0),
            )
            .map_err(|_| KeyError::Sign)?;
            <[u8; 64]>::try_from(sig.as_slice()).map_err(|_| KeyError::Sign)
        }
    }
}

impl Drop for CngKey {
    fn drop(&mut self) {
        unsafe {
            if self.key.0 != 0 {
                let _ = NCryptFreeObject(NCRYPT_HANDLE(self.key.0));
            }
            if self.provider.0 != 0 {
                let _ = NCryptFreeObject(NCRYPT_HANDLE(self.provider.0));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::es256;
    use crate::pairing;

    fn unique_name() -> String {
        use rand_core::RngCore;
        let mut bytes = [0u8; 16];
        rand_core::OsRng.fill_bytes(&mut bytes);
        format!("work-device-test-{}", crate::sha256_hex(&bytes))
    }

    #[test]
    fn creates_non_exportable_key_and_signs() {
        let name = unique_name();
        let key = CngKey::create(&name).expect("create CNG key");
        let jwk = key.public_jwk();
        assert_eq!(jwk.kty, "EC");
        assert_eq!(jwk.crv, "P-256");

        let msg = b"work-device-pair-v2|pid|chal|tp|org|sub";
        let sig = key.sign_es256(msg).expect("CNG sign");
        assert!(es256::verify(&jwk, msg, &crate::b64::encode(&sig)));

        let signature = pairing::sign(&key, "pid", "chal", "org", "sub").unwrap();
        let covered = pairing::covered_string("pid", "chal", &key.thumbprint(), "org", "sub");
        assert!(es256::verify(&jwk, covered.as_bytes(), &signature));

        key.delete().expect("delete CNG key");
    }

    #[test]
    fn reopened_key_matches_and_private_export_denied() {
        let name = unique_name();
        let created = CngKey::create(&name).expect("create");
        let jwk = created.public_jwk();
        drop(created);

        let reopened = CngKey::open(&name).expect("open");
        assert_eq!(reopened.public_jwk(), jwk);
        let sig = reopened.sign_es256(b"msg").expect("sign");
        assert!(es256::verify(&jwk, b"msg", &crate::b64::encode(&sig)));

        // Attempting to export the private key (ECCPRIVATEBLOB) must fail.
        let mut len: u32 = 0;
        let result = unsafe {
            NCryptExportKey(
                reopened.key,
                NCRYPT_KEY_HANDLE::default(),
                w!("ECCPRIVATEBLOB"),
                None,
                None,
                &mut len,
                NCRYPT_FLAGS(0),
            )
        };
        assert!(result.is_err(), "private export must be denied");

        reopened.delete().expect("delete");
    }
}
