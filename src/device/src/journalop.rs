//! The journal-op channel (execution-face §6.1, batch 2 ruling 甲). The Node↔Broker pipe service loop
//! runs on its OWN blocking thread so the sync core stays responsive to cancel/lease (E7 甲 prompt
//! kill). But the journal has a SINGLE owner — the sync core thread (E4 甲, no cross-thread lock). So
//! the Node thread never touches the journal directly: it sends a [`JournalOp`] over this channel and
//! blocks on a one-shot reply; the sync core executes the op against its own journal in its event loop
//! (multiplexed with downlinks) and answers. This keeps every journal transaction on one thread while
//! letting the Node thread drive model/tool I/O concurrently.

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use rusqlite::OptionalExtension;

use crate::frame::{action, checkpoint, envelope, model_probe, model_result, receipt, rfc3339};
use crate::journal::record::{self, ActionRow, RecordError};
use crate::journal::{meta, recover};
use crate::key::DeviceKey;

pub use crate::journal::local_content::{
    DeliverableRow, LocalContentBody, LocalDraftBody, LocalDraftConfirmation, LocalDraftRow,
};
use crate::transport::UplinkFrame;

/// The device runtime instance facts bound into a receipt's historical envelope. They come from the
/// closed BrokerConfig (`agent_instance_id`/`boot_id`, the same facts the link stamps on every
/// envelope) and are provisioned to the sync core at startup. Owned/Send so the Node thread never
/// needs them — the sync core fills them when it signs.
pub struct InstanceFacts {
    pub agent_instance_id: String,
    pub boot_id: String,
}

/// The signing/uplink context the sync core supplies to journal-op production. The sync core is the
/// journal's sole owner AND holds the device key + the uplink sender (E4 甲), so receipt/checkpoint
/// production (allocate seq → sign → append → uplink) runs here, never on the Node thread. Pure ops
/// (register/read a permit jti) ignore it.
pub struct Producer<'a> {
    pub key: &'a dyn DeviceKey,
    pub uplinks: &'a mpsc::Sender<UplinkFrame>,
    pub instance: &'a InstanceFacts,
}

/// A journal operation the Node service thread requests of the sync core. Each variant is one atomic
/// journal transaction the sync core runs as the sole owner. The payloads are owned (moved across the
/// channel) so no reference escapes the Node thread.
pub enum JournalOp {
    /// Register a command/tool permit jti (DD:123): append the sealed action body in one transaction.
    /// A consumed jti surfaces as `RecordError::Sql` (the UNIQUE constraint), which the caller maps to
    /// "return the journal, never re-execute".
    RegisterAction {
        org_id: String,
        subject_id: String,
        row: Box<ActionRowOwned>,
        plaintext: Vec<u8>,
    },
    /// Read a previously registered action body (the consumed-jti path returns the journal).
    ReadAction {
        org_id: String,
        subject_id: String,
        operation_id: String,
    },
    /// Read a sealed checkpoint body back under the identity-bound AAD (recovery/reconcile, and the
    /// local-only device_local model turn fact the model receipt seals into the checkpoint plaintext).
    ReadCheckpoint {
        org_id: String,
        subject_id: String,
        run_id: String,
        checkpoint_seq: i64,
    },
    /// Read one encrypted local deliverable body for the viewer. The body never enters the journal
    /// reply's metadata path and is returned only to the Node service thread.
    ReadLocalContent {
        org_id: String,
        subject_id: String,
        version_id: String,
    },
    RecordLocalApproval {
        org_id: String,
        subject_id: String,
        approval_id: String,
        row: Box<DeliverableRow>,
        plaintext: Vec<u8>,
    },
    ReadLocalApproval {
        org_id: String,
        subject_id: String,
        approval_id: String,
    },
    PrepareLocalApprovalDecision {
        org_id: String,
        subject_id: String,
        device_id: String,
        session_id: String,
        input: Box<crate::approvaldecision::ApprovalDecisionInput>,
    },
    PrepareLocalAcceptance {
        org_id: String,
        subject_id: String,
        device_id: String,
        session_id: String,
        input: Box<crate::possession::PossessionInput>,
    },
    RecordLocalTranscript {
        org_id: String,
        subject_id: String,
        run_id: String,
        row: Box<DeliverableRow>,
        plaintext: Vec<u8>,
    },
    ReadLocalTranscript {
        org_id: String,
        subject_id: String,
        run_id: String,
    },
    PrepareLocalDraft {
        org_id: String,
        subject_id: String,
        row: Box<crate::journal::local_content::LocalDraftRow>,
        plaintext: Vec<u8>,
    },
    ReadLocalDraft {
        org_id: String,
        subject_id: String,
        version_id: String,
    },
    ListLocalDrafts {
        org_id: String,
        subject_id: String,
        artifact_id: String,
        task_id: String,
    },
    DecideLocalDraft {
        org_id: String,
        subject_id: String,
        request_id: String,
        sealed_hash: String,
        action: String,
    },
    ConfirmLocalDraft {
        org_id: String,
        subject_id: String,
        request_id: String,
        sealed_hash: String,
        device_id: String,
        session_id: String,
    },
    CompleteLocalDraft {
        org_id: String,
        subject_id: String,
        request_id: String,
        sealed_hash: String,
        publish_ack: String,
    },
    SetLocalDraftCopyState {
        org_id: String,
        subject_id: String,
        request_id: String,
        sealed_hash: String,
        state: String,
    },
    /// Produce a signed receipt (A3 uplink, execution-face §5/E5 甲): the sync core allocates the
    /// next receipt seq, binds it into the body, signs with the device key, appends the original
    /// signed envelope to `receipt_outbox` and uplinks the receipt — all in one journal transaction
    /// on the sole owner thread. The Node thread supplies only the execution facts (owned/Send).
    AppendReceipt {
        org_id: String,
        subject_id: String,
        facts: Box<ReceiptFacts>,
    },
    /// Persist and uplink an independent device_local model result. Its UUID is the
    /// replay key; this path never allocates an ACTION receipt sequence.
    AppendModelResult {
        org_id: String,
        subject_id: String,
        facts: Box<ModelResultFacts>,
    },
    PrepareModelProbeReceipts {
        org_id: String,
        subject_id: String,
        session_id: String,
        auth_epoch: u64,
    },
    ConfirmModelProbeReceiptDelivery {
        org_id: String,
        subject_id: String,
        session_id: String,
        model_result_id: String,
    },
    /// Persist an encrypted checkpoint and uplink a signed `checkpoint_commit` (A3, DD:133 the
    /// checkpoint precedes prepare/finish). The sealed canonical body stays local; the commit
    /// carries only hashes + an opaque ref (never ciphertext).
    PersistCheckpoint {
        org_id: String,
        subject_id: String,
        facts: Box<CheckpointFacts>,
        plaintext: Vec<u8>,
    },
    /// Propose one action (A2 write spine, execution-face §6.3 C): the sync core signs an
    /// `action_prepare` with the device key and uplinks it. The Node thread supplies the owned
    /// proposal facts (it owns the grant registry + tool args); the sync core holds the key + uplink
    /// sender (E4 甲). The server's prepare→permit→command round-trip returns the command downlink,
    /// which `consume_command` feeds to the live per-Run command map the executor waits on. This op
    /// only signs + uplinks (fire-and-forget); it does NOT wait for the command (that would deadlock
    /// the sync core, which processes the downlinks).
    ProposeAction {
        org_id: String,
        subject_id: String,
        facts: Box<ActionPrepareFacts>,
    },
    /// Record one sealed deliverable version the Broker itself wrote (a successful `artifact.write`).
    /// DD:137 — the finish judges deliverables from the Broker's own execution facts, not Node's
    /// self-reported list. The sync core intercepts this op (it owns the per-Run deliverable set the
    /// finish names in `deliverable_versions`, and the per-version facts batch 4's `local_publish`
    /// payload is built from); it writes no journal row.
    RecordDeliverable { facts: Box<DeliverableFacts> },
}

/// The owned facts of one sealed `artifact.write` deliverable (batch 4 publication). The Node thread
/// supplies them from the command + tool args + sealed-buffer result; the sync core fills the
/// identity facts it owns (device_id/journal_epoch) and the completed receipt's seq at publication
/// time. `logical_name` is derived from the args' `artifact_id` (lead ruling 甲 2026-11-21: a stable
/// per-artifact server UUID, so the tool schema/tool_manifest_hash stay unchanged); `content_hash`
/// is bare 64-hex (the `sha256:` sealed-buffer form stripped, 0043:218); `local_ref` is
/// `run_id:operation_id`, equal to the completed receipt's `local_result_ref` (0043:425 cross-check).
#[derive(Clone, Debug)]
pub struct DeliverableFacts {
    pub run_id: String,
    pub operation_id: String,
    pub version_id: String,
    pub logical_name: String,
    pub format: String,
    pub content_hash: String,
    pub byte_count: u64,
    pub sealed_blob: Vec<u8>,
    pub grant_id: String,
    pub root_identity_hash: String,
}

