//! The Broker side of device-design §2.1: the non-exportable signing key, the two purpose-specific
//! signing requests, and the certificate the server issues once pairing is confirmed.
//!
//! GW20 closed the server's issuance/record/renewal faces, but nothing on the device consumed the
//! issued certificate and `main.rs` was still a version printer. This module is the state the
//! executable Broker owns so the shell can drive §2.1 steps 1/3/4 over the closed IPC set:
//!
//! * step 1 — the key lives in CNG and only its public JWK/thumbprint leaves the Broker;
//! * step 3 — the shell asks for a signature over the pairing covered string. The Broker builds
//!   that string itself from closed fields, so the shell can never make it sign arbitrary bytes;
//! * step 4 — the shell hands back the CA-issued chain. The Broker refuses it unless the CA
//!   signed it, its public key is this device's key, its CN is the device the shell named and its
//!   OU is the org the Broker last signed for. Only then is it held, in memory.
//!
//! Renewal uses its own domain ([`crate::certrenewal`]); §2.1 forbids reusing a signature domain
//! across purposes, so the two requests are separate methods rather than one generic signer.
//!
//! The certificate is held in memory only (lead ruling, GW21): no disk artefact, no administrator
//! rights, nothing to clean up on uninstall. A Broker restart therefore needs the shell to deliver
//! the chain again; shell-side persistence belongs to M2 and is registered as not done.
//!
//! REST stays with the desktop main process (§2.1 steps 2/3/4 all say 主进程). This crate has no
//! HTTP client and gains none here: the Broker reports facts and signs, it never calls the API.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64ct::Encoding;
use serde_json::Value;

use crate::key::{DeviceKey, KeyError};
use crate::transport::ClientIdentity;

#[cfg(windows)]
use windows::Win32::Security::Cryptography::CERT_CONTEXT;

/// The renewal window §2.1 step 4 defines: request a new certificate inside the last hour.
pub const RENEWAL_WINDOW: Duration = Duration::from_secs(3600);

/// One purpose-specific signing function. The two domains share a shape but never a preimage.
type SignFn = fn(&dyn DeviceKey, &str, &str, &str, &str) -> Result<String, KeyError>;

/// Why an identity operation was refused. Each variant maps to one closed IPC refusal code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityError {
    /// The payload is not the closed shape for this method.
    Schema,
    /// A field is present but malformed (empty string, bad PEM, bad base64).
    Shape,
    /// A certificate arrived before the Broker ever signed for an org, so there is no OU to
    /// bind it against. Refused rather than guessed.
    NoPairing,
    /// The chain failed one of the certificate gates (parse, CN, OU, public key, EKU, validity,
    /// CA signature). Never partially held.
    CertificateInvalid,
    /// The CNG key refused to sign.
    Sign,
    /// A CNG-bound identity was requested on a non-Windows build. Explicit, never a silent
    /// fallback to exportable material (the GW19a rule).
    NotWindows,
}

impl From<KeyError> for IdentityError {
    fn from(_: KeyError) -> Self {
        IdentityError::Sign
    }
}

/// The certificate the Broker currently holds. `der_chain` is leaf-first, the shape
/// [`ClientIdentity::CngBound`] wants.
#[derive(Clone, Debug)]
pub struct HeldCertificate {
    /// Leaf first, then the issuing CA.
    pub der_chain: Vec<Vec<u8>>,
    /// The leaf serial as a decimal string, matching the server's `cert_serial`.
    pub serial: String,
    /// The leaf NotAfter.
    pub not_after: SystemTime,
}

impl HeldCertificate {
    /// Whether §2.1 step 4's renewal window is open. An already-expired certificate is also
    /// "open": the device must renew, and refusing to report that would hide the only way out.
    pub fn renewal_window_open(&self, now: SystemTime) -> bool {
        match self.not_after.duration_since(now) {
            Ok(remaining) => remaining <= RENEWAL_WINDOW,
            Err(_) => true,
        }
    }

    /// NotAfter as the strict whole-second UTC form every landed frame uses.
    pub fn not_after_rfc3339(&self) -> Option<String> {
        let seconds = self.not_after.duration_since(UNIX_EPOCH).ok()?.as_secs();
        crate::frame::rfc3339::format_utc_seconds(seconds)
    }
}

