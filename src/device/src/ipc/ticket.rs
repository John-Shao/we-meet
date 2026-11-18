//! The shell→Broker device-session ticket delivery (device-design §2.2 :63, §1 :20).
//!
//! §2.2: hello needs a SINGLE-USE device-session ticket with a 60s TTL, bound to
//! org/subject/device/session_revision/pubkey, of which the cloud stores only the hash. The
//! "current desktop identity" that mints it is the main process's NATIVE BEARER session, not a
//! Django cookie, and the device may not renew indefinitely without a login identity. mTLS and
//! the ticket must BOTH pass. The shell mints it through the landed M1b REST face
//! (`work.mint_device_session_ticket`, 0040:1392) and hands it to the Broker over the
//! ACL-protected pipe; this module is the Broker's side of that hand-off.
//!
//! Two measured server facts shape the lifecycle:
//!  * The mint returns the plaintext ticket ONLY on the first call. A replay of the same
//!    `client_request_id` returns `ticket: null` (0040:1429-1431), so the shell cannot re-hand
//!    a spent ticket — it must mint with a new request id. The Broker therefore refuses a
//!    re-delivery of a ticket id it already consumed instead of silently retrying a null.
//!  * `work.activate_device_session` has no challenge_response parameter and always mints a NEW
//!    session, so EVERY reconnect consumes a fresh ticket. One pending slot is enough; the
//!    Broker never queues tickets ahead of need, because a queued ticket would expire unused.
//!
//! The expiry the Broker enforces is its OWN holding window measured from receipt, not the
//! server's `expires_at`: that column is Postgres `now() + 60s` rendered with fractional seconds
//! and a `+00:00` offset, which the crate's strict whole-second RFC3339 parser refuses. The
//! server remains the authority on expiry; the local window is a conservative pre-check that
//! stops the Broker spending a ticket it has sat on for a minute.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::ipc::schema::{validate_message, Channel, SchemaError};

/// The shell IPC method that delivers a ticket. Added to the closed shell set in GW17.
pub const METHOD: &str = "deliverDeviceSessionTicket";

/// The ticket TTL (device-design §2.2: 60s; SQL 0040:1471 `now() + interval '60 seconds'`).
pub const TICKET_TTL: Duration = Duration::from_secs(60);

/// The closed top-level field set of a delivery message. `request_id` is the shell's
/// correlation id (the mint's `client_request_id`); there is no separate payload envelope.
const FIELDS: &[&str] = &[
    "device_id",
    "method",
    "request_id",
    "session_ticket_id",
    "ticket",
];

/// A validated ticket delivery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TicketDelivery {
    /// The plaintext ticket: `sha256_text(uuid||uuid)`, 64 lowercase hex (0040:1469).
    pub ticket: String,
    /// The device the ticket was minted for; must be this Broker's own device.
    pub device_id: String,
    /// The server's `device_session_ticket` row id — the single-use dedup key.
    pub session_ticket_id: String,
    /// The shell's correlation id, carried for diagnostics.
    pub request_id: String,
}

/// Why a delivery or a withdrawal was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketError {
    /// Not a closed delivery message (unknown method, missing/extra field, non-string member).
    Schema,
    /// A member is empty or the ticket is not 64 lowercase hex.
    Shape,
    /// The ticket was minted for another device.
    ForeignDevice,
    /// This ticket id was already spent. The mint returns null on replay, so retrying it is
    /// pointless — the shell must mint a new one.
    AlreadyConsumed,
    /// No ticket is pending.
    Empty,
    /// The pending ticket sat past the local holding window.
    Expired,
}

impl From<SchemaError> for TicketError {
    fn from(_: SchemaError) -> Self {
        Self::Schema
    }
}

/// Validate the closed delivery schema and extract the ticket.
pub fn parse(message: &Value) -> Result<TicketDelivery, TicketError> {
    validate_message(Channel::Shell, message)?;
    let obj = message.as_object().ok_or(TicketError::Schema)?;
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    if keys != FIELDS {
        return Err(TicketError::Schema);
    }
    if obj["method"].as_str() != Some(METHOD) {
        return Err(TicketError::Schema);
    }
    let text = |key: &str| -> Result<String, TicketError> {
        let value = obj[key].as_str().ok_or(TicketError::Schema)?;
        if value.is_empty() {
            return Err(TicketError::Shape);
        }
        Ok(value.to_string())
    };
    let ticket = text("ticket")?;
    // The mint's output shape: sha256 hex, never a UUID and never base64.
    if ticket.len() != 64
        || !ticket
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(TicketError::Shape);
    }
    Ok(TicketDelivery {
        ticket,
        device_id: text("device_id")?,
        session_ticket_id: text("session_ticket_id")?,
        request_id: text("request_id")?,
    })
}

