"""Durable Docs delivery: fence workers and reconcile ambiguous writes by original key."""

import uuid
from datetime import timedelta
from functools import partial

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core import models
from core.services import meeting_summary_exports as exports
from core.services.docs_delivery_client import DocsDeliveryClient, DocsDeliveryError
from core.services.meeting_records import RecordConflict

LEASE_SECONDS = 90
RECONCILE_SECONDS = 300
MAX_ATTEMPTS = 20


def _client(row):
    config = settings.DOCS_CONFIGURATION
    if str(config.get("api_url", "")).rstrip("/") != row.api_url:
        raise ValueError("Docs origin changed.")
    if exports.digest(row.payload) != row.payload_hash:
        raise ValueError("Frozen document changed.")
    return DocsDeliveryClient(row.api_url, config.get("server_to_server_token"))


def _may_create(row):
    user = models.User.objects.filter(pk=row.requested_by_id, is_active=True).first()
    return bool(
        exports.available()
        and user
        and user.sub == row.payload.get("sub")
        and exports.can_export(row.record, user)
    )


def _save_state(row, status, error="", document_id=None):
    row.status = status
    row.error_code = error
    row.document_id = document_id
    row.worker_id = None
    row.deadline = None
    row.save(
        update_fields=[
            "status",
            "error_code",
            "document_id",
            "worker_id",
            "deadline",
            "updated_at",
        ]
    )


@transaction.atomic
def _claim(export_id, attempt, expected_status):
    if not settings.CELERY_ENABLED or expected_status not in {"queued", "uncertain"}:
        return None
    row = (
        models.MeetingSummaryExport.objects.select_for_update()
        .filter(pk=export_id)
        .first()
    )
    if row is None or row.attempt != attempt or row.status != expected_status:
        return None
    if expected_status == "queued" and not _may_create(row):
        _save_state(
            row, "uncertain" if row.create_started else "canceled", "permission_revoked"
        )
        return None
    row.status = "running"
    row.worker_id = uuid.uuid4()
    row.deadline = timezone.now() + timedelta(seconds=LEASE_SECONDS)
    row.save(update_fields=["status", "worker_id", "deadline", "updated_at"])
    return row


def _live(export_id, attempt, worker_id):
    return (
        models.MeetingSummaryExport.objects.select_for_update()
        .filter(
            pk=export_id,
            attempt=attempt,
            worker_id=worker_id,
            status="running",
            deadline__gt=timezone.now(),
        )
        .first()
    )


@transaction.atomic
def _finish(row, status, error="", document_id=None):
    current = _live(row.pk, row.attempt, row.worker_id)
    if current is None:
        return False
    _save_state(current, status, error, document_id)
    return True


@transaction.atomic
def _begin_create(row):
    """Last local authorization check, immediately before the external write."""
    current = _live(row.pk, row.attempt, row.worker_id)
    if current is None:
        return False
    try:
        _client(current)
    except ValueError:
        _save_state(
            current,
            "uncertain" if current.create_started else "failed",
            "configuration_changed",
        )
        return False
    if not _may_create(current):
        _save_state(
            current,
            "uncertain" if current.create_started else "canceled",
            "permission_revoked",
        )
        return False
    current.create_started = True
    current.save(update_fields=["create_started", "updated_at"])
    row.create_started = True
    return True


def execute_export(export_id, attempt, expected_status="queued"):  # noqa: PLR0911 -- explicit receipt state machine
    """Only explicit queued attempts may create. Automatic recovery performs GET only."""
    row = _claim(export_id, attempt, expected_status)
    if row is None:
        return False
    try:
        client = _client(row)
        receipt = client.lookup(row.payload["sub"], str(row.pk))
        if receipt.state == "not_found":
            if expected_status == "uncertain":
                # A prior POST might still be in transit: keep the key and require
                # explicit consent for another write even when lookup sees no row.
                return _finish(row, "uncertain", "result_not_found")
            if not _begin_create(row):
                return False
            receipt = client.create(str(row.pk), row.payload)
        if receipt.state == "ready":
            return _finish(row, "ready", document_id=receipt.document_id)
        if receipt.state == "unavailable":
            return _finish(row, "unavailable", "document_unavailable")
        if receipt.state == "conflict":
            return _finish(row, "failed", "document_conflict")
        return _finish(row, "uncertain", "document_processing")
    except DocsDeliveryError as error:
        return _finish(row, "uncertain" if row.create_started else "failed", error.code)
    except (ValueError, KeyError, TypeError):
        return _finish(
            row,
            "uncertain" if row.create_started else "failed",
            "configuration_changed",
        )


