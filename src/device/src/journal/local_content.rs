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

use rusqlite::{params, Connection, OptionalExtension};

use crate::journal::record::{open_record, seal_record, RecordContext, RecordError};

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

#[derive(Clone, Debug)]
pub struct LocalContentBody {
    pub row: DeliverableRow,
    pub bytes: Vec<u8>,
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

/// Persist a sealed deliverable and its encrypted body. The plaintext never reaches SQLite/WAL.
pub fn record_sealed(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    row: &DeliverableRow,
    plaintext: &[u8],
) -> Result<(), RecordError> {
    let expected = row
        .content_hash
        .strip_prefix("sha256:")
        .unwrap_or(&row.content_hash);
    if crate::sha256_hex(plaintext) != expected || plaintext.len() as u64 != row.byte_count {
        return Err(RecordError::Crypto(
            crate::journal::crypto::CryptoError::Open,
        ));
    }
    let sealed = seal_record(dek, ctx, "local_content", &row.version_id, plaintext)?;
    conn.execute(
        "INSERT INTO local_content
            (version_id, origin, publish_state, sealed_hash, classification,
             run_id, operation_id, logical_name, format, byte_count,
             sealed_blob_hash, sealed_blob)
         VALUES (?1, 'device_write', 'sealed', ?2, 'local_only', ?3, ?4, ?5, ?6, ?7, ?2, ?8)
         ON CONFLICT(version_id) DO NOTHING",
        params![
            row.version_id,
            row.content_hash,
            row.run_id,
            row.operation_id,
            row.logical_name,
            row.format,
            row.byte_count as i64,
            sealed,
        ],
    )?;
    Ok(())
}

pub fn record_approval(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    approval_id: &str,
    row: &DeliverableRow,
    plaintext: &[u8],
) -> Result<(), RecordError> {
    if !valid_uuid(approval_id)
        || !valid_uuid(&row.version_id)
        || !valid_uuid(&row.operation_id)
        || row.run_id.is_empty()
        || plaintext.len() as u64 != row.byte_count
        || crate::sha256_hex(plaintext)
            != row
                .content_hash
                .strip_prefix("sha256:")
                .unwrap_or(&row.content_hash)
    {
        return Err(RecordError::InvalidLocalDraft);
    }
    let sealed = seal_record(dek, ctx, "local_content", &row.version_id, plaintext)?;
    conn.execute(
        "INSERT INTO local_content
            (version_id, origin, publish_state, classification, sealed_hash, run_id,
             operation_id, logical_name, format, byte_count, sealed_blob_hash, sealed_blob,
             approval_id)
         VALUES (?1, 'approval', 'sealed', 'local_only', ?2, ?3, ?4, ?5, ?6, ?7, ?2, ?8, ?9)
         ON CONFLICT(version_id) DO NOTHING",
        params![
            row.version_id,
            row.content_hash,
            row.run_id,
            row.operation_id,
            row.logical_name,
            row.format,
            row.byte_count as i64,
            sealed,
            approval_id,
        ],
    )?;
    Ok(())
}

pub fn read_approval(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    approval_id: &str,
) -> Result<Option<LocalContentBody>, RecordError> {
    if !valid_uuid(approval_id) {
        return Ok(None);
    }
    let version_id: Option<String> = conn
        .query_row(
            "SELECT version_id FROM local_content WHERE approval_id = ?1 AND origin = 'approval'",
            [approval_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(version_id) = version_id else {
        return Ok(None);
    };
    read_sealed(conn, dek, ctx, &version_id)
}

pub fn record_transcript(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    run_id: &str,
    row: &DeliverableRow,
    plaintext: &[u8],
) -> Result<(), RecordError> {
    if run_id.is_empty()
        || run_id.len() > 512
        || run_id.contains('\0')
        || row.run_id != run_id
        || row.version_id != run_id
        || row.format != "json"
        || plaintext.len() as u64 != row.byte_count
        || crate::sha256_hex(plaintext)
            != row
                .content_hash
                .strip_prefix("sha256:")
                .unwrap_or(&row.content_hash)
    {
        return Err(RecordError::InvalidLocalDraft);
    }
    let sealed = seal_record(dek, ctx, "local_content", run_id, plaintext)?;
    conn.execute(
        "INSERT INTO local_content
            (version_id, origin, publish_state, classification, sealed_hash, run_id,
             operation_id, logical_name, format, byte_count, sealed_blob_hash, sealed_blob)
         VALUES (?1, 'run_transcript', 'sealed', 'local_only', ?2, ?3, ?4, 'run_transcript',
                 'json', ?5, ?2, ?6)
         ON CONFLICT(version_id) DO NOTHING",
        params![
            run_id,
            row.content_hash,
            run_id,
            row.operation_id,
            row.byte_count as i64,
            sealed,
        ],
    )?;
    Ok(())
}

pub fn read_transcript(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    run_id: &str,
) -> Result<Option<LocalContentBody>, RecordError> {
    if run_id.is_empty() || run_id.len() > 512 || run_id.contains('\0') {
        return Ok(None);
    }
    let stored: Option<String> = conn
        .query_row(
            "SELECT version_id FROM local_content WHERE run_id = ?1 AND origin = 'run_transcript'",
            [run_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(version_id) = stored else {
        return Ok(None);
    };
    read_sealed(conn, dek, ctx, &version_id)
}

/// Open one persisted local deliverable under its identity-bound AAD. Missing, legacy body-less,
/// tampered or hash/size-mismatched rows all read as unavailable, never as partial content.
pub fn read_sealed(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    version_id: &str,
) -> Result<Option<LocalContentBody>, RecordError> {
    let mut stmt = conn.prepare(
        "SELECT run_id, operation_id, version_id, COALESCE(logical_name, ''),
                COALESCE(format, ''), COALESCE(sealed_hash, ''),
                COALESCE(byte_count, 0), receipt_seq, COALESCE(publish_state, 'sealed'), sealed_blob
         FROM local_content WHERE version_id = ?1 AND run_id IS NOT NULL AND sealed_blob IS NOT NULL",
    )?;
    let mut rows = stmt.query_map([version_id], |r| {
        Ok((
            DeliverableRow {
                run_id: r.get(0)?,
                operation_id: r.get(1)?,
                version_id: r.get(2)?,
                logical_name: r.get(3)?,
                format: r.get(4)?,
                content_hash: r.get(5)?,
                byte_count: r.get::<_, i64>(6)? as u64,
                receipt_seq: r.get::<_, Option<i64>>(7)?.map(|s| s as u64),
                publish_state: r.get(8)?,
            },
            r.get::<_, Vec<u8>>(9)?,
        ))
    })?;
    let (row, sealed) = match rows.next() {
        Some(row) => row.map_err(RecordError::from)?,
        None => return Ok(None),
    };
    let bytes = match open_record(dek, ctx, "local_content", &row.version_id, &sealed) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let expected = row
        .content_hash
        .strip_prefix("sha256:")
        .unwrap_or(&row.content_hash);
    if crate::sha256_hex(&bytes) != expected || bytes.len() as u64 != row.byte_count {
        return Ok(None);
    }
    Ok(Some(LocalContentBody { row, bytes }))
}

#[derive(Clone, Debug)]
pub struct LocalDraftRow {
    pub version_id: String,
    pub request_id: String,
    pub artifact_id: String,
    pub task_id: String,
    pub base_version_no: u32,
    pub base_hash: String,
    pub format: String,
    pub content_hash: String,
    pub byte_count: u64,
    pub publish_state: String,
    pub created_at: u64,
    pub auth_epoch: u64,
    pub base_version_id: String,
    pub base_byte_count: u64,
}

#[derive(Clone, Debug)]
pub struct LocalDraftBody {
    pub row: LocalDraftRow,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
pub struct LocalDraftCopy {
    pub body: LocalDraftBody,
    pub grant_ref: Option<String>,
}

const LOCAL_DRAFT_TTL_SECONDS: u64 = 30 * 60;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

fn valid_digest(value: &str) -> bool {
    let raw = value.strip_prefix("sha256:").unwrap_or(value);
    raw.len() == 64 && raw.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn draft_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalDraftRow> {
    Ok(LocalDraftRow {
        version_id: row.get(0)?,
        request_id: row.get(1)?,
        artifact_id: row.get(2)?,
        task_id: row.get(3)?,
        base_version_no: row.get::<_, i64>(4)? as u32,
        base_hash: row.get(5)?,
        format: row.get(6)?,
        content_hash: row.get(7)?,
        byte_count: row.get::<_, i64>(8)? as u64,
        publish_state: row.get(9)?,
        created_at: row.get::<_, i64>(10)? as u64,
        auth_epoch: row.get::<_, i64>(11)? as u64,
        base_version_id: row.get(12)?,
        base_byte_count: row.get::<_, i64>(13)? as u64,
    })
}

const DRAFT_COLUMNS: &str = "version_id, request_id, artifact_id, task_id, base_version_no,
    base_hash, format, sealed_hash, byte_count, publish_state, created_at, auth_epoch,
    base_version_id, base_byte_count";

fn expire_drafts(conn: &Connection, now: u64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE local_content SET publish_state = 'expired'
         WHERE origin = 'user_edit' AND publish_state = 'pending_confirm'
           AND created_at <= ?1",
        params![now.saturating_sub(LOCAL_DRAFT_TTL_SECONDS) as i64],
    )?;
    Ok(())
}

/// Seal a user edit and keep only its metadata visible in SQLite. A repeated client_request_id
/// with the same immutable facts replays the draft; a different payload is refused.
pub fn prepare_draft(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    row: &LocalDraftRow,
    plaintext: &[u8],
) -> Result<LocalDraftBody, RecordError> {
    if !valid_uuid(&row.version_id)
        || !valid_uuid(&row.request_id)
        || !valid_uuid(&row.artifact_id)
        || !valid_uuid(&row.task_id)
        || !valid_uuid(&row.base_version_id)
        || !valid_digest(&row.base_hash)
        || !valid_digest(&row.content_hash)
        || !matches!(row.format.as_str(), "md" | "txt" | "json")
        || plaintext.len() as u64 != row.byte_count
        || crate::sha256_hex(plaintext)
            != row
                .content_hash
                .strip_prefix("sha256:")
                .unwrap_or(&row.content_hash)
    {
        return Err(RecordError::InvalidLocalDraft);
    }
    expire_drafts(conn, now_secs())?;
    let base_hash = row
        .base_hash
        .strip_prefix("sha256:")
        .unwrap_or(&row.base_hash)
        .to_ascii_lowercase();
    let base_sealed: Option<Vec<u8>> = conn
        .query_row(
            "SELECT sealed_blob FROM local_content
             WHERE version_id = ?1 AND sealed_blob IS NOT NULL
               AND lower(sealed_hash) IN (?2, ?3)
               AND publish_state IN ('sealed', 'published')",
            params![
                row.base_version_id,
                base_hash,
                format!("sha256:{base_hash}")
            ],
            |row| row.get(0),
        )
        .optional()?;
    let Some(base_sealed) = base_sealed else {
        return Err(RecordError::InvalidLocalDraft);
    };
    let base_bytes = open_record(
        dek,
        ctx,
        "local_content",
        &row.base_version_id,
        &base_sealed,
    )
    .map_err(|_| RecordError::InvalidLocalDraft)?;
    if crate::sha256_hex(&base_bytes) != base_hash {
        return Err(RecordError::InvalidLocalDraft);
    }
    let base_byte_count = base_bytes.len() as u64;
    let existing = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {DRAFT_COLUMNS} FROM local_content WHERE request_id = ?1 AND origin = 'user_edit'"
        ))?;
        stmt.query_row([&row.request_id], draft_from_row)
    };
    match existing {
        Ok(existing) => {
            if existing.version_id == row.version_id
                && existing.artifact_id == row.artifact_id
                && existing.task_id == row.task_id
                && existing.base_version_no == row.base_version_no
                && existing.base_version_id == row.base_version_id
                && existing.base_hash == row.base_hash
                && existing.base_byte_count == base_byte_count
                && existing.format == row.format
                && existing.content_hash == row.content_hash
                && existing.byte_count == row.byte_count
            {
                return read_draft(conn, dek, ctx, &row.version_id)?
                    .ok_or(RecordError::InvalidLocalDraft);
            }
            return Err(RecordError::InvalidLocalDraft);
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(error) => return Err(error.into()),
    }
    let sealed = seal_record(dek, ctx, "local_content", &row.version_id, plaintext)?;
    let mut persisted = row.clone();
    persisted.publish_state = "pending_confirm".into();
    persisted.created_at = now_secs();
    persisted.base_byte_count = base_byte_count;
    conn.execute(
        "INSERT INTO local_content
            (version_id, origin, publish_state, classification, sealed_hash, base_version,
             base_version_no, base_hash, artifact_id, task_id, request_id, logical_name,
             format, byte_count, sealed_blob_hash, sealed_blob, created_at, auth_epoch,
             base_version_id, base_byte_count, grant_ref)
         VALUES (?1, 'user_edit', 'pending_confirm', 'local_only', ?2, ?3, ?3, ?4,
                 ?5, ?6, ?7, ?5, ?8, ?9, ?2, ?10, ?11, ?12, ?13, ?14,
                 (SELECT grant_ref FROM local_content WHERE version_id = ?13))",
        params![
            persisted.version_id,
            persisted.content_hash,
            persisted.base_version_no as i64,
            persisted.base_hash,
            persisted.artifact_id,
            persisted.task_id,
            persisted.request_id,
            persisted.format,
            persisted.byte_count as i64,
            sealed,
            persisted.created_at as i64,
            persisted.auth_epoch as i64,
            persisted.base_version_id,
            persisted.base_byte_count as i64,
        ],
    )?;
    Ok(LocalDraftBody {
        row: persisted,
        bytes: plaintext.to_vec(),
    })
}

fn open_draft_body(
    dek: &[u8; 32],
    ctx: &RecordContext,
    row: LocalDraftRow,
    sealed: Vec<u8>,
) -> Option<LocalDraftBody> {
    let bytes = open_record(dek, ctx, "local_content", &row.version_id, &sealed).ok()?;
    let expected = row
        .content_hash
        .strip_prefix("sha256:")
        .unwrap_or(&row.content_hash);
    if crate::sha256_hex(&bytes) != expected || bytes.len() as u64 != row.byte_count {
        return None;
    }
    Some(LocalDraftBody { row, bytes })
}

fn read_draft_in_states(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    version_id: &str,
    retained: bool,
) -> Result<Option<LocalDraftBody>, RecordError> {
    expire_drafts(conn, now_secs())?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {DRAFT_COLUMNS}, sealed_blob FROM local_content
         WHERE version_id = ?1 AND origin = 'user_edit' AND sealed_blob IS NOT NULL
           AND ((?2 = 0 AND publish_state = 'pending_confirm')
             OR (?2 = 1 AND publish_state IN ('pending_confirm', 'pending_publish', 'expired')))"
    ))?;
    let mut rows = stmt.query_map(params![version_id, retained], |r| {
        Ok((draft_from_row(r)?, r.get::<_, Vec<u8>>(14)?))
    })?;
    let Some(item) = rows.next() else {
        return Ok(None);
    };
    let (row, sealed) = item.map_err(RecordError::from)?;
    Ok(open_draft_body(dek, ctx, row, sealed))
}

pub fn read_draft(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    version_id: &str,
) -> Result<Option<LocalDraftBody>, RecordError> {
    read_draft_in_states(conn, dek, ctx, version_id, false)
}

pub fn read_draft_for_display(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    version_id: &str,
) -> Result<Option<LocalDraftBody>, RecordError> {
    read_draft_in_states(conn, dek, ctx, version_id, true)
}

pub fn list_drafts(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    artifact_id: &str,
    task_id: &str,
) -> Result<Vec<LocalDraftRow>, RecordError> {
    if !valid_uuid(artifact_id) || !valid_uuid(task_id) {
        return Err(RecordError::InvalidLocalDraft);
    }
    expire_drafts(conn, now_secs())?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {DRAFT_COLUMNS}, sealed_blob FROM local_content
         WHERE artifact_id = ?1 AND task_id = ?2 AND origin = 'user_edit'
           AND publish_state IN ('pending_confirm', 'pending_publish', 'expired')
           AND sealed_blob IS NOT NULL
         ORDER BY created_at DESC, version_id"
    ))?;
    let rows = stmt.query_map(params![artifact_id, task_id], |r| {
        Ok((draft_from_row(r)?, r.get::<_, Vec<u8>>(14)?))
    })?;
    let mut drafts = Vec::new();
    for item in rows {
        let (row, sealed) = item.map_err(RecordError::from)?;
        if let Some(body) = open_draft_body(dek, ctx, row, sealed) {
            drafts.push(body.row);
        }
    }
    Ok(drafts)
}

