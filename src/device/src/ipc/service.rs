//! The shell→Broker named-pipe service loop (device-design §1; GW18).
//!
//! This is the first caller of the batch-5 IPC stack: `PipeServer` (ACL + client PID/SID/login
//! session), `Handshake` (one-time nonce + protocol major), `frame` (length-prefixed messages) and
//! `schema` (the closed method set) all existed with no loop to run them. The loop is:
//!
//! create → accept → OS auth → write the server hello → verify the client hello → then per message:
//! read frame → decode JSON → [`classify`] → either answer immediately or hand the message to the
//! ticket pump ([`crate::broker`]) and write the reply it returns.
//!
//! Two ruled boundaries are visible here. (1) The thirteen shell methods that have no handler yet
//! are answered with `method_not_implemented`, never silently ignored and never conflated with
//! `unknown_method` — §1 requires an explicit error rather than a silent downgrade. (2) The loop
//! does NOT validate the ticket itself: it forwards the decoded message so the pump runs
//! `ticket::deliver_message`, the single closure-then-slot path. Duplicating validation here would
//! let the pipe and the slot disagree.
//!
//! Blocking by design: this runs on a dedicated `std::thread`, never inside the async runtime, so
//! `blocking_send`/`blocking_recv` are legal and the sync core keeps its shape. A refused client
//! (foreign SID, foreign login session, bad handshake) ends that connection only — the server keeps
//! accepting, because one hostile or buggy caller must not take the shell channel down.

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::broker::DeliveryRequest;
use crate::ipc::dispatch::{classify, Dispatch, Reply};
use crate::ipc::handshake::{parse_client_hello, ClientKind, Handshake};
use crate::ipc::pipe::{PipeConnection, PipeError, PipeServer};

/// Serve the shell pipe until the ticket pump is gone.
///
/// `name` is the full pipe path (`\\.\pipe\...`). The DACL grants only the Broker's own user SID
/// and every accepted client is checked against the Broker's login session and PID.
pub fn serve_shell_pipe(
    name: &str,
    deliveries: mpsc::Sender<DeliveryRequest>,
) -> Result<(), PipeError> {
    let server = PipeServer::create(name)?;
    loop {
        if deliveries.is_closed() {
            return Err(PipeError::Broker);
        }
        let conn = match server.accept() {
            Ok(conn) => conn,
            // A client that fails OS auth is disconnected by `accept`; keep serving the rest.
            Err(_) => continue,
        };
        let outcome = serve_connection(&conn, &deliveries);
        // DisconnectNamedPipe runs on drop, so the next accept starts from a clean instance.
        drop(conn);
        if outcome == Err(PipeError::Broker) {
            return Err(PipeError::Broker);
        }
    }
}

/// One accepted, OS-authenticated connection: handshake, then the message loop. A client that
/// disconnects is a normal end (`Ok`), not a fault.
pub fn serve_connection(
    conn: &PipeConnection,
    deliveries: &mpsc::Sender<DeliveryRequest>,
) -> Result<(), PipeError> {
    let mut handshake = Handshake::new();
    write_json(conn, &handshake.server_hello())?;
    let hello = match read_message(conn) {
        Read::Gone => return Ok(()),
        Read::NotJson => return refuse_handshake(conn),
        Read::Json(value) => value,
    };
    let accepted = parse_client_hello(&hello)
        .ok()
        .filter(|hello| hello.client_kind == ClientKind::Shell)
        .map(|hello| handshake.verify(&hello).is_ok())
        .unwrap_or(false);
    if !accepted {
        return refuse_handshake(conn);
    }

    loop {
        if deliveries.is_closed() {
            return Err(PipeError::Broker);
        }
        let message = match read_message(conn) {
            Read::Gone => return Ok(()),
            // A payload that is not JSON is still a call that deserves an explicit answer.
            Read::NotJson => {
                write_json(conn, &Reply::refused(&Value::Null, "schema").to_value())?;
                continue;
            }
            Read::Json(message) => message,
        };
        let reply = match classify(&message) {
            Dispatch::Answer(reply) => reply,
            Dispatch::Ticket => {
                let (reply_tx, reply_rx) = oneshot::channel();
                deliveries
                    .blocking_send(DeliveryRequest {
                        message,
                        reply: reply_tx,
                    })
                    .map_err(|_| PipeError::Broker)?;
                reply_rx.blocking_recv().map_err(|_| PipeError::Broker)?
            }
        };
        write_json(conn, &reply.to_value())?;
    }
}