/// A pending ticket and the instant the Broker received it.
struct Pending {
    delivery: TicketDelivery,
    received_at: Instant,
}

/// The Broker's single-use ticket slot: at most one pending ticket, plus the ids already spent.
pub struct TicketSlot {
    device_id: String,
    pending: Option<Pending>,
    consumed: BTreeMap<String, Instant>,
}

impl TicketSlot {
    /// A slot for this Broker's own device.
    pub fn new(device_id: &str) -> Self {
        Self {
            device_id: device_id.to_string(),
            pending: None,
            consumed: BTreeMap::new(),
        }
    }

    /// Accept a delivery. Re-delivering the SAME unspent ticket id is idempotent and does NOT
    /// refresh the holding window — otherwise a shell could keep an expired ticket alive by
    /// re-handing it every few seconds.
    pub fn deliver(&mut self, delivery: TicketDelivery, now: Instant) -> Result<(), TicketError> {
        if delivery.device_id != self.device_id {
            return Err(TicketError::ForeignDevice);
        }
        self.prune(now);
        if self.consumed.contains_key(&delivery.session_ticket_id) {
            return Err(TicketError::AlreadyConsumed);
        }
        if let Some(pending) = &self.pending {
            if pending.delivery.session_ticket_id == delivery.session_ticket_id {
                return Ok(());
            }
        }
        self.pending = Some(Pending {
            delivery,
            received_at: now,
        });
        Ok(())
    }

    /// Withdraw the pending ticket for one dial attempt, marking it spent. The link consumes
    /// exactly one ticket per attempt because every reconnect mints a new session.
    pub fn take(&mut self, now: Instant) -> Result<String, TicketError> {
        self.prune(now);
        let pending = self.pending.take().ok_or(TicketError::Empty)?;
        if now.duration_since(pending.received_at) > TICKET_TTL {
            return Err(TicketError::Expired);
        }
        self.consumed
            .insert(pending.delivery.session_ticket_id.clone(), now);
        Ok(pending.delivery.ticket)
    }

    /// Whether a ticket is pending and still inside the holding window.
    /// The device this slot accepts tickets for. The Broker only learns its own device id from a
    /// CA-signed certificate, so the slot starts empty and is re-keyed on the first delivery.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn has_live_ticket(&mut self, now: Instant) -> bool {
        self.prune(now);
        match &self.pending {
            Some(pending) => now.duration_since(pending.received_at) <= TICKET_TTL,
            None => false,
        }
    }

    /// Drop consumed ids older than the TTL, and retire an expired pending ticket into the
    /// consumed set. Past that window the server would refuse the ticket anyway (single-use,
    /// expired), so the local guard adds nothing by remembering it — and an unbounded set would
    /// grow for the life of the agent. Retiring the expired pending id is what stops a shell
    /// reviving a dead ticket by re-handing it: without this, pruning would forget the id and
    /// the re-delivery would start a fresh holding window on an already-expired ticket.
    fn prune(&mut self, now: Instant) {
        self.consumed
            .retain(|_, spent_at| now.duration_since(*spent_at) <= TICKET_TTL);
        if let Some(pending) = &self.pending {
            if now.duration_since(pending.received_at) > TICKET_TTL {
                self.consumed
                    .insert(pending.delivery.session_ticket_id.clone(), now);
                self.pending = None;
            }
        }
    }
}