#[derive(Clone, Debug)]
pub struct LocalDraftConfirmation {
    pub row: LocalDraftRow,
    pub proof: serde_json::Value,
    pub signature: String,
}

fn stored_confirmation(
    conn: &Connection,
    request_id: &str,
    sealed_hash: &str,
) -> Result<Option<LocalDraftConfirmation>, RecordError> {
    let mut stmt = conn.prepare(
        "SELECT version_id, request_id, artifact_id, task_id, base_version_no,
                base_hash, format, sealed_hash, byte_count, publish_state, created_at,
                auth_epoch, base_version_id, base_byte_count, output_identity, proof_bytes
         FROM local_content
         WHERE request_id = ?1 AND origin = 'user_edit'
           AND publish_state IN ('pending_publish', 'published')",
    )?;
    let mut rows = stmt.query_map([request_id], |r| {
        Ok((
            draft_from_row(r)?,
            r.get::<_, Option<String>>(14)?,
            r.get::<_, Option<Vec<u8>>>(15)?,
        ))
    })?;
    let Some(item) = rows.next() else {
        return Ok(None);
    };
    let (row, proof_json, signature) = item.map_err(RecordError::from)?;
    if row.content_hash != sealed_hash {
        return Ok(None);
    }
    let (Some(proof_json), Some(signature)) = (proof_json, signature) else {
        return Err(RecordError::InvalidLocalDraft);
    };
    let proof = serde_json::from_str(&proof_json).map_err(|_| RecordError::InvalidLocalDraft)?;
    let signature = String::from_utf8(signature).map_err(|_| RecordError::InvalidLocalDraft)?;
    Ok(Some(LocalDraftConfirmation {
        row,
        proof,
        signature,
    }))
}

