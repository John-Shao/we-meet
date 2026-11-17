//! Test-only cross-language probe for the GW18 ticket path: shell pipe → pump → live link.
//!
//! WHERE THIS RUNS. The named pipe is Windows-only (`ipc::pipe`/`ipc::service` are `#[cfg(windows)]`),
//! while the GW17 cross-language interop runs in the Linux Go job because only that job has the real
//! PostgreSQL chain. The two halves therefore cannot share a CI runner: Linux proves link→gateway→
//! PostgreSQL, Windows proves pipe→dispatch→pump→slot→link channel (`cargo test`). This probe is the
//! seam between them, driven by `TestDeviceBrokerInterop` on a Windows machine with both a Rust
//! toolchain and the Go/PostgreSQL fixture — a LOCAL full-chain run, registered as not covered by CI.
//! On any other platform it refuses to run rather than silently reporting success.
//!
//! WHAT IT PROVES. The config carries NO ticket field at all, so the link structurally cannot dial
//! with a handed-over ticket: the only source is the pipe. The Go side plays the desktop shell
//! (main process), connects to the real pipe, completes the one-time handshake, delivers a ticket
//! minted in the real `device_session_ticket` shape (64 lowercase hex) and reads the closed reply.
//! The probe then runs the SHIPPED `broker::run_ticket_bridge` and `transport::link::Link` — no
//! reimplementation — and the Go side asserts the session row and the consumed ticket in PostgreSQL.
//!
//! NOT a production artifact: `examples/` is outside the release payload closure, the key is a
//! software test key (production keeps it non-exportable in CNG, the registered J39 gap), and the
//! PKCS#12 archive is a test-CA fixture.

use serde_json::json;

fn fail(reason: &str) -> ! {
    println!("PROBE_REPORT {}", json!({"ok": false, "error": reason}));
    std::process::exit(1);
}

fn main() {
    #[cfg(windows)]
    win::run();
    #[cfg(not(windows))]
    fail("the broker probe needs Windows named pipes; the Linux interop covers the link only");
}

#[cfg(windows)]
mod win {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use serde::Deserialize;
    use serde_json::json;
    use tokio::sync::mpsc;

    use work_device::broker::run_ticket_bridge;
    use work_device::ipc::service::serve_shell_pipe;
    use work_device::ipc::ticket::TicketSlot;
    use work_device::key::{DeviceKey, SoftwareKey};
    use work_device::transport::link::Link;
    use work_device::transport::{LinkCommand, LinkConfig, LinkEvent, Reconnect};

    use super::fail;

    /// Everything the Go side hands over. There is deliberately NO `ticket` member: the only ticket
    /// source is the pipe, so a session established by this probe proves the whole path crossed.
    #[derive(Deserialize)]
    struct ProbeConfig {
        endpoint: String,
        server_name: String,
        ca_pem: String,
        client_pkcs12_base64: String,
        pkcs12_password: String,
        device_key_scalar_hex: String,
        device_id: String,
        boot_id: String,
        agent_instance_id: String,
        journal_epoch: String,
        profile_id: String,
        tool_manifest_hash: String,
        runtime_digest: String,
        last_receipt_seq: u64,
        /// The pipe the Go shell client connects to.
        pipe_name: String,
        budget_ms: u64,
    }

    pub fn run() {
        let path = match std::env::args().nth(1) {
            Some(path) => path,
            None => fail("usage: device_broker_probe <config.json>"),
        };
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(err) => fail(&format!("read config: {err}")),
        };
        let cfg: ProbeConfig = match serde_json::from_str(&raw) {
            Ok(cfg) => cfg,
            Err(err) => fail(&format!("parse config: {err}")),
        };
        let scalar = match hex32(&cfg.device_key_scalar_hex) {
            Some(scalar) => scalar,
            None => fail("device_key_scalar_hex is not 32 bytes of hex"),
        };
        let key = match SoftwareKey::from_bytes(&scalar) {
            Ok(key) => key,
            Err(_) => fail("device key scalar is not a valid P-256 private key"),
        };
        let device_jwk = key.public_jwk();
        let config = LinkConfig {
            endpoint: cfg.endpoint.clone(),
            server_name: cfg.server_name.clone(),
            ca_pem: cfg.ca_pem.into_bytes(),
            client_pkcs12: match work_device::b64::decode(&cfg.client_pkcs12_base64) {
                Ok(bytes) => bytes,
                Err(_) => fail("client_pkcs12_base64 is not base64url"),
            },
            pkcs12_password: cfg.pkcs12_password.clone(),
            device_id: cfg.device_id.clone(),
            boot_id: cfg.boot_id.clone(),
            agent_instance_id: cfg.agent_instance_id.clone(),
            journal_epoch: cfg.journal_epoch.clone(),
            profile_id: cfg.profile_id.clone(),
            tool_manifest_hash: cfg.tool_manifest_hash.clone(),
            runtime_digest: cfg.runtime_digest.clone(),
            recovery_generation: 0,
            last_receipt_seq: cfg.last_receipt_seq,
            connect_timeout: Duration::from_secs(10),
            reconnect: Reconnect {
                base: Duration::from_millis(200),
                max: Duration::from_secs(1),
            },
        };

