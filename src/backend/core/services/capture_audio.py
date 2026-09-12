"""Private verified audio chunks and sealed, gap-aware upload manifests."""

import hashlib
import io
import wave

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction
from django.db.models import F

from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from storages.backends.s3 import S3Storage

from core import models
from core.services.meeting_captures import CaptureDenied, authorize, check_lease
from core.services.meeting_records import RecordConflict

MAX_BYTES = 320044
MAX_CHUNKS = 4320


def audio_storage():
    """Isolate small private uploads from global S3 retry and public ACL settings."""
    if not isinstance(default_storage, S3Storage):
        return default_storage
    options = dict(settings.STORAGES["default"].get("OPTIONS", {}))
    options.update(
        client_config=default_storage.client_config.merge(
            Config(
                connect_timeout=3, read_timeout=10, retries={"total_max_attempts": 1}
            )
        ),
        transfer_config=TransferConfig(use_threads=False, num_download_attempts=1),
        default_acl="private",
        object_parameters={**default_storage.object_parameters, "ACL": "private"},
        gzip=False,
    )
    return default_storage.__class__(**options)


def validate_wave(data):
    """At most 10 seconds of uncompressed mono 16 kHz PCM16, no client MIME trust."""
    if not isinstance(data, bytes) or len(data) > MAX_BYTES:
        raise ValueError("Audio chunk exceeds the byte limit.")
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            if (
                audio.getnchannels(),
                audio.getsampwidth(),
                audio.getframerate(),
                audio.getcomptype(),
            ) != (1, 2, 16000, "NONE"):
                raise ValueError("Unsupported PCM audio format.")
            frames = audio.getnframes()
            pcm = audio.readframes(frames)
            if frames < 16 or frames > 160000 or frames % 16 or len(pcm) != frames * 2:
                raise ValueError("Invalid or incomplete audio frames.")
            return frames // 16
    except (wave.Error, EOFError) as exc:
        raise ValueError("Invalid WAV file.") from exc


def locked_capture(capture_id, user, lease, device, *, finishing=False):
    """Use the same lock order and current ownership/lease gates as capture commands."""
    models.User.objects.select_for_update().get(pk=user.pk)
    capture = models.CaptureSession.objects.get(pk=capture_id)
    record = models.MeetingRecord.objects.select_for_update().get(pk=capture.record_id)
    capture.refresh_from_db()
    authorize(record, user, allow_disabled=finishing)
    check_lease(capture, lease, device)
    if (
        not settings.MEETING_CAPTURE_AUDIO_ENABLED and not finishing
    ) or record.retention_mode != "media":
        raise CaptureDenied
    return capture


def serialize_chunk(chunk):
    """No raw bucket keys or public media URLs leave the protected endpoint."""
    return {
        "id": str(chunk.pk),
        "sequence": chunk.sequence,
        "start_ms": chunk.start_ms,
        "duration_ms": chunk.duration_ms,
        "checksum": chunk.checksum,
        "byte_size": chunk.byte_size,
        "stored": chunk.stored,
    }


def serialize_manifest(manifest):
    """Report declared delivery separately from unverified acoustic coverage."""
    return {
        "final_sequence": manifest.final_sequence,
        "client_interrupted": manifest.client_interrupted,
        "outcome": manifest.outcome,
        "duration_ms": manifest.duration_ms,
        "missing_sequences": manifest.missing_sequences,
        "gaps": manifest.gaps,
        "coverage_status": "unverified",
    }


