"""Private assistant delivery with immutable destinations and read-only timeout recovery."""

import uuid
from datetime import timedelta
from functools import partial

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core import models
from core.services import im_bots
from core.services import meeting_summary_notifications as notices
from core.services.im_delivery_client import ImDeliveryClient, ImDeliveryError
from core.services.im_provisioning import resolve_uid
from core.services.jusi_im import JusiImAdminClient, JusiImServiceError
from core.services.meeting_records import RecordConflict, visible_records


def _cid(bot, peer):
    bot, peer = str(uuid.UUID(str(bot))), str(uuid.UUID(str(peer)))
    if bot == peer or uuid.UUID(bot).int == 0 or uuid.UUID(peer).int == 0:
        raise ValueError("Invalid private conversation members.")
    low, high = sorted([bot, peer])
    return str(uuid.uuid5(uuid.NAMESPACE_OID, f"direct:{low}:{high}"))


def _recipient(row):
    user = models.User.objects.filter(
        pk=row.recipient_id, is_active=True, sub=row.recipient_sub
    ).first()
    if (
        user
        and visible_records(user, ability="read_summary")
        .filter(pk=row.record_id)
        .exists()
    ):
        return user
    return None


def _client(row):
    config = settings.JUSI_IM_CONFIGURATION or {}
    if (
        row.api_url != str(config.get("api_url", "")).rstrip("/")
        or not row.body
        or row.body_hash != notices.body_hash(row.body)
    ):
        raise ValueError("Notification configuration changed.")
    return ImDeliveryClient(row.api_url, config.get("admin_hmac_secret", ""))


def _state(row, status, error="", message_id=None):
    row.status, row.error_code, row.message_id = status, error, message_id
    row.worker_id = row.deadline = None
    row.save(
        update_fields=[
            "status",
            "error_code",
            "message_id",
            "worker_id",
            "deadline",
            "updated_at",
        ]
    )


@transaction.atomic
def _claim(pk, attempt, expected_status):
    if not settings.CELERY_ENABLED or expected_status not in {"queued", "uncertain"}:
        return None
    row = (
        models.MeetingSummaryNotification.objects.select_for_update()
        .filter(pk=pk, attempt=attempt, status=expected_status)
        .first()
    )
    if row is None:
        return None
    if expected_status == "queued" and (not notices.enabled() or not _recipient(row)):
        _state(
            row, "uncertain" if row.send_started else "canceled", "permission_revoked"
        )
        return None
    row.status = "running"
    row.worker_id = uuid.uuid4()
    row.deadline = timezone.now() + timedelta(seconds=120)
    row.save(update_fields=["status", "worker_id", "deadline", "updated_at"])
    return row


def _live(row):
    return (
        models.MeetingSummaryNotification.objects.select_for_update()
        .filter(
            pk=row.pk,
            worker_id=row.worker_id,
            attempt=row.attempt,
            status="running",
            deadline__gt=timezone.now(),
        )
        .first()
    )


@transaction.atomic
def _finish(row, status, error="", message_id=None):
    current = _live(row)
    if current is None:
        return False
    _state(current, status, error, message_id)
    return True


def _provisioning_client():
    config = settings.JUSI_IM_CONFIGURATION or {}
    return JusiImAdminClient(
        str(config.get("api_url", "")),
        str(config.get("admin_hmac_secret", "")),
        timeout_seconds=5,
    )


@transaction.atomic
def _bind(row, api_url, body, bot_uid, cid):
    current = _live(row)
    if current is None or not notices.enabled() or not _recipient(current):
        return False
    # The operator may have changed the destination during identity resolution.
    if notices._origins()[0] != api_url:  # noqa: SLF001 -- exact shared rollout configuration
        raise ValueError("IM origin changed during preparation.")
    current.api_url, current.body, current.body_hash = (
        api_url,
        body,
        notices.body_hash(body),
    )
    current.bot_uid, current.conversation_id = bot_uid, cid
    current.save(
        update_fields=[
            "api_url",
            "body",
            "body_hash",
            "bot_uid",
            "conversation_id",
            "updated_at",
        ]
    )
    row.api_url, row.body, row.body_hash = api_url, body, current.body_hash
    row.bot_uid, row.conversation_id = current.bot_uid, current.conversation_id
    return True


