//! The device signing-key abstraction. Production Windows keys live in CNG and
//! are non-exportable ([`crate::cng`]); a p256 software key backs tests and
//! non-Windows builds. Both expose the same closed JWK + ES256 R||S surface.

use p256::ecdsa::signature::Signer;
use p256::ecdsa::{SigningKey, VerifyingKey};

use crate::jwk::EcP256Jwk;
use crate::thumbprint::device_key_thumbprint;

/// A device key that can publish its public JWK and produce ES256 R||S signatures.
pub trait DeviceKey {
    /// The closed four-member public JWK.
    fn public_jwk(&self) -> EcP256Jwk;

    /// Sign `msg` with ES256, returning the fixed 64-byte R||S.
    fn sign_es256(&self, msg: &[u8]) -> Result<[u8; 64], KeyError>;

    /// The server-matching thumbprint of the public JWK.
    fn thumbprint(&self) -> String {
        device_key_thumbprint(&self.public_jwk())
    }
}

/// A signing failure. The CNG backend maps native errors here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyError {
    Sign,
}

/// A p256 software key. The private scalar lives in process memory, so this is
/// for tests and non-Windows builds only — never the production device identity,
/// which must stay non-exportable in CNG.
pub struct SoftwareKey {
    signing: SigningKey,
}

impl SoftwareKey {
    /// Generate a random key from the OS entropy source.
    pub fn random() -> Self {
        Self {
            signing: SigningKey::random(&mut rand_core::OsRng),
        }
    }

    /// Load a key from a 32-byte private scalar (deterministic test vectors).
    pub fn from_bytes(bytes: &[u8; 32]) -> Result<Self, KeyError> {
        let signing = SigningKey::from_slice(bytes).map_err(|_| KeyError::Sign)?;
        Ok(Self { signing })
    }
}

impl DeviceKey for SoftwareKey {
    fn public_jwk(&self) -> EcP256Jwk {
        let verifying = VerifyingKey::from(&self.signing);
        let point = verifying.to_encoded_point(false);
        let x = point.x().expect("P-256 affine point has x");
        let y = point.y().expect("P-256 affine point has y");
        EcP256Jwk::from_coords(x, y)
    }

    fn sign_es256(&self, msg: &[u8]) -> Result<[u8; 64], KeyError> {
        let signature: p256::ecdsa::Signature = self.signing.sign(msg);
        Ok(signature.to_bytes().into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_key_has_stable_jwk() {
        let a = SoftwareKey::from_bytes(&[7u8; 32]).unwrap();
        let b = SoftwareKey::from_bytes(&[7u8; 32]).unwrap();
        assert_eq!(a.public_jwk(), b.public_jwk());
        assert_eq!(a.thumbprint(), b.thumbprint());
    }

    #[test]
    fn thumbprint_is_64_hex() {
        let key = SoftwareKey::random();
        let tp = key.thumbprint();
        assert_eq!(tp.len(), 64);
        assert!(tp.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn rejects_zero_scalar() {
        assert!(SoftwareKey::from_bytes(&[0u8; 32]).is_err());
    }
}
