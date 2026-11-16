//! Receipt and finish replay (device-design §6.3 rows "本地 completed、上报丢失"
//! and "run_finish 已发、ack 丢失"). Replay re-sends the original signed bytes
//! unchanged — never re-signs, re-judges, or re-executes. Receipts go out in seq
//! order, batches ≤100 with an un-acked window of 100 (§3.1 :105); finishes replay
//! the same finish_id until the server ack is durable.

use rusqlite::Connection;

use crate::frame::receipt_ack::{ReceiptAckBody, ReceiptConflict};
use crate::frame::reconcile::{ReconcileBody, MAX_RECEIPTS_PER_BATCH};
use crate::journal::recover::{self, FinishRow, OutboxReceipt};
use crate::jwk::EcP256Jwk;

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

/// The outcome of consuming a receipt_ack: how many receipts were marked acked
/// and the conflicts the server reported. Conflicts are surfaced for
/// reconciliation, never silently dropped; the refused seqs stay un-acked.
#[derive(Clone, Debug)]
pub struct ReceiptAckOutcome {
    pub acked: u64,
    pub conflicts: Vec<ReceiptConflict>,
}

/// A receipt_ack / reconcile_ack consumption failure.
#[derive(Debug)]
pub enum ReceiptAckError {
    Signature,
    Sql(rusqlite::Error),
}

impl From<rusqlite::Error> for ReceiptAckError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Sql(err)
    }
}