/// The static half of the Broker's identity: where the key lives and which CA it trusts.
#[derive(Clone, Debug)]
pub struct IdentityConfig {
    /// The persisted CNG container name.
    pub container: String,
    /// The CNG provider name.
    pub provider: String,
    /// The device CA root, PEM. The Broker verifies the issued leaf against this anchor.
    pub ca_pem: Vec<u8>,
}

/// The Broker's §2.1 state. One async task owns it (the GW18 no-lock rule), so nothing here is
/// synchronised internally.
pub struct Identity {
    config: IdentityConfig,
    key: Arc<dyn DeviceKey + Send + Sync>,
    /// The CA root, DER, parsed once from `config.ca_pem`.
    ca_der: Vec<u8>,
    /// The org from the most recent signing request. A certificate's OU must equal it.
    signed_org: Option<String>,
    /// The subject from the most recent signing request. The certificate carries no subject field
    /// (CN=device, OU=org only), so the permit identity gate's `subject_id` is anchored here: set
    /// by `sign_pairing`, and declared explicitly on restart re-delivery (F5 甲, 2026-11-19).
    signed_subject: Option<String>,
    /// The device id adopted from a CA-signed certificate whose CN matched the shell's claim.
    device_id: Option<String>,
    held: Option<HeldCertificate>,
}

impl Identity {
    /// Build the state around an already-created/opened key. Refuses an empty container, an
    /// empty provider or a CA PEM that carries no certificate — schannel's `from_pem` is a
    /// process crash on zero-length input (GW17 measured), so empty material never reaches it.
    pub fn new(
        config: IdentityConfig,
        key: Arc<dyn DeviceKey + Send + Sync>,
    ) -> Result<Self, IdentityError> {
        if config.container.is_empty() || config.provider.is_empty() {
            return Err(IdentityError::Shape);
        }
        let ca_der = pem_certificates(&config.ca_pem)?
            .into_iter()
            .next()
            .ok_or(IdentityError::Shape)?;
        Ok(Self {
            config,
            key,
            ca_der,
            signed_org: None,
            signed_subject: None,
            device_id: None,
            held: None,
        })
    }

    /// The closed four-member public JWK. No private material ever leaves through this.
    pub fn public_jwk(&self) -> crate::jwk::EcP256Jwk {
        self.key.public_jwk()
    }

    /// The server-matching thumbprint of that JWK.
    pub fn thumbprint(&self) -> String {
        self.key.thumbprint()
    }

    /// The container name, for the shell's diagnostics and for the CNG-bound identity.
    pub fn container(&self) -> &str {
        &self.config.container
    }

    /// The device id adopted from the held certificate, if any.
    pub fn device_id(&self) -> Option<&str> {
        self.device_id.as_deref()
    }

    /// The org bound by the most recent signing/re-delivery, if any. The permit identity gate
    /// reads this (the certificate OU is verified against it).
    pub fn signed_org(&self) -> Option<&str> {
        self.signed_org.as_deref()
    }

    /// The subject bound by the most recent signing/re-delivery, if any. The certificate carries
    /// no subject, so this is the permit identity gate's `subject_id` anchor (F5 甲).
    pub fn signed_subject(&self) -> Option<&str> {
        self.signed_subject.as_deref()
    }

    /// The held certificate, if any.
    pub fn certificate(&self) -> Option<&HeldCertificate> {
        self.held.as_ref()
    }

    /// §2.1 step 3: sign the pairing covered string. The Broker builds the string from the closed
    /// fields and its own thumbprint, so the caller cannot supply a preimage.
    pub fn sign_pairing(
        &mut self,
        pairing_id: &str,
        challenge: &str,
        org_id: &str,
        subject_id: &str,
    ) -> Result<String, IdentityError> {
        self.sign_for(
            crate::pairing::sign,
            pairing_id,
            challenge,
            org_id,
            subject_id,
        )
    }

