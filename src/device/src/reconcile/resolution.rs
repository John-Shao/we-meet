//! operation_resolution consumption (device-design §3.1 operation_resolution row,
//! B03 carrier §3.1). A resolution is the only way a journal row leaves `unknown`.
//! The device verifies the server signature, validates the closed sets, and applies
//! the state monotonically by `resolution_revision` (lower → conflict, same →
//! idempotent). A degradation terminal (`evidence_unavailable`/`evidence_exhausted`)
//! resolves the row but never proves the action was un-executed; the reservation
//! stays `unknown` (invariant 2).

use rusqlite::Connection;

use crate::frame::resolution::{OperationResolutionBody, ResolutionAckBody, ResolutionError};
use crate::journal::recover::{self, ResolutionApply};
use crate::jwk::EcP256Jwk;

/// The degradation codes that resolve a row without proving non-execution.
pub const DEGRADATION_CODES: &[&str] = &["evidence_unavailable", "evidence_exhausted"];

/// A resolution consumption failure.
#[derive(Debug)]
pub enum ConsumeError {
    Signature,
    Validation(ResolutionError),
    Sql(rusqlite::Error),
}

impl From<ResolutionError> for ConsumeError {
    fn from(err: ResolutionError) -> Self {
        Self::Validation(err)
    }
}

impl From<rusqlite::Error> for ConsumeError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Sql(err)
    }
}

/// Whether a resolution code is a degradation terminal (keeps the reservation
/// `unknown`, never a proof of non-execution).
pub fn is_degradation(code: Option<&str>) -> bool {
    code.map(|c| DEGRADATION_CODES.contains(&c))
        .unwrap_or(false)
}

/// Consume a server resolution and return the ack the device should send. The ack
/// only advances the delivery watermark; it is not a Run-terminal precondition.
pub fn consume(
    conn: &Connection,
    jwk: &EcP256Jwk,
    org_id: &str,
    resolution: &OperationResolutionBody,
) -> Result<ResolutionAckBody, ConsumeError> {
    if !resolution.verify(jwk) {
        return Err(ConsumeError::Signature);
    }
    resolution.validate()?;
    let apply = recover::apply_resolution(
        conn,
        org_id,
        &resolution.operation_id,
        &resolution.state,
        resolution.resolution_revision as i64,
    )?;
    let state = match apply {
        ResolutionApply::Applied | ResolutionApply::AlreadyApplied => "applied",
        ResolutionApply::Conflict => "conflict",
        ResolutionApply::JournalRowMissing => "journal_row_missing",
    };
    Ok(ResolutionAckBody {
        resolve_id: resolution.resolve_id.clone(),
        state: state.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{resolution, sign};
    use crate::journal::{meta, record, schema};
    use crate::key::{DeviceKey, SoftwareKey};

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "work-reconcile-resolution-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&path).unwrap();
        schema::apply(&conn).unwrap();
        meta::init(&conn, "dev", "epoch-1", schema::SCHEMA_VERSION, &[0u8; 32]).unwrap();
        (conn, path)
    }

    fn ctx() -> record::RecordContext<'static> {
        record::RecordContext {
            org: "org",
            subject: "sub",
            device: "dev",
            journal_epoch: "epoch-1",
            schema_version: schema::SCHEMA_VERSION,
        }
    }

    fn seed_unknown(conn: &Connection, op: &str) {
        record::append_action(
            conn,
            &[3u8; 32],
            &ctx(),
            &record::ActionRow {
                org_id: "org",
                operation_id: op,
                run_id: "run",
                attempt: 1,
                step_key: "step",
                logical_key: op,
                supersedes: None,
                request_hash: "hash",
                fence: 1,
                session_id: "sess",
                generation: 1,
                permit_jti: op,
                state: "unknown",
                result_hash: None,
                result_ref: None,
            },
            b"body",
        )
        .unwrap();
    }

    fn signed(
        server: &SoftwareKey,
        op: &str,
        state: &str,
        revision: u64,
    ) -> OperationResolutionBody {
        let mut body = OperationResolutionBody {
            resolve_id: format!("res-{op}"),
            run_id: "run".into(),
            operation_id: op.into(),
            attempt_id: "att1".into(),
            state: state.into(),
            delivery_state: "delivered".into(),
            code: None,
            usage_source: None,
            settlement_state: "unknown".into(),
            resolution_revision: revision,
            signature: None,
        };
        let sig = sign::sign_frame(server, resolution::FRAME_TYPE, &body.to_value()).unwrap();
        body.signature = Some(sig);
        body
    }

    #[test]
    fn consumes_resolution_and_acks_applied() {
        let (conn, path) = temp_conn();
        seed_unknown(&conn, "op1");
        let server = SoftwareKey::random();
        let ack = consume(
            &conn,
            &server.public_jwk(),
            "org",
            &signed(&server, "op1", "failed", 1),
        )
        .unwrap();
        assert_eq!(ack.state, "applied");
        assert_eq!(
            recover::unreconciled_unknown_count(&conn, "run").unwrap(),
            0
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn lower_revision_acks_conflict_without_rollback() {
        let (conn, path) = temp_conn();
        seed_unknown(&conn, "op1");
        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        consume(&conn, &jwk, "org", &signed(&server, "op1", "failed", 5)).unwrap();
        let ack = consume(&conn, &jwk, "org", &signed(&server, "op1", "succeeded", 4)).unwrap();
        assert_eq!(ack.state, "conflict");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_row_acks_journal_row_missing() {
        let (conn, path) = temp_conn();
        let server = SoftwareKey::random();
        let ack = consume(
            &conn,
            &server.public_jwk(),
            "org",
            &signed(&server, "ghost", "failed", 1),
        )
        .unwrap();
        assert_eq!(ack.state, "journal_row_missing");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn bad_signature_rejected() {
        let (conn, path) = temp_conn();
        seed_unknown(&conn, "op1");
        let server = SoftwareKey::random();
        let other = SoftwareKey::random();
        let body = signed(&server, "op1", "failed", 1);
        assert!(matches!(
            consume(&conn, &other.public_jwk(), "org", &body),
            Err(ConsumeError::Signature)
        ));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn degradation_never_proves_non_execution() {
        assert!(is_degradation(Some("evidence_unavailable")));
        assert!(is_degradation(Some("evidence_exhausted")));
        assert!(!is_degradation(Some("model_error")));
        assert!(!is_degradation(None));
    }
}