@transaction.atomic
def dispatch_export(export_id):
    """Persist a dispatch timestamp; broker delivery loss is recovered by the periodic tick."""
    if not settings.CELERY_ENABLED:
        return False
    row = (
        models.MeetingSummaryExport.objects.select_for_update()
        .filter(pk=export_id)
        .first()
    )
    if row is None or row.status not in {"queued", "uncertain"}:
        return False
    now = timezone.now()
    delay = RECONCILE_SECONDS if row.status == "uncertain" else 30
    if row.dispatch_attempted_at and row.dispatch_attempted_at > now - timedelta(
        seconds=delay
    ):
        return False
    try:
        from meet.celery_app import (  # noqa: PLC0415 -- initialize Celery only when dispatching
            app,
        )

        with app.connection_for_write(connect_timeout=3) as connection:
            connection.transport_options.update(
                socket_timeout=3, socket_connect_timeout=3
            )
            app.send_task(
                "core.tasks.summary_exports.deliver_summary_export",
                args=[str(row.pk), row.attempt, row.status],
                connection=connection,
                retry=False,
            )
        sent = True
    except Exception:  # noqa: BLE001 -- do not log broker credentials
        row.error_code = "dispatch_unavailable"
        sent = False
    row.dispatch_attempted_at = now
    row.save(update_fields=["dispatch_attempted_at", "error_code", "updated_at"])
    return sent


def tick_exports():
    """Bound each tick; expired workers can no longer publish late receipts."""
    if not settings.CELERY_ENABLED:
        return 0
    models.MeetingSummaryExport.objects.filter(
        status="running",
        deadline__lte=timezone.now(),
    ).update(
        status="uncertain",
        worker_id=None,
        deadline=None,
        error_code="worker_expired",
        updated_at=timezone.now(),
    )
    cutoff = timezone.now()
    eligible = models.MeetingSummaryExport.objects.filter(
        Q(status="queued")
        & (
            Q(dispatch_attempted_at__isnull=True)
            | Q(dispatch_attempted_at__lte=cutoff - timedelta(seconds=30))
        )
        | Q(status="uncertain")
        & (
            Q(dispatch_attempted_at__isnull=True)
            | Q(
                dispatch_attempted_at__lte=cutoff - timedelta(seconds=RECONCILE_SECONDS)
            )
        )
    ).order_by("dispatch_attempted_at", "created_at", "id")
    return sum(
        dispatch_export(pk) for pk in list(eligible.values_list("pk", flat=True)[:20])
    )


@transaction.atomic
def retry_export(record_id, export_id, user, key, expected_attempt, expected_hash):  # noqa: PLR0913 -- identity plus consent fences
    """Explicit recovery preserves destination, owner, bytes and the Docs idempotency key."""
    models.User.objects.select_for_update().get(pk=user.pk)
    record = models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    if not exports.can_export(record, user):
        raise PermissionError
    intent_hash = exports.digest(
        {
            "operation": "retry",
            "record_id": str(record_id),
            "export_id": str(export_id),
            "expected_attempt": expected_attempt,
            "expected_hash": expected_hash,
        }
    )
    previous = (
        models.MeetingSummaryExportRequest.objects.filter(requested_by=user, key=key)
        .select_related("export")
        .first()
    )
    if previous:
        if previous.request_hash != intent_hash:
            raise RecordConflict("Export retry key conflicts.")
        transaction.on_commit(partial(dispatch_export, previous.export_id), robust=True)
        return previous.export, True
    if not exports.available():
        raise PermissionError
    row = (
        models.MeetingSummaryExport.objects.select_for_update()
        .filter(pk=export_id, record=record, requested_by=user)
        .first()
    )
    if (
        row is None
        or row.attempt != expected_attempt
        or row.payload_hash != expected_hash
    ):
        raise RecordConflict("Export attempt changed.")
    if (
        row.status not in {"failed", "uncertain", "canceled"}
        or row.attempt >= MAX_ATTEMPTS
        or row.error_code == "document_conflict"
    ):
        raise RecordConflict("This export cannot be retried.")
    _client(row)
    if not _may_create(row):
        raise PermissionError
    row.attempt += 1
    row.status = "queued"
    row.worker_id = None
    row.deadline = None
    row.dispatch_attempted_at = None
    row.error_code = ""
    row.save(
        update_fields=[
            "attempt",
            "status",
            "worker_id",
            "deadline",
            "dispatch_attempted_at",
            "error_code",
            "updated_at",
        ]
    )
    models.MeetingSummaryExportRequest.objects.create(
        requested_by=user,
        key=key,
        request_hash=intent_hash,
        export=row,
        attempt=row.attempt,
    )
    transaction.on_commit(partial(dispatch_export, row.pk), robust=True)
    return row, False
