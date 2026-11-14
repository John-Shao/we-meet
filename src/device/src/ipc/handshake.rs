//! The one-time pipe handshake (device-design §1: "一次性握手 nonce 和协议 major
//! 都须匹配"). The server draws a fresh random nonce per connection; the client
//! hello must echo it and match the protocol major. The handshake is single-use:
//! once accepted or rejected, any further attempt is refused (no replay).

use rand_core::RngCore;

/// The wire protocol major version (device-design §3.1: v2).
pub const PROTOCOL_MAJOR: u32 = 2;

/// Which side of the two ACL/message sets a client belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientKind {
    /// The Electron shell (main process).
    Shell,
    /// The Node/Pi sidecar for a Run.
    Node,
}

/// A client hello presented during the handshake.
#[derive(Clone, Debug)]
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
}
