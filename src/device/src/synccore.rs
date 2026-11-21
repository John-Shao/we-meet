//! The synchronous consumer core (execution-face design §6.1, ruling E4 甲).
//!
//! The journal is blocking SQLite (WAL + FULL); the async link pump cannot own it. This module
//! runs on a dedicated blocking `std::thread` that owns the journal, the sidecar lifecycle state
//! and the permit/lease context. The async entry forwards every [`LinkEvent`] it does not consume
//! here over a channel; the core verifies each downlink fail-closed, registers it in the journal
//! and produces signed uplink frames back over the link's independent uplink channel (batch 1a).
//!
//! Batch 1c lands the A2 consumption spine: command (two-layer verify + jti transaction register,
//! hold-for-dispatch), cancel (verify -> local stop fact -> cancel_ack), offer/start (resume
//! validation -> persist_start -> sidecar lifecycle -> run_ready/run_started), resolution and the
//! three server acks. The Node executor and real tool dispatch are batch 2; the real
//! CreateProcess into AppContainer+Job is batch 1d; the lease-invalidation Job kill is batch 1f.
//! Nothing here claims a production execution capability yet.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::sync::mpsc;

use crate::broker::ReadyIdentity;
use crate::finish::orchestrate::{self, FinishInput};
use crate::frame::{
    action, cancel, checkpoint, command, finish, offer, publish, receipt_ack, reconcile, resolution,
};
use crate::journal::record::{self, ActionRow};
use crate::journal::recover::{self, StartRow};
use crate::journal::{dek, Journal, JournalError};
use crate::key::DeviceKey;
use crate::permit::lease::{Lease, LeaseMode};
use crate::permit::signed::PermitContext;
use crate::reconcile::{resolution as resolution_consume, watermark};
use crate::recovery::{replay, resume};
use crate::sidecar::lifecycle::{Sidecar, SidecarState};
use crate::sidecar::spawn::SpawnConfig;
use crate::transport::{LinkCommand, LinkEvent, UplinkFrame};

/// Spawn the sync core thread. It opens (or creates) the per-device journal, publishes the journal
/// epoch back to the caller (hello carries it, §6.1 device_meta), then serves forwarded link events
/// until the event channel closes. Returns the event sender and the journal epoch. The caller MUST
/// receive the epoch before spawning the link, and drop the sender to stop the core on shutdown.
///
/// `spawn_template` carries the fixed sidecar inputs (node/bundle paths, staging base, digests);
/// `consume_start` derives the per-Run staging dir from it. The real signed bundle is batch 2.
/// The sync-core spawn result. `events` forwards downlinks; `epoch` is the journal epoch hello carries.
/// On Windows the long-lived Node service sender is also returned so the shell dispatch can route
/// workspace/model confirmation requests to the thread that owns the registries (execution-face §6.1).
pub struct SyncCoreSpawn {
    pub events: mpsc::Sender<LinkEvent>,
    pub epoch: String,
    #[cfg(windows)]
    pub node_service: tokio::sync::mpsc::Sender<crate::nodeservice::NodeRequest>,
}

#[allow(clippy::too_many_arguments)]
pub fn spawn_sync_core(
    journal_dir: String,
    ready: ReadyIdentity,
    key: Arc<dyn DeviceKey + Send + Sync>,
    uplinks: mpsc::Sender<UplinkFrame>,
    link_commands: mpsc::Sender<LinkCommand>,
    spawn_template: SpawnConfig,
    instance: crate::journalop::InstanceFacts,
    #[cfg(windows)] node_service: tokio::sync::mpsc::Sender<crate::nodeservice::NodeRequest>,
) -> Result<SyncCoreSpawn, String> {
    let (event_tx, mut event_rx) = mpsc::channel::<LinkEvent>(64);
    let (journal_handle, mut journal_op_rx) = crate::journalop::channel();
    let (epoch_tx, epoch_rx) = std::sync::mpsc::sync_channel::<Result<String, String>>(0);
    // The long-lived Node service thread owns the grant/endpoint registries + executor + proxy (§6.1).
    // The entry creates it once at startup (before the pump) so the shell confirmation face can route
    // to it even before the first certificate; this core shares the same sender for StartRun.
    #[cfg(windows)]
    let node_service_for_core = node_service.clone();
    std::thread::spawn(move || {
        let journal = match open_or_create_journal(&journal_dir, &ready.device_id) {
            Ok(journal) => journal,
            Err(err) => {
                let _ = epoch_tx.send(Err(err));
                return;
            }
        };
        let epoch = journal.journal_epoch().to_string();
        if epoch_tx.send(Ok(epoch)).is_err() {
            return;
        }
        let mut core = SyncCore::new(
            journal,
            ready,
            key,
            uplinks,
            link_commands,
            spawn_template,
            journal_handle,
            instance,
            #[cfg(windows)]
            node_service_for_core,
        );
        // Batch 2 ruling 甲: the Node pipe service loop runs on its OWN thread and requests journal
        // ops over `journal_op_rx`; this thread stays the journal's sole owner (E4 甲). The loop stays
        // a pure blocking thread (no async runtime, so `blocking_send` uplinks are valid): it waits on
        // downlinks with a short idle sleep and serves one journal op each tick. Neither a busy
        // journal producer nor downlinks can starve the other. Check the monotonic Run deadline
        // independently of link events. Blocking OS/journal calls are not a hard real-time bound.
        loop {
            core.expire_lease(Instant::now());
            match event_rx.try_recv() {
                Ok(event) => core.handle(event),
                Err(mpsc::error::TryRecvError::Empty) => {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    core.lose_execution_authority();
                    break;
                }
            }
            // The Node loop-end reply is the finish candidate signal (§3.4 step 1). Take the result
            // out before mutating the core (the receiver borrow must end first).
            let ended = core.run_end_rx.as_mut().and_then(|rx| rx.try_recv().ok());
            if let Some(result) = ended {
                core.on_run_ended(result);
            }
            if let Ok((op, reply_tx)) = journal_op_rx.try_recv() {
                core.expire_lease(Instant::now());
                let reply = match op {
                    // The sync core owns the per-Run deliverable set (DD:137 own execution facts)
                    // and the per-version publication facts (batch 4 local_publish payload).
                    crate::journalop::JournalOp::RecordDeliverable { facts } => {
                        core.deliverables
                            .entry(facts.run_id.clone())
                            .or_default()
                            .push(facts.version_id.clone());
                        core.deliverable_facts
                            .insert(facts.version_id.clone(), *facts);
                        crate::journalop::JournalReply::DeliverableRecorded
                    }
                    // Capture the completed receipt's seq per operation so batch 4's local_publish
                    // can name receipt_ref = journal_epoch:seq (the device's own receipt identity).
                    crate::journalop::JournalOp::AppendReceipt { ref facts, .. } => {
                        let op_id = facts.operation_id.clone();
                        let completed = facts.state == "completed";
                        let producer = crate::journalop::Producer {
                            key: core.key.as_ref(),
                            uplinks: &core.uplinks,
                            instance: &core.instance,
                        };
                        let reply = crate::journalop::execute(core.journal(), &producer, op);
                        if completed {
                            if let crate::journalop::JournalReply::ReceiptProduced { seq, .. } =
                                &reply
                            {
                                core.receipt_seq_by_op.insert(op_id, *seq);
                            }
                        }
                        reply
                    }
                    other => {
                        let producer = crate::journalop::Producer {
                            key: core.key.as_ref(),
                            uplinks: &core.uplinks,
                            instance: &core.instance,
                        };
                        crate::journalop::execute(core.journal(), &producer, other)
                    }
                };
                // Receipt production advances the device-wide watermark cancel_ack/heartbeat carry;
                // re-read it from device_meta so a produced seq is never stale (E4 甲 single owner).
                core.last_receipt_seq = current_receipt_seq(core.journal(), &core.device_id);
                let _ = reply_tx.send(reply);
                // A new receipt/deliverable may make a pending finish judgeable.
                core.attempt_finish();
            }
        }
    });
    let epoch = epoch_rx.recv().map_err(|_| {
        "the sync core thread died before publishing the journal epoch".to_string()
    })??;
    Ok(SyncCoreSpawn {
        events: event_tx,
        epoch,
        #[cfg(windows)]
        node_service,
    })
}

/// Open the per-device journal, creating it on first pairing. Moved here from the entry (batch 1c):
/// the sync core is the journal's sole owner. See the entry's former helper for the fail-closed
/// rationale (a locked/unreadable ledger is never rebuilt empty under an existing device).
fn open_or_create_journal(dir: &str, device_id: &str) -> Result<Journal, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create journal dir: {e}"))?;
    let db_path = Path::new(dir).join(format!("{device_id}.db"));
    #[cfg(windows)]
    let wrap = dek::DpapiWrap;
    #[cfg(not(windows))]
    let wrap = dek::TestWrap;
    match Journal::open(&db_path, device_id, &wrap) {
        Ok(journal) => Ok(journal),
        Err(JournalError::NotFound) => Journal::create(&db_path, device_id, &wrap)
            .map_err(|e| format!("create journal: {e:?}")),
        Err(err) => Err(format!("open journal: {err:?}")),
    }
}

/// The blocking consumer state. One thread owns it; nothing here is synchronised internally.
struct SyncCore {
    journal: Journal,
    key: Arc<dyn DeviceKey + Send + Sync>,
    device_id: String,
    org_id: String,
    subject_id: String,
    uplinks: mpsc::Sender<UplinkFrame>,
    // The link's command channel: consume_start tracks the Run's lease here so the link renewes it
    // on heartbeat and invalidates it (Job kill) when the session ends (E7 甲, §3.3).
    link_commands: mpsc::Sender<LinkCommand>,
    // Session-provisioned authority (hello_ack). Until a session exists no downlink can verify.
    server_jwk: Option<crate::jwk::EcP256Jwk>,
    permit_jwk: Option<crate::jwk::EcP256Jwk>,
    session_id: Option<String>,
    generation: u64,
    // A hello provisions keys/cadence, not a Run lease. Only a verified start acquires these.
    lease_deadline: Option<Instant>,
    lease_id: Option<String>,
    lease_mode: LeaseMode,
    // Expiry/session loss forbids queued command/start from restoring the old authority.
    session_accepts_work: bool,
    lease_ttl: std::time::Duration,
    // The current Run binding (offer -> start). run_fence is the permit identity gate's fence.
    offer: Option<offer::RunOfferBody>,
    ready_sent_at: Option<Instant>,
    run_fence: u64,
    sidecar: Option<Sidecar>,
    #[cfg_attr(not(windows), allow(dead_code))]
    spawn_template: SpawnConfig,
    // The journal-op handle the Node service thread clones to request journal ops of this core (甲).
    #[allow(dead_code)]
    journal_handle: crate::journalop::JournalHandle,
    // The device runtime instance facts (BrokerConfig agent_instance_id/boot_id) bound into every
    // produced receipt's historical envelope (A3, the same facts the link stamps on transport).
    instance: crate::journalop::InstanceFacts,
    // The spawned process tree (Windows). Dropping it kills the Job tree (batch 1f lease kill).
    #[cfg(windows)]
    process: Option<crate::sidecar::spawn::SidecarProcess>,
    // The long-lived Node service sender (Windows): consume_start fires StartRun at it (§6.1).
    #[cfg(windows)]
    node_service: tokio::sync::mpsc::Sender<crate::nodeservice::NodeRequest>,
    // Commands verified + jti-registered "hold for dispatch", forwarded to the Node tool loop at start.
    #[cfg(windows)]
    dispatched: Vec<crate::nodeservice::DispatchedCommand>,
    // The live per-Run command map (A2 write spine): (run_id, shared map) for the active Run, so a
    // command consumed mid-Run reaches the running executor (§6.3 C). None until consume_start.
    #[cfg(windows)]
    active_commands: Option<(String, crate::nodeservice::SharedCommands)>,
    #[cfg(windows)]
    io_deadline: Option<Arc<std::sync::Mutex<Option<Instant>>>>,
    last_receipt_seq: u64,
    // ---- batch 3: the five-step finish + reconcile state (device-design §3.4/§6.3) ----
    // The active Run binding captured at start (the finish proposal names these).
    active_run: Option<ActiveRun>,
    // The serve_run loop-end reply (kept, not dropped): its resolution is the finish candidate signal.
    run_end_rx: Option<tokio::sync::oneshot::Receiver<Result<(), String>>>,
    // Sealed deliverable versions the Broker wrote per Run (RecordDeliverable; DD:137 own facts).
    deliverables: HashMap<String, Vec<String>>,
    // Model dispatches still pending/undelivered per Run (reconciled from resolution delivery_state).
    undelivered: HashMap<String, HashSet<String>>,
    // The latest checkpoint seq the server has RECORDED per Run (finish references a recorded row).
    recorded_checkpoint: HashMap<String, u64>,
    // A Run whose loop ended and awaits a finish judgment (re-evaluated as resolutions/acks arrive).
    finish_pending: Option<FinishPending>,
    // The finish_id whose ack is awaited (a durable proposal exists; replay re-sends it verbatim).
    awaiting_finish_ack: Option<String>,
    // Runs stopped from proposing (stale_fence / terminal) — never re-judged (§3.4 step 4).
    finish_stopped: HashSet<String>,
    // ---- batch 4: local publication state (device-design §7.1 step 4; 0059 completed precondition) ----
    // Per-version sealed deliverable facts the local_publish payload is built from (RecordDeliverable).
    deliverable_facts: HashMap<String, crate::journalop::DeliverableFacts>,
    // The completed receipt seq per operation (AppendReceipt reply), so receipt_ref = epoch:seq.
    receipt_seq_by_op: HashMap<String, u64>,
    // Versions the server has confirmed published per Run (verified publish_ack). A completed finish
    // waits until every sealed deliverable of the Run is published (0059 needs the published rows).
    published: HashMap<String, HashSet<String>>,
    // Versions whose local_publish is in flight (sent, ack pending) — never re-sent each tick.
    publish_pending: HashSet<String>,
}

