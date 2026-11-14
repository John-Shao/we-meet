//! Encrypted record append/read plus the `action_journal` and `receipt_outbox`
//! write paths (device-design §6.1). Record bodies are sealed with the DEK under
//! an identity-bound AAD, so no plaintext action reaches disk or the WAL. Receipt
//! seqs come from the atomic `device_meta` allocator; the signed bytes are
//! supplied by the caller (the receipt JCS signing domain lands with the protocol
//! batch).

use rusqlite::{params, Connection};

use crate::journal::{crypto, meta};

/// The identity bound into every record's AAD.
pub struct RecordContext<'a> {
    pub org: &'a str,
    pub subject: &'a str,
    pub device: &'a str,
    pub journal_epoch: &'a str,
    pub schema_version: u32,
}

impl RecordContext<'_> {
    fn aad(&self, record_type: &str, record_id: &str) -> String {
        crypto::aad(
            self.org,
            self.subject,
            self.device,
            self.journal_epoch,
            record_type,
            record_id,
            self.schema_version,
        )
    }
}

/// A record-layer failure.
#[derive(Debug)]
pub enum RecordError {
    Crypto(crypto::CryptoError),
    Sql(rusqlite::Error),
}

impl From<crypto::CryptoError> for RecordError {
    fn from(err: crypto::CryptoError) -> Self {
        Self::Crypto(err)
    }
}

impl From<rusqlite::Error> for RecordError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Sql(err)
    }
}

/// Seal a record body under the DEK with its identity-bound AAD.
pub fn seal_record(
    dek: &[u8; 32],
    ctx: &RecordContext,
    record_type: &str,
    record_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, crypto::CryptoError> {
    crypto::seal(dek, ctx.aad(record_type, record_id).as_bytes(), plaintext)
}

/// Open a sealed record body.
pub fn open_record(
    dek: &[u8; 32],
    ctx: &RecordContext,
    record_type: &str,
    record_id: &str,
    sealed: &[u8],
) -> Result<Vec<u8>, crypto::CryptoError> {
    crypto::open(dek, ctx.aad(record_type, record_id).as_bytes(), sealed)
}

/// An `action_journal` row. `encrypted_action` is sealed from `action_plaintext`.
pub struct ActionRow<'a> {
    pub org_id: &'a str,
    pub operation_id: &'a str,
    pub run_id: &'a str,
    pub attempt: i64,
    pub step_key: &'a str,
    pub logical_key: &'a str,
    pub supersedes: Option<&'a str>,
    pub request_hash: &'a str,
    pub fence: i64,
    pub session_id: &'a str,
    pub generation: i64,
    pub permit_jti: &'a str,
    pub state: &'a str,
    pub result_hash: Option<&'a str>,
    pub result_ref: Option<&'a str>,
}

/// Append an action, sealing its body. `permit_jti` is UNIQUE (single-use permit).
pub fn append_action(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    row: &ActionRow,
    action_plaintext: &[u8],
) -> Result<(), RecordError> {
    let sealed = seal_record(dek, ctx, "action", row.operation_id, action_plaintext)?;
    conn.execute(
        "INSERT INTO action_journal
            (org_id, operation_id, run_id, attempt, step_key, logical_key, supersedes,
             request_hash, fence, session_id, generation, permit_jti, state,
             encrypted_action, result_hash, result_ref)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            row.org_id,
            row.operation_id,
            row.run_id,
            row.attempt,
            row.step_key,
            row.logical_key,
            row.supersedes,
            row.request_hash,
            row.fence,
            row.session_id,
            row.generation,
            row.permit_jti,
            row.state,
            sealed,
            row.result_hash,
            row.result_ref,
        ],
    )?;
    Ok(())
}

/// Read and open an action's sealed body.
pub fn read_action(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    org_id: &str,
    operation_id: &str,
) -> Result<Vec<u8>, RecordError> {
    let sealed: Vec<u8> = conn.query_row(
        "SELECT encrypted_action FROM action_journal WHERE org_id = ?1 AND operation_id = ?2",
        params![org_id, operation_id],
        |row| row.get(0),
    )?;
    Ok(open_record(dek, ctx, "action", operation_id, &sealed)?)
}