    /// §2.1 step 4: sign the renewal covered string, under its own domain.
    pub fn sign_renewal(
        &mut self,
        pairing_id: &str,
        challenge: &str,
        org_id: &str,
        subject_id: &str,
    ) -> Result<String, IdentityError> {
        self.sign_for(
            crate::certrenewal::sign,
            pairing_id,
            challenge,
            org_id,
            subject_id,
        )
    }

    pub fn sign_grant_succession(
        &mut self,
        proof: &Value,
        org_id: &str,
        subject_id: &str,
    ) -> Result<String, IdentityError> {
        if !proof.is_object() || org_id.is_empty() || subject_id.is_empty() {
            return Err(IdentityError::Shape);
        }
        if self.signed_org.as_deref() != Some(org_id)
            || self.signed_subject.as_deref() != Some(subject_id)
        {
            return Err(IdentityError::NoPairing);
        }
        crate::grantsuccession::sign(self.key.as_ref(), proof).map_err(|_| IdentityError::Sign)
    }

    pub fn sign_model_binding(
        &mut self,
        proof: &Value,
        org_id: &str,
        subject_id: &str,
    ) -> Result<String, IdentityError> {
        if !proof.is_object() || org_id.is_empty() || subject_id.is_empty() {
            return Err(IdentityError::Shape);
        }
        if self.signed_org.as_deref() != Some(org_id)
            || self.signed_subject.as_deref() != Some(subject_id)
        {
            return Err(IdentityError::NoPairing);
        }
        crate::frame::sign::sign_frame(self.key.as_ref(), "model_binding", proof)
            .map_err(|_| IdentityError::Sign)
    }

    pub fn sign_local_intent(
        &mut self,
        proof: &Value,
        org_id: &str,
        subject_id: &str,
    ) -> Result<String, IdentityError> {
        if !proof.is_object() || org_id.is_empty() || subject_id.is_empty() {
            return Err(IdentityError::Shape);
        }
        if self.signed_org.as_deref() != Some(org_id)
            || self.signed_subject.as_deref() != Some(subject_id)
        {
            return Err(IdentityError::NoPairing);
        }
        crate::frame::intent::sign(self.key.as_ref(), proof).map_err(|_| IdentityError::Sign)
    }

    fn sign_for(
        &mut self,
        sign: SignFn,
        pairing_id: &str,
        challenge: &str,
        org_id: &str,
        subject_id: &str,
    ) -> Result<String, IdentityError> {
        if pairing_id.is_empty()
            || challenge.is_empty()
            || org_id.is_empty()
            || subject_id.is_empty()
        {
            return Err(IdentityError::Shape);
        }
        let signature = sign(self.key.as_ref(), pairing_id, challenge, org_id, subject_id)?;
        // Remembered only after a successful signature: a refused request must not leave an org
        // or subject behind that a later certificate could bind against.
        self.signed_org = Some(org_id.to_string());
        self.signed_subject = Some(subject_id.to_string());
        Ok(signature)
    }

    /// §2.1 step 4: hold the chain the server issued. Every gate runs before anything is stored,
    /// so a refused delivery leaves the previous certificate (or none) untouched.
    pub fn deliver_certificate(
        &mut self,
        device_id: &str,
        certificate_pem: &str,
    ) -> Result<(), IdentityError> {
        if device_id.is_empty() {
            return Err(IdentityError::Shape);
        }
        let org_id = self.signed_org.clone().ok_or(IdentityError::NoPairing)?;
        let subject_id = self
            .signed_subject
            .clone()
            .ok_or(IdentityError::NoPairing)?;
        self.hold_validated(device_id, certificate_pem, &org_id, &subject_id)
    }

    /// §2.1 restart re-delivery (M2b): a fresh Broker process has no signing history, so the
    /// stored chain cannot go through `deliver_certificate`'s signed-org gate. The shell declares
    /// the org explicitly instead; the CA-signed OU must equal that declaration and every other
    /// gate is identical. The subject is declared too (F5 甲): the certificate carries no subject
    /// field, so the permit identity gate's `subject_id` anchor must be re-supplied on restart.
    /// Both bindings are set only after the whole chain validates, so a refused re-delivery leaves
    /// the identity exactly as it was.
    pub fn redeliver_certificate(
        &mut self,
        device_id: &str,
        certificate_pem: &str,
        org_id: &str,
        subject_id: &str,
    ) -> Result<(), IdentityError> {
        if device_id.is_empty() || org_id.is_empty() || subject_id.is_empty() {
            return Err(IdentityError::Shape);
        }
        self.hold_validated(device_id, certificate_pem, org_id, subject_id)
    }

