//! Reconciliation (device-design §6.2/§6.3, B03 carrier §3.2). The device journal
//! leaves `unknown` only via a server-signed `operation_resolution`
//! ([`resolution`]); journal cleanup is driven by two server-signed facts — the
//! `checkpoint_ack` recorded receipt watermark and the `finish` accepted ack plus
//! every Operation's resolution ([`watermark`]) — never by local inference. While
//! a Run has unreconciled unknown, new actions/permits are blocked but uplink and
//! resolution receive stay available ([`guard`]).

pub mod guard;
pub mod resolution;
pub mod watermark;
