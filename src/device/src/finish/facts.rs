//! The journal-derived facts the Broker judges a Run finish from (device-design §3.4 steps 1-2).
//! DD:137 — the outcome is judged ONLY from the journal, receipts and sealed deliverables, never
//! Node's self-report. These queries mirror the server's `work.local_operation_set_hash` (0042:641)
//! and `finish_local_run` (0059) preconditions byte for byte:
//!
//! * the operation set is every `action_journal` row of the Run (the dispatched operations the server
//!   also has in `work.operation`), sorted by `operation_id` text ascending;
//! * `state` is the journal row's state, which `operation_resolution` advances to the server's
//!   terminal value (succeeded/failed/canceled/reconciled — there is no `completed` operation state);
//! * `result_hash` is the completed ACTION receipt's bare-hex value stamped onto the journal row by
//!   `produce_receipt` (NULL → empty when no completed ACTION receipt), exactly the server's
//!   `device_receipt` subquery. Independent model results do not enter this hash; their acknowledged
//!   outbox rows satisfy the separate completion gate without consuming an ACTION receipt sequence.

use rusqlite::{params, Connection};

use crate::finish::ophash::{self, OperationSummary};

/// The terminal `work.operation` states (0002:177 CHECK; 0021:299). An operation still in
/// prepared/waiting_approval/authorized/dispatching/unknown/unresolved is non-terminal and blocks a
/// `completed` finish — the device waits for its resolution (reconcile) rather than guessing.
pub const TERMINAL_OPERATION_STATES: &[&str] = &["succeeded", "failed", "canceled", "reconciled"];

/// Whether an operation state is terminal (the server's `finish_local_run` completed gate).
pub fn is_terminal_state(state: &str) -> bool {
    TERMINAL_OPERATION_STATES.contains(&state)
}

/// Every operation of the Run as an [`OperationSummary`], sorted by `operation_id` text ascending —
/// the exact input `work.local_operation_set_hash` aggregates (superseded rows included; this period
/// produces no supersede rows, ruling 甲). `state` and `result_hash` are read from the DURABLE
/// action_journal row: the receipt outbox is transient (the checkpoint_ack watermark releases acked
/// receipts, B03 §3.2), so produce_receipt persists the completed receipt's result_hash onto the
/// action_journal row (NULL = no completed receipt → empty, mirroring the server's device_receipt
/// subquery; a set value, even empty, is the receipt's bare-hex hash).
pub fn operation_summaries(
    conn: &Connection,
    org_id: &str,
    run_id: &str,
    _journal_epoch: &str,
) -> rusqlite::Result<Vec<OperationSummary>> {
    let mut stmt = conn.prepare(
        "SELECT operation_id, state, COALESCE(result_hash, '') FROM action_journal
         WHERE org_id = ?1 AND run_id = ?2 ORDER BY operation_id ASC",
    )?;
    let rows = stmt.query_map(params![org_id, run_id], |r| {
        Ok(OperationSummary {
            operation_id: r.get::<_, String>(0)?,
            state: r.get::<_, String>(1)?,
            result_hash: r.get::<_, String>(2)?,
        })
    })?;
    let mut summaries = Vec::new();
    for row in rows {
        summaries.push(row?);
    }
    Ok(summaries)
}

/// The Run's `final_operation_set_hash` (DD:140 O-16=甲), computed over the journal operations exactly
/// as the server computes `work.local_operation_set_hash`.
pub fn final_operation_set_hash(
    conn: &Connection,
    org_id: &str,
    run_id: &str,
    journal_epoch: &str,
) -> rusqlite::Result<String> {
    let summaries = operation_summaries(conn, org_id, run_id, journal_epoch)?;
    Ok(ophash::final_operation_set_hash(&summaries))
}

