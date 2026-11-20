//! The ticket pump between the shell pipe and the live link (device-design §2.2, §1; GW18).
//!
//! GW17 landed the two halves separately: the Broker's single-use ticket slot
//! ([`crate::ipc::ticket`]) and the A1 link ([`crate::transport::link::Link`]), with nothing
//! connecting them. This module is that connection, and it is deliberately the ONLY new state:
//! the sync core keeps its blocking shape and the link keeps its channel signature.
//!
//! Why a pump and not a queue. A device-session ticket is single-use with a 60s TTL, and
//! `work.activate_device_session` always mints a new session, so the link needs exactly one fresh
//! ticket per dial attempt. Withdrawing one when the shell happens to deliver it would burn or
//! expire tickets the link does not need yet — `ipc::ticket` already records that the Broker never
//! queues ahead of need. So the slot is withdrawn from ONLY while a link request is outstanding:
//! the link emits [`LinkEvent::AwaitingTicket`] when it is about to wait with an empty ticket
//! channel, and the pump satisfies that request either immediately (a ticket is pending) or when
//! the next delivery arrives.
//!
//! Single ownership, no lock. The pump is one async task that owns the `TicketSlot`; the Windows
//! pipe loop (`ipc::service`) is a blocking thread that hands over already-framed messages and
//! waits for the closed reply. Validation is not duplicated: the pump calls
//! [`crate::ipc::ticket::deliver_message`], the one closure-then-slot entry the design names.
//!
//! Scope (GW18, ruled): the ticket path only. Every other link event is forwarded to the core
//! VERBATIM — no downlink is verified, journaled or dispatched here. A2 consumption stays deferred
//! because the device side has no sync core yet, so a downlink router would have no caller.
//!
//! GW21 widens the OWNERSHIP, not the downlink scope. §2.1's Broker side (the CNG key, the two
//! purpose-specific signing requests, the issued certificate) had no carrier in the closed IPC set
//! and no owner anywhere. Rather than add a second dispatcher — which would mean two owners of
//! Broker state and force a lock, breaking the single-ownership rule above — the same task now owns
//! the [`Identity`] alongside the slot and routes by method. The downlink boundary is unchanged:
//! every link event other than `AwaitingTicket` is still forwarded verbatim, and nothing here
//! verifies, journals or dispatches a command.
//!
//! The link cannot be built before a certificate exists ([`ClientIdentity`] is a closed enum with
//! no identity-less variant), so the pump does not own the link's lifecycle. On every successful
//! certificate delivery it publishes a [`ReadyIdentity`] and the entry decides whether to start or
//! restart the link. That keeps the pump's state exclusive and the link's restart policy visible in
//! one place.

use std::time::Instant;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::identity::{Identity, IdentityError};
use crate::ipc::dispatch::{delivery_code, identity_code, Reply};
use crate::ipc::ticket::{self, TicketSlot};
use crate::transport::{ClientIdentity, LinkEvent};

/// A certificate-backed identity the entry can dial with. Published after every successful
/// delivery, including a renewal replacement, so the entry can restart the link on the new chain.
#[derive(Clone, Debug)]
pub struct ReadyIdentity {
    /// The device id adopted from the CA-signed certificate's CN.
    pub device_id: String,
    /// The org bound by signing/re-delivery (certificate OU). The sync core's permit identity
    /// gate reads this (F5 甲).
    pub org_id: String,
    /// The subject bound by signing/re-delivery. The certificate carries no subject, so this is
    /// the permit identity gate's `subject_id` anchor (F5 甲).
    pub subject_id: String,
    /// The CNG-bound client identity (Windows production shape).
    pub identity: ClientIdentity,
}

/// One framed shell message plus the channel the pipe loop waits on for its reply.
pub struct DeliveryRequest {
    /// The decoded JSON message, not yet validated: the pump runs the whole closure.
    pub message: Value,
    /// The closed reply. Dropping it without sending is a pipe-loop error, not a silent accept.
    pub reply: oneshot::Sender<Reply>,
}

/// Why the pump stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BridgeOutcome {
    /// The link reported [`LinkEvent::Stopped`].
    LinkStopped,
    /// The link's event channel closed, or it stopped reading tickets: there is no link to serve.
    LinkGone,
    /// The core stopped reading forwarded events.
    CoreGone,
    /// The shell pipe is gone AND no ticket can satisfy the outstanding request, so the link
    /// could wait forever. The caller decides whether to stop the link; the pump does not.
    ShellGone,
}

/// What one withdrawal attempt achieved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pump {
    /// A ticket was withdrawn and handed to the link; the request is satisfied.
    Supplied,
    /// Nothing spendable is pending, or no request is outstanding. The request stays as it was.
    Waiting,
    /// The link is no longer reading tickets.
    LinkGone,
}

/// Run the pump until the link, the core or the shell ends it.
///
/// `deliveries` comes from the pipe loop, `link_events` from the link, `tickets` goes back to the
/// link, and `core_events` carries every event the pump does not consume. The pump consumes ONLY
/// [`LinkEvent::AwaitingTicket`]; forwarding it would make the core treat a normal wait as a
/// failure (the GW17 probe does exactly that). `ready` publishes a certificate-backed identity
/// whenever one is successfully delivered.
///
/// Backpressure is intentional: if the core stops reading `core_events`, the pump blocks and the
/// pipe loop's reply waits with it. Nothing is dropped to keep the pipe moving.
#[allow(clippy::too_many_arguments)]
pub async fn run_core_pump(
    mut identity: Identity,
    mut slot: TicketSlot,
    mut deliveries: mpsc::Receiver<DeliveryRequest>,
    mut link_events: mpsc::Receiver<LinkEvent>,
    tickets: mpsc::Sender<String>,
    core_events: mpsc::Sender<LinkEvent>,
    ready: mpsc::Sender<ReadyIdentity>,
    #[cfg(windows)] node_service: mpsc::Sender<crate::nodeservice::NodeRequest>,
) -> BridgeOutcome {
    let mut awaiting = false;
    let mut deliveries_open = true;
    loop {
        tokio::select! {
            request = deliveries.recv(), if deliveries_open => {
                match request {
                    Some(request) => {
                        let method = request.message.get("method").and_then(Value::as_str).unwrap_or("");
                        // The §4.2/§5.4 confirmation carriers and §1.1 stageLocalInput are forwarded to
                        // the Node service thread that owns the registries/executor (the `!Send` handles
                        // and sealed bodies stay there); every other core method is answered from the
                        // identity/slot this task owns.
                        let reply = if CONFIRMATION_METHODS.contains(&method) || method == "stageLocalInput" {
                            #[cfg(windows)]
                            { confirmation_reply(&node_service, &request.message).await }
                            #[cfg(not(windows))]
                            { Reply::refused(&request.message, "method_not_implemented") }
                        } else {
                            handle_message(&mut identity, &mut slot, awaiting, &request.message)
                        };
                        // A dropped reply means the pipe client went away mid-call. The state has
                        // already recorded the delivery, which is the honest outcome: the ticket
                        // is pending whether or not the shell stayed to hear about it.
                        let _ = request.reply.send(reply);
                        // Published only after a delivery actually held a certificate, so the
                        // entry never dials with an identity the Broker refused.
                        if let (Some(device_id), Ok(link_identity)) =
                            (identity.device_id(), identity.link_identity())
                        {
                            if matches!(
                                request.message.get("method").and_then(Value::as_str),
                                Some("deliverDeviceCertificate" | "redeliverDeviceCertificate")
                            ) {
                                let _ = ready
                                    .send(ReadyIdentity {
                                        device_id: device_id.to_string(),
                                        org_id: identity.signed_org().unwrap_or("").to_string(),
                                        subject_id: identity.signed_subject().unwrap_or("").to_string(),
                                        identity: link_identity,
                                    })
                                    .await;
                            }
                        }
                        if awaiting {
                            // This arm only runs while the delivery channel is open (the select
                            // guard), so a failed withdrawal just leaves the request outstanding.
                            if withdraw(&mut slot, &tickets, &mut awaiting, Instant::now()).await
                                == Pump::LinkGone
                            {
                                return BridgeOutcome::LinkGone;
                            }
                        }
                    }
                    None => {
                        // The shell pipe is gone. Keep serving a live session — heartbeats and
                        // downlinks must not stop just because no new ticket can arrive — but stop
                        // polling a closed channel, which would otherwise spin this loop.
                        deliveries_open = false;
                        if awaiting && !slot.has_live_ticket(Instant::now()) {
                            return BridgeOutcome::ShellGone;
                        }
                    }
                }
            }
            event = link_events.recv() => {
                match event {
                    Some(LinkEvent::AwaitingTicket) => {
                        awaiting = true;
                        match withdraw(&mut slot, &tickets, &mut awaiting, Instant::now()).await {
                            Pump::LinkGone => return BridgeOutcome::LinkGone,
                            Pump::Waiting if !deliveries_open => return BridgeOutcome::ShellGone,
                            _ => {}
                        }
                    }
                    Some(LinkEvent::Stopped) => {
                        let _ = core_events.send(LinkEvent::Stopped).await;
                        return BridgeOutcome::LinkStopped;
                    }
                    Some(other) => {
                        if core_events.send(other).await.is_err() {
                            return BridgeOutcome::CoreGone;
                        }
                    }
                    None => return BridgeOutcome::LinkGone,
                }
            }
        }
    }
}

