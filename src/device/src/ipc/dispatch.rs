//! What the shell→Broker pipe loop does with one message, and what it answers
//! (device-design §1: "IPC 返回明确错误而不是静默降级").
//!
//! GW18 landed the service loop with one handler out of fourteen closed shell methods. GW21 adds
//! five more for §2.1's Broker side and M2b adds the restart re-delivery carrier; 批2 (主签单选乙)
//! adds the four §4.2/§5.4 confirmation carriers, so eleven now have handlers and eleven remain IN
//! the closure but unimplemented. Those are refused with
//! `method_not_implemented`, never with `unknown_method`:
//! the shell must be able to tell "this call is illegal" from "this call is legal but not landed
//! yet". Conflating the two would make a legitimate caller look like an attacker, and would give
//! the shell no way to decide whether to retry or to change the call.
//!
//! Every reply is closed: `refused` carries exactly four keys, `accepted` exactly three plus an
//! optional `data` object. GW18's accepted reply had no payload slot at all, which §2.1 cannot
//! work with — step 1 requires the public JWK/thumbprint to reach the main process, and the
//! signing requests must return a signature. `data` is therefore present exactly for the methods
//! that return facts, and each one's key set is closed (see [`crate::broker`]). It is never a
//! free-form channel: no method puts a path, a command or a URL in it.
//!
//! The echoed `request_id`/`method` are the caller's own strings when they are strings and empty
//! otherwise — the Broker never invents a correlation id, and a message too malformed to carry
//! one still gets a reply rather than a silent drop.

use serde_json::{json, Value};

use crate::identity::IdentityError;
use crate::ipc::schema::{validate_message, Channel, SchemaError};
use crate::ipc::ticket::{self, TicketError};

/// The closed result value for an accepted call.
pub const ACCEPTED: &str = "accepted";
/// The closed result value for a refused call.
pub const REFUSED: &str = "refused";

/// The closed refusal codes. `unknown_method` and `method_not_implemented` are deliberately
/// distinct (see the module doc); `handshake` is the connection-level refusal written before the
/// one-time handshake is accepted, after which the pipe is disconnected.
///
/// GW21 adds two for the certificate face. `no_pairing` is distinct from `certificate_invalid`
/// because the shell must be able to tell "you have not asked me to sign for any org yet, so I
/// have nothing to bind this certificate against" (retry after pairing) from "this chain failed
/// a gate" (do not retry the same bytes).
pub const CODES: &[&str] = &[
    "unknown_method",
    "method_not_implemented",
    "schema",
    "shape",
    "foreign_device",
    "already_consumed",
    "handshake",
    "no_pairing",
    "certificate_invalid",
];

/// One closed reply to one IPC message.
#[derive(Clone, Debug, PartialEq)]
pub struct Reply {
    /// The caller's correlation id, echoed verbatim (empty when absent or not a string).
    pub request_id: String,
    /// The caller's method name, echoed verbatim (empty when absent or not a string).
    pub method: String,
    /// [`ACCEPTED`] or [`REFUSED`].
    pub result: &'static str,
    /// A member of [`CODES`], present exactly when the call was refused.
    pub code: Option<&'static str>,
    /// The closed fact payload, present exactly when an accepted method returns one. Never
    /// present on a refusal, so a refused call cannot smuggle data past the shell's checks.
    pub data: Option<Value>,
}

impl Reply {
    /// An accepted call that returns no facts.
    pub fn accepted(message: &Value) -> Self {
        let (request_id, method) = echo(message);
        Self {
            request_id,
            method,
            result: ACCEPTED,
            code: None,
            data: None,
        }
    }

    /// An accepted call that returns a closed fact payload.
    pub fn accepted_with(message: &Value, data: Value) -> Self {
        let mut reply = Self::accepted(message);
        reply.data = Some(data);
        reply
    }

    /// A refused call with a closed code.
    pub fn refused(message: &Value, code: &'static str) -> Self {
        debug_assert!(CODES.contains(&code), "{code} is not a closed refusal code");
        let (request_id, method) = echo(message);
        Self {
            request_id,
            method,
            result: REFUSED,
            code: Some(code),
            data: None,
        }
    }