/// The active Run binding the finish proposal names (captured at run_start).
#[derive(Clone)]
struct ActiveRun {
    run_id: String,
    binding_revision: u64,
    fence: u64,
    lease_id: String,
}

/// A Run whose Node loop ended, awaiting a finish judgment over the reconciled journal facts.
#[derive(Clone)]
struct FinishPending {
    run_id: String,
    binding_revision: u64,
    fence: u64,
    lease_id: String,
    loop_ended_normally: bool,
}

impl SyncCore {
    #[allow(clippy::too_many_arguments)]
    fn new(
        journal: Journal,
        ready: ReadyIdentity,
        key: Arc<dyn DeviceKey + Send + Sync>,
        uplinks: mpsc::Sender<UplinkFrame>,
        link_commands: mpsc::Sender<LinkCommand>,
        spawn_template: SpawnConfig,
        journal_handle: crate::journalop::JournalHandle,
        instance: crate::journalop::InstanceFacts,
        #[cfg(windows)] node_service: tokio::sync::mpsc::Sender<crate::nodeservice::NodeRequest>,
    ) -> Self {
        let last_receipt_seq = current_receipt_seq(&journal, &ready.device_id);
        Self {
            journal,
            key,
            device_id: ready.device_id,
            org_id: ready.org_id,
            subject_id: ready.subject_id,
            uplinks,
            link_commands,
            server_jwk: None,
            permit_jwk: None,
            session_id: None,
            generation: 0,
            lease_deadline: None,
            lease_id: None,
            lease_mode: LeaseMode::Invalid,
            session_accepts_work: false,
            lease_ttl: std::time::Duration::from_secs(30),
            offer: None,
            ready_sent_at: None,
            run_fence: 0,
            sidecar: None,
            spawn_template,
            journal_handle,
            instance,
            #[cfg(windows)]
            process: None,
            #[cfg(windows)]
            node_service,
            #[cfg(windows)]
            dispatched: Vec::new(),
            #[cfg(windows)]
            active_commands: None,
            #[cfg(windows)]
            io_deadline: None,
            last_receipt_seq,
            active_run: None,
            run_end_rx: None,
            deliverables: HashMap::new(),
            undelivered: HashMap::new(),
            recorded_checkpoint: HashMap::new(),
            finish_pending: None,
            awaiting_finish_ack: None,
            finish_stopped: HashSet::new(),
            deliverable_facts: HashMap::new(),
            receipt_seq_by_op: HashMap::new(),
            published: HashMap::new(),
            publish_pending: HashSet::new(),
        }
    }

    fn journal(&self) -> &Journal {
        &self.journal
    }

    fn handle(&mut self, event: LinkEvent) {
        self.expire_lease(Instant::now());
        match event {
            LinkEvent::SessionEstablished(ack) => {
                if self.session_id.as_deref() != Some(ack.session_id.as_str()) {
                    // A new session cannot renew an old Run's lease. Repeated hello metadata for
                    // the same session must not undo expiry, either.
                    self.lose_execution_authority();
                    self.session_accepts_work = true;
                }
                self.server_jwk = Some(ack.server_jwk.clone());
                self.permit_jwk = Some(ack.permit_jwk.clone());
                self.session_id = Some(ack.session_id.clone());
                self.generation = ack.generation;
                self.lease_ttl = ack.lease_ttl;
                eprintln!("work-device: session established, sync core provisioned");
                // §6.3 (ruling 甲): a fresh session reconciles — re-upload un-acked receipts verbatim
                // and replay un-acked finish proposals before any new lease/offer is considered.
                self.reconcile_uplink();
            }
            LinkEvent::LeaseRenewal(state) => {
                if self.lease_id.as_deref() != Some(state.lease_id.as_str())
                    || state.fence != self.run_fence
                    || self.lease_deadline.is_none()
                    || self.lease_mode == LeaseMode::Invalid
                {
                    return;
                }
                match state.mode {
                    LeaseMode::Invalid => self.lose_execution_authority(),
                    LeaseMode::HistoryReturn => {
                        // History remains uploadable; it never authorizes a running executor or
                        // a new permit. extended=false alone is NOT invalidation.
                        self.lease_mode = LeaseMode::HistoryReturn;
                        self.lease_deadline = Some(state.deadline);
                        self.offer = None;
                        self.ready_sent_at = None;
                        self.kill_sidecar();
                    }
                    LeaseMode::Active if state.extended && self.lease_mode == LeaseMode::Active => {
                        self.lease_deadline = Some(state.deadline);
                        #[cfg(windows)]
                        if let Some(deadline) = &self.io_deadline {
                            *deadline.lock().unwrap() = Some(state.deadline);
                        }
                    }
                    LeaseMode::Active => {}
                }
                self.expire_lease(Instant::now());
            }
            LinkEvent::LeasesInvalidated { ids, cause } => {
                // The link ends the whole session, including any start still queued for tracking.
                self.lose_execution_authority();
                eprintln!("work-device: leases invalidated {ids:?} ({cause:?}), sidecar killed");
            }
            LinkEvent::Downlink(env) => self.route_downlink(&env.frame_type, env.body.clone()),
            LinkEvent::Disconnected { reason, attempt } => {
                self.lose_execution_authority();
                eprintln!("work-device: link disconnected (attempt {attempt}): {reason}");
            }
            LinkEvent::Stopped => self.lose_execution_authority(),
            LinkEvent::AwaitingTicket => {}
        }
    }

    fn route_downlink(&mut self, frame_type: &str, body: Value) {
        // No session authority yet: a downlink cannot be verified, so it is dropped fail-closed
        // rather than guessed. The link only forwards downlinks after a session, so this is a guard.
        let server_jwk = match &self.server_jwk {
            Some(jwk) => jwk.clone(),
            None => {
                eprintln!("work-device: downlink {frame_type} before session, dropped");
                return;
            }
        };
        match frame_type {
            command::COMMAND_FRAME_TYPE => self.consume_command(&server_jwk, body),
            cancel::CANCEL_FRAME_TYPE => self.consume_cancel(&server_jwk, body),
            offer::OFFER_FRAME_TYPE => self.consume_offer(&server_jwk, body),
            offer::START_FRAME_TYPE => self.consume_start(&server_jwk, body),
            resolution::FRAME_TYPE => self.consume_resolution(&server_jwk, body),
            checkpoint::ACK_FRAME_TYPE => self.consume_checkpoint_ack(&server_jwk, body),
            finish::FINISH_ACK_FRAME_TYPE => self.consume_finish_ack(&server_jwk, body),
            publish::PUBLISH_ACK_FRAME_TYPE => self.consume_publish_ack(&server_jwk, body),
            receipt_ack::FRAME_TYPE | crate::frame::reconcile::FRAME_TYPE => {
                self.consume_receipt_ack(&server_jwk, frame_type, body)
            }
            action::ACTION_PREPARED_FRAME_TYPE => self.consume_action_prepared(&server_jwk, body),
            other => eprintln!("work-device: downlink {other} not consumed (closed router)"),
        }
    }

    /// DD:123 — verify the frame (server key) AND the nested permit (independent permit key), bind
    /// the permit to the command, then register the jti in ONE SQLite transaction before dispatch.
    /// A re-sent command whose jti is already consumed returns the journal, never re-executes.
    /// Batch 1c holds the registered action for dispatch (the Node executor is batch 2).
    fn consume_command(&mut self, server_jwk: &crate::jwk::EcP256Jwk, body: Value) {
        self.expire_lease(Instant::now());
        if !self.session_accepts_work || self.lease_mode != LeaseMode::Active {
            eprintln!("work-device: command without an active Run lease, refused");
            return;
        }
        let cmd: command::CommandBody = match serde_json::from_value(body) {
            Ok(cmd) => cmd,
            Err(err) => {
                eprintln!("work-device: command schema refused: {err}");
                return;
            }
        };
        if !cmd.verify(server_jwk) {
            eprintln!("work-device: command frame signature refused");
            return;
        }
        let permit_jwk = match &self.permit_jwk {
            Some(jwk) => jwk.clone(),
            None => return,
        };
        let session_id = match &self.session_id {
            Some(id) => id.clone(),
            None => return,
        };
        let ctx = PermitContext {
            server_permit_key: &permit_jwk,
            org_id: &self.org_id,
            subject_id: &self.subject_id,
            device_id: &self.device_id,
            session_id: &session_id,
            run_fence: self.run_fence,
            now_unix: now_unix(),
            remaining_lease_secs: self.remaining_lease_secs(),
        };
        if let Err(err) = cmd.verify_permit(&ctx) {
            eprintln!("work-device: command permit refused: {err:?}");
            return;
        }
        if !cmd.permit_matches_command() {
            eprintln!("work-device: command permit does not bind the command");
            return;
        }
        // The full command (dispatch_attempt_id, tool_schema, local_payload_ref, permit) is sealed
        // verbatim as the action body; the indexed columns carry the queryable identity. attempt is
        // the server's uuid dispatch_attempt_id (the receipt gate binds to it); state="started"
        // follows the landed jti precedent; supersede/re-dispatch is batch 3 reconcile scope.
        let plaintext = match serde_json::to_vec(&cmd) {
            Ok(bytes) => bytes,
            Err(err) => {
                eprintln!("work-device: command encode failed: {err}");
                return;
            }
        };
        let rctx = self.journal.context(&self.org_id, &self.subject_id);
        let row = ActionRow {
            org_id: &self.org_id,
            operation_id: &cmd.operation_id,
            run_id: &cmd.run_id,
            attempt: &cmd.dispatch_attempt_id,
            step_key: &cmd.logical_key,
            logical_key: &cmd.logical_key,
            supersedes: None,
            request_hash: &cmd.request_hash,
            fence: cmd.permit.fence as i64,
            session_id: &cmd.permit.session_id,
            generation: cmd.permit.generation as i64,
            permit_jti: &cmd.permit.jti,
            state: "started",
            result_hash: None,
            result_ref: None,
        };
        let conn = self.journal.connection();
        let registered = (|| -> Result<(), record::RecordError> {
            // The journal exposes only &Connection (single owner, no nested transactions), so the
            // &self transaction constructor is the correct one; the jti INSERT + commit are atomic.
            let tx = conn.unchecked_transaction()?;
            record::append_action(&tx, self.journal.dek(), &rctx, &row, &plaintext)?;
            tx.commit()?;
            Ok(())
        })();
        match registered {
            Ok(()) => {
                eprintln!(
                    "work-device: command {} jti registered (hold for dispatch, batch 2)",
                    cmd.operation_id
                );
                // Feed the verified command to the Node tool loop. If a Run is active for this
                // run_id, insert into the live per-Run map so the running executor sees it mid-Run
                // (A2 write spine, §6.3 C); otherwise buffer it for the next StartRun.
                #[cfg(windows)]
                {
                    let dispatched = crate::nodeservice::DispatchedCommand {
                        operation_id: cmd.operation_id.clone(),
                        logical_key: cmd.logical_key.clone(),
                        tool_name: cmd.tool_schema.clone(),
                        request_hash: cmd.request_hash.clone(),
                        permit_jti: cmd.permit.jti.clone(),
                        fence: cmd.permit.fence,
                        generation: cmd.permit.generation,
                        dispatch_attempt_id: cmd.dispatch_attempt_id.clone(),
                    };
                    match &self.active_commands {
                        Some((run_id, live)) if run_id == &cmd.run_id => {
                            live.lock()
                                .unwrap()
                                .insert(dispatched.logical_key.clone(), dispatched);
                        }
                        _ => {
                            self.dispatched.push(dispatched);
                        }
                    }
                }
            }
            Err(record::RecordError::Sql(_)) => {
                // The jti is already consumed: return the journal, do not execute again (DD:123).
                match record::read_action(
                    conn,
                    self.journal.dek(),
                    &rctx,
                    &self.org_id,
                    &cmd.operation_id,
                ) {
                    Ok(_) => eprintln!(
                        "work-device: command {} jti already consumed, journal returned",
                        cmd.operation_id
                    ),
                    Err(err) => eprintln!("work-device: consumed-jti read failed: {err:?}"),
                }
            }
            Err(err) => eprintln!("work-device: command registration failed: {err:?}"),
        }
    }

