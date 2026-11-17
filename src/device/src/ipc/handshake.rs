//! The one-time pipe handshake (device-design §1: "一次性握手 nonce 和协议 major
//! 都须匹配"). The server draws a fresh random nonce per connection; the client
//! hello must echo it and match the protocol major. The handshake is single-use:
//! once accepted or rejected, any further attempt is refused (no replay).

use rand_core::RngCore;
use serde_json::{json, Value};

/// The wire protocol major version (device-design §3.1: v2).
pub const PROTOCOL_MAJOR: u32 = 2;

/// The closed `client_kind` wire values. The shell and the Node sidecar are two distinct
/// ACL/message sets (§1), so the kind is declared at handshake time and the pipe instance
/// refuses a client that belongs to the other set.
pub const CLIENT_KINDS: &[&str] = &["shell", "node"];

/// Which side of the two ACL/message sets a client belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientKind {
    /// The Electron shell (main process).
    Shell,
    /// The Node/Pi sidecar for a Run.
    Node,
}

/// A client hello presented during the handshake.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientHello {
    pub nonce: String,
    pub protocol_major: u32,
    pub client_kind: ClientKind,
}

/// Why a handshake was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandshakeError {
    Nonce,
    Protocol,
    Replay,
    /// The client hello is not the closed three-key shape, or a member is mistyped.
    Schema,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Pending,
    Accepted,
    Rejected,
}

/// A server-side one-time handshake.
pub struct Handshake {
    nonce: String,
    state: State,
}

impl Handshake {
    /// Create a handshake with a fresh random 256-bit nonce (hex).
    pub fn new() -> Self {
        let mut bytes = [0u8; 32];
        rand_core::OsRng.fill_bytes(&mut bytes);
        Self {
            nonce: crate::sha256_hex(&bytes),
            state: State::Pending,
        }
    }

    /// The nonce the client must echo.
    pub fn nonce(&self) -> &str {
        &self.nonce
    }

    /// Whether the handshake has been accepted.
    pub fn is_accepted(&self) -> bool {
        self.state == State::Accepted
    }

    /// Verify a client hello. Single-use: a second attempt always fails.
    pub fn verify(&mut self, hello: &ClientHello) -> Result<(), HandshakeError> {
        if self.state != State::Pending {
            return Err(HandshakeError::Replay);
        }
        if hello.nonce != self.nonce {
            self.state = State::Rejected;
            return Err(HandshakeError::Nonce);
        }
        if hello.protocol_major != PROTOCOL_MAJOR {
            self.state = State::Rejected;
            return Err(HandshakeError::Protocol);
        }
        self.state = State::Accepted;
        Ok(())
    }

    /// The closed server hello the pipe writes first: the fresh nonce the client must echo and
    /// the protocol major it must match. Two keys, nothing else — the nonce is the only secret
    /// here and it is single-use per connection.
    pub fn server_hello(&self) -> Value {
        json!({"nonce": self.nonce, "protocol_major": PROTOCOL_MAJOR})
    }
}

/// Parse the closed client hello. Exactly three keys, `protocol_major` a JSON number and
/// `client_kind` one of [`CLIENT_KINDS`]; anything else is a schema refusal, never a default.
pub fn parse_client_hello(value: &Value) -> Result<ClientHello, HandshakeError> {
    let obj = value.as_object().ok_or(HandshakeError::Schema)?;
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    if keys != ["client_kind", "nonce", "protocol_major"] {
        return Err(HandshakeError::Schema);
    }
    let nonce = obj["nonce"].as_str().ok_or(HandshakeError::Schema)?;
    // try_from, not `as`: a major above u32::MAX would otherwise truncate into a matching value
    // (2^32 + 2 becomes 2) and a wrong protocol version would be accepted.
    let major = u32::try_from(
        obj["protocol_major"]
            .as_u64()
            .ok_or(HandshakeError::Schema)?,
    )
    .map_err(|_| HandshakeError::Schema)?;
    let kind = obj["client_kind"].as_str().ok_or(HandshakeError::Schema)?;
    let client_kind = match kind {
        "shell" => ClientKind::Shell,
        "node" => ClientKind::Node,
        _ => return Err(HandshakeError::Schema),
    };
    Ok(ClientHello {
        nonce: nonce.to_string(),
        protocol_major: major,
        client_kind,
    })
}

impl Default for Handshake {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(handshake: &Handshake) -> ClientHello {
        ClientHello {
            nonce: handshake.nonce().to_string(),
            protocol_major: PROTOCOL_MAJOR,
            client_kind: ClientKind::Shell,
        }
    }

    #[test]
    fn matching_nonce_and_major_accept() {
        let mut h = Handshake::new();
        assert_eq!(h.verify(&hello(&h)), Ok(()));
        assert!(h.is_accepted());
    }

    #[test]
    fn wrong_nonce_rejects() {
        let mut h = Handshake::new();
        let mut hello = hello(&h);
        hello.nonce = "wrong".into();
        assert_eq!(h.verify(&hello), Err(HandshakeError::Nonce));
        assert!(!h.is_accepted());
    }

