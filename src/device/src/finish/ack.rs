//! Consume the server's `run_finish_ack` (device-design §3.4 step 4, §6.3; control §6.4).
//!
//! The verdict is server-signed and verified against the hello_ack key BEFORE any journal row
//! moves — fail-closed, no optional-signature shim (GW8 precedent). An `accepted` verdict records
//! `terminal_run_revision` and is what makes the Run terminal locally (`is_run_terminal`) and
//! opens the cleanup watermark (B03 carrier §3.2). A `rejected` verdict only stops that finish_id
//! being replayed: it never changes the local outcome, deliverables or signed bytes, because
//! §3.4 step 4 says a refusal does not rewrite local facts — repairing means a NEW finish_id over
//! the current facts, and `stale_fence` means stop proposing at all.

use rusqlite::Connection;

use crate::frame::finish::RunFinishAckBody;
use crate::journal::recover;
use crate::jwk::EcP256Jwk;

/// What consuming a verdict did. `UnknownFinish` means this device never proposed that
/// finish_id, so nothing was written — the ack names only finish_id, never run_id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FinishAckOutcome {
    Accepted { terminal_run_revision: u64 },
    Rejected { code: String },
    UnknownFinish,
}

/// A run_finish_ack consumption failure.
#[derive(Debug)]
pub enum FinishAckError {
    Signature,
    Malformed,
    Sql(rusqlite::Error),
}

impl From<rusqlite::Error> for FinishAckError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Sql(err)
    }
}