/// Route one already-closure-checked shell message to the state that owns it, and build the closed
/// reply. The pipe loop never validates a payload itself, so this is the single place a method's
/// key set is enforced.
fn handle_message(
    identity: &mut Identity,
    slot: &mut TicketSlot,
    awaiting: bool,
    message: &Value,
) -> Reply {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if method == ticket::METHOD {
        return match ticket::deliver_message(slot, message, Instant::now()) {
            Ok(()) => Reply::accepted(message),
            Err(err) => Reply::refused(message, delivery_code(err)),
        };
    }

    let fields: &[&str] = match method {
        "getDeviceIdentity" | "getDeviceCertificateStatus" => &[],
        "signDevicePairing" | "signDeviceCertificateRenewal" => {
            &["pairing_id", "challenge", "org_id", "subject_id"]
        }
        "deliverDeviceCertificate" => &["device_id", "certificate_pem"],
        "redeliverDeviceCertificate" => &["device_id", "certificate_pem", "org_id", "subject_id"],
        // classify() only forwards CORE_METHODS, so this is unreachable; answering with a closed
        // code keeps the pipe moving instead of panicking inside the pump.
        _ => return Reply::refused(message, "unknown_method"),
    };
    if let Err(err) = closed_fields(message, fields) {
        return Reply::refused(message, identity_code(err));
    }
    let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or("");

    match method {
        "getDeviceIdentity" => {
            let jwk = serde_json::to_value(identity.public_jwk()).unwrap_or(Value::Null);
            Reply::accepted_with(
                message,
                json!({
                    "public_key_jwk": jwk,
                    "public_key_thumbprint": identity.thumbprint(),
                    "container": identity.container(),
                }),
            )
        }
        "signDevicePairing" | "signDeviceCertificateRenewal" => {
            let result = if method == "signDevicePairing" {
                identity.sign_pairing(
                    text("pairing_id"),
                    text("challenge"),
                    text("org_id"),
                    text("subject_id"),
                )
            } else {
                identity.sign_renewal(
                    text("pairing_id"),
                    text("challenge"),
                    text("org_id"),
                    text("subject_id"),
                )
            };
            match result {
                Ok(signature) => Reply::accepted_with(message, json!({ "signature": signature })),
                Err(err) => Reply::refused(message, identity_code(err)),
            }
        }
        "deliverDeviceCertificate" | "redeliverDeviceCertificate" => {
            let result = if method == "deliverDeviceCertificate" {
                identity.deliver_certificate(text("device_id"), text("certificate_pem"))
            } else {
                identity.redeliver_certificate(
                    text("device_id"),
                    text("certificate_pem"),
                    text("org_id"),
                    text("subject_id"),
                )
            };
            match result {
                Ok(()) => {
                    // The slot is keyed by the device id, which the Broker only learns from the
                    // CA-signed CN. Re-key it on the first delivery so a ticket for this device is
                    // no longer refused as foreign; a renewal keeps the same id and must not reset
                    // the consumed set.
                    if let Some(device_id) = identity.device_id() {
                        if slot.device_id() != device_id {
                            *slot = TicketSlot::new(device_id);
                        }
                    }
                    let held = identity.certificate();
                    Reply::accepted_with(
                        message,
                        json!({
                            "cert_serial": held.map(|c| c.serial.clone()).unwrap_or_default(),
                            "cert_not_after": held
                                .and_then(|c| c.not_after_rfc3339())
                                .unwrap_or_default(),
                        }),
                    )
                }
                Err(err) => Reply::refused(message, identity_code(err)),
            }
        }
        "getDeviceCertificateStatus" => {
            let held = identity.certificate();
            Reply::accepted_with(
                message,
                json!({
                    "has_certificate": held.is_some(),
                    "device_id": identity.device_id().map(Value::from).unwrap_or(Value::Null),
                    "cert_serial": held.map(|c| Value::from(c.serial.clone())).unwrap_or(Value::Null),
                    "cert_not_after": held
                        .and_then(|c| c.not_after_rfc3339())
                        .map(Value::from)
                        .unwrap_or(Value::Null),
                    "renewal_window_open": held
                        .map(|c| c.renewal_window_open(std::time::SystemTime::now()))
                        .unwrap_or(false),
                    // M2 ruling 甲: the shell mints a ticket only when the link is waiting for
                    // one. The pump's own outstanding-request flag is the authority — reporting
                    // the slot's contents instead would say "pending" for a ticket nobody asked
                    // for and hide a reconnect that needs a fresh one.
                    "awaiting_ticket": awaiting,
                }),
            )
        }
        _ => Reply::refused(message, "unknown_method"),
    }
}

