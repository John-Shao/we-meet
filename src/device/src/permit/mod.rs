//! Device-side permit, lease and fence (device-design §3.3). The SignedPermit is
//! server-signed and verified here; the lease state machine uses a monotonic
//! deadline with a history-return-only mode; `fence` is `run.fence` carried in
//! both (no device-side counter). Permit issuance, dispatch CAS and lease-renewal
//! RPCs are server-side (gateway batch); sleep OS-event detection is the
//! supervisor batch (this batch exposes the invalidation hook).

pub mod lease;
pub mod signed;

#[cfg(test)]
mod tests {
    use super::signed::{PermitContext, SignedPermit, AUD_DEVICE_TOOL, FRAME_TYPE};
    use crate::frame::sign;
    use crate::journal::{self, record};
    use crate::key::{DeviceKey, SoftwareKey};

    /// A validated permit's jti is registered single-use in the journal: the
    /// first action consumes it, a re-sent command with the same jti fails the
    /// UNIQUE insert and must only return the journal (no re-execution).
    #[test]
    fn permit_jti_is_single_use_through_journal() {
        let server_key = SoftwareKey::random();
        let mut permit = SignedPermit {
            v: 2,
            aud: AUD_DEVICE_TOOL.into(),
            kid: "kid".into(),
            jti: "jti-once".into(),
            org_id: "org".into(),
            subject_id: "sub".into(),
            device_id: "dev".into(),
            session_id: "sess".into(),
            agent_instance_id: "agent".into(),
            boot_id: "boot".into(),
            generation: 1,
            run_id: "run".into(),
            operation_id: "op1".into(),
            dispatch_attempt_id: "attempt".into(),
            request_hash: "hash".into(),
            fence: 2,
            policy_epoch: 1,
            access_epoch: 1,
            grant_id: "grant".into(),
            grant_revision: 1,
            approval_id: "approval".into(),
            decision_revision: 1,
            scope_hash: "scope".into(),
            destination_id: None,
            max_bytes: 1024,
            issued_at: 1000,
            expires_at: 1005,
            signature: None,
        };
        let value = permit.to_value();
        permit.signature = Some(sign::sign_frame(&server_key, FRAME_TYPE, &value).unwrap());

        let ctx = PermitContext {
            server_permit_key: &server_key.public_jwk(),
            org_id: "org",
            subject_id: "sub",
            device_id: "dev",
            session_id: "sess",
            run_fence: 2,
            now_unix: 1001,
            remaining_lease_secs: 30,
        };
        permit.validate(&ctx).unwrap();

        let path =
            std::env::temp_dir().join(format!("work-permit-jti-{}.db", uuid::Uuid::new_v4()));
        let journal = journal::Journal::create(&path, "dev", &journal::dek::TestWrap).unwrap();
        let rctx = journal.context("org", "sub");
        let row = record::ActionRow {
            org_id: "org",
            operation_id: "op1",
            run_id: "run",
            attempt: 1,
            step_key: "step",
            logical_key: "step#0",
            supersedes: None,
            request_hash: "hash",
            fence: 2,
            session_id: "sess",
            generation: 1,
            permit_jti: &permit.jti,
            state: "started",
            result_hash: None,
            result_ref: None,
        };
        // First registration consumes the jti.
        record::append_action(journal.connection(), journal.dek(), &rctx, &row, b"action").unwrap();
        // A re-sent command with the same jti is refused by the UNIQUE constraint.
        let mut row2 = record::ActionRow {
            operation_id: "op2",
            ..row
        };
        row2.permit_jti = &permit.jti;
        let err =
            record::append_action(journal.connection(), journal.dek(), &rctx, &row2, b"action");
        assert!(matches!(err, Err(record::RecordError::Sql(_))));

        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
}