    /// DD:101 — verify the cancel, derive the local stop fact from the sidecar state (Exited ->
    /// Confirmed, otherwise Unconfirmed; no sidecar -> Exited), sign cancel_ack and uplink it.
    /// `stopped` only confirms the local process stop, never claims no external effect.
    fn consume_cancel(&mut self, server_jwk: &crate::jwk::EcP256Jwk, body: Value) {
        let cancel_body: cancel::CancelBody = match serde_json::from_value(body) {
            Ok(body) => body,
            Err(err) => {
                eprintln!("work-device: cancel schema refused: {err}");
                return;
            }
        };
        if !cancel_body.verify(server_jwk) {
            eprintln!("work-device: cancel signature refused");
            return;
        }
        // DD:101: a verified cancel stops the local sidecar (Job kill-on-close), then the stop fact
        // is read from the resulting lifecycle state. `stopped` confirms only the local process
        // stop, never claims no external effect.
        self.retire_run_lease();
        let state = self
            .sidecar
            .as_ref()
            .map(|s| s.state())
            .unwrap_or(SidecarState::Exited);
        let local = cancel::LocalStop::from_sidecar_state(state);
        let mut ack = cancel::CancelAckBody::for_stop(&cancel_body, self.last_receipt_seq, local);
        if let Err(err) = ack.sign(self.key.as_ref()) {
            eprintln!("work-device: cancel_ack sign failed: {err:?}");
            return;
        }
        self.uplink(cancel::CANCEL_ACK_FRAME_TYPE, ack.to_value());
    }

    /// DD:113 — verify the offer; a resume offer must validate against local journal facts before
    /// ready. Store the offer so run_start can match it, then uplink run_ready.
    fn consume_offer(&mut self, server_jwk: &crate::jwk::EcP256Jwk, body: Value) {
        self.expire_lease(Instant::now());
        if !self.session_accepts_work {
            return;
        }
        let offer_body: offer::RunOfferBody = match serde_json::from_value(body) {
            Ok(body) => body,
            Err(err) => {
                eprintln!("work-device: offer schema refused: {err}");
                return;
            }
        };
        if !offer_body.verify(server_jwk) {
            eprintln!("work-device: offer signature refused");
            return;
        }
        let mut reason = "ready";
        if offer_body.is_resume() {
            let resume_offer = resume::ResumeOffer::from_wire(&offer_body, "");
            match resume::validate_resume(
                self.journal.connection(),
                self.journal.journal_epoch(),
                &resume_offer,
            ) {
                Ok(()) => {
                    // §6.3 (ruling 甲): a validated resume re-uploads the Run's un-acked receipts
                    // verbatim before re-entering execution.
                    self.reconcile_uplink();
                }
                Err(
                    resume::ResumeError::MissingCheckpoint
                    | resume::ResumeError::CheckpointMismatch,
                ) => {
                    reason = "missing_input";
                }
                Err(resume::ResumeError::PriorReceiptsIncomplete) => {
                    reason = "needs_reauthorization"
                }
                Err(err) => {
                    // TerminalRun / StaleRevision / Sql: explicit stop, never re-run from input.
                    eprintln!("work-device: resume offer refused: {err:?}");
                    return;
                }
            }
        }
        self.offer = Some(offer_body.clone());
        let mut ready = offer::RunReadyBody::new(&offer_body, reason);
        if let Err(err) = ready.sign(self.key.as_ref()) {
            eprintln!("work-device: run_ready sign failed: {err:?}");
            return;
        }
        // Measure from before queueing run_ready, so queue/signalling delay consumes, never
        // adds to, the acquiring exchange's budget. hello's arrival is not this exchange.
        self.ready_sent_at = Some(Instant::now());
        self.uplink(offer::READY_FRAME_TYPE, ready.to_value());
    }

    /// DD:113 — verify the start, match it to the stored offer, persist start_nonce BEFORE spawn,
    /// then bring up the single sidecar lifecycle and uplink run_started. The real CreateProcess
    /// into AppContainer+Job is batch 1d; batch 1c advances the lifecycle state machine only.
    fn consume_start(&mut self, server_jwk: &crate::jwk::EcP256Jwk, body: Value) {
        self.expire_lease(Instant::now());
        if !self.session_accepts_work {
            eprintln!("work-device: start under expired/lost session authority, refused");
            return;
        }
        let start: offer::RunStartBody = match serde_json::from_value(body) {
            Ok(body) => body,
            Err(err) => {
                eprintln!("work-device: start schema refused: {err}");
                return;
            }
        };
        if !start.verify(server_jwk) {
            eprintln!("work-device: start signature refused");
            return;
        }
        let offer_body = match &self.offer {
            Some(offer) => offer.clone(),
            None => {
                eprintln!("work-device: start without a matching offer");
                return;
            }
        };
        if !start.matches_offer(&offer_body)
            || self.session_id.as_deref() != Some(start.session_id.as_str())
            || offer_body.original_target.session_id != start.session_id
        {
            eprintln!("work-device: start does not match the stored offer/session");
            return;
        }
        // Replayed run_start must never spawn a second sidecar, including after a crash.
        match recover::read_start(
            self.journal.connection(),
            &start.run_id,
            start.run_binding_id as i64,
        ) {
            Ok(None) => {}
            Ok(Some(_)) | Err(_) => return,
        }
        let sent_at = match self.ready_sent_at {
            Some(sent_at) => sent_at,
            None => return,
        };
        let received_at = Instant::now();
        let round_trip = received_at.saturating_duration_since(sent_at);
        let lease = Lease::acquire(sent_at, self.lease_ttl, round_trip, start.fence);
        if !lease.is_valid(received_at) {
            eprintln!("work-device: start exchange exhausted the Run lease, refused");
            return;
        }
        let row = StartRow {
            run_id: start.run_id.clone(),
            binding_revision: start.run_binding_id as i64,
            binding_hash: offer_body.binding_hash.clone(),
            start_nonce: start.start_nonce.clone(),
            state: "started".into(),
            expected_checkpoint_ref: None,
            expected_checkpoint_hash: offer_body.expected_checkpoint_hash.clone(),
        };
        if let Err(err) = recover::persist_start(self.journal.connection(), &row) {
            eprintln!("work-device: persist_start failed: {err:?}");
            return;
        }
        self.run_fence = start.fence;
        self.generation = start.generation;
        self.lease_id = Some(start.lease_id.clone());
        self.lease_mode = lease.mode();
        self.lease_deadline = Some(lease.deadline());
        // DD:113: start_nonce is persisted above BEFORE the sidecar spawns. Batch 1d spawns the
        // single sidecar into a fresh AppContainer+Job (kill-on-close); the real signed bundle and
        // tool loop are batch 2. A spawn refusal leaves no run_started and no live process.
        let mut sidecar = Sidecar::new(
            &start.run_id,
            start.run_binding_id,
            &start.start_nonce,
            &start.runtime_digest,
        );
        #[cfg(windows)]
        {
            let mut config = self.spawn_template.clone();
            config.staging_dir = std::path::Path::new(&self.spawn_template.staging_dir)
                .join(&start.run_id)
                .to_string_lossy()
                .into_owned();
            config.runtime_digest = start.runtime_digest.clone();
            // DD:113 spawn-time digest gate (execution-face §6.4): re-hash the bundle's signed files
            // and refuse a drifted/substituted bundle BEFORE CreateProcess, so only the single sidecar
            // of the designated digest ever starts. The pin came down with the offer (start.runtime_digest).
            let bundle_dir = std::path::Path::new(&config.bundle_path)
                .parent()
                .unwrap_or(std::path::Path::new("."));
            if let Err(err) = crate::digest::verify_bundle(bundle_dir, &config.runtime_digest) {
                eprintln!("work-device: bundle digest refused ({err:?}), run not started");
                return;
            }
            // The per-Run Node↔Broker pipe name is fixed before spawn (the bundle gets it as argv[2]).
            let pipe_name = format!(
                "\\\\.\\pipe\\work-device-node-{}-{}",
                start.run_id,
                uuid::Uuid::new_v4()
            );
            if self.expire_lease(Instant::now()) {
                return;
            }
            match crate::sidecar::spawn::spawn_sidecar(&config, &start.run_id, &pipe_name) {
                Ok(mut process) => {
                    if self.expire_lease(Instant::now()) {
                        // The local process has not been handed off; dropping it closes its Job.
                        return;
                    }
                    // Fire StartRun at the long-lived Node service thread (§6.1). Fire-and-forget: the
                    // Run's pipe loop runs on that thread while this sync core stays responsive to
                    // cancel/lease (E7 甲). The profile/model/bounds are the dev fixture profile this
                    // period (E3 乙); the production ExecutionProfile binding lands with #184/M4.
                    let container_sid = process.container_sid().to_vec();
                    let sidecar_pid = process.pid();
                    // The pipe was created while the sidecar was suspended (no connect race); take
                    // its handle so the Node-service thread can rebuild the server and accept.
                    let pipe_handle = match process.take_node_pipe_handle() {
                        Some(handle) => handle,
                        None => {
                            eprintln!("work-device: sidecar spawned without a node pipe handle");
                            return;
                        }
                    };
                    self.process = Some(process);
                    // Operational supervision fact: the spawned sidecar pid (the Job kill-on-close
                    // target for cancel/lease loss; the interop kill evidence parses this line).
                    eprintln!("work-device: sidecar spawned pid={sidecar_pid}");
                    let bootstrap = crate::ipc::nodepipe::RunBootstrap {
                        run_id: start.run_id.clone(),
                        binding_revision: start.run_binding_id,
                        start_nonce: start.start_nonce.clone(),
                        profile_id: "profile-dev-fixture-v1".into(),
                        compat_profile_version: 1,
                        tool_manifest_hash: self.spawn_template.manifest_hash.clone(),
                        runtime_digest: start.runtime_digest.clone(),
                        model_provider: "device-local".into(),
                        model_name: "fixture-model".into(),
                        model_config_revision: 1,
                        sealed_input_refs: Vec::new(),
                        max_turns: 8,
                        max_tokens: 4096,
                        max_bytes: 1_048_576,
                        deadline: start.expiry.clone(),
                    };
                    let io_deadline = Arc::new(std::sync::Mutex::new(self.lease_deadline));
                    self.io_deadline = Some(io_deadline.clone());
                    let ctx = crate::nodeservice::RunContext {
                        run_id: start.run_id.clone(),
                        org_id: self.org_id.clone(),
                        subject_id: self.subject_id.clone(),
                        session_id: start.session_id.clone(),
                        fence: start.fence,
                        generation: start.generation,
                        profile_id: "profile-dev-fixture-v1".into(),
                        journal: self.journal_handle.clone(),
                        lease_id: start.lease_id.clone(),
                        // The seq=0 baseline acquire_device_lease writes is the binding's
                        // input_hash (0041); a fresh offer leaves expected_checkpoint_hash null,
                        // so the first action_prepare prepares against input_hash at seq=0. A
                        // resume offer carries the latest recorded checkpoint instead.
                        baseline_checkpoint_hash: offer_body
                            .expected_checkpoint_hash
                            .clone()
                            .unwrap_or_else(|| offer_body.input_hash.clone()),
                        grant_set: offer_body.grant_set.clone(),
                        io_deadline,
                    };
                    // The live per-Run command map (A2 write spine): seed it with the commands
                    // consumed before start, then keep it so consume_command can feed mid-Run
                    // commands to the running executor. The pre-start buffer is now drained.
                    let live =
                        crate::nodeservice::shared_commands(std::mem::take(&mut self.dispatched));
                    self.active_commands = Some((start.run_id.clone(), live.clone()));
                    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                    let sent = self.node_service.blocking_send(
                        crate::nodeservice::NodeRequest::StartRun {
                            ctx,
                            bootstrap: Box::new(bootstrap),
                            pipe_handle,
                            container_sid,
                            sidecar_pid,
                            commands: live,
                            reply: reply_tx,
                        },
                    );
                    if sent.is_err() {
                        unsafe {
                            let _ = windows::Win32::Foundation::CloseHandle(
                                windows::Win32::Foundation::HANDLE(
                                    pipe_handle as *mut std::ffi::c_void,
                                ),
                            );
                        }
                        eprintln!("work-device: node service gone, run not started");
                        return;
                    }
                    // Keep the loop-end reply (batch 3): its resolution is the finish candidate
                    // signal the sync core polls in its event loop (§3.4 step 1).
                    self.run_end_rx = Some(reply_rx);
                }
                Err(err) => {
                    eprintln!("work-device: sidecar spawn refused: {err:?}");
                    return;
                }
            }
        }
        if let Err(err) = sidecar.mark_running() {
            eprintln!("work-device: sidecar lifecycle refused: {err:?}");
            return;
        }
        self.sidecar = Some(sidecar);
        // Capture the Run binding the finish proposal will name (batch 3, §3.4).
        self.active_run = Some(ActiveRun {
            run_id: start.run_id.clone(),
            binding_revision: start.run_binding_id,
            fence: start.fence,
            lease_id: start.lease_id.clone(),
        });
        if self.expire_lease(Instant::now()) {
            return;
        }
        // §3.3: the Run's lease comes from run_start. Track it in the link so heartbeat renewes it
        // and a session end invalidates it (LeasesInvalidated -> Job kill, E7 甲). Without this the
        // link holds no lease, never renewes, and a revoked device's session loss kills nothing.
        let _ = self.link_commands.blocking_send(LinkCommand::TrackLease {
            lease_id: start.lease_id.clone(),
            fence: start.fence,
            sent_at,
            ttl: self.lease_ttl,
            round_trip,
        });
        let (checkpoint_ref, checkpoint_hash) = self.latest_checkpoint_ref(&start.run_id);
        let mut started = offer::RunStartedBody {
            start_nonce: start.start_nonce.clone(),
            state: "running".into(),
            checkpoint_ref,
            checkpoint_hash,
            signature: None,
        };
        if let Err(err) = started.sign(self.key.as_ref()) {
            eprintln!("work-device: run_started sign failed: {err:?}");
            return;
        }
        self.uplink(offer::STARTED_FRAME_TYPE, started.to_value());
    }

