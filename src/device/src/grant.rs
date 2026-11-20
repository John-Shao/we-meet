//! The §4.2 root-acquisition confirmation flow (device-side half) + the grant registry.
//!
//! The system selector returns only a path STRING; between selection and the Broker opening it, any
//! ancestor could be swapped for a junction. So authorization binds the object the Broker ACTUALLY
//! opens and the user confirms, not the path (§4.2 根目录获取). This module: opens the root without
//! following its reparse ([`crate::tool_exec::bind_root`]), reads the actual location + volume label,
//! compares actual vs selected (volume-normalized, case-insensitive, per segment), checks whether the
//! root or any ancestor lets OTHER non-admin local users write/delete children (DACL inspection), and
//! produces the confirmation request the native dialog shows. Only after the user confirms does the
//! caller register the grant (holding the root handle); a cancel drops the handle and produces no
//! grant. The native dialog UI itself is the desktop shell's half (§1.1).

use std::collections::HashMap;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
use windows::Win32::Security::{
    CreateWellKnownSid, EqualSid, GetAce, WinBuiltinAdministratorsSid, WinLocalSystemSid,
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
};
use windows::Win32::Storage::FileSystem::{
    GetVolumeInformationW, DELETE, FILE_APPEND_DATA, FILE_DELETE_CHILD, FILE_WRITE_DATA, WRITE_DAC,
    WRITE_OWNER,
};

use crate::tool_exec::{self, ExecError, RootHandle};

/// `ACCESS_ALLOWED_ACE_TYPE` (winnt.h).
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
/// `SECURITY_MAX_SID_SIZE` (winnt.h).
const MAX_SID_SIZE: usize = 68;
/// GENERIC_WRITE | GENERIC_ALL (winnt.h) — generic masks that imply write/delete.
const GENERIC_WRITE_ALL: u32 = 0x4000_0000 | 0x1000_0000;

/// A root-confirmation refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantError {
    /// The root open/identity binding refused (§4.2 step 1).
    Root(ExecError),
    /// The DACL could not be read (fail closed: an unreadable ACL is not "safe").
    Security,
    /// The grant_id is not registered.
    NotFound,
}

impl From<ExecError> for GrantError {
    fn from(err: ExecError) -> Self {
        GrantError::Root(err)
    }
}

/// The confirmation request the native dialog displays (§4.2 根目录获取 step 3). When
/// `differs_from_selected` the dialog must warn "actual location differs from selected" and require
/// re-confirmation; when `other_user_writable` it must warn "other local users can modify this dir".
#[derive(Clone, Debug)]
pub struct RootConfirmation {
    pub selected_path: String,
    pub actual_location: String,
    pub volume_label: String,
    pub differs_from_selected: bool,
    pub other_user_writable: bool,
}

/// A registered grant: the held root handle, the artifact output directory (relative segments under
/// the root), and the root identity hash taken from the actually-opened object (§3.5).
pub struct GrantEntry {
    pub root: RootHandle,
    pub artifact_dir: Vec<String>,
    pub root_identity_hash: String,
}

/// The grant registry the Node service thread resolves tool `grant_id`s against. Populated ONLY by
/// the confirmed root-acquisition flow; a tool naming an unregistered grant is refused.
#[derive(Default)]
pub struct GrantRegistry {
    grants: HashMap<String, GrantEntry>,
}

impl GrantRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a confirmed grant, holding the root handle. Returns the root identity hash.
    pub fn register(
        &mut self,
        grant_id: String,
        root: RootHandle,
        artifact_dir: Vec<String>,
    ) -> String {
        let hash = root_identity_hash(&root);
        self.grants.insert(
            grant_id,
            GrantEntry {
                root,
                artifact_dir,
                root_identity_hash: hash.clone(),
            },
        );
        hash
    }

    pub fn get(&self, grant_id: &str) -> Option<&GrantEntry> {
        self.grants.get(grant_id)
    }

    pub fn contains(&self, grant_id: &str) -> bool {
        self.grants.contains_key(grant_id)
    }
}

