//! Run outcome determination (device-design §3.4 step 2). `completed` requires
//! all of: the loop ended normally, every Operation is terminal with its receipt
//! in the outbox, no model dispatch is pending/undelivered (superseded dispatches
//! excluded), and at least one successful `artifact.write` deliverable exists.
//! Otherwise the run is `failed` with a `reason_code` from the closed set. A model
//! that only replied text without writing a deliverable fails `no_deliverable`.
//! The device-side and server-side thresholds use the same criteria; the device
//! must not propose `completed` while a dispatch is still undelivered.

/// The closed `reason_code` set for a failed run (device-design §3.4 step 2).
pub const REASON_CODES: &[&str] = &[
    "no_deliverable",
    "model_error",
    "tool_limit",
    "runtime_limit_exceeded",
    "runtime_unresumable",
    "checkpoint_lost",
    "input_missing",
];

/// The proposed run outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Failed { reason_code: String },
}

/// The local facts the Broker judges the outcome from (never Node's self-report).
#[derive(Clone, Debug, Default)]
pub struct RunFacts {
    pub loop_ended_normally: bool,
    pub all_operations_terminal: bool,
    pub receipts_in_outbox: bool,
    /// A model dispatch still pending/undelivered (superseded ones excluded).
    pub has_pending_model_dispatch: bool,
    /// Count of successful `artifact.write` deliverable versions for this Run.
    pub deliverable_count: usize,
    pub input_missing: bool,
    pub checkpoint_lost: bool,
    pub runtime_unresumable: bool,
    pub runtime_limit_exceeded: bool,
    pub tool_limit_hit: bool,
    pub model_error: bool,
}

/// Determine the outcome from local facts. The failure reason priority is a
/// device-side convention (the design fixes the closed set, not the ordering);
/// `no_deliverable` is the fallback when no specific failure applies.
pub fn determine_outcome(facts: &RunFacts) -> Outcome {
    if facts.loop_ended_normally
        && facts.all_operations_terminal
        && facts.receipts_in_outbox
        && !facts.has_pending_model_dispatch
        && facts.deliverable_count >= 1
    {
        return Outcome::Completed;
    }
    let reason = if facts.input_missing {
        "input_missing"
    } else if facts.checkpoint_lost {
        "checkpoint_lost"
    } else if facts.runtime_unresumable {
        "runtime_unresumable"
    } else if facts.runtime_limit_exceeded {
        "runtime_limit_exceeded"
    } else if facts.tool_limit_hit {
        "tool_limit"
    } else if facts.model_error {
        "model_error"
    } else {
        "no_deliverable"
    };
    Outcome::Failed {
        reason_code: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn completed_facts() -> RunFacts {
        RunFacts {
            loop_ended_normally: true,
            all_operations_terminal: true,
            receipts_in_outbox: true,
            has_pending_model_dispatch: false,
            deliverable_count: 1,
            ..Default::default()
        }
    }

    #[test]
    fn reason_codes_closure_has_seven() {
        assert_eq!(REASON_CODES.len(), 7);
    }

    #[test]
    fn all_conditions_met_is_completed() {
        assert_eq!(determine_outcome(&completed_facts()), Outcome::Completed);
    }

    #[test]
    fn no_deliverable_fails() {
        let mut facts = completed_facts();
        facts.deliverable_count = 0;
        assert_eq!(
            determine_outcome(&facts),
            Outcome::Failed {
                reason_code: "no_deliverable".into()
            }
        );
    }

    #[test]
    fn pending_model_dispatch_blocks_completed() {
        let mut facts = completed_facts();
        facts.has_pending_model_dispatch = true;
        assert!(matches!(determine_outcome(&facts), Outcome::Failed { .. }));
    }

    #[test]
    fn non_terminal_operations_block_completed() {
        let mut facts = completed_facts();
        facts.all_operations_terminal = false;
        assert!(matches!(determine_outcome(&facts), Outcome::Failed { .. }));
    }

    #[test]
    fn abnormal_loop_end_blocks_completed() {
        let mut facts = completed_facts();
        facts.loop_ended_normally = false;
        assert!(matches!(determine_outcome(&facts), Outcome::Failed { .. }));
    }

    #[test]
    fn each_failure_reason_is_in_closed_set() {
        let mut facts = completed_facts();
        facts.deliverable_count = 0;
        facts.model_error = true;
        let Outcome::Failed { reason_code } = determine_outcome(&facts) else {
            panic!("expected failed");
        };
        assert!(REASON_CODES.contains(&reason_code.as_str()));
    }

    #[test]
    fn specific_failure_precedes_no_deliverable() {
        let mut facts = completed_facts();
        facts.deliverable_count = 0;
        facts.checkpoint_lost = true;
        assert_eq!(
            determine_outcome(&facts),
            Outcome::Failed {
                reason_code: "checkpoint_lost".into()
            }
        );
    }
}