    fn hold_validated(
        &mut self,
        device_id: &str,
        certificate_pem: &str,
        org_id: &str,
        subject_id: &str,
    ) -> Result<(), IdentityError> {
        let der_chain = pem_certificates(certificate_pem.as_bytes())?;
        if der_chain.is_empty() {
            return Err(IdentityError::Shape);
        }
        let held = validate_chain(
            &der_chain,
            &self.ca_der,
            device_id,
            org_id,
            &self.public_jwk(),
        )?;
        self.held = Some(held);
        self.device_id = Some(device_id.to_string());
        self.signed_org = Some(org_id.to_string());
        self.signed_subject = Some(subject_id.to_string());
        Ok(())
    }

    /// The identity the link presents at mTLS. Requires a held certificate and a Windows build;
    /// there is no exportable fallback.
    pub fn link_identity(&self) -> Result<ClientIdentity, IdentityError> {
        let held = self
            .held
            .as_ref()
            .ok_or(IdentityError::CertificateInvalid)?;
        if !cfg!(windows) {
            return Err(IdentityError::NotWindows);
        }
        Ok(ClientIdentity::CngBound {
            cert_der_chain: held.der_chain.clone(),
            container: self.config.container.clone(),
            provider: self.config.provider.clone(),
        })
    }
}

/// Decode every `-----BEGIN CERTIFICATE-----` block in `pem`, in order. Strict: a block that is
/// not valid standard base64 is a refusal, not a skip, so a truncated chain cannot pass as a
/// shorter one.
fn pem_certificates(pem: &[u8]) -> Result<Vec<Vec<u8>>, IdentityError> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let text = std::str::from_utf8(pem).map_err(|_| IdentityError::Shape)?;
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(BEGIN) {
        let body = &rest[start + BEGIN.len()..];
        let end = body.find(END).ok_or(IdentityError::Shape)?;
        let encoded: String = body[..end].chars().filter(|c| !c.is_whitespace()).collect();
        if encoded.is_empty() {
            return Err(IdentityError::Shape);
        }
        let der = base64ct::Base64::decode_vec(&encoded).map_err(|_| IdentityError::Shape)?;
        if der.is_empty() {
            return Err(IdentityError::Shape);
        }
        out.push(der);
        rest = &body[end + END.len()..];
    }
    Ok(out)
}

