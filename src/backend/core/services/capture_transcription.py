"""Explicit ASR attempts, immutable audio inputs, single workers and atomic publication."""

import math
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from core import models
from core.services import ai_usage
from core.services.capture_audio import serialize_chunk, serialize_manifest
from core.services.meeting_captures import CaptureDenied, authorize, digest
from core.services.meeting_records import RecordConflict

ACTIVE = {"queued", "running"}
MAX_FINALS = 20000
MAX_TEXT_BYTES = 4000000
LEASE_SECONDS = 45


def available():
    """Agent credentials stay in the worker; this switch authorizes new paid jobs."""
    return bool(
        settings.MEETING_RECORDS_ENABLED
        and settings.MEETING_CAPTURE_PROTOCOL_ENABLED
        and settings.MEETING_CAPTURE_ASR_ENABLED
    )


def current_originals(record):
    """A retry never mixes its partial output with the previously published attempt."""
    return record.original_segments.filter(
        Q(transcription_job__isnull=True)
        | Q(transcription_job_id=F("capture_session__active_transcription_id"))
    )


def owned(capture, user):
    """Use current record ownership and membership, including account deactivation."""
    authorize(capture.record, user, allow_disabled=True)
    if capture.created_by_id != user.pk:
        raise CaptureDenied


def _locked(job_id):
    record_id = models.CaptureTranscriptionJob.objects.values_list(
        "capture__record_id", flat=True
    ).get(pk=job_id)
    models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    return models.CaptureTranscriptionJob.objects.select_related(
        "capture__record", "requested_by"
    ).get(pk=job_id)


def _expire(job):
    if job.status not in ACTIVE:
        return job
    now = timezone.now()
    try:
        if not job.requested_by_id or not available():
            raise CaptureDenied
        owned(job.capture, job.requested_by)
    except CaptureDenied:
        job.status, job.error_code = "canceled", "permission_or_rollout_changed"
    else:
        if job.deadline > now and (
            job.status == "queued" or (job.lease_until and job.lease_until > now)
        ):
            return job
        job.status, job.error_code = "incomplete", "execution_expired"
    job.save(update_fields=["status", "error_code", "updated_at"])
    return job


def serialize(job):
    """Public progress contains neither worker credentials nor unpublished text."""
    return {
        "id": str(job.pk),
        "generation": job.generation,
        "status": job.status,
        "created_at": job.created_at.isoformat(),
        "error_code": job.error_code,
        "input_count": len(job.inputs["chunks"]),
        "acknowledged_inputs": job.acknowledged_inputs,
        "final_count": job.final_sequence,
        "audio_status": job.inputs["manifest"]["outcome"],
        "coverage_status": "unverified",
    }


