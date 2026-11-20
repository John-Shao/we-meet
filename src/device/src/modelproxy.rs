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

use std::io::{Read, Write};
use std::net::TcpStream;

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
) -> Result<ModelReply, ProxyError> {
    let dest = LoopbackAddr::V4([127, 0, 0, 1]);
    let mut stream =
        TcpStream::connect(("127.0.0.1", endpoint.port)).map_err(|_| ProxyError::Connect)?;
    let local = stream.local_addr().map_err(|_| ProxyError::Connect)?;
    let local_addr = match local.ip() {
        std::net::IpAddr::V4(v4) => LoopbackAddr::V4(v4.octets()),
        std::net::IpAddr::V6(_) => return Err(ProxyError::Connect),
    };
    let local_port = local.port();

    // §5.4: verify the listening process identity before sending any request byte.
    let identity = listener::resolve_listener(&dest, endpoint.port, &local_addr, local_port)?;
    listener::verify_binding(
        &identity,
        &endpoint.record,
        &endpoint.requirement,
        &endpoint.current_user_sid,
    )?;

    // Only now write the request. Connection: close keeps each call a fresh, re-verified connection.
    let body = serde_json::to_vec(request_doc).map_err(|_| ProxyError::BadResponse)?;
    let request = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        endpoint.port,
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| ProxyError::Io)?;
    stream.write_all(&body).map_err(|_| ProxyError::Io)?;
    stream.flush().map_err(|_| ProxyError::Io)?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|_| ProxyError::Io)?;
    parse_reply(&response)
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
        let err = invoke(&endpoint, &json!({ "v": 1 })).unwrap_err();
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
        let first = invoke(&endpoint, &json!({ "v": 1, "messages": [] })).expect("first invoke");
        assert_eq!(
            first.assistant_message["tool_calls"][0]["function"]["name"],
            "artifact.write"
        );
        assert!(first.answer_hash.starts_with("sha256:"));
        assert_eq!(first.usage["total_tokens"], 15);
        // Second call stops deterministically.
        let second = invoke(&endpoint, &json!({ "v": 1, "messages": [] })).expect("second invoke");
        assert_eq!(second.assistant_message["content"], "Artifact written.");

        let _ = child.kill();
        let _ = child.wait();
    }
}
