//! Sidecar spawn configuration (device-design §1 :41). Node runs under the
//! `--permission` model (which denies child_process/addons/worker by default);
//! the environment is stripped of config-search and injection vectors
//! (NODE_OPTIONS, user HOME, CWD config search); there is no network capability;
//! only the fixed signed bundle and manifest are loaded. The actual Node bundle
//! load and tool loop land with the Node implementation batch.

/// Environment variables stripped from the sidecar (config-search/injection
/// vectors). The sidecar gets a private staging dir instead of the user HOME.
pub const STRIPPED_ENV: &[&str] = &[
    "NODE_OPTIONS",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "NODE_PATH",
];

/// Node permission-model flags. `--permission` denies child_process, addons and
/// worker threads unless explicitly granted (none are); only the bundle and the
/// private staging dir get fs access. No `--allow-net` is ever passed.
pub fn node_permission_flags(staging_dir: &str, bundle_path: &str) -> Vec<String> {
    vec![
        "--permission".to_string(),
        format!("--allow-fs-read={bundle_path}"),
        format!("--allow-fs-read={staging_dir}"),
        format!("--allow-fs-write={staging_dir}"),
    ]
}

/// Strip config-search/injection variables from a base environment.
pub fn clean_env(base: &[(String, String)]) -> Vec<(String, String)> {
    base.iter()
        .filter(|(key, _)| !STRIPPED_ENV.contains(&key.as_str()))
        .cloned()
        .collect()
}

/// The fixed inputs needed to spawn a sidecar.
#[derive(Clone, Debug)]
pub struct SpawnConfig {
    pub node_path: String,
    pub bundle_path: String,
    pub manifest_hash: String,
    pub runtime_digest: String,
    pub staging_dir: String,
}

impl SpawnConfig {
    /// The Node permission flags for this spawn.
    pub fn permission_flags(&self) -> Vec<String> {
        node_permission_flags(&self.staging_dir, &self.bundle_path)
    }
}

/// The per-process memory limit (device-design §1 :18, 1 GiB).
pub const PROCESS_MEMORY_LIMIT: usize = 1024 * 1024 * 1024;

/// A sidecar spawn failure. Each variant maps to one closed supervisor refusal.
#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpawnError {
    /// The per-Run AppContainer profile could not be created.
    AppContainer,
    /// The Job Object could not be created or limited.
    Job,
    /// The private staging directory could not be created.
    Staging,
    /// The process/thread attribute list could not be built.
    AttributeList,
    /// CreateProcessW refused the spawn.
    CreateProcess,
    /// The process could not be assigned to the Job Object.
    Assign,
}

/// A spawned sidecar process tree. Owning the Job Object means dropping this value (Run stop /
/// Broker exit / lease invalidation) kills the whole tree via kill-on-close; the AppContainer
/// profile is deleted on drop. The process and thread handles are closed on drop.
#[cfg(windows)]
pub struct SidecarProcess {
    process: windows::Win32::Foundation::HANDLE,
    thread: windows::Win32::Foundation::HANDLE,
    pid: u32,
    // Held for their Drop side effects (kill-on-close / profile delete); order matters: the job
    // must outlive the process handle close so the tree is killed before the handles release.
    _job: super::job::JobObject,
    _container: super::appcontainer::AppContainer,
}

#[cfg(windows)]
impl SidecarProcess {
    /// The spawned process id (the Node↔Broker pipe PID predicate, batch 1e).
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// The AppContainer SID bytes the process token carries (the pipe ACL, batch 1e).
    pub fn container_sid(&self) -> &[u8] {
        self._container.sid()
    }

    /// The raw process handle (wait/terminate by the supervisor).
    pub fn process_handle(&self) -> windows::Win32::Foundation::HANDLE {
        self.process
    }
}

#[cfg(windows)]
impl Drop for SidecarProcess {
    fn drop(&mut self) {
        unsafe {
            // Terminate the tree explicitly first (kill-on-close also fires when _job drops), then
            // release the handles. The AppContainer profile is deleted by _container's own drop.
            let _ = windows::Win32::System::Threading::TerminateProcess(self.process, 1);
            let _ = windows::Win32::Foundation::CloseHandle(self.thread);
            let _ = windows::Win32::Foundation::CloseHandle(self.process);
        }
    }
}