def _prepare(row):
    if row.body:
        _client(row)
        return True
    if not notices.enabled() or not (user := _recipient(row)):
        return False
    api_url, base = notices._origins()  # noqa: SLF001
    assistant = im_bots.get_builtin(im_bots.BOT_MEETING_ASSISTANT)
    if assistant is None:
        raise ValueError("Meeting assistant unavailable.")
    client = _provisioning_client()
    peer = resolve_uid(client, user)
    bot = im_bots.resolve_bot_uid(client, assistant)
    cid = _cid(bot, peer)
    return _bind(
        row, api_url, notices.build_body(row, base), uuid.UUID(bot), uuid.UUID(cid)
    )


def _may_send(row):
    user = _recipient(row)
    assistant = im_bots.get_builtin(im_bots.BOT_MEETING_ASSISTANT)
    if (
        not notices.enabled()
        or user is None
        or assistant is None
        or str(assistant.im_uid) != str(row.bot_uid)
    ):
        return None
    if _cid(row.bot_uid, user.im_uid) != str(row.conversation_id):
        return None
    _client(row)
    return user


@transaction.atomic
def _begin_send(row):
    current = _live(row)
    if current is None:
        return False
    if not _may_send(current):
        _state(
            current,
            "uncertain" if current.send_started else "canceled",
            "permission_revoked",
        )
        return False
    current.send_started = True
    current.save(update_fields=["send_started", "updated_at"])
    row.send_started = True
    return True


def _ensure_direct(row):
    user = _may_send(row)
    if user is None:
        return False
    result = _provisioning_client().create_direct(
        cid=str(row.conversation_id), owner_uid=str(row.bot_uid), peer_uid=user.im_uid
    )
    if (
        result.cid != str(row.conversation_id)
        or result.type != "direct"
        or result.owner_uid not in {str(row.bot_uid), user.im_uid}
        or set(result.members) != {str(row.bot_uid), user.im_uid}
    ):
        raise ValueError("Private conversation membership mismatch.")
    return True


def execute_notification(pk, attempt, expected_status="queued"):  # noqa: PLR0911 -- receipt state machine
    row = _claim(pk, attempt, expected_status)
    if row is None:
        return False
    try:
        if not row.body and expected_status == "uncertain":
            return _finish(row, "failed", "preparation_interrupted")
        if not _prepare(row):
            return _finish(row, "canceled", "permission_revoked")
        client = _client(row)
        receipt = client.lookup(str(row.bot_uid), str(row.pk), str(row.conversation_id))
        if receipt.state == "not_found":
            if expected_status == "uncertain":
                return _finish(row, "uncertain", "result_not_found")
            if not _ensure_direct(row) or not _begin_send(row):
                return _finish(
                    row,
                    "uncertain" if row.send_started else "canceled",
                    "permission_revoked",
                )
            receipt = client.create(
                str(row.pk),
                {
                    "sender_uid": str(row.bot_uid),
                    "cid": str(row.conversation_id),
                    "content_type": "rich-card",
                    "body": row.body,
                },
            )
        if receipt.state == "ready":
            return _finish(row, "delivered", message_id=receipt.message_id)
        if receipt.state == "unavailable":
            return _finish(row, "unavailable", "message_unavailable")
        if receipt.state == "conflict":
            return _finish(row, "failed", "message_conflict")
        return _finish(row, "uncertain", "message_processing")
    except ImDeliveryError as error:
        return _finish(row, "uncertain" if row.send_started else "failed", error.code)
    except JusiImServiceError:
        return _finish(
            row,
            "uncertain" if row.send_started else "failed",
            "provisioning_unavailable",
        )
    except (ValueError, TypeError, KeyError, AttributeError):
        return _finish(
            row, "uncertain" if row.send_started else "failed", "configuration_changed"
        )