    /// The connection-level refusal for a failed one-time handshake. There is no message to echo
    /// yet, so both correlation fields are empty.
    pub fn handshake() -> Self {
        Self {
            request_id: String::new(),
            method: String::new(),
            result: REFUSED,
            code: Some("handshake"),
            data: None,
        }
    }

    /// The closed wire shape: four keys when refused, three when accepted without facts, and
    /// three plus `data` when accepted with them.
    pub fn to_value(&self) -> Value {
        let mut out = json!({
            "request_id": self.request_id,
            "method": self.method,
            "result": self.result,
        });
        if let Some(code) = self.code {
            out["code"] = json!(code);
        }
        if let Some(data) = &self.data {
            out["data"] = data.clone();
        }
        out
    }
}

/// The caller's own `request_id` and `method`, or empty strings. A non-object message yields two
/// empty strings, so even a payload that is not an IPC message at all gets a closed reply.
pub fn echo(message: &Value) -> (String, String) {
    let text = |key: &str| {
        message
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    (text("request_id"), text("method"))
}

/// The wire code for a ticket-delivery refusal.
pub fn delivery_code(err: TicketError) -> &'static str {
    match err {
        TicketError::Schema => "schema",
        TicketError::Shape => "shape",
        TicketError::ForeignDevice => "foreign_device",
        TicketError::AlreadyConsumed => "already_consumed",
        // Unreachable from `deliver`: both are withdrawal-side facts. An expired pending ticket
        // is retired into the consumed set by `prune`, so a re-delivery of that id already
        // arrives as AlreadyConsumed. The arm keeps the reply closed instead of panicking inside
        // the pipe loop; `deliveries_never_report_withdrawal_errors` pins that it cannot fire.
        TicketError::Empty | TicketError::Expired => "already_consumed",
    }
}

/// The wire code for an identity/certificate refusal.
pub fn identity_code(err: IdentityError) -> &'static str {
    match err {
        IdentityError::Schema => "schema",
        IdentityError::Shape => "shape",
        IdentityError::NoPairing => "no_pairing",
        IdentityError::CertificateInvalid | IdentityError::NotWindows => "certificate_invalid",
        IdentityError::Sign => "shape",
    }
}

/// What the pipe loop should do with one message.
#[derive(Clone, Debug, PartialEq)]
pub enum Dispatch {
    /// A method the core pump owns: hand the message over, and it runs the whole closed
    /// validation then answers from the result. Validation is NOT duplicated here — one closure
    /// path, so the pipe loop and the owning state cannot disagree. GW18 called this `Ticket`
    /// when the pump owned only the ticket slot; GW21's pump also owns the §2.1 identity, so the
    /// variant names the owner rather than one of its methods.
    Core,
    /// Answer immediately; the message never reaches the pump.
    Answer(Reply),
}

/// The shell methods the core pump implements. Everything else in the closure is legal but
/// unlanded, and is answered with `method_not_implemented`.
///
/// 批2 (主签单选乙) adds the four confirmation carriers: `chooseWorkspace`/`probeLocalModel` prepare
/// (bind root / probe identity, return facts + a single-use token), and `confirmWorkspaceRoot`/
/// `confirmLocalModel` carry the user's confirm/cancel decision back. The pump forwards these to the
/// Node service thread that owns the registries (§6.1); the `!Send` handles never cross threads.
pub const CORE_METHODS: &[&str] = &[
    ticket::METHOD,
    "getDeviceIdentity",
    "signDevicePairing",
    "signDeviceCertificateRenewal",
    "deliverDeviceCertificate",
    "redeliverDeviceCertificate",
    "getDeviceCertificateStatus",
    "chooseWorkspace",
    "confirmWorkspaceRoot",
    "probeLocalModel",
    "confirmLocalModel",
    "stageLocalInput",
];

