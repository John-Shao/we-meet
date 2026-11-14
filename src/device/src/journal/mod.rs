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
pub mod meta;
pub mod record;
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
    lock_path: PathBuf,
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

fn acquire_lock(lock_path: &Path) -> Result<(), JournalError> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)
        .map_err(|_| JournalError::Locked)?;
    Ok(())
}

impl Journal {
    /// Create a new journal: schema, fresh DEK (wrapped) and journal epoch.
    pub fn create(
        db_path: &Path,
        device_id: &str,
        wrap: &dyn KeyWrap,
    ) -> Result<Journal, JournalError> {
        let lock = lock_path(db_path);
        acquire_lock(&lock)?;
        match Self::create_inner(db_path, device_id, wrap, lock.clone()) {
            Ok(journal) => Ok(journal),
            Err(err) => {
                let _ = std::fs::remove_file(&lock);
                Err(err)
            }
        }
    }

    fn create_inner(
        db_path: &Path,
        device_id: &str,
        wrap: &dyn KeyWrap,
        lock: PathBuf,
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
            lock_path: lock,
        })
    }

    /// Open an existing journal, recovering the DEK and epoch. Fails closed if
    /// the ledger is missing/unreadable; never creates an empty journal.
    pub fn open(
        db_path: &Path,
        device_id: &str,
        wrap: &dyn KeyWrap,
    ) -> Result<Journal, JournalError> {
        let lock = lock_path(db_path);
        acquire_lock(&lock)?;
        match Self::open_inner(db_path, device_id, wrap, lock.clone()) {
            Ok(journal) => Ok(journal),
            Err(err) => {
                let _ = std::fs::remove_file(&lock);
                Err(err)
            }
        }
    }

    fn open_inner(
        db_path: &Path,
        device_id: &str,
        wrap: &dyn KeyWrap,
        lock: PathBuf,
    ) -> Result<Journal, JournalError> {
        let conn = Connection::open(db_path)?;
        let wrapped = meta::wrapped_dek(&conn, device_id).map_err(|_| JournalError::NotFound)?;
        let dek = wrap.unwrap(&wrapped)?;
        let journal_epoch = meta::journal_epoch(&conn, device_id)?;
        Ok(Journal {
            conn,
            dek,
            device_id: device_id.to_string(),
            journal_epoch,
            lock_path: lock,
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
        // Release the owner lock on clean shutdown. A crash leaves the lock in
        // place, requiring manual recovery — aligned with preserve-the-scene.
        let _ = std::fs::remove_file(&self.lock_path);
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
        // The failed open must not leave a stale lock behind.
        assert!(!lock_path(&path).exists());
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
            attempt: 1,
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
