"""Fresh editorial/media authority and immutable published upload source snapshots."""

import hashlib
import json
import re
from dataclasses import dataclass, field

from django.conf import settings
from django.utils import timezone

from core import models
from core.services import capture_retention
from core.services import voiceprint_consent as consent
from core.services.meeting_records import visible_records
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_media import MAX_SOURCE_BYTES
from core.services.voiceprint_source_intervals import (
    MAX_ROWS,
    MAX_SPEAKERS,
    SourceInterval,
)
from core.services.voiceprint_source_objects import parse


def digest(value):
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("ascii")
    ).hexdigest()


@dataclass(frozen=True)
class SourceSnapshot:
    record_id: object = field(repr=False)
    actor_id: object = field(repr=False)
    record_revision: int
    header_digest: str
    fingerprint: str
    receipt: object = field(repr=False)
    intervals: tuple = field(repr=False)
    expires_at: object = field(repr=False)


def header(record_id, actor_id, expected_revision):
    if not (
        settings.MEETING_RECORDS_ENABLED
        and settings.MEETING_VOICEPRINT_ENABLED
        and settings.MEETING_VOICEPRINT_MATCHING_ENABLED
    ):
        raise VoiceprintError("voiceprint_matching_disabled")
    actor = consent.owner(models.User(pk=actor_id))
    record = (
        visible_records(actor, ability="read_transcript")
        .filter(pk=record_id, can_manage_record=True, collaboration_media=True)
        .select_related("organization")
        .first()
    )
    if record is None:
        raise VoiceprintError("voiceprint_media_access_unavailable", status=404)
    if record.source_type != "upload" or not consent.available(
        actor, record.organization
    ):
        raise VoiceprintError("voiceprint_source_unavailable")
    if type(expected_revision) is not int or expected_revision < 1:
        raise VoiceprintError("voiceprint_revision_invalid", status=400)
    if record.revision != expected_revision:
        raise VoiceprintError("voiceprint_record_changed", status=409)
    job = (
        models.UploadedRecording.objects.select_related("capture")
        .filter(record=record)
        .first()
    )
    if (
        job is None
        or job.status != "succeeded"
        or job.capture.record_id != record.pk
        or job.capture.created_by_id != record.owner_id
        or job.capture.status != "stopped"
        or job.capture.ended_at is None
        or job.capture.active_transcription_id is not None
        or not isinstance(job.configuration, dict)
        or job.configuration.get("diarization") is not True
        or models.CaptureAudioCleanup.objects.filter(capture_id=job.capture_id).exists()
    ):
        raise VoiceprintError("voiceprint_source_unavailable")
    if record.retention_mode not in {"media", "text"}:
        raise VoiceprintError("voiceprint_source_unavailable")
    # The job's capture relation alone does not load the scoped record.
    # Set it before deriving the existing text-only retention boundary.
    job.capture.record = record
    _, expiry = capture_retention.deadlines(job.capture)
    if expiry is not None and timezone.now() >= expiry:
        raise VoiceprintError("voiceprint_media_expired")
    published = job.configuration.get("_published")
    if (
        not isinstance(published, dict)
        or type(published.get("attempt")) is not int
        or published["attempt"] != job.attempt
        or type(published.get("segment_count")) is not int
        or not 1 <= published["segment_count"] <= MAX_ROWS
    ):
        raise VoiceprintError("voiceprint_source_generation_unavailable")
    try:
        receipt = parse(job.configuration.get("_identity_source"))
    except (ValueError, TypeError):
        raise VoiceprintError("voiceprint_source_integrity_unavailable") from None
    if (
        receipt.key != job.storage_name
        or receipt.size != job.size
        or receipt.size > MAX_SOURCE_BYTES
        # ASR reads a URL, so it cannot send our later conditional GET header.
        # Only a fixed version binds both ASR and identity to a direct-upload
        # object's generation. An unversioned ETag alone does not prove this.
        or receipt.kind == "s3_object"
        and receipt.version_id is None
        or receipt.kind == "content_sha256"
        and receipt.sha256 != job.checksum
    ):
        raise VoiceprintError("voiceprint_source_integrity_unavailable")
    proof = {
        "record": str(record.pk),
        "revision": record.revision,
        "lifecycle": record.lifecycle_revision,
        "owner": str(record.owner_id),
        "org": str(record.organization_id),
        "organization_policy": consent.organization_policy(record.organization)
        if record.organization
        else None,
        "actor": str(actor.pk),
        "retention": record.retention_mode,
        "capture": str(job.capture_id),
        "capture_revision": job.capture.revision,
        "started": job.capture.started_at.isoformat(),
        "ended": job.capture.ended_at.isoformat(),
        "job": str(job.pk),
        "attempt": job.attempt,
        "checksum": job.checksum,
        "configuration": digest(job.configuration),
        "object": receipt.payload(),
    }
    return record, job, receipt, expiry, digest(proof)