    /// DD:104 — consume the resolution (verify + validate + apply) and uplink the unsigned ack.
    fn consume_resolution(&mut self, server_jwk: &crate::jwk::EcP256Jwk, body: Value) {
        let res: resolution::OperationResolutionBody = match serde_json::from_value(body) {
            Ok(body) => body,
            Err(err) => {
                eprintln!("work-device: resolution schema refused: {err}");
                return;
            }
        };
        // §3.4 step 2: a resolution carrying delivery_state pending/undelivered means the model
        // dispatch still blocks `completed` (superseded/delivered clears it). Track it per Run so the
        // finish judge sees the same blocking fact the server's finish_local_run gate enforces.
        let run_id = res.run_id.clone();
        let operation_id = res.operation_id.clone();
        let blocking = matches!(res.delivery_state.as_str(), "pending" | "undelivered");
        match resolution_consume::consume(self.journal.connection(), server_jwk, &self.org_id, &res)
        {
            Ok(ack) => {
                if ack.state == "applied" {
                    let set = self.undelivered.entry(run_id).or_default();
                    if blocking {
                        set.insert(operation_id);
                    } else {
                        set.remove(&operation_id);
                    }
                }
                self.uplink(resolution::ACK_FRAME_TYPE, ack.to_value());
                // A resolution may terminalize the last operation → the finish becomes judgeable.
                self.attempt_finish();
            }
            Err(err) => eprintln!("work-device: resolution consume refused: {err:?}"),
        }
    }

    fn consume_checkpoint_ack(&mut self, server_jwk: &crate::jwk::EcP256Jwk, body: Value) {
        let ack: checkpoint::CheckpointAckBody = match serde_json::from_value(body) {
            Ok(body) => body,
            Err(err) => {
                eprintln!("work-device: checkpoint_ack schema refused: {err}");
                return;
            }
        };
        if !ack.verify(server_jwk) {
            eprintln!("work-device: checkpoint_ack signature refused");
            return;
        }
        // Track the latest RECORDED checkpoint seq per Run: the finish references a recorded row
        // (0059 compares final_checkpoint_seq/hash against it), so it waits for this ack.
        if ack.is_recorded() {
            let entry = self
                .recorded_checkpoint
                .entry(ack.run_id.clone())
                .or_insert(0);
            *entry = (*entry).max(ack.checkpoint_seq);
        }
        match watermark::apply_receipt_watermark(
            self.journal.connection(),
            server_jwk,
            self.journal.journal_epoch(),
            &ack,
        ) {
            Ok(watermark) => eprintln!("work-device: checkpoint_ack watermark {watermark}"),
            Err(err) => eprintln!("work-device: checkpoint_ack refused: {err:?}"),
        }
        self.attempt_finish();
    }

    fn consume_finish_ack(&mut self, server_jwk: &crate::jwk::EcP256Jwk, body: Value) {
        let ack: finish::RunFinishAckBody = match serde_json::from_value(body) {
            Ok(body) => body,
            Err(err) => {
                eprintln!("work-device: finish_ack schema refused: {err}");
                return;
            }
        };
        // The ack names only finish_id; map it to its Run across any ack_state (a re-delivered verdict
        // for an already-recorded proposal still resolves). apply_finish_ack verifies the server
        // signature AND verdict consistency fail-closed before any row moves (GW8 precedent).
        let run_id = match recover::run_id_for_finish(self.journal.connection(), &ack.finish_id) {
            Ok(Some(run_id)) => run_id,
            Ok(None) => {
                eprintln!(
                    "work-device: finish_ack for an unknown finish_id {}",
                    ack.finish_id
                );
                return;
            }
            Err(err) => {
                eprintln!("work-device: finish_ack lookup failed: {err:?}");
                return;
            }
        };
        let outcome = match crate::finish::ack::apply_finish_ack(
            self.journal.connection(),
            server_jwk,
            &run_id,
            &ack,
        ) {
            Ok(outcome) => outcome,
            Err(err) => {
                eprintln!("work-device: finish_ack refused: {err:?}");
                return;
            }
        };
        match outcome {
            crate::finish::ack::FinishAckOutcome::Accepted {
                terminal_run_revision,
            } => {
                eprintln!(
                    "work-device: run_finish accepted, terminal_run_revision={terminal_run_revision}"
                );
                self.awaiting_finish_ack = None;
                self.finish_pending = None;
                self.finish_stopped.insert(run_id.clone());
                // §3.4 step 4: accepted records the terminal revision, releases the lease, then the
                // cleanup watermark (B03 §3.2) — never journal_release/run_sealed (card E=B).
                if self.sidecar.as_ref().is_some_and(|s| s.run_id() == run_id) {
                    self.retire_run_lease();
                }
                if self.active_run.as_ref().is_some_and(|r| r.run_id == run_id) {
                    self.active_run = None;
                }
                let all_resolved =
                    recover::unreconciled_unknown_count(self.journal.connection(), &run_id)
                        .unwrap_or(1)
                        == 0;
                let gate = watermark::TombstoneGate {
                    finish_accepted: true,
                    final_operation_set_hash_verified: true,
                    receipt_through_seq_continuous: true,
                    all_resolutions_received: all_resolved,
                };
                match watermark::cleanup_tombstones(self.journal.connection(), &run_id, &gate) {
                    Ok(n) if n > 0 => eprintln!("work-device: cleaned {n} action tombstones"),
                    _ => {}
                }
            }
            crate::finish::ack::FinishAckOutcome::Rejected { code } => {
                eprintln!("work-device: run_finish rejected: {code}");
                self.awaiting_finish_ack = None;
                // §3.4 step 4: a refusal never rewrites local facts. Repair means a NEW finish_id over
                // the CURRENT facts; stale_fence stops proposing at all.
                match code.as_str() {
                    "stale_fence" => {
                        self.finish_pending = None;
                        self.finish_stopped.insert(run_id);
                    }
                    "run_cancel_requested" => {
                        // The Run is cancel_requested; the cancel downlink drives cancel_ack. Stop
                        // proposing a completed finish.
                        self.finish_pending = None;
                    }
                    "finish_state_mismatch" | "finish_precondition_failed" => {
                        // Re-reconcile (re-upload un-acked receipts / await resolutions), then re-judge
                        // over the current facts with a NEW finish_id — never blind-retry the same one.
                        self.reconcile_uplink();
                        if !self.finish_stopped.contains(&run_id) {
                            if let Some(active) =
                                self.active_run.clone().filter(|r| r.run_id == run_id)
                            {
                                self.finish_pending = Some(FinishPending {
                                    run_id: active.run_id,
                                    binding_revision: active.binding_revision,
                                    fence: active.fence,
                                    lease_id: active.lease_id,
                                    loop_ended_normally: true,
                                });
                            }
                        }
                        self.attempt_finish();
                    }
                    _ => {}
                }
            }
            crate::finish::ack::FinishAckOutcome::UnknownFinish => {
                eprintln!(
                    "work-device: finish_ack unknown finish_id {}",
                    ack.finish_id
                );
            }
        }
    }

    fn consume_receipt_ack(
        &mut self,
        server_jwk: &crate::jwk::EcP256Jwk,
        frame_type: &str,
        body: Value,
    ) {
        let ack: receipt_ack::ReceiptAckBody = match serde_json::from_value(body) {
            Ok(body) => body,
            Err(err) => {
                eprintln!("work-device: receipt_ack schema refused: {err}");
                return;
            }
        };
        match replay::apply_receipt_ack(
            self.journal.connection(),
            server_jwk,
            self.journal.journal_epoch(),
            frame_type,
            &ack,
        ) {
            Ok(outcome) => {
                if outcome.acked > 0 {
                    self.last_receipt_seq = self
                        .last_receipt_seq
                        .max(current_receipt_seq(&self.journal, &self.device_id));
                    // The heartbeat must report the live watermark, not the static hello baseline,
                    // or renew_device_lease refuses the regression after a recorded receipt (0051).
                    let _ = self
                        .link_commands
                        .blocking_send(LinkCommand::ReceiptWatermark(self.last_receipt_seq));
                }
                eprintln!(
                    "work-device: {frame_type} acked {} conflicts {}",
                    outcome.acked,
                    outcome.conflicts.len()
                );
            }
            Err(err) => eprintln!("work-device: {frame_type} refused: {err:?}"),
        }
    }

    /// GW13 action_prepared: verify the frame. The tool permit gate / dispatch is batch 2; batch 1c
    /// registers nothing here (the command carries the executable permit), only fail-closed verify.
    fn consume_action_prepared(&mut self, server_jwk: &crate::jwk::EcP256Jwk, body: Value) {
        let prepared: action::ActionPreparedBody = match serde_json::from_value(body) {
            Ok(body) => body,
            Err(err) => {
                eprintln!("work-device: action_prepared schema refused: {err}");
                return;
            }
        };
        if !prepared.verify(server_jwk) {
            eprintln!("work-device: action_prepared signature refused");
            return;
        }
        eprintln!(
            "work-device: action_prepared {} verified (tool gate batch 2)",
            prepared.operation_id
        );
    }

    fn uplink(&self, frame_type: &str, body: Value) {
        let frame = UplinkFrame {
            frame_type: frame_type.to_string(),
            body,
        };
        if self.uplinks.blocking_send(frame).is_err() {
            eprintln!("work-device: uplink channel closed ({frame_type})");
        }
    }

    /// Independent monotonic expiry, called on idle ticks and before consuming work/renewals.
    /// Clearing the deadline is a latched loss, not a chance for a late renewal to acquire it.
    fn expire_lease(&mut self, now: Instant) -> bool {
        if self.lease_deadline.is_some_and(|deadline| now >= deadline) {
            self.lose_execution_authority();
            eprintln!("work-device: Run lease expired, sidecar killed");
            return true;
        }
        false
    }

    fn clear_run_authority(&mut self) -> Option<String> {
        self.lease_deadline = None;
        self.lease_mode = LeaseMode::Invalid;
        self.offer = None;
        self.ready_sent_at = None;
        self.kill_sidecar();
        self.lease_id.take()
    }

    fn lose_execution_authority(&mut self) {
        self.session_accepts_work = false;
        // Do not ReleaseLease here: the link still owes an invalidation event for its held ids.
        let _ = self.clear_run_authority();
    }

    /// A canceled/finished Run is intentionally released, unlike an unreported expiry.
    fn retire_run_lease(&mut self) {
        if let Some(lease_id) = self.clear_run_authority() {
            let _ = self
                .link_commands
                .blocking_send(LinkCommand::ReleaseLease { lease_id });
        }
    }

    /// Stop the sidecar: dropping the owned process closes the Job Object (kill-on-close terminates
    /// the whole tree) and the lifecycle advances to Exited. Idempotent — a second kill is a no-op.
    /// This does NOT cancel already-started Broker I/O on the separate Node-service thread.
    fn kill_sidecar(&mut self) {
        #[cfg(windows)]
        {
            if let Some(deadline) = self.io_deadline.take() {
                *deadline.lock().unwrap() = None;
            }
            self.process = None;
            self.dispatched.clear();
            if let Some((_, commands)) = self.active_commands.take() {
                commands.lock().unwrap().clear();
            }
        }
        if let Some(sidecar) = self.sidecar.as_mut() {
            let _ = sidecar.mark_exited();
        }
        // A killed Run (cancel/lease loss/expiry) is finished by the server's cancel/timeout path, not
        // a device proposal: drop the live loop-end signal and pending judgment. A durable un-acked
        // finish proposal still replays on the next session (reconcile_uplink).
        self.run_end_rx = None;
        self.finish_pending = None;
        self.awaiting_finish_ack = None;
    }

    fn remaining_lease_secs(&self) -> u64 {
        if self.lease_mode != LeaseMode::Active {
            return 0;
        }
        self.lease_deadline
            .map(|d| d.saturating_duration_since(Instant::now()).as_secs())
            .unwrap_or(0)
    }

    fn latest_checkpoint_ref(&self, run_id: &str) -> (String, String) {
        match recover::latest_checkpoint(self.journal.connection(), run_id) {
            Ok(Some(cp)) => (cp.checkpoint_seq.to_string(), cp.checkpoint_hash),
            _ => ("0".to_string(), String::new()),
        }
    }

    /// The Node loop ended (the serve_run reply resolved): the finish candidate signal (§3.4 step 1).
    /// A canceled/killed/expired Run is finished by the server's cancel/timeout path, not a device
    /// proposal; only a Run that still holds active authority judges a finish from its journal facts.
    fn on_run_ended(&mut self, result: Result<(), String>) {
        self.run_end_rx = None;
        if !self.session_accepts_work || self.lease_mode != LeaseMode::Active {
            return;
        }
        let Some(active) = self.active_run.clone() else {
            return;
        };
        let loop_ended_normally = result.is_ok();
        if let Err(err) = &result {
            eprintln!("work-device: Node loop ended abnormally: {err}");
        }
        self.finish_pending = Some(FinishPending {
            run_id: active.run_id,
            binding_revision: active.binding_revision,
            fence: active.fence,
            lease_id: active.lease_id,
            loop_ended_normally,
        });
        self.attempt_finish();
    }