@transaction.atomic
def prepare(capture_id, user, key, payload):
    """Persist an explicit generation before any dispatch or provider connection."""
    models.User.objects.select_for_update().get(pk=user.pk)
    capture = models.CaptureSession.objects.select_related("record").get(pk=capture_id)
    models.MeetingRecord.objects.select_for_update().get(pk=capture.record_id)
    capture.refresh_from_db()
    owned(capture, user)
    request_hash = digest({"capture_id": str(capture.pk), **payload})
    previous = models.CaptureTranscriptionJob.objects.filter(
        requested_by=user, key=key
    ).first()
    if previous:
        if previous.request_hash != request_hash or previous.capture_id != capture.pk:
            raise RecordConflict("Transcription intent changed.")
        return _expire(previous), False
    if not available():
        raise CaptureDenied
    manifest = getattr(capture, "audio_manifest", None)
    if capture.status != "stopped" or not manifest:
        raise RecordConflict("Finish and seal audio before requesting transcription.")
    if manifest.outcome == "incomplete" and not payload["allow_incomplete"]:
        raise RecordConflict(
            "Explicitly accept incomplete audio before transcribing it."
        )
    latest = capture.transcription_jobs.order_by("-generation").first()
    if latest:
        _expire(latest)
    if payload["expected_job_id"] != (str(latest.pk) if latest else None) or (
        latest and latest.status in ACTIVE
    ):
        raise RecordConflict("Transcription generation changed or is still running.")
    for pending in models.CaptureTranscriptionJob.objects.filter(
        requested_by=user, status__in=ACTIVE
    ):
        if _expire(_locked(pending.pk)).status in ACTIVE:
            raise RecordConflict(
                "Only one active transcription per requester is allowed."
            )
    chunks = [
        serialize_chunk(chunk)
        for chunk in capture.audio_chunks.filter(stored=True).order_by("sequence")
    ]
    if not chunks:
        raise RecordConflict("No saved audio is available.")
    # Each disconnected audio run needs a separate provider task; bound this explicitly.
    runs = 1 + sum(
        b["sequence"] != a["sequence"] + 1
        or b["start_ms"] != a["start_ms"] + a["duration_ms"]
        for a, b in zip(chunks, chunks[1:], strict=False)
    )
    if runs > 50:
        raise RecordConflict("Audio has too many disconnected runs for one attempt.")
    job = models.CaptureTranscriptionJob.objects.create(
        capture=capture,
        requested_by=user,
        key=key,
        request_hash=request_hash,
        generation=latest.generation + 1 if latest else 1,
        inputs={
            "manifest": serialize_manifest(manifest),
            "chunks": chunks,
            "runs": runs,
        },
        configuration={
            "model": settings.QWEN_ASR_MODEL,
            "region": settings.QWEN_ASR_REGION,
        },
        deadline=timezone.now() + timedelta(minutes=5),
    )
    return job, True


@transaction.atomic
def state(capture_id, user):
    """Owner recovery expires stale attempts even when no worker is deployed."""
    capture = models.CaptureSession.objects.select_related("record").get(pk=capture_id)
    models.MeetingRecord.objects.select_for_update().get(pk=capture.record_id)
    capture.refresh_from_db()
    owned(capture, user)
    jobs = [
        _expire(job) for job in capture.transcription_jobs.order_by("-generation")[:10]
    ]
    return {
        "available": available(),
        "active_job_id": str(capture.active_transcription_id)
        if capture.active_transcription_id
        else None,
        "results": [serialize(job) for job in jobs],
    }


@transaction.atomic
def cancel(job_id, user):
    """Cancel once; cancellation never promotes partial transcripts."""
    job = _locked(job_id)
    owned(job.capture, user)
    if job.status == "canceled":
        return job
    if job.status not in ACTIVE:
        raise RecordConflict("Transcription is already terminal.")
    job.status, job.error_code = "canceled", "requester_canceled"
    job.save(update_fields=["status", "error_code", "updated_at"])
    return job


def worker_state(job, *, include_inputs=True):
    """No input object keys; workers download through the scoped internal endpoint."""
    return {
        **serialize(job),
        "capture_id": str(job.capture_id),
        "record_id": str(job.capture.record_id),
        "configuration": job.configuration,
        **({"inputs": job.inputs} if include_inputs else {}),
        "started": job.started_at is not None,
    }


@transaction.atomic
def claim(worker_id, model, region):
    """A worker identity is unique to one process; expired jobs are never reclaimed."""
    existing = models.CaptureTranscriptionJob.objects.filter(
        worker_id=worker_id, status="running"
    ).first()
    if existing:
        job = _expire(_locked(existing.pk))
        return worker_state(job) if job.status == "running" else None
    if not available():
        return None
    for identity in models.CaptureTranscriptionJob.objects.filter(
        status="queued", configuration__model=model, configuration__region=region
    ).order_by("created_at", "id")[:20]:
        job = _expire(_locked(identity.pk))
        if job.status != "queued":
            continue
        duration = sum(chunk["duration_ms"] for chunk in job.inputs["chunks"])
        job.status, job.worker_id = "running", worker_id
        job.lease_until = timezone.now() + timedelta(seconds=LEASE_SECONDS)
        job.deadline = timezone.now() + timedelta(seconds=duration / 500 + 300)
        job.save(
            update_fields=[
                "status",
                "worker_id",
                "lease_until",
                "deadline",
                "updated_at",
            ]
        )
        return worker_state(job)
    return None