@transaction.atomic
def prepare(capture_id, user, lease, payload, audio):
    """Commit a deterministic private object identity before external storage I/O."""
    duration = validate_wave(audio)
    if (
        not 1 <= payload["sequence"] <= MAX_CHUNKS
        or not 0 <= payload["start_ms"] <= 43200000
    ):
        raise ValueError("Audio timeline exceeds the limit.")
    checksum = hashlib.sha256(audio).hexdigest()
    if checksum != payload["checksum"]:
        raise ValueError("Audio checksum mismatch.")
    capture = locked_capture(capture_id, user, lease, payload["device_id"])
    existing = capture.audio_chunks.filter(sequence=payload["sequence"]).first()
    if existing:
        if (
            existing.checksum,
            existing.start_ms,
            existing.duration_ms,
            existing.byte_size,
        ) != (checksum, payload["start_ms"], duration, len(audio)):
            raise RecordConflict("Audio sequence has different content or timing.")
        return existing
    if capture.status not in {
        "recording",
        "paused",
        "interrupted",
        "stopping",
    } or hasattr(capture, "audio_manifest"):
        raise RecordConflict("Audio capture is sealed or not recording.")
    # Keep retry/reorder windows bounded and make overlaps an explicit conflict.
    previous = capture.audio_chunks.order_by("-sequence").first()
    if payload["sequence"] > (previous.sequence if previous else 0) + 20:
        raise RecordConflict("Audio sequence is beyond the recovery window.")
    if (
        capture.audio_chunks.annotate(chunk_end=F("start_ms") + F("duration_ms"))
        .filter(
            start_ms__lt=payload["start_ms"] + duration,
            chunk_end__gt=payload["start_ms"],
        )
        .exists()
    ):
        raise RecordConflict("Audio timeline overlaps another chunk.")
    before = (
        capture.audio_chunks.filter(sequence__lt=payload["sequence"])
        .order_by("-sequence")
        .first()
    )
    after = (
        capture.audio_chunks.filter(sequence__gt=payload["sequence"])
        .order_by("sequence")
        .first()
    )
    if (before and before.start_ms + before.duration_ms > payload["start_ms"]) or (
        after and payload["start_ms"] + duration > after.start_ms
    ):
        raise RecordConflict("Audio sequence and timeline disagree.")
    chunk = models.CaptureAudioChunk(
        capture=capture,
        sequence=payload["sequence"],
        start_ms=payload["start_ms"],
        duration_ms=duration,
        checksum=checksum,
        byte_size=len(audio),
    )
    chunk.object_key = f"capture-audio/{capture.record_id}/{capture.pk}/{chunk.pk}.wav"
    chunk.save()
    return chunk


def read_verified(chunk, storage=None):
    """Treat missing/corrupt storage as unavailable, never as a successful receipt."""
    storage = storage or audio_storage()
    with storage.open(chunk.object_key, "rb") as stream:
        audio = stream.read(MAX_BYTES + 1)
    if (
        len(audio) != chunk.byte_size
        or hashlib.sha256(audio).hexdigest() != chunk.checksum
    ):
        raise OSError("Stored audio failed verification.")
    return audio


@transaction.atomic
def store(chunk_id, user, lease, device, audio):
    """Serialize storage recovery with finalize; a failed response can reuse the object."""
    identity = models.CaptureAudioChunk.objects.get(pk=chunk_id)
    capture = locked_capture(identity.capture_id, user, lease, device)
    chunk = models.CaptureAudioChunk.objects.get(pk=chunk_id)
    if hashlib.sha256(audio).hexdigest() != chunk.checksum:
        raise RecordConflict("Upload body changed.")
    if not chunk.stored and hasattr(capture, "audio_manifest"):
        raise RecordConflict("Sealed capture cannot accept a late chunk.")
    storage = audio_storage()
    if not storage.exists(chunk.object_key):
        if chunk.stored:
            raise RecordConflict("Previously acknowledged audio is missing.")
        saved = storage.save(chunk.object_key, ContentFile(audio))
        if saved != chunk.object_key:
            raise RecordConflict("Storage changed the immutable audio key.")
    read_verified(chunk, storage)
    authorize(capture.record, user)
    chunk.stored = True
    chunk.save(update_fields=["stored", "updated_at"])
    return chunk


@transaction.atomic
def seal(capture_id, user, lease, payload):
    """Finalize declared storage delivery independently of ASR or the capture state."""
    capture = locked_capture(
        capture_id, user, lease, payload["device_id"], finishing=True
    )
    existing = getattr(capture, "audio_manifest", None)
    if existing:
        if (existing.final_sequence, existing.client_interrupted) != (
            payload["final_sequence"],
            payload.get("client_interrupted", False),
        ):
            raise RecordConflict("Audio manifest has a different final sequence.")
        return existing
    if capture.status != "stopping":
        raise RecordConflict("Stop recording before sealing its audio.")
    chunks = list(capture.audio_chunks.order_by("sequence"))
    final = payload["final_sequence"]
    if any(chunk.sequence > final for chunk in chunks):
        raise RecordConflict("Final sequence precedes known audio.")
    stored = {chunk.sequence for chunk in chunks if chunk.stored}
    missing = [value for value in range(1, final + 1) if value not in stored]
    gaps = []
    end = 0
    for chunk in chunks:
        if chunk.start_ms > end:
            gaps.append({"start_ms": end, "end_ms": chunk.start_ms})
        end = chunk.start_ms + chunk.duration_ms
    return models.CaptureAudioManifest.objects.create(
        capture=capture,
        final_sequence=final,
        client_interrupted=payload.get("client_interrupted", False),
        outcome="incomplete"
        if missing or payload.get("client_interrupted", False)
        else ("saved" if final else "empty"),
        duration_ms=sum(chunk.duration_ms for chunk in chunks if chunk.stored),
        missing_sequences=missing,
        gaps=gaps,
    )
