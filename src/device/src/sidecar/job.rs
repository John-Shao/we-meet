//! Job Object supervisor (device-design §1 :18). The sidecar process tree is
//! placed in a Job Object with a per-process memory limit and kill-on-close, so
//! closing the job (Broker exit / Run stop) terminates the whole tree. The Job
//! Object is not a file sandbox; the AppContainer ([`super::appcontainer`]) and
//! Node permission model carry the capability boundary.

use std::ffi::c_void;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
};

/// A Job Object failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobError {
    Create,
    Limits,
    Assign,
}

/// An owned Job Object handle.
pub struct JobObject {
    handle: HANDLE,
}

impl JobObject {
    /// Create an unnamed Job Object.
    pub fn create() -> Result<Self, JobError> {
        unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null()).map_err(|_| JobError::Create)?;
            Ok(Self { handle })
        }
    }

    /// Apply kill-on-close and a per-process memory limit (bytes).
    pub fn set_limits(&self, process_memory_bytes: usize) -> Result<(), JobError> {
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        info.ProcessMemoryLimit = process_memory_bytes;
        unsafe {
            SetInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|_| JobError::Limits)?;
        }
        Ok(())
    }

    /// Assign a process to this job (its children inherit the job).
    pub fn assign(&self, process: HANDLE) -> Result<(), JobError> {
        unsafe {
            AssignProcessToJobObject(self.handle, process).map_err(|_| JobError::Assign)?;
        }
        Ok(())
    }

    /// The raw job handle (for spawning into the job).
    pub fn handle(&self) -> HANDLE {
        self.handle
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        // With kill-on-close set, this terminates any assigned process tree.
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Threading::GetCurrentProcess;

    #[test]
    fn create_and_set_limits() {
        let job = JobObject::create().expect("create job");
        // 1 GiB per-process limit; no process is assigned, so drop kills nothing.
        job.set_limits(1024 * 1024 * 1024).expect("set limits");
    }

    #[test]
    fn assign_process_without_kill_on_close() {
        // No limits set => no kill-on-close, so assigning the current process and
        // dropping the job is safe for the test runner.
        let job = JobObject::create().expect("create job");
        unsafe {
            job.assign(GetCurrentProcess())
                .expect("assign current process");
        }
    }

    #[test]
    fn kill_on_close_flag_value() {
        assert_eq!(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0, 0x2000);
    }
}