def _require(job, worker_id, *, begun=True):
    _expire(job)
    if (
        job.status != "running"
        or job.worker_id != worker_id
        or (begun and not job.started_at)
    ):
        raise RecordConflict("Worker execution is no longer authorized.")


@transaction.atomic
def control(job_id, worker_id, operation, payload):
    """Begin is a one-shot billable gate. Lost begin responses must not trigger replay."""
    job = _locked(job_id)
    _require(job, worker_id, begun=operation != "begin")
    if operation == "begin":
        if job.started_at:
            raise RecordConflict("Provider execution has already begun.")
        job.started_at = timezone.now()
    elif operation == "ack_input":
        index = payload["index"]
        if (
            not 1 <= index <= len(job.inputs["chunks"])
            or job.inputs["chunks"][index - 1]["checksum"] != payload["checksum"]
        ):
            raise RecordConflict("Audio input receipt changed.")
        if index > job.acknowledged_inputs + 1:
            raise RecordConflict("Audio input acknowledgement is not contiguous.")
        job.acknowledged_inputs = max(job.acknowledged_inputs, index)
    elif operation != "heartbeat":
        raise RecordConflict("Unknown transcription control.")
    job.lease_until = timezone.now() + timedelta(seconds=LEASE_SECONDS)
    job.save(
        update_fields=["started_at", "acknowledged_inputs", "lease_until", "updated_at"]
    )
    return worker_state(job, include_inputs=False)


@transaction.atomic
def input_chunk(job_id, worker_id, index):
    """Authorize each input identity before storage and again after download."""
    job = _locked(job_id)
    _require(job, worker_id, begun=False)
    if not 1 <= index <= len(job.inputs["chunks"]):
        raise RecordConflict("Input index is outside the sealed manifest.")
    source = job.inputs["chunks"][index - 1]
    chunk = models.CaptureAudioChunk.objects.get(
        pk=source["id"], capture_id=job.capture_id, stored=True
    )
    if serialize_chunk(chunk) != source:
        raise RecordConflict("Input audio identity changed.")
    return chunk


def _source_interval(job, start, end):
    """A result may span adjacent chunks, but never invent time across missing audio."""
    runs = []
    previous = None
    for chunk in job.inputs["chunks"]:
        if (
            previous
            and previous["sequence"] + 1 == chunk["sequence"]
            and runs[-1][1] == chunk["start_ms"]
        ):
            runs[-1][1] += chunk["duration_ms"]
        else:
            runs.append([chunk["start_ms"], chunk["start_ms"] + chunk["duration_ms"]])
        previous = chunk
    return any(a <= start < b and (end is None or start <= end <= b) for a, b in runs)


