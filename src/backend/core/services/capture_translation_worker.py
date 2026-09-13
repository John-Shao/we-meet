"""One-use gateway claims and paid-connection fences for standalone translation."""

import uuid
from datetime import timedelta

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.utils import timezone

from core import models
from core.services import ai_usage, capture_translation_archive
from core.services import capture_translation as control
from core.services.meeting_captures import check_lease, digest
from core.services.meeting_records import RecordConflict

TICKET_SALT = "capture-translation-gateway-v1"
TICKET_AGE = 30
WORKER_LIFETIME = timedelta(seconds=15)
MAX_LIFETIME = timedelta(hours=12)


def _run(capture, run_id):
    return models.CaptureTranslationRun.objects.select_for_update().get(
        pk=run_id, capture=capture
    )


def _authorized(run, capture):
    control.owned(capture, run.requested_by)
    if not control.source_valid(run, capture):
        raise PermissionError


def _retention_ready(run):
    """Old reservations without their requested archive cannot incur new spend."""
    if (
        run.configuration["save_translations"]
        and not models.MeetingTranslationArchive.objects.filter(
            source_kind="capture",
            source_id=run.pk,
            record_id=run.capture.record_id,
            owner_id=run.requested_by_id,
            status="capturing",
            configuration__capture_id=str(run.capture_id),
        ).exists()
    ):
        raise RecordConflict("The requested translation archive is unavailable.")


@transaction.atomic
def ticket(capture_id, user, lease, data):
    """A bearer grant travels in the first TLS WS message, never the URL."""
    capture = control.locked_capture(capture_id)
    control.owned(capture, user)
    check_lease(capture, lease, data["device_id"])
    run = _run(capture, data["run_id"])
    _authorized(run, capture)
    if (
        not control.enabled()
        or run.status != "starting"
        or run.worker_id
        or run.deadline <= timezone.now()
        or run.generation != data["generation"]
    ):
        raise RecordConflict("Translation is not awaiting a connection.")
    grant = {
        "run_id": str(run.pk),
        "capture_id": str(capture.pk),
        "user_id": str(user.pk),
        "device_id": capture.device_id,
        "generation": run.generation,
        "source_revision": run.source_revision,
    }
    return {
        "ticket": signing.dumps(grant, salt=TICKET_SALT),
        "gateway_url": settings.MEETING_CAPTURE_TRANSLATION_URL,
        "expires_at": run.deadline.isoformat(),
        "source": grant,
    }


@transaction.atomic
def claim(raw_ticket, worker_id):
    """A claimed ticket cannot move to another process, including after disconnection."""
    try:
        grant = signing.loads(raw_ticket, salt=TICKET_SALT, max_age=TICKET_AGE)
        if not isinstance(grant, dict) or set(grant) != {
            "run_id",
            "capture_id",
            "user_id",
            "device_id",
            "generation",
            "source_revision",
        }:
            raise ValueError
        capture_id, run_id = uuid.UUID(grant["capture_id"]), uuid.UUID(grant["run_id"])
    except (signing.BadSignature, ValueError, TypeError, KeyError):
        raise PermissionError from None
    capture = control.locked_capture(capture_id)
    run = _run(capture, run_id)
    _authorized(run, capture)
    if (
        not control.enabled()
        or run.status != "starting"
        or run.begun_at
        or run.deadline <= timezone.now()
        or grant["user_id"] != str(run.requested_by_id)
        or grant["device_id"] != capture.device_id
        or grant["generation"] != run.generation
        or grant["source_revision"] != run.source_revision
        or (run.worker_id and run.worker_id != worker_id)
    ):
        raise RecordConflict("Translation ticket has expired or was consumed.")
    if not run.worker_id:
        run.worker_id = worker_id
        run.save()
    return {"run": control.serialize_run(run), "worker_id": str(worker_id)}


def _view(run):
    return {
        "run": control.serialize_run(run),
        "worker_id": str(run.worker_id),
        "action": "stop"
        if run.status == "stopping"
        else "abort"
        if run.status not in control.ACTIVE
        else "stream",
    }


@transaction.atomic
def advance(run_id, worker_id, operation):
    """Only the first acknowledged begin permits provider IO; never repeat it on timeout."""
    source = models.CaptureTranslationRun.objects.only("capture_id").get(pk=run_id)
    capture = control.locked_capture(source.capture_id)
    run = _run(capture, run_id)
    if run.worker_id != worker_id:
        raise PermissionError
    _authorized(run, capture)
    run = control.reconcile(capture)
    if run.pk != run_id or run.status not in control.ACTIVE:
        raise RecordConflict("Translation lease has ended.")
    now = timezone.now()
    if operation == "begin":
        _retention_ready(run)
        if not control.enabled() or run.status != "starting":
            raise RecordConflict("Translation cannot begin.")
        if run.begun_at:
            return {**_view(run), "execute": False}
        run.begun_at = now
        run.deadline = now + WORKER_LIFETIME
        run.save()
        return {**_view(run), "execute": True}
    if not run.begun_at:
        raise RecordConflict("Translation has not begun.")
    if run.status != "stopping" and (
        not control.enabled() or now >= run.begun_at + MAX_LIFETIME
    ):
        run.status, run.stopped_at = "stopping", now
        run.deadline = min(run.deadline, now + control.DRAIN_LIFETIME)
    elif run.status != "stopping":
        run.deadline = min(now + WORKER_LIFETIME, run.begun_at + MAX_LIFETIME)
        if operation == "ready":
            run.status = "translating"
    run.save()
    return _view(run)


@transaction.atomic
def finish(run_id, worker_id, data):
    """Late metering receipts never upgrade an expired or revoked source to success."""
    source = models.CaptureTranslationRun.objects.only("capture_id").get(pk=run_id)
    capture = control.locked_capture(source.capture_id)
    run = _run(capture, run_id)
    if run.worker_id != worker_id:
        raise PermissionError
    fingerprint = digest(data)
    if run.finish_hash:
        if run.finish_hash != fingerprint:
            raise RecordConflict("Translation finish receipt changed.")
        return _view(run)
    valid = run.deadline > timezone.now()
    try:
        _authorized(run, capture)
    except PermissionError:
        valid = False
    if run.status in control.ACTIVE:
        valid = capture_translation_archive.close(
            run,
            bool(valid and data["complete"] and run.begun_at),
            data.get("segment_count", 0),
        )
        run.status = (
            "stopped" if valid and data["complete"] and run.begun_at else "incomplete"
        )
        run.ended_at = timezone.now()
        run.error_code = "" if run.status == "stopped" else "translation_incomplete"
    run.finish_hash = fingerprint
    run.save()
    if run.begun_at:
        ai_usage.record_usage(
            user=run.requested_by,
            organization=models.Organization.objects.filter(
                pk=run.organization_id_snapshot
            ).first(),
            model_code=run.configuration["model"],
            ref_type="capture_translation",
            ref_id=str(run.pk),
            input_tokens=data["input_tokens"],
            output_tokens=data["output_tokens"],
            audio_seconds=data["audio_seconds"],
            infer_organization=False,
        )
    return _view(run)