/// The owned `action_prepare` proposal facts the Node thread supplies (execution-face §6.3 C). The
/// sync core fills `prepare_id` and signs; every other field is a closed `ActionPrepareBody` member.
/// Fresh actions only this period (supersede is batch-3 reconcile scope), so the three supersede keys
/// are null. `grant_revision` comes from the offer's grant_set; `classification` is the device's claim
/// the server cross-checks against the grant; `resource_selector_hash` is derived from the tool args.
pub struct ActionPrepareFacts {
    pub run_id: String,
    pub lease_id: String,
    pub fence: u64,
    pub step_key: String,
    pub logical_key: String,
    pub checkpoint_seq: u64,
    pub checkpoint_hash: String,
    pub request_hash: String,
    pub action_kind: String,
    pub tool_schema: String,
    pub local_payload_ref: String,
    pub grant_id: String,
    pub grant_revision: u64,
    pub resource_selector_hash: String,
    pub classification: String,
    pub destination_id: Option<String>,
    pub byte_upper_bound: u64,
    pub token_upper_bound: u64,
}

/// The execution facts the Node thread supplies for one receipt. The identity facts the sync core
/// owns (device/agent_instance/boot/journal_epoch) and the allocated seq are filled at production;
/// `org`/`subject` ride the op envelope. `session_id`/`generation`/`fence` are the verified-session
/// facts forwarded at StartRun (E5 甲: RecordContext from the verified session, not the cert OU alone).
pub struct ReceiptFacts {
    pub operation_id: String,
    pub run_id: String,
    pub session_id: String,
    pub generation: u64,
    pub attempt: String,
    pub fence: u64,
    pub request_hash: String,
    pub state: String,
    pub outcome: Option<String>,
    pub result_hash: String,
    pub local_result_ref: String,
    pub model_delivery: Option<String>,
    pub usage: Option<Value>,
    pub usage_source: Option<String>,
    pub error_code: String,
}

/// The checkpoint facts the Node thread supplies. `checkpoint_seq` is the Run-local monotonic
/// sequence the executor assigns; the commit's `receipt_through_seq` is the receipt watermark the
/// checkpoint covers (the sync core's last produced seq at production time).
#[derive(Clone, Debug)]
pub struct ProbeResultMetadata {
    pub binding_id: String,
    pub probe_id: String,
    pub preview_hash: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ModelProbeReceiptProof {
    pub client_request_id: String,
    pub receipt: Value,
    pub signature: String,
}

#[derive(Clone, Debug)]
pub struct ModelResultFacts {
    pub run_id: String,
    pub operation_id: String,
    pub attempt_id: String,
    pub session_id: String,
    pub request_hash: String,
    pub state: String,
    pub outcome: Option<String>,
    pub result_hash: Option<String>,
    pub provider_request_id: Option<String>,
    pub model: String,
    pub usage: Option<model_result::ModelUsage>,
    pub error_code: Option<String>,
    pub probe: Option<ProbeResultMetadata>,
}

pub struct CheckpointFacts {
    pub run_id: String,
    pub checkpoint_seq: i64,
    pub schema_version: u32,
    pub runtime_digest: String,
    pub checkpoint_hash: String,
    pub pending_operation_set_hash: String,
    pub prior_receipt_ref: Option<String>,
    pub binding_revision: u64,
    pub fence: u64,
    pub local_checkpoint_ref: String,
}

/// The owned mirror of [`ActionRow`] (which borrows its strings). The Node thread builds this from the
/// command/tool facts; the sync core reborrow it into an `ActionRow` against its own journal context.
pub struct ActionRowOwned {
    pub org_id: String,
    pub operation_id: String,
    pub run_id: String,
    pub attempt: String,
    pub step_key: String,
    pub logical_key: String,
    pub supersedes: Option<String>,
    pub request_hash: String,
    pub fence: i64,
    pub session_id: String,
    pub generation: i64,
    pub permit_jti: String,
    pub state: String,
    pub result_hash: Option<String>,
    pub result_ref: Option<String>,
}

/// The sync core's reply to a [`JournalOp`].
#[derive(Debug)]
pub enum JournalReply {
    /// RegisterAction succeeded (the jti is now consumed).
    Registered,
    /// RegisterAction hit the consumed-jti UNIQUE constraint; the body is returned via ReadAction.
    JtiConsumed,
    /// ReadAction returned the sealed body (or an error).
    Action(Result<Vec<u8>, RecordError>),
    /// ReadCheckpoint returned the sealed checkpoint body (or an error).
    CheckpointBody(Result<Vec<u8>, RecordError>),
    /// ReadLocalContent returned an encrypted local deliverable body (or an error).
    LocalContent(Result<Option<crate::journal::local_content::LocalContentBody>, RecordError>),
    LocalApproval(Result<Option<crate::journal::local_content::LocalContentBody>, RecordError>),
    LocalApprovalDecision(Result<Option<Value>, RecordError>),
    LocalAcceptance(Result<Option<Value>, RecordError>),
    LocalTranscript(Result<Option<crate::journal::local_content::LocalContentBody>, RecordError>),
    LocalDraftPrepared(Result<crate::journal::local_content::LocalDraftBody, RecordError>),
    LocalDraft(Result<Option<crate::journal::local_content::LocalDraftBody>, RecordError>),
    LocalDrafts(Result<Vec<LocalDraftRow>, RecordError>),
    LocalDraftDecided(Result<Option<crate::journal::local_content::LocalDraftRow>, RecordError>),
    LocalDraftConfirmed(
        Result<Option<crate::journal::local_content::LocalDraftConfirmation>, RecordError>,
    ),
    LocalDraftCompleted(Result<Option<crate::journal::local_content::LocalDraftCopy>, RecordError>),
    LocalDraftCopyState(Result<bool, RecordError>),
    /// AppendReceipt produced and uplinked a signed receipt; carries its allocated seq + integrity
    /// hash so the caller can advance its watermark / reference the receipt.
    ReceiptProduced {
        seq: u64,
        signed_hash: String,
    },
    /// AppendModelResult persisted and uplinked one independently replayable result.
    ModelResultProduced {
        model_result_id: String,
        signed_hash: String,
    },
    ModelProbeReceiptsPrepared(Vec<ModelProbeReceiptProof>),
    ModelProbeReceiptDeliveryConfirmed(bool),
    /// PersistCheckpoint sealed the body and uplinked a signed checkpoint_commit.
    CheckpointProduced,
    /// ProposeAction signed and uplinked an action_prepare (the command returns via the downlink).
    Proposed,
    /// ProposeAction was refused by the unknown-blocking guard (§6.2 :296): the Run has an
    /// unreconciled `unknown`, so no new action/permit may proceed until it resolves. The caller
    /// treats this as waiting-for-reconcile, never a reconnect or a proof of non-execution.
    Blocked(String),
    /// RecordDeliverable noted a sealed deliverable version (the sync core intercepts this op).
    DeliverableRecorded,
    /// Any other registration failure.
    Failed(RecordError),
}

/// A cloneable handle the Node service thread holds to request journal ops of the sync core.
#[derive(Clone)]
pub struct JournalHandle {
    tx: mpsc::Sender<(JournalOp, oneshot::Sender<JournalReply>)>,
}

impl JournalHandle {
    /// Send an op and block until the sync core answers. Returns `None` if the sync core is gone (the
    /// Broker is shutting down), which the Node thread treats as a closed pipe.
    pub fn request(&self, op: JournalOp) -> Option<JournalReply> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx.blocking_send((op, reply_tx)).ok()?;
        reply_rx.blocking_recv().ok()
    }
}

/// Create the channel pair: the handle for the Node thread, the receiver the sync core multiplexes.
pub fn channel() -> (
    JournalHandle,
    mpsc::Receiver<(JournalOp, oneshot::Sender<JournalReply>)>,
) {
    let (tx, rx) = mpsc::channel(64);
    (JournalHandle { tx }, rx)
}

/// The journal facts an approval decision needs. The Node service thread is inside `serve_run`
/// for a whole Run, so a decision taken while the Run waits for its permit must reach the journal
/// op without going through that thread; the pump shares this slot to sign it directly.
#[derive(Clone)]
pub struct ApprovalSigner {
    pub journal: JournalHandle,
    pub org_id: String,
    pub subject_id: String,
    pub device_id: String,
    pub session_id: Option<String>,
}

pub type ApprovalSignerSlot = std::sync::Arc<std::sync::Mutex<Option<ApprovalSigner>>>;