@transaction.atomic
def ingest(job_id, worker_id, payload):
    """Store provider-final originals privately until this complete generation publishes."""
    job = _locked(job_id)
    _require(job, worker_id)
    fingerprint = digest({**payload, "ingest_id": str(payload["ingest_id"])})
    previous = models.MeetingOriginalSegment.objects.filter(
        ingest_id=payload["ingest_id"]
    ).first()
    if previous:
        if (
            previous.transcription_job_id != job.pk
            or previous.payload_hash != fingerprint
            or any(
                getattr(previous, field) != payload[field]
                for field in ("text", "start_ms", "end_ms", "language")
            )
            or previous.source_sequence != payload["sequence"]
        ):
            raise RecordConflict("Final identity has different source or text.")
        return previous, False
    if (
        payload["sequence"] != job.final_sequence + 1
        or payload["sequence"] > MAX_FINALS
        or not _source_interval(job, payload["start_ms"], payload["end_ms"])
    ):
        raise RecordConflict("Final sequence or audio time is invalid.")
    size = len(payload["text"].encode("utf-8"))
    if job.text_bytes + size > MAX_TEXT_BYTES or not payload["text"].strip():
        raise RecordConflict("Final text is empty or beyond the source budget.")
    track = f"asr:{job.pk}"
    speaker, _ = models.MeetingSpeaker.objects.get_or_create(
        record_id=job.capture.record_id,
        capture_session_id=job.capture_id,
        source_track_id=track,
        source_key="unknown",
        defaults={"label": "Unknown speaker", "identity_type": "unknown"},
    )
    segment = models.MeetingOriginalSegment.objects.create(
        record_id=job.capture.record_id,
        capture_session_id=job.capture_id,
        transcription_job=job,
        speaker=speaker,
        source_track_id=track,
        source_sequence=payload["sequence"],
        ingest_id=payload["ingest_id"],
        start_ms=payload["start_ms"],
        end_ms=payload["end_ms"],
        text=payload["text"],
        language=payload["language"],
        payload_hash=fingerprint,
    )
    job.final_sequence, job.text_bytes = payload["sequence"], job.text_bytes + size
    job.save(update_fields=["final_sequence", "text_bytes", "updated_at"])
    return segment, True


@transaction.atomic
def finish(job_id, worker_id, payload):
    """Publish only after provider finish and all declared input/final receipts match."""
    job = _expire(_locked(job_id))
    if job.worker_id != worker_id:
        raise RecordConflict("Worker identity changed.")
    fingerprint = digest(payload)
    if job.finish_hash:
        if job.finish_hash != fingerprint:
            raise RecordConflict("Finish receipt changed.")
        return job
    if job.status == "queued":
        raise RecordConflict("Job was never claimed.")
    observations = payload["tasks"]
    success = bool(
        job.status == "running"
        and job.started_at
        and payload["provider_finished"]
        and len(observations) == job.inputs["runs"]
        and all(item["finished"] for item in observations)
        and sum(item["input_samples"] for item in observations)
        == sum(chunk["duration_ms"] * 16 for chunk in job.inputs["chunks"])
        and job.acknowledged_inputs == len(job.inputs["chunks"])
        and payload["final_sequence"] == job.final_sequence
    )
    if job.status == "running":
        job.status = "succeeded" if success else "incomplete"
        job.error_code = "" if success else "provider_or_delivery_incomplete"
    job.finish_hash, job.report = fingerprint, payload
    job.save(
        update_fields=["status", "error_code", "finish_hash", "report", "updated_at"]
    )
    if success:
        capture = job.capture
        capture.active_transcription = job
        capture.save(update_fields=["active_transcription", "updated_at"])
        record = capture.record
        record.revision += 1
        record.save(update_fields=["revision", "updated_at"])
        record.processing_jobs.filter(status__in=["queued", "running"]).update(
            status="canceled",
            retryable=False,
            error_code="source_changed",
            updated_at=timezone.now(),
        )
    billed = [
        item["billed_seconds"]
        for item in observations
        if item["billed_seconds"] is not None
    ]
    if billed:
        ai_usage.record_usage(
            user=job.requested_by,
            organization=job.capture.record.organization,
            kind=models.AIUsageKindChoices.OTHER,
            model_code=job.configuration["model"],
            ref_type="capture_transcription",
            ref_id=str(job.pk),
            audio_seconds=math.ceil(sum(billed)),
            infer_organization=False,
        )
    return job


def tick_transcriptions(limit=100):
    """Background expiry never queues or replays a billable provider attempt."""
    ids = list(
        models.CaptureTranscriptionJob.objects.filter(status__in=ACTIVE)
        .order_by("updated_at", "id")
        .values_list("pk", flat=True)[:limit]
    )
    for job_id in ids:
        with transaction.atomic():
            _expire(_locked(job_id))
    return len(ids)
