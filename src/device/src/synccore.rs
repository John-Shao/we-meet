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

use std::path::Path;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::sync::mpsc;

use crate::broker::ReadyIdentity;
use crate::frame::{action, cancel, checkpoint, command, finish, offer, receipt_ack, resolution};
use crate::journal::record::{self, ActionRow};
use crate::journal::recover::{self, StartRow};
use crate::journal::{dek, Journal, JournalError};
use crate::key::DeviceKey;
use crate::permit::signed::PermitContext;
use crate::reconcile::{resolution as resolution_consume, watermark};
use crate::recovery::{replay, resume};
use crate::sidecar::lifecycle::{Sidecar, SidecarState};
use crate::sidecar::spawn::SpawnConfig;
use crate::transport::{LinkEvent, UplinkFrame};

/// Spawn the sync core thread. It opens (or creates) the per-device journal, publishes the journal
/// epoch back to the caller (hello carries it, §6.1 device_meta), then serves forwarded link events
/// until the event channel closes. Returns the event sender and the journal epoch. The caller MUST
/// receive the epoch before spawning the link, and drop the sender to stop the core on shutdown.
///
/// `spawn_template` carries the fixed sidecar inputs (node/bundle paths, staging base, digests);
/// `consume_start` derives the per-Run staging dir from it. The real signed bundle is batch 2.
pub fn spawn_sync_core(
    journal_dir: String,
    ready: ReadyIdentity,
    key: Arc<dyn DeviceKey + Send + Sync>,
    uplinks: mpsc::Sender<UplinkFrame>,
    spawn_template: SpawnConfig,
) -> Result<(mpsc::Sender<LinkEvent>, String), String> {
    let (event_tx, mut event_rx) = mpsc::channel::<LinkEvent>(64);
    let (epoch_tx, epoch_rx) = std::sync::mpsc::sync_channel::<Result<String, String>>(0);
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
        let mut core = SyncCore::new(journal, ready, key, uplinks, spawn_template);
        while let Some(event) = event_rx.blocking_recv() {
            core.handle(event);
        }
    });
    let epoch = epoch_rx.recv().map_err(|_| {
        "the sync core thread died before publishing the journal epoch".to_string()
    })??;
    Ok((event_tx, epoch))
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
    // Session-provisioned authority (hello_ack). Until a session exists no downlink can verify.
    server_jwk: Option<crate::jwk::EcP256Jwk>,
    permit_jwk: Option<crate::jwk::EcP256Jwk>,
    session_id: Option<String>,
    generation: u64,
    lease_deadline: Option<Instant>,
    // The current Run binding (offer -> start). run_fence is the permit identity gate's fence.
    offer: Option<offer::RunOfferBody>,
    run_fence: u64,
    sidecar: Option<Sidecar>,
    #[cfg_attr(not(windows), allow(dead_code))]
    spawn_template: SpawnConfig,
    // The spawned process tree (Windows). Dropping it kills the Job tree (batch 1f lease kill).
    #[cfg(windows)]
    process: Option<crate::sidecar::spawn::SidecarProcess>,
    last_receipt_seq: u64,
}

impl SyncCore {
    fn new(
        journal: Journal,
        ready: ReadyIdentity,
        key: Arc<dyn DeviceKey + Send + Sync>,
        uplinks: mpsc::Sender<UplinkFrame>,
        spawn_template: SpawnConfig,
    ) -> Self {
        let last_receipt_seq = current_receipt_seq(&journal, &ready.device_id);
        Self {
            journal,
            key,
            device_id: ready.device_id,
            org_id: ready.org_id,
            subject_id: ready.subject_id,
            uplinks,
            server_jwk: None,
            permit_jwk: None,
            session_id: None,
            generation: 0,
            lease_deadline: None,
            offer: None,
            run_fence: 0,
            sidecar: None,
            spawn_template,
            #[cfg(windows)]
            process: None,
            last_receipt_seq,
        }
    }

