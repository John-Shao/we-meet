//! ACL-protected named-pipe IPC (device-design §1). The shell→Broker and
//! Node→Broker channels are two distinct ACL/message sets. The cross-platform
//! message layer (one-time handshake, length-prefixed framing, closed method
//! sets) lives here; the Windows named-pipe server and client token/SID/session
//! authentication live in [`pipe`] (Windows only).
//!
//! Scope (batch 5): transport + authentication + handshake + framing + method
//! closure. Per-method payload schemas/handlers land with their feature batches;
//! the AppContainer per-Run pipe ACL lands with the sidecar batch.
//!
//! GW18 wires the shell channel: [`dispatch`] is the closed reply vocabulary and the
//! per-message routing decision (cross-platform), and [`service`] is the Windows named-pipe
//! service loop that runs it. The ticket itself is pumped to the live link by [`crate::broker`].

pub mod dispatch;
pub mod frame;
pub mod handshake;
pub mod nodemsg;
pub mod schema;
pub mod ticket;

#[cfg(windows)]
pub mod nodepipe;
#[cfg(windows)]
pub mod pipe;
#[cfg(windows)]
pub mod service;
