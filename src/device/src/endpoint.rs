//! The §5.4 `configureLocalModel` / `probeLocalModel` confirmation flow (device-side half) + the
//! endpoint binding registry.
//!
//! A `device_local` profile may only target a registered, probed endpoint whose listening process the
//! user has confirmed in a native dialog (§5.4 step 3: "进程名、路径、签名者、运行账户"). This module
//! probes the listener identity over a throwaway loopback connection ([`crate::listener`]), produces
//! the confirmation request the dialog shows, and — only after the user confirms — records the
//! `listener_identity` binding and its contribution to `binding_hash`. The endpoint registry resolves
//! a `profile_id` to the [`DeviceLocalEndpoint`] the model proxy invokes. A profile whose
//! `listener_requirement` is empty cannot be published (§5.4 step 5). The dialog UI is the desktop
//! shell's half (§1.1).

use std::collections::HashMap;
use std::net::TcpStream;

use serde_json::json;

use crate::listener::{
    self, IdentityError, ListenerIdentity, ListenerRecord, ListenerRequirement, LoopbackAddr,
};
use crate::modelproxy::DeviceLocalEndpoint;

/// The confirmation request the native dialog displays (§5.4 step 3).
#[derive(Clone, Debug)]
pub struct ModelConfirmation {
    pub process_name: String,
    pub image_path: String,
    pub signer_thumbprint: Option<String>,
    /// The running account SID (the dialog renders it as a name).
    pub owner_sid: Vec<u8>,
    pub image_sha256: String,
    /// A wildcard LISTEN means the service is open to the LAN → UI hint (§5.4 末段).
    pub listens_on_all_interfaces: bool,
}

/// A confirmed endpoint binding: the proxy endpoint plus its `binding_hash` contribution.
#[derive(Clone, Debug)]
pub struct EndpointEntry {
    pub endpoint: DeviceLocalEndpoint,
    pub binding_hash: String,
}

/// The endpoint registry the Node service thread resolves a Run's model `profile_id` against.
/// Populated ONLY by the confirmed probe flow.
#[derive(Default)]
pub struct EndpointBinding {
    endpoints: HashMap<String, EndpointEntry>,
}

impl EndpointBinding {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a confirmed endpoint binding. Refuses an unpublishable (empty) `listener_requirement`
    /// (§5.4 step 5) and an identity that does not satisfy the requirement against the current user.
    pub fn confirm(
        &mut self,
        profile_id: String,
        port: u16,
        identity: &ListenerIdentity,
        requirement: ListenerRequirement,
        current_user_sid: Vec<u8>,
    ) -> Result<String, IdentityError> {
        if !requirement.is_publishable() {
            return Err(IdentityError::Unpublishable);
        }
        let record = ListenerRecord {
            owner_sid: identity.owner_sid.clone(),
            image_path: identity.image_path.clone(),
            signer_thumbprint: identity.signer_thumbprint.clone(),
            image_sha256: identity.image_sha256.clone(),
        };
        // The confirmed identity must itself satisfy the requirement (owner + signer/hash).
        listener::verify_binding(identity, &record, &requirement, &current_user_sid)?;
        let binding_hash = listener_identity_hash(&record);
        let endpoint = DeviceLocalEndpoint {
            port,
            record,
            requirement,
            current_user_sid,
        };
        self.endpoints.insert(
            profile_id,
            EndpointEntry {
                endpoint,
                binding_hash: binding_hash.clone(),
            },
        );
        Ok(binding_hash)
    }

    pub fn get(&self, profile_id: &str) -> Option<&EndpointEntry> {
        self.endpoints.get(profile_id)
    }

    pub fn contains(&self, profile_id: &str) -> bool {
        self.endpoints.contains_key(profile_id)
    }
}

/// The `listener_identity` contribution to `binding_hash` (§5.4 step 3): SHA-256 over the JCS of
/// `{owner_sid, image_path, signer_thumbprint, image_sha256}` (SID as hex).
pub fn listener_identity_hash(record: &ListenerRecord) -> String {
    let sid_hex: String = record
        .owner_sid
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let doc = json!({
        "owner_sid": sid_hex,
        "image_path": record.image_path,
        "signer_thumbprint": record.signer_thumbprint,
        "image_sha256": record.image_sha256,
    });
    let canonical = serde_jcs::to_vec(&doc).unwrap_or_default();
    crate::sha256_hex(&canonical)
}

