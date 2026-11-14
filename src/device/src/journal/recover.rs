//! Recovery/reconcile journal domain paths (device-design §6.3, B03 carrier §3.2).
//! Batch 2 created the seven tables and the action/receipt append paths; this
//! module adds the read/cleanup paths the recovery and reconcile batches need:
//! receipt-outbox replay and watermark cleanup, `runtime_finish` persistence and
//! replay, `runtime_start` resume bindings, encrypted `checkpoint` persistence,
//! and monotonic `operation_resolution` application. Cleanup is always driven by
//! a server-signed fact supplied by the caller, never by local inference; receipt
//! seqs are never recomputed and an unknown/gap is never crossed (§6.1, §6.4).

use rusqlite::{params, Connection, OptionalExtension};

use crate::journal::record::{self, RecordContext, RecordError};

/// An un-acked outbox receipt, replayed with its original signed bytes unchanged.
#[derive(Clone, Debug)]
pub struct OutboxReceipt {
    pub receipt_seq: i64,
    pub operation_id: String,
    pub state: String,
    pub signed_bytes: Vec<u8>,
    pub signed_hash: String,
}

/// Read up to `limit` un-acked receipts in seq order (replay oldest first).
pub fn unacked_receipts(
    conn: &Connection,
    journal_epoch: &str,
    limit: u32,
) -> rusqlite::Result<Vec<OutboxReceipt>> {
    let mut stmt = conn.prepare(
        "SELECT receipt_seq, operation_id, state, signed_bytes, signed_hash
         FROM receipt_outbox
         WHERE journal_epoch = ?1 AND acked = 0
         ORDER BY receipt_seq ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![journal_epoch, limit], |r| {
        Ok(OutboxReceipt {
            receipt_seq: r.get(0)?,
            operation_id: r.get(1)?,
            state: r.get(2)?,
            signed_bytes: r.get(3)?,
            signed_hash: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// Mark a receipt acknowledged (server recorded it).
pub fn mark_receipt_acked(
    conn: &Connection,
    journal_epoch: &str,
    receipt_seq: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE receipt_outbox SET acked = 1 WHERE journal_epoch = ?1 AND receipt_seq = ?2",
        params![journal_epoch, receipt_seq],
    )?;
    Ok(())
}

/// Release the contiguous prefix of acknowledged receipts at or below `watermark`.
/// Stops at the first un-acked receipt, an `unknown` receipt, or a missing seq —
/// never crosses an unknown or gap (§6.4). Returns the number released.
pub fn cleanup_receipts_through(
    conn: &Connection,
    journal_epoch: &str,
    watermark: i64,
) -> rusqlite::Result<u64> {
    let mut stmt = conn.prepare(
        "SELECT receipt_seq, acked, state FROM receipt_outbox
         WHERE journal_epoch = ?1 AND receipt_seq <= ?2 ORDER BY receipt_seq ASC",
    )?;
    let rows = stmt.query_map(params![journal_epoch, watermark], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut release: Vec<i64> = Vec::new();
    let mut expected: Option<i64> = None;
    for row in rows {
        let (seq, acked, state) = row?;
        if acked != 1 || state == "unknown" {
            break;
        }
        if let Some(exp) = expected {
            if seq != exp {
                break;
            }
        }
        release.push(seq);
        expected = Some(seq + 1);
    }
    let mut released = 0u64;
    for seq in release {
        conn.execute(
            "DELETE FROM receipt_outbox WHERE journal_epoch = ?1 AND receipt_seq = ?2",
            params![journal_epoch, seq],
        )?;
        released += 1;
    }
    Ok(released)
}

/// A `runtime_finish` row (the durable finish proposal; batch 6's in-memory
/// tracker projects onto this).
#[derive(Clone, Debug)]
pub struct FinishRow {
    pub run_id: String,
    pub finish_id: String,
    pub outcome: String,
    pub reason: Option<String>,
    pub final_checkpoint_seq: Option<i64>,
    pub final_checkpoint_hash: Option<String>,
    pub signed_bytes: Vec<u8>,
    pub signed_hash: String,
    pub ack_state: Option<String>,
    pub terminal_run_revision: Option<i64>,
}

/// Persist a finish proposal. Idempotent by `(run_id, finish_id)`: a re-send keeps
/// the original row (same signed bytes, no re-judgment, §3.4 step 3).
pub fn persist_finish(conn: &Connection, row: &FinishRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO runtime_finish
            (run_id, finish_id, outcome, reason, final_checkpoint_seq, final_checkpoint_hash,
             signed_bytes, signed_hash, ack_state, terminal_run_revision)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            row.run_id,
            row.finish_id,
            row.outcome,
            row.reason,
            row.final_checkpoint_seq,
            row.final_checkpoint_hash,
            row.signed_bytes,
            row.signed_hash,
            row.ack_state,
            row.terminal_run_revision,
        ],
    )?;
    Ok(())
}

/// Read a finish proposal.
pub fn read_finish(
    conn: &Connection,
    run_id: &str,
    finish_id: &str,
) -> rusqlite::Result<Option<FinishRow>> {
    conn.query_row(
        "SELECT run_id, finish_id, outcome, reason, final_checkpoint_seq, final_checkpoint_hash,
                signed_bytes, signed_hash, ack_state, terminal_run_revision
         FROM runtime_finish WHERE run_id = ?1 AND finish_id = ?2",
        params![run_id, finish_id],
        |r| {
            Ok(FinishRow {
                run_id: r.get(0)?,
                finish_id: r.get(1)?,
                outcome: r.get(2)?,
                reason: r.get(3)?,
                final_checkpoint_seq: r.get(4)?,
                final_checkpoint_hash: r.get(5)?,
                signed_bytes: r.get(6)?,
                signed_hash: r.get(7)?,
                ack_state: r.get(8)?,
                terminal_run_revision: r.get(9)?,
            })
        },
    )
    .optional()
}

/// Record the server's finish ack (`accepted`/`rejected`) and terminal revision.
pub fn set_finish_ack(
    conn: &Connection,
    run_id: &str,
    finish_id: &str,
    ack_state: &str,
    terminal_run_revision: Option<i64>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE runtime_finish SET ack_state = ?1, terminal_run_revision = ?2
         WHERE run_id = ?3 AND finish_id = ?4",
        params![ack_state, terminal_run_revision, run_id, finish_id],
    )?;
    Ok(())
}

/// Finishes sent but not yet acknowledged (replay candidates after restart).
pub fn pending_finishes(conn: &Connection) -> rusqlite::Result<Vec<FinishRow>> {
    let mut stmt = conn.prepare(
        "SELECT run_id, finish_id, outcome, reason, final_checkpoint_seq, final_checkpoint_hash,
                signed_bytes, signed_hash, ack_state, terminal_run_revision
         FROM runtime_finish WHERE ack_state IS NULL ORDER BY run_id, finish_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(FinishRow {
            run_id: r.get(0)?,
            finish_id: r.get(1)?,
            outcome: r.get(2)?,
            reason: r.get(3)?,
            final_checkpoint_seq: r.get(4)?,
            final_checkpoint_hash: r.get(5)?,
            signed_bytes: r.get(6)?,
            signed_hash: r.get(7)?,
            ack_state: r.get(8)?,
            terminal_run_revision: r.get(9)?,
        })
    })?;
    rows.collect()
}

/// A `runtime_start` resume binding row.
#[derive(Clone, Debug)]
pub struct StartRow {
    pub run_id: String,
    pub binding_revision: i64,
    pub binding_hash: String,
    pub start_nonce: String,
    pub state: String,
    pub expected_checkpoint_ref: Option<String>,
    pub expected_checkpoint_hash: Option<String>,
}

/// Persist a resume binding. Idempotent on retry; `start_nonce` stays UNIQUE.
pub fn persist_start(conn: &Connection, row: &StartRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO runtime_start
            (run_id, binding_revision, binding_hash, start_nonce, state,
             expected_checkpoint_ref, expected_checkpoint_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            row.run_id,
            row.binding_revision,
            row.binding_hash,
            row.start_nonce,
            row.state,
            row.expected_checkpoint_ref,
            row.expected_checkpoint_hash,
        ],
    )?;
    Ok(())
}

