use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::journal::crypto::{self, CryptoError};

const SUPPORT_AAD: &[u8] = b"work-device-support-package-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UninstallMode {
    Preserve,
    Delete,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct JournalSummary {
    pub schema_version: i64,
    pub device_id_hash: String,
    pub journal_epoch_hash: String,
    pub action_count: i64,
    pub unknown_count: i64,
    pub unacked_receipt_count: i64,
    pub unacked_model_result_count: i64,
    pub pending_finish_count: i64,
    pub unfinished_run_count: i64,
    pub pending_content_count: i64,
}

impl JournalSummary {
    pub fn has_unresolved_facts(&self) -> bool {
        self.unknown_count > 0
            || self.unacked_receipt_count > 0
            || self.unacked_model_result_count > 0
            || self.pending_finish_count > 0
            || self.unfinished_run_count > 0
            || self.pending_content_count > 0
    }
}

#[derive(Debug)]
pub enum UninstallError {
    Io(String),
    Sql(rusqlite::Error),
    Crypto(CryptoError),
    Shape(String),
    Unresolved,
}

impl std::fmt::Display for UninstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(msg) => write!(f, "{msg}"),
            Self::Sql(err) => write!(f, "journal: {err}"),
            Self::Crypto(err) => write!(f, "support package: {err:?}"),
            Self::Shape(msg) => write!(f, "support package: {msg}"),
            Self::Unresolved => write!(
                f,
                "journal has unresolved facts; export a support package or pass --acknowledge-loss"
            ),
        }
    }
}

impl From<rusqlite::Error> for UninstallError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Sql(err)
    }
}

impl From<CryptoError> for UninstallError {
    fn from(err: CryptoError) -> Self {
        Self::Crypto(err)
    }
}