/// Execute one journal op against the sync core's journal (the sole owner). The sync core calls this
/// from its event loop; it never runs on the Node thread. `device_id`/`journal_epoch`/`schema_version`
/// come from the journal itself via the record context the caller builds. `producer` carries the
/// device key + uplink sender + instance facts the receipt/checkpoint production arms need (the pure
/// register/read arms ignore it).
pub fn execute(
    journal: &crate::journal::Journal,
    producer: &Producer,
    op: JournalOp,
) -> JournalReply {
    match op {
        JournalOp::RegisterAction {
            org_id,
            subject_id,
            row,
            plaintext,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let supersedes = row.supersedes.as_deref();
            let result_hash = row.result_hash.as_deref();
            let result_ref = row.result_ref.as_deref();
            let borrowed = ActionRow {
                org_id: &row.org_id,
                operation_id: &row.operation_id,
                run_id: &row.run_id,
                attempt: &row.attempt,
                step_key: &row.step_key,
                logical_key: &row.logical_key,
                supersedes,
                request_hash: &row.request_hash,
                fence: row.fence,
                session_id: &row.session_id,
                generation: row.generation,
                permit_jti: &row.permit_jti,
                state: &row.state,
                result_hash,
                result_ref,
            };
            let conn = journal.connection();
            let outcome = (|| -> Result<(), RecordError> {
                let tx = conn.unchecked_transaction()?;
                record::append_action(&tx, journal.dek(), &rctx, &borrowed, &plaintext)?;
                tx.commit()?;
                Ok(())
            })();
            match outcome {
                Ok(()) => JournalReply::Registered,
                Err(RecordError::Sql(_)) => JournalReply::JtiConsumed,
                Err(err) => JournalReply::Failed(err),
            }
        }
        JournalOp::ReadAction {
            org_id,
            subject_id,
            operation_id,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let body = record::read_action(
                journal.connection(),
                journal.dek(),
                &rctx,
                &org_id,
                &operation_id,
            );
            JournalReply::Action(body)
        }
        JournalOp::ReadCheckpoint {
            org_id,
            subject_id,
            run_id,
            checkpoint_seq,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let body = recover::read_checkpoint(
                journal.connection(),
                journal.dek(),
                &rctx,
                &run_id,
                checkpoint_seq,
            );
            JournalReply::CheckpointBody(body)
        }
        JournalOp::ReadLocalContent {
            org_id,
            subject_id,
            version_id,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let body = crate::journal::local_content::read_sealed(
                journal.connection(),
                journal.dek(),
                &rctx,
                &version_id,
            );
            JournalReply::LocalContent(body)
        }
        JournalOp::RecordLocalApproval {
            org_id,
            subject_id,
            approval_id,
            row,
            plaintext,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let result = crate::journal::local_content::record_approval(
                journal.connection(),
                journal.dek(),
                &rctx,
                &approval_id,
                &row,
                &plaintext,
            );
            match result {
                Ok(()) => JournalReply::Registered,
                Err(error) => JournalReply::Failed(error),
            }
        }
        JournalOp::ReadLocalApproval {
            org_id,
            subject_id,
            approval_id,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let body = crate::journal::local_content::read_approval(
                journal.connection(),
                journal.dek(),
                &rctx,
                &approval_id,
            );
            JournalReply::LocalApproval(body)
        }
        JournalOp::PrepareLocalApprovalDecision {
            org_id,
            subject_id,
            device_id,
            session_id,
            mut input,
        } => {
            input.org_id = org_id;
            input.subject_id = subject_id;
            input.device_id = device_id;
            input.session_id = session_id;
            let proof = crate::approvaldecision::produce(producer.key, *input)
                .map(Some)
                .map_err(RecordError::Sign);
            JournalReply::LocalApprovalDecision(proof)
        }
        JournalOp::PrepareLocalAcceptance {
            org_id,
            subject_id,
            device_id,
            session_id,
            mut input,
        } => {
            let proof = (|| {
                let rctx = journal.context(&org_id, &subject_id);
                let body = crate::journal::local_content::read_sealed(
                    journal.connection(),
                    journal.dek(),
                    &rctx,
                    &input.version_id,
                )?
                .ok_or(RecordError::InvalidLocalDraft)?;
                if body.row.content_hash != input.content_hash {
                    return Err(RecordError::InvalidLocalDraft);
                }
                input.org_id = org_id;
                input.subject_id = subject_id;
                input.device_id = device_id;
                input.session_id = session_id;
                crate::possession::produce(producer.key, *input)
                    .map(Some)
                    .map_err(RecordError::Sign)
            })();
            JournalReply::LocalAcceptance(proof)
        }
        JournalOp::RecordLocalTranscript {
            org_id,
            subject_id,
            run_id,
            row,
            plaintext,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let result = crate::journal::local_content::record_transcript(
                journal.connection(),
                journal.dek(),
                &rctx,
                &run_id,
                &row,
                &plaintext,
            );
            match result {
                Ok(()) => JournalReply::Registered,
                Err(error) => JournalReply::Failed(error),
            }
        }
        JournalOp::ReadLocalTranscript {
            org_id,
            subject_id,
            run_id,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let body = crate::journal::local_content::read_transcript(
                journal.connection(),
                journal.dek(),
                &rctx,
                &run_id,
            );
            JournalReply::LocalTranscript(body)
        }
        JournalOp::PrepareLocalDraft {
            org_id,
            subject_id,
            row,
            plaintext,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let body = crate::journal::local_content::prepare_draft(
                journal.connection(),
                journal.dek(),
                &rctx,
                &row,
                &plaintext,
            );
            JournalReply::LocalDraftPrepared(body)
        }
        JournalOp::ReadLocalDraft {
            org_id,
            subject_id,
            version_id,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let body = crate::journal::local_content::read_draft_for_display(
                journal.connection(),
                journal.dek(),
                &rctx,
                &version_id,
            );
            JournalReply::LocalDraft(body)
        }
        JournalOp::ListLocalDrafts {
            org_id,
            subject_id,
            artifact_id,
            task_id,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let drafts = crate::journal::local_content::list_drafts(
                journal.connection(),
                journal.dek(),
                &rctx,
                &artifact_id,
                &task_id,
            );
            JournalReply::LocalDrafts(drafts)
        }
        JournalOp::DecideLocalDraft {
            org_id,
            subject_id,
            request_id,
            sealed_hash,
            action,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let row = crate::journal::local_content::decide_draft(
                journal.connection(),
                journal.dek(),
                &rctx,
                &request_id,
                &sealed_hash,
                &action,
            );
            JournalReply::LocalDraftDecided(row)
        }
        JournalOp::ConfirmLocalDraft {
            org_id,
            subject_id,
            request_id,
            sealed_hash,
            device_id,
            session_id,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let confirmed = crate::journal::local_content::confirm_draft(
                journal.connection(),
                journal.dek(),
                &rctx,
                producer.key,
                &request_id,
                &sealed_hash,
                &device_id,
                &session_id,
            );
            JournalReply::LocalDraftConfirmed(confirmed)
        }
        JournalOp::CompleteLocalDraft {
            org_id,
            subject_id,
            request_id,
            sealed_hash,
            publish_ack,
        } => {
            let rctx = journal.context(&org_id, &subject_id);
            let completed = crate::journal::local_content::mark_draft_published(
                journal.connection(),
                &rctx,
                &request_id,
                &sealed_hash,
                &publish_ack,
            );
            let completed = completed.and_then(|published| {
                if !published {
                    return Ok(None);
                }
                crate::journal::local_content::read_published_draft_copy(
                    journal.connection(),
                    journal.dek(),
                    &rctx,
                    &request_id,
                    &sealed_hash,
                )
            });
            JournalReply::LocalDraftCompleted(completed)
        }
        JournalOp::SetLocalDraftCopyState {
            org_id: _,
            subject_id: _,
            request_id,
            sealed_hash,
            state,
        } => {
            JournalReply::LocalDraftCopyState(crate::journal::local_content::set_draft_copy_state(
                journal.connection(),
                &request_id,
                &sealed_hash,
                &state,
            ))
        }
        JournalOp::AppendReceipt {
            org_id,
            subject_id,
            facts,
        } => produce_receipt(journal, producer, &org_id, &subject_id, &facts),
        JournalOp::AppendModelResult {
            org_id,
            subject_id,
            facts,
        } => produce_model_result(journal, producer, &org_id, &subject_id, &facts),
        JournalOp::PrepareModelProbeReceipts {
            org_id,
            subject_id,
            session_id,
            auth_epoch,
        } => prepare_model_probe_receipts(
            journal,
            producer,
            &org_id,
            &subject_id,
            &session_id,
            auth_epoch,
        ),
        JournalOp::ConfirmModelProbeReceiptDelivery {
            org_id,
            subject_id,
            session_id,
            model_result_id,
        } => confirm_model_probe_receipt_delivery(
            journal,
            &org_id,
            &subject_id,
            &session_id,
            &model_result_id,
        ),
        JournalOp::PersistCheckpoint {
            org_id,
            subject_id,
            facts,
            plaintext,
        } => produce_checkpoint(journal, producer, &org_id, &subject_id, &facts, &plaintext),
        JournalOp::ProposeAction { facts, .. } => {
            // §6.2 :296 unknown-blocking guard: while the Run has an unreconciled `unknown`, the
            // server rejects new action_prepare/permits; the device mirrors it here (the sole journal
            // owner) and refuses to propose, treating it as waiting-for-reconcile. Lease renewal,
            // receipt/checkpoint uplink and resolution receive are NOT blocked.
            match crate::reconcile::guard::check_action_prepare(journal.connection(), &facts.run_id)
            {
                Ok(crate::reconcile::guard::GuardDecision::Block(code)) => {
                    return JournalReply::Blocked(code.to_string());
                }
                Ok(crate::reconcile::guard::GuardDecision::Allow) => {}
                Err(err) => return JournalReply::Failed(RecordError::Sql(err)),
            }
            let mut body = action::ActionPrepareBody {
                prepare_id: uuid::Uuid::new_v4().to_string(),
                run_id: facts.run_id.clone(),
                lease_id: facts.lease_id.clone(),
                fence: facts.fence,
                step_key: facts.step_key.clone(),
                logical_key: facts.logical_key.clone(),
                supersedes_operation_id: None,
                supersede_reason: None,
                supersede_assertion: None,
                checkpoint_seq: facts.checkpoint_seq,
                checkpoint_hash: facts.checkpoint_hash.clone(),
                request_hash: facts.request_hash.clone(),
                action_kind: facts.action_kind.clone(),
                tool_schema: facts.tool_schema.clone(),
                local_payload_ref: facts.local_payload_ref.clone(),
                grant_id: facts.grant_id.clone(),
                grant_revision: facts.grant_revision,
                resource_selector_hash: facts.resource_selector_hash.clone(),
                classification: facts.classification.clone(),
                destination_id: facts.destination_id.clone(),
                byte_upper_bound: facts.byte_upper_bound,
                token_upper_bound: facts.token_upper_bound,
                signature: None,
            };
            if let Err(err) = body.sign(producer.key) {
                eprintln!("work-device: action_prepare sign failed: {err:?}");
                return JournalReply::Failed(RecordError::Sign(err));
            }
            let frame = UplinkFrame {
                frame_type: action::ACTION_PREPARE_FRAME_TYPE.to_string(),
                body: body.to_value(),
            };
            if producer.uplinks.blocking_send(frame).is_err() {
                eprintln!("work-device: action_prepare uplink channel closed");
            }
            JournalReply::Proposed
        }
        // The sync core intercepts RecordDeliverable in its event loop (it owns the per-Run
        // deliverable set); this fallback keeps the match exhaustive for direct callers and writes
        // no journal row.
        JournalOp::RecordDeliverable { .. } => JournalReply::DeliverableRecorded,
    }
}