/// Enforce one method's closed key set: exactly `method`, `request_id` and the named payload
/// fields, every value a string, every payload field non-empty. An unlisted key is a refusal, not
/// something the handler ignores — the same rule the REST DTOs follow.
fn closed_fields(message: &Value, fields: &[&str]) -> Result<(), IdentityError> {
    let object = message.as_object().ok_or(IdentityError::Schema)?;
    let mut allowed: Vec<&str> = vec!["method", "request_id"];
    allowed.extend_from_slice(fields);
    if object.len() != allowed.len() || !object.keys().all(|k| allowed.contains(&k.as_str())) {
        return Err(IdentityError::Schema);
    }
    for key in allowed {
        if !object.get(key).map(Value::is_string).unwrap_or(false) {
            return Err(IdentityError::Schema);
        }
    }
    for key in fields {
        if object
            .get(*key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        {
            return Err(IdentityError::Shape);
        }
    }
    Ok(())
}

/// The §4.2/§5.4 confirmation carriers the pump forwards to the Node service thread (批2 主签单选乙).
/// `chooseWorkspace`/`probeLocalModel` prepare; `confirmWorkspaceRoot`/`confirmLocalModel` carry the
/// user's confirm/cancel decision back. The handle/identity stays on the Node thread; only owned
/// (Send) facts and the decision cross the channel.
const CONFIRMATION_METHODS: &[&str] = &[
    "chooseWorkspace",
    "confirmWorkspaceRoot",
    "probeLocalModel",
    "confirmLocalModel",
];

/// Forward one confirmation message to the Node service thread and build the closed reply. The
/// prepare methods return the confirmation facts plus a single-use token; the confirm methods return
/// the registered grant/binding hash on approve, or an accepted no-facts reply on cancel (no grant).
/// A bind/probe/identity failure is a closed `shape` refusal — the Broker could not bind/probe the
/// target — never a silent accept. Schema (key-set/type) violations are `schema`.
#[cfg(windows)]
async fn confirmation_reply(
    node: &mpsc::Sender<crate::nodeservice::NodeRequest>,
    message: &Value,
) -> Reply {
    use crate::nodeservice::NodeRequest;

    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or("");
    match method {
        "chooseWorkspace" => {
            if let Err(code) = confirm_keys(message, &["selected_path"]) {
                return Reply::refused(message, code);
            }
            let selected_path = text("selected_path");
            if selected_path.is_empty() {
                return Reply::refused(message, "shape");
            }
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::PrepareRoot {
                    selected_path: selected_path.to_string(),
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Reply::refused(message, "shape");
            }
            match rx.await {
                Ok(Ok((token, c))) => Reply::accepted_with(
                    message,
                    json!({
                        "confirmation_token": token,
                        "selected_path": c.selected_path,
                        "actual_location": c.actual_location,
                        "volume_label": c.volume_label,
                        "differs_from_selected": c.differs_from_selected,
                        "other_user_writable": c.other_user_writable,
                    }),
                ),
                _ => Reply::refused(message, "shape"),
            }
        }
        "confirmWorkspaceRoot" => {
            if let Err(code) = confirm_keys(
                message,
                &["confirmation_token", "grant_id", "artifact_dir", "approved"],
            ) {
                return Reply::refused(message, code);
            }
            let token = text("confirmation_token");
            let grant_id = text("grant_id");
            let approved = match message.get("approved").and_then(Value::as_bool) {
                Some(b) => b,
                None => return Reply::refused(message, "schema"),
            };
            let artifact_dir = match string_array(message.get("artifact_dir")) {
                Some(v) => v,
                None => return Reply::refused(message, "schema"),
            };
            if token.is_empty() || grant_id.is_empty() {
                return Reply::refused(message, "shape");
            }
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::ConfirmRoot {
                    token: token.to_string(),
                    grant_id: grant_id.to_string(),
                    artifact_dir,
                    approved,
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Reply::refused(message, "shape");
            }
            match rx.await {
                Ok(Some(hash)) => Reply::accepted_with(
                    message,
                    json!({ "grant_id": grant_id, "root_identity_hash": hash }),
                ),
                // Cancel, or a token already spent: either way no grant exists. The token is
                // single-use (the Node thread removes it), so a replay produces no grant.
                Ok(None) => Reply::accepted(message),
                Err(_) => Reply::refused(message, "shape"),
            }
        }
        "probeLocalModel" => {
            if let Err(code) = confirm_keys(message, &["port"]) {
                return Reply::refused(message, code);
            }
            let port = match parse_port(text("port")) {
                Some(p) => p,
                None => return Reply::refused(message, "shape"),
            };
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::PrepareModel { port, reply: tx })
                .await
                .is_err()
            {
                return Reply::refused(message, "shape");
            }
            match rx.await {
                Ok(Ok((token, c))) => Reply::accepted_with(
                    message,
                    json!({
                        "confirmation_token": token,
                        "process_name": c.process_name,
                        "image_path": c.image_path,
                        "signer_thumbprint": c.signer_thumbprint.map(Value::from).unwrap_or(Value::Null),
                        "owner_sid": hex_encode(&c.owner_sid),
                        "image_sha256": c.image_sha256,
                        "listens_on_all_interfaces": c.listens_on_all_interfaces,
                    }),
                ),
                _ => Reply::refused(message, "shape"),
            }
        }
        "confirmLocalModel" => {
            if let Err(code) = confirm_keys(
                message,
                &[
                    "confirmation_token",
                    "profile_id",
                    "port",
                    "listener_requirement",
                    "approved",
                ],
            ) {
                return Reply::refused(message, code);
            }
            let token = text("confirmation_token");
            let profile_id = text("profile_id");
            let approved = match message.get("approved").and_then(Value::as_bool) {
                Some(b) => b,
                None => return Reply::refused(message, "schema"),
            };
            let port = match parse_port(text("port")) {
                Some(p) => p,
                None => return Reply::refused(message, "shape"),
            };
            let requirement = match parse_requirement(message.get("listener_requirement")) {
                Some(r) => r,
                None => return Reply::refused(message, "schema"),
            };
            if token.is_empty() || profile_id.is_empty() {
                return Reply::refused(message, "shape");
            }
            // The Broker is the current-user authority for the §5.4 owner_sid comparison; if its own
            // SID is unreadable the binding cannot be verified, so refuse rather than guess.
            let current_user_sid = match crate::listener::current_user_sid() {
                Ok(sid) => sid,
                Err(_) => return Reply::refused(message, "shape"),
            };
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::ConfirmModel {
                    token: token.to_string(),
                    profile_id: profile_id.to_string(),
                    port,
                    requirement,
                    current_user_sid,
                    approved,
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Reply::refused(message, "shape");
            }
            match rx.await {
                Ok(Some(Ok(hash))) => Reply::accepted_with(
                    message,
                    json!({ "profile_id": profile_id, "binding_hash": hash }),
                ),
                // identity_mismatch / unpublishable requirement: the binding did not verify.
                Ok(Some(Err(_))) => Reply::refused(message, "shape"),
                Ok(None) => Reply::accepted(message),
                Err(_) => Reply::refused(message, "shape"),
            }
        }
        "stageLocalInput" => {
            // §1.1: the shell exchanges the Composer目标文本 for a local_input_ref + metadata, then
            // clears the text. The bytes are sealed on the Node thread; only the ref/hash/size cross back.
            if let Err(code) = confirm_keys(message, &["text"]) {
                return Reply::refused(message, code);
            }
            let text = text("text");
            if text.is_empty() {
                return Reply::refused(message, "shape");
            }
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::StageInput {
                    text: text.to_string(),
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Reply::refused(message, "shape");
            }
            match rx.await {
                Ok((input_ref, content_hash, byte_count)) => Reply::accepted_with(
                    message,
                    json!({
                        "local_input_ref": input_ref,
                        "content_hash": content_hash,
                        "byte_count": byte_count.to_string(),
                    }),
                ),
                Err(_) => Reply::refused(message, "shape"),
            }
        }
        _ => Reply::refused(message, "unknown_method"),
    }
}