def snapshot(record, actor, *, expected_revision):
    record, job, receipt, expiry, header_digest = header(
        record.pk, actor.pk, expected_revision
    )
    rows = list(
        record.original_segments.order_by("source_sequence", "id").values(
            "id",
            "capture_session_id",
            "source_track_id",
            "source_sequence",
            "start_ms",
            "end_ms",
            "revision",
            "payload_hash",
            "transcription_job_id",
            "speaker_id",
            "speaker__record_id",
            "speaker__capture_session_id",
            "speaker__source_track_id",
            "speaker__source_key",
            "speaker__identity_type",
        )[: MAX_ROWS + 1]
    )
    count = job.configuration["_published"]["segment_count"]
    if len(rows) != count:
        raise VoiceprintError("voiceprint_source_generation_unavailable")
    intervals, proof = [], []
    for index, row in enumerate(rows, 1):
        if (
            row["capture_session_id"] != job.capture_id
            or row["source_track_id"] != "uploaded-file"
            or row["speaker__record_id"] != record.pk
            or row["speaker__capture_session_id"] != job.capture_id
            or row["speaker__source_track_id"] != "uploaded-file"
            or row["source_sequence"] != index
            or row["revision"] != 1
            or row["transcription_job_id"] is not None
            or type(row["start_ms"]) is not int
            or type(row["end_ms"]) is not int
            or not 0 <= row["start_ms"] < row["end_ms"] <= 7200000
            or not isinstance(row["payload_hash"], str)
            or re.fullmatch(r"[0-9a-f]{64}", row["payload_hash"]) is None
        ):
            raise VoiceprintError("voiceprint_source_generation_unavailable")
        key = row["speaker__source_key"]
        known = (
            row["speaker__identity_type"] == "diarized"
            and isinstance(key, str)
            and re.fullmatch(r"(?:0|[1-9]|[1-4][0-9]|50)", key) is not None
        )
        intervals.append(
            SourceInterval(
                row["speaker_id"] if known else None, row["start_ms"], row["end_ms"]
            )
        )
        proof.append(
            {
                key: str(value) if key.endswith("_id") or key == "id" else value
                for key, value in row.items()
            }
        )
    if not any(row.speaker_id is not None for row in intervals):
        raise VoiceprintError("voiceprint_source_diarization_unavailable")
    if len({row.speaker_id for row in intervals} - {None}) > MAX_SPEAKERS:
        raise VoiceprintError("voiceprint_source_speakers_exceeded")
    return SourceSnapshot(
        record.pk,
        actor.pk,
        record.revision,
        header_digest,
        digest({"header": header_digest, "segments": proof}),
        receipt,
        tuple(intervals),
        expiry,
    )


def authorized(source):
    """Cheap repeated headers; immutable source rows are fully checked at publish."""
    try:
        return (
            header(source.record_id, source.actor_id, source.record_revision)[-1]
            == source.header_digest
        )
    except (ValueError, PermissionError):
        return False


def revalidate(source):
    try:
        current = snapshot(
            models.MeetingRecord(pk=source.record_id),
            models.User(pk=source.actor_id),
            expected_revision=source.record_revision,
        )
        return current.fingerprint == source.fingerprint
    except (ValueError, PermissionError):
        return False
