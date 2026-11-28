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
#[allow(unused_variables)]
pub async fn run_core_pump(
    mut identity: Identity,
    mut slot: TicketSlot,
    mut deliveries: mpsc::Receiver<DeliveryRequest>,
    mut link_events: mpsc::Receiver<LinkEvent>,
    tickets: mpsc::Sender<String>,
    core_events: mpsc::Sender<LinkEvent>,
    ready: mpsc::Sender<ReadyIdentity>,
    approval_signer: crate::journalop::ApprovalSignerSlot,
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
                        let reply = if method == "confirmLocalSubmission"
                            || method == "confirmLocalConfigurationProbe"
                        {
                            #[cfg(windows)]
                            if method == "confirmLocalConfigurationProbe" {
                                configuration_probe_reply(&mut identity, &node_service, &request.message).await
                            } else {
                                submission_reply(&mut identity, &node_service, &request.message).await
                            }
                            #[cfg(not(windows))]
                            { Reply::refused(&request.message, "method_not_implemented") }
                        } else if method == "rebindRunWorkspace" {
                            #[cfg(windows)]
                            { rebind_reply(&mut identity, &node_service, &request.message).await }
                            #[cfg(not(windows))]
                            { Reply::refused(&request.message, "method_not_implemented") }
                        } else if method == "prepareLocalApprovalDecision" {
                            #[cfg(windows)]
                            { approval_decision_reply(&approval_signer, &node_service, &request.message).await }
                            #[cfg(not(windows))]
                            { Reply::refused(&request.message, "method_not_implemented") }
                        } else if matches!(method, "openLocalContent" | "exportArtifactVersion") {
                            #[cfg(windows)]
                            { open_local_content_reply(&approval_signer, &node_service, &request.message).await }
                            #[cfg(not(windows))]
                            { Reply::refused(&request.message, "method_not_implemented") }
                        } else if matches!(
                            method,
                            "getModelProbeReceipts" | "confirmModelProbeReceiptDelivery"
                        ) {
                            model_probe_receipt_reply(&approval_signer, &request.message).await
                        } else if CONFIRMATION_METHODS.contains(&method)
                            || method == "stageLocalInput"
                            || method == "listWorkspaceGrants"
                            || method == "getCurrentSession"
                            || method == "prepareLocalAcceptance"
                            || method == "listLocalArtifactDrafts"
                            || method == "prepareLocalArtifactEdit"
                            || method == "decideLocalArtifactEdit"
                            || method == "completeLocalArtifactEdit"
                        {
                            #[cfg(windows)]
                            { confirmation_reply_with_identity(Some(&mut identity), &node_service, &request.message).await }
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

/// Sign a local Task submission only after the shell carries the native approval decision back.
/// The Node thread proves the exact staged input and selected grants exist in this live session;
/// the Broker supplies org/subject/device from its own authenticated identity.
#[cfg(windows)]
async fn submission_reply(
    identity: &mut Identity,
    node: &mpsc::Sender<crate::nodeservice::NodeRequest>,
    message: &Value,
) -> Reply {
    use crate::nodeservice::NodeRequest;

    let fields = [
        "approved",
        "client_request_id",
        "input_ref",
        "input_hash",
        "preview_hash",
        "target_selection_hash",
        "selected_grant_ids",
        "grant_revisions",
        "profile_id",
        "profile_revision",
        "profile_hash",
        "auth_epoch",
    ];
    if let Err(code) = confirm_keys(message, &fields) {
        return Reply::refused(message, code);
    }
    let Some(approved) = message.get("approved").and_then(Value::as_bool) else {
        return Reply::refused(message, "schema");
    };
    if !approved {
        return Reply::accepted(message);
    }
    let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or("");
    for key in [
        "client_request_id",
        "input_ref",
        "input_hash",
        "preview_hash",
        "target_selection_hash",
        "profile_id",
        "profile_revision",
        "profile_hash",
        "auth_epoch",
    ] {
        if text(key).is_empty() {
            return Reply::refused(message, "schema");
        }
    }
    let auth_epoch = match text("auth_epoch").parse::<u64>() {
        Ok(value) if canonical_uint_text(text("auth_epoch")) => value,
        _ => return Reply::refused(message, "shape"),
    };
    let profile_revision = match text("profile_revision").parse::<u64>() {
        Ok(value) if canonical_uint_text(text("profile_revision")) => value,
        _ => return Reply::refused(message, "shape"),
    };
    if uuid::Uuid::parse_str(text("input_ref")).is_err() {
        return Reply::refused(message, "shape");
    }
    let selected_grant_ids = match string_array_field(message, "selected_grant_ids") {
        Ok(value) => value,
        Err(code) => return Reply::refused(message, code),
    };
    let grant_revisions = match string_array_field(message, "grant_revisions") {
        Ok(value) => value,
        Err(code) => return Reply::refused(message, code),
    };
    if selected_grant_ids.len() != grant_revisions.len()
        || !grant_revisions
            .iter()
            .all(|value| canonical_uint_text(value))
    {
        return Reply::refused(message, "shape");
    }
    let org_id = match identity.signed_org() {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return Reply::refused(message, "no_pairing"),
    };
    let subject_id = match identity.signed_subject() {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return Reply::refused(message, "no_pairing"),
    };
    let device_id = match identity.device_id() {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return Reply::refused(message, "no_pairing"),
    };
    let (tx, rx) = oneshot::channel();
    if node
        .send(NodeRequest::ValidateLocalSubmission {
            input_ref: text("input_ref").to_string(),
            input_hash: text("input_hash").to_string(),
            selected_grant_ids: selected_grant_ids.clone(),
            reply: tx,
        })
        .await
        .is_err()
    {
        return Reply::accepted_with(message, json!({ "status": "unavailable" }));
    }
    let session_id = match rx.await {
        Ok(Ok((node_org, node_subject, node_device, session_id)))
            if node_org == org_id
                && node_subject == subject_id
                && node_device == device_id
                && uuid::Uuid::parse_str(&session_id).is_ok() =>
        {
            session_id
        }
        _ => return Reply::accepted_with(message, json!({ "status": "unavailable" })),
    };
    let proof = crate::frame::intent::LocalIntent {
        v: 1,
        org_id,
        subject_id,
        auth_plane: "bearer".into(),
        auth_epoch,
        device_id,
        session_id,
        request_id: text("client_request_id").to_string(),
        input_hash: text("input_hash").to_string(),
        preview_hash: text("preview_hash").to_string(),
        target_selection_hash: text("target_selection_hash").to_string(),
        selected_grant_ids,
        grant_revisions,
        profile_id: text("profile_id").to_string(),
        profile_revision,
        profile_hash: text("profile_hash").to_string(),
        nonce: uuid::Uuid::new_v4().simple().to_string(),
        expires_at: match std::time::SystemTime::now()
            .checked_add(std::time::Duration::from_secs(60))
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|value| crate::frame::rfc3339::format_utc_seconds(value.as_secs()))
        {
            Some(value) => value,
            None => return Reply::accepted_with(message, json!({ "status": "unavailable" })),
        },
        signature: None,
    };
    if let Err(code) = proof.validate().map_err(|_| "shape") {
        return Reply::refused(message, code);
    }
    let value = proof.to_value();
    let signature = match identity.sign_local_intent(&value, &proof.org_id, &proof.subject_id) {
        Ok(value) => value,
        Err(IdentityError::NoPairing) => return Reply::refused(message, "no_pairing"),
        Err(_) => return Reply::refused(message, "shape"),
    };
    let mut proof = value;
    proof["signature"] = Value::String(signature);
    Reply::accepted_with(message, json!({ "status": "ready", "local_intent": proof }))
}

/// Sign the fixed, empty-grant configuration-probe intent for the current Node session.
#[cfg(windows)]
async fn configuration_probe_reply(
    identity: &mut Identity,
    node: &mpsc::Sender<crate::nodeservice::NodeRequest>,
    message: &Value,
) -> Reply {
    use crate::nodeservice::NodeRequest;

    let fields = [
        "approved",
        "auth_epoch",
        "client_request_id",
        "preview_hash",
        "profile_hash",
        "profile_id",
        "profile_revision",
        "session_id",
        "target_selection_hash",
    ];
    if let Err(code) = confirm_keys(message, &fields) {
        return Reply::refused(message, code);
    }
    let Some(approved) = message.get("approved").and_then(Value::as_bool) else {
        return Reply::refused(message, "schema");
    };
    if !approved {
        return Reply::accepted(message);
    }
    let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or("");
    for key in [
        "auth_epoch",
        "client_request_id",
        "preview_hash",
        "profile_hash",
        "profile_id",
        "profile_revision",
        "session_id",
        "target_selection_hash",
    ] {
        if text(key).is_empty() {
            return Reply::refused(message, "schema");
        }
    }
    let auth_epoch = match text("auth_epoch").parse::<u64>() {
        Ok(value) if canonical_uint_text(text("auth_epoch")) => value,
        _ => return Reply::refused(message, "shape"),
    };
    let profile_revision = match text("profile_revision").parse::<u64>() {
        Ok(value) if value > 0 && canonical_uint_text(text("profile_revision")) => value,
        _ => return Reply::refused(message, "shape"),
    };
    if uuid::Uuid::parse_str(text("session_id")).is_err() {
        return Reply::refused(message, "shape");
    }
    let org_id = match identity.signed_org() {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return Reply::refused(message, "no_pairing"),
    };
    let subject_id = match identity.signed_subject() {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return Reply::refused(message, "no_pairing"),
    };
    let device_id = match identity.device_id() {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return Reply::refused(message, "no_pairing"),
    };
    let (tx, rx) = oneshot::channel();
    if node
        .send(NodeRequest::CurrentSession { reply: tx })
        .await
        .is_err()
    {
        return Reply::accepted_with(message, json!({ "status": "unavailable" }));
    }
    let session_id = match rx.await {
        Ok(Ok((node_org, node_subject, node_device, session_id)))
            if node_org == org_id
                && node_subject == subject_id
                && node_device == device_id
                && session_id == text("session_id")
                && uuid::Uuid::parse_str(&session_id).is_ok() =>
        {
            session_id
        }
        _ => return Reply::accepted_with(message, json!({ "status": "unavailable" })),
    };
    let proof = crate::frame::intent::LocalIntent {
        v: 1,
        org_id,
        subject_id,
        auth_plane: "bearer".into(),
        auth_epoch,
        device_id,
        session_id,
        request_id: text("client_request_id").to_string(),
        input_hash: crate::sha256_hex(b"device-model-probe-v1"),
        preview_hash: text("preview_hash").to_string(),
        target_selection_hash: text("target_selection_hash").to_string(),
        selected_grant_ids: Vec::new(),
        grant_revisions: Vec::new(),
        profile_id: text("profile_id").to_string(),
        profile_revision,
        profile_hash: text("profile_hash").to_string(),
        nonce: uuid::Uuid::new_v4().simple().to_string(),
        expires_at: match std::time::SystemTime::now()
            .checked_add(std::time::Duration::from_secs(60))
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|value| crate::frame::rfc3339::format_utc_seconds(value.as_secs()))
        {
            Some(value) => value,
            None => return Reply::accepted_with(message, json!({ "status": "unavailable" })),
        },
        signature: None,
    };
    if proof.validate_configuration_probe().is_err() {
        return Reply::refused(message, "shape");
    }
    let value = proof.to_value();
    let signature = match identity.sign_local_intent(&value, &proof.org_id, &proof.subject_id) {
        Ok(value) => value,
        Err(IdentityError::NoPairing) => return Reply::refused(message, "no_pairing"),
        Err(_) => return Reply::refused(message, "shape"),
    };
    let mut proof = value;
    proof["signature"] = Value::String(signature);
    Reply::accepted_with(message, json!({ "status": "ready", "local_intent": proof }))
}

