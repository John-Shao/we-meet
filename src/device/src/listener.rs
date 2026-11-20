//! The §5.4 local-model listener identity gate (device-design §5.4). Windows loopback ports are
//! machine-wide: another logged-in user or a low-privilege service can squat `127.0.0.1:<port>`, so
//! connecting by address/port alone could hand `local_only` content to an impersonator. Before any
//! request byte is sent, the Broker locates the SERVER-side row of THIS connection by exact
//! four-tuple (`GetExtendedTcpTable`), reads the listening process's token SID / image path / image
//! SHA-256 / Authenticode signer, guards against PID reuse by comparing process creation time across
//! two opens, and compares against the user-confirmed binding `listener_identity`. Anything unreadable
//! fails closed (`model_identity_unreadable`) — a standard user typically cannot open another
//! account's process token, and that is a refusal, never a pass.
//!
//! This does not defend against a process that already controls the current user (§4.2 disclaimer);
//! it defends against OTHER local users and other-account services impersonating the model endpoint.

use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
    MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
};
use windows::Win32::Security::{
    GetLengthSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

/// `AF_INET` / `AF_INET6` (winsock2.h); literals avoid pulling the WinSock feature for two constants.
const AF_INET: u32 = 2;
const AF_INET6: u32 = 23;
/// `MIB_TCP_STATE_LISTEN` (tcpmib.h).
const MIB_TCP_STATE_LISTEN: u32 = 2;

/// A fail-closed identity refusal (§5.4 steps 2-4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityError {
    /// The destination is not a literal loopback address (§5.4 step 1).
    NotLoopback,
    /// The four-tuple matched zero or more than one server-side row (§5.4 step 2: never guess by port).
    NoUniqueMatch,
    /// The process/token/image could not be read → `model_identity_unreadable` (§5.4 step 2).
    Unreadable,
    /// The PID's process creation time changed across the query → PID reuse (§5.4 step 2).
    PidReused,
    /// The identity does not match the confirmed binding (§5.4 steps 3-4) → `identity_mismatch`.
    Mismatch,
    /// The profile's `listener_requirement` is empty and cannot be published (§5.4 step 5).
    Unpublishable,
}

/// A literal loopback endpoint (§5.4 step 1: only `127.0.0.1` or `::1`, never `localhost`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopbackAddr {
    V4([u8; 4]),
    V6([u8; 16]),
}

impl LoopbackAddr {
    fn is_loopback(&self) -> bool {
        match self {
            LoopbackAddr::V4(a) => a == &[127, 0, 0, 1],
            LoopbackAddr::V6(a) => {
                let mut want = [0u8; 16];
                want[15] = 1;
                a == &want
            }
        }
    }
    fn family(&self) -> u32 {
        match self {
            LoopbackAddr::V4(_) => AF_INET,
            LoopbackAddr::V6(_) => AF_INET6,
        }
    }
}

/// The listening process identity read for one connection (§5.4 step 2).
#[derive(Clone, Debug)]
pub struct ListenerIdentity {
    pub pid: u32,
    pub owner_sid: Vec<u8>,
    pub image_path: String,
    /// `sha256:<hex>` of the image file bytes.
    pub image_sha256: String,
    /// `sha256:<hex>` of the Authenticode signer certificate DER; `None` when unsigned.
    pub signer_thumbprint: Option<String>,
    /// Process creation time (FILETIME as i64), the PID-reuse guard anchor.
    pub creation_time: i64,
    /// A `0.0.0.0`/`::` LISTEN row exists on the port → UI hint "open to the LAN" (§5.4 末段).
    pub listens_on_all_interfaces: bool,
}

/// The user-confirmed binding record (§5.4 step 3, `listener_identity`).
#[derive(Clone, Debug)]
pub struct ListenerRecord {
    pub owner_sid: Vec<u8>,
    pub image_path: String,
    pub signer_thumbprint: Option<String>,
    pub image_sha256: String,
}

/// The organization profile's `endpoint_policy.listener_requirement` (§5.4 step 5). A profile with
/// all three empty cannot be published.
#[derive(Clone, Debug, Default)]
pub struct ListenerRequirement {
    pub allowed_signers: Vec<String>,
    pub allow_user_pinned_hash: bool,
    pub allowed_service_sids: Vec<Vec<u8>>,
}