/// Produce and persist the closed 21-key proof inside the sole-owner transaction. A retry returns
/// the original proof/signature, so a crash after signing but before the HTTP response cannot burn
/// the nonce with an unrecoverable local state.
#[allow(clippy::too_many_arguments)]
pub fn confirm_draft(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    key: &dyn crate::key::DeviceKey,
    request_id: &str,
    sealed_hash: &str,
    device_id: &str,
    session_id: &str,
) -> Result<Option<LocalDraftConfirmation>, RecordError> {
    if !valid_uuid(request_id)
        || !valid_digest(sealed_hash)
        || !valid_uuid(device_id)
        || !valid_uuid(session_id)
    {
        return Err(RecordError::InvalidLocalDraft);
    }
    if let Some(confirmed) = stored_confirmation(conn, request_id, sealed_hash)? {
        return Ok(Some(confirmed));
    }
    let version_id: String = conn
        .query_row(
            "SELECT version_id FROM local_content WHERE request_id = ?1 AND origin = 'user_edit'",
            [request_id],
            |row| row.get(0),
        )
        .map_err(|_| RecordError::InvalidLocalDraft)?;
    let Some(body) = read_draft(conn, dek, ctx, &version_id)? else {
        return Ok(None);
    };
    if body.row.content_hash != sealed_hash {
        return Ok(None);
    }
    let expires_at = std::time::SystemTime::now()
        .checked_add(std::time::Duration::from_secs(60))
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|value| crate::frame::rfc3339::format_utc_seconds(value.as_secs()))
        .ok_or(RecordError::InvalidLocalDraft)?;
    let raw_hash = |value: &str| {
        value
            .strip_prefix("sha256:")
            .unwrap_or(value)
            .to_ascii_lowercase()
    };
    let proof = serde_json::json!({
        "v": 1,
        "org_id": ctx.org,
        "subject_id": ctx.subject,
        "auth_plane": "bearer",
        "auth_epoch": body.row.auth_epoch,
        "device_id": device_id,
        "session_id": session_id,
        "task_id": body.row.task_id,
        "artifact_id": body.row.artifact_id,
        "base_version_no": body.row.base_version_no,
        "base_hash": raw_hash(&body.row.base_hash),
        "version_id": body.row.version_id,
        "format": match body.row.format.as_str() {
            "md" => "text/markdown",
            _ => "text/plain",
        },
        "content_hash": raw_hash(&body.row.content_hash),
        "bytes": body.row.byte_count,
        "classification": "local_only",
        "clipboard_derived": false,
        "clipboard_source_version_ids": [],
        "client_request_id": body.row.request_id,
        "nonce": uuid::Uuid::new_v4().simple().to_string(),
        "expires_at": expires_at,
    });
    let signature = crate::userversion::sign(key, &proof)?;
    let proof_json = serde_json::to_string(&proof).map_err(|_| RecordError::InvalidLocalDraft)?;
    conn.execute(
        "UPDATE local_content
         SET publish_state = 'pending_publish', output_identity = ?1, proof_bytes = ?2
         WHERE request_id = ?3 AND publish_state = 'pending_confirm' AND sealed_hash = ?4",
        params![proof_json, signature.as_bytes(), request_id, sealed_hash],
    )?;
    let mut row = body.row;
    row.publish_state = "pending_publish".into();
    Ok(Some(LocalDraftConfirmation {
        row,
        proof,
        signature,
    }))
}