/// Produce one signed receipt on the sync core (the sole journal owner + key holder). The seq is
/// allocated, bound into the body, signed, and the original signed ENVELOPE appended to the outbox
/// within ONE transaction — a failed sign/insert rolls back the allocation so receipt seqs stay
/// continuous (a reconcile gate, §3.1). The stored bytes are the full historical envelope (the
/// reconcile path re-uploads them verbatim, gateway/reconcile.go); the live uplink carries the signed
/// body, which the link re-wraps in the current transport envelope. `device_local` receipts carry no
/// `gateway_receipt_hash` (egress-only, DD:264); model usage is stamped `usage_source='device_adapter'`.
fn produce_receipt(
    journal: &crate::journal::Journal,
    producer: &Producer,
    org_id: &str,
    subject_id: &str,
    facts: &ReceiptFacts,
) -> JournalReply {
    let conn = journal.connection();
    let outcome = (|| -> Result<(u64, String, Value), RecordError> {
        let tx = conn.unchecked_transaction()?;
        let seq = meta::allocate_receipt_seq(&tx, journal.device_id())?;
        let mut body = receipt::ReceiptBody {
            journal_epoch: journal.journal_epoch().to_string(),
            receipt_seq: seq as u64,
            original_execution: receipt::OriginalExecution {
                org: org_id.to_string(),
                subject: subject_id.to_string(),
                device: journal.device_id().to_string(),
                session: facts.session_id.clone(),
                agent_instance: producer.instance.agent_instance_id.clone(),
                boot: producer.instance.boot_id.clone(),
                generation: facts.generation,
                run: facts.run_id.clone(),
                operation: facts.operation_id.clone(),
                attempt: facts.attempt.clone(),
                fence: facts.fence,
            },
            request_hash: facts.request_hash.clone(),
            state: facts.state.clone(),
            outcome: facts.outcome.clone(),
            result_hash: facts.result_hash.clone(),
            local_result_ref: facts.local_result_ref.clone(),
            gateway_receipt_hash: None,
            model_delivery: facts.model_delivery.clone(),
            usage: facts.usage.clone(),
            usage_source: facts.usage_source.clone(),
            error_code: facts.error_code.clone(),
            signature: None,
        };
        body.sign(producer.key)?;
        let body_value = body.to_value();
        // The historical envelope kept in the outbox (transport fields are NOT signed; the body
        // signature covers {schema_version, type, body}, frame/sign.rs). session/agent/boot/generation
        // are the execution-time facts, so a later reconcile re-upload keeps them verbatim.
        let mut env =
            envelope::Envelope::new(receipt::FRAME_TYPE, journal.device_id(), body_value.clone());
        env.session_id = facts.session_id.clone();
        env.agent_instance_id = producer.instance.agent_instance_id.clone();
        env.boot_id = producer.instance.boot_id.clone();
        env.recovery_generation = facts.generation;
        env.sent_at = now_rfc3339();
        let signed_bytes = serde_json::to_vec(&env).expect("receipt envelope serializes");
        let signed_hash = format!("sha256:{}", crate::sha256_hex(&signed_bytes));
        record::insert_receipt(
            &tx,
            journal.journal_epoch(),
            seq,
            &record::ReceiptRow {
                operation_id: &facts.operation_id,
                state: &facts.state,
                signed_bytes: &signed_bytes,
                signed_hash: &signed_hash,
            },
        )?;
        // The outbox is transient (the checkpoint_ack watermark releases acked receipts, B03 §3.2),
        // so the finish facts cannot read it. Persist the completed receipt's result_hash onto the
        // durable action_journal row: NULL means no completed receipt yet, a set value (even empty)
        // means receipted. This mirrors the server's device_receipt.result_hash subquery (0042:641).
        if facts.state == "completed" {
            tx.execute(
                "UPDATE action_journal SET result_hash = ?1, result_ref = ?2
                 WHERE org_id = ?3 AND run_id = ?4 AND operation_id = ?5",
                rusqlite::params![
                    facts.result_hash,
                    facts.local_result_ref,
                    org_id,
                    facts.run_id,
                    facts.operation_id
                ],
            )?;
        }
        tx.commit()?;
        Ok((seq as u64, signed_hash, body_value))
    })();
    match outcome {
        Ok((seq, signed_hash, body_value)) => {
            let frame = UplinkFrame {
                frame_type: receipt::FRAME_TYPE.to_string(),
                body: body_value,
            };
            if producer.uplinks.blocking_send(frame).is_err() {
                eprintln!("work-device: receipt uplink channel closed (seq {seq})");
            }
            JournalReply::ReceiptProduced { seq, signed_hash }
        }
        Err(err) => JournalReply::Failed(err),
    }
}