impl ListenerRequirement {
    pub fn is_publishable(&self) -> bool {
        !self.allowed_signers.is_empty()
            || self.allow_user_pinned_hash
            || !self.allowed_service_sids.is_empty()
    }
}

fn filetime_i64(ft: FILETIME) -> i64 {
    ((ft.dwHighDateTime as i64) << 32) | ft.dwLowDateTime as i64
}

/// The current process token's user SID (the §5.4 "current user" and the §4.2 DACL self-principal).
pub fn current_user_sid() -> Result<Vec<u8>, IdentityError> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(
            windows::Win32::System::Threading::GetCurrentProcess(),
            TOKEN_QUERY,
            &mut token,
        )
        .map_err(|_| IdentityError::Unreadable)?;
        let sid = token_sid(token);
        let _ = CloseHandle(token);
        sid
    }
}

/// Locate the unique server-side PID for THIS connection by exact four-tuple, then read its identity.
/// `dest`/`dest_port` is the address we connected to (the row's LOCAL side); `local`/`local_port` is
/// this connection's local side (the row's REMOTE side). Refuses non-loopback, non-unique matches,
/// unreadable processes and PID reuse — all fail closed.
pub fn resolve_listener(
    dest: &LoopbackAddr,
    dest_port: u16,
    local: &LoopbackAddr,
    local_port: u16,
) -> Result<ListenerIdentity, IdentityError> {
    if !dest.is_loopback() || dest.family() != local.family() {
        return Err(IdentityError::NotLoopback);
    }
    let (pid, listens_all) = match (dest, local) {
        (LoopbackAddr::V4(d), LoopbackAddr::V4(l)) => match_v4(*d, dest_port, *l, local_port)?,
        (LoopbackAddr::V6(d), LoopbackAddr::V6(l)) => match_v6(*d, dest_port, *l, local_port)?,
        _ => return Err(IdentityError::NotLoopback),
    };
    read_process_identity(pid, listens_all)
}

/// Convert a host port to the network-order form the MIB table stores (ntohs inverse).
fn port_network_order(port: u16) -> u32 {
    (port.to_be()) as u32
}

