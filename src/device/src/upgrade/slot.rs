//! Dual-slot activation and rollback (device-design §8 :378). Two slots each hold
//! a complete release matrix (shell + agent + runtime + canonical_schema together).
//! Activation swaps the active slot atomically; on failure the device rolls back
//! to the original COMPLETE version — never just Node leaving a new schema. The
//! switch only happens with no active Run and all Operations reconciled. On
//! revocation or a critical security flaw the device stops new execution rather
//! than rolling back to a vulnerable version.

use crate::upgrade::manifest::ReleaseManifest;

/// A physical slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
    A,
    B,
}

impl Slot {
    /// The other slot.
    pub fn other(self) -> Slot {
        match self {
            Slot::A => Slot::B,
            Slot::B => Slot::A,
        }
    }

    fn index(self) -> usize {
        match self {
            Slot::A => 0,
            Slot::B => 1,
        }
    }
}

/// A slot's lifecycle state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotState {
    Empty,
    Staged,
    Active,
    Failed,
}

/// An upgrade failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpgradeError {
    NotStaged,
    ActiveRun,
    Unreconciled,
    Blocked,
    Rollback,
    NoRollbackTarget,
}

/// The switch precondition facts (§8 :378): no active Run AND all Operations
/// reconciled. Both must hold before a slot switch.
#[derive(Clone, Copy, Debug, Default)]
pub struct SwitchFacts {
    pub has_active_run: bool,
    pub has_unreconciled_unknown: bool,
}

/// Whether a switch is permitted given the local facts.
pub fn may_switch(facts: &SwitchFacts) -> bool {
    !facts.has_active_run && !facts.has_unreconciled_unknown
}

/// The dual-slot upgrade state.
pub struct DualSlot {
    active: Slot,
    manifests: [Option<ReleaseManifest>; 2],
    states: [SlotState; 2],
    rollback: Option<Slot>,
    blocked: bool,
}

impl DualSlot {
    /// Initialize with one complete active version in slot A.
    pub fn new(initial: ReleaseManifest) -> Self {
        Self {
            active: Slot::A,
            manifests: [Some(initial), None],
            states: [SlotState::Active, SlotState::Empty],
            rollback: None,
            blocked: false,
        }
    }

    pub fn active_slot(&self) -> Slot {
        self.active
    }

    /// The complete active release matrix.
    pub fn active_manifest(&self) -> &ReleaseManifest {
        self.manifests[self.active.index()]
            .as_ref()
            .expect("active slot always holds a complete manifest")
    }

    pub fn state(&self, slot: Slot) -> SlotState {
        self.states[slot.index()]
    }

    pub fn is_blocked(&self) -> bool {
        self.blocked
    }

    /// Stage a (already self-tested) manifest into the inactive slot.
    pub fn stage(&mut self, manifest: ReleaseManifest) {
        let target = self.active.other();
        self.manifests[target.index()] = Some(manifest);
        self.states[target.index()] = SlotState::Staged;
    }

    /// Activate the staged slot. `activation_ok` is the post-switch boot/self-test
    /// result. On success the previous complete version is kept as the rollback
    /// target; on failure the active slot is unchanged (original complete version
    /// preserved) and the staged slot is marked Failed.
    pub fn activate(
        &mut self,
        facts: &SwitchFacts,
        activation_ok: bool,
    ) -> Result<(), UpgradeError> {
        if self.blocked {
            return Err(UpgradeError::Blocked);
        }
        if facts.has_active_run {
            return Err(UpgradeError::ActiveRun);
        }
        if facts.has_unreconciled_unknown {
            return Err(UpgradeError::Unreconciled);
        }
        let target = self.active.other();
        if self.states[target.index()] != SlotState::Staged {
            return Err(UpgradeError::NotStaged);
        }
        if activation_ok {
            let old = self.active;
            self.active = target;
            self.states[target.index()] = SlotState::Active;
            // Keep the old complete version staged as the rollback target.
            self.states[old.index()] = SlotState::Staged;
            self.rollback = Some(old);
            Ok(())
        } else {
            self.states[target.index()] = SlotState::Failed;
            Err(UpgradeError::Rollback)
        }
    }

    /// Report a post-activation failure: roll back to the previous COMPLETE version
    /// (the whole matrix, not a partial Node-only rollback).
    pub fn report_failure(&mut self) -> Result<(), UpgradeError> {
        let Some(prev) = self.rollback.take() else {
            return Err(UpgradeError::NoRollbackTarget);
        };
        self.states[self.active.index()] = SlotState::Failed;
        self.active = prev;
        self.states[prev.index()] = SlotState::Active;
        Ok(())
    }

