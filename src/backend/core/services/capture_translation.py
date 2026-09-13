"""Independent recording translation reservations; no provider IO in public controls."""

from datetime import timedelta
from urllib.parse import urlsplit

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from core import models
from core.services import capture_retention
from core.services.meeting_captures import (
    CaptureDenied,
    authorize,
    captures_enabled,
    check_lease,
)
from core.services.meeting_records import RecordConflict

ACTIVE = ("starting", "translating", "stopping")
MODEL = "qwen3.5-livetranslate-flash-realtime"
LANGUAGES = ("zh", "en")
RESERVATION_LIFETIME = timedelta(seconds=30)
DRAIN_LIFETIME = timedelta(seconds=20)


def enabled():
    """Only configured secure gateways can advertise a new paid attempt."""
    try:
        url = urlsplit(settings.MEETING_CAPTURE_TRANSLATION_URL)
        secure = (
            url.scheme == "wss"
            and bool(url.hostname)
            and not (url.username or url.password or url.query or url.fragment)
        )
        _ = url.port  # Reject malformed ports before advertising availability.
    except ValueError:
        return False
    return bool(
        secure
        and captures_enabled()
        and settings.MEETING_CAPTURE_AUDIO_ENABLED
        and settings.MEETING_CAPTURE_TRANSLATION_ENABLED
        and settings.AGENT_INTERNAL_API_TOKEN
        and settings.MEETING_CAPTURE_TRANSLATION_REGION
        in ("cn-beijing", "ap-southeast-1")
    )


def owned(capture, user):
    """Current owner and original-material access are required even on replay."""
    authorize(capture.record, user, allow_disabled=True)
    if capture.created_by_id != user.pk:
        raise CaptureDenied


def source_valid(run, capture):
    """A pause/resume or lease replacement invalidates this precise source version."""
    return bool(
        capture.status == "recording"
        and capture.revision == run.source_revision
        and capture.lease_hash == run.source_lease_hash
        and capture.record.organization_id == run.organization_id_snapshot
        and capture.created_by_id == run.requested_by_id
        and not capture_retention.expired(capture)
    )


def serialize_run(run):
    if not run:
        return None
    return {
        "id": str(run.pk),
        "capture_id": str(run.capture_id),
        "generation": run.generation,
        "source_revision": run.source_revision,
        "configuration": run.configuration,
        "status": run.status,
        "deadline": run.deadline.isoformat(),
        "ended_at": run.ended_at.isoformat() if run.ended_at else None,
        "error_code": run.error_code,
    }


def latest(capture):
    return capture.translation_runs.order_by("-generation").first()


def reconcile(capture):
    """Called under record lock; expiry never authorizes another provider connection."""
    run = latest(capture)
    if run and run.status in ACTIVE:
        code = (
            "source_changed"
            if not source_valid(run, capture)
            else "lease_expired"
            if run.deadline <= timezone.now()
            else ""
        )
        if code:
            run.status = "incomplete"
            run.error_code = code
            run.ended_at = timezone.now()
            run.save()
    return run


def locked_capture(capture_id):
    source = models.CaptureSession.objects.only("record_id").get(pk=capture_id)
    record = models.MeetingRecord.objects.select_for_update().get(pk=source.record_id)
    capture = models.CaptureSession.objects.select_for_update().get(pk=capture_id)
    capture.record = record
    return capture


def _state(capture, run):
    available = enabled()
    return {
        "source": {
            "capture_id": str(capture.pk),
            "record_id": str(capture.record_id),
            "revision": capture.revision,
            "status": capture.status,
        },
        "available": available,
        "current": serialize_run(run),
        "can_start": bool(
            available
            and capture.status == "recording"
            and not capture_retention.expired(capture)
            and (not run or run.status not in ACTIVE)
        ),
        "can_stop": bool(run and run.status in ("starting", "translating")),
    }


@transaction.atomic
def state(capture_id, user):
    capture = locked_capture(capture_id)
    owned(capture, user)
    return _state(capture, reconcile(capture))


@transaction.atomic
def control(capture_id, user, lease, key, payload):
    """Freeze original receipt before replying; stale identities cannot stop new runs."""
    # Serializes the user's idempotency namespace across captures, then normal record lock.
    models.User.objects.select_for_update().get(pk=user.pk)
    capture = locked_capture(capture_id)
    owned(capture, user)
    check_lease(capture, lease, payload["device_id"])
    previous = models.CaptureTranslationCommand.objects.filter(
        user=user, key=key
    ).first()
    run = reconcile(capture)
    if previous:
        if previous.capture_id != capture.pk or previous.payload != payload:
            raise RecordConflict("Translation key belongs to another intent.")
        return previous, True, _state(capture, run)
    if payload["expected_run_id"] != (str(run.pk) if run else None):
        raise RecordConflict("Translation source is stale.")
    if payload["operation"] == "start":
        if (
            not _state(capture, run)["can_start"]
            or payload["expected_revision"] != capture.revision
        ):
            raise RecordConflict("Translation cannot start for this source.")
        configuration = {
            **payload["configuration"],
            "model": MODEL,
            "region": settings.MEETING_CAPTURE_TRANSLATION_REGION,
        }
        run = models.CaptureTranslationRun.objects.create(
            capture=capture,
            requested_by=user,
            generation=run.generation + 1 if run else 1,
            source_revision=capture.revision,
            source_lease_hash=capture.lease_hash,
            organization_id_snapshot=capture.record.organization_id,
            configuration=configuration,
            deadline=timezone.now() + RESERVATION_LIFETIME,
        )
    else:
        if not run or run.status not in ("starting", "translating"):
            raise RecordConflict("Translation is no longer stoppable.")
        run.stopped_at = timezone.now()
        if not run.worker_id:
            run.status = "stopped"
            run.ended_at = run.stopped_at
        else:
            run.status = "stopping"
            run.deadline = min(run.deadline, run.stopped_at + DRAIN_LIFETIME)
        run.save()
    command = models.CaptureTranslationCommand.objects.create(
        user=user, key=key, capture=capture, payload=payload, result=serialize_run(run)
    )
    return command, False, _state(capture, run)


def serialize_command(command):
    return {
        "key": str(command.key),
        "capture_id": str(command.capture_id),
        "payload": command.payload,
        "result": command.result,
    }