pub fn mark_draft_published(
    conn: &Connection,
    ctx: &RecordContext,
    request_id: &str,
    sealed_hash: &str,
    publish_ack: &str,
) -> Result<bool, RecordError> {
    if !valid_uuid(request_id)
        || !valid_digest(sealed_hash)
        || publish_ack.len() != 71
        || !publish_ack.starts_with("sha256:")
        || !publish_ack[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(RecordError::InvalidLocalDraft);
    }
    let Some(confirmed) = stored_confirmation(conn, request_id, sealed_hash)? else {
        return Ok(false);
    };
    if confirmed.proof["org_id"] != ctx.org || confirmed.proof["subject_id"] != ctx.subject {
        return Err(RecordError::InvalidLocalDraft);
    }
    if confirmed.row.publish_state == "published" {
        return Ok(true);
    }
    let changed = conn.execute(
        "UPDATE local_content SET publish_state = 'published', copy_state = 'pending', publish_ack = ?1
         WHERE request_id = ?2 AND sealed_hash = ?3 AND publish_state = 'pending_publish'",
        params![publish_ack, request_id, sealed_hash],
    )?;
    Ok(changed == 1)
}

pub fn read_published_draft_copy(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    request_id: &str,
    sealed_hash: &str,
) -> Result<Option<LocalDraftCopy>, RecordError> {
    if !valid_uuid(request_id) || !valid_digest(sealed_hash) {
        return Err(RecordError::InvalidLocalDraft);
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT {}, sealed_blob, grant_ref FROM local_content
         WHERE request_id = ?1 AND origin = 'user_edit' AND publish_state = 'published'
           AND sealed_hash = ?2 AND sealed_blob IS NOT NULL",
        DRAFT_COLUMNS
    ))?;
    let mut rows = stmt.query_map(params![request_id, sealed_hash], |r| {
        Ok((
            draft_from_row(r)?,
            r.get::<_, Vec<u8>>(14)?,
            r.get::<_, Option<String>>(15)?,
        ))
    })?;
    let Some(item) = rows.next() else {
        return Ok(None);
    };
    let (row, sealed, grant_ref) = item.map_err(RecordError::from)?;
    let Some(body) = open_draft_body(dek, ctx, row, sealed) else {
        return Ok(None);
    };
    Ok(Some(LocalDraftCopy { body, grant_ref }))
}

