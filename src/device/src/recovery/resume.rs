//! Resume binding validation (device-design §3.2 :113). A resume offer must carry
//! a higher binding_revision than the latest local binding, and its
//! expected_checkpoint must equal the latest checkpoint the device signed and
//! reported (§3.4). The Broker confirms the same content and all prior receipts
//! complete before ready; a missing checkpoint means explicit stop/recover, never
//! a re-run from the initial input. A terminal Run tombstone blocks old offers.

use rusqlite::Connection;

use crate::journal::recover::{self, StartRow};

/// A resume rejection.
#[derive(Debug)]
pub enum ResumeError {
    /// The Run is terminal; its tombstone blocks old offers.
    TerminalRun,
    /// The offer revision is not higher than the latest binding.
    StaleRevision,
    /// No checkpoint exists: explicit stop, never re-run from initial input.
    MissingCheckpoint,
    /// The expected checkpoint hash differs from the latest signed-reported one.
    CheckpointMismatch,
    /// Prior receipts are not all acknowledged.
    PriorReceiptsIncomplete,
    Sql(rusqlite::Error),
}

impl From<rusqlite::Error> for ResumeError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Sql(err)
    }
}

/// A resume offer from the control plane (higher binding_revision for the same Run).
#[derive(Clone, Debug)]
pub struct ResumeOffer {
    pub run_id: String,
    pub binding_revision: u64,
    pub binding_hash: String,
    pub start_nonce: String,
    pub expected_checkpoint_ref: Option<String>,
    pub expected_checkpoint_hash: Option<String>,
}

/// Validate a resume offer against local journal facts. `journal_epoch` scopes the
/// prior-receipt completeness check.
pub fn validate_resume(
    conn: &Connection,
    journal_epoch: &str,
    offer: &ResumeOffer,
) -> Result<(), ResumeError> {
    if recover::is_run_terminal(conn, &offer.run_id)? {
        return Err(ResumeError::TerminalRun);
    }
    if let Some(latest) = recover::latest_start(conn, &offer.run_id)? {
        if offer.binding_revision <= latest.binding_revision as u64 {
            return Err(ResumeError::StaleRevision);
        }
    }
    match recover::latest_checkpoint(conn, &offer.run_id)? {
        None => return Err(ResumeError::MissingCheckpoint),
        Some(cp) => {
            if offer.expected_checkpoint_hash.as_deref() != Some(cp.checkpoint_hash.as_str()) {
                return Err(ResumeError::CheckpointMismatch);
            }
        }
    }
    if !recover::unacked_receipts(conn, journal_epoch, 1)?.is_empty() {
        return Err(ResumeError::PriorReceiptsIncomplete);
    }
    Ok(())
}

/// Register a validated resume offer as the new binding (state `ready`). The
/// `start_nonce` UNIQUE constraint keeps it single-use.
pub fn register_resume(conn: &Connection, offer: &ResumeOffer) -> rusqlite::Result<()> {
    recover::persist_start(
        conn,
        &StartRow {
            run_id: offer.run_id.clone(),
            binding_revision: offer.binding_revision as i64,
            binding_hash: offer.binding_hash.clone(),
            start_nonce: offer.start_nonce.clone(),
            state: "ready".into(),
            expected_checkpoint_ref: offer.expected_checkpoint_ref.clone(),
            expected_checkpoint_hash: offer.expected_checkpoint_hash.clone(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::recover::{CheckpointRow, FinishRow};
    use crate::journal::{meta, record, schema};

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("work-recovery-resume-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        schema::apply(&conn).unwrap();
        meta::init(&conn, "dev", "epoch-1", schema::SCHEMA_VERSION, &[0u8; 32]).unwrap();
        (conn, path)
    }

    fn ctx() -> record::RecordContext<'static> {
        record::RecordContext {
            org: "org",
            subject: "sub",
            device: "dev",
            journal_epoch: "epoch-1",
            schema_version: schema::SCHEMA_VERSION,
        }
    }

    fn seed_checkpoint(conn: &Connection, hash: &str) {
        recover::persist_checkpoint(
            conn,
            &[3u8; 32],
            &ctx(),
            &CheckpointRow {
                run_id: "run".into(),
                checkpoint_seq: 1,
                schema_version: schema::SCHEMA_VERSION,
                runtime_digest: "digest".into(),
                checkpoint_hash: hash.into(),
                pending_operation_set_hash: "pending".into(),
                prior_receipt_ref: None,
            },
            b"checkpoint body",
        )
        .unwrap();
    }

    fn offer(revision: u64, hash: &str) -> ResumeOffer {
        ResumeOffer {
            run_id: "run".into(),
            binding_revision: revision,
            binding_hash: "bh".into(),
            start_nonce: format!("nonce-{revision}"),
            expected_checkpoint_ref: Some("ref".into()),
            expected_checkpoint_hash: Some(hash.into()),
        }
    }

    #[test]
    fn valid_resume_with_matching_checkpoint() {
        let (conn, path) = temp_conn();
        seed_checkpoint(&conn, "ch1");
        assert!(validate_resume(&conn, "epoch-1", &offer(1, "ch1")).is_ok());
        register_resume(&conn, &offer(1, "ch1")).unwrap();
        // A higher revision still valid; the same revision is now stale.
        assert!(validate_resume(&conn, "epoch-1", &offer(2, "ch1")).is_ok());
        assert!(matches!(
            validate_resume(&conn, "epoch-1", &offer(1, "ch1")),
            Err(ResumeError::StaleRevision)
        ));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_checkpoint_stops_never_reruns() {
        let (conn, path) = temp_conn();
        assert!(matches!(
            validate_resume(&conn, "epoch-1", &offer(1, "ch1")),
            Err(ResumeError::MissingCheckpoint)
        ));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn checkpoint_mismatch_rejected() {
        let (conn, path) = temp_conn();
        seed_checkpoint(&conn, "ch1");
        assert!(matches!(
            validate_resume(&conn, "epoch-1", &offer(1, "other")),
            Err(ResumeError::CheckpointMismatch)
        ));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn terminal_run_blocks_offer() {
        let (conn, path) = temp_conn();
        seed_checkpoint(&conn, "ch1");
        recover::persist_finish(
            &conn,
            &FinishRow {
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
            },
        )
        .unwrap();
        assert!(matches!(
            validate_resume(&conn, "epoch-1", &offer(2, "ch1")),
            Err(ResumeError::TerminalRun)
        ));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn incomplete_prior_receipts_block_ready() {
        let (conn, path) = temp_conn();
        seed_checkpoint(&conn, "ch1");
        record::append_receipt(
            &conn,
            "dev",
            "epoch-1",
            &record::ReceiptRow {
                operation_id: "op",
                state: "completed",
                signed_bytes: b"sig",
                signed_hash: "h",
            },
        )
        .unwrap();
        assert!(matches!(
            validate_resume(&conn, "epoch-1", &offer(1, "ch1")),
            Err(ResumeError::PriorReceiptsIncomplete)
        ));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
