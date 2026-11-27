//! SQLite schema and durability pragmas (device-design §6.1). WAL +
//! synchronous=FULL; the seven journal tables. Schema creation is idempotent.
//! A corrupt or unreadable database is never auto-rebuilt empty (§6.1): the
//! caller stops and preserves the scene.

use rusqlite::Connection;

/// The journal schema version bound into every record's AAD.
pub const SCHEMA_VERSION: u32 = 2;

/// Apply durability pragmas and create the journal tables. `journal_mode=WAL`
/// only takes effect on a file database (an in-memory database reports `memory`).
pub fn apply(conn: &Connection) -> rusqlite::Result<()> {
    let _mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.execute_batch(SCHEMA)?;
    // Batch 5: the local_content carrier gained plain columns after the table was
    // first created. Add any missing ones idempotently (SQLite has no ADD COLUMN
    // IF NOT EXISTS); the table is plain (no AAD), so SCHEMA_VERSION stays 2.
    ensure_columns(
        conn,
        "local_content",
        &[
            ("run_id", "TEXT"),
            ("operation_id", "TEXT"),
            ("logical_name", "TEXT"),
            ("format", "TEXT"),
            ("byte_count", "INTEGER"),
            ("receipt_seq", "INTEGER"),
            ("artifact_id", "TEXT"),
            ("task_id", "TEXT"),
            ("base_version_no", "INTEGER"),
            ("base_hash", "TEXT"),
            ("request_id", "TEXT"),
            ("created_at", "INTEGER"),
            ("auth_epoch", "INTEGER"),
            ("base_version_id", "TEXT"),
            ("base_byte_count", "INTEGER"),
            ("approval_id", "TEXT"),
            ("publish_ack", "TEXT"),
        ],
    )?;
    conn.execute_batch(
        "DROP INDEX IF EXISTS local_content_pending_edit_once;
         CREATE UNIQUE INDEX local_content_pending_edit_once
         ON local_content(artifact_id, base_version_no)
         WHERE origin = 'user_edit' AND publish_state IN ('pending_confirm', 'pending_publish');
         CREATE UNIQUE INDEX IF NOT EXISTS local_content_edit_request_once
         ON local_content(request_id)
         WHERE origin = 'user_edit';
         CREATE UNIQUE INDEX IF NOT EXISTS local_content_approval_once
         ON local_content(approval_id)
         WHERE origin = 'approval';
         CREATE UNIQUE INDEX IF NOT EXISTS local_content_transcript_once
         ON local_content(run_id)
         WHERE origin = 'run_transcript'",
    )?;
    // Batch 5: runtime_start carries the binding's fence/lease_id so a restart can rebuild the
    // finish judgment that re-publishes sealed deliverables (plain columns, SCHEMA_VERSION stays 2).
    ensure_columns(
        conn,
        "runtime_start",
        &[("fence", "INTEGER"), ("lease_id", "TEXT")],
    )?;
    // Batch 6: which checkpoint the server acked as `recorded` is itself a durable fact — the finish
    // has to reference it (0059 gate) and a restart used to lose it, which left the recovered Run
    // stuck below its own recorded checkpoint. Plain column, so SCHEMA_VERSION stays 2.
    ensure_columns(
        conn,
        "checkpoint",
        &[("acked", "INTEGER NOT NULL DEFAULT 0")],
    )?;
    ensure_columns(
        conn,
        "model_result_outbox",
        &[("rejected", "INTEGER NOT NULL DEFAULT 0")],
    )?;
    Ok(())
}