fn produce_model_result(
    journal: &crate::journal::Journal,
    producer: &Producer,
    org_id: &str,
    subject_id: &str,
    facts: &ModelResultFacts,
) -> JournalReply {
    let conn = journal.connection();
    let outcome = (|| -> Result<(String, String, Value), RecordError> {
        let tx = conn.unchecked_transaction()?;
        let result_id = uuid::Uuid::new_v4().to_string();
        let mut body = model_result::ModelResultBody {
            model_result_id: result_id.clone(),
            run_id: facts.run_id.clone(),
            operation_id: facts.operation_id.clone(),
            attempt_id: facts.attempt_id.clone(),
            request_hash: facts.request_hash.clone(),
            state: facts.state.clone(),
            outcome: facts.outcome.clone(),
            result_hash: facts.result_hash.clone(),
            provider_request_id: facts.provider_request_id.clone(),
            model: facts.model.clone(),
            usage: facts.usage.clone(),
            error_code: facts.error_code.clone(),
            signature: None,
        };
        if !body.shape_consistent() {
            return Err(RecordError::InvalidModelResult);
        }
        body.sign(producer.key)?;
        let body_value = body.to_value();
        let mut env = envelope::Envelope::new(
            model_result::FRAME_TYPE,
            journal.device_id(),
            body_value.clone(),
        );
        env.session_id = facts.session_id.clone();
        env.agent_instance_id = producer.instance.agent_instance_id.clone();
        env.boot_id = producer.instance.boot_id.clone();
        env.sent_at = now_rfc3339();
        let signed_bytes = serde_json::to_vec(&env).expect("model_result envelope serializes");
        let signed_hash = format!("sha256:{}", crate::sha256_hex(&signed_bytes));
        record::insert_model_result(
            &tx,
            journal.journal_epoch(),
            &record::ModelResultRow {
                model_result_id: &result_id,
                operation_id: &facts.operation_id,
                state: &facts.state,
                signed_bytes: &signed_bytes,
                signed_hash: &signed_hash,
            },
        )?;
        if let Some(probe) = &facts.probe {
            let digest = |value: &str| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            };
            if uuid::Uuid::parse_str(&probe.binding_id).is_err()
                || uuid::Uuid::parse_str(&probe.probe_id).is_err()
                || !digest(&probe.preview_hash)
            {
                return Err(RecordError::InvalidModelResult);
            }
            record::insert_model_probe_result(
                &tx,
                journal.journal_epoch(),
                &record::ModelProbeResultRow {
                    model_result_id: &result_id,
                    org_id,
                    subject_id,
                    device_id: journal.device_id(),
                    session_id: &facts.session_id,
                    binding_id: &probe.binding_id,
                    probe_id: &probe.probe_id,
                    preview_hash: &probe.preview_hash,
                },
            )?;
        }
        tx.commit()?;
        Ok((result_id, signed_hash, body_value))
    })();
    match outcome {
        Ok((result_id, signed_hash, body_value)) => {
            let frame = UplinkFrame {
                frame_type: model_result::FRAME_TYPE.to_string(),
                body: body_value,
            };
            if producer.uplinks.blocking_send(frame).is_err() {
                eprintln!("work-device: model_result uplink channel closed ({result_id})");
            }
            JournalReply::ModelResultProduced {
                model_result_id: result_id,
                signed_hash,
            }
        }
        Err(err) => JournalReply::Failed(err),
    }
}

fn prepare_model_probe_receipts(
    journal: &crate::journal::Journal,
    producer: &Producer,
    org_id: &str,
    subject_id: &str,
    session_id: &str,
    auth_epoch: u64,
) -> JournalReply {
    let outcome = (|| -> Result<Vec<ModelProbeReceiptProof>, RecordError> {
        let tx = journal.connection().unchecked_transaction()?;
        let rows = recover::pending_probe_results(
            &tx,
            journal.journal_epoch(),
            org_id,
            subject_id,
            journal.device_id(),
            session_id,
            16,
        )?;
        let now = now_rfc3339();
        let expires_at = rfc3339::format_utc_seconds(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs() + 60)
                .unwrap_or(60),
        )
        .unwrap_or_else(|| "1970-01-01T00:01:00Z".to_string());
        let mut proofs = Vec::with_capacity(rows.len());
        for row in rows {
            if !row.acked || row.rejected {
                return Err(RecordError::ProbeReceiptUnavailable);
            }
            if row.signed_receipt.is_some() {
                let (bytes, signature, stored_epoch, stored_expiry) = (
                    row.signed_receipt.as_deref(),
                    row.receipt_signature.as_deref(),
                    row.receipt_auth_epoch.as_deref(),
                    row.receipt_expires_at.as_deref(),
                );
                let (Some(bytes), Some(signature), Some(stored_epoch), Some(stored_expiry)) =
                    (bytes, signature, stored_epoch, stored_expiry)
                else {
                    return Err(RecordError::InvalidModelResult);
                };
                if stored_epoch != auth_epoch.to_string() || stored_expiry <= now.as_str() {
                    continue;
                }
                let receipt: model_probe::ModelProbeReceipt =
                    serde_json::from_slice(bytes).map_err(|_| RecordError::InvalidModelResult)?;
                if !receipt.shape_consistent()
                    || !crate::frame::sign::verify_frame(
                        &producer.key.public_jwk(),
                        model_probe::FRAME_TYPE,
                        &receipt.to_value(),
                        signature,
                    )
                {
                    return Err(RecordError::InvalidModelResult);
                }
                proofs.push(ModelProbeReceiptProof {
                    client_request_id: format!("model_probe:{}", row.model_result_id),
                    receipt: receipt.to_value(),
                    signature: signature.to_string(),
                });
                continue;
            }
            let env: envelope::Envelope = serde_json::from_slice(&row.signed_bytes)
                .map_err(|_| RecordError::InvalidModelResult)?;
            if env.frame_type != model_result::FRAME_TYPE
                || env.device_id != row.device_id
                || env.session_id != row.session_id
            {
                return Err(RecordError::ProbeReceiptIdentityMismatch);
            }
            let result: model_result::ModelResultBody = serde_json::from_value(env.body.clone())
                .map_err(|_| RecordError::InvalidModelResult)?;
            if !result.shape_consistent()
                || result.model_result_id != row.model_result_id
                || result.operation_id != row.operation_id
                || result.request_hash != row.preview_hash
                || !crate::frame::sign::verify_frame(
                    &producer.key.public_jwk(),
                    model_result::FRAME_TYPE,
                    &env.body,
                    result.signature.as_deref().unwrap_or(""),
                )
            {
                return Err(RecordError::ProbeReceiptIdentityMismatch);
            }
            let (state, receipt_hash) = match result.outcome.as_deref() {
                Some("succeeded") => ("verified", result.result_hash.clone().unwrap_or_default()),
                Some("failed") => ("failed", String::new()),
                None if result.state == "unknown" => ("reconcile", String::new()),
                _ => return Err(RecordError::InvalidModelResult),
            };
            let receipt = model_probe::ModelProbeReceipt {
                v: 1,
                org_id: row.org_id,
                subject_id: row.subject_id,
                auth_epoch,
                device_id: row.device_id,
                session_id: row.session_id,
                binding_id: row.binding_id,
                probe_id: row.probe_id,
                preview_hash: row.preview_hash,
                receipt_hash,
                receipt_ref: format!("model_result:{}", row.model_result_id),
                state: state.to_string(),
                nonce: uuid::Uuid::new_v4().to_string(),
                expires_at: expires_at.clone(),
            };
            let signature = receipt.signature_for(producer.key)?;
            let bytes = serde_json::to_vec(&receipt.to_value())
                .map_err(|_| RecordError::InvalidModelResult)?;
            recover::store_probe_receipt(
                &tx,
                journal.journal_epoch(),
                &row.model_result_id,
                &bytes,
                &signature,
                auth_epoch,
                &expires_at,
            )?;
            proofs.push(ModelProbeReceiptProof {
                client_request_id: format!("model_probe:{}", row.model_result_id),
                receipt: receipt.to_value(),
                signature,
            });
        }
        tx.commit()?;
        Ok(proofs)
    })();
    match outcome {
        Ok(proofs) => JournalReply::ModelProbeReceiptsPrepared(proofs),
        Err(err) => JournalReply::Failed(err),
    }
}

fn confirm_model_probe_receipt_delivery(
    journal: &crate::journal::Journal,
    org_id: &str,
    subject_id: &str,
    session_id: &str,
    model_result_id: &str,
) -> JournalReply {
    let result = (|| -> Result<bool, RecordError> {
        let row = journal
            .connection()
            .query_row(
                "SELECT p.org_id, p.subject_id, p.device_id, p.session_id, p.signed_receipt,
                        m.acked, m.rejected
                 FROM model_probe_result p
                 JOIN model_result_outbox m
                   ON m.model_result_id = p.model_result_id AND m.journal_epoch = p.journal_epoch
                 WHERE p.journal_epoch = ?1 AND p.model_result_id = ?2",
                rusqlite::params![journal.journal_epoch(), model_result_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<Vec<u8>>>(4)?,
                        row.get::<_, i64>(5)? != 0,
                        row.get::<_, i64>(6)? != 0,
                    ))
                },
            )
            .optional()
            .map_err(RecordError::from)?;
        let Some((stored_org, stored_subject, device_id, stored_session, receipt, acked, rejected)) =
            row
        else {
            return Err(RecordError::ProbeReceiptUnavailable);
        };
        if !acked
            || rejected
            || stored_org != org_id
            || stored_subject != subject_id
            || device_id != journal.device_id()
            || stored_session != session_id
            || receipt.is_none()
        {
            return Err(RecordError::ProbeReceiptIdentityMismatch);
        }
        recover::mark_probe_receipt_delivered(
            journal.connection(),
            journal.journal_epoch(),
            model_result_id,
        )
        .map_err(RecordError::from)
    })();
    match result {
        Ok(confirmed) => JournalReply::ModelProbeReceiptDeliveryConfirmed(confirmed),
        Err(err) => JournalReply::Failed(err),
    }
}

