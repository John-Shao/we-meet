//! Per-device DEK and its at-rest wrapping (device-design §6.1). The DEK is a
//! random 32-byte AES key, kept separate from the CNG signing key. On Windows it
//! is wrapped by DPAPI in the CurrentUser scope (`CryptProtectData`); the wrapped
//! blob lives in `device_meta`. A test-only pass-through wrap backs non-Windows
//! builds and unit tests — it is never a production path.

use rand_core::RngCore;

/// A DEK wrapping failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WrapError {
    Protect,
    Unprotect,
    Length,
}

/// Generate a fresh random 32-byte DEK from OS entropy.
pub fn generate_dek() -> [u8; 32] {
    let mut dek = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut dek);
    dek
}

/// Wraps and unwraps the DEK for at-rest storage.
pub trait KeyWrap {
    fn wrap(&self, dek: &[u8; 32]) -> Result<Vec<u8>, WrapError>;
    fn unwrap(&self, wrapped: &[u8]) -> Result<[u8; 32], WrapError>;
}

/// DPAPI CurrentUser wrapping (production, Windows only).
#[cfg(windows)]
pub struct DpapiWrap;

#[cfg(windows)]
impl KeyWrap for DpapiWrap {
    fn wrap(&self, dek: &[u8; 32]) -> Result<Vec<u8>, WrapError> {
        use windows::core::w;
        use windows::Win32::Foundation::{LocalFree, HLOCAL};
        use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: dek.len() as u32,
                pbData: dek.as_ptr() as *mut u8,
            };
            let mut out = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            // CRYPTPROTECT_UI_FORBIDDEN (0x1); CurrentUser is the default scope.
            CryptProtectData(
                &input,
                w!("work-device DEK"),
                None,
                None,
                None,
                0x1,
                &mut out,
            )
            .map_err(|_| WrapError::Protect)?;
            let wrapped = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(HLOCAL(out.pbData as *mut core::ffi::c_void));
            Ok(wrapped)
        }
    }

    fn unwrap(&self, wrapped: &[u8]) -> Result<[u8; 32], WrapError> {
        use windows::Win32::Foundation::{LocalFree, HLOCAL};
        use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: wrapped.len() as u32,
                pbData: wrapped.as_ptr() as *mut u8,
            };
            let mut out = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            CryptUnprotectData(&input, None, None, None, None, 0x1, &mut out)
                .map_err(|_| WrapError::Unprotect)?;
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize);
            let dek = <[u8; 32]>::try_from(bytes).map_err(|_| WrapError::Length);
            let _ = LocalFree(HLOCAL(out.pbData as *mut core::ffi::c_void));
            dek
        }
    }
}

/// Test-only pass-through wrap. Stores the DEK in the clear; for unit tests and
/// non-Windows builds only, never production.
#[cfg(any(test, not(windows)))]
pub struct TestWrap;

#[cfg(any(test, not(windows)))]
impl KeyWrap for TestWrap {
    fn wrap(&self, dek: &[u8; 32]) -> Result<Vec<u8>, WrapError> {
        Ok(dek.to_vec())
    }

    fn unwrap(&self, wrapped: &[u8]) -> Result<[u8; 32], WrapError> {
        <[u8; 32]>::try_from(wrapped).map_err(|_| WrapError::Length)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_deks_differ() {
        assert_ne!(generate_dek(), generate_dek());
    }

    #[test]
    fn test_wrap_round_trips() {
        let dek = generate_dek();
        let wrapped = TestWrap.wrap(&dek).unwrap();
        assert_eq!(TestWrap.unwrap(&wrapped).unwrap(), dek);
    }

    #[test]
    fn test_wrap_rejects_wrong_length() {
        assert_eq!(TestWrap.unwrap(&[0u8; 16]), Err(WrapError::Length));
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trips_current_user() {
        let dek = generate_dek();
        let wrapped = DpapiWrap.wrap(&dek).unwrap();
        // DPAPI output is not the plaintext DEK.
        assert_ne!(wrapped.as_slice(), dek.as_slice());
        assert_eq!(DpapiWrap.unwrap(&wrapped).unwrap(), dek);
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_rejects_tampered_blob() {
        let dek = generate_dek();
        let mut wrapped = DpapiWrap.wrap(&dek).unwrap();
        let last = wrapped.len() - 1;
        wrapped[last] ^= 0x01;
        assert!(DpapiWrap.unwrap(&wrapped).is_err());
    }
}
