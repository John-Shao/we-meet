//! `device_meta`: the journal epoch and the atomic receipt-sequence allocator
//! (device-design §6.1). Receipt seqs are allocated only from `device_meta` and
//! never recomputed after cleanup; `journal_epoch` changes on loss/rebuild rather
//! than impersonating the original continuous sequence.

use rusqlite::{params, Connection};

/// Insert the single `device_meta` row for a new journal.
pub fn init(
    conn: &Connection,
    device_id: &str,
    journal_epoch: &str,
    schema_version: u32,
    wrapped_dek: &[u8],
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO device_meta (device_id, journal_epoch, next_receipt_seq, schema_version, wrapped_dek)
         VALUES (?1, ?2, 1, ?3, ?4)",
        params![device_id, journal_epoch, schema_version, wrapped_dek],
    )?;
    Ok(())
}

/// Atomically allocate the next receipt seq, returning the allocated value (the
/// pre-increment counter). The advance happens in the same statement, so two
/// callers never receive the same seq.
pub fn allocate_receipt_seq(conn: &Connection, device_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "UPDATE device_meta SET next_receipt_seq = next_receipt_seq + 1
         WHERE device_id = ?1 RETURNING next_receipt_seq - 1",
        params![device_id],
        |row| row.get(0),
    )
}

/// Read the current journal epoch.
pub fn journal_epoch(conn: &Connection, device_id: &str) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT journal_epoch FROM device_meta WHERE device_id = ?1",
        params![device_id],
        |row| row.get(0),
    )
}

/// Read the wrapped DEK blob.
pub fn wrapped_dek(conn: &Connection, device_id: &str) -> rusqlite::Result<Vec<u8>> {
    conn.query_row(
        "SELECT wrapped_dek FROM device_meta WHERE device_id = ?1",
        params![device_id],
        |row| row.get(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::schema;

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("work-journal-meta-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        schema::apply(&conn).unwrap();
        (conn, path)
    }

    #[test]
    fn allocates_monotonic_seqs_from_one() {
        let (conn, path) = temp_conn();
        init(&conn, "dev", "epoch-1", schema::SCHEMA_VERSION, &[0u8; 32]).unwrap();
        assert_eq!(allocate_receipt_seq(&conn, "dev").unwrap(), 1);
        assert_eq!(allocate_receipt_seq(&conn, "dev").unwrap(), 2);
        assert_eq!(allocate_receipt_seq(&conn, "dev").unwrap(), 3);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reads_epoch_and_wrapped_dek() {
        let (conn, path) = temp_conn();
        init(
            &conn,
            "dev",
            "epoch-xyz",
            schema::SCHEMA_VERSION,
            &[9u8; 32],
        )
        .unwrap();
        assert_eq!(journal_epoch(&conn, "dev").unwrap(), "epoch-xyz");
        assert_eq!(wrapped_dek(&conn, "dev").unwrap(), vec![9u8; 32]);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn seq_survives_reopen() {
        let path =
            std::env::temp_dir().join(format!("work-journal-meta-{}.db", uuid::Uuid::new_v4()));
        {
            let conn = Connection::open(&path).unwrap();
            schema::apply(&conn).unwrap();
            init(&conn, "dev", "epoch-1", schema::SCHEMA_VERSION, &[0u8; 32]).unwrap();
            allocate_receipt_seq(&conn, "dev").unwrap();
            allocate_receipt_seq(&conn, "dev").unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            // Reopen must continue from 3, never reset to 1.
            assert_eq!(allocate_receipt_seq(&conn, "dev").unwrap(), 3);
        }
        let _ = std::fs::remove_file(&path);
    }
}