        let rt = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(err) => fail(&format!("runtime: {err}")),
        };

        let (delivery_tx, delivery_rx) = mpsc::channel(4);
        let (link_event_tx, link_event_rx) = mpsc::channel(32);
        let (ticket_tx, ticket_rx) = mpsc::channel(1);
        let (core_tx, mut core_rx) = mpsc::channel(32);
        let (command_tx, command_rx) = mpsc::channel(4);

        // The real Windows pipe service loop on a dedicated blocking thread, exactly as a Broker
        // would run it: blocking_send/blocking_recv are only legal outside the async runtime.
        let pipe_name = cfg.pipe_name.clone();
        let server = std::thread::spawn(move || serve_shell_pipe(&pipe_name, delivery_tx));
        let bridge = rt.spawn(run_ticket_bridge(
            TicketSlot::new(&cfg.device_id),
            delivery_rx,
            link_event_rx,
            ticket_tx,
            core_tx,
        ));
        let link = Link::new(config, Arc::new(key));
        let link_handle = rt.spawn(link.run(ticket_rx, command_rx, link_event_tx));

        let started = Instant::now();
        let budget = Duration::from_millis(cfg.budget_ms);
        let mut report = json!({
            "ok": false,
            "device_public_jwk": device_jwk,
            "downlink_types": [],
            "pipe_name": cfg.pipe_name,
        });
        let mut established: Option<Instant> = None;
        let mut heartbeat_interval = Duration::from_secs(10);
        let mut downlinks: Vec<String> = Vec::new();

        rt.block_on(async {
            loop {
                if let Some(at) = established {
                    if at.elapsed() >= heartbeat_interval + Duration::from_millis(1500) {
                        report["ok"] = json!(true);
                        report["alive_ms"] = json!(at.elapsed().as_millis() as u64);
                        break;
                    }
                }
                let remaining = budget.saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    report["error"] = json!("budget exhausted before the link proved liveness");
                    break;
                }
                let wait = match established {
                    Some(at) => remaining.min(
                        (heartbeat_interval + Duration::from_millis(1500))
                            .saturating_sub(at.elapsed()),
                    ),
                    None => remaining,
                };
                let event = match tokio::time::timeout(wait, core_rx.recv()).await {
                    Ok(Some(event)) => event,
                    Ok(None) => {
                        report["error"] = json!("event channel closed");
                        break;
                    }
                    Err(_) => continue,
                };
                match event {
                    LinkEvent::SessionEstablished(ack) => {
                        heartbeat_interval = ack.heartbeat_interval;
                        report["session_id"] = json!(ack.session_id);
                        report["generation"] = json!(ack.generation);
                        report["lease_ttl_ms"] = json!(ack.lease_ttl.as_millis() as u64);
                        report["heartbeat_ms"] = json!(ack.heartbeat_interval.as_millis() as u64);
                        report["resync_required"] = json!(ack.resync_required);
                        report["server_public_jwk"] = json!(ack.server_jwk);
                        report["permit_public_jwk"] = json!(ack.permit_jwk);
                        established = Some(Instant::now());
                    }
                    LinkEvent::Downlink(env) => downlinks.push(env.frame_type.clone()),
                    LinkEvent::LeaseRenewal(state) => {
                        report["lease_renewal"] = json!({
                            "lease_id": state.lease_id,
                            "extended": state.extended,
                            "fence": state.fence,
                        });
                    }
                    LinkEvent::LeasesInvalidated { ids, cause } => {
                        report["leases_invalidated"] =
                            json!({"ids": ids, "cause": format!("{cause:?}")});
                    }
                    LinkEvent::Disconnected { reason, attempt } => {
                        report["error"] =
                            json!(format!("disconnected (attempt {attempt}): {reason}"));
                        break;
                    }
                    LinkEvent::AwaitingTicket => {
                        // The pump consumes this, so seeing it here means the wiring is wrong.
                        report["error"] = json!("the pump forwarded AwaitingTicket to the core");
                        break;
                    }
                    LinkEvent::Stopped => break,
                }
            }
            report["downlink_types"] = json!(downlinks);
            let _ = command_tx.send(LinkCommand::Stop).await;
            let _ = tokio::time::timeout(Duration::from_secs(5), link_handle).await;
            match tokio::time::timeout(Duration::from_secs(5), bridge).await {
                Ok(Ok(outcome)) => report["bridge_outcome"] = json!(format!("{outcome:?}")),
                _ => report["bridge_outcome"] = json!("did not stop in time"),
            }
        });

        // With the pump gone the pipe loop must stop too, rather than keep accepting calls it
        // cannot answer. The loop blocks in ConnectNamedPipe, so a test-only nudge unblocks it;
        // a production Broker exits with the process and needs no such courtesy.
        nudge_pipe(&cfg.pipe_name);
        match server.join() {
            Ok(Err(work_device::ipc::pipe::PipeError::Broker)) => {
                report["pipe_stopped"] = json!(true);
            }
            Ok(other) => report["pipe_stopped"] = json!(format!("unexpected: {other:?}")),
            Err(_) => report["pipe_stopped"] = json!("server thread panicked"),
        }
        println!("PROBE_REPORT {report}");
        if report["ok"].as_bool() == Some(true) {
            std::process::exit(0);
        }
        std::process::exit(1);
    }

    /// Open and immediately close the pipe so a server blocked in `accept` returns and observes
    /// that the pump is gone. Test-only teardown, never a production path.
    fn nudge_pipe(name: &str) {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE};
        use windows::Win32::Storage::FileSystem::{
            CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE, OPEN_EXISTING,
        };
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        for _ in 0..400 {
            let handle = unsafe {
                CreateFileW(
                    PCWSTR(wide.as_ptr()),
                    GENERIC_READ.0 | GENERIC_WRITE.0,
                    FILE_SHARE_NONE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAGS_AND_ATTRIBUTES(0),
                    None,
                )
            };
            if let Ok(handle) = handle {
                unsafe {
                    let _ = CloseHandle(handle);
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn hex32(text: &str) -> Option<[u8; 32]> {
        if text.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for (index, byte) in out.iter_mut().enumerate() {
            let pair = &text[index * 2..index * 2 + 2];
            *byte = u8::from_str_radix(pair, 16).ok()?;
        }
        Some(out)
    }
}