/// Read a specific binding.
pub fn read_start(
    conn: &Connection,
    run_id: &str,
    binding_revision: i64,
) -> rusqlite::Result<Option<StartRow>> {
    conn.query_row(
        "SELECT run_id, binding_revision, binding_hash, start_nonce, state,
                expected_checkpoint_ref, expected_checkpoint_hash
         FROM runtime_start WHERE run_id = ?1 AND binding_revision = ?2",
        params![run_id, binding_revision],
        |r| {
            Ok(StartRow {
                run_id: r.get(0)?,
                binding_revision: r.get(1)?,
                binding_hash: r.get(2)?,
                start_nonce: r.get(3)?,
                state: r.get(4)?,
                expected_checkpoint_ref: r.get(5)?,
                expected_checkpoint_hash: r.get(6)?,
            })
        },
    )
    .optional()
}

/// The highest-revision binding for a Run (the current resume point).
pub fn latest_start(conn: &Connection, run_id: &str) -> rusqlite::Result<Option<StartRow>> {
    conn.query_row(
        "SELECT run_id, binding_revision, binding_hash, start_nonce, state,
                expected_checkpoint_ref, expected_checkpoint_hash
         FROM runtime_start WHERE run_id = ?1 ORDER BY binding_revision DESC LIMIT 1",
        params![run_id],
        |r| {
            Ok(StartRow {
                run_id: r.get(0)?,
                binding_revision: r.get(1)?,
                binding_hash: r.get(2)?,
                start_nonce: r.get(3)?,
                state: r.get(4)?,
                expected_checkpoint_ref: r.get(5)?,
                expected_checkpoint_hash: r.get(6)?,
            })
        },
    )
    .optional()
}