/// Route one message on the shell channel. The closure check runs first, so a forbidden
/// `command`/`path`/`url` field is a schema refusal even on a method that is otherwise known.
pub fn classify(message: &Value) -> Dispatch {
    match validate_message(Channel::Shell, message) {
        Err(SchemaError::UnknownMethod) => {
            Dispatch::Answer(Reply::refused(message, "unknown_method"))
        }
        Err(SchemaError::MissingMethod) | Err(SchemaError::ForbiddenField) => {
            Dispatch::Answer(Reply::refused(message, "schema"))
        }
        Ok(()) => {
            let method = message.get("method").and_then(Value::as_str).unwrap_or("");
            if CORE_METHODS.contains(&method) {
                Dispatch::Core
            } else {
                Dispatch::Answer(Reply::refused(message, "method_not_implemented"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::schema::SHELL_METHODS;
    use crate::ipc::ticket::TicketSlot;
    use std::time::Instant;

    const TICKET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn delivery() -> Value {
        json!({
            "method": ticket::METHOD,
            "request_id": "req-1",
            "ticket": TICKET,
            "device_id": "dev-1",
            "session_ticket_id": "ticket-row-1",
        })
    }

    #[test]
    fn the_reply_closure_is_nine_codes_and_two_results() {
        assert_eq!(CODES.len(), 9);
        let mut sorted = CODES.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            CODES.len(),
            "a duplicate code is not a closed set"
        );
        assert_eq!(ACCEPTED, "accepted");
        assert_eq!(REFUSED, "refused");
    }

    #[test]
    fn accepted_carries_three_keys_and_refused_four() {
        let accepted = Reply::accepted(&delivery()).to_value();
        let mut keys: Vec<&str> = accepted
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["method", "request_id", "result"]);
        assert_eq!(accepted["result"], "accepted");
        assert_eq!(accepted["request_id"], "req-1");
        assert_eq!(accepted["method"], ticket::METHOD);

        let refused = Reply::refused(&delivery(), "shape").to_value();
        let mut keys: Vec<&str> = refused
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["code", "method", "request_id", "result"]);
        assert_eq!(refused["result"], "refused");
        assert_eq!(refused["code"], "shape");
        // No arbitrary command/path/url can ride along on a reply.
        for field in ["command", "path", "url"] {
            assert!(refused.get(field).is_none());
        }
    }

    #[test]
    fn echo_never_invents_a_correlation_id() {
        assert_eq!(echo(&delivery()), ("req-1".into(), ticket::METHOD.into()));
        // Absent, non-string and non-object messages all echo empty strings.
        assert_eq!(
            echo(&json!({"method": ticket::METHOD})),
            ("".into(), ticket::METHOD.into())
        );
        assert_eq!(
            echo(&json!({"request_id": 42, "method": true})),
            ("".into(), "".into())
        );
        assert_eq!(echo(&json!("not an object")), ("".into(), "".into()));
        assert_eq!(echo(&json!(null)), ("".into(), "".into()));
        let reply = Reply::refused(&json!(null), "schema").to_value();
        assert_eq!(reply["request_id"], "");
        assert_eq!(reply["method"], "");
        assert_eq!(reply["code"], "schema");
    }

    #[test]
    fn the_ticket_method_is_dispatched_to_the_bridge() {
        assert_eq!(classify(&delivery()), Dispatch::Core);
    }

    #[test]
    fn every_other_closed_shell_method_is_not_implemented_not_unknown() {
        let mut count = 0;
        for method in SHELL_METHODS {
            if CORE_METHODS.contains(method) {
                continue;
            }
            count += 1;
            let message = json!({"method": method, "request_id": "req-9"});
            match classify(&message) {
                Dispatch::Answer(reply) => {
                    assert_eq!(reply.code, Some("method_not_implemented"), "{method}");
                    assert_eq!(reply.result, REFUSED);
                    // The caller's own correlation id survives, so the shell can match the answer.
                    assert_eq!(reply.request_id, "req-9");
                    assert_eq!(reply.method, *method);
                }
                Dispatch::Core => panic!("{method} must not reach the ticket slot"),
            }
        }
        // Ten of the twenty-two are unlanded; the count is the closure minus the twelve handlers.
        assert_eq!(count, 10);
        assert_eq!(SHELL_METHODS.len(), 22);
        assert_eq!(CORE_METHODS.len(), 12);
    }

    #[test]
    fn an_unknown_method_is_distinct_from_an_unimplemented_one() {
        for method in [
            "executeArbitrary",
            "signObjectProof",
            "chooseWorkspace2",
            "",
        ] {
            let message = json!({"method": method, "request_id": "req-1"});
            match classify(&message) {
                Dispatch::Answer(reply) => {
                    assert_eq!(reply.code, Some("unknown_method"), "{method}")
                }
                Dispatch::Core => panic!("{method} must not reach the slot"),
            }
        }
        // A viewer-channel method is unknown on the shell pipe, not merely unimplemented.
        let message = json!({"method": "decideLocalApproval"});
        assert_eq!(
            classify(&message),
            Dispatch::Answer(Reply::refused(&message, "unknown_method"))
        );
    }

    #[test]
    fn a_forbidden_field_is_a_schema_refusal_even_on_a_known_method() {
        for field in ["command", "path", "url"] {
            for method in [ticket::METHOD, "chooseWorkspace"] {
                let message = json!({"method": method, "request_id": "req-1", field: "anything"});
                match classify(&message) {
                    Dispatch::Answer(reply) => {
                        assert_eq!(reply.code, Some("schema"), "{method}/{field}")
                    }
                    Dispatch::Core => panic!("{method}/{field} must not reach the slot"),
                }
            }
        }
        // Missing method entirely.
        let message = json!({"request_id": "req-1"});
        assert_eq!(
            classify(&message),
            Dispatch::Answer(Reply::refused(&message, "schema"))
        );
    }

    #[test]
    fn delivery_codes_cover_the_four_reachable_refusals() {
        assert_eq!(delivery_code(TicketError::Schema), "schema");
        assert_eq!(delivery_code(TicketError::Shape), "shape");
        assert_eq!(delivery_code(TicketError::ForeignDevice), "foreign_device");
        assert_eq!(
            delivery_code(TicketError::AlreadyConsumed),
            "already_consumed"
        );
        for err in [
            TicketError::Schema,
            TicketError::Shape,
            TicketError::ForeignDevice,
            TicketError::AlreadyConsumed,
        ] {
            assert!(
                CODES.contains(&delivery_code(err)),
                "{err:?} maps outside the closed refusal set"
            );
        }
    }

    #[test]
    fn deliveries_never_report_withdrawal_errors() {
        // The unreachable arm in delivery_code must stay unreachable: no delivery path produces
        // Empty or Expired, because those are `take`-side facts. Drive every refusal the slot can
        // actually produce and check the code is one of the four.
        let start = Instant::now();
        let mut slot = TicketSlot::new("dev-1");
        let reachable = ["schema", "shape", "foreign_device", "already_consumed"];

        let mut bad = delivery();
        bad["url"] = json!("https://example.test");
        let err = ticket::deliver_message(&mut slot, &bad, start).unwrap_err();
        assert!(reachable.contains(&delivery_code(err)));

        let mut bad = delivery();
        bad["ticket"] = json!("not-hex");
        let err = ticket::deliver_message(&mut slot, &bad, start).unwrap_err();
        assert!(reachable.contains(&delivery_code(err)));

        let mut bad = delivery();
        bad["device_id"] = json!("dev-2");
        let err = ticket::deliver_message(&mut slot, &bad, start).unwrap_err();
        assert_eq!(delivery_code(err), "foreign_device");

        ticket::deliver_message(&mut slot, &delivery(), start).unwrap();
        slot.take(start).unwrap();
        let err = ticket::deliver_message(&mut slot, &delivery(), start).unwrap_err();
        assert_eq!(delivery_code(err), "already_consumed");

        // An expired pending ticket is retired into the consumed set, so the shell sees
        // already_consumed rather than a withdrawal-side `expired`.
        let mut slot = TicketSlot::new("dev-1");
        ticket::deliver_message(&mut slot, &delivery(), start).unwrap();
        let late = start + ticket::TICKET_TTL + std::time::Duration::from_secs(1);
        let err = ticket::deliver_message(&mut slot, &delivery(), late).unwrap_err();
        assert_eq!(delivery_code(err), "already_consumed");
        assert_ne!(delivery_code(err), "expired");
    }

    #[test]
    fn the_handshake_refusal_is_closed_and_carries_no_echo() {
        let reply = Reply::handshake();
        assert_eq!(reply.result, REFUSED);
        assert_eq!(reply.code, Some("handshake"));
        let value = reply.to_value();
        assert_eq!(value["request_id"], "");
        assert_eq!(value["method"], "");
        assert_eq!(value.as_object().unwrap().len(), 4);
    }
}