    /// Judge and propose a finish if the Run is ready (§3.4 steps 2-3). Re-evaluated as resolutions,
    /// checkpoint acks and receipt acks arrive: it waits while operations are non-terminal/unreceipted
    /// or the final checkpoint is not yet recorded, replays a durable un-acked proposal verbatim, and
    /// otherwise produces a NEW signed proposal. Never re-judges a stopped/terminal Run.
    fn attempt_finish(&mut self) {
        let Some(pending) = self.finish_pending.clone() else {
            return;
        };
        if self.finish_stopped.contains(&pending.run_id) || self.awaiting_finish_ack.is_some() {
            return;
        }
        if recover::is_run_terminal(self.journal.connection(), &pending.run_id).unwrap_or(false) {
            self.finish_pending = None;
            return;
        }
        // A durable un-acked proposal exists (e.g. after restart) → replay it verbatim, never re-judge.
        let existing = replay::pending_finishes(self.journal.connection())
            .unwrap_or_default()
            .into_iter()
            .find(|r| r.run_id == pending.run_id);
        if let Some(row) = existing {
            let frame = orchestrate::replay_frame(&row);
            eprintln!("work-device: replay run_finish {}", row.finish_id);
            self.awaiting_finish_ack = Some(row.finish_id);
            self.uplink(&frame.frame_type, frame.body);
            return;
        }
        // The finish references the latest checkpoint the server has RECORDED (0059 gate).
        let latest =
            recover::latest_checkpoint(self.journal.connection(), &pending.run_id).unwrap_or(None);
        let Some(cp) = latest else {
            return;
        };
        let recorded = self
            .recorded_checkpoint
            .get(&pending.run_id)
            .copied()
            .unwrap_or(0);
        if recorded < cp.checkpoint_seq as u64 {
            return;
        }
        // Batch 4 publication gate: a `completed` finish needs published `artifact_version` rows
        // (0059 precondition). Publish each sealed deliverable via local_publish after its receipt
        // is durable, before judging completed; finalize is idempotent (same artifact+hash+run
        // replays, 0043:543) so a restart re-publish is safe. Only gate a Run that would be
        // completed (loop ended normally, deliverables, no undelivered dispatch which forces
        // failed); a failed finish names no deliverables and needs no publication.
        let has_pending_dispatch = self
            .undelivered
            .get(&pending.run_id)
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        if pending.loop_ended_normally && !has_pending_dispatch {
            let deliverables = self
                .deliverables
                .get(&pending.run_id)
                .cloned()
                .unwrap_or_default();
            let epoch = self.journal.journal_epoch().to_string();
            let receipted = crate::finish::facts::all_operations_terminal(
                self.journal.connection(),
                &self.org_id,
                &pending.run_id,
            )
            .unwrap_or(false)
                && crate::finish::facts::operations_receipted(
                    self.journal.connection(),
                    &self.org_id,
                    &pending.run_id,
                    &epoch,
                )
                .unwrap_or(false);
            if !deliverables.is_empty() && receipted {
                let published = self
                    .published
                    .get(&pending.run_id)
                    .cloned()
                    .unwrap_or_default();
                if !deliverables.iter().all(|v| published.contains(v)) {
                    let unpublished: Vec<String> = deliverables
                        .iter()
                        .filter(|v| !published.contains(*v) && !self.publish_pending.contains(*v))
                        .cloned()
                        .collect();
                    for v in unpublished {
                        self.send_local_publish(&pending.run_id, &v);
                    }
                    return; // wait for the verified publish_ack before judging completed
                }
            }
        }
        let input = FinishInput {
            run_id: pending.run_id.clone(),
            org_id: self.org_id.clone(),
            journal_epoch: self.journal.journal_epoch().to_string(),
            binding_revision: pending.binding_revision,
            fence: pending.fence,
            lease_id: pending.lease_id.clone(),
            loop_ended_normally: pending.loop_ended_normally,
            deliverables: self
                .deliverables
                .get(&pending.run_id)
                .cloned()
                .unwrap_or_default(),
            has_pending_model_dispatch: self
                .undelivered
                .get(&pending.run_id)
                .map(|s| !s.is_empty())
                .unwrap_or(false),
            model_error: false,
            tool_limit_hit: false,
            runtime_limit_exceeded: false,
            runtime_unresumable: false,
            checkpoint_lost: false,
            input_missing: false,
            final_checkpoint_seq: cp.checkpoint_seq as u64,
            final_checkpoint_hash: cp.checkpoint_hash.clone(),
            receipt_through_seq: current_receipt_seq(&self.journal, &self.device_id),
        };
        match orchestrate::judge_and_propose(self.journal.connection(), self.key.as_ref(), &input) {
            Ok(orchestrate::FinishAttempt::Proposed(proposal)) => {
                eprintln!(
                    "work-device: run_finish proposed {} ({:?})",
                    proposal.finish_id, proposal.outcome
                );
                self.awaiting_finish_ack = Some(proposal.finish_id);
                self.uplink(&proposal.frame.frame_type, proposal.frame.body);
            }
            Ok(orchestrate::FinishAttempt::Wait) => {}
            Err(err) => eprintln!("work-device: finish production failed: {err:?}"),
        }
    }

    /// Batch 4: uplink a signed `local_publish` for one sealed deliverable version, asking the
    /// control plane to finalize it into a published local_only artifact_version (0043). The payload
    /// is built from the Broker's own execution facts (RecordDeliverable) + the completed receipt's
    /// seq (AppendReceipt) + the identity facts the sync core owns. logical_name derives from the
    /// args' artifact_id (lead ruling 甲); artifact_id is null (merge by logical_name). Fire-and-
    /// forget: the verified publish_ack marks the version published; finalize idempotency makes a
    /// re-send (restart) replay rather than conflict.
    fn send_local_publish(&mut self, run_id: &str, version_id: &str) {
        let Some(facts) = self.deliverable_facts.get(version_id).cloned() else {
            return;
        };
        let Some(seq) = self.receipt_seq_by_op.get(&facts.operation_id).copied() else {
            return; // the completed receipt's seq is not yet known
        };
        let epoch = self.journal.journal_epoch().to_string();
        let mut body = publish::LocalPublishBody {
            run_id: run_id.to_string(),
            operation_id: facts.operation_id.clone(),
            version_id: version_id.to_string(),
            artifact_id: None,
            logical_name: facts.logical_name.clone(),
            format: facts.format.clone(),
            content_hash: facts.content_hash.clone(),
            byte_count: facts.byte_count,
            local_ref: format!("{}:{}", run_id, facts.operation_id),
            device_id: self.device_id.clone(),
            classification_claimed: "local_only".to_string(),
            receipt_ref: format!("{}:{}", epoch, seq),
            signature: None,
        };
        if !body.payload_consistent() {
            eprintln!("work-device: local_publish payload inconsistent for {version_id}");
            return;
        }
        if let Err(err) = body.sign(self.key.as_ref()) {
            eprintln!("work-device: local_publish sign failed: {err:?}");
            return;
        }
        self.publish_pending.insert(version_id.to_string());
        eprintln!("work-device: local_publish {version_id} (run {run_id})");
        self.uplink(publish::PUBLISH_FRAME_TYPE, body.to_value());
    }

    /// Batch 4: consume a server-signed `publish_ack`. Fail-closed verify (GW8 precedent); only a
    /// verified local_only publication marks the version published, which lets the completed finish
    /// proceed (0059 needs the published row). An unsigned/unverifiable ack never moves the set.
    fn consume_publish_ack(&mut self, server_jwk: &crate::jwk::EcP256Jwk, body: Value) {
        let ack: publish::PublishAckBody = match serde_json::from_value(body) {
            Ok(a) => a,
            Err(err) => {
                eprintln!("work-device: publish_ack shape refused: {err}");
                return;
            }
        };
        if !ack.verify(server_jwk) {
            eprintln!("work-device: publish_ack signature refused");
            return;
        }
        if !ack.is_published_local() {
            eprintln!("work-device: publish_ack is not a local_only publication");
            return;
        }
        self.publish_pending.remove(&ack.version_id);
        self.published
            .entry(ack.run_id.clone())
            .or_default()
            .insert(ack.version_id.clone());
        eprintln!(
            "work-device: publish_ack accepted {} (run {})",
            ack.version_id, ack.run_id
        );
        self.attempt_finish();
    }

    /// §6.3 reconcile (ruling 甲 fresh-session/resume driven): re-upload un-acked receipts with their
    /// original signed bytes nested verbatim, and replay un-acked finish proposals (same finish_id,
    /// same bytes). The reconcile_ack/receipt_ack consumption (wired) advances the watermark; durable
    /// cleanup stays gated on the server-signed facts, never local inference.
    fn reconcile_uplink(&mut self) {
        let epoch = self.journal.journal_epoch().to_string();
        let batch =
            replay::next_receipt_batch(self.journal.connection(), &epoch).unwrap_or_default();
        if !batch.is_empty() {
            let from_seq = batch[0].receipt_seq as u64;
            let run_id = recover::run_id_for_operation(
                self.journal.connection(),
                &self.org_id,
                &batch[0].operation_id,
            )
            .ok()
            .flatten()
            .or_else(|| self.active_run.as_ref().map(|r| r.run_id.clone()))
            .unwrap_or_default();
            let body = replay::reconcile_batch(&run_id, &epoch, from_seq, &batch);
            eprintln!(
                "work-device: reconcile re-upload {} receipts from seq {from_seq}",
                batch.len()
            );
            self.uplink(reconcile::FRAME_TYPE, body.to_value());
        }
        let pending = replay::pending_finishes(self.journal.connection()).unwrap_or_default();
        for row in pending {
            let frame = orchestrate::replay_frame(&row);
            eprintln!("work-device: replay run_finish {}", row.finish_id);
            self.awaiting_finish_ack = Some(row.finish_id);
            self.uplink(&frame.frame_type, frame.body);
        }
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The highest receipt seq the device has produced (next_receipt_seq - 1), recovered from the
/// journal so a restart does not reset the cancel_ack / watermark high-water mark.
fn current_receipt_seq(journal: &Journal, device_id: &str) -> u64 {
    let next: i64 = journal
        .connection()
        .query_row(
            "SELECT next_receipt_seq FROM device_meta WHERE device_id = ?1",
            rusqlite::params![device_id],
            |row| row.get(0),
        )
        .unwrap_or(1);
    next.saturating_sub(1).max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::sign;
    use crate::key::SoftwareKey;
    use crate::transport::ClientIdentity;
    use std::time::Duration;

    const DEVICE: &str = "abcdefab-abcd-abcd-abcd-abcdefabcdef";

    fn ready() -> ReadyIdentity {
        ReadyIdentity {
            device_id: DEVICE.to_string(),
            org_id: "org".to_string(),
            subject_id: "sub".to_string(),
            identity: ClientIdentity::Pkcs12 {
                der: vec![1, 2, 3],
                password: "p".to_string(),
            },
        }
    }

    fn hello(server: &SoftwareKey, permit: &SoftwareKey) -> crate::transport::HelloAck {
        crate::transport::HelloAck {
            session_id: "sess".to_string(),
            server_time: "2026-11-19T00:00:00Z".to_string(),
            generation: 1,
            lease_ttl: Duration::from_secs(30),
            heartbeat_interval: Duration::from_secs(10),
            resync_required: true,
            server_jwk: server.public_jwk(),
            permit_jwk: permit.public_jwk(),
        }
    }

    fn temp_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("work-synccore-{}", uuid::Uuid::new_v4()))
    }

    fn spawn_template() -> SpawnConfig {
        SpawnConfig {
            node_path: "node".into(),
            bundle_path: "bundle.js".into(),
            manifest_hash: "h".into(),
            runtime_digest: "d".into(),
            staging_dir: temp_dir().to_string_lossy().into_owned(),
        }
    }

    fn instance_facts() -> crate::journalop::InstanceFacts {
        crate::journalop::InstanceFacts {
            agent_instance_id: "agent".into(),
            boot_id: "boot".into(),
        }
    }

    fn signed_cancel(
        server: &SoftwareKey,
        run_id: &str,
        revision: u64,
    ) -> crate::frame::envelope::Envelope {
        let mut body = cancel::CancelBody {
            run_id: run_id.to_string(),
            cancel_revision: revision,
            signature: None,
        };
        body.signature =
            Some(sign::sign_frame(server, cancel::CANCEL_FRAME_TYPE, &body.to_value()).unwrap());
        crate::frame::envelope::Envelope::new(cancel::CANCEL_FRAME_TYPE, DEVICE, body.to_value())
    }

