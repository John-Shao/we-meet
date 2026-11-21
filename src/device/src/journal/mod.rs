//! The encrypted journal engine (device-design §6.1). Owns the SQLite connection,
//! the unwrapped DEK and the owner lock. `create` generates a fresh DEK and
//! journal epoch; `open` recovers them from `device_meta`. A second concurrent
//! Agent is rejected by the owner lock; `open` never auto-creates an empty
//! journal — a missing or unreadable ledger fails closed so the scene is
//! preserved for manual recovery (§6.1, §6.3).
//!
//! Scope (batch 2): the storage engine foundation. The receipt JCS signing domain
//! and the checkpoint/start/finish/content domain write paths land with their
//! protocol batches; their tables already exist in the schema.

pub mod crypto;
pub mod dek;
pub mod local_content;
pub mod meta;
pub mod record;
pub mod recover;
pub mod schema;

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use dek::KeyWrap;

/// An open journal: connection, DEK, identity and the held owner lock.
pub struct Journal {
    conn: Connection,
    dek: [u8; 32],
    device_id: String,
    journal_epoch: String,
    // Held for its Drop side effect (releases the owner lock); never read directly.
    #[allow(dead_code)]
    lock: OwnerLock,
}

/// A journal open/create failure.
#[derive(Debug)]
pub enum JournalError {
    Sql(rusqlite::Error),
    Wrap(dek::WrapError),
    /// Another Agent holds the owner lock.
    Locked,
    /// The journal does not exist or is unreadable; never auto-rebuilt empty.
    NotFound,
}

impl From<rusqlite::Error> for JournalError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Sql(err)
    }
}

impl From<dek::WrapError> for JournalError {
    fn from(err: dek::WrapError) -> Self {
        Self::Wrap(err)
    }
}

fn lock_path(db_path: &Path) -> PathBuf {
    let mut name = db_path.as_os_str().to_os_string();
    name.push(".lock");
    PathBuf::from(name)
}

/// The journal owner lock (F6 甲, 2026-11-19). Its purpose is to reject a second CONCURRENT
/// Agent, not to forbid a restart after the owner dies. On Windows it is an OS advisory lock
/// (LockFileEx) held on an open handle: the OS releases it when the process exits (clean or
/// killed), so a kill-only Broker restart re-acquires it, while a live concurrent Agent is still
/// refused. Preserve-the-scene is independent of this lock: `open` fails closed on an unreadable
/// ledger and never rebuilds it empty. On non-Windows (CI build + unit tests only) the persistent
/// create_new file lock is retained; there is no kill-restart path there.
struct OwnerLock {
    #[cfg(windows)]
    handle: windows::Win32::Foundation::HANDLE,
    #[cfg(not(windows))]
    path: PathBuf,
}

impl Drop for OwnerLock {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            // Closing the handle releases the LockFileEx byte-range lock.
            let _ = windows::Win32::Foundation::CloseHandle(self.handle);
        }
        #[cfg(not(windows))]
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn acquire_lock(lock_path: &Path) -> Result<OwnerLock, JournalError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
        use windows::Win32::Storage::FileSystem::{
            CreateFileW, LockFileEx, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE,
            LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, OPEN_ALWAYS,
        };
        use windows::Win32::System::IO::OVERLAPPED;
        let wide: Vec<u16> = lock_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                (GENERIC_READ | GENERIC_WRITE).0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .map_err(|_| JournalError::Locked)?;
        if handle == INVALID_HANDLE_VALUE {
            return Err(JournalError::Locked);
        }
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        let locked = unsafe {
            LockFileEx(
                handle,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        };
        if locked.is_err() {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(handle);
            }
            return Err(JournalError::Locked);
        }
        Ok(OwnerLock { handle })
    }
    #[cfg(not(windows))]
    {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(lock_path)
            .map_err(|_| JournalError::Locked)?;
        Ok(OwnerLock {
            path: lock_path.to_path_buf(),
        })
    }
}

impl Journal {
    /// Create a new journal: schema, fresh DEK (wrapped) and journal epoch.
    pub fn create(
        db_path: &Path,
        device_id: &str,
        wrap: &dyn KeyWrap,
    ) -> Result<Journal, JournalError> {
        let lock = acquire_lock(&lock_path(db_path))?;
        Self::create_inner(db_path, device_id, wrap, lock)
    }

    fn create_inner(
        db_path: &Path,
        device_id: &str,
        wrap: &dyn KeyWrap,
        lock: OwnerLock,
    ) -> Result<Journal, JournalError> {
        let conn = Connection::open(db_path)?;
        schema::apply(&conn)?;
        let dek = dek::generate_dek();
        let wrapped = wrap.wrap(&dek)?;
        let journal_epoch = uuid::Uuid::new_v4().to_string();
        meta::init(
            &conn,
            device_id,
            &journal_epoch,
            schema::SCHEMA_VERSION,
            &wrapped,
        )?;
        Ok(Journal {
            conn,
            dek,
            device_id: device_id.to_string(),
            journal_epoch,
            lock,
        })
    }