    /// Security block (revocation / critical flaw): stop new execution. Does NOT
    /// roll back to a potentially vulnerable version (§8 :378).
    pub fn block(&mut self) {
        self.blocked = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(shell: &str, schema: &str) -> ReleaseManifest {
        ReleaseManifest {
            shell_version: shell.into(),
            agent_version: "1.0.0".into(),
            runtime_digest: "a".repeat(64),
            node_version: "24.0.0".into(),
            protocol_major: 2,
            protocol_minor: 0,
            required_features: vec![],
            tool_manifest_hash: "b".repeat(64),
            profile_id: "profile".into(),
            canonical_schema: schema.into(),
            min_windows_build: 19041,
            timestamp: "2026-11-15T00:00:00Z".into(),
            sbom_ref: "sbom".into(),
            signature: None,
        }
    }

    fn idle() -> SwitchFacts {
        SwitchFacts::default()
    }

    #[test]
    fn successful_activation_swaps_and_keeps_rollback() {
        let mut slots = DualSlot::new(manifest("1.0.0", "2"));
        slots.stage(manifest("2.0.0", "3"));
        slots.activate(&idle(), true).unwrap();
        assert_eq!(slots.active_slot(), Slot::B);
        assert_eq!(slots.active_manifest().shell_version, "2.0.0");
        assert_eq!(slots.state(Slot::A), SlotState::Staged);
    }

    #[test]
    fn failed_activation_preserves_original_complete_version() {
        let mut slots = DualSlot::new(manifest("1.0.0", "2"));
        slots.stage(manifest("2.0.0", "3"));
        assert_eq!(slots.activate(&idle(), false), Err(UpgradeError::Rollback));
        // Original complete version intact (schema not left at the new one).
        assert_eq!(slots.active_slot(), Slot::A);
        assert_eq!(slots.active_manifest().shell_version, "1.0.0");
        assert_eq!(slots.active_manifest().canonical_schema, "2");
        assert_eq!(slots.state(Slot::B), SlotState::Failed);
    }

    #[test]
    fn post_activation_failure_rolls_back_whole_matrix() {
        let mut slots = DualSlot::new(manifest("1.0.0", "2"));
        slots.stage(manifest("2.0.0", "3"));
        slots.activate(&idle(), true).unwrap();
        slots.report_failure().unwrap();
        assert_eq!(slots.active_slot(), Slot::A);
        // The whole old matrix returns together (shell + schema), not Node-only.
        assert_eq!(slots.active_manifest().shell_version, "1.0.0");
        assert_eq!(slots.active_manifest().canonical_schema, "2");
        assert_eq!(slots.state(Slot::B), SlotState::Failed);
    }

    #[test]
    fn switch_blocked_by_active_run_or_unknown() {
        let mut slots = DualSlot::new(manifest("1.0.0", "2"));
        slots.stage(manifest("2.0.0", "3"));
        let active_run = SwitchFacts {
            has_active_run: true,
            has_unreconciled_unknown: false,
        };
        assert_eq!(
            slots.activate(&active_run, true),
            Err(UpgradeError::ActiveRun)
        );
        let unknown = SwitchFacts {
            has_active_run: false,
            has_unreconciled_unknown: true,
        };
        assert_eq!(
            slots.activate(&unknown, true),
            Err(UpgradeError::Unreconciled)
        );
        assert!(!may_switch(&active_run));
        assert!(!may_switch(&unknown));
        assert!(may_switch(&idle()));
    }

    #[test]
    fn security_block_stops_and_does_not_roll_back() {
        let mut slots = DualSlot::new(manifest("1.0.0", "2"));
        slots.stage(manifest("2.0.0", "3"));
        slots.block();
        assert!(slots.is_blocked());
        assert_eq!(slots.activate(&idle(), true), Err(UpgradeError::Blocked));
        // Still on the original version; block did not switch or roll back.
        assert_eq!(slots.active_slot(), Slot::A);
    }

    #[test]
    fn activate_without_stage_rejected() {
        let mut slots = DualSlot::new(manifest("1.0.0", "2"));
        assert_eq!(slots.activate(&idle(), true), Err(UpgradeError::NotStaged));
        assert_eq!(slots.report_failure(), Err(UpgradeError::NoRollbackTarget));
    }
}
