//! Test-only GW19a probe: the SHIPPED link dialing the SHIPPED Go gateway with a client
//! identity bound to a NON-EXPORTABLE CNG key. No private key bytes exist on this path —
//! the same persisted CNG key both backs the mTLS certificate and signs the hello, which is
//! the §2.1 production shape and is strictly stronger than the GW17 probe (software signing
//! key + a separate exportable PKCS#12 identity).
//!
//! Two phases, because the CA cannot sign a certificate for a key it has never seen:
//!   keygen <container>   create the persisted key, report its public JWK + thumbprint
//!   dial <config.json>   reopen that key by container name and dial the gateway
//!   delete <container>   remove the persisted key (cleanup; a real user-profile artifact)
//! Running keygen and dial as separate processes also proves the key survives a restart.
//!
//! The Go orchestration is `src/work/internal/gateway/interop_cng_test.go`. It only runs on
//! Windows with a real PostgreSQL, so no CI job covers this seam; the probe is exercised by
//! one local full-chain run.
//!
//! NOT a production artifact: `examples/` is outside `cmd/` and outside the release payload.

#[cfg(windows)]
fn main() {
    win::run();
}

#[cfg(not(windows))]
fn main() {
    println!(
        "PROBE_REPORT {}",
        serde_json::json!({"ok": false, "error": "the CNG identity probe is Windows-only"})
    );
    std::process::exit(1);
}

#[cfg(windows)]
mod win {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use serde::Deserialize;
    use serde_json::json;
    use tokio::sync::mpsc;

    use work_device::cng::CngKey;
    use work_device::key::DeviceKey;
    use work_device::transport::link::Link;
    use work_device::transport::{ClientIdentity, LinkCommand, LinkConfig, LinkEvent, Reconnect};

    /// Everything the Go side hands over for the dial phase. There is deliberately NO key
    /// scalar and NO PKCS#12 field: the probe structurally cannot dial with exported material.
    #[derive(Deserialize)]
    struct DialConfig {
        endpoint: String,
        server_name: String,
        ca_pem: String,
        /// Leaf first, then the chain. base64url DER.
        cert_der_chain_base64: Vec<String>,
        container: String,
        provider: String,
        device_id: String,
        boot_id: String,
        agent_instance_id: String,
        journal_epoch: String,
        profile_id: String,
        tool_manifest_hash: String,
        runtime_digest: String,
        last_receipt_seq: u64,
        ticket: String,
        budget_ms: u64,
    }

    fn fail(reason: &str) -> ! {
        println!("PROBE_REPORT {}", json!({"ok": false, "error": reason}));
        std::process::exit(1);
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        match args.first().map(String::as_str) {
            Some("keygen") => keygen(args.get(1).map(String::as_str)),
            Some("dial") => dial(args.get(1).map(String::as_str)),
            Some("delete") => delete(args.get(1).map(String::as_str)),
            other => fail(&format!(
                "usage: device_cng_probe keygen|dial <arg> (got {other:?})"
            )),
        }
    }

    fn keygen(container: Option<&str>) {
        let container = match container {
            Some(name) if !name.is_empty() => name,
            _ => fail("keygen needs a container name"),
        };
        let key = match CngKey::create(container) {
            Ok(key) => key,
            Err(err) => fail(&format!("create CNG key: {err:?}")),
        };
        println!(
            "CNG_KEYGEN {}",
            json!({
                "container": container,
                "jwk": key.public_jwk(),
                "thumbprint": key.thumbprint(),
            })
        );
        // Deliberately not deleted: the dial phase is a separate process.
    }

    fn delete(container: Option<&str>) {
        let container = match container {
            Some(name) if !name.is_empty() => name,
            _ => fail("delete needs a container name"),
        };
        match CngKey::open(container) {
            Ok(key) => {
                if let Err(err) = key.delete() {
                    fail(&format!("delete CNG key: {err:?}"));
                }
                println!("CNG_DELETED {container}");
            }
            // Already gone is a successful cleanup, not a failure.
            Err(_) => println!("CNG_DELETED {container} (absent)"),
        }
    }

    fn dial(path: Option<&str>) {
        let path = match path {
            Some(path) => path,
            None => fail("dial needs a config path"),
        };
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(err) => fail(&format!("read config: {err}")),
        };
        let cfg: DialConfig = match serde_json::from_str(&raw) {
            Ok(cfg) => cfg,
            Err(err) => fail(&format!("parse config: {err}")),
        };
        let runtime = match tokio::runtime::Runtime::new() {
            Ok(runtime) => runtime,
            Err(err) => fail(&format!("tokio runtime: {err}")),
        };
        runtime.block_on(dial_async(cfg));
    }

    async fn dial_async(cfg: DialConfig) {
        // Reopen the persisted key by name. This is the production shape: the scalar is never
        // read, and the certificate is linked to the same container.
        let key = match CngKey::open(&cfg.container) {
            Ok(key) => key,
            Err(err) => fail(&format!("open CNG key {}: {err:?}", cfg.container)),
        };
        let device_jwk = key.public_jwk();

        let mut chain = Vec::new();
        for encoded in &cfg.cert_der_chain_base64 {
            match work_device::b64::decode(encoded) {
                Ok(der) => chain.push(der),
                Err(_) => fail("cert_der_chain_base64 is not base64url"),
            }
        }
        if chain.is_empty() {
            fail("cert_der_chain_base64 is empty");
        }

        let config = LinkConfig {
            endpoint: cfg.endpoint.clone(),
            server_name: cfg.server_name.clone(),
            ca_pem: cfg.ca_pem.into_bytes(),
            identity: ClientIdentity::CngBound {
                cert_der_chain: chain,
                container: cfg.container.clone(),
                provider: cfg.provider.clone(),
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
        let handle = tokio::spawn(link.run(ticket_rx, command_rx, event_tx));

        let started = Instant::now();
        let budget = Duration::from_millis(cfg.budget_ms);
        let mut report = json!({
            "ok": false,
            "identity": "cng_bound",
            "container": cfg.container,
            "device_public_jwk": device_jwk,
            "downlink_types": [],
        });
        let mut established: Option<Instant> = None;
        let mut heartbeat_interval = Duration::from_secs(10);
        let mut downlinks: Vec<String> = Vec::new();

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
                    report["leases_invalidated"] =
                        json!({"ids": ids, "cause": format!("{cause:?}")});
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
}