/// What one framed read produced. A malformed payload is kept distinct from a departed client: the
/// first gets a closed refusal, the second ends the connection.
enum Read {
    Gone,
    NotJson,
    Json(Value),
}

fn read_message(conn: &PipeConnection) -> Read {
    let raw = match conn.read_frame() {
        Ok(raw) => raw,
        Err(_) => return Read::Gone,
    };
    match serde_json::from_slice(&raw) {
        Ok(value) => Read::Json(value),
        Err(_) => Read::NotJson,
    }
}

/// The handshake is single-use, so a refusal is written and the connection closed — there is no
/// retry to negotiate. A Node sidecar belongs to the other ACL/message set and is refused here.
fn refuse_handshake(conn: &PipeConnection) -> Result<(), PipeError> {
    let _ = write_json(conn, &Reply::handshake().to_value());
    Err(PipeError::Handshake)
}

fn write_json(conn: &PipeConnection, value: &Value) -> Result<(), PipeError> {
    let raw = serde_json::to_vec(value).map_err(|_| PipeError::Frame)?;
    conn.write_frame(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::{run_ticket_bridge, BridgeOutcome};
    use crate::ipc::frame;
    use crate::ipc::handshake::PROTOCOL_MAJOR;
    use crate::ipc::schema::SHELL_METHODS;
    use crate::ipc::ticket::{self, TicketSlot};
    use crate::transport::LinkEvent;
    use serde_json::json;
    use std::time::Duration;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE, OPEN_EXISTING,
    };

    const TICKET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn unique_name() -> String {
        format!("\\\\.\\pipe\\work-device-gw18-{}", uuid::Uuid::new_v4())
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn delivery(ticket: &str, row: &str) -> Value {
        json!({
            "method": ticket::METHOD,
            "request_id": "req-1",
            "ticket": ticket,
            "device_id": "dev-1",
            "session_ticket_id": row,
        })
    }

    fn client_hello(nonce: &Value, kind: &str) -> Value {
        json!({"nonce": nonce, "protocol_major": PROTOCOL_MAJOR, "client_kind": kind})
    }

    /// A real pipe client: CreateFileW against the server's instance, then length-prefixed frames.
    struct Client {
        handle: HANDLE,
    }

    impl Client {
        /// Connect within a budget, or None. Between one client's disconnect and the server's next
        /// accept the instance is briefly unavailable, and a server that has already exited owns no
        /// instance at all — so a caller that only wants to unblock `accept` must tolerate both.
        fn try_connect(name: &str, budget: Duration) -> Option<Self> {
            let name_w = wide(name);
            let deadline = std::time::Instant::now() + budget;
            while std::time::Instant::now() < deadline {
                let handle = unsafe {
                    CreateFileW(
                        PCWSTR(name_w.as_ptr()),
                        GENERIC_READ.0 | GENERIC_WRITE.0,
                        FILE_SHARE_NONE,
                        None,
                        OPEN_EXISTING,
                        FILE_FLAGS_AND_ATTRIBUTES(0),
                        None,
                    )
                };
                if let Ok(handle) = handle {
                    return Some(Self { handle });
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            None
        }

        fn read(&self) -> Value {
            self.try_read().expect("read frame")
        }

        /// A read that reports a departed server instead of panicking. A single-instance pipe has a
        /// window between the previous client's close and the server's DisconnectNamedPipe where a
        /// new attachment is dropped, so attaching retries rather than assuming the first try lives.
        fn try_read(&self) -> Option<Value> {
            let mut buf = vec![0u8; frame::MAX_FRAME_BYTES + frame::LENGTH_PREFIX];
            let mut read: u32 = 0;
            unsafe {
                ReadFile(self.handle, Some(buf.as_mut_slice()), Some(&mut read), None).ok()?;
            }
            buf.truncate(read as usize);
            let payload = frame::decode(&buf).ok()?;
            serde_json::from_slice(payload).ok()
        }

        fn write(&self, value: &Value) {
            assert!(self.try_write(value), "write frame");
        }

        fn try_write(&self, value: &Value) -> bool {
            match serde_json::to_vec(value) {
                Ok(raw) => self.try_write_raw(&raw),
                Err(_) => false,
            }
        }

        fn write_raw(&self, payload: &[u8]) {
            assert!(self.try_write_raw(payload), "write frame");
        }

        fn try_write_raw(&self, payload: &[u8]) -> bool {
            let bytes = match frame::encode(payload) {
                Ok(bytes) => bytes,
                Err(_) => return false,
            };
            let mut written: u32 = 0;
            unsafe {
                WriteFile(
                    self.handle,
                    Some(bytes.as_slice()),
                    Some(&mut written),
                    None,
                )
                .is_ok()
            }
        }
    }

    /// Attach to the server and return the connection plus the server hello it wrote. Retries until
    /// a server hello actually arrives, which is the point where the server is committed to this
    /// connection and will not tear it down before the client answers.
    fn attach(name: &str) -> (Client, Value) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if let Some(client) = Client::try_connect(name, Duration::from_millis(200)) {
                if let Some(hello) = client.try_read() {
                    return (client, hello);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("could not attach to {name}");
    }

    impl Drop for Client {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }

    /// The whole Windows half: a real pipe server thread, the real ticket pump on a real runtime,
    /// and a real pipe client. Nothing here is a fake connection.
    struct Harness {
        name: String,
        rt: tokio::runtime::Runtime,
        link_tx: Option<mpsc::Sender<LinkEvent>>,
        ticket_rx: Option<mpsc::Receiver<String>>,
        core_rx: Option<mpsc::Receiver<LinkEvent>>,
        bridge: Option<tokio::task::JoinHandle<BridgeOutcome>>,
        server: Option<std::thread::JoinHandle<Result<(), PipeError>>>,
    }

    impl Harness {
        fn new() -> Self {
            let name = unique_name();
            let (delivery_tx, delivery_rx) = mpsc::channel(4);
            let (link_tx, link_rx) = mpsc::channel(8);
            let (ticket_tx, ticket_rx) = mpsc::channel(1);
            let (core_tx, core_rx) = mpsc::channel(8);
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap();
            let bridge = rt.spawn(run_ticket_bridge(
                TicketSlot::new("dev-1"),
                delivery_rx,
                link_rx,
                ticket_tx,
                core_tx,
            ));
            let server_name = name.clone();
            let server = std::thread::spawn(move || serve_shell_pipe(&server_name, delivery_tx));
            Self {
                name,
                rt,
                link_tx: Some(link_tx),
                ticket_rx: Some(ticket_rx),
                core_rx: Some(core_rx),
                bridge: Some(bridge),
                server: Some(server),
            }
        }

        fn client(&self) -> Client {
            let (client, hello) = attach(&self.name);
            client.write(&client_hello(&hello["nonce"], "shell"));
            client
        }

        fn ask(&mut self) {
            let tx = self.link_tx.as_ref().unwrap();
            self.rt
                .block_on(tx.send(LinkEvent::AwaitingTicket))
                .unwrap();
        }

        fn next_ticket(&mut self) -> Option<String> {
            let rx = self.ticket_rx.as_mut().unwrap();
            self.rt.block_on(async {
                tokio::time::timeout(Duration::from_millis(500), rx.recv())
                    .await
                    .ok()
                    .flatten()
            })
        }

        /// The pump consumes AwaitingTicket, so the core must see nothing for a ticket call.
        fn assert_no_core_event(&mut self) {
            let rx = self.core_rx.as_mut().unwrap();
            let quiet = self.rt.block_on(async {
                tokio::time::timeout(Duration::from_millis(100), rx.recv()).await
            });
            assert!(
                quiet.is_err(),
                "the pump forwarded an event it should consume"
            );
        }

        /// Stop the pump, then join the server. The loop checks for a closed pump before each
        /// accept, so it may already have exited (the pipe is gone) or still be blocked in accept;
        /// a short connect attempt unblocks the second case and is tolerated failing in the first.
        fn shutdown(mut self) -> Result<(), PipeError> {
            self.link_tx = None;
            let bridge = self.bridge.take().unwrap();
            assert_eq!(self.rt.block_on(bridge).unwrap(), BridgeOutcome::LinkGone);
            if let Some(client) = Client::try_connect(&self.name, Duration::from_millis(300)) {
                if let Some(hello) = client.try_read() {
                    let _ = client.try_write(&client_hello(&hello["nonce"], "shell"));
                    let _ = client.try_write(&delivery(TICKET, "row-teardown"));
                }
            }
            let server = self.server.take().unwrap();
            server.join().expect("server thread panicked")
        }
    }

    #[test]
    fn a_real_pipe_delivery_reaches_the_link_ticket_channel() {
        let mut h = Harness::new();
        let client = h.client();
        // The link asks first: the pump must not spend a ticket nobody requested.
        h.ask();
        assert_eq!(h.next_ticket(), None);
        client.write(&delivery(TICKET, "row-1"));
        let reply = client.read();
        assert_eq!(reply["result"], "accepted");
        assert_eq!(reply["request_id"], "req-1");
        assert_eq!(reply["method"], ticket::METHOD);
        assert!(reply.get("code").is_none());
        assert_eq!(reply.as_object().unwrap().len(), 3);
        // The ticket crossed the whole Windows half: pipe → dispatch → pump → slot → link channel.
        assert_eq!(h.next_ticket().as_deref(), Some(TICKET));
        h.assert_no_core_event();
        drop(client);
        assert_eq!(h.shutdown(), Err(PipeError::Broker));
    }

    #[test]
    fn a_delivery_before_the_request_is_held_not_spent() {
        let mut h = Harness::new();
        let client = h.client();
        client.write(&delivery(TICKET, "row-1"));
        assert_eq!(client.read()["result"], "accepted");
        assert_eq!(h.next_ticket(), None);
        h.ask();
        assert_eq!(h.next_ticket().as_deref(), Some(TICKET));
        drop(client);
        assert_eq!(h.shutdown(), Err(PipeError::Broker));
    }

    #[test]
    fn every_unimplemented_shell_method_gets_an_explicit_refusal_over_the_pipe() {
        let h = Harness::new();
        let client = h.client();
        let mut count = 0;
        for method in SHELL_METHODS {
            if *method == ticket::METHOD {
                continue;
            }
            count += 1;
            client.write(&json!({"method": method, "request_id": "req-13"}));
            let reply = client.read();
            assert_eq!(reply["result"], "refused", "{method}");
            assert_eq!(reply["code"], "method_not_implemented", "{method}");
            assert_eq!(reply["request_id"], "req-13");
            assert_eq!(reply["method"], *method);
            assert_eq!(reply.as_object().unwrap().len(), 4);
        }
        assert_eq!(count, 13);
        // The channel is still usable afterwards: a refusal is not a disconnect.
        client.write(&delivery(TICKET, "row-1"));
        assert_eq!(client.read()["result"], "accepted");
        drop(client);
        assert_eq!(h.shutdown(), Err(PipeError::Broker));
    }

    #[test]
    fn unknown_methods_and_forbidden_fields_are_refused_over_the_pipe() {
        let h = Harness::new();
        let client = h.client();
        client.write(&json!({"method": "executeArbitrary", "request_id": "r"}));
        assert_eq!(client.read()["code"], "unknown_method");
        // A viewer method is unknown on the shell channel.
        client.write(&json!({"method": "signObjectProof", "request_id": "r"}));
        assert_eq!(client.read()["code"], "unknown_method");
        for field in ["command", "path", "url"] {
            client.write(&json!({"method": ticket::METHOD, "request_id": "r", field: "x"}));
            let reply = client.read();
            assert_eq!(reply["code"], "schema", "{field}");
            assert_eq!(reply["request_id"], "r");
        }
        client.write(&json!({"request_id": "r"}));
        assert_eq!(client.read()["code"], "schema");
        drop(client);
        assert_eq!(h.shutdown(), Err(PipeError::Broker));
    }

    #[test]
    fn a_payload_that_is_not_json_gets_a_closed_reply_not_a_silent_drop() {
        let h = Harness::new();
        let client = h.client();
        client.write_raw(b"this is not json");
        let reply = client.read();
        assert_eq!(reply["result"], "refused");
        assert_eq!(reply["code"], "schema");
        assert_eq!(reply["request_id"], "");
        assert_eq!(reply["method"], "");
        // The connection survives a malformed payload: the next call is still answered.
        client.write(&delivery(TICKET, "row-1"));
        assert_eq!(client.read()["result"], "accepted");
        drop(client);
        assert_eq!(h.shutdown(), Err(PipeError::Broker));
    }

    #[test]
    fn ticket_refusals_cross_the_pipe_with_their_own_codes() {
        let mut h = Harness::new();
        let client = h.client();
        h.ask();
        let mut message = delivery(TICKET, "row-1");
        message["device_id"] = json!("dev-2");
        client.write(&message);
        assert_eq!(client.read()["code"], "foreign_device");
        assert_eq!(h.next_ticket(), None);

        client.write(&delivery("not-hex", "row-1"));
        assert_eq!(client.read()["code"], "shape");

        client.write(&delivery(TICKET, "row-1"));
        assert_eq!(client.read()["result"], "accepted");
        assert_eq!(h.next_ticket().as_deref(), Some(TICKET));
        // The spent id cannot be re-handed: the mint returns null on replay (0040:1429).
        client.write(&delivery(TICKET, "row-1"));
        assert_eq!(client.read()["code"], "already_consumed");
        drop(client);
        assert_eq!(h.shutdown(), Err(PipeError::Broker));
    }

    #[test]
    fn a_wrong_nonce_is_refused_explicitly_and_the_server_serves_the_next_client() {
        let h = Harness::new();
        let (client, hello) = attach(&h.name);
        client.write(&client_hello(&json!("not-the-server-nonce"), "shell"));
        let reply = client.read();
        assert_eq!(reply["result"], "refused");
        assert_eq!(reply["code"], "handshake");
        assert_eq!(reply["request_id"], "");
        assert_eq!(reply.as_object().unwrap().len(), 4);
        assert_ne!(hello["nonce"], "not-the-server-nonce");
        drop(client);
        // One refused client must not take the shell channel down.
        let good = h.client();
        good.write(&delivery(TICKET, "row-1"));
        assert_eq!(good.read()["result"], "accepted");
        drop(good);
        assert_eq!(h.shutdown(), Err(PipeError::Broker));
    }

    #[test]
    fn a_node_client_is_refused_on_the_shell_pipe() {
        let h = Harness::new();
        let (client, hello) = attach(&h.name);
        client.write(&client_hello(&hello["nonce"], "node"));
        assert_eq!(client.read()["code"], "handshake");
        drop(client);
        let good = h.client();
        good.write(&delivery(TICKET, "row-1"));
        assert_eq!(good.read()["result"], "accepted");
        drop(good);
        assert_eq!(h.shutdown(), Err(PipeError::Broker));
    }

    #[test]
    fn a_wrong_protocol_major_and_an_unclosed_hello_are_refused() {
        let h = Harness::new();
        let (client, hello) = attach(&h.name);
        client.write(&json!({
            "nonce": hello["nonce"],
            "protocol_major": PROTOCOL_MAJOR + 1,
            "client_kind": "shell",
        }));
        assert_eq!(client.read()["code"], "handshake");
        drop(client);

        // An extra member breaks the closed client-hello shape.
        let (client, hello) = attach(&h.name);
        let mut value = client_hello(&hello["nonce"], "shell");
        value["command"] = json!("anything");
        client.write(&value);
        assert_eq!(client.read()["code"], "handshake");
        drop(client);

        // A major above u32::MAX must not truncate into a matching version.
        let (client, hello) = attach(&h.name);
        client.write(&json!({
            "nonce": hello["nonce"],
            "protocol_major": u64::from(u32::MAX) + u64::from(PROTOCOL_MAJOR),
            "client_kind": "shell",
        }));
        assert_eq!(client.read()["code"], "handshake");
        drop(client);

        // A client hello that is not JSON at all is refused, not treated as a departure.
        let (client, _) = attach(&h.name);
        client.write_raw(b"not json");
        assert_eq!(client.read()["code"], "handshake");
        drop(client);
        assert_eq!(h.shutdown(), Err(PipeError::Broker));
    }

    #[test]
    fn each_connection_gets_a_fresh_nonce_and_the_old_one_is_not_accepted() {
        let h = Harness::new();
        let (first, hello_one) = attach(&h.name);
        let nonce_one = hello_one["nonce"].as_str().unwrap().to_string();
        first.write(&client_hello(&json!(nonce_one), "shell"));
        first.write(&delivery(TICKET, "row-1"));
        assert_eq!(first.read()["result"], "accepted");
        drop(first);

        let (second, hello_two) = attach(&h.name);
        let nonce_two = hello_two["nonce"].as_str().unwrap().to_string();
        assert_ne!(nonce_one, nonce_two);
        second.write(&client_hello(&json!(nonce_one), "shell"));
        assert_eq!(second.read()["code"], "handshake");
        drop(second);
        assert_eq!(h.shutdown(), Err(PipeError::Broker));
    }

    #[test]
    fn a_client_that_disconnects_does_not_kill_the_server() {
        let h = Harness::new();
        let client = h.client();
        client.write(&delivery(TICKET, "row-1"));
        assert_eq!(client.read()["result"], "accepted");
        drop(client);
        let next = h.client();
        next.write(&json!({"method": "chooseWorkspace", "request_id": "r"}));
        assert_eq!(next.read()["code"], "method_not_implemented");
        drop(next);
        assert_eq!(h.shutdown(), Err(PipeError::Broker));
    }

    #[test]
    fn a_gone_pump_stops_the_server_instead_of_answering_blindly() {
        let mut h = Harness::new();
        let client = h.client();
        client.write(&delivery(TICKET, "row-1"));
        assert_eq!(client.read()["result"], "accepted");
        drop(client);
        h.link_tx = None;
        let bridge = h.bridge.take().unwrap();
        assert_eq!(h.rt.block_on(bridge).unwrap(), BridgeOutcome::LinkGone);
        // Either the loop already noticed and exited, or it is still in accept; a call it cannot
        // answer must end it, never produce an `accepted` reply from a slot nobody owns.
        if let Some(client) = Client::try_connect(&h.name, Duration::from_millis(300)) {
            if let Some(hello) = client.try_read() {
                let _ = client.try_write(&client_hello(&hello["nonce"], "shell"));
                let _ = client.try_write(&delivery(TICKET, "row-2"));
            }
        }
        let server = h.server.take().unwrap();
        assert_eq!(
            server.join().expect("server thread panicked"),
            Err(PipeError::Broker)
        );
    }
}
