"""Owner/lease-fenced capture control and source-bound final-text ingestion."""

import hashlib
import json
import secrets

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.utils import timezone

from core import models
from core.services.meeting_records import RecordConflict, visible_records

GRANT_SALT = "meeting-capture-writer-v1"
GRANT_MAX_AGE = 300


class CaptureDenied(PermissionError):
    """Current ownership, membership or device lease does not authorize writing."""


def captures_enabled():
    """Both switches are required even for trusted internal writes."""
    return (
        settings.MEETING_RECORDS_ENABLED and settings.MEETING_CAPTURE_PROTOCOL_ENABLED
    )


def digest(value):
    """Canonical receipts exclude raw credentials."""
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()


def original_fingerprint(data):
    """Normalize UUIDs identically on wire input and persisted-row verification."""
    return digest(
        {
            name: str(value) if name.endswith("_id") else value
            for name, value in data.items()
        }
    )


def stored_original_fingerprint(segment):
    """An out-of-band source edit must not be acknowledged as an exact replay."""
    return original_fingerprint(
        {
            **{
                name: getattr(segment, name)
                for name in (
                    "record_id",
                    "ingest_id",
                    "source_track_id",
                    "source_sequence",
                    "start_ms",
                    "end_ms",
                    "text",
                    "language",
                )
            },
            "capture_id": segment.capture_session_id,
            "speaker_key": segment.speaker.source_key,
            "speaker_label": segment.speaker.label,
            "identity_type": segment.speaker.identity_type,
            "final": True,
        }
    )


def authorize(record, user, *, allow_disabled=False):
    """Re-read account and membership for each control or ingestion operation."""
    fresh = models.User.objects.get(pk=user.pk)
    if (
        (not captures_enabled() and not allow_disabled)
        or record.source_type != models.MeetingRecord.Source.AUDIO
        or record.owner_id != fresh.pk
        or not visible_records(fresh, ability="read_transcript")
        .filter(pk=record.pk)
        .exists()
    ):
        raise CaptureDenied


def check_lease(capture, lease_key, device_id):
    """Knowing a device label is insufficient to control its capture."""
    if (
        capture.device_id != device_id
        or not capture.lease_hash
        or not secrets.compare_digest(capture.lease_hash, digest(str(lease_key)))
    ):
        raise CaptureDenied


def capture_state(capture):
    """Control state is deliberately separate from verified media delivery."""
    manifest = getattr(capture, "audio_manifest", None)
    sequences = list(
        capture.audio_chunks.filter(stored=True)
        .order_by("sequence")
        .values_list("sequence", flat=True)
    )
    contiguous = 0
    for sequence in sequences:
        if sequence != contiguous + 1:
            break
        contiguous = sequence
    return {
        "id": str(capture.pk),
        "record_id": str(capture.record_id),
        "device_id": capture.device_id,
        "status": capture.status,
        "revision": capture.revision,
        "started_at": capture.started_at.isoformat(),
        "ended_at": capture.ended_at.isoformat() if capture.ended_at else None,
        "media_status": manifest.outcome
        if manifest
        else ("uploading" if capture.audio_chunks.exists() else "not_connected"),
        "captured_duration_ms": manifest.duration_ms if manifest else None,
        "last_acked_sequence": contiguous,
        "missing_ranges": manifest.gaps if manifest else None,
        "missing_sequences": manifest.missing_sequences if manifest else None,
        "coverage_status": "unverified",
    }


def _receipt(user, key, capture, payload):
    return models.CaptureOperation.objects.create(
        user=user,
        key=key,
        capture=capture,
        payload=payload,
        result=capture_state(capture),
    )


def _replay(user, key, payload):
    previous = models.CaptureOperation.objects.filter(user=user, key=key).first()
    if previous and previous.payload != payload:
        raise RecordConflict("Idempotency key was used for another capture operation.")
    return previous


@transaction.atomic
def create_capture(user, key, data):
    """Create a private note and preparing session atomically, without any Room."""
    # Serialize both global user keys and per-device uniqueness, including races
    # between two different records. All public control writes take this lock first.
    user = models.User.objects.select_for_update().get(pk=user.pk)
    if not captures_enabled() or not user.is_active:
        raise CaptureDenied
    payload = {
        "operation": "create",
        **data,
        "lease_key": digest(str(data["lease_key"])),
    }
    previous = _replay(user, key, payload)
    if previous:
        authorize(previous.capture.record, user)
        return previous, True
    if (
        models.CaptureSession.objects.filter(
            created_by=user, device_id=data["device_id"]
        )
        .exclude(status="stopped")
        .exists()
    ):
        raise RecordConflict("This device already has an active capture.")
    # Same primary-membership selection as the current directory, but no request
    # cache and no client-supplied tenant. Inactive organizations fail closed.
    membership = (
        user.memberships.filter(status=models.MembershipStatusChoices.ACTIVE)
        .order_by("-is_primary", "created_at")
        .first()
    )
    organization = membership.organization if membership else None
    if organization and not organization.is_active:
        raise CaptureDenied
    now = timezone.now()
    record = models.MeetingRecord.objects.create(
        source_type="audio_recording",
        owner=user,
        organization=organization,
        title=data["title"],
        retention_mode=data["retention_mode"],
        origin_at=now,
    )
    capture = models.CaptureSession.objects.create(
        record=record,
        created_by=user,
        device_id=data["device_id"],
        started_at=now,
        lease_hash=payload["lease_key"],
    )
    return _receipt(user, key, capture, payload), False


