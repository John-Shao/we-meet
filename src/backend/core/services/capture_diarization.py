"""Independent capture attribution generations with atomic, traceable publication."""

from datetime import timedelta
from uuid import UUID, uuid4

from django.conf import settings
from django.db import transaction
from django.db.models import Count, Func, IntegerField, Max, Prefetch, Sum, TextField
from django.db.models.functions import Cast
from django.utils import timezone

from core import models
from core.services import capture_diarization_alignment as alignment
from core.services import capture_live_inputs, capture_retention, qwen_filetrans
from core.services.capture_audio import (
    ensure_audio_not_cleaning,
    serialize_chunk,
    serialize_manifest,
)
from core.services.capture_diarization_projection import (
    row_receipt,
    validate_publication,
)
from core.services.capture_transcription import owned
from core.services.effective_transcripts import current_generation
from core.services.meeting_captures import CaptureDenied, digest
from core.services.meeting_records import (
    RecordConflict,
    bump_record_source,
    visible_records,
)
from core.services.transcript_corrections import corrected_text_subquery

LEASE_SECONDS = 300
MAX_TEXT_BYTES = 4000000
MAX_ALIGNMENT_BYTES = 32 * 1024 * 1024


def available():
    return bool(
        settings.MEETING_RECORDS_ENABLED
        and settings.MEETING_CAPTURE_PROTOCOL_ENABLED
        and settings.MEETING_CAPTURE_AUDIO_ENABLED
        and settings.MEETING_CAPTURE_DIARIZATION_ENABLED
    )


def _capture(identifier):
    record_id = models.CaptureSession.objects.values_list("record_id", flat=True).get(
        pk=identifier
    )
    record = models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    # A competing publication may have changed the pointers while we waited.
    capture = models.CaptureSession.objects.get(pk=identifier)
    capture.record = record
    return capture


def _check_budget(rows):
    """Reject oversized persisted sources before loading text and JSON into Python."""

    def size(value):
        return Func(value, function="OCTET_LENGTH", output_field=IntegerField())

    totals = rows.aggregate(
        count=Count("pk"),
        text_bytes=Sum(size("text")),
        corrected_bytes=Sum(size(corrected_text_subquery())),
        alignment_bytes=Sum(size(Cast("word_alignment", output_field=TextField()))),
    )
    if (
        totals["count"] > alignment.MAX_ROWS
        or (totals["text_bytes"] or 0) > MAX_TEXT_BYTES
        or (totals["corrected_bytes"] or 0) > MAX_TEXT_BYTES
        or (totals["alignment_bytes"] or 0) > MAX_ALIGNMENT_BYTES
    ):
        raise RecordConflict("Diarization source exceeds its budget.")


def _correction(row):
    latest = row.current_corrections[0] if row.current_corrections else None
    return latest or (row.inherited_correction if row.inherited_correction_id else None)


def _parent(row):
    correction = _correction(row)
    return {
        "id": str(row.pk),
        "payload_hash": row.payload_hash,
        "text_hash": digest(row.text),
        "start_ms": row.start_ms,
        "end_ms": row.end_ms,
        "speaker": str(row.speaker_id),
        "sequence": row.source_sequence,
        "track": row.source_track_id,
        "language": row.language,
        "alignment": row.word_alignment,
        "alignment_revision": row.alignment_revision,
        "alignment_status": row.alignment_status,
        "correction": str(correction.pk) if correction else None,
        "correction_hash": digest(correction.text) if correction else None,
    }