/// A `receipt_outbox` row. The signed bytes are produced by the caller.
pub struct ReceiptRow<'a> {
    pub operation_id: &'a str,
    pub state: &'a str,
    pub signed_bytes: &'a [u8],
    pub signed_hash: &'a str,
}

/// Append a receipt, atomically allocating its seq. Returns the allocated seq.
pub fn append_receipt(
    conn: &Connection,
    device_id: &str,
    journal_epoch: &str,
    row: &ReceiptRow,
) -> Result<i64, RecordError> {
    let seq = meta::allocate_receipt_seq(conn, device_id)?;
    conn.execute(
        "INSERT INTO receipt_outbox
            (journal_epoch, receipt_seq, operation_id, state, signed_bytes, signed_hash, acked)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        params![
            journal_epoch,
            seq,
            row.operation_id,
            row.state,
            row.signed_bytes,
            row.signed_hash,
        ],
    )?;
    Ok(seq)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::schema;

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("work-journal-record-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        schema::apply(&conn).unwrap();
        meta::init(&conn, "dev", "epoch-1", schema::SCHEMA_VERSION, &[0u8; 32]).unwrap();
        (conn, path)
    }

    fn ctx() -> RecordContext<'static> {
        RecordContext {
            org: "org",
            subject: "sub",
            device: "dev",
            journal_epoch: "epoch-1",
            schema_version: schema::SCHEMA_VERSION,
        }
    }

    fn action<'a>(operation_id: &'a str, permit_jti: &'a str) -> ActionRow<'a> {
        ActionRow {
            org_id: "org",
            operation_id,
            run_id: "run",
            attempt: 1,
            step_key: "step",
            logical_key: "step#0",
            supersedes: None,
            request_hash: "hash",
            fence: 1,
            session_id: "sess",
            generation: 1,
            permit_jti,
            state: "started",
            result_hash: None,
            result_ref: None,
        }
    }

    #[test]
    fn record_round_trips_and_binds_record_id() {
        let dek = [3u8; 32];
        let c = ctx();
        let sealed = seal_record(&dek, &c, "action", "op1", b"body").unwrap();
        assert_eq!(
            open_record(&dek, &c, "action", "op1", &sealed).unwrap(),
            b"body"
        );
        assert!(open_record(&dek, &c, "action", "op2", &sealed).is_err());
    }

    #[test]
    fn action_body_is_encrypted_at_rest() {
        let (conn, path) = temp_conn();
        let dek = [3u8; 32];
        let c = ctx();
        let plaintext = b"canonical action body with sensitive params";
        append_action(&conn, &dek, &c, &action("op1", "jti-1"), plaintext).unwrap();
        // The stored blob is not the plaintext.
        let stored: Vec<u8> = conn
            .query_row(
                "SELECT encrypted_action FROM action_journal WHERE operation_id='op1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(stored.as_slice(), plaintext.as_slice());
        assert_eq!(
            read_action(&conn, &dek, &c, "org", "op1").unwrap(),
            plaintext
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn permit_jti_is_single_use() {
        let (conn, path) = temp_conn();
        let dek = [3u8; 32];
        let c = ctx();
        append_action(&conn, &dek, &c, &action("op1", "jti-dup"), b"a").unwrap();
        let err = append_action(&conn, &dek, &c, &action("op2", "jti-dup"), b"b");
        assert!(matches!(err, Err(RecordError::Sql(_))));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn receipts_allocate_contiguous_seqs() {
        let (conn, path) = temp_conn();
        let r1 = ReceiptRow {
            operation_id: "op1",
            state: "started",
            signed_bytes: b"signed-1",
            signed_hash: "h1",
        };
        let r2 = ReceiptRow {
            operation_id: "op1",
            state: "completed",
            signed_bytes: b"signed-2",
            signed_hash: "h2",
        };
        assert_eq!(append_receipt(&conn, "dev", "epoch-1", &r1).unwrap(), 1);
        assert_eq!(append_receipt(&conn, "dev", "epoch-1", &r2).unwrap(), 2);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM receipt_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