@transaction.atomic
def dispatch_notification(pk):
    if not settings.CELERY_ENABLED:
        return False
    row = (
        models.MeetingSummaryNotification.objects.select_for_update()
        .filter(pk=pk, status__in=["queued", "uncertain"])
        .first()
    )
    if row is None:
        return False
    interval = 300 if row.status == "uncertain" else 30
    if (
        row.dispatch_attempted_at
        and row.dispatch_attempted_at > timezone.now() - timedelta(seconds=interval)
    ):
        return False
    try:
        from meet.celery_app import (  # noqa: PLC0415 -- initialize only for asynchronous dispatch
            app,
        )

        with app.connection_for_write(connect_timeout=3) as connection:
            connection.transport_options.update(
                socket_timeout=3, socket_connect_timeout=3
            )
            app.send_task(
                "core.tasks.summary_notifications.deliver_summary_notification",
                args=[str(row.pk), row.attempt, row.status],
                connection=connection,
                retry=False,
            )
        sent = True
    except Exception:  # noqa: BLE001 -- redact broker details
        row.error_code = "dispatch_unavailable"
        sent = False
    row.dispatch_attempted_at = timezone.now()
    row.save(update_fields=["dispatch_attempted_at", "error_code", "updated_at"])
    return sent


def tick_notifications():
    if not settings.CELERY_ENABLED:
        return 0
    models.MeetingSummaryNotification.objects.filter(
        status="running", deadline__lte=timezone.now()
    ).update(
        status="uncertain",
        worker_id=None,
        deadline=None,
        error_code="worker_expired",
        updated_at=timezone.now(),
    )
    now = timezone.now()
    rows = models.MeetingSummaryNotification.objects.filter(
        Q(status="queued")
        & (
            Q(dispatch_attempted_at__isnull=True)
            | Q(dispatch_attempted_at__lte=now - timedelta(seconds=30))
        )
        | Q(status="uncertain")
        & (
            Q(dispatch_attempted_at__isnull=True)
            | Q(dispatch_attempted_at__lte=now - timedelta(seconds=300))
        )
    ).order_by("dispatch_attempted_at", "created_at", "id")
    return sum(
        dispatch_notification(pk) for pk in list(rows.values_list("pk", flat=True)[:20])
    )


@transaction.atomic
def retry_notification(record_id, notice_id, user, key, expected_attempt):
    models.User.objects.select_for_update().get(pk=user.pk)
    models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    row = (
        models.MeetingSummaryNotification.objects.select_for_update()
        .filter(pk=notice_id, record_id=record_id, recipient=user)
        .first()
    )
    if row is None or _recipient(row) is None:
        raise PermissionError
    fingerprint = notices.body_hash(f"{record_id}:{notice_id}:{expected_attempt}")
    previous = models.MeetingSummaryNotificationRequest.objects.filter(
        user=user, key=key
    ).first()
    if previous:
        if previous.request_hash != fingerprint:
            raise RecordConflict("Notification retry key conflicts.")
        transaction.on_commit(partial(dispatch_notification, row.pk), robust=True)
        return row, True
    if not notices.available():
        raise PermissionError
    if (
        row.attempt != expected_attempt
        or row.attempt >= 20
        or row.status not in {"failed", "uncertain", "canceled"}
        or row.error_code == "message_conflict"
    ):
        raise RecordConflict("Notification attempt changed or is not retryable.")
    if row.body:
        _client(row)
    row.attempt += 1
    row.status, row.error_code = "queued", ""
    row.worker_id = row.deadline = row.dispatch_attempted_at = None
    row.save(
        update_fields=[
            "attempt",
            "status",
            "error_code",
            "worker_id",
            "deadline",
            "dispatch_attempted_at",
            "updated_at",
        ]
    )
    models.MeetingSummaryNotificationRequest.objects.create(
        user=user, key=key, notice=row, attempt=row.attempt, request_hash=fingerprint
    )
    transaction.on_commit(partial(dispatch_notification, row.pk), robust=True)
    return row, False
