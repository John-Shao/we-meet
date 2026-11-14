//! Receipt and finish replay (device-design §6.3 rows "本地 completed、上报丢失"
//! and "run_finish 已发、ack 丢失"). Replay re-sends the original signed bytes
//! unchanged — never re-signs, re-judges, or re-executes. Receipts go out in seq
//! order, batches ≤100 with an un-acked window of 100 (§3.1 :105); finishes replay
//! the same finish_id until the server ack is durable.

use rusqlite::Connection;

use crate::frame::reconcile::{ReconcileBody, MAX_RECEIPTS_PER_BATCH};
use crate::journal::recover::{self, FinishRow, OutboxReceipt};

/// The un-acked receipt window (§3.1 :105).
pub const UNACKED_WINDOW: u32 = 100;

/// The next replay batch: up to 100 un-acked receipts, oldest seq first.
pub fn next_receipt_batch(
    conn: &Connection,
    journal_epoch: &str,
) -> rusqlite::Result<Vec<OutboxReceipt>> {
    recover::unacked_receipts(conn, journal_epoch, MAX_RECEIPTS_PER_BATCH as u32)
}

/// Assemble the reconcile uplink for a replay batch (original bytes nested).
pub fn reconcile_batch(
    original_run_id: &str,
    journal_epoch: &str,
    from_seq: u64,
    receipts: &[OutboxReceipt],
) -> ReconcileBody {
    ReconcileBody::from_receipts(original_run_id, journal_epoch, from_seq, receipts)
}

/// Mark a receipt acknowledged once the server records it.
pub fn ack_receipt(
    conn: &Connection,
    journal_epoch: &str,
    receipt_seq: i64,
) -> rusqlite::Result<()> {
    recover::mark_receipt_acked(conn, journal_epoch, receipt_seq)
}

/// Persist a finish proposal durably (idempotent by finish_id).
pub fn persist_finish(conn: &Connection, row: &FinishRow) -> rusqlite::Result<()> {
    recover::persist_finish(conn, row)
}

/// Finishes to replay after restart: sent but un-acked, same finish_id and bytes.
pub fn pending_finishes(conn: &Connection) -> rusqlite::Result<Vec<FinishRow>> {
    recover::pending_finishes(conn)
}

/// Record the server finish ack; `accepted` stops replay and seals the Run.
pub fn ack_finish(
    conn: &Connection,
    run_id: &str,
    finish_id: &str,
    ack_state: &str,
    terminal_run_revision: Option<i64>,
) -> rusqlite::Result<()> {
    recover::set_finish_ack(conn, run_id, finish_id, ack_state, terminal_run_revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{meta, record, schema};

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("work-recovery-replay-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        schema::apply(&conn).unwrap();
        meta::init(&conn, "dev", "epoch-1", schema::SCHEMA_VERSION, &[0u8; 32]).unwrap();
        (conn, path)
    }

    #[test]
    fn receipt_batch_replays_original_bytes_in_order() {
        let (conn, path) = temp_conn();
        for i in 1..=3 {
            record::append_receipt(
                &conn,
                "dev",
                "epoch-1",
                &record::ReceiptRow {
                    operation_id: "op",
                    state: "completed",
                    signed_bytes: format!("signed-{i}").as_bytes(),
                    signed_hash: "h",
                },
            )
            .unwrap();
        }
        let batch = next_receipt_batch(&conn, "epoch-1").unwrap();
        assert_eq!(batch.len(), 3);
        let body = reconcile_batch("run", "epoch-1", 1, &batch);
        assert_eq!(body.decode_receipts().unwrap()[0], b"signed-1");
        assert_eq!(body.last_receipt_seq, 3);
        // Acking the first leaves two for the next batch.
        ack_receipt(&conn, "epoch-1", 1).unwrap();
        assert_eq!(next_receipt_batch(&conn, "epoch-1").unwrap().len(), 2);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn finish_replays_same_bytes_until_accepted() {
        let (conn, path) = temp_conn();
        let row = FinishRow {
            run_id: "run".into(),
            finish_id: "f1".into(),
            outcome: "completed".into(),
            reason: None,
            final_checkpoint_seq: None,
            final_checkpoint_hash: None,
            signed_bytes: b"finish-sig".to_vec(),
            signed_hash: "h".into(),
            ack_state: None,
            terminal_run_revision: None,
        };
        persist_finish(&conn, &row).unwrap();
        let pending = pending_finishes(&conn).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].signed_bytes, b"finish-sig");
        ack_finish(&conn, "run", "f1", "accepted", Some(2)).unwrap();
        assert!(pending_finishes(&conn).unwrap().is_empty());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