/// Enforce a confirmation method's closed key set: exactly `method`, `request_id` and the named
/// payload fields. Unlike [`closed_fields`] this does NOT require every value to be a string —
/// `approved` is a bool, `artifact_dir` an array, `listener_requirement` an object — so types are
/// checked per-field in the handler. An unlisted or missing key is a `schema` refusal.
fn confirm_keys(message: &Value, fields: &[&str]) -> Result<(), &'static str> {
    let object = message.as_object().ok_or("schema")?;
    let mut allowed: Vec<&str> = vec!["method", "request_id"];
    allowed.extend_from_slice(fields);
    if object.len() != allowed.len() || !object.keys().all(|k| allowed.contains(&k.as_str())) {
        return Err("schema");
    }
    Ok(())
}

/// A JSON array of non-empty strings (the artifact dir's relative segments), or None.
fn string_array(value: Option<&Value>) -> Option<Vec<String>> {
    let arr = value?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let s = item.as_str()?;
        if s.is_empty() {
            return None;
        }
        out.push(s.to_string());
    }
    Some(out)
}

/// A loopback port as a decimal string (the wire convention for integers), 1..=65535.
fn parse_port(text: &str) -> Option<u16> {
    let port: u16 = text.parse().ok()?;
    if port == 0 {
        None
    } else {
        Some(port)
    }
}

/// The closed `listener_requirement` object: allowed_signers (string array), allow_user_pinned_hash
/// (bool), allowed_service_sids (hex-string array). Three-empty is legal here but the Node thread's
/// `confirm` refuses to publish it (§5.4 step 5).
#[cfg(windows)]
fn parse_requirement(value: Option<&Value>) -> Option<crate::listener::ListenerRequirement> {
    let obj = value?.as_object()?;
    let mut allowed: Vec<&str> = vec![
        "allowed_signers",
        "allow_user_pinned_hash",
        "allowed_service_sids",
    ];
    allowed.sort_unstable();
    let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    if keys != allowed {
        return None;
    }
    let allowed_signers = string_array(obj.get("allowed_signers"))?;
    let allow_user_pinned_hash = obj.get("allow_user_pinned_hash")?.as_bool()?;
    let sid_strings = string_array(obj.get("allowed_service_sids"))?;
    let mut allowed_service_sids = Vec::with_capacity(sid_strings.len());
    for s in sid_strings {
        allowed_service_sids.push(hex_decode(&s)?);
    }
    Some(crate::listener::ListenerRequirement {
        allowed_signers,
        allow_user_pinned_hash,
        allowed_service_sids,
    })
}