/// A `checkpoint` row's metadata (the ciphertext is sealed separately).
#[derive(Clone, Debug)]
pub struct CheckpointRow {
    pub run_id: String,
    pub checkpoint_seq: i64,
    pub schema_version: u32,
    pub runtime_digest: String,
    pub checkpoint_hash: String,
    pub pending_operation_set_hash: String,
    pub prior_receipt_ref: Option<String>,
}

/// The non-secret metadata of the latest checkpoint (for resume matching).
#[derive(Clone, Debug)]
pub struct CheckpointMeta {
    pub checkpoint_seq: i64,
    pub checkpoint_hash: String,
    pub runtime_digest: String,
    pub pending_operation_set_hash: String,
}

fn checkpoint_record_id(run_id: &str, checkpoint_seq: i64) -> String {
    format!("{run_id}:{checkpoint_seq}")
}

/// Persist an encrypted checkpoint (canonical body sealed under the DEK).
pub fn persist_checkpoint(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    row: &CheckpointRow,
    plaintext: &[u8],
) -> Result<(), RecordError> {
    let record_id = checkpoint_record_id(&row.run_id, row.checkpoint_seq);
    let sealed = record::seal_record(dek, ctx, "checkpoint", &record_id, plaintext)?;
    conn.execute(
        "INSERT INTO checkpoint
            (run_id, checkpoint_seq, schema_version, runtime_digest, ciphertext,
             checkpoint_hash, pending_operation_set_hash, prior_receipt_ref)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            row.run_id,
            row.checkpoint_seq,
            row.schema_version,
            row.runtime_digest,
            sealed,
            row.checkpoint_hash,
            row.pending_operation_set_hash,
            row.prior_receipt_ref,
        ],
    )?;
    Ok(())
}