fn match_v4(
    dest: [u8; 4],
    dest_port: u16,
    local: [u8; 4],
    local_port: u16,
) -> Result<(u32, bool), IdentityError> {
    let dest_addr = u32::from_ne_bytes(dest);
    let local_addr = u32::from_ne_bytes(local);
    let dp = port_network_order(dest_port);
    let lp = port_network_order(local_port);
    let table = query_tcp_table(AF_INET)?;
    let header = unsafe { &*(table.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
    let rows = unsafe {
        std::slice::from_raw_parts(
            std::ptr::addr_of!(header.table) as *const MIB_TCPROW_OWNER_PID,
            header.dwNumEntries as usize,
        )
    };
    let mut matched_pid: Option<u32> = None;
    let mut listens_all = false;
    for row in rows {
        // The server-side row of our connection: local == dest, remote == our local side.
        if row.dwLocalAddr == dest_addr
            && row.dwLocalPort == dp
            && row.dwRemoteAddr == local_addr
            && row.dwRemotePort == lp
        {
            match matched_pid {
                None => matched_pid = Some(row.dwOwningPid),
                Some(p) if p != row.dwOwningPid => return Err(IdentityError::NoUniqueMatch),
                _ => {}
            }
        }
        // A wildcard LISTEN on the same port means the service is open to the LAN.
        if row.dwState == MIB_TCP_STATE_LISTEN && row.dwLocalPort == dp && row.dwLocalAddr == 0 {
            listens_all = true;
        }
    }
    matched_pid
        .map(|p| (p, listens_all))
        .ok_or(IdentityError::NoUniqueMatch)
}

fn match_v6(
    dest: [u8; 16],
    dest_port: u16,
    local: [u8; 16],
    local_port: u16,
) -> Result<(u32, bool), IdentityError> {
    let dp = port_network_order(dest_port);
    let lp = port_network_order(local_port);
    let table = query_tcp_table(AF_INET6)?;
    let header = unsafe { &*(table.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID) };
    let rows = unsafe {
        std::slice::from_raw_parts(
            std::ptr::addr_of!(header.table) as *const MIB_TCP6ROW_OWNER_PID,
            header.dwNumEntries as usize,
        )
    };
    let mut matched_pid: Option<u32> = None;
    let mut listens_all = false;
    let zero6 = [0u8; 16];
    for row in rows {
        if row.ucLocalAddr == dest
            && row.dwLocalPort == dp
            && row.ucRemoteAddr == local
            && row.dwRemotePort == lp
        {
            match matched_pid {
                None => matched_pid = Some(row.dwOwningPid),
                Some(p) if p != row.dwOwningPid => return Err(IdentityError::NoUniqueMatch),
                _ => {}
            }
        }
        if row.dwState == MIB_TCP_STATE_LISTEN && row.dwLocalPort == dp && row.ucLocalAddr == zero6
        {
            listens_all = true;
        }
    }
    matched_pid
        .map(|p| (p, listens_all))
        .ok_or(IdentityError::NoUniqueMatch)
}

/// Two-call `GetExtendedTcpTable` (size probe then fill) into an owned buffer.
fn query_tcp_table(family: u32) -> Result<Vec<u8>, IdentityError> {
    let mut size: u32 = 0;
    unsafe {
        GetExtendedTcpTable(None, &mut size, false, family, TCP_TABLE_OWNER_PID_ALL, 0);
    }
    if size == 0 {
        return Err(IdentityError::NoUniqueMatch);
    }
    let mut buf = vec![0u8; size as usize];
    let rc = unsafe {
        GetExtendedTcpTable(
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
            false,
            family,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if rc != 0 {
        return Err(IdentityError::NoUniqueMatch);
    }
    Ok(buf)
}

unsafe fn token_sid(token: HANDLE) -> Result<Vec<u8>, IdentityError> {
    let mut len: u32 = 0;
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
    if len == 0 {
        return Err(IdentityError::Unreadable);
    }
    let mut buf = vec![0u8; len as usize];
    GetTokenInformation(
        token,
        TokenUser,
        Some(buf.as_mut_ptr() as *mut _),
        len,
        &mut len,
    )
    .map_err(|_| IdentityError::Unreadable)?;
    let user = &*(buf.as_ptr() as *const TOKEN_USER);
    let sid = user.User.Sid;
    let sid_len = GetLengthSid(sid) as usize;
    Ok(std::slice::from_raw_parts(sid.0 as *const u8, sid_len).to_vec())
}

unsafe fn process_creation_time(pid: u32) -> Result<i64, IdentityError> {
    let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
        .map_err(|_| IdentityError::Unreadable)?;
    let mut creation: FILETIME = std::mem::zeroed();
    let mut exit: FILETIME = std::mem::zeroed();
    let mut kernel: FILETIME = std::mem::zeroed();
    let mut user: FILETIME = std::mem::zeroed();
    let result = GetProcessTimes(proc, &mut creation, &mut exit, &mut kernel, &mut user)
        .map(|()| filetime_i64(creation));
    let _ = CloseHandle(proc);
    result.map_err(|_| IdentityError::Unreadable)
}

/// Read the listening process identity, guarding PID reuse by comparing creation time across two
/// independent opens (§5.4 step 2). Every read failure is `Unreadable` (fail closed).
fn read_process_identity(pid: u32, listens_all: bool) -> Result<ListenerIdentity, IdentityError> {
    unsafe {
        let creation_before = process_creation_time(pid)?;
        let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .map_err(|_| IdentityError::Unreadable)?;

        let mut token = HANDLE::default();
        let sid_result = OpenProcessToken(proc, TOKEN_QUERY, &mut token)
            .map_err(|_| IdentityError::Unreadable)
            .and_then(|()| token_sid(token));
        let _ = CloseHandle(token);
        let owner_sid = sid_result?;

        let mut name_buf = vec![0u16; 1024];
        let mut name_len = name_buf.len() as u32;
        QueryFullProcessImageNameW(
            proc,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(name_buf.as_mut_ptr()),
            &mut name_len,
        )
        .map_err(|_| IdentityError::Unreadable)?;
        let image_path = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        let _ = CloseHandle(proc);

        let image_bytes = std::fs::read(&image_path).map_err(|_| IdentityError::Unreadable)?;
        let image_sha256 = format!("sha256:{}", crate::sha256_hex(&image_bytes));
        let signer_thumbprint = authenticode_signer_thumbprint(&image_path);

        // Re-open by PID and compare creation time: a different time means the PID was reused.
        let creation_after = process_creation_time(pid)?;
        if creation_before != creation_after {
            return Err(IdentityError::PidReused);
        }

        Ok(ListenerIdentity {
            pid,
            owner_sid,
            image_path,
            image_sha256,
            signer_thumbprint,
            creation_time: creation_before,
            listens_on_all_interfaces: listens_all,
        })
    }
}

/// The Authenticode signer certificate thumbprint (`sha256:<hex>` of the DER), or `None` when the
/// image is unsigned / the signature cannot be read. Best-effort: an unsigned local fixture legitimately
/// has no signer, and the profile then pins the image hash instead (§5.4 step 3).
fn authenticode_signer_thumbprint(image_path: &str) -> Option<String> {
    use windows::Win32::Security::Cryptography::{
        CertCloseStore, CertEnumCertificatesInStore, CertFreeCertificateContext, CryptQueryObject,
        CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED, CERT_QUERY_FORMAT_FLAG_BINARY,
        CERT_QUERY_OBJECT_FILE,
    };
    let path_w: Vec<u16> = image_path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let mut store = windows::Win32::Security::Cryptography::HCERTSTORE::default();
        let ok = CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            path_w.as_ptr() as *const _,
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            None,
            None,
            None,
            Some(&mut store),
            None,
            None,
        );
        if ok.is_err() {
            return None;
        }
        let ctx = CertEnumCertificatesInStore(store, None);
        let mut thumbprint = None;
        if !ctx.is_null() {
            let cert = &*ctx;
            let der = std::slice::from_raw_parts(cert.pbCertEncoded, cert.cbCertEncoded as usize);
            // The first certificate in the signed blob is the signer; one is enough for the gate.
            thumbprint = Some(format!("sha256:{}", crate::sha256_hex(der)));
            let _ = CertFreeCertificateContext(Some(ctx));
        }
        let _ = CertCloseStore(store, 0);
        thumbprint
    }
}

/// Compare a freshly-read identity against the confirmed binding (§5.4 steps 3-4). The owner SID must
/// be the current user or an allowed service account; the signer must match an allowed signer, or (when
/// the profile allows user-pinned hash) the image hash must equal the recorded one. Any mismatch is
/// `Mismatch` → no request byte is sent, binding turns `identity_mismatch`.
pub fn verify_binding(
    identity: &ListenerIdentity,
    record: &ListenerRecord,
    requirement: &ListenerRequirement,
    current_user_sid: &[u8],
) -> Result<(), IdentityError> {
    if !requirement.is_publishable() {
        return Err(IdentityError::Unpublishable);
    }
    let owner_ok = identity.owner_sid == current_user_sid
        || requirement
            .allowed_service_sids
            .iter()
            .any(|s| s == &identity.owner_sid);
    if !owner_ok || identity.owner_sid != record.owner_sid {
        return Err(IdentityError::Mismatch);
    }
    let signer_ok = identity
        .signer_thumbprint
        .as_ref()
        .map(|s| requirement.allowed_signers.iter().any(|a| a == s))
        .unwrap_or(false);
    let hash_ok =
        requirement.allow_user_pinned_hash && identity.image_sha256 == record.image_sha256;
    if !signer_ok && !hash_ok {
        return Err(IdentityError::Mismatch);
    }
    Ok(())
}

#[cfg(test)]
pub mod tests_support {
    //! Shared test helpers for the identity gate and the proxy that consumes it.
    use super::*;

    pub fn current_sid() -> Vec<u8> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(
                windows::Win32::System::Threading::GetCurrentProcess(),
                TOKEN_QUERY,
                &mut token,
            )
            .unwrap();
            let sid = token_sid(token).unwrap();
            let _ = CloseHandle(token);
            sid
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn current_sid() -> Vec<u8> {
        tests_support::current_sid()
    }

    #[test]
    fn non_loopback_destination_is_refused() {
        let dest = LoopbackAddr::V4([192, 168, 1, 10]);
        let local = LoopbackAddr::V4([127, 0, 0, 1]);
        assert_eq!(
            resolve_listener(&dest, 8080, &local, 50000).unwrap_err(),
            IdentityError::NotLoopback
        );
    }

    #[test]
    fn a_four_tuple_with_no_connection_has_no_unique_match() {
        let dest = LoopbackAddr::V4([127, 0, 0, 1]);
        let local = LoopbackAddr::V4([127, 0, 0, 1]);
        // Port 1 is almost certainly not an established server-side row of this process.
        let err = resolve_listener(&dest, 1, &local, 1).unwrap_err();
        assert!(matches!(
            err,
            IdentityError::NoUniqueMatch | IdentityError::Unreadable
        ));
    }

    #[test]
    fn resolves_the_real_listening_process_of_a_loopback_connection() {
        use std::net::{TcpListener, TcpStream};
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (_sock, _peer) = listener.accept().expect("accept");
            // Hold the connection open while the main thread resolves the identity.
            std::thread::sleep(std::time::Duration::from_millis(500));
        });
        let client = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let client_local = client.local_addr().unwrap();
        let client_port = client_local.port();
        let dest = LoopbackAddr::V4([127, 0, 0, 1]);
        let local = LoopbackAddr::V4([127, 0, 0, 1]);
        let identity = resolve_listener(&dest, port, &local, client_port)
            .expect("resolve the server-side PID of our own connection");
        // The listener lives in this process, so the resolved PID is ours and the SID is ours.
        assert_eq!(identity.pid, unsafe {
            windows::Win32::System::Threading::GetCurrentProcessId()
        });
        assert_eq!(identity.owner_sid, current_sid());
        assert!(identity.image_sha256.starts_with("sha256:"));
        assert!(!identity.image_path.is_empty());
        assert_ne!(identity.creation_time, 0);
        drop(client);
        let _ = server.join();
    }

    #[test]
    fn binding_verification_owner_signer_and_hash_rules() {
        let sid = current_sid();
        let identity = ListenerIdentity {
            pid: 1,
            owner_sid: sid.clone(),
            image_path: "C:\\model.exe".into(),
            image_sha256: "sha256:abc".into(),
            signer_thumbprint: Some("sha256:signer".into()),
            creation_time: 100,
            listens_on_all_interfaces: false,
        };
        let record = ListenerRecord {
            owner_sid: sid.clone(),
            image_path: "C:\\model.exe".into(),
            signer_thumbprint: Some("sha256:signer".into()),
            image_sha256: "sha256:abc".into(),
        };
        // Allowed signer → pass.
        let req = ListenerRequirement {
            allowed_signers: vec!["sha256:signer".into()],
            allow_user_pinned_hash: false,
            allowed_service_sids: vec![],
        };
        assert_eq!(verify_binding(&identity, &record, &req, &sid), Ok(()));
        // Wrong owner SID → mismatch.
        let other = vec![1u8, 2, 3];
        assert_eq!(
            verify_binding(&identity, &record, &req, &other),
            Err(IdentityError::Mismatch)
        );
        // Unsigned image + pinned hash matching the record → pass.
        let mut unsigned = identity.clone();
        unsigned.signer_thumbprint = None;
        let pin_req = ListenerRequirement {
            allowed_signers: vec![],
            allow_user_pinned_hash: true,
            allowed_service_sids: vec![],
        };
        assert_eq!(verify_binding(&unsigned, &record, &pin_req, &sid), Ok(()));
        // Unsigned image + hash changed → mismatch (no signer, hash differs).
        let mut changed = unsigned.clone();
        changed.image_sha256 = "sha256:different".into();
        assert_eq!(
            verify_binding(&changed, &record, &pin_req, &sid),
            Err(IdentityError::Mismatch)
        );
        // Empty requirement → unpublishable.
        assert_eq!(
            verify_binding(&identity, &record, &ListenerRequirement::default(), &sid),
            Err(IdentityError::Unpublishable)
        );
    }

    #[test]
    fn empty_listener_requirement_is_not_publishable() {
        assert!(!ListenerRequirement::default().is_publishable());
        assert!(ListenerRequirement {
            allow_user_pinned_hash: true,
            ..Default::default()
        }
        .is_publishable());
    }
}
