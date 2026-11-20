//! The unknown-blocking guard (device-design §6.2 :296). While a Run has an
//! unreconciled `unknown`, the server rejects new `action_prepare` and permits
//! (`run_has_unreconciled_operation`); the device mirrors this and treats it as
//! waiting-for-reconcile, not a reconnect. It must not change logical_key to
//! bypass, treat the rejection as proof of non-execution, or restart the loop.
//! Lease renewal, receipt/checkpoint uplink and resolution receive are NOT blocked
//! — they must stay available so late receipts can return and unknowns can resolve.

use rusqlite::Connection;

use crate::journal::recover;

/// The public code mirrored from the control plane (§6.2).
pub const RUN_HAS_UNRECONCILED_OPERATION: &str = "run_has_unreconciled_operation";

/// Whether a new action/permit may proceed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuardDecision {
    Allow,
    Block(&'static str),
}

/// Guard a new `action_prepare`/permit. Blocked while the Run has unreconciled
/// unknown; this is the only device-visible form of "unknown blocks continuation".
pub fn check_action_prepare(conn: &Connection, run_id: &str) -> rusqlite::Result<GuardDecision> {
    if recover::unreconciled_unknown_count(conn, run_id)? > 0 {
        Ok(GuardDecision::Block(RUN_HAS_UNRECONCILED_OPERATION))
    } else {
        Ok(GuardDecision::Allow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{meta, record, schema};

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("work-reconcile-guard-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        schema::apply(&conn).unwrap();
        meta::init(&conn, "dev", "epoch-1", schema::SCHEMA_VERSION, &[0u8; 32]).unwrap();
        (conn, path)
    }

    fn seed(conn: &Connection, op: &str, state: &str) {
        record::append_action(
            conn,
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
                operation_id: op,
                run_id: "run",
                attempt: "attempt-1",
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
    fn unknown_blocks_action_prepare() {
        let (conn, path) = temp_conn();
        seed(&conn, "op1", "unknown");
        assert_eq!(
            check_action_prepare(&conn, "run").unwrap(),
            GuardDecision::Block(RUN_HAS_UNRECONCILED_OPERATION)
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolved_run_allows_action_prepare() {
        let (conn, path) = temp_conn();
        seed(&conn, "op1", "unknown");
        recover::apply_resolution(&conn, "org", "op1", "failed", 1).unwrap();
        assert_eq!(
            check_action_prepare(&conn, "run").unwrap(),
            GuardDecision::Allow
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn no_unknown_allows_action_prepare() {
        let (conn, path) = temp_conn();
        seed(&conn, "op1", "completed");
        assert_eq!(
            check_action_prepare(&conn, "run").unwrap(),
            GuardDecision::Allow
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