fn model_binding_hash(parts: &[&str]) -> String {
    let field = |value: &str| format!("{}:{value}", value.len());
    let preimage = format!(
        "device-model-binding-v1|{}",
        parts
            .iter()
            .map(|value| field(value))
            .collect::<Vec<_>>()
            .join("|")
    );
    crate::sha256_hex(preimage.as_bytes())
}

fn canonical_uint_text(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
        && value.parse::<u64>().is_ok()
}

fn string_array_field(message: &Value, key: &str) -> Result<Vec<String>, &'static str> {
    let Some(Value::Array(values)) = message.get(key) else {
        return Err("schema");
    };
    if values.is_empty() {
        return Err("shape");
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .ok_or("schema")
        })
        .collect()
}

/// Build and sign a same-root GrantSuccessionProof from the Node thread's registered grants.
#[cfg(windows)]
async fn rebind_reply(
    identity: &mut Identity,
    node: &mpsc::Sender<crate::nodeservice::NodeRequest>,
    message: &Value,
) -> Reply {
    use crate::nodeservice::NodeRequest;

    let fields = ["run_id", "old_grant_id", "new_grant_id", "auth_epoch"];
    if let Err(code) = confirm_keys(message, &fields) {
        return Reply::refused(message, code);
    }
    let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or("");
    for key in fields {
        let value = text(key);
        if value.is_empty() {
            return Reply::refused(message, "schema");
        }
    }
    for key in ["run_id", "old_grant_id", "new_grant_id"] {
        if uuid::Uuid::parse_str(text(key)).is_err() {
            return Reply::refused(message, "shape");
        }
    }
    let auth_epoch = match text("auth_epoch").parse::<u64>() {
        Ok(value) => value.to_string(),
        Err(_) => return Reply::refused(message, "shape"),
    };
    let org_id = match identity.signed_org() {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return Reply::refused(message, "no_pairing"),
    };
    let subject_id = match identity.signed_subject() {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return Reply::refused(message, "no_pairing"),
    };

    let (tx, rx) = oneshot::channel();
    if node
        .send(NodeRequest::GrantRootIdentity {
            old_grant_id: text("old_grant_id").to_string(),
            new_grant_id: text("new_grant_id").to_string(),
            reply: tx,
        })
        .await
        .is_err()
    {
        return Reply::refused(message, "shape");
    }
    let (root_identity_hash, session_id) = match rx.await {
        Ok(Ok((hash, session))) if hash.len() == 64 && uuid::Uuid::parse_str(&session).is_ok() => {
            (hash, session)
        }
        _ => return Reply::refused(message, "shape"),
    };
    let expires_at = match std::time::SystemTime::now()
        .checked_add(std::time::Duration::from_secs(240))
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|value| crate::frame::rfc3339::format_utc_seconds(value.as_secs()))
    {
        Some(value) => value,
        None => return Reply::refused(message, "shape"),
    };
    let mut proof = json!({
        "old_grant_id": text("old_grant_id"),
        "new_grant_id": text("new_grant_id"),
        "root_identity_hash": root_identity_hash,
        "run_id": text("run_id"),
        "session_id": session_id,
        "auth_plane": "bearer",
        "auth_epoch": auth_epoch,
        "nonce": uuid::Uuid::new_v4().to_string(),
        "expires_at": expires_at,
    });
    match identity.sign_grant_succession(&proof, &org_id, &subject_id) {
        Ok(signature) => {
            proof["signature"] = Value::String(signature);
            Reply::accepted_with(message, proof)
        }
        Err(IdentityError::NoPairing) => Reply::refused(message, "no_pairing"),
        Err(_) => Reply::refused(message, "shape"),
    }
}

/// Forward one confirmation message to the Node service thread and build the closed reply. The
/// prepare methods return the confirmation facts plus a single-use token; the confirm methods return
/// the registered grant/binding hash on approve, or an accepted no-facts reply on cancel (no grant).
/// A bind/probe/identity failure is a closed `shape` refusal — the Broker could not bind/probe the
/// target — never a silent accept. Schema (key-set/type) violations are `schema`.
/// Serve recorded model-result receipts to the authenticated shell and persist delivery confirmation.
async fn model_probe_receipt_reply(
    signer: &crate::journalop::ApprovalSignerSlot,
    message: &Value,
) -> Reply {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if method == "getModelProbeReceipts" {
        if confirm_keys(message, &["auth_epoch"]).is_err() {
            return Reply::refused(message, "schema");
        }
    } else if method == "confirmModelProbeReceiptDelivery" {
        if confirm_keys(message, &["model_result_id"]).is_err() {
            return Reply::refused(message, "schema");
        }
    } else {
        return Reply::refused(message, "unknown_method");
    }
    let auth_epoch = if method == "getModelProbeReceipts" {
        message
            .get("auth_epoch")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<u64>().ok())
    } else {
        None
    };
    if method == "getModelProbeReceipts" && auth_epoch.is_none() {
        return Reply::refused(message, "shape");
    }
    let model_result_id = if method == "confirmModelProbeReceiptDelivery" {
        message
            .get("model_result_id")
            .and_then(Value::as_str)
            .unwrap_or("")
    } else {
        ""
    };
    if method == "confirmModelProbeReceiptDelivery"
        && uuid::Uuid::parse_str(model_result_id).is_err()
    {
        return Reply::refused(message, "shape");
    }
    let facts = signer.lock().ok().and_then(|slot| slot.clone());
    let Some(facts) = facts else {
        return Reply::refused(message, "no_pairing");
    };
    let Some(session_id) = facts.session_id.clone() else {
        return Reply::accepted_with(message, json!({ "status": "unavailable" }));
    };
    let op = if method == "getModelProbeReceipts" {
        crate::journalop::JournalOp::PrepareModelProbeReceipts {
            org_id: facts.org_id,
            subject_id: facts.subject_id,
            session_id,
            auth_epoch: auth_epoch.unwrap_or_default(),
        }
    } else {
        crate::journalop::JournalOp::ConfirmModelProbeReceiptDelivery {
            org_id: facts.org_id,
            subject_id: facts.subject_id,
            session_id,
            model_result_id: model_result_id.to_string(),
        }
    };
    let journal = facts.journal;
    let reply = tokio::task::spawn_blocking(move || journal.request(op))
        .await
        .ok()
        .flatten();
    match (method, reply) {
        (
            "getModelProbeReceipts",
            Some(crate::journalop::JournalReply::ModelProbeReceiptsPrepared(receipts)),
        ) => Reply::accepted_with(message, json!({ "status": "ready", "receipts": receipts })),
        (
            "confirmModelProbeReceiptDelivery",
            Some(crate::journalop::JournalReply::ModelProbeReceiptDeliveryConfirmed(delivered)),
        ) => Reply::accepted_with(
            message,
            json!({ "status": "ready", "delivered": delivered }),
        ),
        _ => Reply::accepted_with(message, json!({ "status": "unavailable" })),
    }
}

#[cfg(windows)]
async fn approval_decision_reply(
    signer: &crate::journalop::ApprovalSignerSlot,
    node: &mpsc::Sender<crate::nodeservice::NodeRequest>,
    message: &Value,
) -> Reply {
    let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or("");
    let fields = [
        "approval_id",
        "operation_id",
        "params_hash",
        "expected_revision",
        "decision",
        "remember_readonly",
        "readonly_scope",
        "readonly_expires_at",
        "policy_epoch",
        "access_epoch",
        "auth_epoch",
    ];
    if let Err(code) = confirm_keys(message, &fields) {
        return Reply::refused(message, code);
    }
    for key in fields {
        if key == "remember_readonly" || key == "readonly_scope" || key == "readonly_expires_at" {
            continue;
        }
        if text(key).is_empty() {
            return Reply::refused(message, "schema");
        }
    }
    let Some(remember_readonly) = message.get("remember_readonly").and_then(Value::as_bool) else {
        return Reply::refused(message, "schema");
    };
    let readonly_scope = match message.get("readonly_scope") {
        Some(Value::Object(scope)) => Some(Value::Object(scope.clone())),
        Some(Value::Null) | None => None,
        _ => return Reply::refused(message, "schema"),
    };
    let readonly_expires_at = match message.get("readonly_expires_at") {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        Some(Value::Null) | None => None,
        _ => return Reply::refused(message, "schema"),
    };
    let input = crate::approvaldecision::ApprovalDecisionInput {
        org_id: String::new(),
        subject_id: String::new(),
        auth_epoch: text("auth_epoch").to_string(),
        device_id: String::new(),
        session_id: String::new(),
        approval_id: text("approval_id").to_string(),
        operation_id: text("operation_id").to_string(),
        params_hash: text("params_hash").to_string(),
        expected_revision: text("expected_revision").to_string(),
        decision: text("decision").to_string(),
        remember_readonly,
        readonly_scope,
        readonly_expires_at,
        policy_epoch: text("policy_epoch").to_string(),
        access_epoch: text("access_epoch").to_string(),
    };
    let facts = signer.lock().ok().and_then(|slot| slot.clone());
    if let Some(facts) = facts {
        if let Some(session_id) = facts.session_id.clone() {
            let op = crate::journalop::JournalOp::PrepareLocalApprovalDecision {
                org_id: facts.org_id,
                subject_id: facts.subject_id,
                device_id: facts.device_id,
                session_id,
                input: Box::new(input),
            };
            // The journal handle blocks by design; this reply runs on a runtime worker, so the
            // blocking request must not be made from it.
            let journal = facts.journal;
            let proof = tokio::task::spawn_blocking(move || journal.request(op))
                .await
                .ok()
                .flatten();
            return match proof {
                Some(crate::journalop::JournalReply::LocalApprovalDecision(Ok(proof))) => {
                    Reply::accepted_with(
                        message,
                        json!({ "status": "ready", "approval_decision_proof": proof }),
                    )
                }
                _ => Reply::accepted_with(message, json!({ "status": "unavailable" })),
            };
        }
    }
    confirmation_reply(node, message).await
}

