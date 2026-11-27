//! Sidecar spawn configuration (device-design §1 :41). Node runs under the
//! `--permission` model (which denies child_process/addons/worker by default);
//! the environment is stripped of config-search and injection vectors
//! (NODE_OPTIONS, user HOME, CWD config search); there is no network capability;
//! only the fixed signed bundle and manifest are loaded. The actual Node bundle
//! load and tool loop land with the Node implementation batch.

/// Environment variables stripped from the sidecar outright. These are pure injection/config-search
/// vectors that Windows does NOT require for process creation, so removing them is safe.
pub const STRIPPED_ENV: &[&str] = &["NODE_OPTIONS", "NODE_PATH"];

/// Profile variables REDIRECTED to the private staging dir instead of removed. CreateProcess into an
/// AppContainer refuses a block missing USERPROFILE/APPDATA/LOCALAPPDATA (ERROR_ENVVAR_NOT_FOUND,
/// 0x800700CB), so they must stay present; pointing them at the empty staging dir honours the
/// "private staging dir instead of the user HOME" isolation (device-design §1 :41) without breaking
/// the spawn. Node's `--permission` fs-read grant (bundle + staging only) is the enforcing boundary.
pub const REDIRECTED_ENV: &[&str] = &["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

/// Node permission-model flags. `--permission` denies child_process, addons and
/// worker threads unless explicitly granted (none are); only the bundle and the
/// private staging dir get fs access. No `--allow-net` is ever passed.
pub fn node_permission_flags(staging_dir: &str, bundle_path: &str) -> Vec<String> {
    // Read is granted on the whole bundle DIRECTORY (main.js + its vendored imports + tool-schemas),
    // not just the entry file, so the signed tree's relative imports load under --permission.
    let bundle_dir = std::path::Path::new(bundle_path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| bundle_path.to_string());
    vec![
        "--permission".to_string(),
        // Skip real-path (symlink) resolution of the entry point and imports. realpathSync lstat-s
        // every ancestor dir up to the drive root; the AppContainer has no read grant there (only the
        // bundle tree + staging), so resolution would EPERM on e.g. `D:\`. Preserving symlinks loads
        // the fixed bundle path directly — there are no symlinks in the signed bundle to resolve.
        "--preserve-symlinks".to_string(),
        "--preserve-symlinks-main".to_string(),
        format!("--allow-fs-read={bundle_dir}"),
        format!("--allow-fs-read={staging_dir}"),
        format!("--allow-fs-write={staging_dir}"),
    ]
}

/// Strip injection vectors and redirect the profile variables to the private staging dir. The
/// profile vars are kept PRESENT (CreateProcess into an AppContainer requires them) but pointed at
/// the empty staging dir, so Node's config search lands there instead of the user's real profile.
pub fn clean_env(base: &[(String, String)], staging_dir: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = base
        .iter()
        .filter(|(key, _)| !STRIPPED_ENV.contains(&key.as_str()))
        .map(|(key, value)| {
            if REDIRECTED_ENV.contains(&key.as_str()) {
                (key.clone(), staging_dir.to_string())
            } else {
                (key.clone(), value.clone())
            }
        })
        .collect();
    // Ensure every required profile var is present even if the parent environment lacked it.
    for key in REDIRECTED_ENV {
        if !out.iter().any(|(k, _)| k == key) {
            out.push((key.to_string(), staging_dir.to_string()));
        }
    }
    out
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
pub const PROCESS_CPU_TIME_LIMIT_100NS: u64 = 60 * 10_000_000;
pub const CPU_RATE_LIMIT_BASIS_POINTS: u32 = 5_000;
pub const ACTIVE_PROCESS_LIMIT: u32 = 1;

/// The per-Run AppContainer profile name. CreateAppContainerProfile caps the name at 64 chars
/// (ERROR_INVALID_PARAMETER beyond it): the 16-char prefix + 36-char run_id + an 8-char uniqueness
/// suffix totals 61, leaving headroom while staying unique across recreations of the same Run.
#[cfg(windows)]
fn container_name(run_id: &str) -> String {
    format!(
        "work-device-run-{run_id}-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    )
}

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
    /// The per-Run AppContainer file ACLs (bundle read / staging write) could not be granted.
    FileAcl,
    /// The per-Run Node↔Broker pipe could not be created before the sidecar resumed.
    NodePipe,
}

/// A spawned sidecar process tree. Owning the Job Object means dropping this value (Run stop /
/// Broker exit / lease invalidation) kills the whole tree via kill-on-close; the AppContainer
/// profile is deleted on drop. The process and thread handles are closed on drop.
#[cfg(windows)]
pub struct SidecarProcess {
    process: windows::Win32::Foundation::HANDLE,
    thread: windows::Win32::Foundation::HANDLE,
    pid: u32,
    // Shared paths (node.exe + bundle dir) granted this Run's SID read+execute; Drop revokes the ACEs
    // so the install ACLs do not accumulate per-Run entries. The private staging dir is removed too.
    acl_paths: Vec<String>,
    staging_dir: String,
    // The per-Run Node↔Broker pipe handle, created while the sidecar was suspended so the pipe exists
    // before Node's first connect (no spawn/create race). Handed to the Node-service thread via
    // take_node_pipe_handle(); Drop closes it only if it was never handed off.
    node_pipe_handle: Option<isize>,
    // Held for their Drop side effects (kill-on-close / profile delete); order matters: the job
    // must outlive the process handle close so the tree is killed before the handles release.
    _cpu_guard: super::job::CpuGuard,
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

    /// Take ownership of the pre-created Node↔Broker pipe handle (the Node-service thread rebuilds
    /// its server from it). After this the SidecarProcess no longer closes the handle.
    pub fn take_node_pipe_handle(&mut self) -> Option<isize> {
        self.node_pipe_handle.take()
    }
}

#[cfg(windows)]
impl Drop for SidecarProcess {
    fn drop(&mut self) {
        self._cpu_guard.shutdown();
        unsafe {
            // Terminate the tree explicitly first (kill-on-close also fires when _job drops), then
            // release the handles. The AppContainer profile is deleted by _container's own drop.
            let _ = windows::Win32::System::Threading::TerminateProcess(self.process, 1);
            let _ = windows::Win32::Foundation::CloseHandle(self.thread);
            let _ = windows::Win32::Foundation::CloseHandle(self.process);
            // Close the pipe handle only if it was never handed to the Node-service thread.
            if let Some(handle) = self.node_pipe_handle.take() {
                let _ = windows::Win32::Foundation::CloseHandle(
                    windows::Win32::Foundation::HANDLE(handle as *mut std::ffi::c_void),
                );
            }
        }
        // Revoke this Run's SID ACEs from the shared bundle/node.exe (no per-Run accumulation) and
        // remove the private staging dir. Best-effort: the profile SID is still valid here (the
        // _container field drops after this method), and a stale ACE/dir is harmless to the next Run.
        for path in &self.acl_paths {
            let _ = super::fileacl::revoke(path, self._container.sid());
        }
        let _ = super::fileacl::revoke(&self.staging_dir, self._container.sid());
        let _ = std::fs::remove_dir_all(&self.staging_dir);
    }
}

/// Spawn the single sidecar for a Run into a fresh AppContainer (no capabilities) under a
/// kill-on-close Job Object with a 1 GiB per-process limit, 60s CPU-time budget, 50% CPU rate and
/// one-process limit, a Broker CPU guard, a stripped environment and the Node `--permission` flags
/// (device-design §1 :18/:41, DD:20). The process is created suspended, assigned to the job, then
/// resumed — so it never runs a single instruction outside the job.
///
/// Batch 1d spawns the configured Node bundle path; the real signed bundle and tool loop are
/// batch 2. The caller persists `start_nonce` BEFORE calling this (DD:113), and the lifecycle
/// state machine advances Spawned → Running only after this returns.
#[cfg(windows)]
pub fn spawn_sidecar(
    config: &SpawnConfig,
    run_id: &str,
    pipe_name: &str,
) -> Result<SidecarProcess, SpawnError> {
    use std::ffi::c_void;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{BOOL, GENERIC_ALL, GENERIC_EXECUTE, GENERIC_READ};
    use windows::Win32::Security::{PSID, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES};
    use windows::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        ResumeThread, UpdateProcThreadAttribute, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
        EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
        STARTUPINFOEXW, STARTUPINFOW,
    };

    // PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES (winnt.h): ProcThreadAttributeValue(9, FALSE,
    // TRUE, FALSE) = 0x00020009. (0x0002000F is ALL_APPLICATION_PACKAGES_POLICY, a different
    // attribute whose value shape rejects SECURITY_CAPABILITIES with ERROR_BAD_COMMAND.)
    const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // 1. Private PER-RUN staging directory (Node's only writable fs root): a run_id subdir under the
    // configured staging base, so concurrent Runs never share a writable root (批2-7b-v 甲).
    let staging_dir = std::path::Path::new(&config.staging_dir)
        .join(run_id)
        .to_string_lossy()
        .into_owned();
    std::fs::create_dir_all(&staging_dir).map_err(|_| SpawnError::Staging)?;
    // The bundle directory (parent of main.js) gets an inheritable read grant so the whole signed
    // tree — main.js + vendored imports + tool-schemas.json — is readable by this Run's container.
    let bundle_dir = std::path::Path::new(&config.bundle_path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| config.bundle_path.clone());

    // 2. Per-Run AppContainer profile, no capabilities.
    let container_name = container_name(run_id);
    let container = super::appcontainer::AppContainer::create(&container_name)
        .map_err(|_| SpawnError::AppContainer)?;

    // 3. Job Object with kill-on-close, 1 GiB memory, 60s CPU time, 50% CPU rate and one process.
    let job = super::job::JobObject::create().map_err(|_| SpawnError::Job)?;
    job.set_limits(
        PROCESS_MEMORY_LIMIT,
        PROCESS_CPU_TIME_LIMIT_100NS,
        CPU_RATE_LIMIT_BASIS_POINTS,
        ACTIVE_PROCESS_LIMIT,
    )
    .map_err(|_| SpawnError::Job)?;

    // 4. Command line: node + permission flags + the fixed bundle. Quoted paths tolerate spaces.
    let mut cmdline = format!("\"{}\"", config.node_path);
    for flag in node_permission_flags(&staging_dir, &config.bundle_path) {
        cmdline.push(' ');
        cmdline.push_str(&flag);
    }
    // The pipe is NOT fs-granted under --permission. net.connect({path}) to the Broker pipe works
    // without an fs grant (the pipe DACL grants this Run's AppContainer SID at the OS level). Adding
    // --allow-fs-read/write={pipe_name} makes Node realpath-resolve the granted pipe path, which hangs
    // the IPC connect under the AppContainer (the 'connect' event never fires). No --allow-net either
    // (the sidecar has no network capability, DD:20).
    cmdline.push_str(&format!(" \"{}\"", config.bundle_path));
    // The per-Run Node↔Broker pipe name is argv[2] (a name, not a capability); the bundle connects
    // back through it after the one-time handshake (§6.1). It is fixed before spawn so the suspended
    // process carries it from its first instruction.
    cmdline.push_str(&format!(" \"{}\"", pipe_name));
    let mut cmdline_w = wide(&cmdline);

    // 5. Stripped environment block (double-null-terminated UTF-16 "KEY=VALUE" entries).
    let base_env: Vec<(String, String)> = std::env::vars().collect();
    let cleaned = clean_env(&base_env, &staging_dir);
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
    let staging_w = wide(&staging_dir);
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

    // 10. Per-Run file ACLs (批2-7b-v 甲): grant THIS Run's AppContainer SID read+execute on node.exe
    // and the whole bundle tree, full control on its private staging dir. CreateProcess opened the
    // image with the Broker token, but Node's RUNTIME reads use the AppContainer token, which the
    // install ACLs do not grant — without this the sidecar dies MODULE_NOT_FOUND on main.js. The
    // process is still suspended here, so the first read already sees the grant (no race). Drop
    // revokes the shared-path ACEs and removes the staging dir.
    let acl_paths = vec![config.node_path.clone(), bundle_dir.clone()];
    let rx = GENERIC_READ.0 | GENERIC_EXECUTE.0;
    let grant_result = super::fileacl::grant(&config.node_path, container.sid(), rx, false)
        .and_then(|_| super::fileacl::grant(&bundle_dir, container.sid(), rx, true))
        .and_then(|_| super::fileacl::grant(&staging_dir, container.sid(), GENERIC_ALL.0, true));
    if grant_result.is_err() {
        unsafe {
            let _ = windows::Win32::System::Threading::TerminateProcess(process_info.hProcess, 1);
            let _ = windows::Win32::Foundation::CloseHandle(process_info.hThread);
            let _ = windows::Win32::Foundation::CloseHandle(process_info.hProcess);
        }
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(SpawnError::FileAcl);
    }

    // 11. Create the per-Run Node↔Broker pipe WHILE the sidecar is still suspended, so the pipe
    // instance exists before Node's first connect. Creating it after resume races the sidecar's
    // net.connect (ENOENT) and a failed accept then destroys the pipe, which retry cannot recover.
    // The handle is handed to the Node-service thread (serve_run rebuilds its server from it).
    let node_pipe = crate::ipc::nodepipe::NodePipeServer::create(
        pipe_name,
        container.sid(),
        process_info.dwProcessId,
    )
    .map_err(|_| SpawnError::NodePipe);
    let node_pipe_handle = match node_pipe {
        Ok(server) => server.into_raw_handle().0 as isize,
        Err(err) => {
            unsafe {
                let _ =
                    windows::Win32::System::Threading::TerminateProcess(process_info.hProcess, 1);
                let _ = windows::Win32::Foundation::CloseHandle(process_info.hThread);
                let _ = windows::Win32::Foundation::CloseHandle(process_info.hProcess);
            }
            for path in &acl_paths {
                let _ = super::fileacl::revoke(path, container.sid());
            }
            let _ = std::fs::remove_dir_all(&staging_dir);
            return Err(err);
        }
    };

    let cpu_guard = match super::job::spawn_cpu_guard(
        process_info.hProcess,
        PROCESS_CPU_TIME_LIMIT_100NS,
        CPU_RATE_LIMIT_BASIS_POINTS,
    ) {
        Ok(guard) => guard,
        Err(_) => {
            unsafe {
                let _ =
                    windows::Win32::System::Threading::TerminateProcess(process_info.hProcess, 1);
                let _ = windows::Win32::Foundation::CloseHandle(process_info.hThread);
                let _ = windows::Win32::Foundation::CloseHandle(process_info.hProcess);
                let _ = windows::Win32::Foundation::CloseHandle(
                    windows::Win32::Foundation::HANDLE(node_pipe_handle as *mut c_void),
                );
            }
            for path in &acl_paths {
                let _ = super::fileacl::revoke(path, container.sid());
            }
            let _ = std::fs::remove_dir_all(&staging_dir);
            return Err(SpawnError::Job);
        }
    };

    let resumed = unsafe { ResumeThread(process_info.hThread) };
    // ResumeThread returns the previous suspend count; (u32)-1 signals failure.
    if resumed == u32::MAX {
        unsafe {
            let _ = windows::Win32::System::Threading::TerminateProcess(process_info.hProcess, 1);
            let _ = windows::Win32::Foundation::CloseHandle(process_info.hThread);
            let _ = windows::Win32::Foundation::CloseHandle(process_info.hProcess);
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                node_pipe_handle as *mut c_void,
            ));
        }
        for path in &acl_paths {
            let _ = super::fileacl::revoke(path, container.sid());
        }
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(SpawnError::CreateProcess);
    }

    Ok(SidecarProcess {
        process: process_info.hProcess,
        thread: process_info.hThread,
        pid: process_info.dwProcessId,
        acl_paths,
        staging_dir,
        node_pipe_handle: Some(node_pipe_handle),
        _cpu_guard: cpu_guard,
        _job: job,
        _container: container,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_env_strips_injection_vectors_and_redirects_profile_to_staging() {
        let base = vec![
            ("NODE_OPTIONS".to_string(), "--require evil".to_string()),
            ("NODE_PATH".to_string(), "/evil/modules".to_string()),
            ("HOME".to_string(), "/user/home".to_string()),
            ("USERPROFILE".to_string(), "C:\\Users\\x".to_string()),
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("SYSTEMROOT".to_string(), "C:\\Windows".to_string()),
        ];
        let cleaned = clean_env(&base, "C:\\staging");
        let value = |key: &str| {
            cleaned
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        // Injection vectors are removed outright.
        assert!(value("NODE_OPTIONS").is_none());
        assert!(value("NODE_PATH").is_none());
        // Profile vars stay PRESENT (CreateProcess requires them) but point at the private staging
        // dir, never the user's real profile — including APPDATA/LOCALAPPDATA absent from the base.
        assert_eq!(value("HOME"), Some("C:\\staging"));
        assert_eq!(value("USERPROFILE"), Some("C:\\staging"));
        assert_eq!(value("APPDATA"), Some("C:\\staging"));
        assert_eq!(value("LOCALAPPDATA"), Some("C:\\staging"));
        // Untouched vars survive verbatim.
        assert_eq!(value("PATH"), Some("/usr/bin"));
        assert_eq!(value("SYSTEMROOT"), Some("C:\\Windows"));
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
            bundle_path: "C:\\bundle\\main.js".into(),
            manifest_hash: "hash".into(),
            runtime_digest: "digest".into(),
            staging_dir: "C:\\staging".into(),
        };
        let flags = config.permission_flags();
        // Read covers the whole bundle dir (entry + vendored imports), write only the staging dir.
        assert!(flags.contains(&"--allow-fs-read=C:\\bundle".to_string()));
        assert!(flags.contains(&"--allow-fs-write=C:\\staging".to_string()));
        // Real-path resolution is skipped so the AppContainer never lstat-s ungranted ancestor dirs.
        assert!(flags.contains(&"--preserve-symlinks".to_string()));
        assert!(flags.contains(&"--preserve-symlinks-main".to_string()));
    }

    /// Regression: a full uuid run_id once produced an 89-char profile name that
    /// CreateAppContainerProfile refused (ERROR_INVALID_PARAMETER, 64-char cap), so the sidecar never
    /// spawned and the write spine stalled silently. The name must stay within the cap AND be one the
    /// real API accepts.
    #[test]
    #[cfg(windows)]
    fn container_name_fits_the_appcontainer_cap_and_creates() {
        let run_id = uuid::Uuid::new_v4().to_string();
        let name = container_name(&run_id);
        assert!(name.chars().count() <= 64, "name too long: {name}");
        let container = super::super::appcontainer::AppContainer::create(&name)
            .expect("the per-Run profile name must be accepted by CreateAppContainerProfile");
        container.delete().expect("delete profile");
    }
}
