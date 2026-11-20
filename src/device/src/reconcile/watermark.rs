//! Journal cleanup watermarks (B03 carrier §3.2, replacing journal_release and
//! device_run_seal). Receipt incremental cleanup is driven by the `checkpoint_ack`
//! `recorded` receipt watermark; action dedup tombstone cleanup is driven by the
//! `finish` `accepted` ack plus every Operation's resolution. Both facts are
//! server-signed and monotonic; the device never cleans up from local inference,
//! and never crosses an unknown or missing seq (§6.4).

use rusqlite::Connection;

use crate::frame::checkpoint::CheckpointAckBody;
use crate::journal::recover;
use crate::jwk::EcP256Jwk;

/// A watermark application failure.
#[derive(Debug)]
pub enum WatermarkError {
    Signature,
    State,
    Sql(rusqlite::Error),
}

impl From<rusqlite::Error> for WatermarkError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Sql(err)
    }
}

/// Apply a recorded checkpoint_ack's receipt watermark. Verifies the server
/// signature, requires a valid `recorded` state, then releases the contiguous
/// acknowledged receipts at or below the watermark. A `conflict` ack carries no
/// usable watermark and releases nothing. Returns the number released.
pub fn apply_receipt_watermark(
    conn: &Connection,
    jwk: &EcP256Jwk,
    journal_epoch: &str,
    ack: &CheckpointAckBody,
) -> Result<u64, WatermarkError> {
    if !ack.verify(jwk) {
        return Err(WatermarkError::Signature);
    }
    if !ack.state_valid() {
        return Err(WatermarkError::State);
    }
    if !ack.is_recorded() {
        return Ok(0);
    }
    Ok(recover::cleanup_receipts_through(
        conn,
        journal_epoch,
        ack.receipt_through_seq as i64,
    )?)
}

/// The tombstone cleanup gate (B03 §3.2): the finish is accepted (with its
/// final_operation_set_hash and receipt continuity verified) and every Operation
/// of the Run has received its resolution.
#[derive(Clone, Copy, Debug, Default)]
pub struct TombstoneGate {
    pub finish_accepted: bool,
    pub final_operation_set_hash_verified: bool,
    pub receipt_through_seq_continuous: bool,
    pub all_resolutions_received: bool,
}

impl TombstoneGate {
    /// Whether all gate conditions hold.
    pub fn satisfied(&self) -> bool {
        self.finish_accepted
            && self.final_operation_set_hash_verified
            && self.receipt_through_seq_continuous
            && self.all_resolutions_received
    }
}

/// Clear a Run's action dedup tombstones only when the gate is satisfied and the
/// Run is terminal. The permanent minimal Run tombstone (the accepted finish row)
/// is kept to reject late commands. Returns the number cleared (0 if not allowed).
pub fn cleanup_tombstones(
    conn: &Connection,
    run_id: &str,
    gate: &TombstoneGate,
) -> Result<u64, WatermarkError> {
    if !gate.satisfied() {
        return Ok(0);
    }
    if !recover::is_run_terminal(conn, run_id)? {
        return Ok(0);
    }
    Ok(recover::cleanup_action_tombstones(conn, run_id)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{checkpoint, sign};
    use crate::journal::record::ReceiptRow;
    use crate::journal::recover::FinishRow;
    use crate::journal::{meta, record, schema};
    use crate::key::{DeviceKey, SoftwareKey};

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "work-reconcile-watermark-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&path).unwrap();
        schema::apply(&conn).unwrap();
        meta::init(&conn, "dev", "epoch-1", schema::SCHEMA_VERSION, &[0u8; 32]).unwrap();
        (conn, path)
    }

    fn signed_ack(server: &SoftwareKey, state: &str, watermark: u64) -> CheckpointAckBody {
        let mut body = CheckpointAckBody {
            run_id: "run".into(),
            checkpoint_seq: 1,
            state: state.into(),
            receipt_through_seq: watermark,
            signature: None,
        };
        let sig = sign::sign_frame(server, checkpoint::ACK_FRAME_TYPE, &body.to_value()).unwrap();
        body.signature = Some(sig);
        body
    }

    fn seed_receipts(conn: &Connection, n: i64) {
        for i in 1..=n {
            record::append_receipt(
                conn,
                "dev",
                "epoch-1",
                &ReceiptRow {
                    operation_id: "op",
                    state: "completed",
                    signed_bytes: b"sig",
                    signed_hash: "h",
                },
            )
            .unwrap();
            recover::mark_receipt_acked(conn, "epoch-1", i).unwrap();
        }
    }

    #[test]
    fn recorded_watermark_releases_contiguous_receipts() {
        let (conn, path) = temp_conn();
        seed_receipts(&conn, 3);
        let server = SoftwareKey::random();
        let released = apply_receipt_watermark(
            &conn,
            &server.public_jwk(),
            "epoch-1",
            &signed_ack(&server, "recorded", 2),
        )
        .unwrap();
        assert_eq!(released, 2);
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM receipt_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 1);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn conflict_ack_releases_nothing() {
        let (conn, path) = temp_conn();
        seed_receipts(&conn, 2);
        let server = SoftwareKey::random();
        let released = apply_receipt_watermark(
            &conn,
            &server.public_jwk(),
            "epoch-1",
            &signed_ack(&server, "conflict", 2),
        )
        .unwrap();
        assert_eq!(released, 0);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unsigned_watermark_rejected() {
        let (conn, path) = temp_conn();
        let server = SoftwareKey::random();
        let other = SoftwareKey::random();
        let ack = signed_ack(&server, "recorded", 2);
        assert!(matches!(
            apply_receipt_watermark(&conn, &other.public_jwk(), "epoch-1", &ack),
            Err(WatermarkError::Signature)
        ));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tombstone_gate_requires_all_conditions() {
        let mut gate = TombstoneGate {
            finish_accepted: true,
            final_operation_set_hash_verified: true,
            receipt_through_seq_continuous: true,
            all_resolutions_received: true,
        };
        assert!(gate.satisfied());
        gate.all_resolutions_received = false;
        assert!(!gate.satisfied());
    }

    #[test]
    fn cleanup_only_when_terminal_and_gate_satisfied() {
        let (conn, path) = temp_conn();
        record::append_action(
            &conn,
            &[3u8; 32],
            &record::RecordContext {
                org: "org",
                subject: "sub",
                device: "dev",
                journal_epoch: "epoch-1",
                schema_version: schema::SCHEMA_VERSION,
            },
            &record::ActionRow {
                org_id: "org",
                operation_id: "op1",
                run_id: "run",
                attempt: "attempt-1",
                step_key: "step",
                logical_key: "op1",
                supersedes: None,
                request_hash: "hash",
                fence: 1,
                session_id: "sess",
                generation: 1,
                permit_jti: "op1",
                state: "completed",
                result_hash: None,
                result_ref: None,
            },
            b"body",
        )
        .unwrap();
        let gate = TombstoneGate {
            finish_accepted: true,
            final_operation_set_hash_verified: true,
            receipt_through_seq_continuous: true,
            all_resolutions_received: true,
        };
        // Not terminal yet: nothing cleared.
        assert_eq!(cleanup_tombstones(&conn, "run", &gate).unwrap(), 0);
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
        assert_eq!(cleanup_tombstones(&conn, "run", &gate).unwrap(), 1);
        assert!(recover::is_run_terminal(&conn, "run").unwrap());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