pub fn set_draft_copy_state(
    conn: &Connection,
    request_id: &str,
    sealed_hash: &str,
    state: &str,
) -> Result<bool, RecordError> {
    if !valid_uuid(request_id)
        || !valid_digest(sealed_hash)
        || !matches!(state, "written" | "pending")
    {
        return Err(RecordError::InvalidLocalDraft);
    }
    let changed = conn.execute(
        "UPDATE local_content SET copy_state = ?1
         WHERE request_id = ?2 AND origin = 'user_edit' AND publish_state = 'published'
           AND sealed_hash = ?3",
        params![state, request_id, sealed_hash],
    )?;
    Ok(changed == 1)
}

/// Apply discard/cancel while the draft is pending. Cancel preserves the draft; confirm is
/// reserved for the proof-producing transaction and never mutates state on its own.
pub fn decide_draft(
    conn: &Connection,
    dek: &[u8; 32],
    ctx: &RecordContext,
    request_id: &str,
    sealed_hash: &str,
    action: &str,
) -> Result<Option<LocalDraftRow>, RecordError> {
    if !matches!(action, "discard" | "cancel") || !valid_digest(sealed_hash) {
        return Err(RecordError::InvalidLocalDraft);
    }
    let owned: Option<String> = conn
        .query_row(
            "SELECT version_id FROM local_content WHERE request_id = ?1 AND origin = 'user_edit'",
            [request_id],
            |row| row.get(0),
        )
        .ok();
    let version_id = owned.ok_or(RecordError::InvalidLocalDraft)?;
    if read_draft_for_display(conn, dek, ctx, &version_id)?.is_none() {
        return Ok(None);
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT {DRAFT_COLUMNS} FROM local_content
         WHERE request_id = ?1 AND origin = 'user_edit'"
    ))?;
    let row = match stmt.query_row([request_id], draft_from_row) {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if row.content_hash != sealed_hash
        || !matches!(row.publish_state.as_str(), "pending_confirm" | "expired")
    {
        return Ok(None);
    }
    if action == "discard" {
        conn.execute(
            "UPDATE local_content SET publish_state = 'discarded'
             WHERE request_id = ?1 AND publish_state IN ('pending_confirm', 'expired')
               AND sealed_hash = ?2",
            params![request_id, sealed_hash],
        )?;
        let mut row = row;
        row.publish_state = "discarded".into();
        return Ok(Some(row));
    }
    Ok(Some(row))
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

pub fn read_grant_ref(conn: &Connection, version_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT grant_ref FROM local_content WHERE version_id = ?1",
        [version_id],
        |row| row.get(0),
    )
    .optional()
}