/// Open a checkpoint's sealed canonical body.
pub fn read_checkpoint(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    run_id: &str,
    checkpoint_seq: i64,
) -> Result<Vec<u8>, RecordError> {
    let sealed: Vec<u8> = conn.query_row(
        "SELECT ciphertext FROM checkpoint WHERE run_id = ?1 AND checkpoint_seq = ?2",
        params![run_id, checkpoint_seq],
        |r| r.get(0),
    )?;
    let record_id = checkpoint_record_id(run_id, checkpoint_seq);
    Ok(record::open_record(
        dek,
        ctx,
        "checkpoint",
        &record_id,
        &sealed,
    )?)
}

/// The latest checkpoint metadata for a Run.
pub fn latest_checkpoint(
    conn: &Connection,
    run_id: &str,
) -> rusqlite::Result<Option<CheckpointMeta>> {
    conn.query_row(
        "SELECT checkpoint_seq, checkpoint_hash, runtime_digest, pending_operation_set_hash
         FROM checkpoint WHERE run_id = ?1 ORDER BY checkpoint_seq DESC LIMIT 1",
        params![run_id],
        |r| {
            Ok(CheckpointMeta {
                checkpoint_seq: r.get(0)?,
                checkpoint_hash: r.get(1)?,
                runtime_digest: r.get(2)?,
                pending_operation_set_hash: r.get(3)?,
            })
        },
    )
    .optional()
}

/// The outcome of applying an `operation_resolution` to a journal row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolutionApply {
    Applied,
    AlreadyApplied,
    Conflict,
    JournalRowMissing,
}

