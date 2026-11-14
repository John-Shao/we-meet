//! Recovery on reconnect/restart (device-design §6.3 末段 :315, §3.2). The
//! recovery phase machine enforces the order: exchange generation/last seq →
//! upload missing receipts → reconcile → only then consider a new lease. Receipt
//! replay ([`replay`]) re-sends original signed bytes unchanged; resume binding
//! validation ([`resume`]) confirms the expected checkpoint and prior receipts
//! before ready. The server-gateway transport and hello_ack/session assignment
//! land with the gateway batch.

pub mod replay;
pub mod resume;

/// The recovery phase. A new lease is only considered after reconcile completes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryPhase {
    ExchangeIdentity,
    UploadReceipts,
    Reconcile,
    ReadyForLease,
}

/// A recovery phase violation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryError {
    InvalidTransition,
}

/// The recovery state machine for one reconnect/restart.
pub struct Recovery {
    phase: RecoveryPhase,
    generation: u64,
    last_receipt_seq: u64,
}

impl Recovery {
    /// Begin recovery, exchanging the global generation and last receipt seq.
    pub fn new(generation: u64, last_receipt_seq: u64) -> Self {
        Self {
            phase: RecoveryPhase::ExchangeIdentity,
            generation,
            last_receipt_seq,
        }
    }

    /// Identity exchanged → begin uploading missing receipts.
    pub fn start_upload(&mut self) -> Result<(), RecoveryError> {
        if self.phase != RecoveryPhase::ExchangeIdentity {
            return Err(RecoveryError::InvalidTransition);
        }
        self.phase = RecoveryPhase::UploadReceipts;
        Ok(())
    }

    /// Receipts uploaded → begin reconcile (wait for resolutions).
    pub fn start_reconcile(&mut self) -> Result<(), RecoveryError> {
        if self.phase != RecoveryPhase::UploadReceipts {
            return Err(RecoveryError::InvalidTransition);
        }
        self.phase = RecoveryPhase::Reconcile;
        Ok(())
    }

    /// Reconcile complete → ready to consider a new lease.
    pub fn finish_reconcile(&mut self) -> Result<(), RecoveryError> {
        if self.phase != RecoveryPhase::Reconcile {
            return Err(RecoveryError::InvalidTransition);
        }
        self.phase = RecoveryPhase::ReadyForLease;
        Ok(())
    }

    /// A new lease may only be acquired after reconcile completes (§6.3 :315).
    pub fn may_acquire_lease(&self) -> bool {
        self.phase == RecoveryPhase::ReadyForLease
    }

    pub fn phase(&self) -> RecoveryPhase {
        self.phase
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn last_receipt_seq(&self) -> u64 {
        self.last_receipt_seq
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_recovery_progression() {
        let mut r = Recovery::new(3, 10);
        assert_eq!(r.phase(), RecoveryPhase::ExchangeIdentity);
        assert!(!r.may_acquire_lease());
        r.start_upload().unwrap();
        r.start_reconcile().unwrap();
        assert!(!r.may_acquire_lease());
        r.finish_reconcile().unwrap();
        assert!(r.may_acquire_lease());
        assert_eq!(r.generation(), 3);
        assert_eq!(r.last_receipt_seq(), 10);
    }

    #[test]
    fn cannot_skip_phases() {
        let mut r = Recovery::new(1, 0);
        assert_eq!(r.start_reconcile(), Err(RecoveryError::InvalidTransition));
        assert_eq!(r.finish_reconcile(), Err(RecoveryError::InvalidTransition));
        r.start_upload().unwrap();
        assert_eq!(r.finish_reconcile(), Err(RecoveryError::InvalidTransition));
    }

    #[test]
    fn lease_blocked_until_reconcile_done() {
        let mut r = Recovery::new(1, 0);
        r.start_upload().unwrap();
        r.start_reconcile().unwrap();
        // Still reconciling: no new lease.
        assert!(!r.may_acquire_lease());
        r.finish_reconcile().unwrap();
        assert!(r.may_acquire_lease());
    }
}
