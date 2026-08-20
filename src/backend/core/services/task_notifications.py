"""Reliable Meeting Assistant notifications for task assignments."""

import json
import logging
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from core import models
from core.services import im_bots, im_cards
from core.services.jusi_im import JusiImAdminClient

logger = logging.getLogger(__name__)

# A claimed row is hidden from the recovery scan while one worker talks to IM.
# If that worker dies, the production maintenance CronJob can claim it again.
CLAIM_TTL = timedelta(minutes=2)


class TaskImNotificationUnavailable(RuntimeError):
    """Raised for configuration/provisioning gaps worth retrying later."""


def record_task_assignment(
    *, task: models.Task, event: str
) -> models.TaskImDelivery | None:
    """Persist and enqueue one assignment event after the surrounding commit.

    Self-assignment intentionally stays silent. Reassigning to self still
    supersedes a pending notification for the previous assignee.
    """

    models.TaskImDelivery.objects.filter(
        task=task,
        status=models.TaskImDelivery.Status.PENDING,
    ).exclude(recipient_id=task.assignee_id).update(
        status=models.TaskImDelivery.Status.SUPERSEDED,
        next_attempt_at=None,
        last_error="",
    )

    if task.assignee_id is None or task.assignee_id == task.creator_id:
        return None

    delivery = models.TaskImDelivery.objects.create(
        task=task,
        recipient_id=task.assignee_id,
        event=event,
        next_attempt_at=timezone.now(),
    )
    transaction.on_commit(lambda: _enqueue_delivery(delivery.id))
    return delivery


def _enqueue_delivery(delivery_id) -> bool:
    """Publish without turning an already-committed task into an API error."""

    from core.tasks.task_notifications import (  # noqa: PLC0415 - avoid task cycle
        deliver_task_assignment,
    )

    try:
        deliver_task_assignment.apply_async(args=[str(delivery_id)])
    except Exception:  # pragma: no cover - broker outage is recovered by the scan
        logger.exception("Failed to enqueue task IM delivery %s", delivery_id)
        return False
    return True


def enqueue_due_task_assignments(*, limit: int = 100) -> int:
    """Recover pending rows whose original publish/retry may have been lost."""

    delivery_ids = list(
        models.TaskImDelivery.objects.filter(
            status=models.TaskImDelivery.Status.PENDING,
            next_attempt_at__lte=timezone.now(),
        )
        .order_by("next_attempt_at", "created_at")
        .values_list("id", flat=True)[:limit]
    )
    return sum(_enqueue_delivery(delivery_id) for delivery_id in delivery_ids)


def claim_task_assignment(delivery_id) -> models.TaskImDelivery | None:
    """Atomically claim a due row so duplicate Celery jobs cannot both send it."""

    now = timezone.now()
    claimed = models.TaskImDelivery.objects.filter(
        pk=delivery_id,
        status=models.TaskImDelivery.Status.PENDING,
        next_attempt_at__lte=now + timedelta(seconds=2),
    ).update(
        attempt_count=F("attempt_count") + 1,
        next_attempt_at=now + CLAIM_TTL,
    )
    if not claimed:
        return None

    delivery = (
        models.TaskImDelivery.objects.select_related(
            "recipient",
            "task__creator",
            "task__assignee",
            "task__source_action_item__room",
        )
        .filter(pk=delivery_id)
        .first()
    )
    if delivery is None:
        return None
    if delivery.task.assignee_id != delivery.recipient_id:
        models.TaskImDelivery.objects.filter(pk=delivery.pk).update(
            status=models.TaskImDelivery.Status.SUPERSEDED,
            next_attempt_at=None,
            last_error="",
        )
        return None
    return delivery


