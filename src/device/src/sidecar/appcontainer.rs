//! AppContainer per-Run profile (device-design §1 :18). Each Run's sidecar gets
//! its own AppContainer profile (a low-capability SID); the profile is created at
//! Run start and deleted at Run end. The AppContainer SID is what the process
//! token carries; combined with the Job Object and Node permission model it forms
//! the capability boundary. Spawning a process into the AppContainer lands with
//! the sidecar spawn integration.

use windows::core::PCWSTR;
use windows::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows::Win32::Security::{FreeSid, GetLengthSid, PSID};

/// An AppContainer failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppContainerError {
    Create,
    Derive,
    Delete,
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Copy a SID into owned bytes and free the API-allocated SID.
///
/// # Safety
/// `sid` must be a valid SID allocated by the AppContainer API.
unsafe fn take_sid(sid: PSID) -> Vec<u8> {
    let len = GetLengthSid(sid) as usize;
    let bytes = std::slice::from_raw_parts(sid.0 as *const u8, len).to_vec();
    let _ = FreeSid(sid);
    bytes
}

/// An AppContainer profile bound to a Run.
pub struct AppContainer {
    name: String,
    sid: Vec<u8>,
}

impl AppContainer {
    /// Create a per-Run AppContainer profile with no extra capabilities.
    pub fn create(name: &str) -> Result<Self, AppContainerError> {
        unsafe {
            let name_w = wide(name);
            let ptr = PCWSTR(name_w.as_ptr());
            let sid = CreateAppContainerProfile(ptr, ptr, ptr, None)
                .map_err(|_| AppContainerError::Create)?;
            let sid_bytes = take_sid(sid);
            Ok(Self {
                name: name.to_string(),
                sid: sid_bytes,
            })
        }
    }

    /// Derive the AppContainer SID for a name without creating a profile.
    pub fn derive_sid(name: &str) -> Result<Vec<u8>, AppContainerError> {
        unsafe {
            let name_w = wide(name);
            let sid = DeriveAppContainerSidFromAppContainerName(PCWSTR(name_w.as_ptr()))
                .map_err(|_| AppContainerError::Derive)?;
            Ok(take_sid(sid))
        }
    }

    /// The AppContainer SID bytes.
    pub fn sid(&self) -> &[u8] {
        &self.sid
    }

    /// The profile name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Delete the profile (Run end).
    pub fn delete(self) -> Result<(), AppContainerError> {
        unsafe {
            let name_w = wide(&self.name);
            DeleteAppContainerProfile(PCWSTR(name_w.as_ptr()))
                .map_err(|_| AppContainerError::Delete)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_name() -> String {
        format!("work-device-run-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn create_derive_and_delete_profile() {
        let name = unique_name();
        let container = AppContainer::create(&name).expect("create appcontainer");
        // The created profile's SID matches the derived SID for the same name.
        let derived = AppContainer::derive_sid(&name).expect("derive sid");
        assert_eq!(container.sid(), derived.as_slice());
        assert!(!container.sid().is_empty());
        container.delete().expect("delete appcontainer");
    }

    #[test]
    fn derive_is_deterministic() {
        let name = unique_name();
        let a = AppContainer::derive_sid(&name).expect("derive a");
        let b = AppContainer::derive_sid(&name).expect("derive b");
        assert_eq!(a, b);
    }
}