/// Whether every operation of the Run has reached a terminal state. A Run with no dispatched
/// operations (a model-only turn that wrote no deliverable) is vacuously terminal — its finish fails
/// `no_deliverable`, it does not wait forever.
pub fn all_operations_terminal(
    conn: &Connection,
    org_id: &str,
    run_id: &str,
) -> rusqlite::Result<bool> {
    let mut stmt =
        conn.prepare("SELECT state FROM action_journal WHERE org_id = ?1 AND run_id = ?2")?;
    let rows = stmt.query_map(params![org_id, run_id], |r| r.get::<_, String>(0))?;
    for row in rows {
        if !is_terminal_state(&row?) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Whether every operation of the Run has a durable completion fact. ACTION operations use the
/// completed receipt's result_hash stamped onto action_journal; model operations use the independently
/// acknowledged model_result outbox row. Neither path consumes the other's sequence or watermark.
pub fn operations_receipted(
    conn: &Connection,
    org_id: &str,
    run_id: &str,
    journal_epoch: &str,
) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(
        "SELECT a.result_hash, a.resolution_revision, m.model_result_id
         FROM action_journal a
         LEFT JOIN model_result_outbox m
           ON m.operation_id = a.operation_id AND m.journal_epoch = ?3 AND m.acked = 1
         WHERE a.org_id = ?1 AND a.run_id = ?2",
    )?;
    let rows = stmt.query_map(params![org_id, run_id, journal_epoch], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, Option<i64>>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })?;
    for row in rows {
        let (result_hash, resolution_revision, model_result_id) = row?;
        if result_hash.is_none() && resolution_revision.is_none() && model_result_id.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{meta, record, schema};

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("work-finish-facts-{}.db", uuid::Uuid::new_v4()));
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

    fn action(conn: &Connection, op: &str, state: &str) {
        record::append_action(
            conn,
            &[3u8; 32],
            &ctx(),
            &record::ActionRow {
                org_id: "org",
                operation_id: op,
                run_id: "run",
                attempt: "attempt-1",
                step_key: "tool:0:0",
                logical_key: op,
                supersedes: None,
                request_hash: "hash",
                fence: 2,
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

    /// Stamp a completed receipt's result_hash onto the durable action_journal row, exactly as
    /// produce_receipt does (the outbox is transient; the finish facts read the journal row).
    fn stamp_receipt(conn: &Connection, op: &str, result_hash: &str) {
        conn.execute(
            "UPDATE action_journal SET result_hash = ?1, result_ref = ?2
             WHERE org_id = 'org' AND run_id = 'run' AND operation_id = ?3",
            params![result_hash, format!("run:{op}"), op],
        )
        .unwrap();
    }

    #[test]
    fn terminal_states_are_the_server_set() {
        for state in ["succeeded", "failed", "canceled", "reconciled"] {
            assert!(is_terminal_state(state));
        }
        for state in [
            "prepared",
            "waiting_approval",
            "authorized",
            "dispatching",
            "unknown",
            "unresolved",
            "started",
        ] {
            assert!(!is_terminal_state(state));
        }
    }

    #[test]
    fn summaries_mirror_the_server_hash_formula() {
        let (conn, path) = temp_conn();
        action(&conn, "op-b", "succeeded");
        action(&conn, "op-a", "failed");
        stamp_receipt(&conn, "op-b", &"b".repeat(64));
        // op-a has no completed receipt → empty result_hash.
        let summaries = operation_summaries(&conn, "org", "run", "epoch-1").unwrap();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].operation_id, "op-a"); // sorted ascending
        assert_eq!(summaries[0].result_hash, "");
        assert_eq!(summaries[1].operation_id, "op-b");
        assert_eq!(summaries[1].result_hash, "b".repeat(64));
        // The hash equals the ophash over the same sorted elements (bare hex, no sha256: prefix).
        let expected = ophash::final_operation_set_hash(&summaries);
        assert_eq!(
            final_operation_set_hash(&conn, "org", "run", "epoch-1").unwrap(),
            expected
        );
        assert_eq!(expected.len(), 64);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn durable_result_hash_survives_outbox_cleanup() {
        let (conn, path) = temp_conn();
        action(&conn, "op-1", "succeeded");
        stamp_receipt(&conn, "op-1", &"2".repeat(64));
        // The receipt outbox is released by the checkpoint_ack watermark (B03); the finish facts must
        // still read the result_hash from the durable action_journal row.
        crate::journal::recover::cleanup_receipts_through(&conn, "epoch-1", 9).unwrap();
        let summaries = operation_summaries(&conn, "org", "run", "epoch-1").unwrap();
        assert_eq!(summaries[0].result_hash, "2".repeat(64));
        assert!(operations_receipted(&conn, "org", "run", "epoch-1").unwrap());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn non_terminal_operation_blocks() {
        let (conn, path) = temp_conn();
        action(&conn, "op-1", "succeeded");
        assert!(all_operations_terminal(&conn, "org", "run").unwrap());
        action(&conn, "op-2", "dispatching");
        assert!(!all_operations_terminal(&conn, "org", "run").unwrap());
        // A resolution advances it terminal.
        crate::journal::recover::apply_resolution(&conn, "org", "op-2", "succeeded", 1).unwrap();
        assert!(all_operations_terminal(&conn, "org", "run").unwrap());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn empty_run_is_vacuously_terminal() {
        let (conn, path) = temp_conn();
        assert!(all_operations_terminal(&conn, "org", "run").unwrap());
        assert!(operations_receipted(&conn, "org", "run", "epoch-1").unwrap());
        assert_eq!(
            final_operation_set_hash(&conn, "org", "run", "epoch-1").unwrap(),
            crate::sha256_hex(b"[]")
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn acknowledged_model_result_satisfies_completion_without_action_receipt() {
        let (conn, path) = temp_conn();
        action(&conn, "op-model", "succeeded");
        assert!(!operations_receipted(&conn, "org", "run", "epoch-1").unwrap());
        conn.execute(
            "INSERT INTO model_result_outbox
             (model_result_id, journal_epoch, operation_id, state, signed_bytes, signed_hash, acked)
             VALUES (?1, 'epoch-1', 'op-model', 'completed', X'00', 'sha256:test', 0)",
            ["10000000-0000-0000-0000-000000000001"],
        )
        .unwrap();
        assert!(!operations_receipted(&conn, "org", "run", "epoch-1").unwrap());
        conn.execute(
            "UPDATE model_result_outbox SET acked = 1 WHERE operation_id = 'op-model'",
            [],
        )
        .unwrap();
        assert!(operations_receipted(&conn, "org", "run", "epoch-1").unwrap());
        let summaries = operation_summaries(&conn, "org", "run", "epoch-1").unwrap();
        assert_eq!(summaries[0].result_hash, "");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejected_model_result_is_not_replayed_and_server_resolution_can_complete_it() {
        let (conn, path) = temp_conn();
        action(&conn, "op-model", "unknown");
        conn.execute(
            "INSERT INTO model_result_outbox
             (model_result_id, journal_epoch, operation_id, state, signed_bytes, signed_hash, rejected)
             VALUES (?1, 'epoch-1', 'op-model', 'completed', X'00', 'sha256:test', 1)",
            ["10000000-0000-0000-0000-000000000001"],
        )
        .unwrap();
        assert!(
            crate::journal::recover::unacked_model_results(&conn, "epoch-1", 100)
                .unwrap()
                .is_empty()
        );
        assert!(!operations_receipted(&conn, "org", "run", "epoch-1").unwrap());
        crate::journal::recover::apply_resolution(&conn, "org", "op-model", "failed", 1).unwrap();
        assert!(operations_receipted(&conn, "org", "run", "epoch-1").unwrap());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn receipted_requires_a_completed_receipt_per_operation() {
        let (conn, path) = temp_conn();
        action(&conn, "op-1", "succeeded");
        assert!(!operations_receipted(&conn, "org", "run", "epoch-1").unwrap());
        stamp_receipt(&conn, "op-1", &"a".repeat(64));
        assert!(operations_receipted(&conn, "org", "run", "epoch-1").unwrap());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
