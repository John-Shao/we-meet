//! Run finish (device-design §3.4). The operation-set hash ([`ophash`]) and the
//! outcome judgment ([`outcome`]) are cross-platform; the finish proposal is
//! idempotent by `finish_id` — a re-send (lost ack, or after restart) returns the
//! same finish_id and the same signed bytes, never a re-judgment. The durable
//! record is the journal `runtime_finish` table (finish_id primary key); this is
//! its in-memory projection. The wire bodies live in `crate::frame::finish` and the
//! server verdict is consumed by [`ack::apply_finish_ack`] (GW12).

pub mod ack;
pub mod ophash;
pub mod outcome;

use std::collections::HashMap;

/// A proposed run finish.
#[derive(Clone, Debug)]
pub struct FinishProposal {
    pub finish_id: String,
    pub run_id: String,
    pub outcome: outcome::Outcome,
    pub operation_set_hash: String,
    pub signed_bytes: Vec<u8>,
}

/// Tracks proposed finishes so re-sends are idempotent (same finish_id, same
/// signed bytes, no re-judgment).
#[derive(Default)]
pub struct FinishTracker {
    proposals: HashMap<String, FinishProposal>,
}

impl FinishTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Propose a finish. If `finish_id` was already proposed, the stored proposal
    /// is returned unchanged (the new one is discarded); otherwise it is stored.
    pub fn propose(&mut self, proposal: FinishProposal) -> &FinishProposal {
        self.proposals
            .entry(proposal.finish_id.clone())
            .or_insert(proposal)
    }

    /// Look up a previously proposed finish.
    pub fn get(&self, finish_id: &str) -> Option<&FinishProposal> {
        self.proposals.get(finish_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal(finish_id: &str, bytes: &[u8]) -> FinishProposal {
        FinishProposal {
            finish_id: finish_id.into(),
            run_id: "run".into(),
            outcome: outcome::Outcome::Completed,
            operation_set_hash: "hash".into(),
            signed_bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn resend_same_finish_id_keeps_original_bytes() {
        let mut tracker = FinishTracker::new();
        tracker.propose(proposal("f1", b"original"));
        // A re-send with the same finish_id but different bytes must keep the original.
        let returned = tracker.propose(proposal("f1", b"different"));
        assert_eq!(returned.signed_bytes, b"original");
    }

    #[test]
    fn distinct_finish_ids_are_separate() {
        let mut tracker = FinishTracker::new();
        tracker.propose(proposal("f1", b"one"));
        tracker.propose(proposal("f2", b"two"));
        assert_eq!(tracker.get("f1").unwrap().signed_bytes, b"one");
        assert_eq!(tracker.get("f2").unwrap().signed_bytes, b"two");
    }

    #[test]
    fn unknown_finish_id_is_none() {
        let tracker = FinishTracker::new();
        assert!(tracker.get("missing").is_none());
    }
}