#[cfg(windows)]
async fn open_local_content_reply(
    signer: &crate::journalop::ApprovalSignerSlot,
    node: &mpsc::Sender<crate::nodeservice::NodeRequest>,
    message: &Value,
) -> Reply {
    if message.get("method").and_then(Value::as_str) == Some("exportArtifactVersion") {
        if let Err(code) = confirm_keys(message, &["version_id"]) {
            return Reply::refused(message, code);
        }
        let version_id = message
            .get("version_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        if uuid::Uuid::parse_str(version_id).is_err() {
            return Reply::refused(message, "shape");
        }
        let (tx, rx) = oneshot::channel();
        if node
            .send(crate::nodeservice::NodeRequest::OpenLocalContent {
                kind: "artifact_version".to_string(),
                id: version_id.to_string(),
                reply: tx,
            })
            .await
            .is_err()
        {
            return Reply::accepted_with(message, json!({ "status": "not_on_this_device" }));
        }
        return match rx.await {
            Ok(Some(body)) => local_content_export_reply(message, version_id, body),
            _ => Reply::accepted_with(message, json!({ "status": "not_on_this_device" })),
        };
    }
    let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or("");
    if let Err(code) = confirm_keys(message, &["kind", "id"]) {
        return Reply::refused(message, code);
    }
    let kind = text("kind");
    let id = text("id");
    if !matches!(
        kind,
        "approval" | "run_transcript" | "artifact_version" | "artifact_edit"
    ) || id.is_empty()
        || id.len() > 512
        || id.contains('\0')
    {
        return Reply::refused(message, "shape");
    }
    if kind != "approval" {
        return confirmation_reply(node, message).await;
    }
    let Some(facts) = signer.lock().ok().and_then(|slot| slot.clone()) else {
        return confirmation_reply(node, message).await;
    };
    let op = crate::journalop::JournalOp::ReadLocalApproval {
        org_id: facts.org_id,
        subject_id: facts.subject_id,
        approval_id: id.to_string(),
    };
    let journal = facts.journal;
    let body = tokio::task::spawn_blocking(move || journal.request(op))
        .await
        .ok()
        .flatten();
    match body {
        Some(crate::journalop::JournalReply::LocalApproval(Ok(Some(body)))) => {
            local_content_reply(message, kind, id, body)
        }
        _ => Reply::accepted_with(message, json!({ "status": "not_on_this_device" })),
    }
}

fn local_content_reply(
    message: &Value,
    kind: &str,
    id: &str,
    body: crate::journalop::LocalContentBody,
) -> Reply {
    let format = match body.row.format.as_str() {
        "md" => "text/markdown",
        "txt" | "json" => "text/plain",
        _ => return Reply::accepted_with(message, json!({ "status": "not_on_this_device" })),
    };
    if body.bytes.len() > 1024 * 1024 {
        return Reply::accepted_with(message, json!({ "status": "not_on_this_device" }));
    }
    let Ok(text) = String::from_utf8(body.bytes) else {
        return Reply::accepted_with(message, json!({ "status": "not_on_this_device" }));
    };
    if kind == "approval" {
        let valid = (|| -> Option<()> {
            if body.row.version_id != id
                || body.row.format != "json"
                || body.row.publish_state != "sealed"
            {
                return None;
            }
            let document: Value = serde_json::from_str(&text).ok()?;
            let object = document.as_object()?;
            let destination = object.get("destination_id")?;
            if object.len() != 9
                || object.get("approval_id")?.as_str()? != id
                || uuid::Uuid::parse_str(object.get("operation_id")?.as_str()?).is_err()
                || object.get("logical_key")?.as_str()?.is_empty()
                || object.get("step_key")?.as_str()?.is_empty()
                || object.get("state")?.as_str()? != "waiting_approval"
                || object.get("classification")?.as_str()? != "local_only"
                || !matches!(destination, Value::Null | Value::String(_))
                || object.get("request_hash")?.as_str()?.len() != 64
                || object
                    .get("request_hash")?
                    .as_str()?
                    .bytes()
                    .any(|b| !b.is_ascii_hexdigit())
            {
                return None;
            }
            let action = object.get("action")?.as_object()?;
            if action.len() != 2
                || !matches!(
                    action.get("kind")?.as_str()?,
                    "artifact.write" | "model.send_device_local"
                )
                || !action.get("request")?.is_object()
            {
                return None;
            }
            Some(())
        })()
        .is_some();
        if !valid {
            return Reply::accepted_with(message, json!({ "status": "not_on_this_device" }));
        }
    }
    if kind == "run_transcript" {
        let valid = (|| -> Option<()> {
            if body.row.version_id != id
                || body.row.format != "json"
                || body.row.publish_state != "sealed"
            {
                return None;
            }
            let document: Value = serde_json::from_str(&text).ok()?;
            let object = document.as_object()?;
            if object.len() != 3 || object.get("run_id")?.as_str()? != id {
                return None;
            }
            let turn_count = object.get("turn_count")?.as_str()?;
            if turn_count.is_empty() || !turn_count.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let messages = object.get("messages")?.as_array()?;
            if !messages.iter().all(|message| {
                message
                    .get("role")
                    .and_then(Value::as_str)
                    .is_some_and(|role| !role.is_empty())
            }) {
                return None;
            }
            Some(())
        })()
        .is_some();
        if !valid {
            return Reply::accepted_with(message, json!({ "status": "not_on_this_device" }));
        }
    }
    let content_hash = body
        .row
        .content_hash
        .strip_prefix("sha256:")
        .unwrap_or(&body.row.content_hash);
    Reply::accepted_with(
        message,
        json!({
            "status": "available",
            "format": format,
            "text": text,
            "content_hash": format!("sha256:{content_hash}"),
            "byte_count": body.row.byte_count.to_string(),
        }),
    )
}

#[cfg(windows)]
fn local_content_export_reply(
    message: &Value,
    version_id: &str,
    body: crate::journalop::LocalContentBody,
) -> Reply {
    let format = match body.row.format.as_str() {
        "md" => "text/markdown",
        "txt" => "text/plain",
        _ => return Reply::accepted_with(message, json!({ "status": "not_on_this_device" })),
    };
    let expected_hash = body
        .row
        .content_hash
        .strip_prefix("sha256:")
        .unwrap_or(&body.row.content_hash);
    if body.row.version_id != version_id
        || body.bytes.len() > 1024 * 1024
        || body.bytes.len() as u64 != body.row.byte_count
        || std::str::from_utf8(&body.bytes).is_err()
        || crate::sha256_hex(&body.bytes) != expected_hash
    {
        return Reply::accepted_with(message, json!({ "status": "not_on_this_device" }));
    }
    Reply::accepted_with(
        message,
        json!({
            "status": "ready",
            "version_id": version_id,
            "format": format,
            "content_hash": format!("sha256:{expected_hash}"),
            "byte_count": body.row.byte_count.to_string(),
        }),
    )
}

// The confirmation carriers forward into the Node service thread, which only exists on Windows
// (nodeservice/listener/modelproxy are `#[cfg(windows)]` modules). The pump's non-Windows arm
// refuses these methods before this function is reachable.
#[cfg(windows)]
async fn confirmation_reply(
    node: &mpsc::Sender<crate::nodeservice::NodeRequest>,
    message: &Value,
) -> Reply {
    confirmation_reply_with_identity(None, node, message).await
}

