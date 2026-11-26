//! Journal cleanup watermarks (B03 carrier §3.2, replacing journal_release and
//! device_run_seal). Receipt incremental cleanup is driven by the `checkpoint_ack`
//! `recorded` receipt watermark; action dedup tombstone cleanup is driven by the
//! `finish` `accepted` ack plus every Operation's resolution. Both facts are
//! server-signed and monotonic; the device never cleans up from local inference,
//! and never crosses an unknown or missing seq (§6.4).

use rusqlite::{params, Connection};

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
///
/// Batch 6: the recorded ack is also stamped durably (`mark_recorded`), because which checkpoint the
/// server recorded is the fact the finish gate reads and a restart used to lose it.
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
    mark_recorded(conn, &ack.run_id, ack.checkpoint_seq)?;
    Ok(recover::cleanup_receipts_through(
        conn,
        journal_epoch,
        ack.receipt_through_seq as i64,
    )?)
}

/// Stamp the journal checkpoint row the server acked as `recorded`. Only a verified recorded ack
/// reaches here, and the stamp is on the exact (run, seq) the ack names, so an ack for a seq this
/// journal never produced marks nothing rather than inventing a watermark.
fn mark_recorded(
    conn: &Connection,
    run_id: &str,
    checkpoint_seq: u64,
) -> Result<(), WatermarkError> {
    conn.execute(
        "UPDATE checkpoint SET acked = 1 WHERE run_id = ?1 AND checkpoint_seq = ?2",
        params![run_id, checkpoint_seq as i64],
    )?;
    Ok(())
}

/// Every Run's highest durably acked checkpoint, the resume rebuild source for the finish's
/// recorded-checkpoint gate. Monotonic by construction: the stamp names the acked row itself, so the
/// max over acked rows cannot go backwards and a stale ack cannot lower it.
pub fn recorded_watermarks(conn: &Connection) -> Result<Vec<(String, u64)>, WatermarkError> {
    let mut stmt = conn.prepare(
        "SELECT run_id, MAX(checkpoint_seq) FROM checkpoint WHERE acked = 1 GROUP BY run_id",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
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
    use crate::finish::ack;
    use crate::frame::{checkpoint, finish, sign};
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

    #[test]
    fn lost_ack_reconnect_and_permanent_loss_keep_cleanup_monotonic() {
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
        seed_receipts(&conn, 2);
        conn.execute(
            "INSERT INTO checkpoint (run_id, checkpoint_seq, schema_version, runtime_digest,
             checkpoint_hash, pending_operation_set_hash) VALUES ('run',1,2,'runtime','cp','set')",
            [],
        )
        .unwrap();
        recover::persist_finish(
            &conn,
            &FinishRow {
                run_id: "run".into(),
                finish_id: "f1".into(),
                outcome: "failed".into(),
                reason: Some("model_error".into()),
                final_checkpoint_seq: Some(1),
                final_checkpoint_hash: Some("cp".into()),
                signed_bytes: b"sig".to_vec(),
                signed_hash: "h".into(),
                ack_state: None,
                terminal_run_revision: None,
            },
        )
        .unwrap();
        let server = SoftwareKey::random();
        let mut finish_ack = crate::frame::finish::RunFinishAckBody {
            finish_id: "f1".into(),
            state: "accepted".into(),
            code: None,
            terminal_run_revision: Some(7),
            expected_operation_set_hash: "set".into(),
            unresolved_operations: vec![],
            signature: None,
        };
        finish_ack.signature = Some(
            sign::sign_frame(
                &server,
                finish::FINISH_ACK_FRAME_TYPE,
                &finish_ack.to_value(),
            )
            .unwrap(),
        );
        let checkpoint_ack = signed_ack(&server, "recorded", 2);

        // The transport drops before the finish ack arrives. Reopening the journal models a
        // reconnect; only the verified server ack makes the Run terminal.
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        assert!(!recover::is_run_terminal(&conn, "run").unwrap());
        assert!(matches!(
            ack::apply_finish_ack(&conn, &server.public_jwk(), "run", &finish_ack),
            Ok(ack::FinishAckOutcome::Accepted {
                terminal_run_revision: 7
            })
        ));
        assert!(recover::is_run_terminal(&conn, "run").unwrap());
        let mut gate = TombstoneGate {
            finish_accepted: true,
            final_operation_set_hash_verified: true,
            receipt_through_seq_continuous: false,
            all_resolutions_received: true,
        };
        assert_eq!(cleanup_tombstones(&conn, "run", &gate).unwrap(), 0);
        assert_eq!(
            apply_receipt_watermark(&conn, &server.public_jwk(), "epoch-1", &checkpoint_ack)
                .unwrap(),
            2
        );
        gate.receipt_through_seq_continuous = true;
        assert_eq!(cleanup_tombstones(&conn, "run", &gate).unwrap(), 1);

        // Permanent loss: no further network ack is needed for the durable terminal tombstone
        // or cleanup state. Replaying both signed acks after another reopen changes nothing.
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        assert!(recover::is_run_terminal(&conn, "run").unwrap());
        assert_eq!(cleanup_tombstones(&conn, "run", &gate).unwrap(), 0);
        ack::apply_finish_ack(&conn, &server.public_jwk(), "run", &finish_ack).unwrap();
        assert_eq!(
            apply_receipt_watermark(&conn, &server.public_jwk(), "epoch-1", &checkpoint_ack)
                .unwrap(),
            0
        );
        assert_eq!(cleanup_tombstones(&conn, "run", &gate).unwrap(), 0);
        assert!(recover::is_run_terminal(&conn, "run").unwrap());
        let finishes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM runtime_finish WHERE run_id='run'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(finishes, 1);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}
