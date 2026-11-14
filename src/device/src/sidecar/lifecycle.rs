//! Sidecar lifecycle (device-design §3.2). `start_nonce` is single-instance: a
//! crashed sidecar's old nonce cannot restart the loop; `runtime_digest` pins the
//! exact bundle. Durable single-use is the journal `runtime_start.start_nonce`
//! UNIQUE constraint (batch 2); this is the in-memory state machine.

/// The sidecar process state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SidecarState {
    Spawned,
    Running,
    Exited,
}

/// A lifecycle violation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleError {
    InvalidTransition,
    NonceReuse,
}

/// A single sidecar instance bound to a Run binding.
pub struct Sidecar {
    run_id: String,
    binding_revision: u64,
    start_nonce: String,
    runtime_digest: String,
    state: SidecarState,
}

impl Sidecar {
    /// Register a newly spawned sidecar.
    pub fn new(
        run_id: &str,
        binding_revision: u64,
        start_nonce: &str,
        runtime_digest: &str,
    ) -> Self {
        Self {
            run_id: run_id.to_string(),
            binding_revision,
            start_nonce: start_nonce.to_string(),
            runtime_digest: runtime_digest.to_string(),
            state: SidecarState::Spawned,
        }
    }

    /// Transition Spawned → Running.
    pub fn mark_running(&mut self) -> Result<(), LifecycleError> {
        if self.state != SidecarState::Spawned {
            return Err(LifecycleError::InvalidTransition);
        }
        self.state = SidecarState::Running;
        Ok(())
    }

    /// Transition to Exited (from Spawned or Running).
    pub fn mark_exited(&mut self) -> Result<(), LifecycleError> {
        if self.state == SidecarState::Exited {
            return Err(LifecycleError::InvalidTransition);
        }
        self.state = SidecarState::Exited;
        Ok(())
    }

    /// A crashed/exited sidecar's nonce must not be reused to restart the loop.
    pub fn ensure_nonce_fresh(&self, nonce: &str) -> Result<(), LifecycleError> {
        if self.state == SidecarState::Exited && nonce == self.start_nonce {
            return Err(LifecycleError::NonceReuse);
        }
        Ok(())
    }

    pub fn state(&self) -> SidecarState {
        self.state
    }

    pub fn start_nonce(&self) -> &str {
        &self.start_nonce
    }

    pub fn runtime_digest(&self) -> &str {
        &self.runtime_digest
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn binding_revision(&self) -> u64 {
        self.binding_revision
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sidecar() -> Sidecar {
        Sidecar::new("run", 1, "nonce-1", "digest-1")
    }

    #[test]
    fn normal_lifecycle() {
        let mut s = sidecar();
        assert_eq!(s.state(), SidecarState::Spawned);
        s.mark_running().unwrap();
        assert_eq!(s.state(), SidecarState::Running);
        s.mark_exited().unwrap();
        assert_eq!(s.state(), SidecarState::Exited);
    }

    #[test]
    fn cannot_run_twice() {
        let mut s = sidecar();
        s.mark_running().unwrap();
        assert_eq!(s.mark_running(), Err(LifecycleError::InvalidTransition));
    }

    #[test]
    fn cannot_exit_twice() {
        let mut s = sidecar();
        s.mark_exited().unwrap();
        assert_eq!(s.mark_exited(), Err(LifecycleError::InvalidTransition));
    }

    #[test]
    fn exited_nonce_cannot_restart() {
        let mut s = sidecar();
        s.mark_exited().unwrap();
        assert_eq!(
            s.ensure_nonce_fresh("nonce-1"),
            Err(LifecycleError::NonceReuse)
        );
        // A fresh nonce is allowed.
        assert_eq!(s.ensure_nonce_fresh("nonce-2"), Ok(()));
    }

    #[test]
    fn running_nonce_is_not_reuse() {
        let s = sidecar();
        assert_eq!(s.ensure_nonce_fresh("nonce-1"), Ok(()));
    }

    #[test]
    fn accessors() {
        let s = sidecar();
        assert_eq!(s.run_id(), "run");
        assert_eq!(s.binding_revision(), 1);
        assert_eq!(s.start_nonce(), "nonce-1");
        assert_eq!(s.runtime_digest(), "digest-1");
    }
}