fn digest_hex(value: &str) -> String {
    hex(&Sha256::digest(value.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

pub fn inspect(path: &Path) -> Result<JournalSummary, UninstallError> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| UninstallError::Io(format!("open journal read-only: {err}")))?;
    let (schema_version, device_id, journal_epoch): (i64, String, String) = conn.query_row(
        "SELECT schema_version, device_id, journal_epoch FROM device_meta LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let action_count =
        conn.query_row("SELECT COUNT(*) FROM action_journal", [], |row| row.get(0))?;
    let unknown_count = conn.query_row(
        "SELECT COUNT(*) FROM action_journal WHERE state = 'unknown'",
        [],
        |row| row.get(0),
    )?;
    let unacked_receipt_count = conn.query_row(
        "SELECT COUNT(*) FROM receipt_outbox WHERE acked = 0",
        [],
        |row| row.get(0),
    )?;
    let unacked_model_result_count = conn.query_row(
        "SELECT COUNT(*) FROM model_result_outbox WHERE acked = 0 AND rejected = 0",
        [],
        |row| row.get(0),
    )?;
    let pending_finish_count = conn.query_row(
        "SELECT COUNT(*) FROM runtime_finish WHERE ack_state IS NULL",
        [],
        |row| row.get(0),
    )?;
    let unfinished_run_count = conn.query_row(
        "SELECT COUNT(*) FROM runtime_start WHERE state IS NULL OR state != 'finished'",
        [],
        |row| row.get(0),
    )?;
    let pending_content_count = conn.query_row(
        "SELECT COUNT(*) FROM local_content
         WHERE publish_state IN ('sealed', 'pending_confirm', 'pending_publish', 'expired')",
        [],
        |row| row.get(0),
    )?;
    Ok(JournalSummary {
        schema_version,
        device_id_hash: digest_hex(&device_id),
        journal_epoch_hash: digest_hex(&journal_epoch),
        action_count,
        unknown_count,
        unacked_receipt_count,
        unacked_model_result_count,
        pending_finish_count,
        unfinished_run_count,
        pending_content_count,
    })
}

pub fn read_support_key(path: &Path) -> Result<[u8; 32], UninstallError> {
    let bytes = fs::read(path)
        .map_err(|err| UninstallError::Io(format!("read support package key: {err}")))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| UninstallError::Shape("support key must be exactly 32 bytes".into()))
}

pub fn write_support_package(
    journal_path: &Path,
    key: &[u8; 32],
    output_path: &Path,
) -> Result<JournalSummary, UninstallError> {
    let summary = inspect(journal_path)?;
    let plaintext = serde_json::to_vec(&summary)
        .map_err(|err| UninstallError::Shape(format!("encode metadata: {err}")))?;
    let sealed = crypto::seal(key, SUPPORT_AAD, &plaintext)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(output_path)
        .map_err(|err| UninstallError::Io(format!("create support package: {err}")))?;
    file.write_all(&sealed)
        .map_err(|err| UninstallError::Io(format!("write support package: {err}")))?;
    file.sync_all()
        .map_err(|err| UninstallError::Io(format!("sync support package: {err}")))?;
    Ok(summary)
}

pub fn open_support_package(
    key: &[u8; 32],
    input_path: &Path,
) -> Result<JournalSummary, UninstallError> {
    let mut sealed = Vec::new();
    fs::File::open(input_path)
        .and_then(|mut file| file.read_to_end(&mut sealed))
        .map_err(|err| UninstallError::Io(format!("read support package: {err}")))?;
    let plaintext = crypto::open(key, SUPPORT_AAD, &sealed)?;
    serde_json::from_slice(&plaintext)
        .map_err(|err| UninstallError::Shape(format!("decode metadata: {err}")))
}

pub fn remove_journal(
    path: &Path,
    mode: UninstallMode,
    acknowledge_loss: bool,
) -> Result<JournalSummary, UninstallError> {
    let summary = inspect(path)?;
    if mode == UninstallMode::Preserve {
        return Ok(summary);
    }
    if summary.has_unresolved_facts() && !acknowledge_loss {
        return Err(UninstallError::Unresolved);
    }
    for candidate in [
        path.to_path_buf(),
        sidecar(path, "-wal"),
        sidecar(path, "-shm"),
        sidecar(path, ".lock"),
    ] {
        match fs::remove_file(&candidate) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(UninstallError::Io(format!(
                    "remove journal artefact {}: {err}",
                    candidate.display()
                )))
            }
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{self, dek::TestWrap};
    use rusqlite::params;

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "work-uninstall-{label}-{}.db",
            uuid::Uuid::new_v4()
        ))
    }

    fn journal(path: &Path) -> journal::Journal {
        journal::Journal::create(path, "device-1", &TestWrap).unwrap()
    }

    #[test]
    fn preserve_keeps_the_journal_and_reports_clean_metadata() {
        let path = temp_path("preserve");
        let _journal = journal(&path);
        let summary = remove_journal(&path, UninstallMode::Preserve, false).unwrap();
        assert!(!summary.has_unresolved_facts());
        assert!(path.exists());
        drop(_journal);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn delete_refuses_unknown_without_explicit_loss_acknowledgement() {
        let path = temp_path("unknown");
        let _journal = journal(&path);
        _journal
            .connection()
            .execute(
                "INSERT INTO action_journal(org_id, operation_id, run_id, state)
                 VALUES ('org', 'op', 'run', 'unknown')",
                [],
            )
            .unwrap();
        assert!(matches!(
            remove_journal(&path, UninstallMode::Delete, false),
            Err(UninstallError::Unresolved)
        ));
        assert!(path.exists());
        drop(_journal);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn support_package_is_encrypted_and_contains_only_metadata() {
        let path = temp_path("support");
        let _journal = journal(&path);
        _journal
            .connection()
            .execute(
                "INSERT INTO local_content(version_id, origin, publish_state, sealed_blob)
                 VALUES ('version-secret-name', 'device_write', 'sealed', X'00010203')",
                [],
            )
            .unwrap();
        let output = temp_path("support-output");
        let key = [9u8; 32];
        let summary = write_support_package(&path, &key, &output).unwrap();
        assert_eq!(summary.pending_content_count, 1);
        let sealed = fs::read(&output).unwrap();
        assert!(!sealed
            .windows(19)
            .any(|window| window == b"version-secret-name"));
        let decoded = open_support_package(&key, &output).unwrap();
        assert_eq!(decoded, summary);
        assert!(open_support_package(&[8u8; 32], &output).is_err());
        drop(_journal);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&output);
    }

    #[test]
    fn explicit_loss_allows_delete_and_removes_sidecars() {
        let path = temp_path("delete");
        let _journal = journal(&path);
        _journal
            .connection()
            .execute(
                "INSERT INTO action_journal(org_id, operation_id, run_id, state)
                 VALUES ('org', 'op', 'run', 'unknown')",
                params![],
            )
            .unwrap();
        drop(_journal);
        fs::write(sidecar(&path, "-wal"), b"wal").unwrap();
        fs::write(sidecar(&path, "-shm"), b"shm").unwrap();
        remove_journal(&path, UninstallMode::Delete, true).unwrap();
        assert!(!path.exists());
        assert!(!sidecar(&path, "-wal").exists());
        assert!(!sidecar(&path, "-shm").exists());
    }

    #[test]
    fn support_key_must_be_exactly_32_bytes() {
        let path = temp_path("key");
        fs::write(&path, b"short").unwrap();
        assert!(matches!(
            read_support_key(&path),
            Err(UninstallError::Shape(_))
        ));
        let _ = fs::remove_file(&path);
    }
}