/// Spawn the single sidecar for a Run into a fresh AppContainer (no capabilities) under a
/// kill-on-close Job Object with a 1 GiB per-process limit, a stripped environment and the Node
/// `--permission` flags (device-design §1 :18/:41, DD:20). The process is created suspended,
/// assigned to the job, then resumed — so it never runs a single instruction outside the job.
///
/// Batch 1d spawns the configured Node bundle path; the real signed bundle and tool loop are
/// batch 2. The caller persists `start_nonce` BEFORE calling this (DD:113), and the lifecycle
/// state machine advances Spawned → Running only after this returns.
#[cfg(windows)]
pub fn spawn_sidecar(config: &SpawnConfig, run_id: &str) -> Result<SidecarProcess, SpawnError> {
    use std::ffi::c_void;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::Security::{PSID, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES};
    use windows::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        ResumeThread, UpdateProcThreadAttribute, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
        EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
        STARTUPINFOEXW, STARTUPINFOW,
    };

    // PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES (winnt.h): the AppContainer token attribute.
    const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_000F;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // 1. Private staging directory (Node's only writable fs root).
    std::fs::create_dir_all(&config.staging_dir).map_err(|_| SpawnError::Staging)?;

    // 2. Per-Run AppContainer profile, no capabilities.
    let container_name = format!("work-device-run-{run_id}-{}", uuid::Uuid::new_v4());
    let container = super::appcontainer::AppContainer::create(&container_name)
        .map_err(|_| SpawnError::AppContainer)?;

    // 3. Job Object with kill-on-close + 1 GiB per-process limit.
    let job = super::job::JobObject::create().map_err(|_| SpawnError::Job)?;
    job.set_limits(PROCESS_MEMORY_LIMIT)
        .map_err(|_| SpawnError::Job)?;

    // 4. Command line: node + permission flags + the fixed bundle. Quoted paths tolerate spaces.
    let mut cmdline = format!("\"{}\"", config.node_path);
    for flag in config.permission_flags() {
        cmdline.push(' ');
        cmdline.push_str(&flag);
    }
    cmdline.push_str(&format!(" \"{}\"", config.bundle_path));
    let mut cmdline_w = wide(&cmdline);

    // 5. Stripped environment block (double-null-terminated UTF-16 "KEY=VALUE" entries).
    let base_env: Vec<(String, String)> = std::env::vars().collect();
    let cleaned = clean_env(&base_env);
    let mut env_block: Vec<u16> = Vec::new();
    for (key, value) in &cleaned {
        env_block.extend(wide(&format!("{key}={value}")));
    }
    env_block.push(0); // final terminator (each entry already null-terminated)

    // 6. SECURITY_CAPABILITIES carrying the AppContainer SID and zero capabilities.
    let mut sid_bytes = container.sid().to_vec();
    let mut security_caps = SECURITY_CAPABILITIES {
        AppContainerSid: PSID(sid_bytes.as_mut_ptr() as *mut c_void),
        Capabilities: std::ptr::null_mut::<SID_AND_ATTRIBUTES>(),
        CapabilityCount: 0,
        Reserved: 0,
    };

    // 7. Proc-thread attribute list (one attribute), 16-byte aligned per MEMORY_ALLOCATION_ALIGNMENT.
    let mut size: usize = 0;
    unsafe {
        let _ = InitializeProcThreadAttributeList(
            LPPROC_THREAD_ATTRIBUTE_LIST(std::ptr::null_mut()),
            1,
            0,
            &mut size,
        );
    }
    let layout = std::alloc::Layout::from_size_align(size.max(1), 16)
        .map_err(|_| SpawnError::AttributeList)?;
    let attr_buf = unsafe { std::alloc::alloc_zeroed(layout) };
    if attr_buf.is_null() {
        return Err(SpawnError::AttributeList);
    }
    let attr_list = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf as *mut _);
    let attr_result = unsafe {
        InitializeProcThreadAttributeList(attr_list, 1, 0, &mut size).and_then(|_| {
            UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                Some(&mut security_caps as *mut _ as *const c_void),
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                None,
                None,
            )
        })
    };
    if attr_result.is_err() {
        unsafe {
            DeleteProcThreadAttributeList(attr_list);
            std::alloc::dealloc(attr_buf, layout);
        }
        return Err(SpawnError::AttributeList);
    }

    // 8. STARTUPINFOEX with the attribute list; create suspended into the AppContainer.
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attr_list;
    let mut process_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let staging_w = wide(&config.staging_dir);
    let create_result = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            PWSTR(cmdline_w.as_mut_ptr()),
            None,
            None,
            BOOL(0),
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            Some(env_block.as_ptr() as *const c_void),
            PCWSTR(staging_w.as_ptr()),
            &startup.StartupInfo as *const STARTUPINFOW,
            &mut process_info,
        )
    };

    // The attribute list is only needed during CreateProcess; release it now.
    unsafe {
        DeleteProcThreadAttributeList(attr_list);
        std::alloc::dealloc(attr_buf, layout);
    }
    if create_result.is_err() {
        return Err(SpawnError::CreateProcess);
    }

    // 9. Assign to the job BEFORE resuming, so the first instruction runs under kill-on-close.
    if let Err(err) = job.assign(process_info.hProcess) {
        unsafe {
            let _ = windows::Win32::System::Threading::TerminateProcess(process_info.hProcess, 1);
            let _ = windows::Win32::Foundation::CloseHandle(process_info.hThread);
            let _ = windows::Win32::Foundation::CloseHandle(process_info.hProcess);
        }
        let _ = err;
        return Err(SpawnError::Assign);
    }
    let resumed = unsafe { ResumeThread(process_info.hThread) };
    // ResumeThread returns the previous suspend count; (u32)-1 signals failure.
    if resumed == u32::MAX {
        unsafe {
            let _ = windows::Win32::System::Threading::TerminateProcess(process_info.hProcess, 1);
            let _ = windows::Win32::Foundation::CloseHandle(process_info.hThread);
            let _ = windows::Win32::Foundation::CloseHandle(process_info.hProcess);
        }
        return Err(SpawnError::CreateProcess);
    }

    Ok(SidecarProcess {
        process: process_info.hProcess,
        thread: process_info.hThread,
        pid: process_info.dwProcessId,
        _job: job,
        _container: container,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_env_strips_injection_vectors() {
        let base = vec![
            ("NODE_OPTIONS".to_string(), "--require evil".to_string()),
            ("HOME".to_string(), "/user/home".to_string()),
            ("USERPROFILE".to_string(), "C:\\Users\\x".to_string()),
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("SYSTEMROOT".to_string(), "C:\\Windows".to_string()),
        ];
        let cleaned = clean_env(&base);
        let keys: Vec<&str> = cleaned.iter().map(|(k, _)| k.as_str()).collect();
        assert!(!keys.contains(&"NODE_OPTIONS"));
        assert!(!keys.contains(&"HOME"));
        assert!(!keys.contains(&"USERPROFILE"));
        assert!(keys.contains(&"PATH"));
        assert!(keys.contains(&"SYSTEMROOT"));
    }

    #[test]
    fn permission_flags_enable_permission_model() {
        let flags = node_permission_flags("C:\\staging", "C:\\bundle.js");
        assert!(flags.contains(&"--permission".to_string()));
        assert!(flags.iter().any(|f| f.starts_with("--allow-fs-read=")));
        assert!(flags.iter().any(|f| f.starts_with("--allow-fs-write=")));
    }

    #[test]
    fn no_network_or_child_process_grant() {
        let flags = node_permission_flags("C:\\staging", "C:\\bundle.js");
        assert!(!flags.iter().any(|f| f.contains("--allow-net")));
        assert!(!flags.iter().any(|f| f.contains("--allow-child-process")));
        assert!(!flags.iter().any(|f| f.contains("--allow-addons")));
        assert!(!flags.iter().any(|f| f.contains("--allow-worker")));
    }

    #[test]
    fn spawn_config_flags_use_its_paths() {
        let config = SpawnConfig {
            node_path: "node".into(),
            bundle_path: "C:\\bundle.js".into(),
            manifest_hash: "hash".into(),
            runtime_digest: "digest".into(),
            staging_dir: "C:\\staging".into(),
        };
        let flags = config.permission_flags();
        assert!(flags.contains(&"--allow-fs-read=C:\\bundle.js".to_string()));
        assert!(flags.contains(&"--allow-fs-write=C:\\staging".to_string()));
    }
}