/// Add columns absent from `table` (idempotent ALTER). `cols` is (name, decl).
fn ensure_columns(conn: &Connection, table: &str, cols: &[(&str, &str)]) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let existing: std::collections::HashSet<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    for (name, decl) in cols {
        if !existing.contains(*name) {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {decl};"))?;
        }
    }
    Ok(())
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS device_meta (
    device_id        TEXT PRIMARY KEY,
    journal_epoch    TEXT NOT NULL,
    next_receipt_seq INTEGER NOT NULL DEFAULT 1,
    acked_release    TEXT,
    schema_version   INTEGER NOT NULL,
    runtime_version  TEXT,
    wrapped_dek      BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS action_journal (
    org_id           TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    run_id           TEXT,
    attempt          TEXT,
    step_key         TEXT,
    logical_key      TEXT,
    supersedes       TEXT,
    request_hash     TEXT,
    fence            INTEGER,
    session_id       TEXT,
    generation       INTEGER,
    permit_jti       TEXT UNIQUE,
    state            TEXT NOT NULL,
    encrypted_action BLOB,
    result_hash      TEXT,
    result_ref       TEXT,
    resolution_revision INTEGER,
    PRIMARY KEY (org_id, operation_id)
);

CREATE TABLE IF NOT EXISTS receipt_outbox (
    journal_epoch   TEXT NOT NULL,
    receipt_seq     INTEGER NOT NULL,
    operation_id    TEXT,
    state           TEXT,
    signed_bytes    BLOB,
    signed_hash     TEXT,
    acked           INTEGER NOT NULL DEFAULT 0,
    durable_release TEXT,
    PRIMARY KEY (journal_epoch, receipt_seq)
);

CREATE TABLE IF NOT EXISTS model_result_outbox (
    model_result_id TEXT PRIMARY KEY,
    journal_epoch    TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    state            TEXT NOT NULL,
    signed_bytes     BLOB NOT NULL,
    signed_hash      TEXT NOT NULL,
    acked            INTEGER NOT NULL DEFAULT 0,
    rejected         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS model_result_outbox_unacked
    ON model_result_outbox(journal_epoch, acked, rejected);

CREATE TABLE IF NOT EXISTS model_probe_result (
    model_result_id TEXT PRIMARY KEY,
    journal_epoch    TEXT NOT NULL,
    org_id           TEXT NOT NULL,
    subject_id       TEXT NOT NULL,
    device_id        TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    binding_id       TEXT NOT NULL,
    probe_id         TEXT NOT NULL,
    preview_hash     TEXT NOT NULL,
    signed_receipt   BLOB,
    receipt_signature TEXT,
    receipt_auth_epoch TEXT,
    receipt_expires_at TEXT,
    receipt_delivered INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS model_probe_result_session
    ON model_probe_result(journal_epoch, session_id, model_result_id);

CREATE TABLE IF NOT EXISTS checkpoint (
    run_id                   TEXT NOT NULL,
    checkpoint_seq           INTEGER NOT NULL,
    schema_version           INTEGER,
    runtime_digest           TEXT,
    ciphertext               BLOB,
    checkpoint_hash          TEXT,
    pending_operation_set_hash TEXT,
    prior_receipt_ref        TEXT,
    acked                    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, checkpoint_seq)
);

CREATE TABLE IF NOT EXISTS runtime_start (
    run_id                 TEXT NOT NULL,
    binding_revision       INTEGER NOT NULL,
    binding_hash           TEXT,
    start_nonce            TEXT UNIQUE,
    state                  TEXT,
    expected_checkpoint_ref  TEXT,
    expected_checkpoint_hash TEXT,
    fence                  INTEGER,
    lease_id               TEXT,
    PRIMARY KEY (run_id, binding_revision)
);

CREATE TABLE IF NOT EXISTS runtime_finish (
    run_id                TEXT NOT NULL,
    finish_id             TEXT NOT NULL,
    outcome               TEXT,
    reason                TEXT,
    final_checkpoint_seq  INTEGER,
    final_checkpoint_hash TEXT,
    signed_bytes          BLOB,
    signed_hash           TEXT,
    ack_state             TEXT,
    terminal_run_revision INTEGER,
    PRIMARY KEY (run_id, finish_id)
);

CREATE TABLE IF NOT EXISTS local_content (
    version_id                 TEXT PRIMARY KEY,
    origin                     TEXT,
    publish_state              TEXT,
    base_version               INTEGER,
    request_id                 TEXT,
    sealed_hash                TEXT,
    proof_bytes                BLOB,
    sealed_blob_hash           TEXT,
    sealed_blob                BLOB,
    output_identity            TEXT,
    copy_state                 TEXT,
    grant_ref                  TEXT,
    classification             TEXT,
    clipboard_derived          INTEGER,
    clipboard_source_version_ids TEXT,
    sync_state                 TEXT,
    run_id                     TEXT,
    operation_id               TEXT,
    logical_name               TEXT,
    format                     TEXT,
    byte_count                 INTEGER,
    receipt_seq                INTEGER
);
";

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (Connection, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("work-journal-schema-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        (conn, path)
    }

    #[test]
    fn file_database_uses_wal_and_full() {
        let (conn, path) = temp_db();
        apply(&conn).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let sync: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sync, 2); // FULL
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn creates_all_seven_tables() {
        let (conn, path) = temp_db();
        apply(&conn).unwrap();
        let mut names: Vec<String> = Vec::new();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        for row in rows {
            names.push(row.unwrap());
        }
        for expected in [
            "action_journal",
            "checkpoint",
            "device_meta",
            "local_content",
            "receipt_outbox",
            "runtime_finish",
            "runtime_start",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
        drop(stmt);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn apply_is_idempotent() {
        let (conn, path) = temp_db();
        apply(&conn).unwrap();
        apply(&conn).unwrap();
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