/// Persist an encrypted checkpoint and uplink a signed `checkpoint_commit`. The canonical body is
/// sealed under the DEK with the identity-bound AAD (recover::persist_checkpoint); the commit carries
/// only hashes + an opaque local ref, never ciphertext (device-design §3.4). `receipt_through_seq` is
/// the receipt watermark this checkpoint covers — the highest seq the device has produced so far.
fn produce_checkpoint(
    journal: &crate::journal::Journal,
    producer: &Producer,
    org_id: &str,
    subject_id: &str,
    facts: &CheckpointFacts,
    plaintext: &[u8],
) -> JournalReply {
    let rctx = journal.context(org_id, subject_id);
    let row = recover::CheckpointRow {
        run_id: facts.run_id.clone(),
        checkpoint_seq: facts.checkpoint_seq,
        schema_version: facts.schema_version,
        runtime_digest: facts.runtime_digest.clone(),
        checkpoint_hash: facts.checkpoint_hash.clone(),
        pending_operation_set_hash: facts.pending_operation_set_hash.clone(),
        prior_receipt_ref: facts.prior_receipt_ref.clone(),
    };
    if let Err(err) =
        recover::persist_checkpoint(journal.connection(), journal.dek(), &rctx, &row, plaintext)
    {
        return JournalReply::Failed(err);
    }
    let receipt_through_seq = current_receipt_seq(journal);
    let mut commit = checkpoint::CheckpointCommitBody {
        run_id: facts.run_id.clone(),
        binding_revision: facts.binding_revision,
        fence: facts.fence,
        checkpoint_seq: facts.checkpoint_seq as u64,
        checkpoint_hash: facts.checkpoint_hash.clone(),
        local_checkpoint_ref: facts.local_checkpoint_ref.clone(),
        receipt_through_seq,
        pending_operation_set_hash: facts.pending_operation_set_hash.clone(),
        signature: None,
    };
    if let Err(err) = commit.sign(producer.key) {
        return JournalReply::Failed(err.into());
    }
    let frame = UplinkFrame {
        frame_type: checkpoint::COMMIT_FRAME_TYPE.to_string(),
        body: commit.to_value(),
    };
    if producer.uplinks.blocking_send(frame).is_err() {
        eprintln!(
            "work-device: checkpoint uplink channel closed ({})",
            facts.run_id
        );
    }
    JournalReply::CheckpointProduced
}

/// The highest receipt seq the device has produced (next_receipt_seq - 1), read from device_meta so
/// the checkpoint watermark reflects every allocated seq, including this Run's just-produced ones.
fn current_receipt_seq(journal: &crate::journal::Journal) -> u64 {
    let next: i64 = journal
        .connection()
        .query_row(
            "SELECT next_receipt_seq FROM device_meta WHERE device_id = ?1",
            rusqlite::params![journal.device_id()],
            |row| row.get(0),
        )
        .unwrap_or(1);
    next.saturating_sub(1).max(0) as u64
}