def _snapshot(capture, actor):
    if actor is None:
        raise CaptureDenied
    owned(capture, actor)
    if (
        not visible_records(actor, ability="read_transcript")
        .filter(pk=capture.record_id, can_manage_record=True, collaboration_media=True)
        .exists()
    ):
        raise CaptureDenied
    ensure_audio_not_cleaning(capture)
    job = capture.active_transcription
    manifest = getattr(capture, "audio_manifest", None)
    if (
        not available()
        or capture.record.source_type != models.MeetingRecord.Source.AUDIO
        or capture.status != "stopped"
        or capture.ended_at is None
        or job is None
        or job.status != "succeeded"
        or manifest is None
        or not 0 < manifest.duration_ms <= alignment.MAX_DURATION_MS
        or capture.transcription_jobs.filter(status__in=["queued", "running"]).exists()
        or job.capture_id != capture.pk
        or capture.record.retention_mode not in {"media", "text"}
    ):
        raise CaptureDenied
    expected = capture_live_inputs.inputs(job)
    base_rows = job.originals.filter(diarization_job__isnull=True)
    _check_budget(base_rows)
    base = list(base_rows.order_by("source_sequence")[: alignment.MAX_ROWS + 1])
    if len(base) != job.final_sequence or not 1 <= len(base) <= alignment.MAX_ROWS:
        raise RecordConflict("Capture ASR originals are incomplete.")
    for index, row in enumerate(base, 1):
        payload = {
            "ingest_id": str(row.ingest_id),
            "sequence": index,
            "text": row.text,
            "start_ms": row.start_ms,
            "end_ms": row.end_ms,
            "language": row.language,
        }
        if (
            row.source_sequence != index
            or row.source_track_id != f"asr:{job.pk}"
            or row.payload_hash != digest(payload)
        ):
            raise RecordConflict("Capture ASR original content changed.")
    chunks = list(capture.audio_chunks.order_by("sequence")[:4321])
    if (
        not 1 <= len(chunks) <= 4320
        or any(not row.stored or row.audio_deleted_at is not None for row in chunks)
        or [serialize_chunk(row) for row in chunks] != expected.get("chunks")
        or serialize_manifest(manifest) != expected.get("manifest")
    ):
        raise RecordConflict("Capture audio source changed.")
    parent_rows = current_generation(job.originals.all())
    _check_budget(parent_rows)
    parents = list(
        parent_rows.select_related("inherited_correction", "parent_original")
        .prefetch_related(
            Prefetch(
                "revisions",
                queryset=models.MeetingOriginalRevision.objects.order_by("-revision")[
                    :1
                ],
                to_attr="current_corrections",
            )
        )
        .order_by("source_sequence", "id")[: alignment.MAX_ROWS + 1]
    )
    if not 1 <= len(parents) <= alignment.MAX_ROWS:
        raise RecordConflict("Capture originals are unavailable.")
    current = capture.active_diarization
    current = (
        current
        if current
        and current.source_transcription_id == job.pk
        and current.status == "succeeded"
        else None
    )
    if current:
        validate_publication(current, parents)
    elif len(parents) != job.final_sequence:
        raise RecordConflict("Capture originals are incomplete.")
    if any(
        row.source_sequence != index
        or row.transcription_job_id != job.pk
        or row.capture_session_id != capture.pk
        or row.record_id != capture.record_id
        for index, row in enumerate(parents, 1)
    ):
        raise RecordConflict("Capture original identity changed.")
    proof = {
        "record": str(capture.record_id),
        "owner": str(capture.record.owner_id),
        "revision": capture.record.revision,
        "lifecycle_revision": capture.record.lifecycle_revision,
        "retention": capture.record.retention_mode,
        "origin": capture.record.origin_at.isoformat(),
        "capture": str(capture.pk),
        "capture_revision": capture.revision,
        "started": capture.started_at.isoformat(),
        "ended": capture.ended_at.isoformat(),
        "asr": str(job.pk),
        "asr_generation": job.generation,
        "asr_configuration": job.configuration,
        "asr_finish": job.finish_hash,
        "derivation": str(current.pk) if current else None,
        "chunks": [serialize_chunk(row) for row in chunks],
        "objects": [{"id": str(row.pk), "key": row.object_key} for row in chunks],
        "manifest": serialize_manifest(manifest),
        "parents": [_parent(row) for row in parents],
    }
    return proof, parents, job, current


