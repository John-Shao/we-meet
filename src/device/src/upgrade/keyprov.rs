//! Device signing-key provenance (device-design §2.1 :55, four-question Q3). The
//! ES256 device identity key lives in CNG; when a TPM is available the key is held
//! by the platform crypto provider, otherwise it falls back to the software CNG
//! provider. The device NEVER claims hardware attestation — provenance selects the
//! storage provider, it is not a proof of hardware binding.

#[cfg(windows)]
use windows::core::w;
#[cfg(windows)]
use windows::Win32::Security::Cryptography::{
    NCryptFreeObject, NCryptOpenStorageProvider, NCRYPT_HANDLE, NCRYPT_PROV_HANDLE,
};

/// Where the non-exportable device signing key is held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyProvenance {
    Tpm,
    SoftwareCng,
}

impl KeyProvenance {
    /// The CNG storage provider name for this provenance.
    pub fn provider_name(self) -> &'static str {
        match self {
            KeyProvenance::Tpm => "Microsoft Platform Crypto Provider",
            KeyProvenance::SoftwareCng => "Microsoft Software Key Storage Provider",
        }
    }

    /// Provenance never claims hardware attestation (§2.1 :55, Q3). This is always
    /// false regardless of where the key is held.
    pub fn claims_hardware_attestation(self) -> bool {
        false
    }
}

/// Whether the TPM platform crypto provider can be opened on this machine.
#[cfg(windows)]
fn tpm_available() -> bool {
    unsafe {
        let mut provider = NCRYPT_PROV_HANDLE::default();
        let ok =
            NCryptOpenStorageProvider(&mut provider, w!("Microsoft Platform Crypto Provider"), 0)
                .is_ok();
        if ok {
            let _ = NCryptFreeObject(NCRYPT_HANDLE(provider.0));
        }
        ok
    }
}

/// Select the key provenance: TPM when available, else the software CNG fallback.
#[cfg(windows)]
pub fn select_provenance() -> KeyProvenance {
    if tpm_available() {
        KeyProvenance::Tpm
    } else {
        KeyProvenance::SoftwareCng
    }
}

/// Non-Windows builds have no CNG/TPM; the software fallback is the only option.
#[cfg(not(windows))]
pub fn select_provenance() -> KeyProvenance {
    KeyProvenance::SoftwareCng
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_claims_hardware_attestation() {
        assert!(!KeyProvenance::Tpm.claims_hardware_attestation());
        assert!(!KeyProvenance::SoftwareCng.claims_hardware_attestation());
    }

    #[test]
    fn provider_names() {
        assert_eq!(
            KeyProvenance::Tpm.provider_name(),
            "Microsoft Platform Crypto Provider"
        );
        assert_eq!(
            KeyProvenance::SoftwareCng.provider_name(),
            "Microsoft Software Key Storage Provider"
        );
    }

    #[test]
    fn selection_is_valid_and_never_attests() {
        let provenance = select_provenance();
        assert!(matches!(
            provenance,
            KeyProvenance::Tpm | KeyProvenance::SoftwareCng
        ));
        assert!(!provenance.claims_hardware_attestation());
        // The selected provider name is always non-empty.
        assert!(!provenance.provider_name().is_empty());
    }
}
