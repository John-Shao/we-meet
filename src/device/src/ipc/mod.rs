//! ACL-protected named-pipe IPC (device-design §1). The shell→Broker and
//! Node→Broker channels are two distinct ACL/message sets. The cross-platform
//! message layer (one-time handshake, length-prefixed framing, closed method
//! sets) lives here; the Windows named-pipe server and client token/SID/session
//! authentication live in [`pipe`] (Windows only).
//!
//! Scope (batch 5): transport + authentication + handshake + framing + method
//! closure. Per-method payload schemas/handlers land with their feature batches;
//! the AppContainer per-Run pipe ACL lands with the sidecar batch.

pub mod frame;
pub mod handshake;
pub mod schema;

#[cfg(windows)]
pub mod pipe;
