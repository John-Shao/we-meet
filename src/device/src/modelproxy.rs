//! The `device_local` model proxy (device-design §5.1/§5.4). The Broker proxies a registered,
//! probed local endpoint profile: ONLY a literal loopback address (`127.0.0.1`, never `localhost`),
//! a fixed port and a fixed API type. Every NEW TCP connection passes the §5.4 listener identity
//! gate ([`crate::listener`]) BEFORE any request byte is sent; a mismatch closes the connection and
//! no content leaves. There is no redirect following, no DNS resolution (so no rebinding), and no
//! model-output-specified URL. The request body is the canonical `local_model_request` doc; the
//! reply's assistant message is hashed and returned for the journal completed receipt.
//!
//! `org_remote`/`org_private` are out of scope this period (card E=B); this proxy is `device_local`
//! only and never reaches a device-external destination.

use std::cell::Cell;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use serde_json::Value;

use crate::listener::{self, IdentityError, ListenerRecord, ListenerRequirement, LoopbackAddr};

/// A proxy refusal. Each maps to a closed model_blocked/model_unknown reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProxyError {
    /// The listener identity gate refused (§5.4) → `identity_mismatch` / `model_identity_unreadable`.
    Identity(IdentityError),
    /// The loopback connection could not be established.
    Connect,
    /// The endpoint returned a redirect (forbidden, §5.1) or a non-success status.
    RedirectOrStatus,
    /// The response could not be read / parsed.
    BadResponse,
    /// An I/O error mid-call: the effect is unknown, never silently retried (§5.2 step 5).
    Io,
    LeaseExpired,
}

impl From<IdentityError> for ProxyError {
    fn from(err: IdentityError) -> Self {
        ProxyError::Identity(err)
    }
}

/// A registered, user-confirmed `device_local` endpoint (§5.4 step 3 binding).
#[derive(Clone, Debug)]
pub struct DeviceLocalEndpoint {
    pub port: u16,
    pub record: ListenerRecord,
    pub requirement: ListenerRequirement,
    pub current_user_sid: Vec<u8>,
}

/// The verified model reply the Broker hands back to Node (and hashes for the receipt).
#[derive(Clone, Debug)]
pub struct ModelReply {
    pub assistant_message: Value,
    pub answer_hash: String,
    pub answer_bytes: u64,
    pub usage: Value,
    pub provider_request_id: String,
}

/// Invoke the local model over a fresh, identity-verified loopback connection. The identity gate runs
/// after connect and BEFORE the request is written; any refusal closes the socket with no byte sent.
pub fn invoke(
    endpoint: &DeviceLocalEndpoint,
    request_doc: &Value,
    io_deadline: &Arc<Mutex<Option<Instant>>>,
) -> Result<ModelReply, ProxyError> {
    let live = || {
        io_deadline
            .lock()
            .unwrap()
            .is_some_and(|deadline| Instant::now() < deadline)
    };
    if !live() {
        return Err(ProxyError::LeaseExpired);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| ProxyError::Connect)?;
    let sending = Cell::new(false);
    runtime.block_on(async {
        let exchange = async {
            let dest = LoopbackAddr::V4([127, 0, 0, 1]);
            let mut stream = TcpStream::connect(("127.0.0.1", endpoint.port))
                .await
                .map_err(|_| ProxyError::Connect)?;
            let local = stream.local_addr().map_err(|_| ProxyError::Connect)?;
            let local_addr = match local.ip() {
                std::net::IpAddr::V4(v4) => LoopbackAddr::V4(v4.octets()),
                std::net::IpAddr::V6(_) => return Err(ProxyError::Connect),
            };
            let identity = listener::resolve_listener(&dest, endpoint.port, &local_addr, local.port())?;
            listener::verify_binding(
                &identity,
                &endpoint.record,
                &endpoint.requirement,
                &endpoint.current_user_sid,
            )?;
            let body = serde_json::to_vec(request_doc).map_err(|_| ProxyError::BadResponse)?;
            let request = format!(
                "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                endpoint.port,
                body.len()
            );
            // Identity inspection is synchronous; recheck before the first possible send.
            if !live() {
                return Err(ProxyError::LeaseExpired);
            }
            sending.set(true);
            stream.write_all(request.as_bytes()).await.map_err(|_| ProxyError::Io)?;
            stream.write_all(&body).await.map_err(|_| ProxyError::Io)?;
            stream.flush().await.map_err(|_| ProxyError::Io)?;
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.map_err(|_| ProxyError::Io)?;
            parse_reply(&response)
        };
        tokio::select! {
            biased;
            _ = async {
                loop {
                    let remaining = io_deadline.lock().unwrap()
                        .and_then(|deadline| deadline.checked_duration_since(Instant::now()));
                    match remaining {
                        Some(remaining) if !remaining.is_zero() => {
                            tokio::time::sleep(remaining.min(Duration::from_millis(10))).await;
                        }
                        _ => break,
                    }
                }
            } => Err(if sending.get() { ProxyError::Io } else { ProxyError::LeaseExpired }),
            result = exchange => result,
        }
    })
}

