//! Device wire-frame foundation (device-design §3.1). The closed envelope, the
//! RFC 8785 JCS canonicalizer, uint64-string boundary adapters, ES256-over-JCS
//! frame signing, and the hello / local_intent / receipt signed bodies.
//!
//! Signing convention: the signed document is `{schema_version, type, body}`
//! with the body's `signature` field stripped; the outer envelope transport
//! fields are unsigned ("当前外层 session 仅管传输", m1a :658). `type` +
//! `schema_version` give domain separation (no cross-frame signature reuse).
//!
//! Scope (batch 3): device-side framing and signing. The mTLS gRPC transport
//! (`DeviceGateway/Connect`), hello_ack/session assignment and the ticket-mint
//! handshake land with the server-gateway batch.

pub mod action;
pub mod checkpoint;
pub mod command;
pub mod envelope;
pub mod finish;
pub mod hello;
pub mod intent;
pub mod jcs;
pub mod lease;
pub mod offer;
pub mod receipt;
pub mod receipt_ack;
pub mod reconcile;
pub mod resolution;
pub mod rfc3339;
pub mod sign;
pub mod u64string;