/// The root identity hash from the actually-opened object's volume serial + file ID (§3.5/§4.2 step 1).
pub fn root_identity_hash(root: &RootHandle) -> String {
    let preimage = format!("{}:{}", root.identity.volume_serial, root.identity.file_id);
    format!("sha256:{}", crate::sha256_hex(preimage.as_bytes()))
}

fn wide_null(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Open the root, read its actual location/label, compare against the selected path and check the
/// other-user-writable warning. Returns the HELD handle plus the confirmation request; the caller
/// registers on confirm or drops on cancel (no grant).
pub fn prepare_root_confirmation(
    selected_path: &str,
) -> Result<(RootHandle, RootConfirmation), GrantError> {
    let root = tool_exec::bind_root(selected_path)?;
    let volume_label = volume_label_of(&root.final_path);
    let differs = !locations_equal(selected_path, &root.final_path);
    let other_writable = other_user_writable(&root.final_path)?;
    let confirmation = RootConfirmation {
        selected_path: selected_path.to_string(),
        actual_location: root.final_path.clone(),
        volume_label,
        differs_from_selected: differs,
        other_user_writable: other_writable,
    };
    Ok((root, confirmation))
}

/// Normalize a path for comparison: strip the `\\?\` Win32 namespace prefix, split into segments,
/// lowercase (case-insensitive volume/path comparison, §4.2 根目录获取 step 2).
fn normalized_segments(path: &str) -> Vec<String> {
    let rest = path.strip_prefix("\\\\?\\").unwrap_or(path);
    rest.split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .collect()
}

/// Whether the selected path and the actually-opened location denote the same object (volume GUID /
/// drive normalized, per-segment case-insensitive). A legitimate ancestor junction (e.g. a redirected
/// user dir) can make them differ — that is the warning case, not an error.
pub fn locations_equal(selected: &str, actual: &str) -> bool {
    normalized_segments(selected) == normalized_segments(actual)
}

fn volume_label_of(final_path: &str) -> String {
    let root = match tool_exec::volume_root_of(final_path) {
        Some(r) => r,
        None => return String::new(),
    };
    let root_w = wide_null(&root);
    let mut label = vec![0u16; 256];
    let ok = unsafe {
        GetVolumeInformationW(
            PCWSTR(root_w.as_ptr()),
            Some(&mut label),
            None,
            None,
            None,
            None,
        )
    };
    if ok.is_err() {
        return String::new();
    }
    String::from_utf16_lossy(&label)
        .trim_end_matches('\0')
        .to_string()
}

unsafe fn well_known_sid(kind: windows::Win32::Security::WELL_KNOWN_SID_TYPE) -> Vec<u8> {
    let mut buf = vec![0u8; MAX_SID_SIZE];
    let mut size = buf.len() as u32;
    let _ = CreateWellKnownSid(kind, None, PSID(buf.as_mut_ptr() as *mut _), &mut size);
    buf.truncate(size as usize);
    buf
}

/// Whether `path`'s DACL grants write/delete-child to a principal OTHER than the current user, SYSTEM
/// or Administrators (§4.2 根目录获取 step 5). A NULL DACL means unrestricted access → writable.
unsafe fn dacl_grants_other_write(
    path: &str,
    self_sid: PSID,
    system_sid: PSID,
    admin_sid: PSID,
) -> Result<bool, GrantError> {
    let path_w = wide_null(path);
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let rc = GetNamedSecurityInfoW(
        PCWSTR(path_w.as_ptr()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        None,
        None,
        Some(&mut dacl),
        None,
        &mut sd,
    );
    if rc.0 != 0 {
        return Err(GrantError::Security);
    }
    let outcome = (|| {
        if dacl.is_null() {
            // A NULL DACL grants everyone full access — other users can write.
            return Ok(true);
        }
        let write_bits = FILE_WRITE_DATA.0
            | FILE_APPEND_DATA.0
            | FILE_DELETE_CHILD.0
            | DELETE.0
            | WRITE_DAC.0
            | WRITE_OWNER.0
            | GENERIC_WRITE_ALL;
        let mut index = 0u32;
        loop {
            let mut ace_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
            if GetAce(dacl, index, &mut ace_ptr).is_err() {
                break;
            }
            let header = &*(ace_ptr as *const ACE_HEADER);
            if header.AceType == ACCESS_ALLOWED_ACE_TYPE {
                let ace = &*(ace_ptr as *const ACCESS_ALLOWED_ACE);
                if ace.Mask & write_bits != 0 {
                    let sid = PSID(std::ptr::addr_of!(ace.SidStart) as *mut _);
                    let is_self = EqualSid(sid, self_sid).is_ok();
                    let is_system = EqualSid(sid, system_sid).is_ok();
                    let is_admin = EqualSid(sid, admin_sid).is_ok();
                    if !is_self && !is_system && !is_admin {
                        return Ok(true);
                    }
                }
            }
            index += 1;
        }
        Ok(false)
    })();
    let _ = LocalFree(HLOCAL(sd.0));
    outcome
}

/// Check the root AND every ancestor up to the volume root for other-user write/delete (§4.2 step 5:
/// "root 本身或其上级"). An ancestor swap to a junction in a shared location is the threat model.
pub fn other_user_writable(final_path: &str) -> Result<bool, GrantError> {
    unsafe {
        let self_bytes = crate::listener::current_user_sid().map_err(|_| GrantError::Security)?;
        let system_bytes = well_known_sid(WinLocalSystemSid);
        let admin_bytes = well_known_sid(WinBuiltinAdministratorsSid);
        let self_sid = PSID(self_bytes.as_ptr() as *mut _);
        let system_sid = PSID(system_bytes.as_ptr() as *mut _);
        let admin_sid = PSID(admin_bytes.as_ptr() as *mut _);

        let mut current = final_path.to_string();
        loop {
            if dacl_grants_other_write(&current, self_sid, system_sid, admin_sid)? {
                return Ok(true);
            }
            match parent_path(&current) {
                Some(parent) if parent != current => current = parent,
                _ => break,
            }
        }
        Ok(false)
    }
}

/// The parent directory of a `\\?\C:\a\b` path, stopping at the volume root (`\\?\C:\`).
fn parent_path(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches(['\\', '/']);
    // A drive root ("C:" / "\\?\C:") or a volume-GUID root has no parent.
    if trimmed.ends_with(':') {
        return None;
    }
    if trimmed.starts_with("\\\\?\\Volume{") && trimmed.ends_with('}') {
        return None;
    }
    let idx = trimmed.rfind(['\\', '/'])?;
    let parent = &trimmed[..idx];
    if parent.ends_with(':') {
        return Some(format!("{parent}\\"));
    }
    if parent.is_empty() {
        return None;
    }
    Some(parent.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Security::Authorization::SetNamedSecurityInfoW;
    use windows::Win32::Security::{AddAccessAllowedAce, InitializeAcl, WinWorldSid, ACL_REVISION};

    struct TempDir(String);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("work-grant-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir.to_string_lossy().into_owned())
        }
        fn path(&self) -> &str {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn locations_equal_normalizes_prefix_and_case() {
        assert!(locations_equal(
            "C:\\Users\\X\\Docs",
            "\\\\?\\C:\\users\\x\\docs"
        ));
        assert!(!locations_equal("C:\\a", "C:\\b"));
        assert!(!locations_equal("C:\\a", "D:\\a"));
    }

    #[test]
    fn parent_path_stops_at_volume_root() {
        assert_eq!(parent_path("\\\\?\\C:\\a\\b").unwrap(), "\\\\?\\C:\\a");
        assert_eq!(parent_path("\\\\?\\C:\\a").unwrap(), "\\\\?\\C:\\");
        assert!(parent_path("\\\\?\\C:\\").is_none());
    }

    #[test]
    fn prepare_confirmation_binds_root_and_reports_same_location() {
        let tmp = TempDir::new("confirm");
        let (root, confirmation) = prepare_root_confirmation(tmp.path()).unwrap();
        assert!(confirmation.actual_location.contains("work-grant-confirm"));
        // The selected path and the opened location are the same object (no ancestor junction).
        assert!(!confirmation.differs_from_selected);
        assert!(root.identity.is_dir());
        // other_user_writable reflects the real ancestor DACLs (a user-profile temp dir sits under
        // shared ancestors like C:\ that grant Authenticated Users write — flagging that is correct,
        // §4.2 step 5). The isolated DACL-parse negative case is tested below.
        let _ = confirmation.other_user_writable;
    }

    #[test]
    fn dacl_granting_only_self_write_is_not_other_writable() {
        let tmp = TempDir::new("selfonly");
        unsafe {
            let self_bytes = crate::listener::current_user_sid().unwrap();
            let system_bytes = well_known_sid(WinLocalSystemSid);
            let admin_bytes = well_known_sid(WinBuiltinAdministratorsSid);
            // A DACL granting ONLY the current user full control (no other principal).
            let mut acl = vec![0u8; 1024];
            let acl_ptr = acl.as_mut_ptr() as *mut ACL;
            InitializeAcl(acl_ptr, acl.len() as u32, ACL_REVISION).unwrap();
            AddAccessAllowedAce(
                acl_ptr,
                ACL_REVISION,
                0x1000_0000, // GENERIC_ALL
                PSID(self_bytes.as_ptr() as *mut _),
            )
            .unwrap();
            let path_w = wide_null(tmp.path());
            let rc = SetNamedSecurityInfoW(
                PCWSTR(path_w.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(acl_ptr),
                None,
            );
            if rc.0 != 0 {
                eprintln!("skipping: SetNamedSecurityInfoW rc={}", rc.0);
                return;
            }
            let flagged = dacl_grants_other_write(
                tmp.path(),
                PSID(self_bytes.as_ptr() as *mut _),
                PSID(system_bytes.as_ptr() as *mut _),
                PSID(admin_bytes.as_ptr() as *mut _),
            )
            .unwrap();
            assert!(
                !flagged,
                "a self-only DACL must not be flagged as other-user-writable"
            );
        }
    }

    #[test]
    fn root_identity_hash_is_stable_for_the_bound_object() {
        let tmp = TempDir::new("hash");
        let root = tool_exec::bind_root(tmp.path()).unwrap();
        let h1 = root_identity_hash(&root);
        let h2 = root_identity_hash(&root);
        assert_eq!(h1, h2);
        assert!(h1.starts_with("sha256:"));
    }

    #[test]
    fn registry_registers_and_resolves_a_confirmed_grant() {
        let tmp = TempDir::new("registry");
        let root = tool_exec::bind_root(tmp.path()).unwrap();
        let mut registry = GrantRegistry::new();
        assert!(!registry.contains("g1"));
        let hash = registry.register("g1".into(), root, vec!["WeMeet成果".into()]);
        assert!(registry.contains("g1"));
        let entry = registry.get("g1").unwrap();
        assert_eq!(entry.root_identity_hash, hash);
        assert_eq!(entry.artifact_dir, vec!["WeMeet成果".to_string()]);
        assert!(registry.get("missing").is_none());
    }

    #[test]
    fn other_user_writable_detects_an_everyone_write_ace() {
        let tmp = TempDir::new("dacL");
        // Grant Everyone write/delete-child on the dir, then the check must flag it.
        let flagged = unsafe {
            let everyone = well_known_sid(WinWorldSid);
            let mut acl = vec![0u8; 1024];
            let acl_ptr = acl.as_mut_ptr() as *mut ACL;
            InitializeAcl(acl_ptr, acl.len() as u32, ACL_REVISION).unwrap();
            AddAccessAllowedAce(
                acl_ptr,
                ACL_REVISION,
                FILE_WRITE_DATA.0 | FILE_DELETE_CHILD.0,
                PSID(everyone.as_ptr() as *mut _),
            )
            .unwrap();
            let path_w = wide_null(tmp.path());
            let rc = SetNamedSecurityInfoW(
                PCWSTR(path_w.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(acl_ptr),
                None,
            );
            if rc.0 != 0 {
                // Setting a DACL may require privilege on some hosts; skip rather than fail.
                eprintln!("skipping: SetNamedSecurityInfoW rc={}", rc.0);
                return;
            }
            other_user_writable(tmp.path()).unwrap()
        };
        assert!(
            flagged,
            "an Everyone write ACE must be flagged as other-user-writable"
        );
    }
}
