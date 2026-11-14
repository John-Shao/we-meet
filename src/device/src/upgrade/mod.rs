//! Install/upgrade dual-slot (device-design §8, four-question Q3). The shell,
//! agent and runtime ship as one signed release-manifest matrix ([`manifest`]);
//! a supply-chain self-test ([`supply`]) gates activation; two slots swap
//! atomically with whole-version rollback ([`slot`]); the device signing key uses
//! TPM when available else software CNG, never claiming hardware attestation
//! ([`keyprov`]). Uninstall data handling and the support-package boundary are a
//! separate §8 concern deferred to a later batch; real clean-machine install/
//! upgrade/rollback acceptance is M5 (this crate does not claim measured passes).

pub mod keyprov;
pub mod manifest;
pub mod slot;
pub mod supply;