/// Apply a server resolution monotonically by `resolution_revision`: a lower
/// revision conflicts (no journal rollback), the same revision is idempotent, a
/// higher revision advances the state. A missing row yields `JournalRowMissing`
/// (the device answers the ack accordingly; §3.1 operation_resolution row).
pub fn apply_resolution(
    conn: &Connection,
    org_id: &str,
    operation_id: &str,
    new_state: &str,
    resolution_revision: i64,
) -> rusqlite::Result<ResolutionApply> {
    let current: Option<Option<i64>> = conn
        .query_row(
            "SELECT resolution_revision FROM action_journal WHERE org_id = ?1 AND operation_id = ?2",
            params![org_id, operation_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(stored) = current else {
        return Ok(ResolutionApply::JournalRowMissing);
    };
    match stored {
        Some(rev) if resolution_revision < rev => Ok(ResolutionApply::Conflict),
        Some(rev) if resolution_revision == rev => Ok(ResolutionApply::AlreadyApplied),
        _ => {
            conn.execute(
                "UPDATE action_journal SET state = ?1, resolution_revision = ?2
                 WHERE org_id = ?3 AND operation_id = ?4",
                params![new_state, resolution_revision, org_id, operation_id],
            )?;
            Ok(ResolutionApply::Applied)
        }
    }
}

/// Count Operations of a Run still `unknown` (unreconciled). A resolution always
/// moves the state out of `unknown`, so this is the unknown-blocking signal.
pub fn unreconciled_unknown_count(conn: &Connection, run_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM action_journal WHERE run_id = ?1 AND state = 'unknown'",
        params![run_id],
        |r| r.get(0),
    )
}

/// Whether the Run has a terminal (`accepted`) finish — the permanent minimal Run
/// tombstone that rejects late offers/commands (§3.2 :115).
pub fn is_run_terminal(conn: &Connection, run_id: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM runtime_finish WHERE run_id = ?1 AND ack_state = 'accepted'",
        params![run_id],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

/// Clear a Run's action dedup tombstones after the cleanup gate is satisfied
/// (finish accepted + every Operation resolved). The `runtime_finish` terminal
/// row is kept as the permanent Run tombstone. Returns the number cleared.
pub fn cleanup_action_tombstones(conn: &Connection, run_id: &str) -> rusqlite::Result<u64> {
    let n = conn.execute(
        "DELETE FROM action_journal WHERE run_id = ?1",
        params![run_id],
    )?;
    Ok(n as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{meta, record, schema};

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("work-journal-recover-{}.db", uuid::Uuid::new_v4()));
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

    fn receipt(conn: &Connection, op: &str, state: &str, bytes: &[u8]) -> i64 {
        record::append_receipt(
            conn,
            "dev",
            "epoch-1",
            &record::ReceiptRow {
                operation_id: op,
                state,
                signed_bytes: bytes,
                signed_hash: "h",
            },
        )
        .unwrap()
    }

    fn action(conn: &Connection, op: &str, state: &str) {
        record::append_action(
            conn,
            &[3u8; 32],
            &ctx(),
            &record::ActionRow {
                org_id: "org",
                operation_id: op,
                run_id: "run",
                attempt: 1,
                step_key: "step",
                logical_key: op,
                supersedes: None,
                request_hash: "hash",
                fence: 1,
                session_id: "sess",
                generation: 1,
                permit_jti: op,
                state,
                result_hash: None,
                result_ref: None,
            },
            b"body",
        )
        .unwrap();
    }

    #[test]
    fn unacked_receipts_replay_in_seq_order_with_original_bytes() {
        let (conn, path) = temp_conn();
        receipt(&conn, "op1", "completed", b"signed-1");
        receipt(&conn, "op2", "completed", b"signed-2");
        let out = unacked_receipts(&conn, "epoch-1", 100).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].receipt_seq, 1);
        assert_eq!(out[0].signed_bytes, b"signed-1");
        assert_eq!(out[1].signed_bytes, b"signed-2");
        // Acking the first removes it from replay; the second remains.
        mark_receipt_acked(&conn, "epoch-1", 1).unwrap();
        let out = unacked_receipts(&conn, "epoch-1", 100).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].receipt_seq, 2);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cleanup_releases_contiguous_acked_prefix_only() {
        let (conn, path) = temp_conn();
        receipt(&conn, "op1", "completed", b"a");
        receipt(&conn, "op2", "completed", b"b");
        receipt(&conn, "op3", "completed", b"c");
        mark_receipt_acked(&conn, "epoch-1", 1).unwrap();
        mark_receipt_acked(&conn, "epoch-1", 2).unwrap();
        // seq 3 un-acked: watermark 3 must release only 1 and 2, never cross 3.
        let released = cleanup_receipts_through(&conn, "epoch-1", 3).unwrap();
        assert_eq!(released, 2);
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM receipt_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 1);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cleanup_stops_at_unknown_even_if_acked() {
        let (conn, path) = temp_conn();
        receipt(&conn, "op1", "completed", b"a");
        receipt(&conn, "op2", "unknown", b"b");
        receipt(&conn, "op3", "completed", b"c");
        mark_receipt_acked(&conn, "epoch-1", 1).unwrap();
        mark_receipt_acked(&conn, "epoch-1", 2).unwrap();
        mark_receipt_acked(&conn, "epoch-1", 3).unwrap();
        // The unknown at seq 2 blocks release of 2 and 3.
        let released = cleanup_receipts_through(&conn, "epoch-1", 3).unwrap();
        assert_eq!(released, 1);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn finish_persist_is_idempotent_and_replays_until_accepted() {
        let (conn, path) = temp_conn();
        let row = FinishRow {
            run_id: "run".into(),
            finish_id: "f1".into(),
            outcome: "completed".into(),
            reason: None,
            final_checkpoint_seq: Some(3),
            final_checkpoint_hash: Some("ch".into()),
            signed_bytes: b"original".to_vec(),
            signed_hash: "h".into(),
            ack_state: None,
            terminal_run_revision: None,
        };
        persist_finish(&conn, &row).unwrap();
        // A re-send with different bytes keeps the original.
        let mut resend = row.clone();
        resend.signed_bytes = b"different".to_vec();
        persist_finish(&conn, &resend).unwrap();
        let stored = read_finish(&conn, "run", "f1").unwrap().unwrap();
        assert_eq!(stored.signed_bytes, b"original");
        assert_eq!(pending_finishes(&conn).unwrap().len(), 1);
        set_finish_ack(&conn, "run", "f1", "accepted", Some(7)).unwrap();
        assert!(pending_finishes(&conn).unwrap().is_empty());
        assert!(is_run_terminal(&conn, "run").unwrap());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolution_is_monotonic_by_revision() {
        let (conn, path) = temp_conn();
        action(&conn, "op1", "unknown");
        assert_eq!(
            apply_resolution(&conn, "org", "op1", "failed", 5).unwrap(),
            ResolutionApply::Applied
        );
        // Same revision idempotent.
        assert_eq!(
            apply_resolution(&conn, "org", "op1", "failed", 5).unwrap(),
            ResolutionApply::AlreadyApplied
        );
        // Lower revision conflicts, no rollback.
        assert_eq!(
            apply_resolution(&conn, "org", "op1", "succeeded", 4).unwrap(),
            ResolutionApply::Conflict
        );
        // Higher revision advances.
        assert_eq!(
            apply_resolution(&conn, "org", "op1", "succeeded", 6).unwrap(),
            ResolutionApply::Applied
        );
        // Missing row.
        assert_eq!(
            apply_resolution(&conn, "org", "missing", "failed", 1).unwrap(),
            ResolutionApply::JournalRowMissing
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unknown_count_drops_after_resolution() {
        let (conn, path) = temp_conn();
        action(&conn, "op1", "unknown");
        action(&conn, "op2", "completed");
        assert_eq!(unreconciled_unknown_count(&conn, "run").unwrap(), 1);
        apply_resolution(&conn, "org", "op1", "failed", 1).unwrap();
        assert_eq!(unreconciled_unknown_count(&conn, "run").unwrap(), 0);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn checkpoint_sealed_at_rest_and_latest_meta() {
        let (conn, path) = temp_conn();
        let dek = [3u8; 32];
        let c = ctx();
        let row = CheckpointRow {
            run_id: "run".into(),
            checkpoint_seq: 1,
            schema_version: schema::SCHEMA_VERSION,
            runtime_digest: "digest".into(),
            checkpoint_hash: "ch1".into(),
            pending_operation_set_hash: "pending".into(),
            prior_receipt_ref: None,
        };
        persist_checkpoint(&conn, &dek, &c, &row, b"canonical checkpoint body").unwrap();
        let stored: Vec<u8> = conn
            .query_row(
                "SELECT ciphertext FROM checkpoint WHERE run_id='run'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(stored.as_slice(), b"canonical checkpoint body");
        assert_eq!(
            read_checkpoint(&conn, &dek, &c, "run", 1).unwrap(),
            b"canonical checkpoint body"
        );
        let meta = latest_checkpoint(&conn, "run").unwrap().unwrap();
        assert_eq!(meta.checkpoint_seq, 1);
        assert_eq!(meta.checkpoint_hash, "ch1");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tombstone_cleanup_keeps_terminal_finish() {
        let (conn, path) = temp_conn();
        action(&conn, "op1", "completed");
        action(&conn, "op2", "completed");
        let row = FinishRow {
            run_id: "run".into(),
            finish_id: "f1".into(),
            outcome: "completed".into(),
            reason: None,
            final_checkpoint_seq: None,
            final_checkpoint_hash: None,
            signed_bytes: b"sig".to_vec(),
            signed_hash: "h".into(),
            ack_state: Some("accepted".into()),
            terminal_run_revision: Some(1),
        };
        persist_finish(&conn, &row).unwrap();
        assert!(is_run_terminal(&conn, "run").unwrap());
        let cleared = cleanup_action_tombstones(&conn, "run").unwrap();
        assert_eq!(cleared, 2);
        // The terminal finish tombstone survives the action cleanup.
        assert!(is_run_terminal(&conn, "run").unwrap());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