/// A big-endian byte string as a decimal string, by repeated division by ten. The leaf serial is
/// a random 128-bit integer, so it does not fit any native type.
fn decimal_from_be(bytes: &[u8]) -> String {
    let mut digits: Vec<u8> = bytes.to_vec();
    // Strip leading zeros so the value is canonical.
    while digits.len() > 1 && digits[0] == 0 {
        digits.remove(0);
    }
    if digits.iter().all(|b| *b == 0) {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while !(digits.len() == 1 && digits[0] == 0) {
        let mut remainder = 0u32;
        for byte in digits.iter_mut() {
            let cur = (remainder << 8) | *byte as u32;
            *byte = (cur / 10) as u8;
            remainder = cur % 10;
        }
        out.push(b'0' + remainder as u8);
        while digits.len() > 1 && digits[0] == 0 {
            digits.remove(0);
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(windows)]
fn validate_chain(
    der_chain: &[Vec<u8>],
    ca_der: &[u8],
    device_id: &str,
    org_id: &str,
    jwk: &crate::jwk::EcP256Jwk,
) -> Result<HeldCertificate, IdentityError> {
    use windows::Win32::Security::Cryptography::{
        szOID_COMMON_NAME, szOID_ORGANIZATIONAL_UNIT_NAME, CertCreateCertificateContext,
        CertFreeCertificateContext, CryptVerifyCertificateSignature, PKCS_7_ASN_ENCODING,
        X509_ASN_ENCODING,
    };

    // The platform parses the leaf; a malformed DER never reaches our own field reads.
    let leaf = unsafe {
        CertCreateCertificateContext(X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, &der_chain[0])
    };
    if leaf.is_null() {
        return Err(IdentityError::CertificateInvalid);
    }
    let ca =
        unsafe { CertCreateCertificateContext(X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, ca_der) };
    if ca.is_null() {
        unsafe {
            let _ = CertFreeCertificateContext(Some(leaf));
        };
        return Err(IdentityError::CertificateInvalid);
    }

    let result = (|| {
        // The CA must actually have signed this leaf. This is a cryptographic check, not a
        // shape check: a self-signed or foreign-CA leaf is refused here. The issuer's public key
        // is taken from the CA's own CERT_INFO, so there is no subject/issuer-type convention to
        // get wrong (CryptVerifyCertificateSignatureEx's undocumented constants produced an ASN1
        // end-of-data error on a perfectly valid chain).
        let issuer_key = unsafe {
            let info = (*ca).pCertInfo;
            if info.is_null() {
                return Err(IdentityError::CertificateInvalid);
            }
            &(*info).SubjectPublicKeyInfo as *const _
        };
        unsafe {
            CryptVerifyCertificateSignature(None, X509_ASN_ENCODING, &der_chain[0], issuer_key)
        }
        .map_err(|_| IdentityError::CertificateInvalid)?;

        let cn = name_attr(leaf, szOID_COMMON_NAME)?;
        if cn != device_id {
            return Err(IdentityError::CertificateInvalid);
        }
        let ou = name_attr(leaf, szOID_ORGANIZATIONAL_UNIT_NAME)?;
        if ou != org_id {
            return Err(IdentityError::CertificateInvalid);
        }

        // The certificate must be for THIS key, not for any key the shell happens to hold.
        // The SPKI BIT STRING content for an EC P-256 key is exactly the uncompressed point,
        // so comparing it to the JWK's point is an exact public-key equality check.
        let point = jwk.to_encoded_point().map_err(|_| IdentityError::Shape)?;
        let public_key = unsafe {
            let info = (*leaf).pCertInfo;
            if info.is_null() {
                return Err(IdentityError::CertificateInvalid);
            }
            let blob = (*info).SubjectPublicKeyInfo.PublicKey;
            if blob.cUnusedBits != 0 || blob.pbData.is_null() {
                return Err(IdentityError::CertificateInvalid);
            }
            std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec()
        };
        if public_key != point {
            return Err(IdentityError::CertificateInvalid);
        }

        // clientAuth EKU (1.3.6.1.5.5.7.3.2). An absent EKU extension means unrestricted use,
        // which includes clientAuth; a present one must name it.
        if !client_auth_ok(leaf)? {
            return Err(IdentityError::CertificateInvalid);
        }

        let info = unsafe { (*leaf).pCertInfo };
        let not_after = filetime_to_systemtime(unsafe { (*info).NotAfter })?;
        if not_after <= SystemTime::now() {
            return Err(IdentityError::CertificateInvalid);
        }
        let serial = {
            let blob = unsafe { (*info).SerialNumber };
            let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) };
            // CRYPT_INTEGER_BLOB is little-endian; the server reports the decimal value.
            let mut be = bytes.to_vec();
            be.reverse();
            decimal_from_be(&be)
        };
        Ok(HeldCertificate {
            der_chain: der_chain.to_vec(),
            serial,
            not_after,
        })
    })();

    unsafe {
        let _ = CertFreeCertificateContext(Some(leaf));
        let _ = CertFreeCertificateContext(Some(ca));
    }
    result
}

#[cfg(windows)]
fn name_attr(
    leaf: *const CERT_CONTEXT,
    oid: windows::core::PCSTR,
) -> Result<String, IdentityError> {
    use windows::Win32::Security::Cryptography::{CertGetNameStringW, CERT_NAME_ATTR_TYPE};
    let mut buf = vec![0u16; 256];
    let len = unsafe {
        CertGetNameStringW(
            leaf,
            CERT_NAME_ATTR_TYPE,
            0,
            Some(oid.as_ptr() as *const _),
            Some(&mut buf),
        )
    };
    if len == 0 {
        return Err(IdentityError::CertificateInvalid);
    }
    // The returned length includes the terminating NUL.
    let end = (len as usize).saturating_sub(1).min(buf.len());
    String::from_utf16(&buf[..end]).map_err(|_| IdentityError::CertificateInvalid)
}

#[cfg(windows)]
fn client_auth_ok(leaf: *const CERT_CONTEXT) -> Result<bool, IdentityError> {
    use windows::Win32::Foundation::CRYPT_E_NOT_FOUND;
    use windows::Win32::Security::Cryptography::{CertGetEnhancedKeyUsage, CTL_USAGE};
    const CLIENT_AUTH_OID: &[u8] = b"1.3.6.1.5.5.7.3.2";
    let mut buf = vec![0u8; 4096];
    let mut needed = buf.len() as u32;
    let usage = buf.as_mut_ptr() as *mut CTL_USAGE;
    match unsafe { CertGetEnhancedKeyUsage(leaf, 0, Some(usage), &mut needed) } {
        Ok(()) => {}
        // No EKU extension at all: unrestricted use, which includes clientAuth.
        Err(err) if err.code() == CRYPT_E_NOT_FOUND => return Ok(true),
        Err(_) => return Err(IdentityError::CertificateInvalid),
    }
    let count = unsafe { (*usage).cUsageIdentifier } as usize;
    let oids = unsafe { (*usage).rgpszUsageIdentifier };
    if oids.is_null() {
        return Err(IdentityError::CertificateInvalid);
    }
    for i in 0..count {
        let ptr = unsafe { *oids.add(i) };
        if ptr.is_null() {
            continue;
        }
        let text = unsafe { std::ffi::CStr::from_ptr(ptr.0 as *const i8) };
        if text.to_bytes() == CLIENT_AUTH_OID {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(windows)]
fn filetime_to_systemtime(
    ft: windows::Win32::Foundation::FILETIME,
) -> Result<SystemTime, IdentityError> {
    // 100ns intervals since 1601-01-01; the Unix epoch is 11644473600 seconds later, which is
    // 116444736000000000 intervals (NOT 11644473600000000 — a dropped zero reads every leaf as
    // valid for another 332 years, so the renewal window would never open).
    const EPOCH_OFFSET_100NS: u64 = 116_444_736_000_000_000;
    let raw = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
    let unix_100ns = raw
        .checked_sub(EPOCH_OFFSET_100NS)
        .ok_or(IdentityError::CertificateInvalid)?;
    Ok(UNIX_EPOCH + Duration::from_nanos(unix_100ns * 100))
}

/// Non-Windows builds hold no CNG-bound certificate. The refusal is explicit so a Linux test
/// build can never silently accept exportable material as the production identity.
#[cfg(not(windows))]
fn validate_chain(
    _der_chain: &[Vec<u8>],
    _ca_der: &[u8],
    _device_id: &str,
    _org_id: &str,
    _jwk: &crate::jwk::EcP256Jwk,
) -> Result<HeldCertificate, IdentityError> {
    Err(IdentityError::NotWindows)
}

/// A test-only identity around a fresh software key, for routing/signing tests that do not
/// exercise the Windows certificate gates.
#[cfg(test)]
pub(crate) fn test_identity() -> Identity {
    Identity::new(
        IdentityConfig {
            container: "test-container".to_string(),
            provider: "Microsoft Software Key Storage Provider".to_string(),
            ca_pem: b"-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n".to_vec(),
        },
        Arc::new(crate::key::SoftwareKey::random()),
    )
    .expect("test identity")
}

#[cfg(test)]
pub(crate) fn test_paired_identity() -> Identity {
    let mut identity = test_identity_with_device("11111111-1111-4111-8111-111111111111");
    identity.signed_org = Some("org-1".into());
    identity.signed_subject = Some("sub-1".into());
    identity
}

#[cfg(test)]
pub(crate) fn test_identity_with_device(device_id: &str) -> Identity {
    let mut identity = test_identity();
    identity.device_id = Some(device_id.to_string());
    identity
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key::SoftwareKey;

    fn config() -> IdentityConfig {
        IdentityConfig {
            container: "work-device-test".to_string(),
            provider: "Microsoft Software Key Storage Provider".to_string(),
            ca_pem: Vec::new(),
        }
    }

    fn identity() -> Identity {
        // A CA PEM is required, so tests that only exercise signing use a placeholder block
        // that parses as base64 but is never handed to the platform stack.
        let mut cfg = config();
        cfg.ca_pem = b"-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n".to_vec();
        Identity::new(cfg, Arc::new(SoftwareKey::random())).expect("identity")
    }

    #[test]
    fn empty_container_or_provider_is_refused() {
        let key = Arc::new(SoftwareKey::random());
        let mut cfg = config();
        cfg.ca_pem = b"-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n".to_vec();
        cfg.container = String::new();
        assert_eq!(
            Identity::new(cfg, key.clone()).err().unwrap(),
            IdentityError::Shape
        );
        let mut cfg = config();
        cfg.ca_pem = b"-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n".to_vec();
        cfg.provider = String::new();
        assert_eq!(Identity::new(cfg, key).err().unwrap(), IdentityError::Shape);
    }

    #[test]
    fn a_ca_pem_with_no_certificate_is_refused() {
        let mut cfg = config();
        cfg.ca_pem = b"not a pem".to_vec();
        assert_eq!(
            Identity::new(cfg, Arc::new(SoftwareKey::random()))
                .err()
                .unwrap(),
            IdentityError::Shape
        );
    }

    #[test]
    fn signing_returns_a_verifiable_signature_and_remembers_the_org() {
        let mut id = identity();
        let jwk = id.public_jwk();
        let sig = id.sign_pairing("pid", "chal", "org", "sub").unwrap();
        let covered = crate::pairing::covered_string("pid", "chal", &id.thumbprint(), "org", "sub");
        assert!(crate::es256::verify(&jwk, covered.as_bytes(), &sig));
        assert_eq!(id.signed_org.as_deref(), Some("org"));
        assert_eq!(id.signed_subject.as_deref(), Some("sub"));
    }

    #[test]
    fn the_two_signing_methods_use_different_domains() {
        let mut id = identity();
        let jwk = id.public_jwk();
        let pair = id.sign_pairing("pid", "chal", "org", "sub").unwrap();
        let renew = id.sign_renewal("pid", "chal", "org", "sub").unwrap();
        assert_ne!(pair, renew);
        let renew_covered =
            crate::certrenewal::covered_string("pid", "chal", &id.thumbprint(), "org", "sub");
        assert!(!crate::es256::verify(&jwk, renew_covered.as_bytes(), &pair));
    }

    #[test]
    fn an_empty_field_is_refused_and_leaves_no_org_behind() {
        let mut id = identity();
        assert_eq!(
            id.sign_pairing("pid", "chal", "", "sub").err().unwrap(),
            IdentityError::Shape
        );
        assert_eq!(
            id.sign_pairing("pid", "chal", "org", "").err().unwrap(),
            IdentityError::Shape
        );
        assert!(id.signed_org.is_none());
        assert!(id.signed_subject.is_none());
    }

    #[test]
    fn a_certificate_before_any_signing_is_refused_as_no_pairing() {
        let mut id = identity();
        assert_eq!(
            id.deliver_certificate(
                "dev",
                "-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n"
            )
            .err()
            .unwrap(),
            IdentityError::NoPairing
        );
        assert!(id.certificate().is_none());
    }

    #[test]
    fn redelivery_empty_fields_are_refused_and_leave_no_org_behind() {
        let mut id = identity();
        let pem = "-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n";
        assert_eq!(
            id.redeliver_certificate("", pem, "org", "sub")
                .err()
                .unwrap(),
            IdentityError::Shape
        );
        assert_eq!(
            id.redeliver_certificate("dev", pem, "", "sub")
                .err()
                .unwrap(),
            IdentityError::Shape
        );
        assert_eq!(
            id.redeliver_certificate("dev", pem, "org", "")
                .err()
                .unwrap(),
            IdentityError::Shape
        );
        assert!(id.signed_org.is_none());
        assert!(id.signed_subject.is_none());
        assert!(id.certificate().is_none());
    }

    #[test]
    fn redelivery_without_signing_history_runs_the_chain_gates_and_binds_nothing_on_refusal() {
        let mut id = identity();
        // No sign_pairing first: the restart path must reach the certificate gates themselves,
        // not the signed-org gate. A chain that fails them binds no org/subject and holds nothing.
        let err = id
            .redeliver_certificate(
                "dev",
                "-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n",
                "org",
                "sub",
            )
            .err()
            .unwrap();
        assert!(matches!(
            err,
            IdentityError::CertificateInvalid | IdentityError::NotWindows
        ));
        assert!(id.signed_org.is_none());
        assert!(id.signed_subject.is_none());
        assert!(id.certificate().is_none());
    }

    #[test]
    fn link_identity_without_a_certificate_is_refused() {
        let id = identity();
        assert_eq!(
            id.link_identity().err().unwrap(),
            IdentityError::CertificateInvalid
        );
    }

    #[test]
    fn pem_parsing_is_strict_about_a_truncated_block() {
        assert_eq!(
            pem_certificates(b"-----BEGIN CERTIFICATE-----\nAAEC\n")
                .err()
                .unwrap(),
            IdentityError::Shape
        );
        assert_eq!(
            pem_certificates(b"-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n")
                .err()
                .unwrap(),
            IdentityError::Shape
        );
        assert_eq!(
            pem_certificates(b"-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n")
                .err()
                .unwrap(),
            IdentityError::Shape
        );
    }

    #[test]
    fn pem_parsing_keeps_chain_order() {
        let pem = b"-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nAwQF\n-----END CERTIFICATE-----\n";
        let chain = pem_certificates(pem).unwrap();
        assert_eq!(chain, vec![vec![0x00, 0x01, 0x02], vec![0x03, 0x04, 0x05]]);
    }

    #[test]
    fn decimal_conversion_matches_known_values() {
        assert_eq!(decimal_from_be(&[0]), "0");
        assert_eq!(decimal_from_be(&[1]), "1");
        assert_eq!(decimal_from_be(&[0x01, 0x00]), "256");
        assert_eq!(
            decimal_from_be(&[0xff; 16]),
            "340282366920938463463374607431768211455"
        );
        assert_eq!(decimal_from_be(&[0x00, 0x00, 0x2a]), "42");
    }

    #[test]
    fn the_renewal_window_opens_inside_the_last_hour_and_after_expiry() {
        let now = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let inside = HeldCertificate {
            der_chain: vec![vec![1]],
            serial: "1".to_string(),
            not_after: now + Duration::from_secs(1800),
        };
        let outside = HeldCertificate {
            not_after: now + Duration::from_secs(7200),
            ..inside.clone()
        };
        let expired = HeldCertificate {
            not_after: now - Duration::from_secs(1),
            ..inside.clone()
        };
        assert!(inside.renewal_window_open(now));
        assert!(!outside.renewal_window_open(now));
        assert!(expired.renewal_window_open(now));
        assert_eq!(inside.not_after_rfc3339().unwrap(), "2027-01-15T08:30:00Z");
    }

    // The FILETIME epoch offset is pinned against a known instant: a dropped zero in the
    // constant still produces a plausible-looking date (332 years out), so only an absolute
    // comparison discriminates. 1_800_000_000 is 2027-01-15T08:00:00Z.
    #[cfg(windows)]
    #[test]
    fn filetime_reads_the_leaf_not_after_as_the_instant_it_encodes() {
        use windows::Win32::Foundation::FILETIME;
        let raw: u64 = (1_800_000_000 + 11_644_473_600) * 10_000_000;
        let ft = FILETIME {
            dwLowDateTime: (raw & 0xffff_ffff) as u32,
            dwHighDateTime: (raw >> 32) as u32,
        };
        assert_eq!(
            filetime_to_systemtime(ft).unwrap(),
            UNIX_EPOCH + Duration::from_secs(1_800_000_000)
        );
        // Before 1970 the subtraction underflows: a certificate cannot be valid then.
        let ancient = FILETIME {
            dwLowDateTime: 1,
            dwHighDateTime: 0,
        };
        assert_eq!(
            filetime_to_systemtime(ancient).err().unwrap(),
            IdentityError::CertificateInvalid
        );
    }
}
