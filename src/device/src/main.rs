//! Binary entry point for the Work device Broker (device-design §1, §2.1).
//!
//! GW21 replaces the batch-0 version printer with the real process: it loads a closed JSON config
//! from the per-user install directory, opens (or creates) the non-exportable CNG signing key,
//! serves the ACL-protected shell pipe on a dedicated blocking thread, runs the core pump that owns
//! the ticket slot and the §2.1 identity, and starts the live link once a certificate-backed
//! identity exists.
//!
//! Three boundaries are deliberate and visible here:
//!
//! * The link cannot be built before a certificate arrives — `ClientIdentity` is a closed enum with
//!   no identity-less variant — so the entry waits for the pump to publish a `ReadyIdentity`. A
//!   renewal does not rebuild the link: the pump's channel ends are fixed for its lifetime, so the
//!   entry sends `LinkCommand::ReplaceIdentity` and the next dial presents the new chain. The
//!   current session is not dropped, because the old certificate stays valid until its own NotAfter
//!   and §2.1 renewals happen inside that last hour.
//! * Downlink frames are forwarded to the sync core, which owns A2 journal registration and
//!   sidecar dispatch; the entry only forwards link events and never duplicates domain writes.
//! * REST stays with the desktop main process (§2.1). This binary has no HTTP client: it signs and
//!   reports facts over the pipe, and the shell drives pairing, ticket minting and renewal.
//!
//! The ticket slot is keyed by the device id, which the Broker only learns from a CA-signed
//! certificate. Before that it is keyed by an empty string, so a ticket delivered for a real device
//! is refused as foreign rather than accepted against a placeholder.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::mpsc;
use work_device::broker::{run_core_pump, ReadyIdentity};
use work_device::identity::{Identity, IdentityConfig};
use work_device::ipc::ticket::TicketSlot;
use work_device::key::DeviceKey;
use work_device::synccore::spawn_sync_core;
use work_device::transport::link::Link;
use work_device::transport::{LinkCommand, LinkConfig, LinkEvent, Reconnect};

/// The closed config shape. No arbitrary command/path/url field: the only path is the CA file, and
/// it is read once at startup rather than being reachable from any IPC message.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrokerConfig {
    /// Full pipe path, `\\.\pipe\...`.
    pipe_name: String,
    /// The desktop main process that spawned this Broker. The pipe's OS auth already binds the
    /// user SID and login session; this is the extra predicate that refuses every OTHER process
    /// of that same user, so only the shell may deliver tickets/certificates (M2 ruling).
    shell_pid: u32,
    /// `https://host:port` of the gateway listener.
    endpoint: String,
    /// Name verified against the gateway's server certificate.
    server_name: String,
    /// Path to the device CA root PEM.
    ca_pem_path: String,
    /// Persisted CNG container name.
    container: String,
    /// CNG provider name.
    provider: String,
    boot_id: String,
    agent_instance_id: String,
    /// Base directory for the per-device journal databases. The Broker forms
    /// `<journal_dir>/<device_id>.db` once the certificate reveals the device id (CN); the journal
    /// owns its epoch (device_meta), NOT this config — hello carries `Journal::journal_epoch()`.
    journal_dir: String,
    profile_id: String,
    tool_manifest_hash: String,
    runtime_digest: String,
    last_receipt_seq: u64,
    connect_timeout_ms: u64,
    reconnect_base_ms: u64,
    reconnect_max_ms: u64,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--uninstall") {
        if let Err(err) = run_uninstall(&args[2..]) {
            eprintln!("work-device: {err}");
            std::process::exit(1);
        }
        return;
    }
    // Teardown primitive: a persisted CNG container is a real user-profile artefact, so removing it
    // must be an explicit operation rather than a side effect of a failed start. The local
    // full-chain evidence uses it to leave nothing behind; uninstall (§8) uses the same call.
    if args.get(1).map(String::as_str) == Some("--delete-container") {
        match args.get(2) {
            Some(name) => match delete_container(name) {
                Ok(()) => return,
                Err(err) => {
                    eprintln!("work-device: {err}");
                    std::process::exit(1);
                }
            },
            None => {
                eprintln!("usage: work-device --delete-container <name>");
                std::process::exit(2);
            }
        }
    }
    let path = match args.get(1) {
        Some(path) => path.clone(),
        None => {
            eprintln!("usage: work-device <config.json>");
            std::process::exit(2);
        }
    };
    if let Err(err) = run(&path) {
        eprintln!("work-device: {err}");
        std::process::exit(1);
    }
}

