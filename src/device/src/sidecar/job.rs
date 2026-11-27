//! Job Object supervisor (device-design §1 :18). The sidecar process tree is
//! placed in a Job Object with per-process memory, CPU rate/time and one-process
//! limits plus kill-on-close. A Broker CPU guard independently enforces the CPU
//! budget because this host accepted but did not enforce the Job CPU settings in
//! a real-child probe. The Job Object is not a file sandbox; the AppContainer
//! ([`super::appcontainer`]) and Node permission model carry the capability boundary.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, FILETIME, HANDLE, WAIT_TIMEOUT,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectCpuRateControlInformation,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    JOB_OBJECT_LIMIT_PROCESS_TIME,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, TerminateProcess, WaitForSingleObject,
};

/// A Job Object failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobError {
    Create,
    Limits,
    Assign,
    Monitor,
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

    /// Apply kill-on-close, per-process memory/CPU-time, CPU rate and process-count limits.
    /// CPU time is in 100-nanosecond ticks; rate is the Job Object CPU rate (1..=10,000).
    pub fn set_limits(
        &self,
        process_memory_bytes: usize,
        process_cpu_time_100ns: u64,
        cpu_rate_basis_points: u32,
        active_process_limit: u32,
    ) -> Result<(), JobError> {
        if process_memory_bytes == 0
            || process_cpu_time_100ns == 0
            || process_cpu_time_100ns > i64::MAX as u64
            || !(1..=10_000).contains(&cpu_rate_basis_points)
            || active_process_limit == 0
        {
            return Err(JobError::Limits);
        }
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_PROCESS_TIME
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        info.BasicLimitInformation.PerProcessUserTimeLimit = process_cpu_time_100ns as i64;
        info.BasicLimitInformation.ActiveProcessLimit = active_process_limit;
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
        let cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
            ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
            Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 {
                CpuRate: cpu_rate_basis_points,
            },
        };
        unsafe {
            SetInformationJobObject(
                self.handle,
                JobObjectCpuRateControlInformation,
                &cpu as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
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

pub struct CpuGuard {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl CpuGuard {
    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for CpuGuard {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Broker-side CPU budget enforcement. Windows accepts Job CPU rate/time settings on this host,
/// but a real busy-child probe showed they were not enforced; this guard is therefore mandatory,
/// not a replacement for the Job's memory/process-count/kill-on-close limits.
pub fn spawn_cpu_guard(
    process: HANDLE,
    process_cpu_time_100ns: u64,
    cpu_rate_basis_points: u32,
) -> Result<CpuGuard, JobError> {
    if process_cpu_time_100ns == 0 || !(1..=10_000).contains(&cpu_rate_basis_points) {
        return Err(JobError::Limits);
    }
    let mut duplicate: HANDLE = unsafe { std::mem::zeroed() };
    unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            process,
            GetCurrentProcess(),
            &mut duplicate,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
        .map_err(|_| JobError::Monitor)?;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let raw_handle = duplicate.0 as usize;
    let thread = match std::thread::Builder::new()
        .name("work-sidecar-cpu-guard".into())
        .spawn(move || {
            let process = HANDLE(raw_handle as *mut c_void);
            let cpu_budget_seconds = process_cpu_time_100ns as f64 / 10_000_000.0;
            let cpu_rate = cpu_rate_basis_points as f64 / 10_000.0;
            let mut previous: Option<(Instant, u64)> = None;
            while !thread_stop.load(Ordering::Relaxed) {
                unsafe {
                    if WaitForSingleObject(process, 0) != WAIT_TIMEOUT {
                        break;
                    }
                }
                let mut creation = FILETIME::default();
                let mut exit = FILETIME::default();
                let mut kernel = FILETIME::default();
                let mut user = FILETIME::default();
                let read = unsafe {
                    GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user)
                        .is_ok()
                };
                if !read {
                    break;
                }
                let ticks = |time: FILETIME| {
                    ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64
                };
                let total_ticks = ticks(kernel) + ticks(user);
                let total_seconds = total_ticks as f64 / 10_000_000.0;
                if total_seconds > cpu_budget_seconds {
                    unsafe {
                        let _ = TerminateProcess(process, 1);
                    }
                    break;
                }
                let now = Instant::now();
                if let Some((previous_at, previous_ticks)) = previous {
                    let wall_seconds = previous_at.elapsed().as_secs_f64();
                    if wall_seconds >= 2.0 {
                        let used_seconds =
                            total_ticks.saturating_sub(previous_ticks) as f64 / 10_000_000.0;
                        if used_seconds > wall_seconds * cpu_rate + 0.1 {
                            unsafe {
                                let _ = TerminateProcess(process, 1);
                            }
                            break;
                        }
                        previous = Some((now, total_ticks));
                    }
                } else {
                    previous = Some((now, total_ticks));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            unsafe {
                let _ = CloseHandle(process);
            }
        }) {
        Ok(thread) => thread,
        Err(_) => {
            unsafe {
                let _ = CloseHandle(duplicate);
            }
            return Err(JobError::Monitor);
        }
    };
    Ok(CpuGuard {
        stop,
        thread: Some(thread),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::c_void;
    use std::time::{Duration, Instant};
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, BOOL, FILETIME, WAIT_EVENT};
    use windows::Win32::System::JobObjects::{
        JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    use windows::Win32::System::Threading::{
        CreateProcessW, GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, ResumeThread,
        TerminateProcess, WaitForSingleObject, CREATE_SUSPENDED, PROCESS_INFORMATION, STARTUPINFOW,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn spawn_suspended_test(args: &[&str]) -> PROCESS_INFORMATION {
        let executable = std::env::current_exe().expect("current test executable");
        let mut command = format!("\"{}\"", executable.display());
        for arg in args {
            command.push(' ');
            command.push_str(arg);
        }
        let mut command = wide(&command);
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        unsafe {
            CreateProcessW(
                PCWSTR::null(),
                PWSTR(command.as_mut_ptr()),
                None,
                None,
                BOOL(0),
                CREATE_SUSPENDED,
                None,
                PCWSTR::null(),
                &startup,
                &mut process,
            )
            .expect("create suspended test process");
        }
        process
    }

    fn close_process(process: &PROCESS_INFORMATION) {
        unsafe {
            let _ = TerminateProcess(process.hProcess, 1);
            let _ = CloseHandle(process.hThread);
            let _ = CloseHandle(process.hProcess);
        }
    }

    #[test]
    fn create_and_set_limits() {
        let job = JobObject::create().expect("create job");
        job.set_limits(1024 * 1024 * 1024, 60 * 10_000_000, 5_000, 1)
            .expect("set limits");
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let mut returned = 0;
        unsafe {
            QueryInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                Some(&mut returned),
            )
            .expect("query extended limits");
        }
        assert_eq!(
            returned as usize,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()
        );
        assert_eq!(info.BasicLimitInformation.ActiveProcessLimit, 1);
        assert_eq!(
            info.BasicLimitInformation.PerProcessUserTimeLimit,
            60 * 10_000_000
        );
        assert_eq!(info.ProcessMemoryLimit, 1024 * 1024 * 1024);
        assert!(info
            .BasicLimitInformation
            .LimitFlags
            .contains(JOB_OBJECT_LIMIT_ACTIVE_PROCESS));
        assert!(info
            .BasicLimitInformation
            .LimitFlags
            .contains(JOB_OBJECT_LIMIT_PROCESS_TIME));
        let mut cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                job.handle,
                JobObjectCpuRateControlInformation,
                &mut cpu as *mut _ as *mut c_void,
                std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
                Some(&mut returned),
            )
            .expect("query CPU limits");
        }
        assert_eq!(
            returned as usize,
            std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>()
        );
        assert_eq!(
            cpu.ControlFlags,
            JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP
        );
        assert_eq!(unsafe { cpu.Anonymous.CpuRate }, 5_000);
    }

    #[test]
    fn invalid_limits_are_refused_before_windows_configuration() {
        let job = JobObject::create().expect("create job");
        for (memory, cpu_time, cpu, processes) in [
            (0, 1, 5_000, 1),
            (1, 0, 5_000, 1),
            (1, 1, 0, 1),
            (1, 1, 10_001, 1),
            (1, 1, 5_000, 0),
        ] {
            assert_eq!(
                job.set_limits(memory, cpu_time, cpu, processes),
                Err(JobError::Limits)
            );
        }
    }

    #[test]
    fn second_process_cannot_join_a_single_process_job() {
        let job = JobObject::create().expect("create job");
        job.set_limits(1024 * 1024 * 1024, 60 * 10_000_000, 5_000, 1)
            .expect("set limits");
        let first = spawn_suspended_test(&[
            "--ignored",
            "--exact",
            "sidecar::job::tests::job_child_wait",
            "--nocapture",
        ]);
        job.assign(first.hProcess).expect("assign first process");
        let second = spawn_suspended_test(&[
            "--ignored",
            "--exact",
            "sidecar::job::tests::job_child_wait",
            "--nocapture",
        ]);
        assert_eq!(job.assign(second.hProcess), Err(JobError::Assign));
        close_process(&second);
        close_process(&first);
    }

    fn assert_cpu_guard_kills(
        process_cpu_time_100ns: u64,
        cpu_rate_basis_points: u32,
        minimum_wall_seconds: f64,
        maximum_cpu_seconds: f64,
    ) {
        let child = spawn_suspended_test(&[
            "--ignored",
            "--exact",
            "sidecar::job::tests::job_cpu_busy_child",
            "--nocapture",
        ]);
        let mut guard = spawn_cpu_guard(
            child.hProcess,
            process_cpu_time_100ns,
            cpu_rate_basis_points,
        )
        .expect("start CPU guard");
        unsafe {
            ResumeThread(child.hThread);
        }
        let started = Instant::now();
        assert_eq!(
            unsafe { WaitForSingleObject(child.hProcess, 10_000) },
            WAIT_EVENT(0)
        );
        let wall_seconds = started.elapsed().as_secs_f64();
        guard.shutdown();
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        unsafe {
            GetProcessTimes(
                child.hProcess,
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
            .expect("query child CPU time");
        }
        let ticks =
            |time: FILETIME| ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64;
        let cpu_seconds = (ticks(kernel) + ticks(user)) as f64 / 10_000_000.0;
        let mut exit_code = 0;
        unsafe {
            GetExitCodeProcess(child.hProcess, &mut exit_code).expect("query child exit code");
        }
        close_process(&child);
        assert!(
            wall_seconds >= minimum_wall_seconds,
            "CPU guard fired too early: {wall_seconds}"
        );
        assert!(
            cpu_seconds < maximum_cpu_seconds,
            "CPU guard was not enforced: {cpu_seconds}s"
        );
        assert_ne!(
            exit_code, 0,
            "busy child exited normally instead of being killed"
        );
    }

    #[test]
    fn cpu_guard_enforces_total_cpu_time() {
        assert_cpu_guard_kills(10_000_000, 500, 0.5, 1.5);
    }

    #[test]
    fn cpu_guard_enforces_rate_window() {
        assert_cpu_guard_kills(60 * 10_000_000, 500, 1.5, 2.5);
    }

    #[test]
    #[ignore]
    fn job_child_wait() {
        std::thread::sleep(Duration::from_secs(10));
    }

    #[test]
    #[ignore]
    fn job_cpu_busy_child() {
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            std::hint::spin_loop();
        }
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