    /// Open an existing journal, recovering the DEK and epoch. Fails closed if
    /// the ledger is missing/unreadable; never creates an empty journal.
    pub fn open(
        db_path: &Path,
        device_id: &str,
        wrap: &dyn KeyWrap,
    ) -> Result<Journal, JournalError> {
        let lock = acquire_lock(&lock_path(db_path))?;
        Self::open_inner(db_path, device_id, wrap, lock)
    }

    fn open_inner(
        db_path: &Path,
        device_id: &str,
        wrap: &dyn KeyWrap,
        lock: OwnerLock,
    ) -> Result<Journal, JournalError> {
        let conn = Connection::open(db_path)?;
        // Idempotent schema/migration pass on open too, so a journal created before
        // a plain-column extension (batch 5 local_content) gains the new columns.
        schema::apply(&conn)?;
        let wrapped = meta::wrapped_dek(&conn, device_id).map_err(|_| JournalError::NotFound)?;
        let dek = wrap.unwrap(&wrapped)?;
        let journal_epoch = meta::journal_epoch(&conn, device_id)?;
        Ok(Journal {
            conn,
            dek,
            device_id: device_id.to_string(),
            journal_epoch,
            lock,
        })
    }

    /// The SQLite connection (for the record/meta write paths).
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// The unwrapped DEK (in memory only; never logged or persisted in the clear).
    pub fn dek(&self) -> &[u8; 32] {
        &self.dek
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn journal_epoch(&self) -> &str {
        &self.journal_epoch
    }

    /// Build a record context binding the caller's org/subject to this journal.
    pub fn context<'a>(&'a self, org: &'a str, subject: &'a str) -> record::RecordContext<'a> {
        record::RecordContext {
            org,
            subject,
            device: &self.device_id,
            journal_epoch: &self.journal_epoch,
            schema_version: schema::SCHEMA_VERSION,
        }
    }
}

impl Drop for Journal {
    fn drop(&mut self) {
        // The OwnerLock field drops after this body, releasing the OS advisory lock (Windows) or
        // removing the lock file (non-Windows). A killed process releases the Windows lock by OS
        // handle close, so a restart re-acquires it (F6 甲); the ledger itself is never rebuilt.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path() -> PathBuf {
        std::env::temp_dir().join(format!("work-journal-engine-{}.db", uuid::Uuid::new_v4()))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(lock_path(path));
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn create_then_open_recovers_dek_and_epoch() {
        let path = temp_path();
        let (dek, epoch) = {
            let journal = Journal::create(&path, "dev", &dek::TestWrap).unwrap();
            (*journal.dek(), journal.journal_epoch().to_string())
        };
        {
            let journal = Journal::open(&path, "dev", &dek::TestWrap).unwrap();
            assert_eq!(journal.dek(), &dek);
            assert_eq!(journal.journal_epoch(), epoch);
            // Receipt seq continues across reopen (never reset).
            let seq = meta::allocate_receipt_seq(journal.connection(), "dev").unwrap();
            assert_eq!(seq, 1);
        }
        cleanup(&path);
    }

    #[test]
    fn second_concurrent_agent_is_locked_out() {
        let path = temp_path();
        let _first = Journal::create(&path, "dev", &dek::TestWrap).unwrap();
        let second = Journal::open(&path, "dev", &dek::TestWrap);
        assert!(matches!(second, Err(JournalError::Locked)));
        drop(_first);
        cleanup(&path);
    }

    #[test]
    fn open_missing_journal_fails_closed() {
        let path = temp_path();
        // An empty database file with no device_meta row.
        {
            let _conn = Connection::open(&path).unwrap();
        }
        let result = Journal::open(&path, "dev", &dek::TestWrap);
        assert!(matches!(result, Err(JournalError::NotFound)));
        // The failed open must RELEASE the owner lock (F6 甲): a retry fails NotFound again, never
        // Locked. On Windows the lock file persists but the OS lock is released; on non-Windows the
        // file is removed — either way the next open is not blocked by a stale lock.
        let retry = Journal::open(&path, "dev", &dek::TestWrap);
        assert!(matches!(retry, Err(JournalError::NotFound)));
        cleanup(&path);
    }

    #[test]
    fn journal_database_uses_wal() {
        let path = temp_path();
        let journal = Journal::create(&path, "dev", &dek::TestWrap).unwrap();
        let mode: String = journal
            .connection()
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        drop(journal);
        cleanup(&path);
    }

    #[test]
    fn end_to_end_encrypted_action_through_engine() {
        let path = temp_path();
        let journal = Journal::create(&path, "dev", &dek::TestWrap).unwrap();
        let ctx = journal.context("org", "sub");
        let row = record::ActionRow {
            org_id: "org",
            operation_id: "op1",
            run_id: "run",
            attempt: "attempt-1",
            step_key: "step",
            logical_key: "step#0",
            supersedes: None,
            request_hash: "hash",
            fence: 1,
            session_id: "sess",
            generation: 1,
            permit_jti: "jti-1",
            state: "started",
            result_hash: None,
            result_ref: None,
        };
        record::append_action(
            journal.connection(),
            journal.dek(),
            &ctx,
            &row,
            b"action body",
        )
        .unwrap();
        let opened =
            record::read_action(journal.connection(), journal.dek(), &ctx, "org", "op1").unwrap();
        assert_eq!(opened, b"action body");
        drop(journal);
        cleanup(&path);
    }
}