fn run_uninstall(args: &[String]) -> Result<(), String> {
    use std::path::PathBuf;
    use work_device::upgrade::uninstall::{self, UninstallMode};

    let mut journal = None;
    let mut mode = None;
    let mut support_package = None;
    let mut support_key = None;
    let mut acknowledge_loss = false;
    let mut container = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--journal" => {
                journal = Some(PathBuf::from(
                    args.get(index + 1).ok_or("missing --journal value")?,
                ));
                index += 2;
            }
            "--mode" => {
                mode = Some(match args.get(index + 1).map(String::as_str) {
                    Some("preserve") => UninstallMode::Preserve,
                    Some("delete") => UninstallMode::Delete,
                    _ => return Err("--mode must be preserve or delete".into()),
                });
                index += 2;
            }
            "--support-package" => {
                support_package = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or("missing --support-package value")?,
                ));
                index += 2;
            }
            "--support-key" => {
                support_key = Some(PathBuf::from(
                    args.get(index + 1).ok_or("missing --support-key value")?,
                ));
                index += 2;
            }
            "--acknowledge-loss" => {
                acknowledge_loss = true;
                index += 1;
            }
            "--container" => {
                container = Some(
                    args.get(index + 1)
                        .ok_or("missing --container value")?
                        .clone(),
                );
                index += 2;
            }
            other => return Err(format!("unknown --uninstall option: {other}")),
        }
    }
    let journal = journal.ok_or("--journal is required")?;
    let mode = mode.ok_or("--mode is required")?;
    if support_package.is_some() != support_key.is_some() {
        return Err("--support-package and --support-key must be supplied together".into());
    }
    if container.is_some() && mode != UninstallMode::Delete {
        return Err("--container is only valid with --mode delete".into());
    }
    if let (Some(output), Some(key_path)) = (support_package, support_key) {
        let key = uninstall::read_support_key(&key_path).map_err(|err| err.to_string())?;
        uninstall::write_support_package(&journal, &key, &output).map_err(|err| err.to_string())?;
    }
    let summary = uninstall::remove_journal(&journal, mode, acknowledge_loss)
        .map_err(|err| err.to_string())?;
    if let Some(name) = container {
        delete_container(&name)?;
    }
    let rendered = serde_json::to_string(&summary).map_err(|err| format!("summary: {err}"))?;
    println!("uninstall_mode={mode:?} summary={rendered}");
    Ok(())
}

#[cfg(windows)]
fn delete_container(name: &str) -> Result<(), String> {
    let key = work_device::cng::CngKey::open(name).map_err(|e| format!("open CNG key: {e:?}"))?;
    key.delete().map_err(|e| format!("delete CNG key: {e:?}"))
}

#[cfg(not(windows))]
fn delete_container(_name: &str) -> Result<(), String> {
    Err("CNG containers only exist on Windows".to_string())
}

