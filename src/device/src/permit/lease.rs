//! The lease state machine (device-design §3.3). The local deadline uses a
//! monotonic clock (`Instant`), so a wall-clock rollback can never extend it.
//! Heartbeat renewal conservatively subtracts the round-trip from the server
//! TTL. Sleep / clock discontinuity / OS resume invalidates the lease (the
//! supervisor calls [`Lease::invalidate`]; OS-event detection lands with that
//! batch). After expiry the device may re-sign a history-return-only lease that
//! uploads receipts/checkpoint and proposes `run_finish` but carries no new
//! permits and forbids `action_prepare`.

use std::time::{Duration, Instant};

use crate::frame::lease::LeaseBody;

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

    /// Renew on a successful heartbeat. The response must arrive BEFORE the old
    /// deadline; being Active alone does not mean an unobserved expiry can revive.
    /// The new deadline remains `sent_at + (server_ttl - round_trip)` (§3.3).
    pub fn heartbeat(
        &mut self,
        sent_at: Instant,
        server_ttl: Duration,
        round_trip: Duration,
    ) -> bool {
        if self.mode != LeaseMode::Active {
            return false;
        }
        if sent_at
            .checked_add(round_trip)
            .is_none_or(|received_at| received_at >= self.deadline)
        {
            self.invalidate();
            return false;
        }
        self.deadline = sent_at + server_ttl.saturating_sub(round_trip);
        true
    }

    /// Apply a server `lease` downlink (device-design §3.1 heartbeat row: "仅在线性化续租
    /// 成功后延长本地许可"). `sent_at` is the monotonic instant the heartbeat was sent and
    /// `round_trip` the measured send→response elapsed time, so the new deadline is
    /// `sent_at + (ttl - round_trip)` (§3.3) — never the wall clock, and never the server's
    /// `expires_at` string.
    ///
    /// The frame is unsigned (§3.1 lists no signature for the lease row; mTLS plus the
    /// hello-established session authenticate it, and 0051 binds the renewal to the lease's
    /// original device/session server-side). The judgments left here are fence and mode: a
    /// renewal naming a different fence is not this lease's renewal, and only an Active
    /// lease is extended — a heartbeat never revives a history-return or invalidated lease.
    /// Returns whether the deadline was extended.
    pub fn apply_renewal(
        &mut self,
        sent_at: Instant,
        round_trip: Duration,
        body: &LeaseBody,
    ) -> bool {
        if body.fence != self.fence || self.mode != LeaseMode::Active {
            return false;
        }
        self.heartbeat(sent_at, body.ttl(), round_trip)
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

    fn renewal(fence: u64, ttl_ms: u64) -> LeaseBody {
        LeaseBody {
            lease_id: "lease-1".into(),
            run_id: "run-1".into(),
            fence,
            expires_at: "2026-11-16T00:00:30Z".into(),
            ttl_ms,
        }
    }

    #[test]
    fn renewal_extends_only_for_the_matching_fence() {
        let start = now();
        let mut lease = Lease::acquire(start, Duration::from_secs(30), Duration::ZERO, 2);
        let sent = start + Duration::from_secs(10);
        assert!(lease.apply_renewal(sent, Duration::from_secs(1), &renewal(2, 30_000)));
        assert_eq!(lease.deadline(), sent + Duration::from_secs(29));
        // A renewal for another fence is not this lease's renewal: nothing moves.
        let deadline = lease.deadline();
        assert!(!lease.apply_renewal(sent, Duration::ZERO, &renewal(3, 30_000)));
        assert_eq!(lease.deadline(), deadline);
    }

    #[test]
    fn renewal_never_revives_history_return_or_invalid() {
        let start = now();
        let mut lease = Lease::acquire(start, Duration::from_secs(30), Duration::ZERO, 2);
        lease.enter_history_return(start, Duration::from_secs(30), Duration::ZERO);
        let deadline = lease.deadline();
        assert!(!lease.apply_renewal(start, Duration::ZERO, &renewal(2, 30_000)));
        assert_eq!(lease.deadline(), deadline);
        assert_eq!(lease.mode(), LeaseMode::HistoryReturn);

        lease.invalidate();
        assert!(!lease.apply_renewal(start, Duration::ZERO, &renewal(2, 30_000)));
        assert!(!lease.is_valid(start));
    }

    #[test]
    fn renewal_uses_the_send_instant_not_the_response_instant() {
        let start = now();
        let mut lease = Lease::acquire(start, Duration::from_secs(30), Duration::ZERO, 2);
        let sent = start + Duration::from_secs(10);
        // The response arrives 2s later; the deadline is still measured from the send,
        // so the round trip is subtracted rather than added (§3.3 conservative rule).
        assert!(lease.apply_renewal(sent, Duration::from_secs(2), &renewal(2, 30_000)));
        assert_eq!(lease.deadline(), sent + Duration::from_secs(28));
        assert!(lease.deadline() < sent + Duration::from_secs(30));
    }

    #[test]
    fn renewal_with_a_round_trip_over_the_ttl_expires_immediately() {
        let start = now();
        let mut lease = Lease::acquire(start, Duration::from_secs(60), Duration::ZERO, 2);
        // Still within the OLD lease, but the new TTL has no usable budget left.
        assert!(lease.apply_renewal(start, Duration::from_secs(40), &renewal(2, 30_000)));
        assert_eq!(lease.deadline(), start);
        assert!(!lease.is_valid(start));
        assert!(!lease.allows_new_permits(start));
    }

    #[test]
    fn renewal_at_or_after_expiry_never_revives_an_active_lease() {
        let start = now();
        for delay in [10, 11] {
            let mut lease = Lease::acquire(start, Duration::from_secs(30), Duration::ZERO, 2);
            let deadline = lease.deadline();
            let sent = start + Duration::from_secs(20);
            assert!(!lease.apply_renewal(sent, Duration::from_secs(delay), &renewal(2, 30_000)));
            assert_eq!(lease.deadline(), deadline);
            assert_eq!(lease.mode(), LeaseMode::Invalid);
            // Even a subsequently supplied earlier timestamp cannot revive the invalid state.
            assert!(!lease.heartbeat(start, Duration::from_secs(60), Duration::ZERO));
        }
    }
}
