//! The five-step finish proposal production (device-design §3.4 steps 1-3). The sync core calls this
//! once the Node loop ends (the candidate signal) and the Run's operations have reconciled terminal.
//! Step 1 (stop the sidecar) is the caller's job; this module does steps 2-3: judge the outcome ONLY
//! from journal/receipt/sealed-deliverable facts (never Node's self-report), compute the
//! `final_operation_set_hash` byte-for-byte as the server does, and durably persist the signed
//! `runtime_finish` row BEFORE the caller uplinks `run_finish`. A re-send (lost ack or restart)
//! replays the stored row's same finish_id and same signed bytes — never a re-judgment (§3.4 step 3).

use rusqlite::Connection;

use crate::finish::facts;
use crate::finish::outcome::{self, Outcome, RunFacts};
use crate::frame::finish::{RunFinishBody, FINISH_FRAME_TYPE};
use crate::journal::recover::{self, FinishRow};
use crate::key::DeviceKey;
use crate::transport::UplinkFrame;

/// The facts the sync core supplies for one finish judgment. The journal-derived parts (operation
/// terminality, receipts, the operation-set hash) are read inside [`judge_and_propose`]; these are
/// the execution facts only the sync core holds — the loop-end signal, the sealed deliverable versions
/// the Broker itself wrote, the undelivered-dispatch set reconciled from resolutions, and the final
/// checkpoint the server has recorded.
pub struct FinishInput {
    pub run_id: String,
    pub org_id: String,
    pub journal_epoch: String,
    pub binding_revision: u64,
    pub fence: u64,
    pub lease_id: String,
    /// The Node loop reached LOOP_END normally (vs an abnormal end / kill).
    pub loop_ended_normally: bool,
    /// The artifact.write version ids the Broker executed and sealed this Run (its own deliverable
    /// facts, not Node's self-reported list — DD:137).
    pub deliverables: Vec<String>,
    /// A model dispatch still pending/undelivered (reconciled from resolution delivery_state;
    /// superseded excluded). Blocks `completed` (§3.4 step 2).
    pub has_pending_model_dispatch: bool,
    pub model_error: bool,
    pub tool_limit_hit: bool,
    pub runtime_limit_exceeded: bool,
    pub runtime_unresumable: bool,
    pub checkpoint_lost: bool,
    pub input_missing: bool,
    /// The latest checkpoint the server has RECORDED (finish references it; 0059 compares
    /// final_checkpoint_seq/hash against the recorded row).
    pub final_checkpoint_seq: u64,
    pub final_checkpoint_hash: String,
    /// The device's receipt watermark (MAX produced seq = the server's MAX device_receipt seq).
    pub receipt_through_seq: u64,
}

/// A persisted, signed finish proposal ready to uplink (and replay verbatim).
pub struct FinishProposal {
    pub finish_id: String,
    pub outcome: Outcome,
    pub frame: UplinkFrame,
}

/// A finish production failure.
#[derive(Debug)]
pub enum FinishError {
    Sql(rusqlite::Error),
    Sign(crate::frame::sign::SignError),
}

impl From<rusqlite::Error> for FinishError {
    fn from(err: rusqlite::Error) -> Self {
        FinishError::Sql(err)
    }
}

impl From<crate::frame::sign::SignError> for FinishError {
    fn from(err: crate::frame::sign::SignError) -> Self {
        FinishError::Sign(err)
    }
}

/// The result of attempting a finish: either the Run is not yet judgeable (operations still
/// non-terminal or unreceipted — wait for reconcile), or a proposal was persisted and is ready to
/// uplink.
pub enum FinishAttempt {
    Wait,
    Proposed(FinishProposal),
}