fn run(path: &str) -> Result<(), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read config: {e}"))?;
    let cfg: BrokerConfig = serde_json::from_str(&raw).map_err(|e| format!("parse config: {e}"))?;
    let ca_pem = std::fs::read(&cfg.ca_pem_path).map_err(|e| format!("read CA: {e}"))?;

    let key = open_or_create_key(&cfg.container)?;
    let thumbprint = key.thumbprint();
    let identity = Identity::new(
        IdentityConfig {
            container: cfg.container.clone(),
            provider: cfg.provider.clone(),
            ca_pem: ca_pem.clone(),
        },
        key.clone(),
    )
    .map_err(|e| format!("identity: {e:?}"))?;

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| format!("runtime: {e}"))?;

    let (delivery_tx, delivery_rx) = mpsc::channel(4);
    let (link_event_tx, link_event_rx) = mpsc::channel(32);
    let (ticket_tx, ticket_rx) = mpsc::channel(1);
    let (core_tx, mut core_rx) = mpsc::channel(32);
    let (command_tx, command_rx) = mpsc::channel(4);
    let (ready_tx, mut ready_rx) = mpsc::channel::<ReadyIdentity>(4);
    // The sync core (batch 1c) signs uplink frames and sends them here; the link stamps the
    // session identity and writes them to the gateway. The core thread owns this sender.
    let (uplink_tx, uplink_rx) = mpsc::channel::<work_device::transport::UplinkFrame>(64);

    // The long-lived Node service thread (execution-face §6.1) owns the grant/endpoint registries +
    // executor + proxy. Created once at startup, BEFORE the pump, so the shell confirmation face can
    // route to it even before the first certificate; the sync core shares the same sender for StartRun.
    #[cfg(windows)]
    let node_service = work_device::nodeservice::spawn_node_service();

    // The pipe loop is blocking by design and must never run inside the async runtime.
    let pipe_name = cfg.pipe_name.clone();
    let shell_pid = cfg.shell_pid;
    let pipe = std::thread::spawn(move || {
        work_device::ipc::service::serve_shell_pipe(&pipe_name, shell_pid, delivery_tx)
    });

    // Shared with the sync core, which fills it with the journal handle and session facts; the
    // pump signs approval decisions directly so `ask_each` stays decidable while a Run waits.
    let approval_signer: work_device::journalop::ApprovalSignerSlot =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let pump = rt.spawn(run_core_pump(
        identity,
        TicketSlot::new(""),
        delivery_rx,
        link_event_rx,
        ticket_tx,
        core_tx,
        ready_tx,
        approval_signer.clone(),
        #[cfg(windows)]
        node_service.clone(),
    ));

    eprintln!(
        "work-device: pipe {} ready, thumbprint {thumbprint}",
        cfg.pipe_name
    );

    let outcome = rt.block_on(async {
        let first = match ready_rx.recv().await {
            Some(ready) => ready,
            None => {
                return Err("the core pump stopped before any certificate was delivered".to_string())
            }
        };
        // Batch 1c (E4 甲): the sync core thread is the journal's sole owner. It opens the
        // per-device journal, publishes the epoch (hello carries it, §6.1 device_meta) and serves
        // forwarded downlinks. The rendezvous recv below blocks this worker only until the journal
        // is open — a one-time startup handoff, like the GW18 blocking pipe thread.
        //
        // Batch 1d: the sidecar inputs are derived from the install layout (node runtime + bundle
        // next to the executable, staging under the journal base), NOT new config fields — the
        // closed BrokerConfig stays 17 fields. The real signed bundle provisioning is batch 2;
        // batch 1d/1g evidence uses a fixture node + bundle at this layout.
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_default();
        let spawn_template = work_device::sidecar::spawn::SpawnConfig {
            node_path: exe_dir.join("node.exe").to_string_lossy().into_owned(),
            bundle_path: exe_dir
                .join("work-device-bundle")
                .join("main.js")
                .to_string_lossy()
                .into_owned(),
            manifest_hash: cfg.tool_manifest_hash.clone(),
            runtime_digest: cfg.runtime_digest.clone(),
            staging_dir: std::path::Path::new(&cfg.journal_dir)
                .join("staging")
                .to_string_lossy()
                .into_owned(),
        };
        let core_spawn = spawn_sync_core(
            cfg.journal_dir.clone(),
            first.clone(),
            key.clone(),
            uplink_tx,
            command_tx.clone(),
            spawn_template,
            work_device::journalop::InstanceFacts {
                agent_instance_id: cfg.agent_instance_id.clone(),
                boot_id: cfg.boot_id.clone(),
            },
            approval_signer.clone(),
            #[cfg(windows)]
            node_service.clone(),
        )?;
        let core_input_tx = core_spawn.events;
        let journal_epoch = core_spawn.epoch;
        let link = spawn_link(&cfg, ca_pem, first, key, ticket_rx, command_rx, uplink_rx, journal_epoch, link_event_tx);
        loop {
            tokio::select! {
                event = core_rx.recv() => match event {
                    Some(LinkEvent::Stopped) => { link.abort(); break; }
                    // A2 consumption lives in the sync core; the entry only forwards.
                    Some(other) => {
                        if core_input_tx.send(other).await.is_err() { link.abort(); break; }
                    }
                    None => { link.abort(); break; }
                },
                renewed = ready_rx.recv() => match renewed {
                    Some(ready) => {
                        eprintln!("work-device: certificate replaced, next dial presents the new chain");
                        if command_tx
                            .send(LinkCommand::ReplaceIdentity(ready.identity))
                            .await
                            .is_err()
                        {
                            link.abort();
                            break;
                        }
                    }
                    None => { link.abort(); break; }
                },
            }
        }
        // Closing the event channel stops the sync core thread, which drops the journal owner lock.
        drop(core_input_tx);
        Ok(())
    });

    // The pipe thread only observes the pump's disappearance on its next accept, so a shutdown
    // needs one client attachment to be observed (the GW18 blocking-accept boundary).
    drop(command_tx);
    pump.abort();
    let _ = pipe.join();
    outcome
}