/// Consume a receipt_ack (the record_device_receipt result) from the gateway. The ack is
/// server-signed (GW8); the signature is verified over the frame type the caller received
/// (`receipt_ack` or `reconcile_ack`, which share this body) against the hello_ack server
/// key BEFORE any row moves — fail-closed, no optional-signature shim (GW5 ruling). Every
/// `recorded` seq — new or idempotently replayed — is then marked acked so it leaves the
/// replay window. This advances the `acked` flag only: it NEVER deletes a receipt. Durable
/// release stays gated on the server-signed checkpoint_ack watermark (B03 §3.2,
/// reconcile/watermark.rs). Re-applying the same ack is idempotent (acked is already 1).
pub fn apply_receipt_ack(
    conn: &Connection,
    jwk: &EcP256Jwk,
    journal_epoch: &str,
    frame_type: &str,
    ack: &ReceiptAckBody,
) -> Result<ReceiptAckOutcome, ReceiptAckError> {
    if !ack.verify(jwk, frame_type) {
        return Err(ReceiptAckError::Signature);
    }
    let mut acked = 0u64;
    for rec in &ack.recorded {
        recover::mark_receipt_acked(conn, journal_epoch, rec.receipt_seq as i64)?;
        acked += 1;
    }
    Ok(ReceiptAckOutcome {
        acked,
        conflicts: ack.conflicts.clone(),
    })
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
    use crate::frame::receipt_ack::RecordedReceipt;
    use crate::journal::{meta, record, schema};
    use crate::key::DeviceKey;

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

    fn seed_receipts(conn: &Connection, n: i64) {
        for i in 1..=n {
            record::append_receipt(
                conn,
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
    }

    fn ack(recorded: &[u64], conflicts: &[(u64, &str)], through: u64) -> ReceiptAckBody {
        ReceiptAckBody {
            recorded: recorded
                .iter()
                .map(|&seq| RecordedReceipt {
                    receipt_seq: seq,
                    operation_id: "op".into(),
                    state: "completed".into(),
                    resolution_revision: None,
                    replayed: false,
                })
                .collect(),
            conflicts: conflicts
                .iter()
                .map(|&(seq, code)| ReceiptConflict {
                    receipt_seq: seq,
                    code: code.into(),
                })
                .collect(),
            receipt_through_seq: through,
            signature: None,
        }
    }

    /// Sign an ack with a fresh server key and return its public JWK, so the consumer
    /// verifies it exactly as it would a gateway-signed ack.
    fn signed_ack(
        server: &crate::key::SoftwareKey,
        frame_type: &str,
        recorded: &[u64],
        conflicts: &[(u64, &str)],
        through: u64,
    ) -> (crate::jwk::EcP256Jwk, ReceiptAckBody) {
        let mut body = ack(recorded, conflicts, through);
        let sig = crate::frame::sign::sign_frame(server, frame_type, &body.to_value()).unwrap();
        body.signature = Some(sig);
        (server.public_jwk(), body)
    }

    #[test]
    fn receipt_ack_marks_recorded_and_leaves_replay_window() {
        let (conn, path) = temp_conn();
        seed_receipts(&conn, 3);
        assert_eq!(next_receipt_batch(&conn, "epoch-1").unwrap().len(), 3);
        let server = crate::key::SoftwareKey::random();
        let (jwk, body) = signed_ack(&server, "receipt_ack", &[1, 2], &[], 2);
        let outcome = apply_receipt_ack(&conn, &jwk, "epoch-1", "receipt_ack", &body).unwrap();
        assert_eq!(outcome.acked, 2);
        assert!(outcome.conflicts.is_empty());
        // Only the un-acked third remains for replay.
        let batch = next_receipt_batch(&conn, "epoch-1").unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].receipt_seq, 3);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn receipt_ack_surfaces_conflicts_and_keeps_them_unacked() {
        let (conn, path) = temp_conn();
        seed_receipts(&conn, 3);
        let server = crate::key::SoftwareKey::random();
        let (jwk, body) = signed_ack(
            &server,
            "receipt_ack",
            &[1],
            &[(2, "idempotency_key_conflict")],
            1,
        );
        let outcome = apply_receipt_ack(&conn, &jwk, "epoch-1", "receipt_ack", &body).unwrap();
        assert_eq!(outcome.acked, 1);
        assert_eq!(outcome.conflicts.len(), 1);
        assert_eq!(outcome.conflicts[0].receipt_seq, 2);
        assert_eq!(outcome.conflicts[0].code, "idempotency_key_conflict");
        // The refused seq 2 and the unrecorded seq 3 stay in the replay window.
        let seqs: Vec<i64> = next_receipt_batch(&conn, "epoch-1")
            .unwrap()
            .iter()
            .map(|r| r.receipt_seq)
            .collect();
        assert_eq!(seqs, vec![2, 3]);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn receipt_ack_does_not_delete_durable_cleanup_is_separate() {
        let (conn, path) = temp_conn();
        seed_receipts(&conn, 2);
        // Even a watermark covering both seqs only acks; rows survive until the
        // signed checkpoint_ack drives cleanup (reconcile/watermark.rs).
        let server = crate::key::SoftwareKey::random();
        let (jwk, body) = signed_ack(&server, "receipt_ack", &[1, 2], &[], 2);
        apply_receipt_ack(&conn, &jwk, "epoch-1", "receipt_ack", &body).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM receipt_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        let unacked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM receipt_outbox WHERE acked = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unacked, 0);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn receipt_ack_reapply_is_idempotent() {
        let (conn, path) = temp_conn();
        seed_receipts(&conn, 2);
        let server = crate::key::SoftwareKey::random();
        let (jwk, body) = signed_ack(&server, "receipt_ack", &[1, 2], &[], 2);
        apply_receipt_ack(&conn, &jwk, "epoch-1", "receipt_ack", &body).unwrap();
        let outcome = apply_receipt_ack(&conn, &jwk, "epoch-1", "receipt_ack", &body).unwrap();
        assert_eq!(outcome.acked, 2);
        assert!(next_receipt_batch(&conn, "epoch-1").unwrap().is_empty());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unsigned_or_wrong_frame_type_ack_is_refused_fail_closed() {
        let (conn, path) = temp_conn();
        seed_receipts(&conn, 2);
        let server = crate::key::SoftwareKey::random();
        let jwk = server.public_jwk();

        // An unsigned ack is refused and nothing is acked.
        let unsigned = ack(&[1, 2], &[], 2);
        assert!(matches!(
            apply_receipt_ack(&conn, &jwk, "epoch-1", "receipt_ack", &unsigned),
            Err(ReceiptAckError::Signature)
        ));
        // A genuine receipt_ack signature consumed as reconcile_ack is refused, because
        // the signature covers {schema_version, type, body} with the frame type bound in.
        let (_, body) = signed_ack(&server, "receipt_ack", &[1, 2], &[], 2);
        assert!(matches!(
            apply_receipt_ack(&conn, &jwk, "epoch-1", "reconcile_ack", &body),
            Err(ReceiptAckError::Signature)
        ));
        // Nothing left the replay window on either refusal.
        assert_eq!(next_receipt_batch(&conn, "epoch-1").unwrap().len(), 2);
        // The same ack under its own frame type is accepted.
        let outcome = apply_receipt_ack(&conn, &jwk, "epoch-1", "receipt_ack", &body).unwrap();
        assert_eq!(outcome.acked, 2);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reconcile_ack_frame_type_consumes_the_same_body() {
        let (conn, path) = temp_conn();
        seed_receipts(&conn, 1);
        let server = crate::key::SoftwareKey::random();
        // The reconcile_ack carries the same body shape but a different frame type; the
        // device consumes it here with the reconcile_ack type the frame arrived under.
        let (jwk, body) = signed_ack(&server, "reconcile_ack", &[1], &[], 1);
        let outcome = apply_receipt_ack(&conn, &jwk, "epoch-1", "reconcile_ack", &body).unwrap();
        assert_eq!(outcome.acked, 1);
        assert!(next_receipt_batch(&conn, "epoch-1").unwrap().is_empty());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
