//! Test-only cross-language interop probe for the A1 device link (GW17).
//!
//! The Go gateway test (`src/work/internal/gateway/interop_test.go`) writes a JSON config,
//! builds this example and runs it against a REAL gateway backed by a REAL PostgreSQL chain.
//! The probe drives the production `transport::link::Link` — not a reimplementation — so what
//! it proves is the shipped code path: platform mTLS with the CA-bound client certificate, the
//! JCS-signed hello with a single-use ticket, the strict `hello_ack` envelope parse (including
//! the uint64 decimal-string boundary the server used to violate), provisioning of BOTH server
//! keys, and a heartbeat the gateway accepts.
//!
//! It prints one `PROBE_REPORT {json}` line to stdout and exits 0 on success, 1 on failure.
//! Liveness past the server's heartbeat cadence is the evidence the heartbeat crossed: a refused
//! heartbeat fails the whole frame and ends the stream, which would surface as `Disconnected`.
//!
//! NOT a production artifact: `examples/` is outside `cmd/` and outside the release payload
//! closure, and the key it loads is a software test key, never the non-exportable CNG identity.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

use work_device::key::{DeviceKey, SoftwareKey};
use work_device::transport::link::Link;
use work_device::transport::{LinkCommand, LinkConfig, LinkEvent, Reconnect};

/// Everything the Go side hands over. PEM material and the key scalar are inline so the probe
/// needs no filesystem layout beyond the one config file.
#[derive(Deserialize)]
struct ProbeConfig {
    endpoint: String,
    server_name: String,
    ca_pem: String,
    client_pkcs12_base64: String,
    pkcs12_password: String,
    /// 32-byte private scalar, hex. Test-only: production keys stay non-exportable in CNG.
    device_key_scalar_hex: String,
    device_id: String,
    boot_id: String,
    agent_instance_id: String,
    journal_epoch: String,
    profile_id: String,
    tool_manifest_hash: String,
    runtime_digest: String,
    last_receipt_seq: u64,
    ticket: String,
    /// Overall wall-clock budget for the probe, milliseconds.
    budget_ms: u64,
}

fn fail(reason: &str) -> ! {
    println!("PROBE_REPORT {}", json!({"ok": false, "error": reason}));
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    let path = match std::env::args().nth(1) {
        Some(path) => path,
        None => fail("usage: device_link_probe <config.json>"),
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
    // The probe reports its own public JWK so the Go side can assert it matches the key the
    // device row was seeded with — the mTLS certificate and the frame signature must be the
    // SAME key (§2.1), and a mismatch would otherwise only surface as a server refusal.
    let device_jwk = key.public_jwk();

    let config = LinkConfig {
        endpoint: cfg.endpoint.clone(),
        server_name: cfg.server_name.clone(),
        ca_pem: cfg.ca_pem.into_bytes(),
        identity: work_device::transport::ClientIdentity::Pkcs12 {
            der: match work_device::b64::decode(&cfg.client_pkcs12_base64) {
                Ok(bytes) => bytes,
                Err(_) => fail("client_pkcs12_base64 is not base64url"),
            },
            password: cfg.pkcs12_password.clone(),
        },
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

    let (ticket_tx, ticket_rx) = mpsc::channel(1);
    let (command_tx, command_rx) = mpsc::channel(4);
    let (event_tx, mut event_rx) = mpsc::channel(32);
    if ticket_tx.send(cfg.ticket.clone()).await.is_err() {
        fail("ticket channel closed before the link started");
    }
    let link = Link::new(config, Arc::new(key));
    let handle = tokio::spawn(link.run(
        ticket_rx,
        command_rx,
        {
            let (tx, rx) = mpsc::channel(1);
            drop(tx);
            rx
        },
        event_tx,
    ));

    let started = Instant::now();
    let budget = Duration::from_millis(cfg.budget_ms);
    let mut report = json!({
        "ok": false,
        "device_public_jwk": device_jwk,
        "downlink_types": [],
    });
    let mut established: Option<Instant> = None;
    let mut heartbeat_interval = Duration::from_secs(10);
    let mut downlinks: Vec<String> = Vec::new();

    loop {
        // Liveness past one full server cadence: the heartbeat was sent and the gateway did not
        // refuse it (a refusal ends the stream, which would have arrived as Disconnected).
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
        // Wake at the liveness threshold, not at the end of the budget: no event arrives on a
        // quiet session, so waiting the whole budget would report a timeout on a healthy link.
        let wait = match established {
            Some(at) => remaining.min(
                (heartbeat_interval + Duration::from_millis(1500)).saturating_sub(at.elapsed()),
            ),
            None => remaining,
        };
        let event = match tokio::time::timeout(wait, event_rx.recv()).await {
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
                report["leases_invalidated"] = json!({"ids": ids, "cause": format!("{cause:?}")});
            }
            LinkEvent::Disconnected { reason, attempt } => {
                report["error"] = json!(format!("disconnected (attempt {attempt}): {reason}"));
                break;
            }
            LinkEvent::AwaitingTicket => {
                report["error"] = json!("link is awaiting another ticket");
                break;
            }
            LinkEvent::Stopped => break,
        }
    }
    report["downlink_types"] = json!(downlinks);

    let _ = command_tx.send(LinkCommand::Stop).await;
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    println!("PROBE_REPORT {report}");
    if report["ok"].as_bool() == Some(true) {
        std::process::exit(0);
    }
    std::process::exit(1);
}

/// Decode exactly 32 bytes of lowercase-or-uppercase hex.
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