#[allow(clippy::too_many_arguments)]
fn spawn_link(
    cfg: &BrokerConfig,
    ca_pem: Vec<u8>,
    ready: ReadyIdentity,
    key: Arc<dyn DeviceKey + Send + Sync>,
    tickets: mpsc::Receiver<String>,
    commands: mpsc::Receiver<LinkCommand>,
    uplinks: mpsc::Receiver<work_device::transport::UplinkFrame>,
    journal_epoch: String,
    events: mpsc::Sender<LinkEvent>,
) -> tokio::task::JoinHandle<()> {
    let config = LinkConfig {
        endpoint: cfg.endpoint.clone(),
        server_name: cfg.server_name.clone(),
        ca_pem,
        identity: ready.identity,
        device_id: ready.device_id,
        boot_id: cfg.boot_id.clone(),
        agent_instance_id: cfg.agent_instance_id.clone(),
        journal_epoch,
        profile_id: cfg.profile_id.clone(),
        tool_manifest_hash: cfg.tool_manifest_hash.clone(),
        runtime_digest: cfg.runtime_digest.clone(),
        recovery_generation: 0,
        last_receipt_seq: cfg.last_receipt_seq,
        connect_timeout: Duration::from_millis(cfg.connect_timeout_ms),
        reconnect: Reconnect {
            base: Duration::from_millis(cfg.reconnect_base_ms),
            max: Duration::from_millis(cfg.reconnect_max_ms),
        },
    };
    let link = Link::new(config, key);
    tokio::spawn(link.run(tickets, commands, uplinks, events))
}

/// Open the persisted key, creating it on first run. The provider comes from the config so a
/// deployment naming a TPM provider does not silently fall back to software CNG; provenance never
/// claims hardware attestation (§2.1).
#[cfg(windows)]
fn open_or_create_key(container: &str) -> Result<Arc<dyn DeviceKey + Send + Sync>, String> {
    use work_device::cng::CngKey;
    if let Ok(key) = CngKey::open(container) {
        return Ok(Arc::new(key));
    }
    let key = CngKey::create(container).map_err(|e| format!("create CNG key: {e:?}"))?;
    Ok(Arc::new(key))
}

/// The production identity is a non-exportable Windows CNG key. A non-Windows build must not
/// silently substitute an exportable software key, so the entry refuses to start.
#[cfg(not(windows))]
fn open_or_create_key(_container: &str) -> Result<Arc<dyn DeviceKey + Send + Sync>, String> {
    Err(
        "the Broker's production identity is a Windows CNG key; this build cannot start"
            .to_string(),
    )
}
