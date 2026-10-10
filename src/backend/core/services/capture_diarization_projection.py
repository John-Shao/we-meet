"""Shared immutable derivative receipts for writers and newly frozen readers."""

from core.services.capture_diarization_alignment import MAX_ROWS
from core.services.meeting_captures import digest
from core.services.meeting_records import RecordConflict


def row_receipt(row):
    return digest(
        {
            "id": str(row.pk),
            "ingest_id": str(row.ingest_id),
            "record": str(row.record_id),
            "capture": str(row.capture_session_id),
            "asr": str(row.transcription_job_id),
            "track": row.source_track_id,
            "job": str(row.diarization_job_id),
            "parent": str(row.parent_original_id),
            "parent_payload": row.parent_original.payload_hash,
            "sequence": row.source_sequence,
            "start_ms": row.start_ms,
            "end_ms": row.end_ms,
            "text": row.text,
            "language": row.language,
            "speaker": str(row.speaker_id),
            "derivation": row.derivation,
            "alignment": row.word_alignment,
            "alignment_revision": row.alignment_revision,
            "alignment_status": row.alignment_status,
            "inherited_correction": str(row.inherited_correction_id)
            if row.inherited_correction_id
            else None,
        }
    )


def validate_publication(job, rows=None):
    if rows is None:
        rows = list(
            job.originals.select_related("parent_original").order_by("source_sequence")[
                : MAX_ROWS + 1
            ]
        )
    hashes = []
    for index, row in enumerate(rows, 1):
        if (
            row.diarization_job_id != job.pk
            or row.source_sequence != index
            or row.payload_hash != row_receipt(row)
        ):
            raise RecordConflict("Diarization publication changed.")
        hashes.append(row.payload_hash)
    if (
        not 1 <= len(rows) == job.published_count <= MAX_ROWS
        or digest(hashes) != job.publication_hash
    ):
        raise RecordConflict("Diarization publication is incomplete.")
    return rows
