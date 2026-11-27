//! Resume binding validation (device-design §3.2 :113). A resume offer must carry
//! a higher binding_revision than the latest local binding, and its
//! expected_checkpoint must equal the latest checkpoint the device signed and
//! reported (§3.4). The Broker confirms the same content and all prior receipts
//! complete before ready; a missing checkpoint means explicit stop/recover, never
//! a re-run from the initial input. A terminal Run tombstone blocks old offers.

use rusqlite::Connection;

use crate::frame::offer::RunOfferBody;
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

impl ResumeOffer {
    /// Map a wire `run_offer` onto the local validation facts.
    ///
    /// `start_nonce` is NOT available here: §3.1 carries it only in `run_start`, so the caller
    /// passes an empty string for [`validate_resume`] (which never reads it) and the real nonce
    /// for [`register_resume`], whose UNIQUE `runtime_start.start_nonce` is what makes the start
    /// single-use. `expected_checkpoint_ref` stays None because the control plane records only
    /// the expected checkpoint's seq and hash on the binding, never a ref.
    pub fn from_wire(offer: &RunOfferBody, start_nonce: &str) -> Self {
        Self {
            run_id: offer.run_id.clone(),
            binding_revision: offer.binding_revision,
            binding_hash: offer.binding_hash.clone(),
            start_nonce: start_nonce.to_string(),
            expected_checkpoint_ref: None,
            expected_checkpoint_hash: offer.expected_checkpoint_hash.clone(),
        }
    }
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
            fence: None,
            lease_id: None,
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

    /// The wire offer carries no start_nonce (§3.1 puts it only in run_start), so validation
    /// runs with an empty nonce and registration uses the one from run_start. Both go through
    /// the same mapping, and the ref stays None because the control plane records only the
    /// expected checkpoint's seq and hash.
    #[test]
    fn wire_offer_maps_onto_resume_facts() {
        use crate::frame::offer::{GrantRef, OriginalTarget, RunOfferBody};

        let wire = RunOfferBody {
            run_id: "run".into(),
            binding_revision: 2,
            binding_hash: "bh".into(),
            task_id: "task".into(),
            input_ref: "ref".into(),
            input_hash: "ih".into(),
            snapshot_descriptor_ref: None,
            snapshot_hash: "sh".into(),
            profile_id: "p1".into(),
            profile_revision: 1,
            runtime_digest: "rd".into(),
            tool_manifest_hash: "tm".into(),
            model_version: "m1".into(),
            grant_set: vec![GrantRef {
                grant_id: "g1".into(),
                grant_revision: 1,
            }],
            expected_checkpoint_seq: Some(1),
            expected_checkpoint_hash: Some("ch1".into()),
            original_target: OriginalTarget {
                device_id: "dev".into(),
                session_id: "sess".into(),
            },
            offer_expiry: "2026-11-16T00:02:00Z".into(),
            probe: None,
            signature: None,
        };
        assert!(wire.is_resume());

        let (conn, path) = temp_conn();
        seed_checkpoint(&conn, "ch1");
        // Validation before the nonce is known: the empty nonce is never read.
        let pending = ResumeOffer::from_wire(&wire, "");
        assert_eq!(pending.start_nonce, "");
        assert_eq!(pending.expected_checkpoint_ref, None);
        assert!(validate_resume(&conn, "epoch-1", &pending).is_ok());
        // Registration with the nonce from run_start makes it single-use: runtime_start's
        // UNIQUE start_nonce plus INSERT OR IGNORE means a reused nonce buys no second row.
        let started = ResumeOffer::from_wire(&wire, "nonce-9");
        register_resume(&conn, &started).unwrap();
        assert!(recover::read_start(&conn, "run", 2).unwrap().is_some());
        let mut replay = ResumeOffer::from_wire(&wire, "nonce-9");
        replay.binding_revision = 3;
        register_resume(&conn, &replay).unwrap();
        assert!(
            recover::read_start(&conn, "run", 3).unwrap().is_none(),
            "a reused start_nonce must not buy a second runtime_start row"
        );
        // The same revision is now stale.
        assert!(matches!(
            validate_resume(&conn, "epoch-1", &pending),
            Err(ResumeError::StaleRevision)
        ));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