/// Probe a local model endpoint's listener identity over a throwaway loopback connection and produce
/// the confirmation request. The connection sends no request byte; it exists only to locate the
/// server-side PID by four-tuple. The caller shows the dialog and calls [`EndpointBinding::confirm`]
/// on confirm; a cancel records nothing.
pub fn probe_local_model(
    port: u16,
) -> Result<(ListenerIdentity, ModelConfirmation), IdentityError> {
    let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|_| IdentityError::Unreadable)?;
    let local = stream.local_addr().map_err(|_| IdentityError::Unreadable)?;
    let local_addr = match local.ip() {
        std::net::IpAddr::V4(v4) => LoopbackAddr::V4(v4.octets()),
        std::net::IpAddr::V6(v6) => LoopbackAddr::V6(v6.octets()),
    };
    let dest = match local_addr {
        LoopbackAddr::V4(_) => LoopbackAddr::V4([127, 0, 0, 1]),
        LoopbackAddr::V6(_) => {
            let mut a = [0u8; 16];
            a[15] = 1;
            LoopbackAddr::V6(a)
        }
    };
    let identity = listener::resolve_listener(&dest, port, &local_addr, local.port())?;
    let process_name = identity
        .image_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .to_string();
    let confirmation = ModelConfirmation {
        process_name,
        image_path: identity.image_path.clone(),
        signer_thumbprint: identity.signer_thumbprint.clone(),
        owner_sid: identity.owner_sid.clone(),
        image_sha256: identity.image_sha256.clone(),
        listens_on_all_interfaces: identity.listens_on_all_interfaces,
    };
    Ok((identity, confirmation))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// Hold a loopback listener open in this process while the probe resolves its identity.
    fn with_listener<F>(f: F)
    where
        F: FnOnce(u16),
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (_sock, _) = listener.accept().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(500));
        });
        f(port);
        let _ = server.join();
    }

    #[test]
    fn probe_produces_a_confirmation_with_process_and_account() {
        with_listener(|port| {
            let (identity, confirmation) = probe_local_model(port).unwrap();
            assert!(!confirmation.process_name.is_empty());
            assert!(confirmation.image_sha256.starts_with("sha256:"));
            assert_eq!(confirmation.owner_sid, identity.owner_sid);
            assert_eq!(
                confirmation.owner_sid,
                crate::listener::current_user_sid().unwrap()
            );
        });
    }

    #[test]
    fn confirm_records_a_binding_and_resolves_it() {
        with_listener(|port| {
            let (identity, _) = probe_local_model(port).unwrap();
            let sid = crate::listener::current_user_sid().unwrap();
            let mut registry = EndpointBinding::new();
            let requirement = ListenerRequirement {
                allowed_signers: vec![],
                allow_user_pinned_hash: true,
                allowed_service_sids: vec![],
            };
            let hash = registry
                .confirm(
                    "profile-dev-fixture-v1".into(),
                    port,
                    &identity,
                    requirement,
                    sid,
                )
                .unwrap();
            assert_eq!(hash.len(), 64);
            assert!(hash.chars().all(|value| value.is_ascii_hexdigit()));
            assert!(registry.contains("profile-dev-fixture-v1"));
            let entry = registry.get("profile-dev-fixture-v1").unwrap();
            assert_eq!(entry.binding_hash, hash);
            assert_eq!(entry.endpoint.port, port);
        });
    }

    #[test]
    fn an_empty_listener_requirement_cannot_be_confirmed() {
        with_listener(|port| {
            let (identity, _) = probe_local_model(port).unwrap();
            let sid = crate::listener::current_user_sid().unwrap();
            let mut registry = EndpointBinding::new();
            let err = registry
                .confirm(
                    "p".into(),
                    port,
                    &identity,
                    ListenerRequirement::default(),
                    sid,
                )
                .unwrap_err();
            assert_eq!(err, IdentityError::Unpublishable);
            assert!(!registry.contains("p"));
        });
    }

    #[test]
    fn listener_identity_hash_is_stable_and_order_independent() {
        let record = ListenerRecord {
            owner_sid: vec![1, 2, 3],
            image_path: "C:\\node.exe".into(),
            signer_thumbprint: None,
            image_sha256: "sha256:abc".into(),
        };
        let h1 = listener_identity_hash(&record);
        let h2 = listener_identity_hash(&record.clone());
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        assert!(h1.chars().all(|value| value.is_ascii_hexdigit()));
        // A different image hash changes the binding hash.
        let mut changed = record;
        changed.image_sha256 = "sha256:other".into();
        assert_ne!(listener_identity_hash(&changed), h1);
    }
}