/// Every persisted deliverable row (the resume rebuild source). Rows without a
/// `run_id` are not Broker deliverables and are skipped.
pub fn load_all(conn: &Connection) -> rusqlite::Result<Vec<DeliverableRow>> {
    let mut stmt = conn.prepare(
        "SELECT run_id, operation_id, version_id, COALESCE(logical_name, ''),
                COALESCE(format, ''), COALESCE(sealed_hash, ''),
                COALESCE(byte_count, 0), receipt_seq, COALESCE(publish_state, 'sealed')
         FROM local_content WHERE run_id IS NOT NULL AND origin = 'device_write'",
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
    use crate::key::DeviceKey;

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

    fn context() -> RecordContext<'static> {
        RecordContext {
            org: "org",
            subject: "subject",
            device: "device",
            journal_epoch: "epoch",
            schema_version: schema::SCHEMA_VERSION,
        }
    }

    #[test]
    fn approval_body_is_encrypted_idempotent_and_not_a_deliverable() {
        let c = conn();
        let dek = [7; 32];
        let approval_id = "11111111-1111-4111-8111-111111111111";
        let bytes = b"{\"approval_id\":\"11111111-1111-4111-8111-111111111111\"}";
        let mut approval = row(approval_id, "22222222-2222-4222-8222-222222222222");
        approval.format = "json".into();
        approval.content_hash = crate::sha256_hex(bytes);
        approval.byte_count = bytes.len() as u64;
        record_approval(&c, &dek, &context(), approval_id, &approval, bytes).unwrap();
        let loaded = read_approval(&c, &dek, &context(), approval_id)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.bytes, bytes);
        let sealed: Vec<u8> = c
            .query_row(
                "SELECT sealed_blob FROM local_content WHERE approval_id = ?1",
                [approval_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!sealed.windows(bytes.len()).any(|part| part == bytes));
        assert!(
            read_approval(&c, &dek, &context(), "33333333-3333-4333-8333-333333333333")
                .unwrap()
                .is_none()
        );
        assert!(load_all(&c).unwrap().is_empty());

        let mut replay = approval;
        replay.content_hash = crate::sha256_hex(b"different");
        replay.byte_count = b"different".len() as u64;
        record_approval(&c, &dek, &context(), approval_id, &replay, b"different").unwrap();
        assert_eq!(
            read_approval(&c, &dek, &context(), approval_id)
                .unwrap()
                .unwrap()
                .bytes,
            bytes
        );
    }

    #[test]
    fn transcript_body_is_encrypted_and_not_a_deliverable() {
        let c = conn();
        let dek = [7; 32];
        let bytes = b"{\"messages\":[{\"role\":\"user\",\"content\":\"local\"}]}";
        let mut transcript = row("run-local", "op-local");
        transcript.run_id = "run-local".into();
        transcript.format = "json".into();
        transcript.content_hash = crate::sha256_hex(bytes);
        transcript.byte_count = bytes.len() as u64;
        record_transcript(&c, &dek, &context(), "run-local", &transcript, bytes).unwrap();
        let loaded = read_transcript(&c, &dek, &context(), "run-local")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.bytes, bytes);
        let sealed: Vec<u8> = c
            .query_row(
                "SELECT sealed_blob FROM local_content WHERE run_id = 'run-local'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!sealed.windows(bytes.len()).any(|part| part == bytes));
        assert!(load_all(&c).unwrap().is_empty());
        let mut other = context();
        other.subject = "other";
        assert!(read_transcript(&c, &dek, &other, "run-local")
            .unwrap()
            .is_none());
    }

    #[test]
    fn sealed_body_round_trips_and_mismatch_is_unavailable() {
        let c = conn();
        let dek = [7; 32];
        let bytes = b"# hello";
        let mut row = row("v-sealed", "op-sealed");
        row.content_hash = crate::sha256_hex(bytes);
        row.byte_count = bytes.len() as u64;
        record_sealed(&c, &dek, &context(), &row, bytes).unwrap();
        let loaded = read_sealed(&c, &dek, &context(), "v-sealed")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.bytes, bytes);
        assert_eq!(loaded.row.version_id, "v-sealed");
        assert!(read_sealed(&c, &[8; 32], &context(), "v-sealed")
            .unwrap()
            .is_none());
        let mut wrong = row;
        wrong.content_hash = "a".repeat(64);
        assert!(record_sealed(&c, &dek, &context(), &wrong, bytes).is_err());
    }

    #[test]
    fn sealed_body_survives_journal_reopen() {
        let dir = std::env::temp_dir().join(format!("work-local-content-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("journal.db");
        let dek = [9; 32];
        let bytes = b"persisted viewer body";
        let mut row = row("v-restart", "op-restart");
        row.content_hash = crate::sha256_hex(bytes);
        row.byte_count = bytes.len() as u64;
        {
            let c = Connection::open(&path).unwrap();
            schema::apply(&c).unwrap();
            record_sealed(&c, &dek, &context(), &row, bytes).unwrap();
        }
        let c = Connection::open(&path).unwrap();
        let loaded = read_sealed(&c, &dek, &context(), "v-restart")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.bytes, bytes);
        drop(c);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn seed_base(c: &Connection, dek: &[u8; 32]) {
        let bytes = b"base";
        let mut base = row("99999999-9999-4999-8999-999999999999", "op-base");
        base.content_hash = crate::sha256_hex(bytes);
        base.byte_count = bytes.len() as u64;
        record_sealed(c, dek, &context(), &base, bytes).unwrap();
        c.execute(
            "UPDATE local_content SET grant_ref = ?1 WHERE version_id = ?2",
            params![
                r#"{"grant_id":"g1","root_identity_hash":"sha256:root"}"#,
                base.version_id
            ],
        )
        .unwrap();
    }

    fn draft(version: &str, request: &str) -> LocalDraftRow {
        let base_hash = crate::sha256_hex(b"base");
        LocalDraftRow {
            version_id: version.into(),
            request_id: request.into(),
            artifact_id: "11111111-1111-1111-1111-111111111111".into(),
            task_id: "22222222-2222-2222-2222-222222222222".into(),
            base_version_no: 4,
            base_hash,
            format: "md".into(),
            content_hash: "b".repeat(64),
            byte_count: 0,
            publish_state: "pending_confirm".into(),
            created_at: 0,
            auth_epoch: 4,
            base_version_id: "99999999-9999-4999-8999-999999999999".into(),
            base_byte_count: 4,
        }
    }

    #[test]
    fn draft_seals_replays_and_enforces_single_flight() {
        let c = conn();
        let dek = [11; 32];
        seed_base(&c, &dek);
        let bytes = b"local edit body";
        let mut row = draft(
            "33333333-3333-3333-3333-333333333333",
            "44444444-4444-4444-4444-444444444444",
        );
        row.content_hash = crate::sha256_hex(bytes);
        row.byte_count = bytes.len() as u64;
        let mut missing_base = row.clone();
        missing_base.base_version_id = "00000000-0000-4000-8000-000000000000".into();
        assert!(matches!(
            prepare_draft(&c, &dek, &context(), &missing_base, bytes),
            Err(RecordError::InvalidLocalDraft)
        ));
        let mut wrong_base_hash = row.clone();
        wrong_base_hash.base_hash = "c".repeat(64);
        assert!(matches!(
            prepare_draft(&c, &dek, &context(), &wrong_base_hash, bytes),
            Err(RecordError::InvalidLocalDraft)
        ));
        let first = prepare_draft(&c, &dek, &context(), &row, bytes).unwrap();
        assert_eq!(first.row.publish_state, "pending_confirm");
        assert_eq!(first.row.base_byte_count, 4);
        assert_eq!(first.bytes, bytes);
        let inherited_grant: String = c
            .query_row(
                "SELECT grant_ref FROM local_content WHERE version_id = ?1",
                [&row.version_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            inherited_grant,
            r#"{"grant_id":"g1","root_identity_hash":"sha256:root"}"#
        );
        let listed = list_drafts(&c, &dek, &context(), &row.artifact_id, &row.task_id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].version_id, row.version_id);
        assert_eq!(listed[0].publish_state, "pending_confirm");
        let wrong_identity = RecordContext {
            subject: "other",
            ..context()
        };
        assert!(
            list_drafts(&c, &dek, &wrong_identity, &row.artifact_id, &row.task_id)
                .unwrap()
                .is_empty()
        );
        let sealed: Vec<u8> = c
            .query_row(
                "SELECT sealed_blob FROM local_content WHERE version_id = ?1",
                [&row.version_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!sealed.windows(bytes.len()).any(|part| part == bytes));
        let replay = prepare_draft(&c, &dek, &context(), &row, bytes).unwrap();
        assert_eq!(replay.row.created_at, first.row.created_at);
        assert_eq!(replay.bytes, bytes);
        let mut different = row.clone();
        different.content_hash = "c".repeat(64);
        assert!(matches!(
            prepare_draft(&c, &dek, &context(), &different, bytes),
            Err(RecordError::InvalidLocalDraft)
        ));
        let mut second = draft(
            "55555555-5555-5555-5555-555555555555",
            "66666666-6666-6666-6666-666666666666",
        );
        second.content_hash = crate::sha256_hex(bytes);
        second.byte_count = bytes.len() as u64;
        assert!(prepare_draft(&c, &dek, &context(), &second, bytes).is_err());
        let wrong_identity = RecordContext {
            subject: "other",
            ..context()
        };
        assert!(read_draft(&c, &dek, &wrong_identity, &row.version_id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn draft_cancel_discard_and_expiry_are_terminal_for_reads() {
        let c = conn();
        let dek = [12; 32];
        seed_base(&c, &dek);
        let bytes = b"draft state";
        let mut row = draft(
            "77777777-7777-7777-7777-777777777777",
            "88888888-8888-8888-8888-888888888888",
        );
        row.content_hash = crate::sha256_hex(bytes);
        row.byte_count = bytes.len() as u64;
        prepare_draft(&c, &dek, &context(), &row, bytes).unwrap();
        let cancelled = decide_draft(
            &c,
            &dek,
            &context(),
            &row.request_id,
            &row.content_hash,
            "cancel",
        )
        .unwrap()
        .unwrap();
        assert_eq!(cancelled.publish_state, "pending_confirm");
        assert!(read_draft(&c, &dek, &context(), &row.version_id)
            .unwrap()
            .is_some());
        let discarded = decide_draft(
            &c,
            &dek,
            &context(),
            &row.request_id,
            &row.content_hash,
            "discard",
        )
        .unwrap()
        .unwrap();
        assert_eq!(discarded.publish_state, "discarded");
        assert!(read_draft(&c, &dek, &context(), &row.version_id)
            .unwrap()
            .is_none());
        assert!(decide_draft(
            &c,
            &dek,
            &context(),
            &row.request_id,
            &row.content_hash,
            "discard"
        )
        .unwrap()
        .is_none());

        let mut expired = draft(
            "99999999-9999-9999-9999-999999999999",
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        );
        expired.content_hash = crate::sha256_hex(bytes);
        expired.byte_count = bytes.len() as u64;
        prepare_draft(&c, &dek, &context(), &expired, bytes).unwrap();
        c.execute(
            "UPDATE local_content SET created_at = 1 WHERE version_id = ?1",
            [&expired.version_id],
        )
        .unwrap();
        assert!(read_draft(&c, &dek, &context(), &expired.version_id)
            .unwrap()
            .is_none());
        let retained = read_draft_for_display(&c, &dek, &context(), &expired.version_id)
            .unwrap()
            .unwrap();
        assert_eq!(retained.row.publish_state, "expired");
        assert_eq!(retained.bytes, bytes);
        let state: String = c
            .query_row(
                "SELECT publish_state FROM local_content WHERE version_id = ?1",
                [&expired.version_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "expired");
        let discarded = decide_draft(
            &c,
            &dek,
            &context(),
            &expired.request_id,
            &expired.content_hash,
            "discard",
        )
        .unwrap()
        .unwrap();
        assert_eq!(discarded.publish_state, "discarded");
        assert!(
            read_draft_for_display(&c, &dek, &context(), &expired.version_id)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn draft_confirmation_signs_closed_proof_and_replays_until_published() {
        let c = conn();
        let dek = [13; 32];
        let key = crate::key::SoftwareKey::from_bytes(&[7; 32]).unwrap();
        seed_base(&c, &dek);
        let bytes = b"signed edit";
        let mut row = draft(
            "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            "cccccccc-cccc-cccc-cccc-cccccccccccc",
        );
        row.content_hash = crate::sha256_hex(bytes);
        row.byte_count = bytes.len() as u64;
        prepare_draft(&c, &dek, &context(), &row, bytes).unwrap();
        let device = "dddddddd-dddd-dddd-dddd-dddddddddddd";
        let session = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
        let first = confirm_draft(
            &c,
            &dek,
            &context(),
            &key,
            &row.request_id,
            &row.content_hash,
            device,
            session,
        )
        .unwrap()
        .unwrap();
        assert_eq!(first.row.publish_state, "pending_publish");
        assert_eq!(
            read_draft_for_display(&c, &dek, &context(), &row.version_id)
                .unwrap()
                .unwrap()
                .bytes,
            bytes
        );
        assert_eq!(first.proof.as_object().unwrap().len(), 21);
        assert!(first.proof.get("signature").is_none());
        assert_eq!(first.proof["task_id"], row.task_id);
        assert_eq!(first.proof["auth_epoch"], 4);
        assert!(crate::userversion::verify(
            &key.public_jwk(),
            &first.proof,
            &first.signature
        ));
        let replay = confirm_draft(
            &c,
            &dek,
            &context(),
            &key,
            &row.request_id,
            &row.content_hash,
            device,
            session,
        )
        .unwrap()
        .unwrap();
        assert_eq!(replay.signature, first.signature);
        assert_eq!(replay.proof, first.proof);
        let mut second = draft(
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        );
        second.content_hash = crate::sha256_hex(bytes);
        second.byte_count = bytes.len() as u64;
        assert!(prepare_draft(&c, &dek, &context(), &second, bytes).is_err());
        assert!(mark_draft_published(
            &c,
            &context(),
            &row.request_id,
            &row.content_hash,
            &format!("sha256:{}", "a".repeat(64)),
        )
        .unwrap());
        assert!(mark_draft_published(
            &c,
            &context(),
            &row.request_id,
            &row.content_hash,
            &format!("sha256:{}", "a".repeat(64)),
        )
        .unwrap());
        let copy =
            read_published_draft_copy(&c, &dek, &context(), &row.request_id, &row.content_hash)
                .unwrap()
                .unwrap();
        assert_eq!(copy.body.bytes, bytes);
        assert_eq!(
            copy.grant_ref.as_deref(),
            Some(r#"{"grant_id":"g1","root_identity_hash":"sha256:root"}"#)
        );
        assert!(set_draft_copy_state(&c, &row.request_id, &row.content_hash, "written").unwrap());
        let copy_state: String = c
            .query_row(
                "SELECT copy_state FROM local_content WHERE request_id = ?1",
                [&row.request_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(copy_state, "written");
        prepare_draft(&c, &dek, &context(), &second, bytes).unwrap();
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