    #[test]
    fn a_verified_cancel_uplinks_a_signed_stop_fact() {
        let device = SoftwareKey::random();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let dir = temp_dir();
        let (uplink_tx, mut uplink_rx) = mpsc::channel::<UplinkFrame>(8);
        let __spawn = spawn_sync_core(
            dir.to_str().unwrap().to_string(),
            ready(),
            Arc::new(device),
            uplink_tx,
            mpsc::channel::<LinkCommand>(4).0,
            spawn_template(),
            instance_facts(),
            #[cfg(windows)]
            crate::nodeservice::spawn_node_service(),
        )
        .unwrap();
        let event_tx = __spawn.events;
        let epoch = __spawn.epoch;
        assert!(
            !epoch.is_empty(),
            "the core must publish the journal epoch for hello"
        );

        event_tx
            .blocking_send(LinkEvent::SessionEstablished(Box::new(hello(
                &server, &permit,
            ))))
            .unwrap();
        event_tx
            .blocking_send(LinkEvent::Downlink(Box::new(signed_cancel(
                &server, "run", 3,
            ))))
            .unwrap();

        let frame = uplink_rx.blocking_recv().expect("a cancel_ack uplink");
        assert_eq!(frame.frame_type, cancel::CANCEL_ACK_FRAME_TYPE);
        assert_eq!(frame.body["run_id"], "run");
        assert_eq!(frame.body["cancel_revision"], "3");
        // No sidecar was spawned, so the local stop fact is Confirmed -> "stopped".
        assert_eq!(frame.body["stopped_or_unknown"], "stopped");
        assert!(
            frame.body["signature"].is_string(),
            "the device must sign the cancel_ack"
        );

        drop(event_tx);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_downlink_before_any_session_is_dropped_fail_closed() {
        let device = SoftwareKey::random();
        let server = SoftwareKey::random();
        let dir = temp_dir();
        let (uplink_tx, mut uplink_rx) = mpsc::channel::<UplinkFrame>(8);
        let __spawn = spawn_sync_core(
            dir.to_str().unwrap().to_string(),
            ready(),
            Arc::new(device),
            uplink_tx,
            mpsc::channel::<LinkCommand>(4).0,
            spawn_template(),
            instance_facts(),
            #[cfg(windows)]
            crate::nodeservice::spawn_node_service(),
        )
        .unwrap();
        let event_tx = __spawn.events;
        let _epoch = __spawn.epoch;
        // No SessionEstablished: the cancel cannot be verified, so nothing is uplinked.
        event_tx
            .blocking_send(LinkEvent::Downlink(Box::new(signed_cancel(
                &server, "run", 1,
            ))))
            .unwrap();
        // A subsequent session + cancel proves the thread is still alive (the drop did not kill it).
        let permit = SoftwareKey::random();
        event_tx
            .blocking_send(LinkEvent::SessionEstablished(Box::new(hello(
                &server, &permit,
            ))))
            .unwrap();
        event_tx
            .blocking_send(LinkEvent::Downlink(Box::new(signed_cancel(
                &server, "run", 2,
            ))))
            .unwrap();
        let frame = uplink_rx
            .blocking_recv()
            .expect("the post-session cancel_ack");
        assert_eq!(frame.body["cancel_revision"], "2");
        drop(event_tx);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Build a core already provisioned with a session and a started Run fence, WITHOUT spawning a
    /// sidecar. The command-registration path (DD:123) is independent of the process lifecycle: it
    /// needs only the session authority + run_fence the permit gate checks. This isolates the A2
    /// journal取证 from the batch 1d CreateProcess (which needs a real node fixture).
    fn provisioned_core(
        dir: &std::path::Path,
        device: SoftwareKey,
        server: &SoftwareKey,
        permit: &SoftwareKey,
    ) -> SyncCore {
        let db_path = dir.join(format!("{DEVICE}.db"));
        let journal = Journal::create(&db_path, DEVICE, &dek::TestWrap).unwrap();
        let (uplink_tx, _uplink_rx) = mpsc::channel::<UplinkFrame>(8);
        let (link_cmd_tx, _link_cmd_rx) = mpsc::channel::<LinkCommand>(4);
        let (journal_handle, _journal_op_rx) = crate::journalop::channel();
        #[cfg(windows)]
        let (node_service_tx, _node_service_rx) = tokio::sync::mpsc::channel(8);
        let mut core = SyncCore::new(
            journal,
            ready(),
            Arc::new(device),
            uplink_tx,
            link_cmd_tx,
            spawn_template(),
            journal_handle,
            instance_facts(),
            #[cfg(windows)]
            node_service_tx,
        );
        core.server_jwk = Some(server.public_jwk());
        core.permit_jwk = Some(permit.public_jwk());
        core.session_id = Some("sess".to_string());
        core.generation = 1;
        core.lease_deadline = Some(Instant::now() + Duration::from_secs(30));
        core.lease_id = Some("lease-1".into());
        core.lease_mode = LeaseMode::Active;
        core.session_accepts_work = true;
        core.run_fence = 2;
        core
    }

    fn with_running_core(test: impl FnOnce(&mut SyncCore, &SoftwareKey, &SoftwareKey)) {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let mut core = provisioned_core(&dir, SoftwareKey::random(), &server, &permit);
        let mut sidecar = Sidecar::new("run", 1, "nonce-1", "digest");
        sidecar.mark_running().unwrap();
        core.sidecar = Some(sidecar);
        test(&mut core, &server, &permit);
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn renewal_event(deadline: Instant) -> crate::transport::LeaseState {
        crate::transport::LeaseState {
            lease_id: "lease-1".into(),
            extended: true,
            fence: 2,
            mode: LeaseMode::Active,
            deadline,
        }
    }

    fn signed_offer_start(server: &SoftwareKey) -> (offer::RunOfferBody, offer::RunStartBody) {
        let mut offer = offer::RunOfferBody {
            run_id: "run".into(),
            binding_revision: 1,
            binding_hash: "binding".into(),
            task_id: "task".into(),
            input_ref: "input".into(),
            input_hash: "input-hash".into(),
            snapshot_descriptor_ref: None,
            snapshot_hash: "snapshot".into(),
            profile_id: "profile".into(),
            profile_revision: 1,
            runtime_digest: "digest".into(),
            tool_manifest_hash: "manifest".into(),
            model_version: "model".into(),
            grant_set: Vec::new(),
            expected_checkpoint_seq: None,
            expected_checkpoint_hash: None,
            original_target: offer::OriginalTarget {
                device_id: DEVICE.into(),
                session_id: "sess".into(),
            },
            offer_expiry: "2026-11-19T00:00:30Z".into(),
            signature: None,
        };
        offer.signature =
            Some(sign::sign_frame(server, offer::OFFER_FRAME_TYPE, &offer.to_value()).unwrap());
        let mut start = offer::RunStartBody {
            run_binding_id: 1,
            run_id: "run".into(),
            payload_hash: "payload".into(),
            session_id: "sess".into(),
            fence: 2,
            generation: 1,
            lease_id: "lease-2".into(),
            runtime_digest: "digest".into(),
            start_nonce: "nonce-2".into(),
            expiry: "2026-11-19T00:00:30Z".into(),
            signature: None,
        };
        start.signature =
            Some(sign::sign_frame(server, offer::START_FRAME_TYPE, &start.to_value()).unwrap());
        (offer, start)
    }

    #[test]
    fn repeated_start_does_not_replace_a_running_sidecar_or_lease() {
        with_running_core(|core, server, _| {
            let (offer, start) = signed_offer_start(server);
            core.offer = Some(offer.clone());
            core.ready_sent_at = Some(Instant::now());
            recover::persist_start(
                core.journal.connection(),
                &StartRow {
                    run_id: start.run_id.clone(),
                    binding_revision: start.run_binding_id as i64,
                    binding_hash: offer.binding_hash,
                    start_nonce: start.start_nonce.clone(),
                    state: "started".into(),
                    expected_checkpoint_ref: None,
                    expected_checkpoint_hash: None,
                },
            )
            .unwrap();
            let deadline = core.lease_deadline;
            let lease_id = core.lease_id.clone();
            let nonce = core.sidecar.as_ref().unwrap().start_nonce().to_string();
            core.consume_start(&server.public_jwk(), start.to_value());
            assert_eq!(core.lease_deadline, deadline);
            assert_eq!(core.lease_id, lease_id);
            assert_eq!(core.sidecar.as_ref().unwrap().start_nonce(), nonce);
            assert_eq!(
                core.sidecar.as_ref().unwrap().state(),
                SidecarState::Running
            );
        });
    }

    #[cfg(windows)]
    #[test]
    fn renewal_updates_broker_io_deadline_and_stop_revokes_it() {
        with_running_core(|core, _, _| {
            let shared = Arc::new(std::sync::Mutex::new(core.lease_deadline));
            core.io_deadline = Some(shared.clone());
            let renewed = core.lease_deadline.unwrap() + Duration::from_secs(10);
            core.handle(LinkEvent::LeaseRenewal(renewal_event(renewed)));
            assert_eq!(*shared.lock().unwrap(), Some(renewed));
            core.expire_lease(renewed);
            assert_eq!(*shared.lock().unwrap(), None);
        });
    }

    #[test]
    fn natural_expiry_without_link_events_kills_the_sidecar() {
        with_running_core(|core, _, _| {
            let deadline = core.lease_deadline.unwrap();
            assert!(!core.expire_lease(deadline - Duration::from_nanos(1)));
            assert_eq!(
                core.sidecar.as_ref().unwrap().state(),
                SidecarState::Running
            );
            assert!(core.expire_lease(deadline));
            assert_eq!(core.sidecar.as_ref().unwrap().state(), SidecarState::Exited);
            assert_eq!(core.remaining_lease_secs(), 0);
            assert!(!core.session_accepts_work);
            assert!(!core.expire_lease(deadline), "expiry is idempotent");
        });
    }

    #[test]
    fn timely_renewal_keeps_the_sidecar_running_past_the_old_deadline() {
        with_running_core(|core, _, _| {
            let old_deadline = core.lease_deadline.unwrap();
            let new_deadline = old_deadline + Duration::from_secs(20);
            core.handle(LinkEvent::LeaseRenewal(renewal_event(new_deadline)));
            assert!(!core.expire_lease(old_deadline));
            assert_eq!(
                core.sidecar.as_ref().unwrap().state(),
                SidecarState::Running
            );
            assert_eq!(core.lease_deadline, Some(new_deadline));
            assert!(core.expire_lease(new_deadline));
        });
    }

    #[test]
    fn late_renewal_hello_command_and_start_cannot_restore_expired_authority() {
        with_running_core(|core, server, permit| {
            // Let handle's own entry check observe expiry, not a supplied invalidation event.
            core.lease_deadline = Some(Instant::now());
            core.handle(LinkEvent::LeaseRenewal(renewal_event(
                Instant::now() + Duration::from_secs(60),
            )));
            core.handle(LinkEvent::SessionEstablished(Box::new(hello(
                server, permit,
            ))));
            assert!(core.lease_deadline.is_none());
            assert_eq!(core.sidecar.as_ref().unwrap().state(), SidecarState::Exited);
            let cmd = signed_command(server, permit, "late-jti", "late-op");
            core.consume_command(&server.public_jwk(), cmd.to_value());
            let (offer, start) = signed_offer_start(server);
            core.consume_offer(&server.public_jwk(), offer.to_value());
            core.consume_start(&server.public_jwk(), start.to_value());
            for table in ["action_journal", "runtime_start"] {
                let count: i64 = core
                    .journal
                    .connection()
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                    .unwrap();
                assert_eq!(count, 0, "expired authority reached {table}");
            }
        });
    }

    #[test]
    fn hello_provisions_cadence_but_only_start_acquires_a_run_lease() {
        with_running_core(|core, server, permit| {
            core.lose_execution_authority();
            core.session_id = None;
            core.handle(LinkEvent::SessionEstablished(Box::new(hello(
                server, permit,
            ))));
            assert!(core.lease_deadline.is_none());
            assert_eq!(core.remaining_lease_secs(), 0);
            core.handle(LinkEvent::LeaseRenewal(renewal_event(
                Instant::now() + Duration::from_secs(60),
            )));
            assert!(
                core.lease_deadline.is_none(),
                "unheld renewal is not acquisition"
            );
            let (offer, start) = signed_offer_start(server);
            core.consume_offer(&server.public_jwk(), offer.to_value());
            let sent = Instant::now() - Duration::from_secs(2);
            core.ready_sent_at = Some(sent);
            core.consume_start(&server.public_jwk(), start.to_value());
            // Windows may refuse the intentionally absent bundle, but the verified/persisted
            // acquisition must use ready's send instant, never hello time or spawn completion.
            assert_eq!(core.lease_id.as_deref(), Some("lease-2"));
            assert!(core.lease_deadline.unwrap() <= sent + Duration::from_secs(28));
        });
    }

    #[test]
    fn refused_or_unrelated_renewal_does_not_revoke_a_live_lease() {
        with_running_core(|core, _, _| {
            let deadline = core.lease_deadline.unwrap();
            let mut state = renewal_event(deadline + Duration::from_secs(60));
            state.extended = false;
            core.handle(LinkEvent::LeaseRenewal(state));
            let mut state = renewal_event(deadline + Duration::from_secs(60));
            state.lease_id = "other-lease".into();
            core.handle(LinkEvent::LeaseRenewal(state));
            let mut state = renewal_event(deadline + Duration::from_secs(60));
            state.fence = 3;
            core.handle(LinkEvent::LeaseRenewal(state));
            assert_eq!(core.lease_deadline, Some(deadline));
            assert_eq!(
                core.sidecar.as_ref().unwrap().state(),
                SidecarState::Running
            );
        });
    }

    #[test]
    fn history_return_stops_execution_without_closing_history_consumption() {
        with_running_core(|core, server, permit| {
            let mut state = renewal_event(core.lease_deadline.unwrap());
            state.mode = LeaseMode::HistoryReturn;
            state.extended = false;
            core.handle(LinkEvent::LeaseRenewal(state));
            assert_eq!(core.lease_mode, LeaseMode::HistoryReturn);
            assert!(core.lease_deadline.is_some());
            assert_eq!(core.remaining_lease_secs(), 0);
            assert_eq!(core.sidecar.as_ref().unwrap().state(), SidecarState::Exited);
            core.handle(LinkEvent::LeaseRenewal(renewal_event(
                Instant::now() + Duration::from_secs(60),
            )));
            assert_eq!(core.lease_mode, LeaseMode::HistoryReturn);
            let cmd = signed_command(server, permit, "history-jti", "history-op");
            core.consume_command(&server.public_jwk(), cmd.to_value());
            let count: i64 = core
                .journal
                .connection()
                .query_row("SELECT COUNT(*) FROM action_journal", [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0);
            // Signed control/history routes remain reachable; there is no blanket router shutdown.
            let (tx, mut rx) = mpsc::channel(1);
            core.uplinks = tx;
            core.handle(LinkEvent::Downlink(Box::new(signed_cancel(
                server, "run", 9,
            ))));
            assert_eq!(
                rx.try_recv().unwrap().frame_type,
                cancel::CANCEL_ACK_FRAME_TYPE
            );
        });
    }

    #[test]
    fn invalid_or_already_exhausted_renewal_kills_the_sidecar() {
        for invalid in [false, true] {
            with_running_core(|core, _, _| {
                let mut state = renewal_event(Instant::now());
                if invalid {
                    state.mode = LeaseMode::Invalid;
                    state.extended = false;
                    state.deadline = Instant::now() + Duration::from_secs(60);
                }
                core.handle(LinkEvent::LeaseRenewal(state));
                assert_eq!(core.sidecar.as_ref().unwrap().state(), SidecarState::Exited);
                assert!(core.lease_deadline.is_none());
            });
        }
    }

    #[test]
    fn only_an_accepted_finish_releases_the_current_run_lease() {
        for accepted in [false, true] {
            with_running_core(|core, server, _| {
                recover::persist_finish(
                    core.journal.connection(),
                    &recover::FinishRow {
                        run_id: "run".into(),
                        finish_id: "finish-1".into(),
                        outcome: "failed".into(),
                        reason: Some("no_deliverable".into()),
                        final_checkpoint_seq: None,
                        final_checkpoint_hash: None,
                        signed_bytes: vec![1],
                        signed_hash: "hash".into(),
                        ack_state: None,
                        terminal_run_revision: None,
                    },
                )
                .unwrap();
                let mut ack = finish::RunFinishAckBody {
                    finish_id: "finish-1".into(),
                    state: if accepted { "accepted" } else { "rejected" }.into(),
                    code: if accepted {
                        None
                    } else {
                        Some("finish_state_mismatch".into())
                    },
                    terminal_run_revision: if accepted { Some(1) } else { None },
                    expected_operation_set_hash: "hash".into(),
                    unresolved_operations: Vec::new(),
                    signature: None,
                };
                ack.signature = Some(
                    sign::sign_frame(server, finish::FINISH_ACK_FRAME_TYPE, &ack.to_value())
                        .unwrap(),
                );
                let (tx, mut rx) = mpsc::channel(1);
                core.link_commands = tx;
                core.consume_finish_ack(&server.public_jwk(), ack.to_value());
                if accepted {
                    assert!(
                        matches!(rx.try_recv(), Ok(LinkCommand::ReleaseLease { lease_id }) if lease_id == "lease-1")
                    );
                    core.handle(LinkEvent::LeaseRenewal(renewal_event(
                        Instant::now() + Duration::from_secs(60),
                    )));
                    assert!(core.lease_deadline.is_none());
                    assert_eq!(core.sidecar.as_ref().unwrap().state(), SidecarState::Exited);
                } else {
                    assert!(rx.try_recv().is_err());
                    assert!(core.lease_deadline.is_some());
                    assert_eq!(
                        core.sidecar.as_ref().unwrap().state(),
                        SidecarState::Running
                    );
                }
            });
        }
    }

    /// A provisioned core whose uplink frames are captured (the finish/reconcile production assertions
    /// read them). Mirrors `provisioned_core` but retains the uplink receiver.
    fn core_with_uplinks(
        dir: &std::path::Path,
        device: SoftwareKey,
        server: &SoftwareKey,
        permit: &SoftwareKey,
    ) -> (SyncCore, mpsc::Receiver<UplinkFrame>) {
        let db_path = dir.join(format!("{DEVICE}.db"));
        let journal = Journal::create(&db_path, DEVICE, &dek::TestWrap).unwrap();
        let (uplink_tx, uplink_rx) = mpsc::channel::<UplinkFrame>(8);
        let (link_cmd_tx, _link_cmd_rx) = mpsc::channel::<LinkCommand>(4);
        let (journal_handle, _journal_op_rx) = crate::journalop::channel();
        #[cfg(windows)]
        let (node_service_tx, _node_service_rx) = tokio::sync::mpsc::channel(8);
        let mut core = SyncCore::new(
            journal,
            ready(),
            Arc::new(device),
            uplink_tx,
            link_cmd_tx,
            spawn_template(),
            journal_handle,
            instance_facts(),
            #[cfg(windows)]
            node_service_tx,
        );
        core.server_jwk = Some(server.public_jwk());
        core.permit_jwk = Some(permit.public_jwk());
        core.session_id = Some("sess".to_string());
        core.generation = 1;
        core.lease_deadline = Some(Instant::now() + Duration::from_secs(30));
        core.lease_id = Some("lease-1".into());
        core.lease_mode = LeaseMode::Active;
        core.session_accepts_work = true;
        core.run_fence = 2;
        (core, uplink_rx)
    }

    /// Seed one succeeded artifact.write operation with its completed receipt + a recorded checkpoint,
    /// the journal facts a completed finish judges from.
    fn seed_completed_write(core: &mut SyncCore) {
        let rctx = core.journal.context(&core.org_id, &core.subject_id);
        let dek = *core.journal.dek();
        record::append_action(
            core.journal.connection(),
            &dek,
            &rctx,
            &ActionRow {
                org_id: &core.org_id,
                operation_id: "op-1",
                run_id: "run",
                attempt: "attempt-1",
                step_key: "tool:0:0",
                logical_key: "tool:0:0#0",
                supersedes: None,
                request_hash: "hash",
                fence: 2,
                session_id: "sess",
                generation: 1,
                permit_jti: "jti-1",
                state: "succeeded",
                result_hash: None,
                result_ref: None,
            },
            b"body",
        )
        .unwrap();
        let env = serde_json::json!({
            "schema_version": 2, "type": "receipt", "device_id": DEVICE,
            "body": { "operation_id": "op-1", "state": "completed", "result_hash": "a".repeat(64) },
        });
        record::insert_receipt(
            core.journal.connection(),
            core.journal.journal_epoch(),
            1,
            &record::ReceiptRow {
                operation_id: "op-1",
                state: "completed",
                signed_bytes: &serde_json::to_vec(&env).unwrap(),
                signed_hash: "h",
            },
        )
        .unwrap();
        // Mirror produce_receipt's durable result_hash stamp (the finish facts read the journal row,
        // not the transient outbox).
        core.journal
            .connection()
            .execute(
                "UPDATE action_journal SET result_hash = ?1, result_ref = 'run:op-1'
                 WHERE org_id = ?2 AND run_id = 'run' AND operation_id = 'op-1'",
                rusqlite::params!["a".repeat(64), core.org_id],
            )
            .unwrap();
        recover::persist_checkpoint(
            core.journal.connection(),
            &dek,
            &rctx,
            &recover::CheckpointRow {
                run_id: "run".into(),
                checkpoint_seq: 1,
                schema_version: crate::journal::schema::SCHEMA_VERSION,
                runtime_digest: "digest".into(),
                checkpoint_hash: "c".repeat(64),
                pending_operation_set_hash: "p".repeat(64),
                prior_receipt_ref: Some("1".into()),
            },
            b"canonical",
        )
        .unwrap();
        core.active_run = Some(ActiveRun {
            run_id: "run".into(),
            binding_revision: 1,
            fence: 2,
            lease_id: "lease-1".into(),
        });
        core.deliverables.insert("run".into(), vec!["v-1".into()]);
        // Batch 4: the completed finish names only PUBLISHED versions (0059). Mark v-1 published
        // (a verified publish_ack already arrived) so the finish judgment proceeds.
        core.published
            .entry("run".into())
            .or_default()
            .insert("v-1".into());
        core.recorded_checkpoint.insert("run".into(), 1);
    }

    #[test]
    fn loop_end_proposes_a_completed_finish_from_journal_facts() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let device = SoftwareKey::random();
        let device_jwk = device.public_jwk();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let (mut core, mut uplink_rx) = core_with_uplinks(&dir, device, &server, &permit);
        seed_completed_write(&mut core);
        core.on_run_ended(Ok(()));
        let frame = uplink_rx.try_recv().expect("a run_finish uplink");
        assert_eq!(frame.frame_type, finish::FINISH_FRAME_TYPE);
        assert_eq!(frame.body["outcome"], "completed");
        assert_eq!(frame.body["deliverable_versions"][0], "v-1");
        assert_eq!(frame.body["final_checkpoint_seq"], "1");
        assert_eq!(frame.body["fence"], "2");
        let expected = crate::finish::facts::final_operation_set_hash(
            core.journal.connection(),
            &core.org_id,
            "run",
            core.journal.journal_epoch(),
        )
        .unwrap();
        assert_eq!(frame.body["final_operation_set_hash"], expected);
        let sig = frame.body["signature"].as_str().unwrap();
        assert!(sign::verify_frame(
            &device_jwk,
            finish::FINISH_FRAME_TYPE,
            &frame.body,
            sig
        ));
        // The durable proposal exists and awaits its ack.
        assert_eq!(
            recover::pending_finishes(core.journal.connection())
                .unwrap()
                .len(),
            1
        );
        assert!(core.awaiting_finish_ack.is_some());
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_undelivered_dispatch_blocks_a_completed_finish() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let (mut core, mut uplink_rx) =
            core_with_uplinks(&dir, SoftwareKey::random(), &server, &permit);
        seed_completed_write(&mut core);
        core.undelivered
            .entry("run".into())
            .or_default()
            .insert("model:0".into());
        core.on_run_ended(Ok(()));
        let frame = uplink_rx.try_recv().expect("a run_finish uplink");
        assert_eq!(frame.body["outcome"], "failed");
        assert!(frame.body["deliverable_versions"]
            .as_array()
            .unwrap()
            .is_empty());
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_completed_finish_publishes_deliverables_before_proposing() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let device = SoftwareKey::random();
        let device_jwk = device.public_jwk();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let (mut core, mut uplink_rx) = core_with_uplinks(&dir, device, &server, &permit);
        seed_completed_write(&mut core);
        // Un-publish v-1 and supply the publication facts: the gate must publish before judging.
        core.published.get_mut("run").unwrap().remove("v-1");
        core.deliverable_facts.insert(
            "v-1".into(),
            crate::journalop::DeliverableFacts {
                run_id: "run".into(),
                operation_id: "op-1".into(),
                version_id: "v-1".into(),
                logical_name: "a".into(),
                format: "md".into(),
                content_hash: "a".repeat(64),
                byte_count: 5,
            },
        );
        core.receipt_seq_by_op.insert("op-1".into(), 1);
        core.on_run_ended(Ok(()));
        // The first uplink is local_publish, NOT run_finish (publication precedes completed finish).
        let frame = uplink_rx.try_recv().expect("a local_publish uplink");
        assert_eq!(frame.frame_type, publish::PUBLISH_FRAME_TYPE);
        assert_eq!(frame.body["version_id"], "v-1");
        assert_eq!(frame.body["logical_name"], "a"); // derived from args artifact_id (ruling 甲)
        assert_eq!(frame.body["content_hash"], "a".repeat(64)); // bare hex
        assert!(frame.body["artifact_id"].is_null()); // merge by logical_name
        assert_eq!(frame.body["local_ref"], "run:op-1"); // == receipt local_result_ref (run_id:operation_id)
        assert_eq!(frame.body["classification_claimed"], "local_only");
        let epoch = core.journal.journal_epoch().to_string();
        assert_eq!(frame.body["receipt_ref"], format!("{epoch}:1"));
        assert!(sign::verify_frame(
            &device_jwk,
            publish::PUBLISH_FRAME_TYPE,
            &frame.body,
            frame.body["signature"].as_str().unwrap()
        ));
        assert!(core.publish_pending.contains("v-1"));
        // No finish is proposed while publication is in flight.
        assert!(uplink_rx.try_recv().is_err());
        assert!(core.awaiting_finish_ack.is_none());
        // A verified publish_ack marks v-1 published and lets the completed finish proceed.
        let mut ack = publish::PublishAckBody {
            run_id: "run".into(),
            operation_id: "op-1".into(),
            version_id: "v-1".into(),
            artifact_id: "44444444-4444-4444-4444-444444444444".into(),
            version_no: 1,
            location: "local_only".into(),
            classification: "local_only".into(),
            publish_ack: format!("sha256:{}", "c".repeat(64)),
            signature: None,
        };
        ack.signature = Some(
            sign::sign_frame(&server, publish::PUBLISH_ACK_FRAME_TYPE, &ack.to_value()).unwrap(),
        );
        core.consume_publish_ack(&server.public_jwk(), ack.to_value());
        assert!(core.published.get("run").unwrap().contains("v-1"));
        assert!(!core.publish_pending.contains("v-1"));
        let finish_frame = uplink_rx
            .try_recv()
            .expect("a run_finish uplink after publication");
        assert_eq!(finish_frame.frame_type, finish::FINISH_FRAME_TYPE);
        assert_eq!(finish_frame.body["outcome"], "completed");
        assert_eq!(finish_frame.body["deliverable_versions"][0], "v-1");
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unsigned_publish_ack_never_marks_published() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let (mut core, _uplink_rx) =
            core_with_uplinks(&dir, SoftwareKey::random(), &server, &permit);
        let ack = publish::PublishAckBody {
            run_id: "run".into(),
            operation_id: "op-1".into(),
            version_id: "v-1".into(),
            artifact_id: "44444444-4444-4444-4444-444444444444".into(),
            version_no: 1,
            location: "local_only".into(),
            classification: "local_only".into(),
            publish_ack: format!("sha256:{}", "c".repeat(64)),
            signature: None, // unsigned: fail-closed
        };
        core.consume_publish_ack(&server.public_jwk(), ack.to_value());
        assert!(!core
            .published
            .get("run")
            .map(|s| s.contains("v-1"))
            .unwrap_or(false));
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_verified_receipt_ack_advances_the_heartbeat_watermark() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let (mut core, _uplink_rx) =
            core_with_uplinks(&dir, SoftwareKey::random(), &server, &permit);
        seed_completed_write(&mut core);
        // insert_receipt seeds the outbox row directly; production receipt production also advances
        // device_meta.next_receipt_seq, which current_receipt_seq reads (next-1). Mirror that here.
        core.journal
            .connection()
            .execute(
                "UPDATE device_meta SET next_receipt_seq = 2 WHERE device_id = ?1",
                rusqlite::params![core.device_id],
            )
            .unwrap();
        let (tx, mut rx) = mpsc::channel(4);
        core.link_commands = tx;
        // A server-signed receipt_ack recording the seeded receipt at seq 1.
        let mut ack = receipt_ack::ReceiptAckBody {
            recorded: vec![crate::frame::receipt_ack::RecordedReceipt {
                receipt_seq: 1,
                operation_id: "op-1".into(),
                state: "completed".into(),
                resolution_revision: None,
                replayed: false,
            }],
            conflicts: Vec::new(),
            receipt_through_seq: 1,
            signature: None,
        };
        ack.signature =
            Some(sign::sign_frame(&server, receipt_ack::FRAME_TYPE, &ack.to_value()).unwrap());
        core.consume_receipt_ack(
            &server.public_jwk(),
            receipt_ack::FRAME_TYPE,
            ack.to_value(),
        );
        assert_eq!(core.last_receipt_seq, 1);
        // The link must learn the live watermark, or its next heartbeat regresses below the lease's
        // recorded seq and renew_device_lease refuses it (0051), killing the session mid-Run.
        assert!(matches!(
            rx.try_recv(),
            Ok(LinkCommand::ReceiptWatermark(1))
        ));
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reconcile_replays_an_unacked_finish_verbatim() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let (mut core, mut uplink_rx) =
            core_with_uplinks(&dir, SoftwareKey::random(), &server, &permit);
        // A durable un-acked proposal (e.g. persisted before a restart).
        let body = serde_json::json!({
            "finish_id": "finish-1", "run_id": "run", "binding_revision": "1", "fence": "2",
            "lease_id": "lease-1", "outcome": "completed", "reason_code": null,
            "final_checkpoint_seq": "1", "final_checkpoint_hash": "c".repeat(64),
            "receipt_through_seq": "1", "final_operation_set_hash": "d".repeat(64),
            "deliverable_versions": ["v-1"], "signature": "sig",
        });
        recover::persist_finish(
            core.journal.connection(),
            &recover::FinishRow {
                run_id: "run".into(),
                finish_id: "finish-1".into(),
                outcome: "completed".into(),
                reason: None,
                final_checkpoint_seq: Some(1),
                final_checkpoint_hash: Some("c".repeat(64)),
                signed_bytes: serde_json::to_vec(&body).unwrap(),
                signed_hash: "h".into(),
                ack_state: None,
                terminal_run_revision: None,
            },
        )
        .unwrap();
        core.reconcile_uplink();
        let frame = uplink_rx.try_recv().expect("a replayed run_finish");
        assert_eq!(frame.frame_type, finish::FINISH_FRAME_TYPE);
        // Same finish_id, same signed bytes — never re-judged or re-signed.
        assert_eq!(frame.body, body);
        assert_eq!(core.awaiting_finish_ack.as_deref(), Some("finish-1"));
        drop(core);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cancel_and_session_loss_cannot_be_undone_by_renewal() {
        for cause in [None, Some(crate::transport::LeaseLoss::SessionLost)] {
            with_running_core(|core, server, _| {
                match cause {
                    None => core.handle(LinkEvent::Downlink(Box::new(signed_cancel(
                        server, "run", 1,
                    )))),
                    Some(cause) => core.handle(LinkEvent::LeasesInvalidated {
                        ids: vec!["lease-1".into()],
                        cause,
                    }),
                }
                core.handle(LinkEvent::LeaseRenewal(renewal_event(
                    Instant::now() + Duration::from_secs(60),
                )));
                assert!(core.lease_deadline.is_none());
                assert_eq!(core.sidecar.as_ref().unwrap().state(), SidecarState::Exited);
            });
        }
    }

    /// A command + nested permit bound to the provisioned identity (org/sub/DEVICE/sess, fence 2),
    /// minted around the real clock so the permit gate's now_unix/lease checks pass. TTL = 5s.
    fn signed_command(
        server: &SoftwareKey,
        permit_key: &SoftwareKey,
        jti: &str,
        operation_id: &str,
    ) -> command::CommandBody {
        use crate::frame::rfc3339::format_utc_seconds;
        use crate::permit::signed::{
            SignedPermit, AUD_DEVICE_TOOL, FRAME_TYPE as PERMIT_FRAME_TYPE,
        };
        use crate::thumbprint::device_key_thumbprint;
        let now = now_unix();
        let mut p = SignedPermit {
            v: 2,
            aud: AUD_DEVICE_TOOL.into(),
            kid: device_key_thumbprint(&permit_key.public_jwk()),
            jti: jti.into(),
            org_id: "org".into(),
            subject_id: "sub".into(),
            device_id: DEVICE.into(),
            session_id: "sess".into(),
            agent_instance_id: "agent".into(),
            boot_id: "boot".into(),
            generation: 1,
            run_id: "run".into(),
            operation_id: operation_id.into(),
            dispatch_attempt_id: "attempt".into(),
            request_hash: "hash".into(),
            fence: 2,
            policy_epoch: 1,
            access_epoch: 1,
            grant_id: "grant".into(),
            grant_revision: 1,
            approval_id: None,
            decision_revision: None,
            scope_hash: "scope".into(),
            destination_id: None,
            max_bytes: 1024,
            issued_at: format_utc_seconds(now.saturating_sub(1)).unwrap(),
            expires_at: format_utc_seconds(now + 4).unwrap(),
            signature: None,
        };
        p.signature = Some(sign::sign_frame(permit_key, PERMIT_FRAME_TYPE, &p.to_value()).unwrap());
        let mut c = command::CommandBody {
            command_id: format!("cmd-{jti}"),
            run_id: "run".into(),
            operation_id: operation_id.into(),
            logical_key: "step#0".into(),
            dispatch_attempt_id: "attempt".into(),
            request_hash: "hash".into(),
            tool_schema: "read-v1".into(),
            local_payload_ref: "local/payload".into(),
            permit: p,
            signature: None,
        };
        c.signature =
            Some(sign::sign_frame(server, command::COMMAND_FRAME_TYPE, &c.to_value()).unwrap());
        c
    }

    #[test]
    fn a_verified_command_registers_one_journal_row_bound_to_the_permit_jti() {
        let device = SoftwareKey::random();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let mut core = provisioned_core(&dir, device, &server, &permit);

        let cmd = signed_command(&server, &permit, "jti-cmd-1", "op-1");
        let server_jwk = server.public_jwk();
        core.consume_command(&server_jwk, cmd.to_value());

        // The full command is sealed verbatim as the action body; read_action recovers it.
        let rctx = core.journal.context("org", "sub");
        let sealed = record::read_action(
            core.journal.connection(),
            core.journal.dek(),
            &rctx,
            "org",
            "op-1",
        )
        .expect("the registered action body");
        let recovered: command::CommandBody = serde_json::from_slice(&sealed).unwrap();
        assert_eq!(recovered.operation_id, "op-1");
        assert_eq!(recovered.permit.jti, "jti-cmd-1");
        assert_eq!(recovered.permit.fence, 2);
        // Exactly one row, indexed by the consumed jti.
        let count: i64 = core
            .journal
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM action_journal WHERE permit_jti = ?1",
                rusqlite::params!["jti-cmd-1"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(core);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_resent_command_with_a_consumed_jti_does_not_register_a_second_row() {
        let device = SoftwareKey::random();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let mut core = provisioned_core(&dir, device, &server, &permit);
        let server_jwk = server.public_jwk();

        let cmd = signed_command(&server, &permit, "jti-cmd-2", "op-2");
        core.consume_command(&server_jwk, cmd.to_value());
        // DD:123: the same jti re-sent returns the journal, never re-executes / re-registers.
        core.consume_command(&server_jwk, cmd.to_value());

        let count: i64 = core
            .journal
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM action_journal WHERE permit_jti = ?1",
                rusqlite::params!["jti-cmd-2"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "a consumed jti must not register twice");
        drop(core);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_command_whose_permit_fence_mismatches_is_refused_and_registers_nothing() {
        let device = SoftwareKey::random();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let mut core = provisioned_core(&dir, device, &server, &permit);
        let server_jwk = server.public_jwk();

        // The permit carries fence 2 but the Run fence is 3: the identity gate refuses it.
        core.run_fence = 3;
        let cmd = signed_command(&server, &permit, "jti-cmd-3", "op-3");
        core.consume_command(&server_jwk, cmd.to_value());
        let count: i64 = core
            .journal
            .connection()
            .query_row("SELECT COUNT(*) FROM action_journal", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 0,
            "a fence-mismatched permit must never reach the journal"
        );
        drop(core);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A2 write spine (§6.3 C): a command consumed while a Run is active feeds the live per-Run map
    /// the executor reads (mid-Run), NOT the pre-start buffer; with no active Run it buffers for the
    /// next StartRun. This is the seam that lets a write authorized after start reach the sidecar.
    #[test]
    #[cfg(windows)]
    fn a_command_feeds_the_live_run_map_when_active_and_buffers_otherwise() {
        let device = SoftwareKey::random();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let mut core = provisioned_core(&dir, device, &server, &permit);
        let server_jwk = server.public_jwk();

        // No active Run yet: the command buffers for the next StartRun.
        let pre = signed_command(&server, &permit, "jti-live-pre", "op-pre");
        core.consume_command(&server_jwk, pre.to_value());
        assert_eq!(core.dispatched.len(), 1, "pre-start command must buffer");
        assert!(core.active_commands.is_none());

        // Start a Run: the live map is seeded from the buffer (drained) and kept for mid-Run feeds.
        let live = crate::nodeservice::shared_commands(std::mem::take(&mut core.dispatched));
        core.active_commands = Some(("run".to_string(), live.clone()));
        assert!(
            live.lock().unwrap().contains_key("step#0"),
            "the buffer seeds the live map"
        );

        // A command consumed mid-Run reaches the live map directly, not the buffer.
        let mid = signed_command(&server, &permit, "jti-live-mid", "op-mid");
        core.consume_command(&server_jwk, mid.to_value());
        assert!(
            core.dispatched.is_empty(),
            "mid-Run command must not buffer"
        );
        let map = live.lock().unwrap();
        let fed = map
            .get("step#0")
            .expect("the mid-Run command fed the live map");
        assert_eq!(fed.operation_id, "op-mid");
        assert_eq!(fed.permit_jti, "jti-live-mid");
        drop(map);
        drop(core);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unsigned_cancel_is_refused_and_uplinks_nothing() {
        let device = SoftwareKey::random();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let dir = temp_dir();
        let (uplink_tx, mut uplink_rx) = mpsc::channel::<UplinkFrame>(8);
        let __spawn = spawn_sync_core(
            dir.to_str().unwrap().to_string(),
            ready(),
            Arc::new(device),
            uplink_tx,
            mpsc::channel::<LinkCommand>(4).0,
            spawn_template(),
            instance_facts(),
            #[cfg(windows)]
            crate::nodeservice::spawn_node_service(),
        )
        .unwrap();
        let event_tx = __spawn.events;
        let _epoch = __spawn.epoch;
        event_tx
            .blocking_send(LinkEvent::SessionEstablished(Box::new(hello(
                &server, &permit,
            ))))
            .unwrap();
        let unsigned = cancel::CancelBody {
            run_id: "run".to_string(),
            cancel_revision: 1,
            signature: None,
        };
        let env = crate::frame::envelope::Envelope::new(
            cancel::CANCEL_FRAME_TYPE,
            DEVICE,
            unsigned.to_value(),
        );
        event_tx
            .blocking_send(LinkEvent::Downlink(Box::new(env)))
            .unwrap();
        // A valid cancel afterwards proves the refused one produced no uplink and did not stop the core.
        event_tx
            .blocking_send(LinkEvent::Downlink(Box::new(signed_cancel(
                &server, "run", 9,
            ))))
            .unwrap();
        let frame = uplink_rx.blocking_recv().expect("the valid cancel_ack");
        assert_eq!(frame.body["cancel_revision"], "9");
        drop(event_tx);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
