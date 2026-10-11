"""Identity queries from one published capture generation and its fixed media."""

import re

from django.db.models import Func, IntegerField, TextField
from django.db.models.functions import Cast

from core import models
from core.services import capture_diarization_objects as objects
from core.services import voiceprint_consent as consent
from core.services import voiceprint_sources as sources
from core.services.capture_diarization import check_source_budget
from core.services.capture_diarization_projection import validate_publication
from core.services.meeting_captures import digest
from core.services.meeting_records import RecordConflict
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_media_process import MediaError
from core.services.voiceprint_source_intervals import (
    MAX_ROWS,
    MAX_SPEAKERS,
    SourceInterval,
)

MAX_PROOF_BYTES = 64 * 1024 * 1024


def header(record, actor):
    captures = list(
        models.CaptureSession.objects.filter(record=record)
        .select_related(
            "active_transcription",
            "active_diarization",
        )
        .defer("active_diarization__inputs", "active_transcription__configuration")[:2]
    )
    if len(captures) != 1:
        raise VoiceprintError("voiceprint_source_unavailable")
    capture = captures[0]
    capture.record = record
    job, asr = capture.active_diarization, capture.active_transcription
    if (
        capture.status != "stopped"
        or capture.ended_at is None
        or capture.created_by_id != record.owner_id
        or record.retention_mode not in {"media", "text"}
        or not job
        or job.status != "succeeded"
        or job.phase != "completed"
        or job.capture_id != capture.pk
        or not asr
        or asr.status != "succeeded"
        or asr.capture_id != capture.pk
        or job.source_transcription_id != asr.pk
        or not job.provider_task_id
        or not job.input_id
        or job.configuration.get("diarization") is not True
        or not 1 <= job.published_count <= MAX_ROWS
    ):
        raise VoiceprintError("voiceprint_source_generation_unavailable")
    job.capture = capture
    duration = (
        models.CaptureAudioManifest.objects.filter(capture=capture)
        .values_list("duration_ms", flat=True)
        .first()
    )
    if type(duration) is not int or not 0 < duration <= 7200000:
        raise VoiceprintError("voiceprint_source_generation_unavailable")
    try:
        artifact, receipt = objects.selected(job, duration_ms=duration)
    except (MediaError, ValueError, TypeError, KeyError):
        raise VoiceprintError("voiceprint_source_integrity_unavailable") from None
    proof = {
        "record": str(record.pk),
        "revision": record.revision,
        "lifecycle": record.lifecycle_revision,
        "owner": str(record.owner_id),
        "org": str(record.organization_id),
        "actor": str(actor.pk),
        "organization_policy": consent.organization_policy(record.organization)
        if record.organization
        else None,
        "retention": record.retention_mode,
        "capture": str(capture.pk),
        "capture_revision": capture.revision,
        "started": capture.started_at.isoformat(),
        "ended": capture.ended_at.isoformat(),
        "asr": str(asr.pk),
        "asr_finish": asr.finish_hash,
        "job": str(job.pk),
        "generation": job.generation,
        "result": job.result_hash,
        "publication": job.publication_hash,
        "source": job.source_fingerprint,
        "configuration": sources.digest(job.configuration),
        "input": str(artifact.pk),
        "input_sha256": artifact.sha256,
        "input_storage": artifact.storage_digest,
        "object": receipt.payload(),
        "expires": artifact.expires_at.isoformat() if artifact.expires_at else None,
    }
    generation = sources.digest(
        {key: value for key, value in proof.items() if key != "revision"}
    )
    return record, job, receipt, artifact.expires_at, generation, sources.digest(proof)


def snapshot(evidence, actor):
    record, job, receipt, expiry, generation_header, header_digest = evidence
    # The same SQL byte budgets as publication apply before loading immutable rows.
    size = (
        models.CaptureDiarizationJob.objects.filter(pk=job.pk)
        .annotate(
            proof_size=Func(
                Cast("inputs", TextField()),
                function="OCTET_LENGTH",
                output_field=IntegerField(),
            ),
        )
        .values_list("proof_size", flat=True)
        .get()
    )
    if size > MAX_PROOF_BYTES:
        raise VoiceprintError("voiceprint_source_generation_unavailable")
    frozen = job.inputs
    asr = job.source_transcription
    if (
        digest(frozen) != job.source_fingerprint
        or frozen.get("record") != str(record.pk)
        or frozen.get("owner") != str(record.owner_id)
        or frozen.get("retention") != record.retention_mode
        or frozen.get("capture_revision") != job.capture.revision
        or frozen.get("asr_finish") != asr.finish_hash
        or frozen.get("asr_configuration") != asr.configuration
    ):
        raise VoiceprintError("voiceprint_source_generation_unavailable")
    try:
        check_source_budget(job.originals.all())
    except RecordConflict:
        raise VoiceprintError("voiceprint_source_generation_unavailable") from None
    rows = list(
        job.originals.select_related("parent_original", "speaker")
        .defer(
            "parent_original__text",
            "parent_original__word_alignment",
            "parent_original__derivation",
        )
        .order_by("source_sequence")[: MAX_ROWS + 1]
    )
    try:
        validate_publication(job, rows)
    except RecordConflict:
        raise VoiceprintError("voiceprint_source_generation_unavailable") from None
    intervals, proof = [], []
    for row in rows:
        speaker = row.speaker
        if (
            row.record_id != record.pk
            or row.capture_session_id != job.capture_id
            or row.transcription_job_id != job.source_transcription_id
            or row.source_track_id != f"diarization:{job.pk}"
            or speaker.record_id != record.pk
            or speaker.capture_session_id != job.capture_id
            or speaker.source_track_id != row.source_track_id
            or type(row.start_ms) is not int
            or type(row.end_ms) is not int
            or not 0 <= row.start_ms < row.end_ms <= job.input.duration_ms
        ):
            raise VoiceprintError("voiceprint_source_generation_unavailable")
        known = (
            row.derivation.get("status") == "known"
            and speaker.identity_type == "diarized"
            and re.fullmatch(r"(?:0|[1-9]|[1-4][0-9]|50)", speaker.source_key)
            is not None
        )
        intervals.append(
            SourceInterval(speaker.pk if known else None, row.start_ms, row.end_ms)
        )
        proof.append(
            {
                "id": str(row.pk),
                "receipt": row.payload_hash,
                "speaker": str(speaker.pk),
                "source_key": speaker.source_key,
                "identity_type": speaker.identity_type,
            }
        )
    known_ids = {row.speaker_id for row in intervals} - {None}
    if not known_ids:
        raise VoiceprintError("voiceprint_source_diarization_unavailable")
    if len(known_ids) > MAX_SPEAKERS:
        raise VoiceprintError("voiceprint_source_speakers_exceeded")
    return sources.SourceSnapshot(
        record.pk,
        actor.pk,
        record.revision,
        header_digest,
        sources.digest({"header": header_digest, "segments": proof}),
        receipt,
        tuple(intervals),
        expiry,
        sources.digest({"header": generation_header, "segments": proof}),
        storage_kind="capture",
        storage_digest=job.input.storage_digest,
        media_sha256=job.input.sha256,
    )
