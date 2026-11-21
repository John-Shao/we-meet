//! Durable `local_content` carrier (batch 5, device-design §6.1). The previously
//! orphan `local_content` table now persists the Broker's own sealed-deliverable
//! facts so a restart rebuilds the publication state without re-executing the Run.
//! Plain columns (no AAD): extending them leaves `SCHEMA_VERSION` unchanged.
//!
//! `publish_state` is the durable publication fact: `sealed` when the deliverable
//! is recorded, `published` once a verified `publish_ack` lands. `receipt_seq` is
//! the completed receipt's seq stamped at production time — it survives the
//! transient `receipt_outbox` cleanup (B03 §3.2) so `local_publish` can still name
//! `receipt_ref = journal_epoch:seq` after a restart.

use rusqlite::{params, Connection};

/// One sealed deliverable's durable facts (the resume rebuild source).
#[derive(Clone, Debug)]
pub struct DeliverableRow {
    pub run_id: String,
    pub operation_id: String,
    pub version_id: String,
    pub logical_name: String,
    pub format: String,
    pub content_hash: String,
    pub byte_count: u64,
    pub receipt_seq: Option<u64>,
    pub publish_state: String,
}

/// Persist a sealed deliverable (RecordDeliverable). Idempotent on `version_id`:
/// an existing row is kept verbatim so a re-record never resets `published` or
/// drops the stamped `receipt_seq`.
pub fn record(conn: &Connection, row: &DeliverableRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO local_content
            (version_id, origin, publish_state, sealed_hash, classification,
             run_id, operation_id, logical_name, format, byte_count)
         VALUES (?1, 'device_write', 'sealed', ?2, 'local_only', ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(version_id) DO NOTHING",
        params![
            row.version_id,
            row.content_hash,
            row.run_id,
            row.operation_id,
            row.logical_name,
            row.format,
            row.byte_count as i64,
        ],
    )?;
    Ok(())
}

/// Stamp the completed receipt's seq onto the deliverable row of that operation.
pub fn stamp_receipt_seq(conn: &Connection, operation_id: &str, seq: u64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE local_content SET receipt_seq = ?1 WHERE operation_id = ?2",
        params![seq as i64, operation_id],
    )?;
    Ok(())
}

/// Mark a version published (verified publish_ack).
pub fn mark_published(conn: &Connection, version_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE local_content SET publish_state = 'published' WHERE version_id = ?1",
        params![version_id],
    )?;
    Ok(())
}

/// Every persisted deliverable row (the resume rebuild source). Rows without a
/// `run_id` are not Broker deliverables and are skipped.
pub fn load_all(conn: &Connection) -> rusqlite::Result<Vec<DeliverableRow>> {
    let mut stmt = conn.prepare(
        "SELECT run_id, operation_id, version_id, COALESCE(logical_name, ''),
                COALESCE(format, ''), COALESCE(sealed_hash, ''),
                COALESCE(byte_count, 0), receipt_seq, COALESCE(publish_state, 'sealed')
         FROM local_content WHERE run_id IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(DeliverableRow {
            run_id: r.get(0)?,
            operation_id: r.get(1)?,
            version_id: r.get(2)?,
            logical_name: r.get(3)?,
            format: r.get(4)?,
            content_hash: r.get(5)?,
            byte_count: r.get::<_, i64>(6)? as u64,
            receipt_seq: r.get::<_, Option<i64>>(7)?.map(|s| s as u64),
            publish_state: r.get(8)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::schema;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        schema::apply(&c).unwrap();
        c
    }

    fn row(version: &str, op: &str) -> DeliverableRow {
        DeliverableRow {
            run_id: "run".into(),
            operation_id: op.into(),
            version_id: version.into(),
            logical_name: "a".into(),
            format: "md".into(),
            content_hash: "b".repeat(64),
            byte_count: 7,
            receipt_seq: None,
            publish_state: "sealed".into(),
        }
    }

    #[test]
    fn record_then_load_round_trips() {
        let c = conn();
        record(&c, &row("v1", "op-1")).unwrap();
        let loaded = load_all(&c).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].version_id, "v1");
        assert_eq!(loaded[0].publish_state, "sealed");
        assert_eq!(loaded[0].content_hash, "b".repeat(64));
        assert_eq!(loaded[0].byte_count, 7);
        assert_eq!(loaded[0].receipt_seq, None);
    }

    #[test]
    fn record_is_idempotent_and_preserves_published() {
        let c = conn();
        record(&c, &row("v1", "op-1")).unwrap();
        mark_published(&c, "v1").unwrap();
        stamp_receipt_seq(&c, "op-1", 3).unwrap();
        // A re-record must not reset published or drop the seq.
        record(&c, &row("v1", "op-1")).unwrap();
        let loaded = load_all(&c).unwrap();
        assert_eq!(loaded[0].publish_state, "published");
        assert_eq!(loaded[0].receipt_seq, Some(3));
    }

    #[test]
    fn stamp_and_publish_move_state() {
        let c = conn();
        record(&c, &row("v1", "op-1")).unwrap();
        stamp_receipt_seq(&c, "op-1", 5).unwrap();
        mark_published(&c, "v1").unwrap();
        let loaded = load_all(&c).unwrap();
        assert_eq!(loaded[0].receipt_seq, Some(5));
        assert_eq!(loaded[0].publish_state, "published");
    }
}