/// Split the HTTP response, refuse redirects/non-200, and adapt the Chat Completions message into the
/// assistant message + hash + usage the device face carries.
fn parse_reply(response: &[u8]) -> Result<ModelReply, ProxyError> {
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or(ProxyError::BadResponse)?;
    let head = String::from_utf8_lossy(&response[..split]);
    let body = &response[split + 4..];
    let status_line = head.lines().next().ok_or(ProxyError::BadResponse)?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or(ProxyError::BadResponse)?;
    // No redirect following (§5.1): any 3xx is a refusal, never a new destination.
    if !(200..300).contains(&status) {
        return Err(ProxyError::RedirectOrStatus);
    }
    let doc: Value = serde_json::from_slice(body).map_err(|_| ProxyError::BadResponse)?;
    let message = doc
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .cloned()
        .ok_or(ProxyError::BadResponse)?;
    let canonical = serde_jcs::to_vec(&message).map_err(|_| ProxyError::BadResponse)?;
    let answer_hash = format!("sha256:{}", crate::sha256_hex(&canonical));
    let answer_bytes = canonical.len() as u64;
    let usage = doc.get("usage").cloned().unwrap_or_else(|| {
        // No usage from the provider: record an estimated upper bound, never zero (§5.1 末段).
        serde_json::json!({ "estimated": true })
    });
    let provider_request_id = doc
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("device-local")
        .to_string();
    Ok(ModelReply {
        assistant_message: message,
        answer_hash,
        answer_bytes,
        usage,
        provider_request_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::listener::ListenerRequirement;
    use serde_json::json;
    use std::io::{Read, Write};

    fn deadline() -> Arc<Mutex<Option<Instant>>> {
        Arc::new(Mutex::new(Some(Instant::now() + Duration::from_secs(30))))
    }

    fn pinned_listener() -> (std::net::TcpListener, DeviceLocalEndpoint) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let (accepted, _) = listener.accept().unwrap();
        let identity = listener::resolve_listener(
            &LoopbackAddr::V4([127, 0, 0, 1]),
            port,
            &LoopbackAddr::V4([127, 0, 0, 1]),
            probe.local_addr().unwrap().port(),
        )
        .unwrap();
        drop((probe, accepted));
        let sid = crate::listener::tests_support::current_sid();
        assert_eq!(identity.owner_sid, sid);
        (
            listener,
            DeviceLocalEndpoint {
                port,
                record: ListenerRecord {
                    owner_sid: identity.owner_sid,
                    image_path: identity.image_path,
                    signer_thumbprint: identity.signer_thumbprint,
                    image_sha256: identity.image_sha256,
                },
                requirement: ListenerRequirement {
                    allowed_signers: vec![],
                    allow_user_pinned_hash: true,
                    allowed_service_sids: vec![],
                },
                current_user_sid: sid,
            },
        )
    }

    fn read_request(stream: &mut std::net::TcpStream) {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            header.push(byte[0]);
            assert!(header.len() < 4096);
        }
        let header = String::from_utf8(header).unwrap();
        assert!(header.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
        let length: usize = header
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .unwrap()
            .parse()
            .unwrap();
        let mut body = vec![0; length];
        stream.read_exact(&mut body).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({ "v": 1 })
        );
    }

    #[test]
    fn expired_or_revoked_lease_never_connects() {
        let (listener, endpoint) = pinned_listener();
        listener.set_nonblocking(true).unwrap();
        for value in [None, Some(Instant::now() - Duration::from_secs(1))] {
            let lease = Arc::new(Mutex::new(value));
            assert_eq!(
                invoke(&endpoint, &json!({ "v": 1 }), &lease).unwrap_err(),
                ProxyError::LeaseExpired
            );
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
    }

    #[test]
    fn stalled_response_is_disconnected_on_expiry_or_revocation_without_retry() {
        for revoke in [false, true] {
            let (listener, endpoint) = pinned_listener();
            let lease = deadline();
            let (sent, received) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                read_request(&mut stream);
                sent.send(()).unwrap();
                let mut byte = [0];
                assert_eq!(
                    stream.read(&mut byte).unwrap(),
                    0,
                    "broker must close the in-flight socket"
                );
                listener.set_nonblocking(true).unwrap();
                assert_eq!(
                    listener.accept().unwrap_err().kind(),
                    std::io::ErrorKind::WouldBlock
                );
            });
            let pending_lease = lease.clone();
            let call =
                std::thread::spawn(move || invoke(&endpoint, &json!({ "v": 1 }), &pending_lease));
            received.recv_timeout(Duration::from_secs(10)).unwrap();
            let stopped_at = Instant::now();
            *lease.lock().unwrap() = if revoke {
                None
            } else {
                Some(stopped_at + Duration::from_millis(100))
            };
            assert_eq!(call.join().unwrap().unwrap_err(), ProxyError::Io);
            assert!(stopped_at.elapsed() < Duration::from_secs(2));
            server.join().unwrap();
        }
    }

    #[test]
    fn renewal_keeps_the_same_in_flight_connection_alive_past_the_old_deadline() {
        let (listener, endpoint) = pinned_listener();
        let lease = deadline();
        let renewed_lease = lease.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&mut stream);
            let old_deadline = Instant::now() + Duration::from_millis(200);
            *renewed_lease.lock().unwrap() = Some(old_deadline);
            std::thread::sleep(Duration::from_millis(50));
            *renewed_lease.lock().unwrap() = Some(Instant::now() + Duration::from_secs(5));
            std::thread::sleep(
                old_deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(50),
            );
            assert!(Instant::now() > old_deadline);
            stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"choices\":[{\"message\":{\"content\":\"renewed\"}}]}").unwrap();
            drop(stream);
            listener.set_nonblocking(true).unwrap();
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        });
        let result = invoke(&endpoint, &json!({ "v": 1 }), &lease).unwrap();
        assert_eq!(result.assistant_message["content"], "renewed");
        server.join().unwrap();
    }

    #[test]
    fn parse_reply_adapts_a_chat_completions_message_and_hashes_it() {
        let body = json!({
            "id": "req-1",
            "choices": [{ "message": { "role": "assistant", "content": "hello" } }],
            "usage": { "input": 3, "output": 2 }
        });
        let raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            serde_json::to_vec(&body).unwrap().len(),
            serde_json::to_string(&body).unwrap()
        );
        let reply = parse_reply(raw.as_bytes()).unwrap();
        assert_eq!(reply.assistant_message["content"], "hello");
        assert_eq!(reply.provider_request_id, "req-1");
        assert!(reply.answer_hash.starts_with("sha256:"));
        assert_eq!(reply.usage["input"], 3);
        // The hash is over the JCS-canonical message, stable across key order.
        let reordered = json!({ "content": "hello", "role": "assistant" });
        let canon = serde_jcs::to_vec(&reordered).unwrap();
        assert_eq!(
            reply.answer_hash,
            format!("sha256:{}", crate::sha256_hex(&canon))
        );
    }

    #[test]
    fn parse_reply_refuses_a_redirect_without_following() {
        let raw = b"HTTP/1.1 302 Found\r\nLocation: http://evil/\r\nContent-Length: 0\r\n\r\n";
        assert_eq!(parse_reply(raw).unwrap_err(), ProxyError::RedirectOrStatus);
    }

    #[test]
    fn parse_reply_records_estimated_usage_when_absent() {
        let body = json!({ "choices": [{ "message": { "content": "x" } }] });
        let raw = format!(
            "HTTP/1.1 200 OK\r\n\r\n{}",
            serde_json::to_string(&body).unwrap()
        );
        let reply = parse_reply(raw.as_bytes()).unwrap();
        assert_eq!(reply.usage["estimated"], true);
    }

    #[test]
    fn invoke_refuses_when_the_listener_identity_does_not_match_the_binding() {
        use std::net::TcpListener;
        // A real loopback listener (this process), but a binding record with a different image hash
        // and no allowed signer → the gate must refuse before any request byte is sent.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                // If the gate wrongly passed, the server would read a request; record that it did not.
                let _ = sock.read(&mut buf);
            }
        });
        let sid = crate::listener::tests_support::current_sid();
        let endpoint = DeviceLocalEndpoint {
            port,
            record: ListenerRecord {
                owner_sid: sid.clone(),
                image_path: "C:\\other.exe".into(),
                signer_thumbprint: None,
                image_sha256: "sha256:not-the-real-image".into(),
            },
            requirement: ListenerRequirement {
                allowed_signers: vec![],
                allow_user_pinned_hash: true,
                allowed_service_sids: vec![],
            },
            current_user_sid: sid,
        };
        let err = invoke(&endpoint, &json!({ "v": 1 }), &deadline()).unwrap_err();
        assert!(matches!(err, ProxyError::Identity(IdentityError::Mismatch)));
        let _ = server.join();
    }

    /// End-to-end: spawn the bundled deterministic fixture (a REAL separate node process on literal
    /// loopback), probe its listener identity to build a hash-pinned binding (the configureLocalModel
    /// + probeLocalModel flow), then invoke through the §5.4 gate and assert the canned replies.
    #[test]
    fn invoke_through_the_identity_gate_against_the_bundled_fixture() {
        use std::net::{TcpListener, TcpStream};
        use std::process::{Command, Stdio};

        // Reserve a free port, then hand it to the fixture.
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let fixture = format!(
            "{}/../work/node/device-bundle/fixture-server.mjs",
            env!("CARGO_MANIFEST_DIR")
        );
        let mut child = Command::new("node")
            .arg(&fixture)
            .arg(port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn node fixture (node must be on PATH)");

        // Wait for the fixture to listen (connect+drop sends no request, so the counter stays 0).
        let mut ready = false;
        for _ in 0..100 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                ready = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if !ready {
            let _ = child.kill();
            panic!("fixture did not listen on {port}");
        }

        // Probe the fixture's listener identity over a throwaway connection to build the binding.
        let sid = crate::listener::tests_support::current_sid();
        let record = {
            let probe_stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let local = probe_stream.local_addr().unwrap();
            let identity = crate::listener::resolve_listener(
                &LoopbackAddr::V4([127, 0, 0, 1]),
                port,
                &LoopbackAddr::V4([127, 0, 0, 1]),
                local.port(),
            )
            .expect("probe the fixture listener identity");
            assert_eq!(identity.owner_sid, sid, "fixture runs as the current user");
            ListenerRecord {
                owner_sid: identity.owner_sid,
                image_path: identity.image_path,
                signer_thumbprint: identity.signer_thumbprint,
                image_sha256: identity.image_sha256,
            }
        };
        let endpoint = DeviceLocalEndpoint {
            port,
            record,
            requirement: ListenerRequirement {
                allowed_signers: vec![],
                allow_user_pinned_hash: true,
                allowed_service_sids: vec![],
            },
            current_user_sid: sid,
        };

        // First call drives an artifact.write tool call; the gate passes (same fixture image hash).
        let first = invoke(&endpoint, &json!({ "v": 1, "messages": [] }), &deadline())
            .expect("first invoke");
        assert_eq!(
            first.assistant_message["tool_calls"][0]["function"]["name"],
            "artifact.write"
        );
        assert!(first.answer_hash.starts_with("sha256:"));
        assert_eq!(first.usage["total_tokens"], 15);
        // Second call stops deterministically.
        let second = invoke(&endpoint, &json!({ "v": 1, "messages": [] }), &deadline())
            .expect("second invoke");
        assert_eq!(second.assistant_message["content"], "Artifact written.");

        let _ = child.kill();
        let _ = child.wait();
    }
}