@transaction.atomic
def prepare(capture_id, actor, key, *, expected_revision):
    """Only an explicit new command can create another processing generation."""
    if (
        not isinstance(key, UUID)
        or type(expected_revision) is not int
        or expected_revision < 1
    ):
        raise ValueError("capture_diarization_request_invalid")
    actor = models.User.objects.select_for_update().get(pk=actor.pk)
    capture = _capture(capture_id)
    owned(capture, actor)
    request_hash = digest(
        {"capture": str(capture.pk), "revision": expected_revision, "protocol": 1}
    )
    previous = models.CaptureDiarizationJob.objects.filter(
        requested_by=actor, key=key
    ).first()
    if previous:
        if previous.capture_id != capture.pk or previous.request_hash != request_hash:
            raise RecordConflict("Diarization command changed.")
        return previous, False
    if capture.record.revision != expected_revision:
        raise RecordConflict("Refresh before requesting diarization.")
    for pending in capture.diarization_jobs.filter(status__in=["queued", "running"]):
        _expire(pending, capture)
    if capture.diarization_jobs.filter(status__in=["queued", "running"]).exists():
        raise RecordConflict("Another diarization is active.")
    proof, _, source, prior = _snapshot(capture, actor)
    _, expiry = capture_retention.deadlines(capture)
    deadline = (
        min(timezone.now() + timedelta(hours=24), expiry)
        if expiry
        else timezone.now() + timedelta(hours=24)
    )
    generation = (
        capture.diarization_jobs.aggregate(value=Max("generation"))["value"] or 0
    ) + 1
    region = settings.QWEN_FILE_ASR_REGION
    if (
        region not in {"cn-beijing", "ap-southeast-1"}
        or settings.QWEN_FILE_ASR_MODEL != qwen_filetrans.MODEL
    ):
        raise RecordConflict("Diarization provider is unavailable.")
    job = models.CaptureDiarizationJob.objects.create(
        capture=capture,
        requested_by=actor,
        key=key,
        request_hash=request_hash,
        generation=generation,
        source_transcription=source,
        source_derivation=prior,
        source_revision=expected_revision,
        source_fingerprint=digest(proof),
        inputs=proof,
        configuration={
            "protocol": 1,
            "model": qwen_filetrans.MODEL,
            "region": region,
            "diarization": True,
        },
        deadline=deadline,
    )
    return job, True


def _expire(job, capture):
    if job.status in {"queued", "running"} and (
        job.deadline <= timezone.now() or capture_retention.expired(capture)
    ):
        job.status, job.error_code = "failed", "capture_diarization_expired"
        job.lease_until = None
        job.save(update_fields=["status", "error_code", "lease_until", "updated_at"])


def _job(identifier):
    identifier_capture, requester_id = models.CaptureDiarizationJob.objects.values_list(
        "capture_id", "requested_by_id"
    ).get(pk=identifier)
    # Match user-command lock order and serialize account deactivation.
    if requester_id:
        models.User.objects.select_for_update().filter(pk=requester_id).first()
    capture = _capture(identifier_capture)
    job = (
        models.CaptureDiarizationJob.objects.select_for_update(of=("self",))
        .select_related("requested_by")
        .get(pk=identifier)
    )
    job.capture = capture
    return job, capture


def _fresh(job, capture):
    proof, parents, _, _ = _snapshot(capture, job.requested_by)
    if (
        proof != job.inputs
        or digest(proof) != job.source_fingerprint
        or capture.record.revision != job.source_revision
    ):
        raise RecordConflict("Diarization source changed.")
    return parents


@transaction.atomic
def claim(identifier, worker_id):
    if not isinstance(worker_id, UUID):
        raise ValueError("capture_diarization_worker_invalid")
    job, capture = _job(identifier)
    _expire(job, capture)
    if (
        job.status not in {"queued", "running"}
        or job.lease_until
        and job.lease_until > timezone.now()
    ):
        return None
    try:
        _fresh(job, capture)
    except (CaptureDenied, RecordConflict):
        job.status, job.error_code = "failed", "capture_diarization_source_changed"
        job.save(update_fields=["status", "error_code", "updated_at"])
        return None
    job.status, job.worker_id = "running", worker_id
    job.lease_until = min(
        job.deadline, timezone.now() + timedelta(seconds=LEASE_SECONDS)
    )
    job.save(update_fields=["status", "worker_id", "lease_until", "updated_at"])
    return job