/// The current wall clock as the strict RFC3339 UTC seconds the envelope `sent_at` carries (the same
/// format the link stamps, frame/rfc3339.rs). Falls back to the epoch on a clock error.
fn now_rfc3339() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    rfc3339::format_utc_seconds(seconds).unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{dek, Journal};

    fn owned_row(jti: &str, op: &str) -> ActionRowOwned {
        ActionRowOwned {
            org_id: "org".into(),
            operation_id: op.into(),
            run_id: "run".into(),
            attempt: "attempt-1".into(),
            step_key: "step#0".into(),
            logical_key: "step#0".into(),
            supersedes: None,
            request_hash: "hash".into(),
            fence: 1,
            session_id: "sess".into(),
            generation: 1,
            permit_jti: jti.into(),
            state: "started".into(),
            result_hash: None,
            result_ref: None,
        }
    }

    /// The signing/uplink context for a pure-op test (no uplink is emitted, so the receiver may drop).
    fn producer_parts() -> (
        crate::key::SoftwareKey,
        mpsc::Sender<UplinkFrame>,
        InstanceFacts,
    ) {
        let (tx, _rx) = mpsc::channel(8);
        (
            crate::key::SoftwareKey::random(),
            tx,
            InstanceFacts {
                agent_instance_id: "agent".into(),
                boot_id: "boot".into(),
            },
        )
    }

    fn receipt_facts(operation_id: &str, state: &str) -> ReceiptFacts {
        ReceiptFacts {
            operation_id: operation_id.into(),
            run_id: "run".into(),
            session_id: "sess".into(),
            generation: 1,
            attempt: "attempt-1".into(),
            fence: 1,
            request_hash: "sha256:req".into(),
            state: state.into(),
            outcome: if state == "completed" {
                Some("succeeded".into())
            } else {
                None
            },
            result_hash: "sha256:result".into(),
            local_result_ref: "ref".into(),
            model_delivery: None,
            usage: None,
            usage_source: None,
            error_code: String::new(),
        }
    }

    #[test]
    fn register_then_read_round_trips_and_consumed_jti_is_reported() {
        let path = std::env::temp_dir().join(format!("work-journalop-{}.db", uuid::Uuid::new_v4()));
        let journal = Journal::create(&path, "dev", &dek::TestWrap).unwrap();
        let (key, up_tx, instance) = producer_parts();
        let producer = Producer {
            key: &key,
            uplinks: &up_tx,
            instance: &instance,
        };
        let op = JournalOp::RegisterAction {
            org_id: "org".into(),
            subject_id: "sub".into(),
            row: Box::new(owned_row("jti-1", "op-1")),
            plaintext: b"sealed body".to_vec(),
        };
        assert!(matches!(
            execute(&journal, &producer, op),
            JournalReply::Registered
        ));
        // The same jti again reports consumed (never re-registers).
        let again = JournalOp::RegisterAction {
            org_id: "org".into(),
            subject_id: "sub".into(),
            row: Box::new(owned_row("jti-1", "op-1")),
            plaintext: b"sealed body".to_vec(),
        };
        assert!(matches!(
            execute(&journal, &producer, again),
            JournalReply::JtiConsumed
        ));
        let read = JournalOp::ReadAction {
            org_id: "org".into(),
            subject_id: "sub".into(),
            operation_id: "op-1".into(),
        };
        match execute(&journal, &producer, read) {
            JournalReply::Action(Ok(body)) => assert_eq!(body, b"sealed body"),
            _ => panic!("expected the sealed body"),
        }
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn the_handle_round_trips_an_op_over_the_channel() {
        let path =
            std::env::temp_dir().join(format!("work-journalop-ch-{}.db", uuid::Uuid::new_v4()));
        let (handle, mut rx) = channel();
        // A stand-in sync core: the journal is created AND owned inside this thread (Journal is not
        // Send — the sync core is its sole owner, exactly the production ownership shape).
        let server_path = path.clone();
        let server = std::thread::spawn(move || {
            let journal = Journal::create(&server_path, "dev", &dek::TestWrap).unwrap();
            let (key, up_tx, instance) = producer_parts();
            let producer = Producer {
                key: &key,
                uplinks: &up_tx,
                instance: &instance,
            };
            let (op, reply_tx) = rx.blocking_recv().unwrap();
            let reply = execute(&journal, &producer, op);
            let _ = reply_tx.send(reply);
            drop(journal);
            let _ = std::fs::remove_file(&server_path);
            let _ = std::fs::remove_file(server_path.with_extension("db-wal"));
            let _ = std::fs::remove_file(server_path.with_extension("db-shm"));
        });
        let reply = handle.request(JournalOp::RegisterAction {
            org_id: "org".into(),
            subject_id: "sub".into(),
            row: Box::new(owned_row("jti-ch", "op-ch")),
            plaintext: b"body".to_vec(),
        });
        assert!(matches!(reply, Some(JournalReply::Registered)));
        server.join().unwrap();
    }

    #[test]
    fn append_model_result_uses_its_own_id_and_leaves_receipt_seq_untouched() {
        let path =
            std::env::temp_dir().join(format!("work-journalop-model-{}.db", uuid::Uuid::new_v4()));
        let journal = Journal::create(
            &path,
            "80000000-0000-0000-0000-000000000001",
            &dek::TestWrap,
        )
        .unwrap();
        let key = crate::key::SoftwareKey::random();
        let (up_tx, mut up_rx) = mpsc::channel(8);
        let instance = InstanceFacts {
            agent_instance_id: "agent".into(),
            boot_id: "boot".into(),
        };
        let producer = Producer {
            key: &key,
            uplinks: &up_tx,
            instance: &instance,
        };
        let facts = ModelResultFacts {
            run_id: "20000000-0000-0000-0000-000000000001".into(),
            operation_id: "30000000-0000-0000-0000-000000000001".into(),
            attempt_id: "40000000-0000-0000-0000-000000000001".into(),
            session_id: "70000000-0000-0000-0000-000000000001".into(),
            request_hash: "c".repeat(64),
            state: "completed".into(),
            outcome: Some("succeeded".into()),
            result_hash: Some("b".repeat(64)),
            provider_request_id: Some("req-1".into()),
            model: "fixture-model".into(),
            usage: Some(model_result::ModelUsage {
                input_tokens: 3,
                output_tokens: 2,
                cached_input_tokens: 1,
                estimated: false,
            }),
            error_code: None,
            probe: Some(ProbeResultMetadata {
                binding_id: "50000000-0000-0000-0000-000000000001".into(),
                probe_id: "60000000-0000-0000-0000-000000000001".into(),
                preview_hash: "c".repeat(64),
            }),
        };
        let operation_id = facts.operation_id.clone();
        let mut invalid_facts = facts.clone();
        invalid_facts.probe.as_mut().unwrap().preview_hash = "bad".into();
        let reply = execute(
            &journal,
            &producer,
            JournalOp::AppendModelResult {
                org_id: "org".into(),
                subject_id: "sub".into(),
                facts: Box::new(facts),
            },
        );
        let result_id = match reply {
            JournalReply::ModelResultProduced {
                model_result_id,
                signed_hash,
            } => {
                assert!(signed_hash.starts_with("sha256:"));
                model_result_id
            }
            other => panic!("unexpected model result reply: {other:?}"),
        };
        let frame = up_rx.blocking_recv().unwrap();
        assert_eq!(frame.frame_type, "model_result");
        assert_eq!(frame.body["model_result_id"], result_id);
        let invalid = execute(
            &journal,
            &producer,
            JournalOp::AppendModelResult {
                org_id: "org".into(),
                subject_id: "sub".into(),
                facts: Box::new(invalid_facts),
            },
        );
        assert!(matches!(
            invalid,
            JournalReply::Failed(RecordError::InvalidModelResult)
        ));
        assert!(matches!(
            up_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        let pending =
            recover::unacked_model_results(journal.connection(), journal.journal_epoch(), 10)
                .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].model_result_id, result_id);
        let probe = recover::probe_result_for_model_result(
            journal.connection(),
            journal.journal_epoch(),
            &result_id,
            &operation_id,
        )
        .unwrap()
        .expect("probe metadata persisted with the model result");
        assert_eq!(probe.binding_id, "50000000-0000-0000-0000-000000000001");
        assert_eq!(probe.probe_id, "60000000-0000-0000-0000-000000000001");
        assert_eq!(probe.preview_hash, "c".repeat(64));
        assert!(!probe.acked && !probe.rejected);
        assert!(recover::probe_result_for_model_result(
            journal.connection(),
            journal.journal_epoch(),
            &result_id,
            "99999999-0000-0000-0000-000000000001",
        )
        .unwrap()
        .is_none());
        let stored: envelope::Envelope = serde_json::from_slice(&pending[0].signed_bytes).unwrap();
        assert_eq!(stored.frame_type, "model_result");
        assert_eq!(stored.body, frame.body);
        recover::mark_model_result_acked(
            journal.connection(),
            journal.journal_epoch(),
            &result_id,
            "99999999-0000-0000-0000-000000000001",
        )
        .unwrap();
        assert_eq!(
            recover::unacked_model_results(journal.connection(), journal.journal_epoch(), 10)
                .unwrap()
                .len(),
            1
        );
        recover::mark_model_result_rejected(
            journal.connection(),
            journal.journal_epoch(),
            &result_id,
            &operation_id,
        )
        .unwrap();
        assert!(
            recover::unacked_model_results(journal.connection(), journal.journal_epoch(), 10)
                .unwrap()
                .is_empty()
        );
        journal
            .connection()
            .execute(
                "UPDATE model_result_outbox SET rejected = 0 WHERE model_result_id = ?1",
                [&result_id],
            )
            .unwrap();
        recover::mark_model_result_acked(
            journal.connection(),
            journal.journal_epoch(),
            &result_id,
            &operation_id,
        )
        .unwrap();
        assert!(
            recover::unacked_model_results(journal.connection(), journal.journal_epoch(), 10)
                .unwrap()
                .is_empty()
        );
        assert_eq!(current_receipt_seq(&journal), 0);
        let probe = recover::probe_result_for_model_result(
            journal.connection(),
            journal.journal_epoch(),
            &result_id,
            &operation_id,
        )
        .unwrap()
        .expect("acked probe metadata remains readable");
        assert!(probe.acked && !probe.rejected);
        assert_eq!(probe.result_state, "completed");
        let prepare = |auth_epoch: u64, session_id: &str| {
            execute(
                &journal,
                &producer,
                JournalOp::PrepareModelProbeReceipts {
                    org_id: "org".into(),
                    subject_id: "sub".into(),
                    session_id: session_id.into(),
                    auth_epoch,
                },
            )
        };
        let proofs = match prepare(4, "70000000-0000-0000-0000-000000000001") {
            JournalReply::ModelProbeReceiptsPrepared(proofs) => proofs,
            other => panic!("expected prepared probe receipts, got {other:?}"),
        };
        assert_eq!(proofs.len(), 1);
        assert_eq!(
            proofs[0].client_request_id,
            format!("model_probe:{result_id}")
        );
        assert_eq!(proofs[0].receipt["state"], "verified");
        assert_eq!(proofs[0].receipt["auth_epoch"], "4");
        assert_eq!(
            proofs[0].receipt["receipt_ref"],
            format!("model_result:{result_id}")
        );
        assert_eq!(proofs[0].receipt["receipt_hash"], "b".repeat(64));
        assert!(crate::frame::sign::verify_frame(
            &key.public_jwk(),
            model_probe::FRAME_TYPE,
            &proofs[0].receipt,
            &proofs[0].signature
        ));
        let replay = match prepare(4, "70000000-0000-0000-0000-000000000001") {
            JournalReply::ModelProbeReceiptsPrepared(proofs) => proofs,
            other => panic!("expected replayed probe receipts, got {other:?}"),
        };
        assert_eq!(replay[0].receipt, proofs[0].receipt);
        assert_eq!(replay[0].signature, proofs[0].signature);
        assert!(matches!(
            prepare(5, "70000000-0000-0000-0000-000000000001"),
            JournalReply::ModelProbeReceiptsPrepared(proofs) if proofs.is_empty()
        ));
        journal
            .connection()
            .execute(
                "UPDATE model_probe_result SET receipt_expires_at = '2000-01-01T00:00:00Z'
                 WHERE model_result_id = ?1",
                [&result_id],
            )
            .unwrap();
        assert!(matches!(
            prepare(4, "70000000-0000-0000-0000-000000000001"),
            JournalReply::ModelProbeReceiptsPrepared(proofs) if proofs.is_empty()
        ));
        assert!(matches!(
            prepare(4, "90000000-0000-0000-0000-000000000001"),
            JournalReply::ModelProbeReceiptsPrepared(proofs) if proofs.is_empty()
        ));
        assert!(matches!(
            execute(
                &journal,
                &producer,
                JournalOp::ConfirmModelProbeReceiptDelivery {
                    org_id: "org".into(),
                    subject_id: "sub".into(),
                    session_id: "70000000-0000-0000-0000-000000000001".into(),
                    model_result_id: result_id.clone(),
                },
            ),
            JournalReply::ModelProbeReceiptDeliveryConfirmed(true)
        ));
        assert!(matches!(
            prepare(4, "70000000-0000-0000-0000-000000000001"),
            JournalReply::ModelProbeReceiptsPrepared(proofs) if proofs.is_empty()
        ));
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn append_receipt_signs_allocates_seq_and_stores_the_original_envelope() {
        let path =
            std::env::temp_dir().join(format!("work-journalop-rcpt-{}.db", uuid::Uuid::new_v4()));
        let journal = Journal::create(&path, "dev", &dek::TestWrap).unwrap();
        let key = crate::key::SoftwareKey::random();
        let jwk = key.public_jwk();
        let (up_tx, mut up_rx) = mpsc::channel(8);
        let instance = InstanceFacts {
            agent_instance_id: "agent".into(),
            boot_id: "boot".into(),
        };
        let producer = Producer {
            key: &key,
            uplinks: &up_tx,
            instance: &instance,
        };
        let op = JournalOp::AppendReceipt {
            org_id: "org".into(),
            subject_id: "sub".into(),
            facts: Box::new(receipt_facts("op-1", "completed")),
        };
        let seq = match execute(&journal, &producer, op) {
            JournalReply::ReceiptProduced { seq, signed_hash } => {
                assert_eq!(seq, 1);
                assert!(signed_hash.starts_with("sha256:"));
                seq
            }
            other => panic!("expected ReceiptProduced, got {other:?}"),
        };
        // The live uplink carries the signed body; the signature verifies over the historical identity.
        let frame = up_rx.blocking_recv().unwrap();
        assert_eq!(frame.frame_type, receipt::FRAME_TYPE);
        assert_eq!(frame.body["receipt_seq"], "1");
        assert_eq!(frame.body["original_execution"]["operation"], "op-1");
        assert_eq!(frame.body["original_execution"]["agent_instance"], "agent");
        let sig = frame.body["signature"].as_str().unwrap();
        assert!(crate::frame::sign::verify_frame(
            &jwk,
            receipt::FRAME_TYPE,
            &frame.body,
            sig
        ));
        // The outbox stores the FULL historical envelope (reconcile re-uploads it verbatim).
        let pending =
            recover::unacked_receipts(journal.connection(), journal.journal_epoch(), 10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].receipt_seq, seq as i64);
        let env: envelope::Envelope = serde_json::from_slice(&pending[0].signed_bytes).unwrap();
        assert_eq!(env.frame_type, receipt::FRAME_TYPE);
        assert_eq!(env.session_id, "sess");
        assert_eq!(env.boot_id, "boot");
        assert_eq!(env.body["original_execution"]["session"], "sess");
        let env_sig = env.body["signature"].as_str().unwrap();
        assert!(crate::frame::sign::verify_frame(
            &jwk,
            receipt::FRAME_TYPE,
            &env.body,
            env_sig
        ));
        assert_eq!(
            pending[0].signed_hash,
            format!("sha256:{}", crate::sha256_hex(&pending[0].signed_bytes))
        );
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn propose_action_signs_and_uplinks_a_closed_action_prepare() {
        let path =
            std::env::temp_dir().join(format!("work-journalop-prop-{}.db", uuid::Uuid::new_v4()));
        let journal = Journal::create(&path, "dev", &dek::TestWrap).unwrap();
        let key = crate::key::SoftwareKey::random();
        let jwk = key.public_jwk();
        let (up_tx, mut up_rx) = mpsc::channel(8);
        let instance = InstanceFacts {
            agent_instance_id: "agent".into(),
            boot_id: "boot".into(),
        };
        let producer = Producer {
            key: &key,
            uplinks: &up_tx,
            instance: &instance,
        };
        let facts = ActionPrepareFacts {
            run_id: "run".into(),
            lease_id: "lease".into(),
            fence: 2,
            step_key: "tool:0:0".into(),
            logical_key: "tool:0:0#0".into(),
            checkpoint_seq: 1,
            checkpoint_hash: "a".repeat(64),
            request_hash: "b".repeat(64),
            action_kind: "artifact.write".into(),
            tool_schema: "write-v1".into(),
            local_payload_ref: "local/tool:0:0".into(),
            grant_id: "grant".into(),
            grant_revision: 1,
            resource_selector_hash: "c".repeat(64),
            classification: "local_only".into(),
            destination_id: None,
            byte_upper_bound: 1048576,
            token_upper_bound: 4096,
        };
        let op = JournalOp::ProposeAction {
            org_id: "org".into(),
            subject_id: "sub".into(),
            facts: Box::new(facts),
        };
        assert!(matches!(
            execute(&journal, &producer, op),
            JournalReply::Proposed
        ));
        let frame = up_rx.blocking_recv().unwrap();
        assert_eq!(frame.frame_type, action::ACTION_PREPARE_FRAME_TYPE);
        assert_eq!(frame.body["logical_key"], "tool:0:0#0");
        assert_eq!(frame.body["step_key"], "tool:0:0");
        assert_eq!(frame.body["lease_id"], "lease");
        assert_eq!(frame.body["fence"], "2");
        assert_eq!(frame.body["grant_id"], "grant");
        assert_eq!(frame.body["action_kind"], "artifact.write");
        // A fresh action carries all three supersede keys null (0042's all-or-none rule).
        assert!(frame.body["supersedes_operation_id"].is_null());
        assert!(frame.body["supersede_reason"].is_null());
        assert!(frame.body["supersede_assertion"].is_null());
        assert!(!frame.body["prepare_id"].as_str().unwrap().is_empty());
        let sig = frame.body["signature"].as_str().unwrap();
        assert!(crate::frame::sign::verify_frame(
            &jwk,
            action::ACTION_PREPARE_FRAME_TYPE,
            &frame.body,
            sig
        ));
        // The body is shape-consistent (the closed sets SQL enforces before writing).
        let body: action::ActionPrepareBody = serde_json::from_value(frame.body).unwrap();
        assert!(body.shape_consistent());
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn device_local_receipt_stamps_usage_source_and_omits_egress_fields() {
        let path =
            std::env::temp_dir().join(format!("work-journalop-usage-{}.db", uuid::Uuid::new_v4()));
        let journal = Journal::create(&path, "dev", &dek::TestWrap).unwrap();
        let key = crate::key::SoftwareKey::random();
        let instance = InstanceFacts {
            agent_instance_id: "agent".into(),
            boot_id: "boot".into(),
        };
        let (up_tx2, mut up_rx) = mpsc::channel(8);
        let producer = Producer {
            key: &key,
            uplinks: &up_tx2,
            instance: &instance,
        };
        let mut facts = receipt_facts("model:0", "completed");
        facts.usage = Some(serde_json::json!({ "total_tokens": 15 }));
        facts.usage_source = Some("device_adapter".into());
        let op = JournalOp::AppendReceipt {
            org_id: "org".into(),
            subject_id: "sub".into(),
            facts: Box::new(facts),
        };
        assert!(matches!(
            execute(&journal, &producer, op),
            JournalReply::ReceiptProduced { .. }
        ));
        let frame = up_rx.blocking_recv().unwrap();
        assert_eq!(frame.body["usage_source"], "device_adapter");
        assert_eq!(frame.body["usage"]["total_tokens"], 15);
        // device_local carries no egress-only fields (DD:264).
        assert!(frame.body.get("gateway_receipt_hash").is_none());
        assert!(frame.body.get("model_delivery").is_none());
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn checkpoint_persists_sealed_body_and_uplinks_a_commit_at_the_receipt_watermark() {
        let path =
            std::env::temp_dir().join(format!("work-journalop-cp-{}.db", uuid::Uuid::new_v4()));
        let journal = Journal::create(&path, "dev", &dek::TestWrap).unwrap();
        let key = crate::key::SoftwareKey::random();
        let jwk = key.public_jwk();
        let (up_tx, mut up_rx) = mpsc::channel(8);
        let instance = InstanceFacts {
            agent_instance_id: "agent".into(),
            boot_id: "boot".into(),
        };
        let producer = Producer {
            key: &key,
            uplinks: &up_tx,
            instance: &instance,
        };
        // Two receipts advance the watermark to 2.
        for op_id in ["op-1", "op-2"] {
            let op = JournalOp::AppendReceipt {
                org_id: "org".into(),
                subject_id: "sub".into(),
                facts: Box::new(receipt_facts(op_id, "completed")),
            };
            assert!(matches!(
                execute(&journal, &producer, op),
                JournalReply::ReceiptProduced { .. }
            ));
            let _ = up_rx.blocking_recv().unwrap();
        }
        let facts = CheckpointFacts {
            run_id: "run".into(),
            checkpoint_seq: 1,
            schema_version: crate::journal::schema::SCHEMA_VERSION,
            runtime_digest: "digest".into(),
            checkpoint_hash: "sha256:cp".into(),
            pending_operation_set_hash: "sha256:pending".into(),
            prior_receipt_ref: Some("2".into()),
            binding_revision: 1,
            fence: 1,
            local_checkpoint_ref: "run:1".into(),
        };
        let op = JournalOp::PersistCheckpoint {
            org_id: "org".into(),
            subject_id: "sub".into(),
            facts: Box::new(facts),
            plaintext: b"canonical checkpoint body".to_vec(),
        };
        assert!(matches!(
            execute(&journal, &producer, op),
            JournalReply::CheckpointProduced
        ));
        let frame = up_rx.blocking_recv().unwrap();
        assert_eq!(frame.frame_type, checkpoint::COMMIT_FRAME_TYPE);
        assert_eq!(frame.body["checkpoint_seq"], "1");
        assert_eq!(frame.body["receipt_through_seq"], "2");
        assert_eq!(frame.body["local_checkpoint_ref"], "run:1");
        let sig = frame.body["signature"].as_str().unwrap();
        assert!(crate::frame::sign::verify_frame(
            &jwk,
            checkpoint::COMMIT_FRAME_TYPE,
            &frame.body,
            sig
        ));
        // The sealed body round-trips under the identity-bound AAD; no plaintext reached the commit.
        let rctx = journal.context("org", "sub");
        let opened =
            recover::read_checkpoint(journal.connection(), journal.dek(), &rctx, "run", 1).unwrap();
        assert_eq!(opened, b"canonical checkpoint body");
        assert!(frame.body.get("ciphertext").is_none());
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
}