/// Judge the outcome and persist the signed proposal (steps 2-3). Returns [`FinishAttempt::Wait`]
/// while any operation is non-terminal or lacks its completed receipt — the device reconciles (waits
/// for resolutions / re-uploads receipts) rather than proposing prematurely. The caller uplinks the
/// returned frame and replays it verbatim until the server ack is durable.
pub fn judge_and_propose(
    conn: &Connection,
    key: &dyn DeviceKey,
    input: &FinishInput,
) -> Result<FinishAttempt, FinishError> {
    // Step 2 gate: every operation terminal AND receipted. A non-terminal operation awaits its
    // resolution; proposing now would mismatch the server's operation-set hash.
    if !facts::all_operations_terminal(conn, &input.org_id, &input.run_id)?
        || !facts::operations_receipted(conn, &input.org_id, &input.run_id, &input.journal_epoch)?
    {
        return Ok(FinishAttempt::Wait);
    }
    let run_facts = RunFacts {
        loop_ended_normally: input.loop_ended_normally,
        all_operations_terminal: true,
        receipts_in_outbox: true,
        has_pending_model_dispatch: input.has_pending_model_dispatch,
        deliverable_count: input.deliverables.len(),
        input_missing: input.input_missing,
        checkpoint_lost: input.checkpoint_lost,
        runtime_unresumable: input.runtime_unresumable,
        runtime_limit_exceeded: input.runtime_limit_exceeded,
        tool_limit_hit: input.tool_limit_hit,
        model_error: input.model_error,
    };
    let outcome = outcome::determine_outcome(&run_facts);
    let operation_set_hash =
        facts::final_operation_set_hash(conn, &input.org_id, &input.run_id, &input.journal_epoch)?;

    // A completed finish names the deliverable versions; a failed one carries none (§3.4 step 2).
    let deliverable_versions = match &outcome {
        Outcome::Completed => input.deliverables.clone(),
        Outcome::Failed { .. } => Vec::new(),
    };
    let finish_id = uuid::Uuid::new_v4().to_string();
    let mut body = RunFinishBody {
        finish_id: finish_id.clone(),
        run_id: input.run_id.clone(),
        binding_revision: input.binding_revision,
        fence: input.fence,
        lease_id: input.lease_id.clone(),
        outcome: String::new(),
        reason_code: None,
        final_checkpoint_seq: input.final_checkpoint_seq,
        final_checkpoint_hash: input.final_checkpoint_hash.clone(),
        receipt_through_seq: input.receipt_through_seq,
        final_operation_set_hash: operation_set_hash,
        deliverable_versions,
        signature: None,
    };
    body.apply_outcome(&outcome);
    body.sign(key)?;
    let signed_value = body.to_value();
    let signed_bytes = serde_json::to_vec(&signed_value).expect("run_finish body serializes");
    let signed_hash = format!("sha256:{}", crate::sha256_hex(&signed_bytes));
    let (reason, checkpoint_seq, checkpoint_hash) = match &outcome {
        Outcome::Completed => (
            None,
            input.final_checkpoint_seq,
            input.final_checkpoint_hash.clone(),
        ),
        Outcome::Failed { reason_code } => (
            Some(reason_code.clone()),
            input.final_checkpoint_seq,
            input.final_checkpoint_hash.clone(),
        ),
    };
    // Step 3: the durable runtime_finish row is written (FULL commit) BEFORE the uplink. INSERT OR
    // IGNORE keeps a re-send idempotent by (run_id, finish_id); the stored bytes are the signed body
    // the link re-wraps in the current transport envelope on replay.
    recover::persist_finish(
        conn,
        &FinishRow {
            run_id: input.run_id.clone(),
            finish_id: finish_id.clone(),
            outcome: body.outcome.clone(),
            reason,
            final_checkpoint_seq: Some(checkpoint_seq as i64),
            final_checkpoint_hash: Some(checkpoint_hash),
            signed_bytes,
            signed_hash,
            ack_state: None,
            terminal_run_revision: None,
        },
    )?;
    Ok(FinishAttempt::Proposed(FinishProposal {
        finish_id,
        outcome,
        frame: UplinkFrame {
            frame_type: FINISH_FRAME_TYPE.to_string(),
            body: signed_value,
        },
    }))
}