@transaction.atomic
def publish(identifier, worker_id, turns):
    """A replay never changes pointers, originals, manual decisions or record revision."""
    job, capture = _job(identifier)
    if job.requested_by is None:
        raise CaptureDenied
    owned(capture, job.requested_by)
    manifest = job.inputs["manifest"]
    timeline = alignment.Timeline(
        turns,
        manifest["duration_ms"],
        source_ranges=[
            (row["start_ms"], row["start_ms"] + row["duration_ms"])
            for row in job.inputs["chunks"]
        ],
    )
    result_hash = digest(
        [{key: row[key] for key in ("start_ms", "end_ms", "speaker")} for row in turns]
    )
    if job.result_hash:
        if job.result_hash != result_hash or job.status != "succeeded":
            raise RecordConflict("Diarization receipt changed.")
        validate_publication(job)
        return job
    if not (
        job.status == "running"
        and job.worker_id == worker_id
        and job.lease_until
        and job.lease_until > timezone.now()
        and job.deadline > timezone.now()
    ):
        raise RecordConflict("Diarization lease changed.")
    parents = _fresh(job, capture)
    track, sequence, text_bytes, hashes, speakers = (
        f"diarization:{job.pk}",
        0,
        0,
        [],
        {},
    )
    pending = []
    for parent in parents:
        correction = _correction(parent)
        derived = alignment.align(
            parent.text,
            parent.start_ms,
            parent.end_ms,
            timeline,
            alignment=parent.word_alignment
            if parent.alignment_status == "available"
            else None,
            corrected=correction is not None and correction.text != parent.text,
        )
        for span in derived:
            sequence += 1
            text_bytes += len(span.text.encode("utf-8"))
            if sequence > alignment.MAX_ROWS or text_bytes > MAX_TEXT_BYTES:
                raise RecordConflict("Diarization publication exceeds its budget.")
            key = span.speaker if span.speaker is not None else "unknown"
            if key not in speakers:
                speakers[key] = models.MeetingSpeaker.objects.create(
                    record=capture.record,
                    capture_session=capture,
                    source_track_id=track,
                    source_key=key,
                    label=f"Speaker {int(key) + 1}"
                    if key != "unknown"
                    else "Unknown speaker",
                    identity_type="diarized" if key != "unknown" else "unknown",
                )
            row = models.MeetingOriginalSegment(
                record=capture.record,
                capture_session=capture,
                transcription_job=capture.active_transcription,
                diarization_job=job,
                parent_original=parent,
                inherited_correction=correction
                if len(derived) == 1 and span.text == parent.text
                else None,
                speaker=speakers[key],
                ingest_id=uuid4(),
                source_track_id=track,
                source_sequence=sequence,
                start_ms=span.start_ms,
                end_ms=span.end_ms,
                text=span.text,
                language=parent.language,
                word_alignment=span.alignment,
                alignment_status="available" if span.alignment else "missing",
                alignment_revision=1 if span.alignment else 0,
                derivation={
                    "protocol": 1,
                    "start_offset": span.start_offset,
                    "end_offset": span.end_offset,
                    "offset_unit": "utf16",
                    "status": "known" if key != "unknown" else "ambiguous",
                    "reason": span.reason,
                },
            )
            row.payload_hash = row_receipt(row)
            row.clean()
            pending.append(row)
            hashes.append(row.payload_hash)
    # Lineage is validated above; database constraints still apply. Avoid
    # per-row validation queries for a bounded 20,000-original publication.
    models.MeetingOriginalSegment.objects.bulk_create(pending, batch_size=1000)
    job.status, job.result_hash, job.publication_hash, job.published_count = (
        "succeeded",
        result_hash,
        digest(hashes),
        sequence,
    )
    job.save(
        update_fields=[
            "status",
            "result_hash",
            "publication_hash",
            "published_count",
            "updated_at",
        ]
    )
    capture.active_diarization = job
    capture.save(update_fields=["active_diarization", "updated_at"])
    bump_record_source(capture.record)
    # Replacing original IDs is not append-only, including for quick/live drafts.
    capture.record.processing_jobs.filter(
        input_revision__lt=capture.record.revision, status__in=["queued", "running"]
    ).update(
        status="canceled",
        error_code="source_changed",
        retryable=False,
        updated_at=timezone.now(),
    )
    return job
