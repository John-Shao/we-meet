//! Node/Pi sidecar supervisor (device-design §1 :18/:41, §3.2). The cross-platform
//! lifecycle state machine and spawn configuration live here; the Windows Job
//! Object ([`job`]) and per-Run AppContainer ([`appcontainer`]) carry the process
//! isolation. The actual Node bundle load and tool loop land with the Node
//! implementation batch; the sidecar spawn integration (CreateProcess into the
//! AppContainer + Job Object) lands with that batch too.

pub mod lifecycle;
pub mod spawn;

#[cfg(windows)]
pub mod appcontainer;
#[cfg(windows)]
pub mod job;