@transaction.atomic
def command_capture(capture_id, user, key, lease_key, data):
    """CAS state changes; replay never repeats a transition or rotates a lease."""
    user = models.User.objects.select_for_update().get(pk=user.pk)
    capture = models.CaptureSession.objects.get(pk=capture_id)
    record = models.MeetingRecord.objects.select_for_update().get(pk=capture.record_id)
    capture.refresh_from_db()
    authorize(
        record,
        user,
        allow_disabled=data["command"] in {"stop", "finalize", "interrupt"},
    )
    check_lease(capture, lease_key, data["device_id"])
    payload = {
        "capture_id": str(capture.pk),
        "lease_hash": digest(str(lease_key)),
        **data,
    }
    previous = _replay(user, key, payload)
    if previous:
        return previous, True
    if data["expected_revision"] != capture.revision:
        raise RecordConflict("Capture revision changed.")
    transitions = {
        "start": {"preparing": "recording"},
        "pause": {"recording": "paused"},
        "resume": {"paused": "recording", "interrupted": "recording"},
        "interrupt": {
            "preparing": "interrupted",
            "recording": "interrupted",
            "paused": "interrupted",
        },
        "stop": dict.fromkeys(
            ("preparing", "recording", "paused", "interrupted"), "stopping"
        ),
        "finalize": {"stopping": "stopped"},
    }
    target = transitions.get(data["command"], {}).get(capture.status)
    if target is None:
        raise RecordConflict("Invalid capture transition.")
    if (
        target == "stopped"
        and capture.audio_chunks.exists()
        and not hasattr(capture, "audio_manifest")
    ):
        raise RecordConflict(
            "Seal the declared audio chunks before finalizing capture."
        )
    capture.status = target
    capture.revision += 1
    if target == "stopped":
        capture.ended_at = timezone.now()
    capture.save(update_fields=["status", "revision", "ended_at", "updated_at"])
    return _receipt(user, key, capture, payload), False


def _locked_source(capture_id):
    capture = models.CaptureSession.objects.get(pk=capture_id)
    record = models.MeetingRecord.objects.select_for_update().get(pk=capture.record_id)
    capture.refresh_from_db()
    authorize(record, capture.created_by)
    if capture.status not in {"recording", "paused", "stopping"}:
        raise RecordConflict("Capture is not accepting final text.")
    return capture, record


@transaction.atomic
def issue_writer_grant(data):
    """Trusted gateway must prove the device lease before obtaining source scope."""
    capture, record = _locked_source(data["capture_id"])
    check_lease(capture, data["lease_key"], data["device_id"])
    if capture.revision != data["expected_revision"]:
        raise RecordConflict("Capture revision changed.")
    return signing.dumps(
        {
            "capture_id": str(capture.pk),
            "record_id": str(record.pk),
            "owner_id": str(record.owner_id),
            "revision": capture.revision,
            "source_track_id": data["source_track_id"],
        },
        salt=GRANT_SALT,
    )


@transaction.atomic
def ingest_original(grant, data):
    """Accept only a scoped writer, preserving original identities across retries."""
    if data.get("final") is not True or not data["text"].strip():
        raise RecordConflict("Only non-empty final text can become an original.")
    try:
        scope = signing.loads(grant, salt=GRANT_SALT, max_age=GRANT_MAX_AGE)
    except signing.BadSignature as exc:
        raise CaptureDenied from exc
    capture, record = _locked_source(scope["capture_id"])
    if (
        scope["record_id"] != str(record.pk)
        or scope["owner_id"] != str(record.owner_id)
        or scope["revision"] != capture.revision
        or data["source_track_id"] != scope["source_track_id"]
        or str(data["capture_id"]) != str(capture.pk)
        or str(data["record_id"]) != str(record.pk)
    ):
        raise RecordConflict("Writer scope or capture revision changed.")
    fingerprint = original_fingerprint(data)
    existing = models.MeetingOriginalSegment.objects.filter(
        ingest_id=data["ingest_id"]
    ).first()
    if existing:
        if (
            existing.payload_hash != fingerprint
            or stored_original_fingerprint(existing) != fingerprint
            or existing.record_id != record.pk
        ):
            raise RecordConflict("Original identity was reused with different content.")
        return existing, False
    if capture.original_segments.filter(
        source_track_id=data["source_track_id"], source_sequence=data["source_sequence"]
    ).exists():
        raise RecordConflict("Source sequence already has a different ingest identity.")
    speaker, _ = models.MeetingSpeaker.objects.get_or_create(
        record=record,
        capture_session=capture,
        source_track_id=data["source_track_id"],
        source_key=data["speaker_key"],
        defaults={
            "label": data["speaker_label"],
            "identity_type": data["identity_type"],
        },
    )
    if (
        speaker.label != data["speaker_label"]
        or speaker.identity_type != data["identity_type"]
    ):
        raise RecordConflict("Speaker identity cannot be silently reassigned.")
    segment = models.MeetingOriginalSegment.objects.create(
        record=record,
        capture_session=capture,
        speaker=speaker,
        payload_hash=fingerprint,
        **{
            name: data[name]
            for name in (
                "ingest_id",
                "source_track_id",
                "source_sequence",
                "start_ms",
                "end_ms",
                "text",
                "language",
            )
        },
    )
    record.revision += 1
    record.save(update_fields=["revision", "updated_at"])
    record.processing_jobs.filter(status__in=["queued", "running"]).update(
        status="canceled",
        retryable=False,
        error_code="source_changed",
        updated_at=timezone.now(),
    )
    return segment, True