/// Lowercase hex encoding of a SID byte buffer (the wire form for binary identity facts).
#[cfg(windows)]
fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Decode a lowercase/uppercase hex string into bytes, or None on odd length / non-hex.
#[cfg(windows)]
fn hex_decode(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

/// Withdraw one ticket for the outstanding request, if the slot has one. The `awaiting` guard is
/// what keeps a single-use ticket from being spent ahead of need: without a request this never
/// touches the slot. `now` is a parameter so the expiry path is testable without waiting out the
/// real 60s holding window.
async fn withdraw(
    slot: &mut TicketSlot,
    tickets: &mpsc::Sender<String>,
    awaiting: &mut bool,
    now: Instant,
) -> Pump {
    if !*awaiting {
        return Pump::Waiting;
    }
    match slot.take(now) {
        Ok(ticket) => {
            if tickets.send(ticket).await.is_err() {
                return Pump::LinkGone;
            }
            *awaiting = false;
            Pump::Supplied
        }
        // Empty or Expired: the link keeps waiting. An expired pending id was already retired into
        // the consumed set by `prune`, so the shell's next re-delivery of it is refused explicitly
        // with `already_consumed` rather than silently starting a fresh holding window.
        Err(_) => Pump::Waiting,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::envelope::Envelope;
    use crate::ipc::dispatch::{ACCEPTED, REFUSED};
    use crate::ipc::ticket::{TicketError, TICKET_TTL};
    use crate::key::{DeviceKey, SoftwareKey};
    use crate::permit::lease::LeaseMode;
    use crate::transport::{HelloAck, LeaseLoss, LeaseState};
    use serde_json::json;
    use std::time::Duration;

    const TICKET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OTHER: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    fn delivery(ticket: &str, row: &str) -> Value {
        json!({
            "method": ticket::METHOD,
            "request_id": "req-1",
            "ticket": ticket,
            "device_id": "dev-1",
            "session_ticket_id": row,
        })
    }

    /// A pump plus the four channel ends a caller needs. The link side stays manual so a test
    /// decides exactly when the link asks for a ticket. Ends are `Option` so a test can close one
    /// without partially moving the harness.
    struct Harness {
        deliveries: Option<mpsc::Sender<DeliveryRequest>>,
        link_events: Option<mpsc::Sender<LinkEvent>>,
        tickets: Option<mpsc::Receiver<String>>,
        core_events: Option<mpsc::Receiver<LinkEvent>>,
        ready: Option<mpsc::Receiver<ReadyIdentity>>,
        handle: tokio::task::JoinHandle<BridgeOutcome>,
    }

    impl Harness {
        fn new() -> Self {
            let (delivery_tx, delivery_rx) = mpsc::channel(4);
            let (link_tx, link_rx) = mpsc::channel(8);
            let (ticket_tx, ticket_rx) = mpsc::channel(1);
            let (core_tx, core_rx) = mpsc::channel(8);
            let (ready_tx, ready_rx) = mpsc::channel(4);
            let handle = tokio::spawn(run_core_pump(
                crate::identity::test_identity(),
                TicketSlot::new("dev-1"),
                delivery_rx,
                link_rx,
                ticket_tx,
                core_tx,
                ready_tx,
                #[cfg(windows)]
                crate::nodeservice::spawn_node_service(),
            ));
            Self {
                deliveries: Some(delivery_tx),
                link_events: Some(link_tx),
                tickets: Some(ticket_rx),
                core_events: Some(core_rx),
                ready: Some(ready_rx),
                handle,
            }
        }

        /// Deliver one message and return the closed reply the pipe loop would write.
        async fn deliver(&mut self, message: Value) -> Reply {
            let (reply_tx, reply_rx) = oneshot::channel();
            self.deliveries
                .as_ref()
                .expect("shell pipe is open")
                .send(DeliveryRequest {
                    message,
                    reply: reply_tx,
                })
                .await
                .unwrap();
            reply_rx.await.unwrap()
        }

        async fn ask(&mut self) {
            self.link_events
                .as_ref()
                .expect("link is running")
                .send(LinkEvent::AwaitingTicket)
                .await
                .unwrap();
        }

        async fn send_event(&mut self, event: LinkEvent) {
            self.link_events
                .as_ref()
                .expect("link is running")
                .send(event)
                .await
                .unwrap();
        }

        /// The next ticket the link received, or None if the pump supplied nothing.
        async fn next_ticket(&mut self) -> Option<String> {
            let rx = self.tickets.as_mut().expect("link reads tickets");
            tokio::time::timeout(Duration::from_millis(200), rx.recv())
                .await
                .ok()
                .flatten()
        }

        async fn next_core_event(&mut self) -> LinkEvent {
            let rx = self.core_events.as_mut().expect("core reads events");
            tokio::time::timeout(Duration::from_millis(500), rx.recv())
                .await
                .expect("the pump forwarded nothing in time")
                .expect("core event channel closed")
        }

        fn close_shell(&mut self) {
            self.deliveries = None;
        }

        fn close_link(&mut self) {
            self.link_events = None;
        }

        fn close_tickets(&mut self) {
            self.tickets = None;
        }

        fn close_core(&mut self) {
            self.core_events = None;
        }

        async fn outcome(self) -> BridgeOutcome {
            self.handle.await.unwrap()
        }

        /// End the link side only. Closing the shell at the same instant would make the outcome a
        /// race between two true facts (LinkGone / ShellGone); the link is the one under test here.
        async fn finish(mut self) -> BridgeOutcome {
            self.link_events = None;
            self.handle.await.unwrap()
        }
    }

    #[tokio::test]
    async fn a_delivery_without_a_request_leaves_the_ticket_pending() {
        let mut h = Harness::new();
        let reply = h.deliver(delivery(TICKET, "row-1")).await;
        assert_eq!(reply.result, "accepted");
        assert_eq!(reply.code, None);
        assert_eq!(reply.request_id, "req-1");
        // Nothing was withdrawn: the link never asked, so spending it now would burn a single-use
        // ticket or let it expire in the channel.
        assert_eq!(h.next_ticket().await, None);
        // The request that comes later is satisfied from the pending slot.
        h.ask().await;
        assert_eq!(h.next_ticket().await.as_deref(), Some(TICKET));
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_request_without_a_ticket_is_satisfied_by_the_next_delivery() {
        let mut h = Harness::new();
        h.ask().await;
        assert_eq!(h.next_ticket().await, None);
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.result,
            "accepted"
        );
        assert_eq!(h.next_ticket().await.as_deref(), Some(TICKET));
        // The request is satisfied, so a second delivery stays pending instead of being pushed.
        assert_eq!(h.deliver(delivery(OTHER, "row-2")).await.result, "accepted");
        assert_eq!(h.next_ticket().await, None);
        h.ask().await;
        assert_eq!(h.next_ticket().await.as_deref(), Some(OTHER));
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn each_dial_attempt_gets_a_fresh_ticket_and_never_the_same_one_twice() {
        let mut h = Harness::new();
        for (index, ticket) in [TICKET, OTHER].iter().enumerate() {
            h.ask().await;
            let row = format!("row-{index}");
            assert_eq!(h.deliver(delivery(ticket, &row)).await.result, "accepted");
            assert_eq!(h.next_ticket().await.as_deref(), Some(*ticket));
        }
        // A third attempt with no new delivery gets nothing: both ids are consumed and the slot is
        // empty, so the pump waits rather than re-supplying a spent ticket.
        h.ask().await;
        assert_eq!(h.next_ticket().await, None);
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_refused_delivery_never_reaches_the_link() {
        let mut h = Harness::new();
        h.ask().await;
        let mut message = delivery(TICKET, "row-1");
        message["device_id"] = json!("dev-2");
        assert_eq!(h.deliver(message).await.code, Some("foreign_device"));
        assert_eq!(h.next_ticket().await, None);

        let mut message = delivery(TICKET, "row-1");
        message["url"] = json!("https://example.test");
        assert_eq!(h.deliver(message).await.code, Some("schema"));
        assert_eq!(h.next_ticket().await, None);

        assert_eq!(
            h.deliver(delivery("not-hex", "row-1")).await.code,
            Some("shape")
        );
        assert_eq!(h.next_ticket().await, None);

        // The outstanding request survived every refusal: a good delivery satisfies it.
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.result,
            "accepted"
        );
        assert_eq!(h.next_ticket().await.as_deref(), Some(TICKET));
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_spent_ticket_id_is_refused_on_re_delivery() {
        let mut h = Harness::new();
        h.ask().await;
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.result,
            "accepted"
        );
        assert_eq!(h.next_ticket().await.as_deref(), Some(TICKET));
        // The mint returns null on replay (0040:1429), so re-handing the spent id is pointless.
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.code,
            Some("already_consumed")
        );
        h.ask().await;
        assert_eq!(h.next_ticket().await, None);
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn an_expired_pending_ticket_is_not_supplied_and_cannot_be_revived() {
        // Drive the withdrawal at an instant past the holding window: the pump must supply nothing
        // and must leave the request outstanding, and the expired id must be retired so the shell
        // cannot revive it by re-handing it.
        let start = Instant::now();
        let late = start + TICKET_TTL + Duration::from_secs(1);
        let mut slot = TicketSlot::new("dev-1");
        ticket::deliver_message(&mut slot, &delivery(TICKET, "row-1"), start).unwrap();
        let (ticket_tx, mut ticket_rx) = mpsc::channel(1);
        let mut awaiting = true;
        assert_eq!(
            withdraw(&mut slot, &ticket_tx, &mut awaiting, late).await,
            Pump::Waiting
        );
        assert!(
            awaiting,
            "an expired ticket must not clear the outstanding request"
        );
        assert!(ticket_rx.try_recv().is_err());
        assert_eq!(
            ticket::deliver_message(&mut slot, &delivery(TICKET, "row-1"), late),
            Err(TicketError::AlreadyConsumed)
        );
        // A fresh id is still spendable on the same outstanding request.
        assert_eq!(
            withdraw(&mut slot, &ticket_tx, &mut awaiting, late).await,
            Pump::Waiting
        );
        ticket::deliver_message(&mut slot, &delivery(OTHER, "row-2"), late).unwrap();
        assert_eq!(
            withdraw(&mut slot, &ticket_tx, &mut awaiting, late).await,
            Pump::Supplied
        );
        assert!(!awaiting);
        assert_eq!(ticket_rx.recv().await.as_deref(), Some(OTHER));
    }

    #[tokio::test]
    async fn withdraw_without_a_request_never_touches_the_slot() {
        let start = Instant::now();
        let mut slot = TicketSlot::new("dev-1");
        ticket::deliver_message(&mut slot, &delivery(TICKET, "row-1"), start).unwrap();
        let (ticket_tx, mut ticket_rx) = mpsc::channel(1);
        let mut awaiting = false;
        assert_eq!(
            withdraw(&mut slot, &ticket_tx, &mut awaiting, start).await,
            Pump::Waiting
        );
        assert!(ticket_rx.try_recv().is_err());
        // The ticket is still pending, not spent.
        assert!(slot.has_live_ticket(start));
        assert_eq!(slot.take(start).unwrap(), TICKET);
    }

    #[tokio::test]
    async fn every_other_link_event_is_forwarded_verbatim() {
        let mut h = Harness::new();
        let mut env = Envelope::new("command", "dev-1", json!({"command_id": "c-1"}));
        env.session_id = "sess-1".into();
        h.send_event(LinkEvent::Downlink(Box::new(env))).await;
        match h.next_core_event().await {
            LinkEvent::Downlink(got) => {
                assert_eq!(got.frame_type, "command");
                assert_eq!(got.session_id, "sess-1");
                assert_eq!(got.body["command_id"], "c-1");
            }
            other => panic!("expected a verbatim Downlink, got {other:?}"),
        }
        h.send_event(LinkEvent::LeasesInvalidated {
            ids: vec!["lease-1".into()],
            cause: LeaseLoss::SessionLost,
        })
        .await;
        match h.next_core_event().await {
            LinkEvent::LeasesInvalidated { ids, cause } => {
                assert_eq!(ids, vec!["lease-1".to_string()]);
                assert_eq!(cause, LeaseLoss::SessionLost);
            }
            other => panic!("expected LeasesInvalidated, got {other:?}"),
        }
        h.send_event(LinkEvent::Disconnected {
            reason: "stream lost".into(),
            attempt: 2,
        })
        .await;
        match h.next_core_event().await {
            LinkEvent::Disconnected { reason, attempt } => {
                assert_eq!(reason, "stream lost");
                assert_eq!(attempt, 2);
            }
            other => panic!("expected Disconnected, got {other:?}"),
        }
        // A downlink is NOT verified, journaled or dispatched here (A2 stays deferred), and no
        // ticket was withdrawn because the link never asked.
        assert_eq!(h.next_ticket().await, None);
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_session_established_event_reaches_the_core_with_both_keys() {
        let mut h = Harness::new();
        let ack = HelloAck {
            session_id: "sess-1".into(),
            server_time: "2026-11-17T05:30:52.123456+00:00".into(),
            generation: 7,
            lease_ttl: Duration::from_secs(30),
            heartbeat_interval: Duration::from_secs(10),
            resync_required: true,
            server_jwk: SoftwareKey::random().public_jwk(),
            permit_jwk: SoftwareKey::random().public_jwk(),
        };
        h.send_event(LinkEvent::SessionEstablished(Box::new(ack.clone())))
            .await;
        match h.next_core_event().await {
            LinkEvent::SessionEstablished(got) => {
                assert_eq!(got.session_id, "sess-1");
                assert_eq!(got.generation, 7);
                assert_eq!(got.server_jwk, ack.server_jwk);
                assert_eq!(got.permit_jwk, ack.permit_jwk);
                assert_ne!(got.server_jwk, got.permit_jwk);
            }
            other => panic!("expected SessionEstablished, got {other:?}"),
        }
        h.send_event(LinkEvent::LeaseRenewal(LeaseState {
            lease_id: "lease-1".into(),
            extended: true,
            fence: 2,
            mode: LeaseMode::Active,
            deadline: Instant::now(),
        }))
        .await;
        match h.next_core_event().await {
            LinkEvent::LeaseRenewal(state) => {
                assert_eq!(state.lease_id, "lease-1");
                assert!(state.extended);
                assert_eq!(state.fence, 2);
            }
            other => panic!("expected LeaseRenewal, got {other:?}"),
        }
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn awaiting_ticket_is_consumed_not_forwarded() {
        let mut h = Harness::new();
        h.ask().await;
        // The core must not see it: the GW17 probe treats AwaitingTicket as a failure, and a
        // normal wait for a shell-minted ticket is not a failure.
        let rx = h.core_events.as_mut().unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), rx.recv())
                .await
                .is_err(),
            "the pump forwarded a wait it should consume"
        );
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_stopped_link_stops_the_pump_and_reports_it() {
        let mut h = Harness::new();
        h.send_event(LinkEvent::Stopped).await;
        assert!(matches!(h.next_core_event().await, LinkEvent::Stopped));
        assert_eq!(h.outcome().await, BridgeOutcome::LinkStopped);
    }

    #[tokio::test]
    async fn a_closed_link_channel_stops_the_pump() {
        let mut h = Harness::new();
        h.close_link();
        assert_eq!(h.outcome().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_core_that_stops_reading_stops_the_pump() {
        let mut h = Harness::new();
        h.close_core();
        h.send_event(LinkEvent::Disconnected {
            reason: "x".into(),
            attempt: 1,
        })
        .await;
        assert_eq!(h.outcome().await, BridgeOutcome::CoreGone);
    }

    #[tokio::test]
    async fn a_link_that_stops_reading_tickets_stops_the_pump() {
        let mut h = Harness::new();
        h.ask().await;
        h.close_tickets();
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.result,
            "accepted"
        );
        assert_eq!(h.outcome().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn a_gone_shell_with_an_unsatisfiable_request_ends_the_pump() {
        let mut h = Harness::new();
        h.ask().await;
        h.close_shell();
        // No ticket can ever arrive, so waiting forever would hang the link's dial.
        assert_eq!(h.outcome().await, BridgeOutcome::ShellGone);
    }

    #[tokio::test]
    async fn a_gone_shell_still_serves_a_live_session() {
        let mut h = Harness::new();
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.result,
            "accepted"
        );
        h.close_shell();
        // A pending ticket is still spendable, and events keep flowing: losing the shell pipe must
        // not tear down a session that is already alive.
        h.ask().await;
        assert_eq!(h.next_ticket().await.as_deref(), Some(TICKET));
        h.send_event(LinkEvent::Disconnected {
            reason: "x".into(),
            attempt: 1,
        })
        .await;
        assert!(matches!(
            h.next_core_event().await,
            LinkEvent::Disconnected { .. }
        ));
        // But a later request that nothing can satisfy ends the pump instead of hanging.
        h.ask().await;
        assert_eq!(h.outcome().await, BridgeOutcome::ShellGone);
    }

    #[tokio::test]
    async fn a_closed_delivery_channel_does_not_spin_the_loop() {
        let mut h = Harness::new();
        h.close_shell();
        // With no outstanding request the pump stays alive and must still forward events promptly
        // rather than busy-looping on a closed receiver.
        for attempt in 1..=3 {
            h.send_event(LinkEvent::Disconnected {
                reason: "x".into(),
                attempt,
            })
            .await;
            match h.next_core_event().await {
                LinkEvent::Disconnected { attempt: got, .. } => assert_eq!(got, attempt),
                other => panic!("event {attempt} did not flow: {other:?}"),
            }
        }
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    // ---- GW21: the §2.1 identity methods the pump now owns ----

    async fn identity_data(h: &mut Harness) -> Value {
        let reply = h
            .deliver(json!({"method": "getDeviceIdentity", "request_id": "id-1"}))
            .await;
        assert_eq!(reply.result, ACCEPTED);
        let data = reply.data.expect("identity facts");
        let mut keys: Vec<&str> = data
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["container", "public_key_jwk", "public_key_thumbprint"]
        );
        data
    }

    #[tokio::test]
    async fn get_device_identity_returns_only_public_material() {
        let mut h = Harness::new();
        let data = identity_data(&mut h).await;
        let jwk = data["public_key_jwk"].as_object().unwrap();
        let mut keys: Vec<&str> = jwk.keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["crv", "kty", "x", "y"], "no private field may leave");
        assert_eq!(data["public_key_thumbprint"].as_str().unwrap().len(), 64);
    }

    #[tokio::test]
    async fn the_two_signing_methods_use_different_domains() {
        let mut h = Harness::new();
        let data = identity_data(&mut h).await;
        let thumbprint = data["public_key_thumbprint"].as_str().unwrap().to_string();
        let jwk = data["public_key_jwk"].clone();
        let body = |method: &str| {
            json!({
                "method": method, "request_id": "sig-1", "pairing_id": "pid",
                "challenge": "chal", "org_id": "org", "subject_id": "sub",
            })
        };
        let pair = h.deliver(body("signDevicePairing")).await;
        let renew = h.deliver(body("signDeviceCertificateRenewal")).await;
        assert_eq!(pair.result, ACCEPTED);
        assert_eq!(renew.result, ACCEPTED);
        let pair_sig = pair.data.unwrap()["signature"]
            .as_str()
            .unwrap()
            .to_string();
        let renew_sig = renew.data.unwrap()["signature"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(pair_sig, renew_sig);
        // Each signature verifies only under its own domain, over the same fields.
        let pair_covered = crate::pairing::covered_string("pid", "chal", &thumbprint, "org", "sub");
        let renew_covered =
            crate::certrenewal::covered_string("pid", "chal", &thumbprint, "org", "sub");
        let jwk = crate::jwk::validate_json(&jwk.to_string()).unwrap();
        assert!(crate::es256::verify(
            &jwk,
            pair_covered.as_bytes(),
            &pair_sig
        ));
        assert!(crate::es256::verify(
            &jwk,
            renew_covered.as_bytes(),
            &renew_sig
        ));
        assert!(!crate::es256::verify(
            &jwk,
            renew_covered.as_bytes(),
            &pair_sig
        ));
        assert!(!crate::es256::verify(
            &jwk,
            pair_covered.as_bytes(),
            &renew_sig
        ));
    }

    #[tokio::test]
    async fn an_unlisted_payload_field_is_refused_not_ignored() {
        let mut h = Harness::new();
        let reply = h
            .deliver(json!({
                "method": "signDevicePairing", "request_id": "sig-2", "pairing_id": "pid",
                "challenge": "chal", "org_id": "org", "subject_id": "sub", "extra": 1,
            }))
            .await;
        assert_eq!(reply.result, REFUSED);
        assert_eq!(reply.code, Some("schema"));
        assert!(reply.data.is_none(), "a refusal carries no facts");
    }

    #[tokio::test]
    async fn a_non_string_or_empty_payload_field_is_refused() {
        let mut h = Harness::new();
        for bad in [
            json!({"method": "signDevicePairing", "request_id": "r", "pairing_id": 7,
                   "challenge": "c", "org_id": "o", "subject_id": "s"}),
            json!({"method": "signDevicePairing", "request_id": "r", "pairing_id": "",
                   "challenge": "c", "org_id": "o", "subject_id": "s"}),
        ] {
            let reply = h.deliver(bad).await;
            assert_eq!(reply.result, REFUSED);
            assert!(matches!(reply.code, Some("schema") | Some("shape")));
        }
    }

    #[tokio::test]
    async fn a_certificate_before_any_signing_is_no_pairing_and_publishes_nothing() {
        let mut h = Harness::new();
        let reply = h
            .deliver(json!({
                "method": "deliverDeviceCertificate", "request_id": "cert-1",
                "device_id": "dev-1",
                "certificate_pem": "-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n",
            }))
            .await;
        assert_eq!(reply.result, REFUSED);
        assert_eq!(reply.code, Some("no_pairing"));
        assert!(
            h.ready.as_mut().unwrap().try_recv().is_err(),
            "a refused delivery must not publish an identity the entry could dial with"
        );
    }

    #[tokio::test]
    async fn redelivery_without_signing_history_runs_the_chain_gates_not_the_signed_org_gate() {
        let mut h = Harness::new();
        // The restart path: a fresh pump has signed nothing, yet the stored chain must reach the
        // certificate gates themselves. A chain that fails them is certificate_invalid, never
        // no_pairing, and publishes nothing.
        let reply = h
            .deliver(json!({
                "method": "redeliverDeviceCertificate", "request_id": "cert-r1",
                "device_id": "dev-1",
                "certificate_pem": "-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n",
                "org_id": "org-1",
                "subject_id": "sub-1",
            }))
            .await;
        assert_eq!(reply.result, REFUSED);
        assert_eq!(reply.code, Some("certificate_invalid"));
        assert!(
            h.ready.as_mut().unwrap().try_recv().is_err(),
            "a refused re-delivery must not publish an identity the entry could dial with"
        );
    }

    #[tokio::test]
    async fn redelivery_payload_is_closed_about_the_org_and_subject_declarations() {
        let mut h = Harness::new();
        let pem = "-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\n";
        // Missing org_id: the declaration is mandatory, not optional.
        let reply = h
            .deliver(json!({
                "method": "redeliverDeviceCertificate", "request_id": "cert-r2",
                "device_id": "dev-1", "certificate_pem": pem, "subject_id": "sub-1",
            }))
            .await;
        assert_eq!(reply.result, REFUSED);
        assert!(matches!(reply.code, Some("schema") | Some("shape")));
        // Missing subject_id (F5 甲): the permit identity anchor is mandatory too.
        let reply = h
            .deliver(json!({
                "method": "redeliverDeviceCertificate", "request_id": "cert-r2s",
                "device_id": "dev-1", "certificate_pem": pem, "org_id": "org-1",
            }))
            .await;
        assert_eq!(reply.result, REFUSED);
        assert!(matches!(reply.code, Some("schema") | Some("shape")));
        // An unlisted field is refused, not ignored.
        let reply = h
            .deliver(json!({
                "method": "redeliverDeviceCertificate", "request_id": "cert-r3",
                "device_id": "dev-1", "certificate_pem": pem, "org_id": "org-1",
                "subject_id": "sub-1", "extra": 1,
            }))
            .await;
        assert_eq!(reply.result, REFUSED);
        assert_eq!(reply.code, Some("schema"));
    }

    #[tokio::test]
    async fn certificate_status_reports_absence_with_every_key_present() {
        let mut h = Harness::new();
        let reply = h
            .deliver(json!({"method": "getDeviceCertificateStatus", "request_id": "st-1"}))
            .await;
        assert_eq!(reply.result, ACCEPTED);
        let data = reply.data.unwrap();
        let mut keys: Vec<&str> = data
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "awaiting_ticket",
                "cert_not_after",
                "cert_serial",
                "device_id",
                "has_certificate",
                "renewal_window_open"
            ]
        );
        assert_eq!(data["has_certificate"], json!(false));
        assert_eq!(data["device_id"], Value::Null);
        assert_eq!(data["renewal_window_open"], json!(false));
        assert_eq!(data["awaiting_ticket"], json!(false));
    }

    #[tokio::test]
    async fn awaiting_ticket_reports_the_outstanding_request_not_the_slot_contents() {
        let mut h = Harness::new();
        async fn status(h: &mut Harness) -> Value {
            h.deliver(json!({"method": "getDeviceCertificateStatus", "request_id": "st"}))
                .await
                .data
                .unwrap()["awaiting_ticket"]
                .clone()
        }
        // A pending ticket nobody asked for is NOT an outstanding request: the shell must not
        // read "awaiting" from the slot's contents, or it would mint against a satisfied link.
        assert_eq!(
            h.deliver(delivery(TICKET, "row-1")).await.result,
            "accepted"
        );
        assert_eq!(status(&mut h).await, json!(false));
        // The link asks and the pending ticket satisfies it at once — still no outstanding wait.
        h.ask().await;
        assert_eq!(h.next_ticket().await.as_deref(), Some(TICKET));
        assert_eq!(status(&mut h).await, json!(false));
        // A second dial with an empty slot IS an outstanding wait, and only a fresh delivery
        // clears it (M2 ruling 甲: the shell mints exactly when this reads true). ask() only
        // ENQUEUES the link event, so the pump may answer a status call before it consumes it;
        // poll to the settled state within a budget instead of assuming channel ordering.
        h.ask().await;
        let mut seen = json!(false);
        for _ in 0..200 {
            seen = status(&mut h).await;
            if seen == json!(true) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(seen, json!(true));
        assert_eq!(h.deliver(delivery(OTHER, "row-2")).await.result, "accepted");
        assert_eq!(h.next_ticket().await.as_deref(), Some(OTHER));
        assert_eq!(status(&mut h).await, json!(false));
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn the_read_only_methods_refuse_any_payload_field() {
        let mut h = Harness::new();
        for method in ["getDeviceIdentity", "getDeviceCertificateStatus"] {
            let reply = h
                .deliver(json!({"method": method, "request_id": "r", "device_id": "dev-1"}))
                .await;
            assert_eq!(reply.result, REFUSED, "{method}");
            assert_eq!(reply.code, Some("schema"), "{method}");
        }
    }

    // ---- 批2 (主签单选乙): the §4.2/§5.4 confirmation face routed to the Node service thread ----

    struct TempRoot(String);
    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("work-broker-conf-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            TempRoot(dir.to_string_lossy().into_owned())
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn data_keys(reply: &Reply) -> Vec<String> {
        let mut keys: Vec<String> = reply
            .data
            .as_ref()
            .expect("accepted confirmation carries facts")
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        keys.sort_unstable();
        keys
    }

    #[tokio::test]
    async fn choose_workspace_prepares_facts_then_confirm_registers_a_grant() {
        let tmp = TempRoot::new("grant");
        let mut h = Harness::new();
        let prepare = h
            .deliver(json!({
                "method": "chooseWorkspace", "request_id": "cw-1", "selected_path": tmp.0,
            }))
            .await;
        assert_eq!(prepare.result, ACCEPTED, "{prepare:?}");
        assert_eq!(
            data_keys(&prepare),
            [
                "actual_location",
                "confirmation_token",
                "differs_from_selected",
                "other_user_writable",
                "selected_path",
                "volume_label"
            ]
        );
        let token = prepare.data.unwrap()["confirmation_token"]
            .as_str()
            .unwrap()
            .to_string();

        let confirm = h
            .deliver(json!({
                "method": "confirmWorkspaceRoot", "request_id": "cw-2",
                "confirmation_token": token, "grant_id": "g-1",
                "artifact_dir": ["WeMeet成果"], "approved": true,
            }))
            .await;
        assert_eq!(confirm.result, ACCEPTED, "{confirm:?}");
        assert_eq!(data_keys(&confirm), ["grant_id", "root_identity_hash"]);
        let hash = confirm.data.unwrap()["root_identity_hash"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(!hash.is_empty());

        // The token is single-use: a replay confirms nothing (no grant), never re-registers.
        let replay = h
            .deliver(json!({
                "method": "confirmWorkspaceRoot", "request_id": "cw-3",
                "confirmation_token": token, "grant_id": "g-2",
                "artifact_dir": ["WeMeet成果"], "approved": true,
            }))
            .await;
        assert_eq!(replay.result, ACCEPTED);
        assert!(replay.data.is_none(), "a spent token produces no grant");
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn stage_local_input_seals_the_text_and_returns_only_metadata() {
        let mut h = Harness::new();
        let reply = h
            .deliver(json!({
                "method": "stageLocalInput", "request_id": "si-1", "text": "artifact body",
            }))
            .await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        // §1.1: only the ref + hash/size metadata cross back, never the本机正文.
        assert_eq!(
            data_keys(&reply),
            ["byte_count", "content_hash", "local_input_ref"]
        );
        let data = reply.data.unwrap();
        assert_eq!(data["byte_count"], "13");
        assert!(data["content_hash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        assert!(!data["local_input_ref"].as_str().unwrap().is_empty());

        // The closed key set refuses an extra field; empty text is a shape refusal.
        let extra = h
            .deliver(json!({
                "method": "stageLocalInput", "request_id": "si-2", "text": "x", "path": "/etc",
            }))
            .await;
        assert_eq!(extra.code, Some("schema"));
        let empty = h
            .deliver(json!({
                "method": "stageLocalInput", "request_id": "si-3", "text": "",
            }))
            .await;
        assert_eq!(empty.code, Some("shape"));
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn cancelling_a_root_confirmation_produces_no_grant() {
        let tmp = TempRoot::new("cancel");
        let mut h = Harness::new();
        let prepare = h
            .deliver(json!({
                "method": "chooseWorkspace", "request_id": "c-1", "selected_path": tmp.0,
            }))
            .await;
        let token = prepare.data.unwrap()["confirmation_token"]
            .as_str()
            .unwrap()
            .to_string();
        let cancel = h
            .deliver(json!({
                "method": "confirmWorkspaceRoot", "request_id": "c-2",
                "confirmation_token": token, "grant_id": "g-x",
                "artifact_dir": ["out"], "approved": false,
            }))
            .await;
        assert_eq!(cancel.result, ACCEPTED);
        assert!(cancel.data.is_none(), "cancel closes the handle, no grant");
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn confirmation_payloads_are_closed() {
        let tmp = TempRoot::new("schema");
        let mut h = Harness::new();
        // An unlisted field on the prepare carrier is a schema refusal, not ignored.
        let reply = h
            .deliver(json!({
                "method": "chooseWorkspace", "request_id": "s-1",
                "selected_path": tmp.0, "extra": 1,
            }))
            .await;
        assert_eq!(reply.code, Some("schema"));
        // approved must be a bool, not a string.
        let prepare = h
            .deliver(json!({
                "method": "chooseWorkspace", "request_id": "s-2", "selected_path": tmp.0,
            }))
            .await;
        let token = prepare.data.unwrap()["confirmation_token"]
            .as_str()
            .unwrap()
            .to_string();
        let reply = h
            .deliver(json!({
                "method": "confirmWorkspaceRoot", "request_id": "s-3",
                "confirmation_token": token, "grant_id": "g", "artifact_dir": ["out"],
                "approved": "true",
            }))
            .await;
        assert_eq!(reply.code, Some("schema"));
        // A non-loopback / zero port is refused, never probed.
        let reply = h
            .deliver(json!({"method": "probeLocalModel", "request_id": "s-4", "port": "0"}))
            .await;
        assert_eq!(reply.code, Some("shape"));
        // A binding root that does not exist is a shape refusal (the Broker could not bind it).
        let reply = h
            .deliver(json!({
                "method": "chooseWorkspace", "request_id": "s-5",
                "selected_path": format!("{}\\does-not-exist", tmp.0),
            }))
            .await;
        assert_eq!(reply.code, Some("shape"));
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
    }

    #[tokio::test]
    async fn probe_then_confirm_a_local_model_binding_through_the_fixture() {
        use std::net::{TcpListener, TcpStream};
        use std::process::{Command, Stdio};
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
            .expect("spawn fixture");
        let mut ready = false;
        for _ in 0..100 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(ready, "fixture did not listen");

        let mut h = Harness::new();
        let prepare = h
            .deliver(json!({
                "method": "probeLocalModel", "request_id": "m-1", "port": port.to_string(),
            }))
            .await;
        assert_eq!(prepare.result, ACCEPTED, "{prepare:?}");
        assert_eq!(
            data_keys(&prepare),
            [
                "confirmation_token",
                "image_path",
                "image_sha256",
                "listens_on_all_interfaces",
                "owner_sid",
                "process_name",
                "signer_thumbprint"
            ]
        );
        let token = prepare.data.unwrap()["confirmation_token"]
            .as_str()
            .unwrap()
            .to_string();
        let confirm = h
            .deliver(json!({
                "method": "confirmLocalModel", "request_id": "m-2",
                "confirmation_token": token, "profile_id": "profile-dev-fixture-v1",
                "port": port.to_string(),
                "listener_requirement": {
                    "allowed_signers": [], "allow_user_pinned_hash": true, "allowed_service_sids": []
                },
                "approved": true,
            }))
            .await;
        assert_eq!(confirm.result, ACCEPTED, "{confirm:?}");
        assert_eq!(data_keys(&confirm), ["binding_hash", "profile_id"]);
        assert!(!confirm.data.unwrap()["binding_hash"]
            .as_str()
            .unwrap()
            .is_empty());
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
        let _ = child.kill();
        let _ = child.wait();
    }
}