#[cfg(windows)]
async fn confirmation_reply_with_identity(
    identity: Option<&mut Identity>,
    node: &mpsc::Sender<crate::nodeservice::NodeRequest>,
    message: &Value,
) -> Reply {
    use crate::nodeservice::NodeRequest;

    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let text = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or("");
    match method {
        "getCurrentSession" => {
            if let Err(code) = confirm_keys(message, &[]) {
                return Reply::refused(message, code);
            }
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::CurrentSession { reply: tx })
                .await
                .is_err()
            {
                return Reply::refused(message, "shape");
            }
            match rx.await {
                Ok(Ok(value)) => {
                    let Some(identity) = identity.as_ref() else {
                        return Reply::refused(message, "no_pairing");
                    };
                    if identity.signed_org() != Some(value.0.as_str())
                        || identity.signed_subject() != Some(value.1.as_str())
                        || identity.device_id() != Some(value.2.as_str())
                        || uuid::Uuid::parse_str(&value.3).is_err()
                    {
                        return Reply::refused(message, "no_pairing");
                    }
                    Reply::accepted_with(message, json!({ "session_id": value.3 }))
                }
                _ => Reply::refused(message, "shape"),
            }
        }
        "listWorkspaceGrants" => {
            if let Err(code) = confirm_keys(message, &[]) {
                return Reply::refused(message, code);
            }
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::ListWorkspaceGrants { reply: tx })
                .await
                .is_err()
            {
                return Reply::refused(message, "shape");
            }
            match rx.await {
                Ok(grants) => Reply::accepted_with(
                    message,
                    json!({ "status": "available", "grants": grants }),
                ),
                _ => Reply::refused(message, "shape"),
            }
        }
        "prepareLocalApprovalDecision" => {
            let fields = [
                "approval_id",
                "operation_id",
                "params_hash",
                "expected_revision",
                "decision",
                "remember_readonly",
                "readonly_scope",
                "readonly_expires_at",
                "policy_epoch",
                "access_epoch",
                "auth_epoch",
            ];
            if let Err(code) = confirm_keys(message, &fields) {
                return Reply::refused(message, code);
            }
            for key in fields {
                if key == "remember_readonly"
                    || key == "readonly_scope"
                    || key == "readonly_expires_at"
                {
                    continue;
                }
                if text(key).is_empty() {
                    return Reply::refused(message, "schema");
                }
            }
            let Some(remember_readonly) = message.get("remember_readonly").and_then(Value::as_bool)
            else {
                return Reply::refused(message, "schema");
            };
            let readonly_scope = match message.get("readonly_scope") {
                Some(Value::Object(scope)) => Some(Value::Object(scope.clone())),
                Some(Value::Null) | None => None,
                _ => return Reply::refused(message, "schema"),
            };
            let readonly_expires_at = match message.get("readonly_expires_at") {
                Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
                Some(Value::Null) | None => None,
                _ => return Reply::refused(message, "schema"),
            };
            let input = crate::approvaldecision::ApprovalDecisionInput {
                org_id: String::new(),
                subject_id: String::new(),
                auth_epoch: text("auth_epoch").to_string(),
                device_id: String::new(),
                session_id: String::new(),
                approval_id: text("approval_id").to_string(),
                operation_id: text("operation_id").to_string(),
                params_hash: text("params_hash").to_string(),
                expected_revision: text("expected_revision").to_string(),
                decision: text("decision").to_string(),
                remember_readonly,
                readonly_scope,
                readonly_expires_at,
                policy_epoch: text("policy_epoch").to_string(),
                access_epoch: text("access_epoch").to_string(),
            };
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::PrepareLocalApprovalDecision {
                    input: Box::new(input),
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Reply::accepted_with(message, json!({ "status": "unavailable" }));
            }
            match rx.await {
                Ok(Some(proof)) => Reply::accepted_with(
                    message,
                    json!({ "status": "ready", "approval_decision_proof": proof }),
                ),
                _ => Reply::accepted_with(message, json!({ "status": "unavailable" })),
            }
        }
        "prepareLocalAcceptance" => {
            let fields = [
                "task_id",
                "artifact_id",
                "version_id",
                "content_hash",
                "auth_epoch",
            ];
            if let Err(code) = confirm_keys(message, &fields) {
                return Reply::refused(message, code);
            }
            for key in fields {
                if text(key).is_empty() {
                    return Reply::refused(message, "schema");
                }
            }
            let input = crate::possession::PossessionInput {
                org_id: String::new(),
                subject_id: String::new(),
                auth_epoch: text("auth_epoch").to_string(),
                device_id: String::new(),
                session_id: String::new(),
                task_id: text("task_id").to_string(),
                artifact_id: text("artifact_id").to_string(),
                version_id: text("version_id").to_string(),
                content_hash: text("content_hash").to_string(),
                request_id: text("request_id").to_string(),
            };
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::PrepareLocalAcceptance {
                    input: Box::new(input),
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Reply::accepted_with(message, json!({ "status": "unavailable" }));
            }
            match rx.await {
                Ok(Some(signed)) => {
                    let proof = signed.get("proof").cloned().unwrap_or(Value::Null);
                    let signature = signed
                        .get("signature")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let device_id = proof
                        .get("device_id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let session_id = proof
                        .get("session_id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if proof.is_null()
                        || signature.is_empty()
                        || device_id.is_empty()
                        || session_id.is_empty()
                    {
                        return Reply::accepted_with(message, json!({ "status": "unavailable" }));
                    }
                    Reply::accepted_with(
                        message,
                        json!({
                            "status": "ready",
                            "possession_proof": proof,
                            "signature": signature,
                            "device_id": device_id,
                            "session_id": session_id,
                        }),
                    )
                }
                _ => Reply::accepted_with(message, json!({ "status": "unavailable" })),
            }
        }
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
                Ok(Ok((token, c, root_identity_hash, device_id, session_id))) => {
                    Reply::accepted_with(
                        message,
                        json!({
                            "confirmation_token": token,
                            "selected_path": c.selected_path,
                            "actual_location": c.actual_location,
                            "volume_label": c.volume_label,
                            "differs_from_selected": c.differs_from_selected,
                            "other_user_writable": c.other_user_writable,
                            "root_identity_hash": root_identity_hash,
                            "device_id": device_id,
                            "session_id": session_id,
                        }),
                    )
                }
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
            let Some(identity) = identity else {
                return Reply::refused(message, "method_not_implemented");
            };
            if let Err(code) = confirm_keys(
                message,
                &[
                    "confirmation_token",
                    "profile_id",
                    "profile_revision",
                    "profile_hash",
                    "auth_epoch",
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
            let requirement = match parse_requirement(message.get("listener_requirement")) {
                Some(r) => r,
                None => return Reply::refused(message, "schema"),
            };
            if token.is_empty() || profile_id.is_empty() {
                return Reply::refused(message, "shape");
            }
            let profile_revision = text("profile_revision");
            let profile_hash = text("profile_hash");
            let auth_epoch = text("auth_epoch");
            if !canonical_uint_text(profile_revision)
                || profile_revision
                    .parse::<u64>()
                    .ok()
                    .is_none_or(|value| value == 0)
                || profile_hash.len() != 64
                || !profile_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !canonical_uint_text(auth_epoch)
                || auth_epoch.parse::<u64>().is_err()
            {
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
                Ok(Some(Ok(confirmed))) => {
                    let listener_identity_hash = confirmed.listener_identity_hash;
                    let port = confirmed.port;
                    let listener_signer_thumbprint = confirmed.signer_thumbprint;
                    let listener_owner_sid = hex_encode(&confirmed.owner_sid);
                    let listener_owner_is_current_user = confirmed.owner_is_current_user;
                    let (session_tx, session_rx) = oneshot::channel();
                    if node
                        .send(NodeRequest::CurrentSession { reply: session_tx })
                        .await
                        .is_err()
                    {
                        return Reply::refused(message, "shape");
                    }
                    let (org_id, subject_id, device_id, session_id) = match session_rx.await {
                        Ok(Ok(value))
                            if identity.signed_org() == Some(value.0.as_str())
                                && identity.signed_subject() == Some(value.1.as_str())
                                && identity.device_id() == Some(value.2.as_str())
                                && uuid::Uuid::parse_str(&value.3).is_ok() =>
                        {
                            value
                        }
                        _ => return Reply::refused(message, "no_pairing"),
                    };
                    let expires_at = match std::time::SystemTime::now()
                        .checked_add(std::time::Duration::from_secs(60))
                        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                        .and_then(|value| {
                            crate::frame::rfc3339::format_utc_seconds(value.as_secs())
                        }) {
                        Some(value) => value,
                        None => return Reply::refused(message, "shape"),
                    };
                    let local_ref = format!("http://127.0.0.1:{port}");
                    let binding_hash = model_binding_hash(&[
                        &org_id,
                        &device_id,
                        &session_id,
                        profile_id,
                        profile_revision,
                        profile_hash,
                        &local_ref,
                        &listener_identity_hash,
                    ]);
                    let proof = json!({
                        "v": "1",
                        "org_id": org_id,
                        "subject_id": subject_id,
                        "auth_epoch": auth_epoch,
                        "device_id": device_id,
                        "session_id": session_id,
                        "profile_id": profile_id,
                        "profile_revision": profile_revision,
                        "profile_hash": profile_hash,
                        "binding_hash": binding_hash,
                        "local_ref": local_ref,
                        "listener_identity_hash": listener_identity_hash,
                        "listener_signer_thumbprint": listener_signer_thumbprint,
                        "listener_owner_sid": listener_owner_sid,
                        "listener_owner_is_current_user": listener_owner_is_current_user,
                        "nonce": uuid::Uuid::new_v4().simple().to_string(),
                        "expires_at": expires_at,
                    });
                    let signature = match identity.sign_model_binding(
                        &proof,
                        proof["org_id"].as_str().unwrap_or(""),
                        proof["subject_id"].as_str().unwrap_or(""),
                    ) {
                        Ok(value) => value,
                        Err(IdentityError::NoPairing) => {
                            return Reply::refused(message, "no_pairing")
                        }
                        Err(_) => return Reply::refused(message, "shape"),
                    };
                    Reply::accepted_with(
                        message,
                        json!({
                            "profile_id": profile_id,
                            "binding_hash": binding_hash,
                            "native_confirmation_proof": proof,
                            "signature": signature,
                        }),
                    )
                }
                // identity_mismatch / unpublishable requirement: the binding did not verify.
                Ok(Some(Err(_))) => Reply::refused(message, "shape"),
                Ok(None) => Reply::accepted(message),
                Err(_) => Reply::refused(message, "shape"),
            }
        }
        "openLocalContent" => {
            if let Err(code) = confirm_keys(message, &["kind", "id"]) {
                return Reply::refused(message, code);
            }
            let kind = text("kind");
            let id = text("id");
            if !matches!(
                kind,
                "approval" | "run_transcript" | "artifact_version" | "artifact_edit"
            ) || id.is_empty()
                || id.len() > 512
                || id.contains('\x00')
            {
                return Reply::refused(message, "shape");
            }
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::OpenLocalContent {
                    kind: kind.to_string(),
                    id: id.to_string(),
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Reply::accepted_with(message, json!({ "status": "not_on_this_device" }));
            }
            let body = match rx.await {
                Ok(Some(body)) => body,
                _ => {
                    return Reply::accepted_with(message, json!({ "status": "not_on_this_device" }))
                }
            };
            local_content_reply(message, kind, id, body)
        }
        "listLocalArtifactDrafts" => {
            if let Err(code) = confirm_keys(message, &["artifact_id", "task_id"]) {
                return Reply::refused(message, code);
            }
            let artifact_id = text("artifact_id");
            let task_id = text("task_id");
            if uuid::Uuid::parse_str(artifact_id).is_err()
                || uuid::Uuid::parse_str(task_id).is_err()
            {
                return Reply::refused(message, "shape");
            }
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::ListLocalDrafts {
                    artifact_id: artifact_id.into(),
                    task_id: task_id.into(),
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Reply::accepted_with(message, json!({ "status": "not_on_this_device" }));
            }
            let drafts = match rx.await {
                Ok(drafts) => drafts,
                Err(_) => {
                    return Reply::accepted_with(message, json!({ "status": "not_on_this_device" }))
                }
            };
            let items: Vec<Value> = drafts
                .into_iter()
                .map(|row| {
                    let format = match row.format.as_str() {
                        "md" => "text/markdown",
                        _ => "text/plain",
                    };
                    json!({
                        "version_id": row.version_id,
                        "request_id": row.request_id,
                        "artifact_id": row.artifact_id,
                        "task_id": row.task_id,
                        "base_version_id": row.base_version_id,
                        "base_version_no": row.base_version_no.to_string(),
                        "base_hash": row.base_hash,
                        "format": format,
                        "content_hash": row.content_hash,
                        "byte_count": row.byte_count.to_string(),
                        "base_byte_count": row.base_byte_count.to_string(),
                        "publish_state": row.publish_state,
                        "created_at": row.created_at.to_string(),
                        "clipboard_derived": row.clipboard_derived,
                        "clipboard_source_version_ids": row.clipboard_source_version_ids,
                    })
                })
                .collect();
            Reply::accepted_with(message, json!({ "status": "available", "items": items }))
        }
        "prepareLocalArtifactEdit" => {
            if let Err(code) = confirm_keys(
                message,
                &[
                    "client_request_id",
                    "version_id",
                    "artifact_id",
                    "task_id",
                    "base_version_no",
                    "base_version_id",
                    "base_hash",
                    "auth_epoch",
                    "format",
                    "content_hash",
                    "byte_count",
                    "body",
                    "clipboard_derived",
                    "clipboard_source_version_ids",
                ],
            ) {
                return Reply::refused(message, code);
            }
            let digest = |value: &str| {
                let raw = value.strip_prefix("sha256:").unwrap_or(value);
                if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return None;
                }
                Some(format!("sha256:{}", raw.to_ascii_lowercase()))
            };
            let request_id = text("client_request_id");
            let version_id = text("version_id");
            let artifact_id = text("artifact_id");
            let task_id = text("task_id");
            let base_version_id = text("base_version_id");
            if [
                request_id,
                version_id,
                artifact_id,
                task_id,
                base_version_id,
            ]
            .iter()
            .any(|value| uuid::Uuid::parse_str(value).is_err())
            {
                return Reply::refused(message, "shape");
            }
            let Ok(base_version_no) = text("base_version_no").parse::<u32>() else {
                return Reply::refused(message, "shape");
            };
            if base_version_no == 0 {
                return Reply::refused(message, "shape");
            }
            let Some(base_hash) = digest(text("base_hash")) else {
                return Reply::refused(message, "shape");
            };
            let Some(content_hash) = digest(text("content_hash")) else {
                return Reply::refused(message, "shape");
            };
            let Ok(auth_epoch) = text("auth_epoch").parse::<u64>() else {
                return Reply::refused(message, "shape");
            };
            let format = match text("format") {
                "text/markdown" => "md",
                "text/plain" => "txt",
                _ => return Reply::refused(message, "shape"),
            };
            let body = text("body");
            if body.len() > 1024 * 1024 || body.contains('\x00') {
                return Reply::refused(message, "shape");
            }
            let byte_count = match text("byte_count").parse::<u64>() {
                Ok(value) if value == body.len() as u64 => value,
                _ => return Reply::refused(message, "shape"),
            };
            if crate::sha256_hex(body.as_bytes())
                != content_hash
                    .strip_prefix("sha256:")
                    .unwrap_or(&content_hash)
            {
                return Reply::refused(message, "shape");
            }
            let clipboard_derived = match message.get("clipboard_derived") {
                Some(Value::Bool(value)) => *value,
                _ => return Reply::refused(message, "shape"),
            };
            let clipboard_source_version_ids = match message.get("clipboard_source_version_ids") {
                Some(Value::Array(values)) => {
                    let mut sources = Vec::with_capacity(values.len());
                    for value in values {
                        let Some(source) = value.as_str() else {
                            return Reply::refused(message, "shape");
                        };
                        sources.push(source.to_owned());
                    }
                    sources
                }
                _ => return Reply::refused(message, "shape"),
            };
            if !crate::journal::local_content::valid_clipboard_sources(
                clipboard_derived,
                &clipboard_source_version_ids,
            ) {
                return Reply::refused(message, "shape");
            }
            let row = crate::journalop::LocalDraftRow {
                version_id: version_id.into(),
                request_id: request_id.into(),
                artifact_id: artifact_id.into(),
                task_id: task_id.into(),
                base_version_no,
                base_hash,
                format: format.into(),
                content_hash: content_hash.clone(),
                byte_count,
                publish_state: "pending_confirm".into(),
                created_at: 0,
                auth_epoch,
                base_version_id: base_version_id.into(),
                base_byte_count: 0,
                clipboard_derived,
                clipboard_source_version_ids,
            };
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::PrepareLocalDraft {
                    row,
                    body: body.into(),
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Reply::refused(message, "shape");
            }
            match rx.await {
                Ok(Ok(row)) => Reply::accepted_with(
                    message,
                    json!({
                        "status": "pending_confirm",
                        "request_id": row.request_id,
                        "version_id": row.version_id,
                        "content_hash": row.content_hash,
                        "byte_count": row.byte_count.to_string(),
                        "base_byte_count": row.base_byte_count.to_string(),
                    }),
                ),
                Ok(Err(_)) => Reply::refused(message, "invalid_work_request"),
                Err(_) => Reply::refused(message, "shape"),
            }
        }
        "decideLocalArtifactEdit" => {
            if let Err(code) = confirm_keys(message, &["draft_request_id", "sealed_hash", "action"])
            {
                return Reply::refused(message, code);
            }
            let request_id = text("draft_request_id");
            let sealed_hash = text("sealed_hash");
            let action = text("action");
            if uuid::Uuid::parse_str(request_id).is_err()
                || sealed_hash.len() != 71
                || !sealed_hash.starts_with("sha256:")
                || !sealed_hash[7..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !matches!(action, "discard" | "cancel" | "confirm")
            {
                return Reply::refused(message, "shape");
            }
            if action == "confirm" {
                let (tx, rx) = oneshot::channel();
                if node
                    .send(NodeRequest::ConfirmLocalDraft {
                        request_id: request_id.into(),
                        sealed_hash: sealed_hash.into(),
                        reply: tx,
                    })
                    .await
                    .is_err()
                {
                    return Reply::refused(message, "shape");
                }
                return match rx.await {
                    Ok(Some(confirmed)) => {
                        let extension = if confirmed.row.format == "md" {
                            "md"
                        } else {
                            "txt"
                        };
                        Reply::accepted_with(
                            message,
                            json!({
                                "status": confirmed.row.publish_state,
                                "request_id": confirmed.row.request_id,
                                "version_id": confirmed.row.version_id,
                                "artifact_id": confirmed.row.artifact_id,
                                "device_id": confirmed.proof["device_id"],
                                "session_id": confirmed.proof["session_id"],
                                "local_ref": format!("local/{}.{}", confirmed.row.version_id, extension),
                                "content_hash": confirmed.row.content_hash,
                                "byte_count": confirmed.row.byte_count.to_string(),
                                "user_version_proof": confirmed.proof,
                                "signature": confirmed.signature,
                            }),
                        )
                    }
                    Ok(None) => {
                        Reply::accepted_with(message, json!({ "status": "not_on_this_device" }))
                    }
                    Err(_) => Reply::refused(message, "shape"),
                };
            }
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::DecideLocalDraft {
                    request_id: request_id.into(),
                    sealed_hash: sealed_hash.into(),
                    action: action.into(),
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Reply::refused(message, "shape");
            }
            match rx.await {
                Ok(Some(row)) => Reply::accepted_with(
                    message,
                    json!({
                        "status": row.publish_state,
                        "request_id": row.request_id,
                        "version_id": row.version_id,
                        "content_hash": row.content_hash,
                    }),
                ),
                Ok(None) => {
                    Reply::accepted_with(message, json!({ "status": "not_on_this_device" }))
                }
                Err(_) => Reply::refused(message, "shape"),
            }
        }
        "completeLocalArtifactEdit" => {
            if let Err(code) =
                confirm_keys(message, &["draft_request_id", "sealed_hash", "publish_ack"])
            {
                return Reply::refused(message, code);
            }
            let request_id = text("draft_request_id");
            let sealed_hash = text("sealed_hash");
            let publish_ack = text("publish_ack");
            if uuid::Uuid::parse_str(request_id).is_err()
                || sealed_hash.len() != 71
                || !sealed_hash.starts_with("sha256:")
                || publish_ack.len() != 71
                || !publish_ack.starts_with("sha256:")
            {
                return Reply::refused(message, "shape");
            }
            let (tx, rx) = oneshot::channel();
            if node
                .send(NodeRequest::CompleteLocalDraft {
                    request_id: request_id.into(),
                    sealed_hash: sealed_hash.into(),
                    publish_ack: publish_ack.into(),
                    reply: tx,
                })
                .await
                .is_err()
            {
                return Reply::refused(message, "shape");
            }
            match rx.await {
                Ok(true) => Reply::accepted_with(message, json!({ "status": "published" })),
                Ok(false) => {
                    Reply::accepted_with(message, json!({ "status": "not_on_this_device" }))
                }
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

    #[tokio::test]
    async fn model_probe_receipt_ipc_refuses_malformed_or_unpaired_requests() {
        let signer: crate::journalop::ApprovalSignerSlot =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        let cases = [
            (
                json!({ "method": "unknown", "request_id": "r1" }),
                "unknown_method",
            ),
            (
                json!({ "method": "getModelProbeReceipts", "request_id": "r2" }),
                "schema",
            ),
            (
                json!({ "method": "getModelProbeReceipts", "request_id": "r3", "auth_epoch": "1", "extra": true }),
                "schema",
            ),
            (
                json!({ "method": "getModelProbeReceipts", "request_id": "r4", "auth_epoch": "bad" }),
                "shape",
            ),
            (
                json!({ "method": "getModelProbeReceipts", "request_id": "r5", "auth_epoch": "1" }),
                "no_pairing",
            ),
            (
                json!({ "method": "confirmModelProbeReceiptDelivery", "request_id": "r6" }),
                "schema",
            ),
            (
                json!({ "method": "confirmModelProbeReceiptDelivery", "request_id": "r7", "model_result_id": "bad" }),
                "shape",
            ),
            (
                json!({ "method": "confirmModelProbeReceiptDelivery", "request_id": "r8", "model_result_id": "55555555-5555-4555-8555-555555555555" }),
                "no_pairing",
            ),
        ];
        for (message, code) in cases {
            let reply = model_probe_receipt_reply(&signer, &message).await;
            assert_eq!(reply.result, REFUSED, "{message}");
            assert_eq!(reply.code, Some(code), "{message}");
            assert_eq!(reply.data, None, "{message}");
            assert_eq!(reply.request_id, message["request_id"].as_str().unwrap());
        }
    }

    #[test]
    fn model_binding_hash_matches_the_server_vector() {
        assert_eq!(
            model_binding_hash(&[
                "org-1",
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
                "profile-dev-fixture-v1",
                "1",
                "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                "http://127.0.0.1:11434",
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            ]),
            "9a6a954d8ac278f9dba441f35ad02e5da95df7af3c7836f8f311a1a1305b5059"
        );
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

    #[cfg(windows)]
    #[tokio::test]
    async fn list_workspace_grants_returns_metadata_only() {
        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::ListWorkspaceGrants { reply } => {
                    reply
                        .send(vec![json!({
                            "grant_id": "11111111-1111-4111-8111-111111111111",
                            "root_identity_hash": "a".repeat(64),
                            "artifact_dir": ["WeMeet成果"],
                        })])
                        .unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = confirmation_reply(
            &node,
            &json!({ "method": "listWorkspaceGrants", "request_id": "list-grants-1" }),
        )
        .await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(data_keys(&reply), ["grants", "status"]);
        let data = reply.data.unwrap();
        assert_eq!(data["status"], "available");
        assert_eq!(data["grants"][0]["artifact_dir"], json!(["WeMeet成果"]));
        assert!(data["grants"][0].get("path").is_none());
        worker.await.unwrap();
    }

    fn local_submission_message() -> Value {
        json!({
            "method": "confirmLocalSubmission",
            "request_id": "pipe-request-1",
            "approved": true,
            "client_request_id": "local-submit-1",
            "input_ref": "44444444-4444-4444-8444-444444444444",
            "input_hash": "a".repeat(64),
            "preview_hash": "p1.preview.signature",
            "target_selection_hash": "b".repeat(64),
            "selected_grant_ids": ["33333333-3333-4333-8333-333333333333"],
            "grant_revisions": ["1"],
            "profile_id": "local-profile",
            "profile_revision": "2",
            "profile_hash": "c".repeat(64),
            "auth_epoch": "4",
        })
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn local_submission_is_session_bound_and_device_signed() {
        let mut identity =
            crate::identity::test_identity_with_device("11111111-1111-4111-8111-111111111111");
        identity
            .sign_pairing("pair-1", "challenge", "org-1", "sub-1")
            .unwrap();
        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::ValidateLocalSubmission {
                    input_ref,
                    input_hash,
                    selected_grant_ids,
                    reply,
                } => {
                    assert_eq!(input_ref, "44444444-4444-4444-8444-444444444444");
                    assert_eq!(input_hash, "a".repeat(64));
                    assert_eq!(
                        selected_grant_ids,
                        vec!["33333333-3333-4333-8333-333333333333".to_string()]
                    );
                    reply
                        .send(Ok((
                            "org-1".into(),
                            "sub-1".into(),
                            "11111111-1111-4111-8111-111111111111".into(),
                            "22222222-2222-4222-8222-222222222222".into(),
                        )))
                        .unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = submission_reply(&mut identity, &node, &local_submission_message()).await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        let data = reply.data.unwrap();
        assert_eq!(data["status"], "ready");
        let proof = &data["local_intent"];
        assert_eq!(proof.as_object().unwrap().len(), 19);
        assert_eq!(proof["request_id"], "local-submit-1");
        assert_eq!(proof["session_id"], "22222222-2222-4222-8222-222222222222");
        assert_eq!(proof["org_id"], "org-1");
        assert_eq!(proof["subject_id"], "sub-1");
        assert!(proof.get("input_ref").is_none());
        assert!(crate::frame::sign::verify_frame(
            &identity.public_jwk(),
            crate::frame::intent::FRAME_TYPE,
            proof,
            proof["signature"].as_str().unwrap()
        ));
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn local_submission_cancel_returns_no_proof() {
        let mut identity = crate::identity::test_identity();
        let (node, _requests) = mpsc::channel(1);
        let mut message = local_submission_message();
        message["approved"] = json!(false);
        let reply = submission_reply(&mut identity, &node, &message).await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert!(reply.data.is_none());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn local_submission_refuses_open_payload_and_unavailable_input() {
        let mut identity =
            crate::identity::test_identity_with_device("11111111-1111-4111-8111-111111111111");
        identity
            .sign_pairing("pair-1", "challenge", "org-1", "sub-1")
            .unwrap();
        let (node, mut requests) = mpsc::channel(1);
        let mut open = local_submission_message();
        open["path"] = json!("C:\\secret");
        let reply = submission_reply(&mut identity, &node, &open).await;
        assert_eq!(reply.result, REFUSED, "{reply:?}");
        assert_eq!(reply.code, Some("schema"));
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::ValidateLocalSubmission { reply, .. } => {
                    reply.send(Err("input_mismatch".into())).unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = submission_reply(&mut identity, &node, &local_submission_message()).await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(reply.data.unwrap()["status"], "unavailable");
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn rebind_proof_is_root_bound_and_device_signed() {
        let mut identity = crate::identity::test_identity();
        identity
            .sign_pairing("pair-1", "challenge", "org-1", "sub-1")
            .unwrap();
        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::GrantRootIdentity { reply, .. } => {
                    reply
                        .send(Ok((
                            "a".repeat(64),
                            "55555555-5555-4555-8555-555555555555".to_string(),
                        )))
                        .unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let message = json!({
            "method": "rebindRunWorkspace",
            "request_id": "req-rebind",
            "run_id": "44444444-4444-4444-8444-444444444444",
            "old_grant_id": "11111111-1111-4111-8111-111111111111",
            "new_grant_id": "22222222-2222-4222-8222-222222222222",
            "auth_epoch": "7",
        });
        let reply = rebind_reply(&mut identity, &node, &message).await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        let proof = reply.data.unwrap();
        assert_eq!(proof["root_identity_hash"], "a".repeat(64));
        assert_eq!(proof["session_id"], "55555555-5555-4555-8555-555555555555");
        assert_eq!(proof["auth_epoch"], "7");
        let signature = proof["signature"].as_str().unwrap();
        assert!(crate::grantsuccession::verify(
            &identity.public_jwk(),
            &proof,
            signature
        ));
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn rebind_refuses_without_the_broker_session() {
        let mut identity = crate::identity::test_identity();
        identity
            .sign_pairing("pair-1", "challenge", "org-1", "sub-1")
            .unwrap();
        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::GrantRootIdentity { reply, .. } => {
                    reply.send(Err("no_session".to_string())).unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = rebind_reply(
            &mut identity,
            &node,
            &json!({
                "method": "rebindRunWorkspace",
                "request_id": "req-rebind",
                "run_id": "44444444-4444-4444-8444-444444444444",
                "old_grant_id": "11111111-1111-4111-8111-111111111111",
                "new_grant_id": "22222222-2222-4222-8222-222222222222",
                "auth_epoch": "7",
            }),
        )
        .await;
        assert_eq!(reply.result, REFUSED, "{reply:?}");
        assert_eq!(reply.code, Some("shape"));
        worker.await.unwrap();
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
        identity_jwk: crate::jwk::EcP256Jwk,
        #[cfg(windows)]
        _journal_inbox: Option<
            mpsc::Receiver<(
                crate::journalop::JournalOp,
                oneshot::Sender<crate::journalop::JournalReply>,
            )>,
        >,
        handle: tokio::task::JoinHandle<BridgeOutcome>,
    }

    impl Harness {
        fn new() -> Self {
            Self::with_identity(crate::identity::test_identity())
        }

        fn with_identity(identity: crate::identity::Identity) -> Self {
            let (delivery_tx, delivery_rx) = mpsc::channel(4);
            let (link_tx, link_rx) = mpsc::channel(8);
            let (ticket_tx, ticket_rx) = mpsc::channel(1);
            let (core_tx, core_rx) = mpsc::channel(8);
            let (ready_tx, ready_rx) = mpsc::channel(4);
            #[cfg(windows)]
            let (node, journal_inbox) = {
                let node = crate::nodeservice::spawn_node_service();
                let (journal, journal_inbox) = crate::journalop::channel();
                node.try_send(crate::nodeservice::NodeRequest::SetJournal {
                    journal,
                    org_id: "org-1".into(),
                    subject_id: "sub-1".into(),
                    device_id: "11111111-1111-4111-8111-111111111111".into(),
                })
                .unwrap();
                node.try_send(crate::nodeservice::NodeRequest::SetLocalSession {
                    session_id: "22222222-2222-4222-8222-222222222222".into(),
                })
                .unwrap();
                (node, Some(journal_inbox))
            };
            let identity_jwk = identity.public_jwk();
            let handle = tokio::spawn(run_core_pump(
                identity,
                TicketSlot::new("dev-1"),
                delivery_rx,
                link_rx,
                ticket_tx,
                core_tx,
                ready_tx,
                std::sync::Arc::new(std::sync::Mutex::new(None)),
                #[cfg(windows)]
                node,
            ));
            Self {
                deliveries: Some(delivery_tx),
                link_events: Some(link_tx),
                tickets: Some(ticket_rx),
                core_events: Some(core_rx),
                ready: Some(ready_rx),
                identity_jwk,
                #[cfg(windows)]
                _journal_inbox: journal_inbox,
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
    async fn probe_receipt_methods_enforce_shape_before_pairing() {
        let mut h = Harness::new();
        let extra = h
            .deliver(json!({
                "method": "getModelProbeReceipts", "request_id": "probe-extra",
                "auth_epoch": "4", "extra": true,
            }))
            .await;
        assert_eq!(extra.code, Some("schema"));
        let unpaired = h
            .deliver(json!({
                "method": "getModelProbeReceipts", "request_id": "probe-unpaired",
                "auth_epoch": "4",
            }))
            .await;
        assert_eq!(unpaired.code, Some("no_pairing"));
        let bad_id = h
            .deliver(json!({
                "method": "confirmModelProbeReceiptDelivery", "request_id": "probe-bad-id",
                "model_result_id": "not-a-uuid",
            }))
            .await;
        assert_eq!(bad_id.code, Some("shape"));
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
                "device_id",
                "differs_from_selected",
                "other_user_writable",
                "root_identity_hash",
                "selected_path",
                "session_id",
                "volume_label"
            ]
        );
        let token = prepare.data.as_ref().unwrap()["confirmation_token"]
            .as_str()
            .unwrap()
            .to_string();
        let prepare_data = prepare.data.unwrap();
        assert_eq!(
            prepare_data["device_id"],
            "11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(
            prepare_data["session_id"],
            "22222222-2222-4222-8222-222222222222"
        );
        assert!(prepare_data["root_identity_hash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));

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

    #[cfg(windows)]
    #[tokio::test]
    async fn open_local_content_returns_closed_viewer_body_for_artifact_version() {
        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::OpenLocalContent { kind, id, reply } => {
                    assert_eq!(kind, "artifact_version");
                    assert_eq!(id, "v-1");
                    reply
                        .send(Some(crate::journalop::LocalContentBody {
                            row: crate::journalop::DeliverableRow {
                                run_id: "run".into(),
                                operation_id: "op".into(),
                                version_id: "v-1".into(),
                                logical_name: "artifact".into(),
                                format: "md".into(),
                                content_hash: "a".repeat(64),
                                byte_count: 4,
                                receipt_seq: None,
                                publish_state: "sealed".into(),
                            },
                            bytes: b"# hi".to_vec(),
                        }))
                        .unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let message = json!({
            "method": "openLocalContent", "request_id": "open-1",
            "kind": "artifact_version", "id": "v-1",
        });
        let reply = confirmation_reply(&node, &message).await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(
            data_keys(&reply),
            ["byte_count", "content_hash", "format", "status", "text"]
        );
        let data = reply.data.unwrap();
        assert_eq!(data["status"], "available");
        assert_eq!(data["format"], "text/markdown");
        assert_eq!(data["text"], "# hi");
        assert_eq!(data["byte_count"], "4");
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn local_content_export_returns_only_closed_metadata() {
        let version_id = "55555555-5555-4555-8555-555555555555";
        let body = crate::journalop::LocalContentBody {
            row: crate::journalop::DeliverableRow {
                run_id: "run".into(),
                operation_id: "op".into(),
                version_id: version_id.into(),
                logical_name: "artifact".into(),
                format: "md".into(),
                content_hash: crate::sha256_hex(b"# hi"),
                byte_count: 4,
                receipt_seq: None,
                publish_state: "published".into(),
            },
            bytes: b"# hi".to_vec(),
        };
        let message = json!({
            "method": "exportArtifactVersion", "request_id": "export-1",
            "version_id": version_id,
        });
        let reply = local_content_export_reply(&message, version_id, body);
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(
            data_keys(&reply),
            [
                "byte_count",
                "content_hash",
                "format",
                "status",
                "version_id"
            ]
        );
        let data = reply.data.unwrap();
        assert_eq!(data["status"], "ready");
        assert_eq!(data["format"], "text/markdown");
        assert_eq!(data["byte_count"], "4");
        assert!(data.get("text").is_none());
        assert!(data.get("path").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn local_content_export_refuses_tampered_sealed_bytes() {
        let version_id = "55555555-5555-4555-8555-555555555555";
        let body = crate::journalop::LocalContentBody {
            row: crate::journalop::DeliverableRow {
                run_id: "run".into(),
                operation_id: "op".into(),
                version_id: version_id.into(),
                logical_name: "artifact".into(),
                format: "txt".into(),
                content_hash: "a".repeat(64),
                byte_count: 4,
                receipt_seq: None,
                publish_state: "published".into(),
            },
            bytes: b"# hi".to_vec(),
        };
        let message = json!({
            "method": "exportArtifactVersion", "request_id": "export-2",
            "version_id": version_id,
        });
        let reply = local_content_export_reply(&message, version_id, body);
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(reply.data.unwrap()["status"], "not_on_this_device");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn open_local_content_returns_validated_approval_body() {
        let approval_id = "11111111-1111-4111-8111-111111111111";
        let text = json!({
            "approval_id": approval_id,
            "operation_id": "22222222-2222-4222-8222-222222222222",
            "logical_key": "tool:0#0",
            "step_key": "tool:0",
            "state": "waiting_approval",
            "classification": "local_only",
            "destination_id": null,
            "request_hash": "a".repeat(64),
            "action": { "kind": "artifact.write", "request": { "args": {} } },
        })
        .to_string();
        let worker_text = text.clone();
        let (node, mut requests) = mpsc::channel(2);
        let worker = tokio::spawn(async move {
            for expected in [
                worker_text.clone(),
                worker_text.replace("waiting_approval", "authorized"),
            ] {
                match requests.recv().await.unwrap() {
                    crate::nodeservice::NodeRequest::OpenLocalContent { kind, id, reply } => {
                        assert_eq!(kind, "approval");
                        assert_eq!(id, approval_id);
                        let body = expected;
                        reply
                            .send(Some(crate::journalop::LocalContentBody {
                                row: crate::journalop::DeliverableRow {
                                    run_id: "run".into(),
                                    operation_id: "22222222-2222-4222-8222-222222222222".into(),
                                    version_id: approval_id.into(),
                                    logical_name: "artifact.write".into(),
                                    format: "json".into(),
                                    content_hash: crate::sha256_hex(body.as_bytes()),
                                    byte_count: body.len() as u64,
                                    receipt_seq: None,
                                    publish_state: "sealed".into(),
                                },
                                bytes: body.into_bytes(),
                            }))
                            .unwrap();
                    }
                    _ => panic!("unexpected node request"),
                }
            }
        });
        let message = |request_id: &str| {
            json!({
                "method": "openLocalContent", "request_id": request_id,
                "kind": "approval", "id": approval_id,
            })
        };
        let valid = confirmation_reply(&node, &message("approval-open-1")).await;
        assert_eq!(valid.result, ACCEPTED, "{valid:?}");
        let data = valid.data.unwrap();
        assert_eq!(data["status"], "available");
        assert_eq!(data["format"], "text/plain");
        assert_eq!(data["text"], text);
        let invalid = confirmation_reply(&node, &message("approval-open-2")).await;
        assert_eq!(invalid.result, ACCEPTED);
        assert_eq!(invalid.data.unwrap()["status"], "not_on_this_device");
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn open_local_content_reads_approval_from_journal_while_node_is_busy() {
        let approval_id = "11111111-1111-4111-8111-111111111111";
        let text = json!({
            "approval_id": approval_id,
            "operation_id": "22222222-2222-4222-8222-222222222222",
            "logical_key": "tool:0#0",
            "step_key": "tool:0",
            "state": "waiting_approval",
            "classification": "local_only",
            "destination_id": null,
            "request_hash": "a".repeat(64),
            "action": { "kind": "artifact.write", "request": { "args": {} } },
        })
        .to_string();
        let (journal, mut operations) = crate::journalop::channel();
        let worker_text = text.clone();
        let worker = tokio::spawn(async move {
            let (op, reply) = operations.recv().await.unwrap();
            match op {
                crate::journalop::JournalOp::ReadLocalApproval {
                    org_id,
                    subject_id,
                    approval_id: requested,
                } => {
                    assert_eq!(org_id, "org-1");
                    assert_eq!(subject_id, "subject-1");
                    assert_eq!(requested, approval_id);
                    reply
                        .send(crate::journalop::JournalReply::LocalApproval(Ok(Some(
                            crate::journalop::LocalContentBody {
                                row: crate::journalop::DeliverableRow {
                                    run_id: "run-1".into(),
                                    operation_id: "22222222-2222-4222-8222-222222222222".into(),
                                    version_id: approval_id.into(),
                                    logical_name: "artifact.write".into(),
                                    format: "json".into(),
                                    content_hash: crate::sha256_hex(worker_text.as_bytes()),
                                    byte_count: worker_text.len() as u64,
                                    receipt_seq: None,
                                    publish_state: "sealed".into(),
                                },
                                bytes: worker_text.into_bytes(),
                            },
                        ))))
                        .unwrap();
                }
                _ => panic!("unexpected journal operation"),
            }
        });
        let signer: crate::journalop::ApprovalSignerSlot = std::sync::Arc::new(
            std::sync::Mutex::new(Some(crate::journalop::ApprovalSigner {
                journal,
                org_id: "org-1".into(),
                subject_id: "subject-1".into(),
                device_id: "device-1".into(),
                session_id: Some("session-1".into()),
            })),
        );
        let (node, _requests) = mpsc::channel(1);
        let reply = tokio::time::timeout(
            Duration::from_secs(1),
            open_local_content_reply(
                &signer,
                &node,
                &json!({
                    "method": "openLocalContent",
                    "request_id": "approval-open-busy",
                    "kind": "approval",
                    "id": approval_id,
                }),
            ),
        )
        .await
        .expect("approval content read waited on the busy Node service");
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        let data = reply.data.unwrap();
        assert_eq!(data["status"], "available");
        assert_eq!(data["text"], text);
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn open_local_content_returns_validated_run_transcript() {
        let text = json!({
            "run_id": "run-1",
            "turn_count": "2",
            "messages": [{ "role": "assistant", "content": "local transcript" }],
        })
        .to_string();
        let worker_text = text.clone();
        let (node, mut requests) = mpsc::channel(2);
        let worker = tokio::spawn(async move {
            for expected in [worker_text.clone(), worker_text.replace("\"2\"", "\"x\"")] {
                match requests.recv().await.unwrap() {
                    crate::nodeservice::NodeRequest::OpenLocalContent { kind, id, reply } => {
                        assert_eq!(kind, "run_transcript");
                        assert_eq!(id, "run-1");
                        reply
                            .send(Some(crate::journalop::LocalContentBody {
                                row: crate::journalop::DeliverableRow {
                                    run_id: "run-1".into(),
                                    operation_id: String::new(),
                                    version_id: "run-1".into(),
                                    logical_name: "run_transcript".into(),
                                    format: "json".into(),
                                    content_hash: crate::sha256_hex(expected.as_bytes()),
                                    byte_count: expected.len() as u64,
                                    receipt_seq: None,
                                    publish_state: "sealed".into(),
                                },
                                bytes: expected.into_bytes(),
                            }))
                            .unwrap();
                    }
                    _ => panic!("unexpected node request"),
                }
            }
        });
        let message = |request_id: &str| {
            json!({
                "method": "openLocalContent", "request_id": request_id,
                "kind": "run_transcript", "id": "run-1",
            })
        };
        let valid = confirmation_reply(&node, &message("transcript-open-1")).await;
        assert_eq!(valid.result, ACCEPTED, "{valid:?}");
        let data = valid.data.unwrap();
        assert_eq!(data["status"], "available");
        assert_eq!(data["format"], "text/plain");
        assert_eq!(data["text"], text);
        let invalid = confirmation_reply(&node, &message("transcript-open-2")).await;
        assert_eq!(invalid.result, ACCEPTED);
        assert_eq!(invalid.data.unwrap()["status"], "not_on_this_device");
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn open_local_content_rejects_unknown_kinds_and_extra_fields() {
        let (node, _requests) = mpsc::channel(1);
        let unsupported = confirmation_reply(
            &node,
            &json!({
                "method": "openLocalContent", "request_id": "open-2",
                "kind": "model_log", "id": "run-1",
            }),
        )
        .await;
        assert_eq!(unsupported.code, Some("shape"));
        let extra = confirmation_reply(
            &node,
            &json!({
                "method": "openLocalContent", "request_id": "open-3",
                "kind": "artifact_version", "id": "v-1", "path": "C:\\secret",
            }),
        )
        .await;
        assert_eq!(extra.code, Some("schema"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn prepare_local_approval_decision_returns_only_the_signed_proof() {
        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::PrepareLocalApprovalDecision { input, reply } => {
                    assert_eq!(input.approval_id, "33333333-3333-4333-8333-333333333333");
                    assert_eq!(input.operation_id, "44444444-4444-4444-8444-444444444444");
                    assert_eq!(input.decision, "approved");
                    assert!(!input.remember_readonly);
                    reply
                        .send(Some(json!({
                            "v": 1,
                            "approval_id": input.approval_id,
                            "signature": "A".repeat(86),
                        })))
                        .unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = confirmation_reply(
            &node,
            &json!({
                "method": "prepareLocalApprovalDecision",
                "request_id": "approval-prepare-1",
                "approval_id": "33333333-3333-4333-8333-333333333333",
                "operation_id": "44444444-4444-4444-8444-444444444444",
                "params_hash": "a".repeat(64),
                "expected_revision": "0",
                "decision": "approved",
                "remember_readonly": false,
                "readonly_scope": null,
                "readonly_expires_at": null,
                "policy_epoch": "0",
                "access_epoch": "0",
                "auth_epoch": "4",
            }),
        )
        .await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(data_keys(&reply), ["approval_decision_proof", "status"]);
        assert_eq!(reply.data.unwrap()["status"], "ready");
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn prepare_local_acceptance_returns_only_bound_proof_metadata() {
        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::PrepareLocalAcceptance { input, reply } => {
                    assert_eq!(input.task_id, "22222222-2222-4222-8222-222222222222");
                    assert_eq!(input.artifact_id, "11111111-1111-4111-8111-111111111111");
                    assert_eq!(input.version_id, "77777777-7777-4777-8777-777777777777");
                    assert_eq!(input.content_hash, "a".repeat(64));
                    assert_eq!(input.request_id, "accept-1");
                    reply
                        .send(Some(json!({
                            "proof": {
                                "v": 1,
                                "device_id": "abcdefab-abcd-abcd-abcd-abcdefabcdef",
                                "session_id": "33333333-3333-4333-8333-333333333333",
                                "task_id": input.task_id,
                                "artifact_id": input.artifact_id,
                                "version_id": input.version_id,
                                "content_hash": input.content_hash,
                                "purpose": "accept",
                                "request_id": input.request_id,
                            },
                            "signature": "A".repeat(86),
                        })))
                        .unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = confirmation_reply(
            &node,
            &json!({
                "method": "prepareLocalAcceptance",
                "request_id": "accept-1",
                "task_id": "22222222-2222-4222-8222-222222222222",
                "artifact_id": "11111111-1111-4111-8111-111111111111",
                "version_id": "77777777-7777-4777-8777-777777777777",
                "content_hash": "a".repeat(64),
                "auth_epoch": "4",
            }),
        )
        .await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(
            data_keys(&reply),
            [
                "device_id",
                "possession_proof",
                "session_id",
                "signature",
                "status"
            ]
        );
        let data = reply.data.unwrap();
        assert_eq!(data["status"], "ready");
        assert_eq!(data["possession_proof"]["request_id"], "accept-1");
        assert!(data["possession_proof"].get("signature").is_none());
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn prepare_local_artifact_edit_carries_task_context_without_body_reply() {
        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::PrepareLocalDraft { row, body, reply } => {
                    assert_eq!(row.task_id, "22222222-2222-2222-2222-222222222222");
                    assert_eq!(row.artifact_id, "11111111-1111-1111-1111-111111111111");
                    assert_eq!(row.base_version_no, 4);
                    assert_eq!(row.format, "md");
                    assert_eq!(body, "edited body");
                    reply.send(Ok(row)).unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = confirmation_reply(
            &node,
            &json!({
                "method": "prepareLocalArtifactEdit",
                "request_id": "prepare-edit-1",
                "client_request_id": "44444444-4444-4444-4444-444444444444",
                "version_id": "33333333-3333-3333-3333-333333333333",
                "artifact_id": "11111111-1111-1111-1111-111111111111",
                "task_id": "22222222-2222-2222-2222-222222222222",
                "base_version_no": "4",
                "base_version_id": "55555555-5555-4555-8555-555555555555",
                "base_hash": format!("sha256:{}", "a".repeat(64)),
                "auth_epoch": "4",
                "format": "text/markdown",
                "content_hash": format!("sha256:{}", crate::sha256_hex(b"edited body")),
                "byte_count": "11",
                "body": "edited body",
                "clipboard_derived": true,
                "clipboard_source_version_ids": ["99999999-9999-4999-8999-999999999999"],
            }),
        )
        .await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(
            data_keys(&reply),
            [
                "base_byte_count",
                "byte_count",
                "content_hash",
                "request_id",
                "status",
                "version_id"
            ]
        );
        assert_eq!(reply.data.unwrap()["status"], "pending_confirm");
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn local_artifact_edit_rejects_hash_mismatch_and_supports_closed_decisions() {
        let (node, _requests) = mpsc::channel(1);
        let bad_hash = confirmation_reply(
            &node,
            &json!({
                "method": "prepareLocalArtifactEdit",
                "request_id": "prepare-edit-2",
                "client_request_id": "55555555-5555-5555-5555-555555555555",
                "version_id": "33333333-3333-3333-3333-333333333333",
                "artifact_id": "11111111-1111-1111-1111-111111111111",
                "task_id": "22222222-2222-2222-2222-222222222222",
                "base_version_no": "4",
                "base_version_id": "55555555-5555-4555-8555-555555555555",
                "base_hash": "a".repeat(64),
                "auth_epoch": "4", "format": "text/plain", "content_hash": "b".repeat(64),
                "byte_count": "2", "body": "ok",
                "clipboard_derived": false, "clipboard_source_version_ids": [],
            }),
        )
        .await;
        assert_eq!(bad_hash.code, Some("shape"));

        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::DecideLocalDraft {
                    request_id,
                    sealed_hash,
                    action,
                    reply,
                } => {
                    assert_eq!(request_id, "44444444-4444-4444-4444-444444444444");
                    assert_eq!(sealed_hash, format!("sha256:{}", "a".repeat(64)));
                    assert_eq!(action, "discard");
                    reply
                        .send(Some(crate::journalop::LocalDraftRow {
                            version_id: "33333333-3333-3333-3333-333333333333".into(),
                            request_id,
                            artifact_id: "11111111-1111-1111-1111-111111111111".into(),
                            task_id: "22222222-2222-2222-2222-222222222222".into(),
                            base_version_no: 4,
                            base_hash: "a".repeat(64),
                            format: "md".into(),
                            content_hash: sealed_hash,
                            byte_count: 11,
                            publish_state: "discarded".into(),
                            created_at: 1,
                            auth_epoch: 4,
                            base_version_id: "55555555-5555-4555-8555-555555555555".into(),
                            base_byte_count: 4,
                            clipboard_derived: false,
                            clipboard_source_version_ids: Vec::new(),
                        }))
                        .unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = confirmation_reply(
            &node,
            &json!({
                "method": "decideLocalArtifactEdit",
                "request_id": "decide-edit-1",
                "draft_request_id": "44444444-4444-4444-4444-444444444444",
                "sealed_hash": format!("sha256:{}", "a".repeat(64)),
                "action": "discard",
            }),
        )
        .await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(
            data_keys(&reply),
            ["content_hash", "request_id", "status", "version_id"]
        );
        assert_eq!(reply.data.unwrap()["status"], "discarded");
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn confirm_local_artifact_edit_returns_proof_without_body_and_completes_ack() {
        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::ConfirmLocalDraft {
                    request_id,
                    sealed_hash,
                    reply,
                } => {
                    assert_eq!(request_id, "44444444-4444-4444-4444-444444444444");
                    assert_eq!(sealed_hash, format!("sha256:{}", "a".repeat(64)));
                    reply
                        .send(Some(crate::journalop::LocalDraftConfirmation {
                            row: crate::journalop::LocalDraftRow {
                                version_id: "33333333-3333-3333-3333-333333333333".into(),
                                request_id,
                                artifact_id: "11111111-1111-1111-1111-111111111111".into(),
                                task_id: "22222222-2222-2222-2222-222222222222".into(),
                                base_version_no: 4,
                                base_hash: "a".repeat(64),
                                format: "md".into(),
                                content_hash: sealed_hash,
                                byte_count: 11,
                                publish_state: "pending_publish".into(),
                                created_at: 1,
                                auth_epoch: 4,
                                base_version_id: "55555555-5555-4555-8555-555555555555".into(),
                                base_byte_count: 4,
                                clipboard_derived: false,
                                clipboard_source_version_ids: Vec::new(),
                            },
                            proof: json!({
                                "device_id": "dddddddd-dddd-dddd-dddd-dddddddddddd",
                                "session_id": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
                            }),
                            signature: "signature-edit-1".into(),
                        }))
                        .unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = confirmation_reply(
            &node,
            &json!({
                "method": "decideLocalArtifactEdit", "request_id": "confirm-edit-1",
                "draft_request_id": "44444444-4444-4444-4444-444444444444",
                "sealed_hash": format!("sha256:{}", "a".repeat(64)), "action": "confirm",
            }),
        )
        .await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(
            data_keys(&reply),
            [
                "artifact_id",
                "byte_count",
                "content_hash",
                "device_id",
                "local_ref",
                "request_id",
                "session_id",
                "signature",
                "status",
                "user_version_proof",
                "version_id",
            ]
        );
        let data = reply.data.unwrap();
        assert_eq!(data["status"], "pending_publish");
        assert_eq!(data["signature"], "signature-edit-1");
        assert!(data["user_version_proof"].get("signature").is_none());
        assert!(data.get("body").is_none());
        worker.await.unwrap();

        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::CompleteLocalDraft {
                    request_id,
                    sealed_hash,
                    publish_ack,
                    reply,
                } => {
                    assert_eq!(request_id, "44444444-4444-4444-4444-444444444444");
                    assert_eq!(sealed_hash, format!("sha256:{}", "a".repeat(64)));
                    assert_eq!(publish_ack, format!("sha256:{}", "b".repeat(64)));
                    reply.send(true).unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = confirmation_reply(
            &node,
            &json!({
                "method": "completeLocalArtifactEdit", "request_id": "complete-edit-1",
                "draft_request_id": "44444444-4444-4444-4444-444444444444",
                "sealed_hash": format!("sha256:{}", "a".repeat(64)),
                "publish_ack": format!("sha256:{}", "b".repeat(64)),
            }),
        )
        .await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(reply.data.unwrap()["status"], "published");
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn list_local_artifact_drafts_returns_closed_metadata_only() {
        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::ListLocalDrafts {
                    artifact_id,
                    task_id,
                    reply,
                } => {
                    assert_eq!(artifact_id, "11111111-1111-4111-8111-111111111111");
                    assert_eq!(task_id, "22222222-2222-4222-8222-222222222222");
                    reply
                        .send(vec![crate::journalop::LocalDraftRow {
                            version_id: "33333333-3333-4333-8333-333333333333".into(),
                            request_id: "44444444-4444-4444-8444-444444444444".into(),
                            artifact_id,
                            task_id,
                            base_version_no: 4,
                            base_hash: format!("sha256:{}", "a".repeat(64)),
                            format: "md".into(),
                            content_hash: format!("sha256:{}", "b".repeat(64)),
                            byte_count: 11,
                            publish_state: "pending_confirm".into(),
                            created_at: 1,
                            auth_epoch: 4,
                            base_version_id: "55555555-5555-4555-8555-555555555555".into(),
                            base_byte_count: 4,
                            clipboard_derived: true,
                            clipboard_source_version_ids: vec![
                                "99999999-9999-4999-8999-999999999999".into(),
                            ],
                        }])
                        .unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = confirmation_reply(
            &node,
            &json!({
                "method": "listLocalArtifactDrafts", "request_id": "list-drafts-1",
                "artifact_id": "11111111-1111-4111-8111-111111111111",
                "task_id": "22222222-2222-4222-8222-222222222222",
            }),
        )
        .await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(data_keys(&reply), ["items", "status"]);
        let data = reply.data.unwrap();
        assert_eq!(data["status"], "available");
        let items = data["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        let mut item_keys: Vec<String> = items[0].as_object().unwrap().keys().cloned().collect();
        item_keys.sort();
        assert_eq!(
            item_keys,
            [
                "artifact_id",
                "base_byte_count",
                "base_hash",
                "base_version_id",
                "base_version_no",
                "byte_count",
                "clipboard_derived",
                "clipboard_source_version_ids",
                "content_hash",
                "created_at",
                "format",
                "publish_state",
                "request_id",
                "task_id",
                "version_id",
            ]
        );
        assert!(items[0].get("body").is_none());
        assert_eq!(items[0]["clipboard_derived"], true);
        assert_eq!(
            items[0]["clipboard_source_version_ids"],
            json!(["99999999-9999-4999-8999-999999999999"])
        );
        worker.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn open_local_artifact_edit_returns_only_the_viewer_body_shape() {
        let (node, mut requests) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            match requests.recv().await.unwrap() {
                crate::nodeservice::NodeRequest::OpenLocalContent { kind, id, reply } => {
                    assert_eq!(kind, "artifact_edit");
                    assert_eq!(id, "v-draft");
                    reply
                        .send(Some(crate::journalop::LocalContentBody {
                            row: crate::journalop::DeliverableRow {
                                run_id: String::new(),
                                operation_id: String::new(),
                                version_id: "v-draft".into(),
                                logical_name: "artifact".into(),
                                format: "txt".into(),
                                content_hash: "a".repeat(64),
                                byte_count: 5,
                                receipt_seq: None,
                                publish_state: "pending_confirm".into(),
                            },
                            bytes: b"draft".to_vec(),
                        }))
                        .unwrap();
                }
                _ => panic!("unexpected node request"),
            }
        });
        let reply = confirmation_reply(
            &node,
            &json!({
                "method": "openLocalContent", "request_id": "open-edit-1",
                "kind": "artifact_edit", "id": "v-draft",
            }),
        )
        .await;
        assert_eq!(reply.result, ACCEPTED, "{reply:?}");
        assert_eq!(
            data_keys(&reply),
            ["byte_count", "content_hash", "format", "status", "text"]
        );
        assert_eq!(reply.data.unwrap()["text"], "draft");
        worker.await.unwrap();
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

        let mut h = Harness::with_identity(crate::identity::test_paired_identity());
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
                "profile_revision": "1", "profile_hash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                "auth_epoch": "4",
                "listener_requirement": {
                    "allowed_signers": [], "allow_user_pinned_hash": true, "allowed_service_sids": []
                },
                "approved": true,
            }))
            .await;
        assert_eq!(confirm.result, ACCEPTED, "{confirm:?}");
        assert_eq!(
            data_keys(&confirm),
            [
                "binding_hash",
                "native_confirmation_proof",
                "profile_id",
                "signature"
            ]
        );
        let data = confirm.data.unwrap();
        let proof = &data["native_confirmation_proof"];
        assert_eq!(proof["v"], "1");
        assert_eq!(proof["org_id"], "org-1");
        assert_eq!(proof["subject_id"], "sub-1");
        assert_eq!(proof["device_id"], "11111111-1111-4111-8111-111111111111");
        assert_eq!(proof["session_id"], "22222222-2222-4222-8222-222222222222");
        assert_eq!(proof["profile_revision"], "1");
        assert_eq!(proof["auth_epoch"], "4");
        assert_eq!(proof["listener_owner_is_current_user"], true);
        assert!(proof["listener_owner_sid"].as_str().unwrap().len() >= 2);
        assert_eq!(proof["binding_hash"], data["binding_hash"]);
        assert_ne!(proof["binding_hash"], proof["listener_identity_hash"]);
        assert_eq!(proof["local_ref"], format!("http://127.0.0.1:{port}"));
        assert_eq!(
            proof["binding_hash"],
            model_binding_hash(&[
                proof["org_id"].as_str().unwrap(),
                proof["device_id"].as_str().unwrap(),
                proof["session_id"].as_str().unwrap(),
                proof["profile_id"].as_str().unwrap(),
                proof["profile_revision"].as_str().unwrap(),
                proof["profile_hash"].as_str().unwrap(),
                proof["local_ref"].as_str().unwrap(),
                proof["listener_identity_hash"].as_str().unwrap(),
            ])
        );
        assert!(crate::frame::sign::verify_frame(
            &h.identity_jwk,
            "model_binding",
            proof,
            data["signature"].as_str().unwrap()
        ));
        assert!(!data["binding_hash"].as_str().unwrap().is_empty());
        assert_eq!(h.finish().await, BridgeOutcome::LinkGone);
        let _ = child.kill();
        let _ = child.wait();
    }
}
