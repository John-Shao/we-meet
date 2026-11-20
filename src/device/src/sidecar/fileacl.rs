//! Per-Run AppContainer file ACLs (device-design §1 :18/:41, 批2-7b-v 主签单选甲). CreateProcess
//! opens the executable image with the BROKER's token, so node.exe loads even though the sidecar
//! runs as a low-capability AppContainer; but every file Node opens at RUNTIME (the bundle main.js,
//! its vendored imports, the private staging dir) is opened with the AppContainer token, which the
//! default install ACLs (Users/Authenticated Users) do not grant. Without an explicit grant the
//! sidecar dies with MODULE_NOT_FOUND on main.js. So at spawn we grant THIS Run's AppContainer SID
//! read+execute on node.exe + the bundle dir and full control on its private staging dir, and revoke
//! those ACEs on Drop so the shared bundle/node.exe ACLs do not accumulate per-Run entries.
//!
//! The grant MERGES into the existing DACL (SetEntriesInAcl GRANT_ACCESS), preserving the
//! admin/system/users ACEs; revoke removes only this SID's entries (REVOKE_ACCESS). The per-Run pipe
//! DACL (ipc/nodepipe.rs) is a separate, replace-only DACL — files must keep their inherited ACEs.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL, WIN32_ERROR};
use windows::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
    GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, REVOKE_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
    TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, NO_INHERITANCE, PSECURITY_DESCRIPTOR,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT,
};

/// A file-ACL failure (grant or revoke). The spawn maps it to a closed refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileAclError;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Apply one explicit-access entry (grant or revoke) for `sid` to `path`'s DACL, merging with the
/// existing ACL. `permissions` is a GENERIC_* mask; `inherit` propagates to children (dirs).
unsafe fn apply(
    path: &str,
    sid: &[u8],
    permissions: u32,
    inherit: bool,
    revoke: bool,
) -> Result<(), FileAclError> {
    let path_w = wide(path);
    let mut old_dacl: *mut ACL = std::ptr::null_mut();
    let mut sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let err = GetNamedSecurityInfoW(
        PCWSTR(path_w.as_ptr()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        None,
        None,
        Some(&mut old_dacl),
        None,
        &mut sd,
    );
    if err != WIN32_ERROR(0) {
        return Err(FileAclError);
    }

    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: permissions,
        grfAccessMode: if revoke { REVOKE_ACCESS } else { GRANT_ACCESS },
        grfInheritance: if inherit {
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        } else {
            NO_INHERITANCE
        },
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: windows::core::PWSTR(sid.as_ptr() as *mut u16),
        },
    };
    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let err = SetEntriesInAclW(Some(&[entry]), Some(old_dacl), &mut new_dacl);
    if err != WIN32_ERROR(0) {
        let _ = LocalFree(HLOCAL(sd.0));
        return Err(FileAclError);
    }

    let err = SetNamedSecurityInfoW(
        PCWSTR(path_w.as_ptr()),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        None,
        None,
        Some(new_dacl),
        None,
    );
    let _ = LocalFree(HLOCAL(new_dacl as *mut _));
    let _ = LocalFree(HLOCAL(sd.0));
    if err != WIN32_ERROR(0) {
        return Err(FileAclError);
    }
    Ok(())
}

/// Grant `sid` the permission mask on `path` (merge into the existing DACL). `inherit` propagates the
/// ACE to child objects (use for directories so the whole bundle tree / staging tree is covered).
pub fn grant(path: &str, sid: &[u8], permissions: u32, inherit: bool) -> Result<(), FileAclError> {
    unsafe { apply(path, sid, permissions, inherit, false) }
}

/// Revoke every ACE for `sid` on `path` (Drop cleanup, so shared bundle/node.exe ACLs do not grow).
pub fn revoke(path: &str, sid: &[u8]) -> Result<(), FileAclError> {
    // The permission mask is ignored for REVOKE_ACCESS; pass 0. Inheritance must match the grant so
    // the inheritable ACE is the one removed.
    unsafe { apply(path, sid, 0, true, true) }
}