/// Replay a persisted, un-acked finish proposal verbatim (same finish_id, same signed body bytes —
/// §3.4 step 3, restart or lost ack). The stored row is the authority; nothing is re-judged.
pub fn replay_frame(row: &FinishRow) -> UplinkFrame {
    let body: serde_json::Value =
        serde_json::from_slice(&row.signed_bytes).expect("stored run_finish body is JSON");
    UplinkFrame {
        frame_type: FINISH_FRAME_TYPE.to_string(),
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{meta, record, schema};
    use crate::key::SoftwareKey;

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("work-finish-orch-{}.db", uuid::Uuid::new_v4()));
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

    fn succeeded_write(conn: &Connection, op: &str) {
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
                state: "succeeded",
                result_hash: None,
                result_ref: None,
            },
            b"body",
        )
        .unwrap();
        let env = serde_json::json!({
            "schema_version": 2, "type": "receipt", "device_id": "dev",
            "body": { "operation_id": op, "state": "completed", "result_hash": "a".repeat(64) },
        });
        record::insert_receipt(
            conn,
            "epoch-1",
            1,
            &record::ReceiptRow {
                operation_id: op,
                state: "completed",
                signed_bytes: &serde_json::to_vec(&env).unwrap(),
                signed_hash: "h",
            },
        )
        .unwrap();
        // produce_receipt stamps the completed receipt's result_hash onto the durable journal row;
        // the finish facts read that (the outbox is transient). Mirror it here.
        conn.execute(
            "UPDATE action_journal SET result_hash = ?1, result_ref = ?2
             WHERE org_id = 'org' AND run_id = 'run' AND operation_id = ?3",
            rusqlite::params!["a".repeat(64), format!("run:{op}"), op],
        )
        .unwrap();
    }

    fn input() -> FinishInput {
        FinishInput {
            run_id: "run".into(),
            org_id: "org".into(),
            journal_epoch: "epoch-1".into(),
            binding_revision: 1,
            fence: 2,
            lease_id: "lease".into(),
            loop_ended_normally: true,
            deliverables: vec!["v-1".into()],
            has_pending_model_dispatch: false,
            model_error: false,
            tool_limit_hit: false,
            runtime_limit_exceeded: false,
            runtime_unresumable: false,
            checkpoint_lost: false,
            input_missing: false,
            final_checkpoint_seq: 2,
            final_checkpoint_hash: "c".repeat(64),
            receipt_through_seq: 1,
        }
    }

    #[test]
    fn completed_run_persists_a_signed_proposal_matching_the_server_hash() {
        let (conn, path) = temp_conn();
        succeeded_write(&conn, "op-1");
        let key = SoftwareKey::random();
        let jwk = key.public_jwk();
        let inp = input();
        let attempt = judge_and_propose(&conn, &key, &inp).unwrap();
        let FinishAttempt::Proposed(proposal) = attempt else {
            panic!("expected a proposal");
        };
        assert_eq!(proposal.outcome, Outcome::Completed);
        assert_eq!(proposal.frame.frame_type, FINISH_FRAME_TYPE);
        assert_eq!(proposal.frame.body["outcome"], "completed");
        assert!(proposal.frame.body["reason_code"].is_null());
        assert_eq!(proposal.frame.body["deliverable_versions"][0], "v-1");
        assert_eq!(proposal.frame.body["final_checkpoint_seq"], "2");
        assert_eq!(proposal.frame.body["receipt_through_seq"], "1");
        // The operation-set hash matches the journal-derived formula (bare hex).
        let expected = facts::final_operation_set_hash(&conn, "org", "run", "epoch-1").unwrap();
        assert_eq!(proposal.frame.body["final_operation_set_hash"], expected);
        let sig = proposal.frame.body["signature"].as_str().unwrap();
        assert!(crate::frame::sign::verify_frame(
            &jwk,
            FINISH_FRAME_TYPE,
            &proposal.frame.body,
            sig
        ));
        // The durable row stores the same signed bytes (replay authority).
        let row = recover::read_finish(&conn, "run", &proposal.finish_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.outcome, "completed");
        assert_eq!(row.ack_state, None);
        let replay = replay_frame(&row);
        assert_eq!(replay.body, proposal.frame.body);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn non_terminal_operation_waits_for_reconcile() {
        let (conn, path) = temp_conn();
        succeeded_write(&conn, "op-1");
        // A second operation still dispatching → not judgeable yet.
        record::append_action(
            &conn,
            &[3u8; 32],
            &ctx(),
            &record::ActionRow {
                org_id: "org",
                operation_id: "op-2",
                run_id: "run",
                attempt: "attempt-2",
                step_key: "tool:1:0",
                logical_key: "op-2",
                supersedes: None,
                request_hash: "hash",
                fence: 2,
                session_id: "sess",
                generation: 1,
                permit_jti: "op-2",
                state: "dispatching",
                result_hash: None,
                result_ref: None,
            },
            b"body",
        )
        .unwrap();
        let key = SoftwareKey::random();
        assert!(matches!(
            judge_and_propose(&conn, &key, &input()).unwrap(),
            FinishAttempt::Wait
        ));
        assert!(recover::pending_finishes(&conn).unwrap().is_empty());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn model_only_run_fails_no_deliverable() {
        let (conn, path) = temp_conn();
        // No dispatched operations, no deliverable: the loop ended normally but wrote nothing.
        let key = SoftwareKey::random();
        let mut inp = input();
        inp.deliverables = vec![];
        let FinishAttempt::Proposed(proposal) = judge_and_propose(&conn, &key, &inp).unwrap()
        else {
            panic!("expected a proposal");
        };
        assert_eq!(
            proposal.outcome,
            Outcome::Failed {
                reason_code: "no_deliverable".into()
            }
        );
        assert_eq!(proposal.frame.body["outcome"], "failed");
        assert_eq!(proposal.frame.body["reason_code"], "no_deliverable");
        assert!(proposal.frame.body["deliverable_versions"]
            .as_array()
            .unwrap()
            .is_empty());
        // No operations → the empty-set hash.
        assert_eq!(
            proposal.frame.body["final_operation_set_hash"],
            crate::sha256_hex(b"[]")
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn undelivered_dispatch_blocks_completed() {
        let (conn, path) = temp_conn();
        succeeded_write(&conn, "op-1");
        let key = SoftwareKey::random();
        let mut inp = input();
        inp.has_pending_model_dispatch = true;
        let FinishAttempt::Proposed(proposal) = judge_and_propose(&conn, &key, &inp).unwrap()
        else {
            panic!("expected a proposal");
        };
        assert!(matches!(proposal.outcome, Outcome::Failed { .. }));
        assert_eq!(proposal.frame.body["outcome"], "failed");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