    #[test]
    fn wrong_major_rejects() {
        let mut h = Handshake::new();
        let mut hello = hello(&h);
        hello.protocol_major = PROTOCOL_MAJOR + 1;
        assert_eq!(h.verify(&hello), Err(HandshakeError::Protocol));
    }

    #[test]
    fn handshake_is_single_use() {
        let mut h = Handshake::new();
        let hello = hello(&h);
        h.verify(&hello).unwrap();
        // A replay after acceptance is refused.
        assert_eq!(h.verify(&hello), Err(HandshakeError::Replay));
    }

    #[test]
    fn rejected_handshake_cannot_retry() {
        let mut h = Handshake::new();
        let mut bad = hello(&h);
        bad.nonce = "wrong".into();
        h.verify(&bad).unwrap_err();
        // Even a correct hello after a rejection is refused.
        assert_eq!(h.verify(&hello(&h)), Err(HandshakeError::Replay));
    }

    #[test]
    fn nonces_are_unique() {
        assert_ne!(Handshake::new().nonce(), Handshake::new().nonce());
    }

    #[test]
    fn server_hello_is_the_closed_two_key_shape() {
        let h = Handshake::new();
        let value = h.server_hello();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["nonce", "protocol_major"]);
        assert_eq!(value["nonce"], h.nonce());
        assert_eq!(value["protocol_major"], PROTOCOL_MAJOR);
        assert!(value["protocol_major"].is_number());
    }

    #[test]
    fn client_hello_round_trips_the_server_nonce() {
        let mut h = Handshake::new();
        let value = json!({
            "nonce": h.nonce(),
            "protocol_major": PROTOCOL_MAJOR,
            "client_kind": "shell",
        });
        let hello = parse_client_hello(&value).unwrap();
        assert_eq!(hello.client_kind, ClientKind::Shell);
        assert_eq!(h.verify(&hello), Ok(()));
        // The node kind parses too; which pipe accepts it is the service loop's decision.
        let value = json!({
            "nonce": h.nonce(),
            "protocol_major": PROTOCOL_MAJOR,
            "client_kind": "node",
        });
        assert_eq!(
            parse_client_hello(&value).unwrap().client_kind,
            ClientKind::Node
        );
    }

    #[test]
    fn client_hello_refuses_every_unclosed_or_mistyped_shape() {
        let good = json!({"nonce": "n", "protocol_major": PROTOCOL_MAJOR, "client_kind": "shell"});
        // Each closed member is required.
        for key in ["nonce", "protocol_major", "client_kind"] {
            let mut value = good.clone();
            value.as_object_mut().unwrap().remove(key);
            assert_eq!(
                parse_client_hello(&value),
                Err(HandshakeError::Schema),
                "without {key}"
            );
        }
        // An extra member breaks the closure.
        let mut value = good.clone();
        value["command"] = json!("anything");
        assert_eq!(parse_client_hello(&value), Err(HandshakeError::Schema));
        // Mistyped members.
        for (key, bad) in [
            ("nonce", json!(42)),
            ("protocol_major", json!("2")),
            ("protocol_major", json!(2.0)),
            ("client_kind", json!(1)),
        ] {
            let mut value = good.clone();
            value[key] = bad;
            assert_eq!(
                parse_client_hello(&value),
                Err(HandshakeError::Schema),
                "{key}"
            );
        }
        // An unknown kind is not defaulted to shell.
        for kind in ["renderer", "viewer", "", "Shell"] {
            let mut value = good.clone();
            value["client_kind"] = json!(kind);
            assert_eq!(
                parse_client_hello(&value),
                Err(HandshakeError::Schema),
                "{kind}"
            );
        }
        assert_eq!(
            parse_client_hello(&json!("hello")),
            Err(HandshakeError::Schema)
        );
        assert_eq!(
            parse_client_hello(&json!(null)),
            Err(HandshakeError::Schema)
        );
    }

    #[test]
    fn a_protocol_major_above_u32_is_refused_not_truncated() {
        // 2^32 + 2 truncates to 2 under `as u32`, which would accept a wrong protocol version.
        for major in [
            u64::from(u32::MAX) + 1,
            u64::from(u32::MAX) + u64::from(PROTOCOL_MAJOR),
            u64::MAX,
        ] {
            let value = json!({"nonce": "n", "protocol_major": major, "client_kind": "shell"});
            assert_eq!(
                parse_client_hello(&value),
                Err(HandshakeError::Schema),
                "{major}"
            );
        }
    }

    #[test]
    fn a_parsed_hello_still_faces_the_nonce_and_single_use_gates() {
        let mut h = Handshake::new();
        let wrong =
            json!({"nonce": "wrong", "protocol_major": PROTOCOL_MAJOR, "client_kind": "shell"});
        let hello = parse_client_hello(&wrong).unwrap();
        assert_eq!(h.verify(&hello), Err(HandshakeError::Nonce));
        // Parsing is not acceptance: the handshake is still single-use after a rejection.
        let right =
            json!({"nonce": h.nonce(), "protocol_major": PROTOCOL_MAJOR, "client_kind": "shell"});
        assert_eq!(
            h.verify(&parse_client_hello(&right).unwrap()),
            Err(HandshakeError::Replay)
        );
    }
}