    fn handle(&mut self, event: LinkEvent) {
        match event {
            LinkEvent::SessionEstablished(ack) => {
                self.server_jwk = Some(ack.server_jwk.clone());
                self.permit_jwk = Some(ack.permit_jwk.clone());
                self.session_id = Some(ack.session_id.clone());
                self.generation = ack.generation;
                self.lease_deadline = Some(Instant::now() + ack.lease_ttl);
                eprintln!("work-device: session established, sync core provisioned");
            }
            LinkEvent::LeaseRenewal(state) => {
                if state.extended {
                    self.lease_deadline = Some(state.deadline);
                }
            }
            LinkEvent::LeasesInvalidated { ids, cause } => {
                // E7 甲 (batch 1f): an invalidated lease kills the sidecar Job tree and invalidates
                // the local lease so no new permit can validate (remaining_lease_secs == 0).
                self.lease_deadline = None;
                self.kill_sidecar();
                eprintln!("work-device: leases invalidated {ids:?} ({cause:?}), sidecar killed");
            }
            LinkEvent::Downlink(env) => self.route_downlink(&env.frame_type, env.body.clone()),
            LinkEvent::Disconnected { reason, attempt } => {
                eprintln!("work-device: link disconnected (attempt {attempt}): {reason}");
            }
            LinkEvent::AwaitingTicket | LinkEvent::Stopped => {}
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
        // verbatim as the action body; the indexed columns carry the queryable identity. attempt=1
        // and state="started" follow the landed jti precedent (permit/mod.rs); supersede/re-dispatch
        // is batch 3 reconcile scope.
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
            attempt: 1,
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
        self.kill_sidecar();
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
                Ok(()) => {}
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
        self.uplink(offer::READY_FRAME_TYPE, ready.to_value());
    }

    /// DD:113 — verify the start, match it to the stored offer, persist start_nonce BEFORE spawn,
    /// then bring up the single sidecar lifecycle and uplink run_started. The real CreateProcess
    /// into AppContainer+Job is batch 1d; batch 1c advances the lifecycle state machine only.
    fn consume_start(&mut self, server_jwk: &crate::jwk::EcP256Jwk, body: Value) {
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
        if !start.matches_offer(&offer_body) {
            eprintln!("work-device: start does not match the stored offer");
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
            match crate::sidecar::spawn::spawn_sidecar(&config, &start.run_id) {
                Ok(process) => self.process = Some(process),
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
        match resolution_consume::consume(self.journal.connection(), server_jwk, &self.org_id, &res)
        {
            Ok(ack) => self.uplink(resolution::ACK_FRAME_TYPE, ack.to_value()),
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
        match watermark::apply_receipt_watermark(
            self.journal.connection(),
            server_jwk,
            self.journal.journal_epoch(),
            &ack,
        ) {
            Ok(watermark) => eprintln!("work-device: checkpoint_ack watermark {watermark}"),
            Err(err) => eprintln!("work-device: checkpoint_ack refused: {err:?}"),
        }
    }

    fn consume_finish_ack(&mut self, server_jwk: &crate::jwk::EcP256Jwk, body: Value) {
        let ack: finish::RunFinishAckBody = match serde_json::from_value(body) {
            Ok(body) => body,
            Err(err) => {
                eprintln!("work-device: finish_ack schema refused: {err}");
                return;
            }
        };
        if !ack.verify(server_jwk) {
            eprintln!("work-device: finish_ack signature refused");
            return;
        }
        // The finish proposal must already be persisted (batch 3 produces it); record the ack.
        let run_id = match self.finish_run_id(&ack.finish_id) {
            Some(run_id) => run_id,
            None => {
                eprintln!(
                    "work-device: finish_ack for an unknown finish_id {}",
                    ack.finish_id
                );
                return;
            }
        };
        let terminal = ack.terminal_run_revision.map(|v| v as i64);
        if let Err(err) = replay::ack_finish(
            self.journal.connection(),
            &run_id,
            &ack.finish_id,
            &ack.state,
            terminal,
        ) {
            eprintln!("work-device: finish_ack record failed: {err:?}");
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

    /// Stop the sidecar: dropping the owned process closes the Job Object (kill-on-close terminates
    /// the whole tree) and the lifecycle advances to Exited. Idempotent — a second kill is a no-op.
    fn kill_sidecar(&mut self) {
        #[cfg(windows)]
        {
            self.process = None;
        }
        if let Some(sidecar) = self.sidecar.as_mut() {
            let _ = sidecar.mark_exited();
        }
    }

    fn remaining_lease_secs(&self) -> u64 {
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

    fn finish_run_id(&self, finish_id: &str) -> Option<String> {
        let pending = replay::pending_finishes(self.journal.connection()).ok()?;
        pending
            .into_iter()
            .find(|f| f.finish_id == finish_id)
            .map(|f| f.run_id)
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
        let (event_tx, epoch) = spawn_sync_core(
            dir.to_str().unwrap().to_string(),
            ready(),
            Arc::new(device),
            uplink_tx,
            spawn_template(),
        )
        .unwrap();
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
        let (event_tx, _epoch) = spawn_sync_core(
            dir.to_str().unwrap().to_string(),
            ready(),
            Arc::new(device),
            uplink_tx,
            spawn_template(),
        )
        .unwrap();
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
        let mut core = SyncCore::new(
            journal,
            ready(),
            Arc::new(device),
            uplink_tx,
            spawn_template(),
        );
        core.server_jwk = Some(server.public_jwk());
        core.permit_jwk = Some(permit.public_jwk());
        core.session_id = Some("sess".to_string());
        core.generation = 1;
        core.lease_deadline = Some(Instant::now() + Duration::from_secs(30));
        core.run_fence = 2;
        core
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

    #[test]
    fn an_unsigned_cancel_is_refused_and_uplinks_nothing() {
        let device = SoftwareKey::random();
        let server = SoftwareKey::random();
        let permit = SoftwareKey::random();
        let dir = temp_dir();
        let (uplink_tx, mut uplink_rx) = mpsc::channel::<UplinkFrame>(8);
        let (event_tx, _epoch) = spawn_sync_core(
            dir.to_str().unwrap().to_string(),
            ready(),
            Arc::new(device),
            uplink_tx,
            spawn_template(),
        )
        .unwrap();
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