def deliver_claimed_task_assignment(delivery: models.TaskImDelivery) -> None:
    """Send one already-claimed row and mark it delivered."""

    cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None) or {}
    if not cfg.get("api_url") or not cfg.get("admin_hmac_secret"):
        raise TaskImNotificationUnavailable("JUSI IM configuration is incomplete")

    assistant = im_bots.get_builtin(im_bots.BOT_MEETING_ASSISTANT)
    if assistant is None:
        raise TaskImNotificationUnavailable("Meeting Assistant is unavailable")

    client = JusiImAdminClient(
        api_url=str(cfg["api_url"]),
        admin_hmac_secret=str(cfg["admin_hmac_secret"]),
        timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
    )
    result = im_bots.post_direct(
        client,
        assistant,
        delivery.recipient,
        json.dumps(_assignment_card(delivery), ensure_ascii=False),
        content_type=im_cards.RICH_CARD,
    )
    if result is None:
        raise TaskImNotificationUnavailable("IM uid is unavailable")

    cid, _message = result
    models.TaskImDelivery.objects.filter(
        pk=delivery.pk,
        status=models.TaskImDelivery.Status.PENDING,
    ).update(
        status=models.TaskImDelivery.Status.DELIVERED,
        conversation_id=cid,
        delivered_at=timezone.now(),
        next_attempt_at=None,
        last_error="",
    )


def mark_task_assignment_retry(
    delivery: models.TaskImDelivery, *, error: Exception, delay_seconds: int
) -> None:
    """Keep a failed attempt pending until its next backoff window."""

    models.TaskImDelivery.objects.filter(
        pk=delivery.pk,
        status=models.TaskImDelivery.Status.PENDING,
    ).update(
        next_attempt_at=timezone.now() + timedelta(seconds=delay_seconds),
        last_error=str(error)[:2000],
    )


def mark_task_assignment_failed(
    delivery: models.TaskImDelivery, *, error: Exception
) -> None:
    """Stop automatic attempts while retaining an operations-visible ledger."""

    models.TaskImDelivery.objects.filter(
        pk=delivery.pk,
        status=models.TaskImDelivery.Status.PENDING,
    ).update(
        status=models.TaskImDelivery.Status.FAILED,
        next_attempt_at=None,
        last_error=str(error)[:2000],
    )


def _assignment_card(delivery: models.TaskImDelivery) -> dict:
    task = delivery.task
    reassigned = delivery.event == models.TaskImDelivery.Event.REASSIGNED
    heading = "任务已转交给你" if reassigned else "你收到一个新任务"
    blocks = [
        {
            "type": im_cards.CARD_BLOCK_TEXT,
            "spans": [{"tag": im_cards.RICH_TAG_TEXT, "text": task.title, "b": True}],
        }
    ]
    if task.description.strip():
        blocks.append(
            {
                "type": im_cards.CARD_BLOCK_TEXT,
                "spans": [
                    {
                        "tag": im_cards.RICH_TAG_TEXT,
                        "text": task.description.strip()[:500],
                    }
                ],
            }
        )

    fields = [{"label": "创建人", "value": _display_name(task.creator)}]
    if task.start_date is not None:
        fields.append({"label": "开始日期", "value": task.start_date.isoformat()})
    if task.due_date is not None:
        fields.append({"label": "截止日期", "value": task.due_date.isoformat()})
    source = getattr(task, "source_action_item", None)
    if source is not None:
        fields.append({"label": "来源会议", "value": source.room.name})
    blocks.append({"type": im_cards.CARD_BLOCK_FIELDS, "items": fields})

    base_url = str(getattr(settings, "APPLICATION_BASE_URL", "") or "").rstrip("/")
    if base_url:
        blocks.append(
            {
                "type": im_cards.CARD_BLOCK_ACTIONS,
                "resolve": im_cards.CARD_RESOLVE_EACH,
                "buttons": [
                    {
                        "id": "open-task-center",
                        "text": "查看任务",
                        "style": "primary",
                        "action": "url",
                        "url": f"{base_url}/tasks",
                    }
                ],
            }
        )
    return im_cards.build_rich_card(
        header={"title": heading, "theme": "warning" if reassigned else "info"},
        blocks=blocks,
        plain=f"{heading}：{task.title}",
    )


def _display_name(user) -> str:
    return (user.full_name or user.short_name or user.email or "").strip()
