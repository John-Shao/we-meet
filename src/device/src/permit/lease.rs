//! The lease state machine (device-design §3.3). The local deadline uses a
//! monotonic clock (`Instant`), so a wall-clock rollback can never extend it.
//! Heartbeat renewal conservatively subtracts the round-trip from the server
//! TTL. Sleep / clock discontinuity / OS resume invalidates the lease (the
//! supervisor calls [`Lease::invalidate`]; OS-event detection lands with that
//! batch). After expiry the device may re-sign a history-return-only lease that
//! uploads receipts/checkpoint and proposes `run_finish` but carries no new
//! permits and forbids `action_prepare`.

use std::time::{Duration, Instant};

/// Default lease TTL (device-design §3.3: 30s).
pub const DEFAULT_LEASE_TTL: Duration = Duration::from_secs(30);
/// Default heartbeat interval (device-design §3.3: 10s).
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

/// The lease operating mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseMode {
    /// Normal: permits and `action_prepare` allowed while unexpired.
    Active,
    /// Expiry re-sign: only receipts/checkpoint upload and `run_finish`; no new
    /// permits, no `action_prepare`.
    HistoryReturn,
    /// Sleep/clock discontinuity: must reconnect, reconcile and re-authorize.
    Invalid,
}

/// A device lease bound to `run.fence` (read, never incremented device-side).
pub struct Lease {
    mode: LeaseMode,
    deadline: Instant,
    fence: u64,
}

impl Lease {
    /// Acquire an active lease. The deadline is `now + (server_ttl - round_trip)`,
    /// conservatively accounting for the heartbeat round-trip.
    pub fn acquire(now: Instant, server_ttl: Duration, round_trip: Duration, fence: u64) -> Self {
        Self {
            mode: LeaseMode::Active,
            deadline: now + server_ttl.saturating_sub(round_trip),
            fence,
        }
    }

    /// Renew on a successful heartbeat. Only an active lease is extended; the
    /// new deadline is again `now + (server_ttl - round_trip)`.
    pub fn heartbeat(&mut self, now: Instant, server_ttl: Duration, round_trip: Duration) {
        if self.mode == LeaseMode::Active {
            self.deadline = now + server_ttl.saturating_sub(round_trip);
        }
    }

    /// Invalidate on sleep / clock discontinuity / OS resume. The caller must
    /// kill or pause controllable processes, then reconnect and re-authorize.
    pub fn invalidate(&mut self) {
        self.mode = LeaseMode::Invalid;
    }

    /// Enter the history-return-only mode after expiry (a re-signed lease that
    /// carries no new permits).
    pub fn enter_history_return(
        &mut self,
        now: Instant,
        server_ttl: Duration,
        round_trip: Duration,
    ) {
        self.mode = LeaseMode::HistoryReturn;
        self.deadline = now + server_ttl.saturating_sub(round_trip);
    }

    /// Whether the lease is usable at `now` (for any allowed operation).
    pub fn is_valid(&self, now: Instant) -> bool {
        self.mode != LeaseMode::Invalid && now < self.deadline
    }

    /// Whether new permits / `action_prepare` are allowed at `now`. Only an
    /// unexpired active lease allows them; history-return never does.
    pub fn allows_new_permits(&self, now: Instant) -> bool {
        self.mode == LeaseMode::Active && now < self.deadline
    }

    pub fn mode(&self) -> LeaseMode {
        self.mode
    }

    pub fn fence(&self) -> u64 {
        self.fence
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> Instant {
        Instant::now()
    }

    #[test]
    fn acquire_subtracts_round_trip() {
        let start = now();
        let lease = Lease::acquire(start, Duration::from_secs(30), Duration::from_secs(2), 2);
        assert_eq!(lease.deadline(), start + Duration::from_secs(28));
        assert_eq!(lease.fence(), 2);
        assert!(lease.is_valid(start));
        assert!(lease.allows_new_permits(start));
    }

    #[test]
    fn heartbeat_extends_deadline() {
        let start = now();
        let mut lease = Lease::acquire(start, Duration::from_secs(30), Duration::from_secs(0), 2);
        let later = start + Duration::from_secs(10);
        lease.heartbeat(later, Duration::from_secs(30), Duration::from_secs(1));
        assert_eq!(lease.deadline(), later + Duration::from_secs(29));
    }

    #[test]
    fn expiry_blocks_new_permits() {
        let start = now();
        let lease = Lease::acquire(start, Duration::from_secs(30), Duration::from_secs(0), 2);
        let after = start + Duration::from_secs(31);
        assert!(!lease.is_valid(after));
        assert!(!lease.allows_new_permits(after));
    }

    #[test]
    fn invalidate_blocks_everything() {
        let start = now();
        let mut lease = Lease::acquire(start, Duration::from_secs(30), Duration::from_secs(0), 2);
        lease.invalidate();
        assert_eq!(lease.mode(), LeaseMode::Invalid);
        assert!(!lease.is_valid(start));
        assert!(!lease.allows_new_permits(start));
        // A heartbeat must not revive an invalidated lease.
        lease.heartbeat(start, Duration::from_secs(30), Duration::from_secs(0));
        assert!(!lease.is_valid(start));
    }

    #[test]
    fn history_return_uploads_but_no_new_permits() {
        let start = now();
        let mut lease = Lease::acquire(start, Duration::from_secs(30), Duration::from_secs(0), 2);
        lease.enter_history_return(start, Duration::from_secs(30), Duration::from_secs(0));
        assert_eq!(lease.mode(), LeaseMode::HistoryReturn);
        // Valid for uploading history...
        assert!(lease.is_valid(start));
        // ...but never for new permits / action_prepare.
        assert!(!lease.allows_new_permits(start));
    }

    #[test]
    fn round_trip_never_extends_beyond_ttl() {
        let start = now();
        // A round-trip larger than the TTL saturates to a zero-length lease.
        let lease = Lease::acquire(start, Duration::from_secs(5), Duration::from_secs(10), 2);
        assert_eq!(lease.deadline(), start);
        assert!(!lease.is_valid(start));
    }
}
