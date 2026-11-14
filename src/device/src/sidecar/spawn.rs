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