/// The complete handler for one delivery message: closure validation, schema, then the slot.
/// The pipe loop calls this when it reads a `deliverDeviceSessionTicket` frame.
pub fn deliver_message(
    slot: &mut TicketSlot,
    message: &Value,
    now: Instant,
) -> Result<(), TicketError> {
    let delivery = parse(message)?;
    slot.deliver(delivery, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TICKET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn message() -> Value {
        json!({
            "method": METHOD,
            "request_id": "req-1",
            "ticket": TICKET,
            "device_id": "dev-1",
            "session_ticket_id": "ticket-row-1",
        })
    }

    #[test]
    fn parses_the_closed_delivery_shape() {
        let delivery = parse(&message()).unwrap();
        assert_eq!(delivery.ticket, TICKET);
        assert_eq!(delivery.device_id, "dev-1");
        assert_eq!(delivery.session_ticket_id, "ticket-row-1");
        assert_eq!(delivery.request_id, "req-1");
    }

    #[test]
    fn refuses_every_unclosed_or_mistyped_message() {
        // Unknown method, and a method from the viewer closure.
        for method in ["executeArbitrary", "signObjectProof", "chooseWorkspace"] {
            let mut msg = message();
            msg["method"] = json!(method);
            assert_eq!(parse(&msg), Err(TicketError::Schema), "accepted {method}");
        }
        // Missing method entirely.
        let mut msg = message();
        msg.as_object_mut().unwrap().remove("method");
        assert_eq!(parse(&msg), Err(TicketError::Schema));
        // Each closed member is required.
        for key in ["request_id", "ticket", "device_id", "session_ticket_id"] {
            let mut msg = message();
            msg.as_object_mut().unwrap().remove(key);
            assert_eq!(
                parse(&msg),
                Err(TicketError::Schema),
                "accepted without {key}"
            );
        }
        // An extra member breaks the closure (§1: every schema is closed).
        let mut msg = message();
        msg["expires_at"] = json!("2026-11-17T00:01:00Z");
        assert_eq!(parse(&msg), Err(TicketError::Schema));
        // The forbidden top-level fields are refused even with a valid method.
        for field in ["command", "path", "url"] {
            let mut msg = message();
            msg[field] = json!("anything");
            assert_eq!(parse(&msg), Err(TicketError::Schema), "accepted {field}");
        }
        // Non-string and empty members.
        let mut msg = message();
        msg["ticket"] = json!(42);
        assert_eq!(parse(&msg), Err(TicketError::Schema));
        for key in ["request_id", "ticket", "device_id", "session_ticket_id"] {
            let mut msg = message();
            msg[key] = json!("");
            assert_eq!(parse(&msg), Err(TicketError::Shape), "accepted empty {key}");
        }
        // Not an object at all.
        assert_eq!(parse(&json!("ticket")), Err(TicketError::Schema));
        assert_eq!(parse(&json!(null)), Err(TicketError::Schema));
    }

    #[test]
    fn refuses_a_ticket_that_is_not_the_mint_output_shape() {
        for bad in [
            "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF", // uppercase
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde",  // 63
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0", // 65
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg", // non-hex
            "11111111-1111-4111-8111-111111111111",                             // a UUID
        ] {
            let mut msg = message();
            msg["ticket"] = json!(bad);
            assert_eq!(parse(&msg), Err(TicketError::Shape), "accepted {bad}");
        }
    }

    #[test]
    fn a_ticket_is_single_use_and_the_slot_holds_only_one() {
        let start = Instant::now();
        let mut slot = TicketSlot::new("dev-1");
        assert_eq!(slot.take(start), Err(TicketError::Empty));
        assert!(!slot.has_live_ticket(start));

        slot.deliver(parse(&message()).unwrap(), start).unwrap();
        assert!(slot.has_live_ticket(start));
        // A second delivery replaces the pending one: the Broker never queues tickets, because
        // a queued ticket would expire unused (§2.2's 60s TTL).
        let mut second = message();
        second["session_ticket_id"] = json!("ticket-row-2");
        second["ticket"] = json!("f".repeat(64));
        slot.deliver(parse(&second).unwrap(), start).unwrap();
        assert_eq!(slot.take(start).unwrap(), "f".repeat(64));
        assert_eq!(slot.take(start), Err(TicketError::Empty));

        // The spent id cannot be re-delivered: the mint returns null on replay (0040:1429).
        assert_eq!(
            slot.deliver(parse(&second).unwrap(), start),
            Err(TicketError::AlreadyConsumed)
        );
        // And the first, never-spent ticket was dropped by the replacement, so it is not
        // silently spendable either.
        assert_eq!(slot.take(start), Err(TicketError::Empty));
    }

    #[test]
    fn re_delivery_inside_the_window_is_idempotent_and_does_not_refresh_it() {
        let start = Instant::now();
        let mut slot = TicketSlot::new("dev-1");
        slot.deliver(parse(&message()).unwrap(), start).unwrap();
        // Re-handing the same unspent id is accepted but must NOT move received_at, or a shell
        // could keep a ticket alive indefinitely by re-handing it every few seconds.
        slot.deliver(
            parse(&message()).unwrap(),
            start + TICKET_TTL - Duration::from_secs(1),
        )
        .unwrap();
        assert!(slot.has_live_ticket(start + TICKET_TTL));
        assert!(!slot.has_live_ticket(start + TICKET_TTL + Duration::from_nanos(1)));
    }

    #[test]
    fn an_expired_ticket_cannot_be_revived_by_re_delivery() {
        let start = Instant::now();
        let mut slot = TicketSlot::new("dev-1");
        slot.deliver(parse(&message()).unwrap(), start).unwrap();
        let later = start + TICKET_TTL + Duration::from_secs(1);
        // The ticket is expired server-side; re-handing the same id must be refused, not start
        // a fresh holding window on a dead ticket.
        assert_eq!(
            slot.deliver(parse(&message()).unwrap(), later),
            Err(TicketError::AlreadyConsumed)
        );
        assert_eq!(slot.take(later), Err(TicketError::Empty));
        assert!(!slot.has_live_ticket(later));
    }

    #[test]
    fn a_ticket_held_past_the_local_window_is_refused() {
        let start = Instant::now();
        let mut slot = TicketSlot::new("dev-1");
        slot.deliver(parse(&message()).unwrap(), start).unwrap();
        // Exactly at the TTL it is still spendable; one nanosecond past it is not.
        assert!(slot.has_live_ticket(start + TICKET_TTL));
        let late = start + TICKET_TTL + Duration::from_nanos(1);
        assert!(!slot.has_live_ticket(late));
        assert_eq!(slot.take(late), Err(TicketError::Empty));
    }

    #[test]
    fn a_foreign_device_ticket_is_refused() {
        let start = Instant::now();
        let mut slot = TicketSlot::new("dev-1");
        let mut msg = message();
        msg["device_id"] = json!("dev-2");
        assert_eq!(
            slot.deliver(parse(&msg).unwrap(), start),
            Err(TicketError::ForeignDevice)
        );
        assert!(!slot.has_live_ticket(start));
    }

    #[test]
    fn consumed_ids_are_pruned_once_the_server_would_refuse_them_anyway() {
        let start = Instant::now();
        let mut slot = TicketSlot::new("dev-1");
        slot.deliver(parse(&message()).unwrap(), start).unwrap();
        slot.take(start).unwrap();
        assert_eq!(
            slot.deliver(parse(&message()).unwrap(), start),
            Err(TicketError::AlreadyConsumed)
        );
        // Past the TTL the id is forgotten: the ticket is expired server-side, so remembering
        // it would only grow the set for the life of the agent.
        let later = start + TICKET_TTL + Duration::from_secs(1);
        slot.deliver(parse(&message()).unwrap(), later).unwrap();
        assert_eq!(slot.take(later).unwrap(), TICKET);
    }

    #[test]
    fn deliver_message_runs_the_whole_closure_then_the_slot() {
        let start = Instant::now();
        let mut slot = TicketSlot::new("dev-1");
        deliver_message(&mut slot, &message(), start).unwrap();
        assert_eq!(slot.take(start).unwrap(), TICKET);
        // A message that fails the shell closure never reaches the slot.
        let mut bad = message();
        bad["url"] = json!("https://example.test");
        assert_eq!(
            deliver_message(&mut slot, &bad, start),
            Err(TicketError::Schema)
        );
        assert_eq!(slot.take(start), Err(TicketError::Empty));
    }

    #[test]
    fn the_method_is_in_the_shell_closure_and_not_the_viewer_closure() {
        use crate::ipc::schema::{validate_method, SHELL_METHODS, VIEWER_METHODS};
        assert!(SHELL_METHODS.contains(&METHOD));
        assert!(!VIEWER_METHODS.contains(&METHOD));
        assert_eq!(validate_method(Channel::Shell, METHOD), Ok(()));
        assert_eq!(
            validate_method(Channel::Viewer, METHOD),
            Err(SchemaError::UnknownMethod)
        );
    }
}