/// Apply one verdict to the journal's `runtime_finish` row. Re-applying the same verdict is
/// idempotent (the UPDATE writes the same values), which is what a re-delivered ack after a lost
/// transport needs.
pub fn apply_finish_ack(
    conn: &Connection,
    jwk: &EcP256Jwk,
    run_id: &str,
    ack: &RunFinishAckBody,
) -> Result<FinishAckOutcome, FinishAckError> {
    if !ack.verify(jwk) {
        return Err(FinishAckError::Signature);
    }
    if !ack.verdict_consistent() {
        return Err(FinishAckError::Malformed);
    }
    if recover::read_finish(conn, run_id, &ack.finish_id)?.is_none() {
        return Ok(FinishAckOutcome::UnknownFinish);
    }
    if ack.is_accepted() {
        let revision = ack.terminal_run_revision.ok_or(FinishAckError::Malformed)?;
        recover::set_finish_ack(
            conn,
            run_id,
            &ack.finish_id,
            "accepted",
            Some(revision as i64),
        )?;
        Ok(FinishAckOutcome::Accepted {
            terminal_run_revision: revision,
        })
    } else {
        let code = ack.code.clone().ok_or(FinishAckError::Malformed)?;
        recover::set_finish_ack(conn, run_id, &ack.finish_id, "rejected", None)?;
        Ok(FinishAckOutcome::Rejected { code })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::finish::FINISH_ACK_FRAME_TYPE;
    use crate::frame::sign;
    use crate::journal::{meta, schema};
    use crate::key::{DeviceKey, SoftwareKey};

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("work-finish-ack-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        schema::apply(&conn).unwrap();
        meta::init(&conn, "dev", "epoch-1", schema::SCHEMA_VERSION, &[0u8; 32]).unwrap();
        (conn, path)
    }

    fn proposed(conn: &Connection) {
        recover::persist_finish(
            conn,
            &recover::FinishRow {
                run_id: "run-1".into(),
                finish_id: "finish-1".into(),
                outcome: "failed".into(),
                reason: Some("model_error".into()),
                final_checkpoint_seq: Some(4),
                final_checkpoint_hash: Some("a".repeat(64)),
                signed_bytes: b"original-signed-bytes".to_vec(),
                signed_hash: "b".repeat(64),
                ack_state: None,
                terminal_run_revision: None,
            },
        )
        .unwrap();
    }

    fn signed_ack(
        server: &SoftwareKey,
        state: &str,
        code: Option<&str>,
        revision: Option<u64>,
    ) -> RunFinishAckBody {
        let mut body = RunFinishAckBody {
            finish_id: "finish-1".into(),
            state: state.into(),
            code: code.map(str::to_string),
            terminal_run_revision: revision,
            expected_operation_set_hash: "c".repeat(64),
            unresolved_operations: vec![],
            signature: None,
        };
        let unsigned = body.to_value();
        body.signature = Some(sign::sign_frame(server, FINISH_ACK_FRAME_TYPE, &unsigned).unwrap());
        body
    }

    #[test]
    fn accepted_verdict_records_the_terminal_revision() {
        let (conn, path) = temp_conn();
        proposed(&conn);
        let server = SoftwareKey::random();
        let ack = signed_ack(&server, "accepted", None, Some(7));
        let out = apply_finish_ack(&conn, &server.public_jwk(), "run-1", &ack).unwrap();
        assert_eq!(
            out,
            FinishAckOutcome::Accepted {
                terminal_run_revision: 7
            }
        );
        let row = recover::read_finish(&conn, "run-1", "finish-1")
            .unwrap()
            .unwrap();
        assert_eq!(row.ack_state.as_deref(), Some("accepted"));
        assert_eq!(row.terminal_run_revision, Some(7));
        // The acceptance is the local Run tombstone and leaves the replay window.
        assert!(recover::is_run_terminal(&conn, "run-1").unwrap());
        assert!(recover::pending_finishes(&conn).unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejected_verdict_stops_replay_without_rewriting_local_facts() {
        let (conn, path) = temp_conn();
        proposed(&conn);
        let server = SoftwareKey::random();
        let ack = signed_ack(&server, "rejected", Some("finish_state_mismatch"), None);
        let out = apply_finish_ack(&conn, &server.public_jwk(), "run-1", &ack).unwrap();
        assert_eq!(
            out,
            FinishAckOutcome::Rejected {
                code: "finish_state_mismatch".into()
            }
        );
        let row = recover::read_finish(&conn, "run-1", "finish-1")
            .unwrap()
            .unwrap();
        assert_eq!(row.ack_state.as_deref(), Some("rejected"));
        assert_eq!(row.terminal_run_revision, None);
        // §3.4 step 4: the refusal does not change the outcome, the reason or the signed bytes.
        assert_eq!(row.outcome, "failed");
        assert_eq!(row.reason.as_deref(), Some("model_error"));
        assert_eq!(row.signed_bytes, b"original-signed-bytes");
        // A rejected proposal is not a terminal Run, and it is not replayed either: repair
        // means a NEW finish_id, never re-sending this one.
        assert!(!recover::is_run_terminal(&conn, "run-1").unwrap());
        assert!(recover::pending_finishes(&conn).unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unsigned_or_tampered_verdict_moves_nothing() {
        let (conn, path) = temp_conn();
        proposed(&conn);
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();

        let mut unsigned = signed_ack(&server, "accepted", None, Some(7));
        unsigned.signature = None;
        assert!(matches!(
            apply_finish_ack(&conn, &jwk, "run-1", &unsigned),
            Err(FinishAckError::Signature)
        ));

        let mut tampered = signed_ack(&server, "accepted", None, Some(7));
        tampered.terminal_run_revision = Some(99);
        assert!(matches!(
            apply_finish_ack(&conn, &jwk, "run-1", &tampered),
            Err(FinishAckError::Signature)
        ));

        // A verdict signed as another frame type is not this verdict.
        let mut wrong_type = signed_ack(&server, "accepted", None, Some(7));
        wrong_type.signature = None;
        wrong_type.signature = Some(
            sign::sign_frame(
                &server,
                crate::frame::offer::OFFER_FRAME_TYPE,
                &wrong_type.to_value(),
            )
            .unwrap(),
        );
        assert!(matches!(
            apply_finish_ack(&conn, &jwk, "run-1", &wrong_type),
            Err(FinishAckError::Signature)
        ));

        let row = recover::read_finish(&conn, "run-1", "finish-1")
            .unwrap()
            .unwrap();
        assert_eq!(row.ack_state, None);
        assert_eq!(row.terminal_run_revision, None);
        assert_eq!(recover::pending_finishes(&conn).unwrap().len(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unknown_finish_id_writes_no_row() {
        let (conn, path) = temp_conn();
        let server = SoftwareKey::random();
        let ack = signed_ack(&server, "accepted", None, Some(7));
        let out = apply_finish_ack(&conn, &server.public_jwk(), "run-1", &ack).unwrap();
        assert_eq!(out, FinishAckOutcome::UnknownFinish);
        assert!(recover::read_finish(&conn, "run-1", "finish-1")
            .unwrap()
            .is_none());
        assert!(!recover::is_run_terminal(&conn, "run-1").unwrap());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn malformed_verdict_is_refused() {
        let (conn, path) = temp_conn();
        proposed(&conn);
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        // accepted without a revision, and rejected with an unknown code: both are protocol
        // breaks, not verdicts the device may act on.
        for ack in [
            signed_ack(&server, "accepted", None, None),
            signed_ack(&server, "rejected", Some("made_up"), None),
            signed_ack(&server, "rejected", Some("stale_fence"), Some(7)),
        ] {
            assert!(matches!(
                apply_finish_ack(&conn, &jwk, "run-1", &ack),
                Err(FinishAckError::Malformed)
            ));
        }
        let row = recover::read_finish(&conn, "run-1", "finish-1")
            .unwrap()
            .unwrap();
        assert_eq!(row.ack_state, None);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reapplying_the_same_verdict_is_idempotent() {
        let (conn, path) = temp_conn();
        proposed(&conn);
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        let ack = signed_ack(&server, "accepted", None, Some(7));
        let first = apply_finish_ack(&conn, &jwk, "run-1", &ack).unwrap();
        let second = apply_finish_ack(&conn, &jwk, "run-1", &ack).unwrap();
        assert_eq!(first, second);
        let row = recover::read_finish(&conn, "run-1", "finish-1")
            .unwrap()
            .unwrap();
        assert_eq!(row.terminal_run_revision, Some(7));
        let _ = std::fs::remove_file(path);
    }
}
